"""
jimeng_gen.py — 即梦 Seedream 4.6 异步图像生成
使用 HMAC-SHA256 签名鉴权（Volcengine CVSync2Async 接口）。
并发限制：1（Seedream 4.6 并发配额），立绘/背景均为 9:16 竖版。
"""

import asyncio
import base64
import hashlib
import hmac
import io
import json
import logging
from datetime import datetime, timezone
from typing import Tuple

import httpx
import numpy as np
from PIL import Image, ImageFilter

logger = logging.getLogger(__name__)

_HOST = "visual.volcengineapi.com"
_REGION = "cn-north-1"
_SERVICE = "cv"
_PATH = "/"
_REQ_KEY = "jimeng_seedream46_cvtob"

_QUERY_SUBMIT = "Action=CVSync2AsyncSubmitTask&Version=2022-08-31"
_QUERY_POLL   = "Action=CVSync2AsyncGetResult&Version=2022-08-31"

# Seedream 4.6 并发配额为 1
# 使用惰性创建：模块级 Semaphore 在 Celery ForkPoolWorker fork 后会绑定到父进程
# 的 event loop，导致子进程 "bound to a different event loop" 错误。
# 改为按 event loop id 维护独立的 Semaphore，每个 worker 进程创建自己的实例。
_SEMAPHORE_REGISTRY: dict = {}  # id(loop) -> asyncio.Semaphore


def _get_semaphore() -> asyncio.Semaphore:
    """返回绑定到当前 running event loop 的 Semaphore(1)。"""
    loop = asyncio.get_running_loop()
    lid = id(loop)
    if lid not in _SEMAPHORE_REGISTRY:
        _SEMAPHORE_REGISTRY[lid] = asyncio.Semaphore(1)
    return _SEMAPHORE_REGISTRY[lid]


# ---------------------------------------------------------------------------
# 熔断器：服务端连续故障时短路，避免整个生成任务卡死在反复重试
# ---------------------------------------------------------------------------
# 每个 event loop 维护一个 {"fails": int, "until_ts": float}
_CIRCUIT_REGISTRY: dict = {}
_CIRCUIT_THRESHOLD = 3        # 连续失败 N 次后触发熔断
_CIRCUIT_COOLDOWN = 600.0     # 熔断后多少秒内拒绝所有调用


def _circuit_state() -> dict:
    loop = asyncio.get_running_loop()
    lid = id(loop)
    if lid not in _CIRCUIT_REGISTRY:
        _CIRCUIT_REGISTRY[lid] = {"fails": 0, "until_ts": 0.0}
    return _CIRCUIT_REGISTRY[lid]


def _circuit_check_open() -> None:
    """若熔断已打开，立刻抛错；否则不动。"""
    state = _circuit_state()
    loop = asyncio.get_running_loop()
    if state["until_ts"] > loop.time():
        remain = int(state["until_ts"] - loop.time())
        raise RuntimeError(f"即梦熔断器开启（连续失败 {state['fails']} 次），{remain}s 后恢复")


def _circuit_record_success() -> None:
    state = _circuit_state()
    state["fails"] = 0
    state["until_ts"] = 0.0


def _circuit_record_failure() -> None:
    state = _circuit_state()
    state["fails"] += 1
    if state["fails"] >= _CIRCUIT_THRESHOLD:
        loop = asyncio.get_running_loop()
        state["until_ts"] = loop.time() + _CIRCUIT_COOLDOWN
        logger.error(
            f"即梦熔断器已开启（连续失败 {state['fails']} 次），后续 {_CIRCUIT_COOLDOWN}s 内全部短路"
        )


# ---------------------------------------------------------------------------
# Volcengine HMAC-SHA256 签名
# ---------------------------------------------------------------------------

def _hmac_sha256(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _build_auth(
    access_key: str,
    secret_key: str,
    query: str,
    body: bytes,
) -> Tuple[str, str, str]:
    """
    生成 Authorization Header、X-Date Header 和 X-Content-Sha256。
    返回 (authorization, x_date, payload_hash)
    """
    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y%m%d")
    x_date = now.strftime("%Y%m%dT%H%M%SZ")
    content_type = "application/json"

    # Payload hash
    payload_hash = hashlib.sha256(body).hexdigest()

    # Headers to sign（按字母排序）— 必须包含 x-content-sha256
    headers = {
        "content-type": content_type,
        "host": _HOST,
        "x-content-sha256": payload_hash,
        "x-date": x_date,
    }
    sorted_headers = sorted(headers.items())
    canonical_headers = "".join(f"{k}:{v}\n" for k, v in sorted_headers)
    signed_headers = ";".join(k for k, _ in sorted_headers)

    # Canonical request
    canonical_request = "\n".join([
        "POST",
        _PATH,
        query,
        canonical_headers,
        signed_headers,
        payload_hash,
    ])

    # Credential scope
    credential_scope = f"{date_str}/{_REGION}/{_SERVICE}/request"

    # String to sign
    string_to_sign = "\n".join([
        "HMAC-SHA256",
        x_date,
        credential_scope,
        hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
    ])

    # Signing key 派生（遵循官方 SDK：直接使用 secret_key，不加 "volc" 前缀）
    k_date    = _hmac_sha256(secret_key.encode("utf-8"), date_str)
    k_region  = _hmac_sha256(k_date, _REGION)
    k_service = _hmac_sha256(k_region, _SERVICE)
    k_signing = _hmac_sha256(k_service, "request")

    signature = hmac.new(k_signing, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    authorization = (
        f"HMAC-SHA256 Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, "
        f"Signature={signature}"
    )
    return authorization, x_date, payload_hash


# ---------------------------------------------------------------------------
# 任务提交 & 轮询（Seedream 4.6 异步接口）
# ---------------------------------------------------------------------------

async def _submit_task(access_key: str, secret_key: str, payload: dict) -> str:
    """提交生成任务，返回 task_id"""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    authorization, x_date, payload_hash = _build_auth(access_key, secret_key, _QUERY_SUBMIT, body)

    url = f"https://{_HOST}{_PATH}?{_QUERY_SUBMIT}"
    headers = {
        "Authorization": authorization,
        "Content-Type": "application/json",
        "Host": _HOST,
        "X-Content-Sha256": payload_hash,
        "X-Date": x_date,
    }

    async with httpx.AsyncClient(timeout=60) as client:
        resp = await client.post(url, content=body, headers=headers)
        resp.raise_for_status()
        result = resp.json()

    code = result.get("code")
    if code != 10000:
        raise RuntimeError(f"即梦提交任务失败: code={code} msg={result.get('message','')} req_id={result.get('request_id','')}")

    task_id = result.get("data", {}).get("task_id")
    if not task_id:
        raise RuntimeError("即梦提交任务未返回 task_id")

    logger.info(f"即梦任务已提交: task_id={task_id}")
    return task_id


async def _poll_task(access_key: str, secret_key: str, task_id: str, timeout: int = 300) -> bytes:
    """
    轮询任务结果直至 status=done，返回图像字节。
    轮询间隔：5s，超时：timeout 秒（默认 300s）。
    """
    poll_payload = {
        "req_key": _REQ_KEY,
        "task_id": task_id,
        "req_json": json.dumps({"return_url": True}),
    }

    waited = 0
    while waited < timeout:
        await asyncio.sleep(5)
        waited += 5

        body = json.dumps(poll_payload, ensure_ascii=False).encode("utf-8")
        authorization, x_date, payload_hash = _build_auth(access_key, secret_key, _QUERY_POLL, body)

        url = f"https://{_HOST}{_PATH}?{_QUERY_POLL}"
        headers = {
            "Authorization": authorization,
            "Content-Type": "application/json",
            "Host": _HOST,
            "X-Content-Sha256": payload_hash,
            "X-Date": x_date,
        }

        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(url, content=body, headers=headers)
            resp.raise_for_status()
            result = resp.json()

        code   = result.get("code")
        data   = result.get("data") or {}
        status = data.get("status", "")

        logger.debug(f"即梦轮询 task_id={task_id}: status={status}")

        if status in ("in_queue", "generating"):
            continue

        if status == "done":
            if code != 10000:
                raise RuntimeError(f"即梦任务失败: code={code} msg={result.get('message','')}")

            image_urls = data.get("image_urls") or []
            b64_list   = data.get("binary_data_base64") or []

            if image_urls and image_urls[0]:
                async with httpx.AsyncClient(timeout=120) as client:
                    r = await client.get(image_urls[0])
                    r.raise_for_status()
                    return r.content
            elif b64_list and b64_list[0]:
                return base64.b64decode(b64_list[0])
            else:
                raise RuntimeError("即梦任务完成但未返回图像数据")

        if status in ("not_found", "expired"):
            raise RuntimeError(f"即梦任务状态异常: {status}")

    raise RuntimeError(f"即梦任务轮询超时 ({timeout}s): task_id={task_id}")


async def _generate(access_key: str, secret_key: str, payload: dict, retries: int = 2) -> bytes:
    """
    串行调用 Seedream 4.6：提交 → 轮询完成。
    通过模块级 Semaphore(1) 保证同时只有 1 个请求在执行。
    失败时自动重试（默认 2 次），指数退避。
    """
    last_err: Exception | None = None
    # 进入前先检查熔断器：上一轮调用已确认服务不可用时直接抛错
    _circuit_check_open()
    for attempt in range(retries + 1):
        try:
            async with _get_semaphore():
                task_id = await _submit_task(access_key, secret_key, payload)
                data = await _poll_task(access_key, secret_key, task_id)
            _circuit_record_success()
            return data
        except Exception as e:
            last_err = e
            if attempt < retries:
                wait = 3 * (attempt + 1)
                logger.warning(f"即梦生成失败（{e}），{wait}s 后重试（{attempt+1}/{retries}）")
                await asyncio.sleep(wait)
            else:
                logger.error(f"即梦生成最终失败: {e}")
                _circuit_record_failure()
    raise last_err if last_err else RuntimeError("即梦生成失败")



# ---------------------------------------------------------------------------
# 绿幕抠图（Chroma Key Removal）
# ---------------------------------------------------------------------------

def _remove_chroma_key(img_bytes: bytes, green_thresh: int = 35, min_green: int = 55) -> bytes:
    """
    去除绿色背景，返回带透明通道的 PNG 字节。
    使用全局候选掩码：凡是满足绿色阈值的像素一律视为背景（含角色内部绿色区域，
    如绿色丝袜/绿幕痕迹等），与边缘是否相连无关。
    若绿色像素占比过低（模型未遵循绿幕指令），自动回退到边缘颜色抠图。
    """
    img = Image.open(io.BytesIO(img_bytes)).convert("RGBA")
    arr = np.array(img, dtype=np.int32)

    r = arr[:, :, 0]
    g = arr[:, :, 1]
    b = arr[:, :, 2]

    greenness = g - np.maximum(r, b)
    # 所有满足绿色条件的像素直接视为背景（包括角色内部绿色）
    bg_mask = (greenness >= green_thresh) & (g >= min_green)

    # 检测绿幕是否有效：绿色像素占比 < 5% 则视为模型未生成绿幕背景
    green_pixel_count = int(np.count_nonzero(bg_mask))
    total_pixels = arr.shape[0] * arr.shape[1]
    if green_pixel_count < total_pixels * 0.05:
        logger.warning(
            "绿幕背景未检测到（绿色像素占比 %.1f%%），启用边缘颜色回退抠图",
            green_pixel_count / total_pixels * 100,
        )
        return _fallback_edge_removal(img_bytes)

    bg_mask_f = bg_mask.astype(np.float32)
    mask_img = Image.fromarray((bg_mask_f * 255).astype(np.uint8), mode='L')
    mask_img = mask_img.filter(ImageFilter.GaussianBlur(radius=1.0))
    soft_mask = np.array(mask_img, dtype=np.float32) / 255.0

    original_alpha = arr[:, :, 3].astype(np.float32) / 255.0
    new_alpha = original_alpha * (1.0 - soft_mask)

    result = arr.copy()
    result[:, :, 3] = (new_alpha * 255).astype(np.uint8)

    out = Image.fromarray(result.astype(np.uint8), 'RGBA')
    buf = io.BytesIO()
    out.save(buf, 'PNG')
    return buf.getvalue()


def _fallback_edge_removal(img_bytes: bytes, color_tolerance: int = 25) -> bytes:
    """
    回退抠图：当图像模型未生成绿幕背景时启用。
    从图像四角采样确定背景主色，使用 BFS 泛洪填充从四边去除背景色。
    比全局颜色替换更安全，不会误伤角色身上与背景相近的颜色。
    """
    img = Image.open(io.BytesIO(img_bytes)).convert("RGBA")
    arr = np.array(img, dtype=np.int32)
    h, w = arr.shape[:2]

    # 采样四角 10×10 区域作为背景色参考
    corner_size = min(10, h // 8, w // 8)
    sample_regions = [
        arr[:corner_size, :corner_size, :3],
        arr[:corner_size, -corner_size:, :3],
        arr[-corner_size:, :corner_size, :3],
        arr[-corner_size:, -corner_size:, :3],
    ]
    corner_pixels = np.concatenate([s.reshape(-1, 3) for s in sample_regions], axis=0)
    bg_color = np.median(corner_pixels, axis=0).astype(np.int32)  # [R, G, B]

    r = arr[:, :, 0]
    g = arr[:, :, 1]
    b = arr[:, :, 2]

    # Chebyshev 距离（L∞ norm），对单色背景效果好
    color_dist = np.maximum(
        np.maximum(np.abs(r - bg_color[0]), np.abs(g - bg_color[1])),
        np.abs(b - bg_color[2]),
    )
    candidate = color_dist < color_tolerance

    # 仅从边缘相连的候选像素才被去除，防止误伤角色内部相似色
    bg_mask = _flood_fill_background(candidate)

    bg_mask_f = bg_mask.astype(np.float32)
    mask_img = Image.fromarray((bg_mask_f * 255).astype(np.uint8), mode='L')
    mask_img = mask_img.filter(ImageFilter.GaussianBlur(radius=2.0))
    soft_mask = np.array(mask_img, dtype=np.float32) / 255.0

    original_alpha = arr[:, :, 3].astype(np.float32) / 255.0
    new_alpha = original_alpha * (1.0 - soft_mask)
    result = arr.copy()
    result[:, :, 3] = (new_alpha * 255).astype(np.uint8)

    out = Image.fromarray(result.astype(np.uint8), 'RGBA')
    buf = io.BytesIO()
    out.save(buf, 'PNG')
    logger.info("回退抠图完成：背景色 RGB(%d,%d,%d)", bg_color[0], bg_color[1], bg_color[2])
    return buf.getvalue()


def _flood_fill_background(candidate: np.ndarray) -> np.ndarray:
    """
    从图像四边向内传播，标记与边缘相连的候选背景像素。
    使用迭代膨胀（BFS近似）避免 scipy 依赖。
    """
    h, w = candidate.shape
    visited = np.zeros((h, w), dtype=bool)

    # 初始化边缘种子
    seed = np.zeros((h, w), dtype=bool)
    seed[0, :] = candidate[0, :]
    seed[-1, :] = candidate[-1, :]
    seed[:, 0] = candidate[:, 0]
    seed[:, -1] = candidate[:, -1]
    visited |= seed

    # 迭代传播（最多 min(h,w)/2 次，足以覆盖整个背景）
    frontier = visited.copy()
    for _ in range(max(h, w)):
        # 向 4 方向膨胀
        shifted = (
            np.roll(frontier, 1, 0) |
            np.roll(frontier, -1, 0) |
            np.roll(frontier, 1, 1) |
            np.roll(frontier, -1, 1)
        )
        new_frontier = shifted & candidate & ~visited
        if not new_frontier.any():
            break
        visited |= new_frontier
        frontier = new_frontier

    return visited


def _extract_main_character(img_bytes: bytes) -> bytes:
    """
    若图像包含多个角色立绘（AI 偶发生成多图），仅保留最大的单个前景连通区域。
    使用降采样（1/8 分辨率）进行 BFS 连通域分析，速度快，适合 1152×2048 大图。
    """
    img = Image.open(io.BytesIO(img_bytes)).convert("RGBA")
    arr = np.array(img, dtype=np.uint8)
    alpha = arr[:, :, 3]
    h_full, w_full = alpha.shape

    # 若前景像素极少，直接返回
    fg_count = np.count_nonzero(alpha > 20)
    if fg_count < 500:
        return img_bytes

    # 降采样（1/8 倍）进行连通域分析
    scale = 8
    small = (alpha[::scale, ::scale] > 20).astype(np.uint8)
    h_s, w_s = small.shape

    labels = np.zeros((h_s, w_s), dtype=np.int32)
    label_id = 0
    label_sizes: dict = {}
    label_centroids: dict = {}

    for y0 in range(h_s):
        for x0 in range(w_s):
            if small[y0, x0] and labels[y0, x0] == 0:
                label_id += 1
                stack = [(y0, x0)]
                labels[y0, x0] = label_id
                cnt = 0
                sum_x = 0
                while stack:
                    y, x = stack.pop()
                    cnt += 1
                    sum_x += x
                    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h_s and 0 <= nx < w_s and small[ny, nx] and labels[ny, nx] == 0:
                            labels[ny, nx] = label_id
                            stack.append((ny, nx))
                label_sizes[label_id] = cnt
                label_centroids[label_id] = sum_x / max(cnt, 1)

    if not label_sizes:
        return img_bytes

    # 若只有一个区域，无需处理
    if len(label_sizes) == 1:
        return img_bytes

    # 选择最大区域（多个同等大小时优先取最靠近水平中心的）
    center_x = w_s / 2.0
    max_size = max(label_sizes.values())
    # 面积在最大的 80% 以上都视为候选，取其中最居中的
    candidates = {
        lid: label_centroids[lid]
        for lid, sz in label_sizes.items()
        if sz >= max_size * 0.8
    }
    best_label = min(candidates, key=lambda lid: abs(candidates[lid] - center_x))

    # 主区域掩码 → 上采样回原分辨率
    main_mask_small = (labels == best_label).astype(np.uint8) * 255
    main_mask_img = Image.fromarray(main_mask_small, mode='L').resize(
        (w_full, h_full), Image.NEAREST
    )
    main_mask = np.array(main_mask_img) > 128

    # 仅保留主角区域的 alpha
    result = arr.copy()
    result[:, :, 3] = np.where(main_mask, alpha, 0).astype(np.uint8)

    out = Image.fromarray(result, 'RGBA')
    buf = io.BytesIO()
    out.save(buf, 'PNG')
    regions = len(label_sizes)
    logger.info(f"单角色提取: 检测到 {regions} 个区域，保留最大居中区域 (label={best_label})")
    return buf.getvalue()


_EXPRESSION_MAP: dict[str, str] = {
    "normal":    "神情平静自然",
    "happy":     "温柔微笑，眼神明亮",
    "sad":       "神情悲伤，眼角微垂",
    "surprised": "眼睛睁大，嘴微张，惊讶表情",
    "angry":     "眉头紧锁，眼神凌厉，愤怒",
    "shy":       "双颊红晕，羞涩微笑，眼神微避",
    "serious":   "神情严肃，目光坚定",
    "hurt":      "神情痛苦，眼含泪光",
}


# ---------------------------------------------------------------------------
# 公开接口
# ---------------------------------------------------------------------------

async def generate_portrait(
    access_key: str,
    secret_key: str,
    character_appearance: str,
    expression: str,
    global_style: str,
) -> bytes:
    """
    生成角色立绘，9:16 竖版（1152×2048），绿幕背景自动抠图，返回透明 PNG。
    """
    expr_desc = _EXPRESSION_MAP.get(expression, expression)

    prompt = (
        f"【绿幕抠图专用】纯绿色背景 #00FF00，绿幕，单一均匀纯色背景，绝对不含任何场景环境梯度阴影；"
        f"{global_style}，{character_appearance}，{expr_desc}，"
        f"全身站立，单人居中，"
        f"竖版 9:16 构图"
    )

    payload = {
        "req_key": _REQ_KEY,
        "prompt": prompt,
        "width": 1152,
        "height": 2048,
        "force_single": True,
    }

    logger.info(f"即梦Seedream4.6立绘生成: {character_appearance[:40]} [{expression}]")
    raw_bytes = await _generate(access_key, secret_key, payload)

    try:
        # 先抠绿幕（含角色内部绿色区域）
        png_bytes = _remove_chroma_key(raw_bytes)
        # 再提取最大单角色区域（防止多角色出现在同一张图）
        png_bytes = _extract_main_character(png_bytes)
        logger.info(f"立绘抠图完成: {character_appearance[:30]}")
        return png_bytes
    except Exception as e:
        logger.warning(f"绿幕抠图失败，返回原图: {e}")
        return raw_bytes


async def generate_background(
    access_key: str,
    secret_key: str,
    scene_description: str,
    global_style: str,
) -> bytes:
    """
    生成场景背景图，16:9 横版（2048×1152），匹配玩家全屏视口避免裁切。
    """
    prompt = (
        f"视觉小说场景背景，{scene_description}，"
        f"无人物，无角色，纯场景环境，"
        f"精致细节，电影质感光线，"
        f"横版16比9宽屏构图，高质量插画"
    )

    payload = {
        "req_key": _REQ_KEY,
        "prompt": prompt,
        "width": 2048,
        "height": 1152,
        "force_single": True,
    }

    logger.info(f"即梦Seedream4.6背景生成: {scene_description[:50]}")
    return await _generate(access_key, secret_key, payload)


async def generate_cover(
    access_key: str,
    secret_key: str,
    title: str,
    synopsis: str,
    characters: list,
    key_scenes: list,
    global_style: str,
) -> bytes:
    """
    生成故事封面图，3:4 竖版（864×1152）。
    整合全部角色外貌描述 + 关键场景，生成电影海报风格封面。
    """
    # 提取角色外貌（最多 2 个主角，外貌截断至 60 字防止 prompt 过长）
    char_descs = []
    for c in characters[:2]:
        appearance = c.get("appearance", "") or c.get("description", "")
        name = c.get("name", "")
        if appearance:
            char_descs.append(f"{name}：{appearance[:60]}")

    # 提取关键场景描述（最多 1 个，截断至 80 字）
    scene_desc_raw = ""
    for s in key_scenes[:1]:
        scene_desc_raw = (s.get("background_description") or s.get("background_desc", ""))[:80]
        if scene_desc_raw:
            break

    char_block = "，".join(char_descs) if char_descs else "主角人物"
    scene_block = scene_desc_raw or "唯美宏大场景"
    # global_style 截断至 60 字（英文描述往往很长）
    style_hint = global_style[:60]

    prompt = (
        f"{style_hint}风格书籍封面，"
        f"《{title}》，"
        f"人物：{char_block}，"
        f"电影海报美学，光影戏剧化，色彩丰富，"
        f"竖版3比4构图，高质量动漫插画"
    )

    payload = {
        "req_key": _REQ_KEY,
        "prompt": prompt,
        "width": 768,
        "height": 1024,
        "force_single": True,
    }

    logger.info(f"即梦Seedream4.6封面生成: {title[:40]}")
    return await _generate(access_key, secret_key, payload)


async def generate_cg(
    access_key: str,
    secret_key: str,
    cg_prompt: str,
) -> bytes:
    """
    生成 CG 插图，9:16 竖版（1152×2048），返回图像字节。
    """
    prompt = (
        f"视觉小说CG插图，{cg_prompt}，"
        f"情感表达丰富，精细画面，高质量动漫插画，"
        f"竖版9比16构图"
    )

    payload = {
        "req_key": _REQ_KEY,
        "prompt": prompt,
        "width": 1152,
        "height": 2048,
        "force_single": True,
    }

    logger.info(f"即梦Seedream4.6 CG生成: {cg_prompt[:50]}")
    return await _generate(access_key, secret_key, payload)
