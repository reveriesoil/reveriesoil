"""人物立绘抠像统一封装（v0.6.6+）。

策略：
1. 优先调用 rembg（U2Net 系列语义抠图）——对任意背景（纯绿幕 / 写实场景 / 复杂渐变）都
   能稳定抠出主体。首次使用会自动下载 ~175 MB 权重到 ~/.u2net/。
2. 若 rembg 不可用（导入失败、模型下载失败、运行异常），回退到旧版
   ``_remove_chroma_key + _extract_main_character``，保证生成不中断。
3. rembg 输出后再做一次轻量的「绿色溢色去除（despill）」，处理头发/衣服边缘的反光。
4. 提供环境变量开关：``MATTING_BACKEND`` 可设为 ``rembg`` / ``chromakey`` / ``auto``（默认）。

公开接口：
    matting.cutout_portrait(raw_bytes: bytes) -> bytes   # 输入任意编码，返回透明 PNG
"""
from __future__ import annotations

import io
import logging
import os
from typing import Optional

import numpy as np
from PIL import Image, ImageFilter

logger = logging.getLogger(__name__)

# 进程级懒加载缓存
_REMBG_SESSION = None
_REMBG_FAILED = False
_REMBG_MODEL_NAME = os.environ.get("REMBG_MODEL", "u2net")


def _get_rembg_session():
    """懒加载 rembg session；失败时缓存失败标记，避免反复重试。"""
    global _REMBG_SESSION, _REMBG_FAILED
    if _REMBG_FAILED:
        return None
    if _REMBG_SESSION is not None:
        return _REMBG_SESSION
    try:
        from rembg import new_session  # type: ignore
        _REMBG_SESSION = new_session(_REMBG_MODEL_NAME)
        logger.info("rembg session 初始化成功，模型: %s", _REMBG_MODEL_NAME)
        return _REMBG_SESSION
    except Exception as e:
        _REMBG_FAILED = True
        logger.warning("rembg 不可用，将回退到色域抠图: %s", e)
        return None


def _despill_green(img: Image.Image) -> Image.Image:
    """对 RGBA 图像做绿色溢色抑制：
    - 对所有像素，若 g > max(r, b)，把 g 拉回到 max(r, b)
    - 对边缘半透明像素（10 < alpha < 220），额外把 g 进一步压向 (r+b)/2，去除边缘绿色 halo
    """
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    arr = np.array(img, dtype=np.int32)
    rgb = arr[:, :, :3].astype(np.float32)
    a = arr[:, :, 3]
    mx_rb = np.maximum(rgb[:, :, 0], rgb[:, :, 2])
    excess = np.clip(rgb[:, :, 1] - mx_rb, 0, None)
    rgb[:, :, 1] = rgb[:, :, 1] - excess
    # 边缘像素再做一次（更激进）：g 拉向 (r+b)/2
    edge_mask = (a > 10) & (a < 220)
    if edge_mask.any():
        target_g = (rgb[:, :, 0] + rgb[:, :, 2]) * 0.5
        rgb[edge_mask, 1] = np.minimum(rgb[edge_mask, 1], target_g[edge_mask])
    arr[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    return Image.fromarray(arr.astype(np.uint8), "RGBA")


def _smooth_alpha(img: Image.Image, blur_radius: float = 0.6) -> Image.Image:
    """对 alpha 通道做轻微高斯模糊，软化锯齿。"""
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    r, g, b, a = img.split()
    a = a.filter(ImageFilter.GaussianBlur(radius=blur_radius))
    return Image.merge("RGBA", (r, g, b, a))


def _cutout_with_rembg(raw_bytes: bytes) -> Optional[bytes]:
    """用 rembg 抠图，成功返回 PNG 字节，失败返回 None。"""
    session = _get_rembg_session()
    if session is None:
        return None
    try:
        from rembg import remove  # type: ignore
        # 提升前景判定阈值，减少半透明背景残留
        out_bytes = remove(
            raw_bytes,
            session=session,
            alpha_matting=True,
            alpha_matting_foreground_threshold=240,
            alpha_matting_background_threshold=15,
            alpha_matting_erode_size=4,
        )
        out = Image.open(io.BytesIO(out_bytes)).convert("RGBA")
        out = _despill_green(out)
        out = _smooth_alpha(out, blur_radius=0.6)
        buf = io.BytesIO()
        out.save(buf, "PNG")
        return buf.getvalue()
    except Exception as e:
        logger.warning("rembg 抠图失败，回退到色域抠图: %s", e)
        return None


def _cutout_with_chromakey(raw_bytes: bytes) -> bytes:
    """回退路径：使用旧版色域抠图 + 主体提取。"""
    from app.services.ai.jimeng_gen import _remove_chroma_key, _extract_main_character
    png_bytes = _remove_chroma_key(raw_bytes)
    return _extract_main_character(png_bytes)


def cutout_portrait(raw_bytes: bytes) -> bytes:
    """统一抠像入口。返回带透明背景的 PNG 字节。

    后端选择策略由 MATTING_BACKEND 环境变量控制：
    - "rembg"     : 仅用 rembg；失败抛错
    - "chromakey" : 仅用旧色域抠图
    - "auto"（默认）: 优先 rembg，失败回退色域抠图
    """
    backend = (os.environ.get("MATTING_BACKEND") or "auto").lower()
    if backend == "chromakey":
        return _cutout_with_chromakey(raw_bytes)
    if backend == "rembg":
        result = _cutout_with_rembg(raw_bytes)
        if result is None:
            raise RuntimeError("rembg 抠图失败且 MATTING_BACKEND=rembg，未启用回退")
        return result
    # auto
    result = _cutout_with_rembg(raw_bytes)
    if result is not None:
        return result
    return _cutout_with_chromakey(raw_bytes)
