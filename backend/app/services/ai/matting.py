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
    """对 RGBA 图像做绿色溢色抑制（v0.7.3 强化版）：

    1. 全图：若 g > max(r, b)，把 g 拉到 max(r, b)，消除整体绿染。
    2. 边缘半透明像素（10 < alpha < 220）：g 进一步拉向 (r+b)/2，处理 halo。
    3. **纯绿幕色像素**（高饱和绿，rembg 误判为前景的）：
       - 直接置 alpha = 0（视为背景），同时把 RGB 拉成中性灰，避免 alpha=0 时遗留绿色。
       判定：g - max(r,b) > 35 且 g > 90 且 b < 200（剔除纯青色的合理颜色，只杀绿幕）。
    4. 边缘半透明（10 < alpha < 220）若存在显著 g 优势再做一次更深的 desaturation。
    """
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    arr = np.array(img, dtype=np.int32)
    rgb = arr[:, :, :3].astype(np.float32)
    a = arr[:, :, 3].astype(np.float32)

    r_ch = rgb[:, :, 0]
    g_ch = rgb[:, :, 1]
    b_ch = rgb[:, :, 2]
    mx_rb = np.maximum(r_ch, b_ch)

    # ── ① 全图溢色压制 ──────────────────────────────
    excess = np.clip(g_ch - mx_rb, 0, None)
    g_ch = g_ch - excess

    # ── ② 边缘 halo 进一步压制 ──────────────────────
    edge_mask = (a > 10) & (a < 220)
    if edge_mask.any():
        target_g = (r_ch + b_ch) * 0.5
        g_ch = np.where(edge_mask, np.minimum(g_ch, target_g), g_ch)

    # ── ③ 纯绿幕像素：强制透明 + 中性化 ──────────────
    #     用更新后的 g_ch 与原始 max(r,b) 比较，判断仍残留高绿饱和的
    pure_green = (rgb[:, :, 1] - mx_rb > 35) & (rgb[:, :, 1] > 90) & (b_ch < 200)
    if pure_green.any():
        a = np.where(pure_green, 0.0, a)
        # 把这些像素 RGB 也归一到灰（避免渲染管线对透明像素做边缘混合时再泛绿）
        gray = (r_ch + b_ch) * 0.5
        r_ch = np.where(pure_green, gray, r_ch)
        g_ch = np.where(pure_green, gray, g_ch)
        b_ch = np.where(pure_green, gray, b_ch)

    # ── ④ 边缘强绿优势再 desaturate（针对 rembg alpha matting 的半透明 halo）
    strong_edge_green = edge_mask & (rgb[:, :, 1] - mx_rb > 15)
    if strong_edge_green.any():
        avg = (r_ch + b_ch) * 0.5
        # 把 g 一路压到 avg * 0.95
        g_ch = np.where(strong_edge_green, np.minimum(g_ch, avg * 0.95), g_ch)

    rgb[:, :, 0] = r_ch
    rgb[:, :, 1] = g_ch
    rgb[:, :, 2] = b_ch
    arr[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    arr[:, :, 3] = np.clip(a, 0, 255).astype(np.uint8)
    return Image.fromarray(arr.astype(np.uint8), "RGBA")


def _smooth_alpha(img: Image.Image, blur_radius: float = 0.6) -> Image.Image:
    """对 alpha 通道做轻微高斯模糊，软化锯齿。"""
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    r, g, b, a = img.split()
    a = a.filter(ImageFilter.GaussianBlur(radius=blur_radius))
    return Image.merge("RGBA", (r, g, b, a))


def _cutout_with_rembg(raw_bytes: bytes) -> Optional[bytes]:
    """用 rembg 抠图，成功返回 PNG 字节，失败返回 None。

    两级策略：
    1. 优先 alpha_matting（需 pymatting + scipy）—— 边缘最干净
    2. 失败则降级为 plain mask（仅 onnxruntime）—— 边缘较硬，由 _despill_green 兜底
    """
    session = _get_rembg_session()
    if session is None:
        return None
    try:
        from rembg import remove  # type: ignore
    except Exception as e:
        logger.warning("rembg 导入 remove 失败，回退色域抠图: %s", e)
        return None

    out_bytes: Optional[bytes] = None
    # ── ① alpha_matting 路径 ──
    try:
        out_bytes = remove(
            raw_bytes,
            session=session,
            alpha_matting=True,
            alpha_matting_foreground_threshold=240,
            alpha_matting_background_threshold=15,
            alpha_matting_erode_size=4,
        )
    except Exception as e:
        logger.info("rembg alpha_matting 不可用（缺 pymatting/scipy？），降级 plain mask: %s", e)
        out_bytes = None

    # ── ② plain mask 路径（不依赖 pymatting）──
    if out_bytes is None:
        try:
            out_bytes = remove(raw_bytes, session=session)
        except Exception as e:
            logger.warning("rembg plain mask 也失败，回退色域抠图: %s", e)
            return None

    try:
        out = Image.open(io.BytesIO(out_bytes)).convert("RGBA")
        out = _despill_green(out)
        out = _smooth_alpha(out, blur_radius=0.6)
        buf = io.BytesIO()
        out.save(buf, "PNG")
        return buf.getvalue()
    except Exception as e:
        logger.warning("rembg 后处理失败: %s", e)
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
