"""
seedream5_gen.py — 豆包 Seedream 5.0 (doubao-seedream-5-0-260128) 图像生成

使用火山引擎 ARK OpenAI 兼容接口：
  POST https://ark.cn-beijing.volces.com/api/v3/images/generations
鉴权：Bearer API Key（与 OpenAI SDK 兼容）

主要能力（相比 Seedream 4.x 有如下变化）：
  - 最低分辨率提升：总像素 >= 3686400（最小约 1921×1921，推荐 2048×2048）
  - 支持 output_format（jpeg/png），默认 jpeg
  - 不支持 guidance_scale 参数
  - response_format 支持 url / b64_json
  - watermark 默认 true，需显式关闭

本模块仅生成"单图"（sequential_image_generation=disabled），
覆盖 portrait / background / cg / cover 四类图像。
"""

import asyncio
import base64
import io
import logging
from typing import Optional

import httpx

from app.services.ai import AccountOverdueError

logger = logging.getLogger(__name__)

_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
_MODEL_ID = "doubao-seedream-5-0-260128"

# Seedream 5.0 推荐尺寸（总像素须 >= 3686400）
# 立绘 / CG：9:16  → 1600x2848
# 背景：     16:9  → 2560x1440（横版，匹配玩家全屏视口，避免拉伸/裁切）
# 封面：     3:4   → 1728x2304

_SIZE_PORTRAIT   = "1600x2848"   # 9:16 竖版立绘
_SIZE_BACKGROUND = "2560x1440"   # 16:9 横版背景（API最低要求3686400像素）
_SIZE_CG         = "1600x2848"   # 9:16 竖版 CG
_SIZE_COVER      = "1728x2304"   # 3:4  竖版封面

# 并发限制（参考 Seedream 5.0 lite 限流策略，保守设为 2）
_SEMAPHORE_REGISTRY: dict = {}


def _get_semaphore() -> asyncio.Semaphore:
    loop = asyncio.get_running_loop()
    lid = id(loop)
    if lid not in _SEMAPHORE_REGISTRY:
        _SEMAPHORE_REGISTRY[lid] = asyncio.Semaphore(2)
    return _SEMAPHORE_REGISTRY[lid]


async def _generate(
    api_key: str,
    prompt: str,
    size: str,
    output_format: Optional[str] = "png",
    retries: int = 2,
) -> bytes:
    """
    调用 Seedream 5.0 生成单张图片，返回图像字节。
    优先使用 response_format=url，下载后返回；失败时降级 b64_json。
    调用失败时自动重试（默认 2 次）。
    """
    last_err: Exception | None = None
    for attempt in range(retries + 1):
        try:
            async with _get_semaphore():
                headers = {
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                }
                payload = {
                    "model": _MODEL_ID,
                    "prompt": prompt,
                    "size": size,
                    "response_format": "url",
                    "watermark": False,
                    "sequential_image_generation": "disabled",
                }
                if output_format:
                    payload["output_format"] = output_format

                async with httpx.AsyncClient(timeout=httpx.Timeout(240.0, connect=10.0)) as client:
                    logger.info(f"[seedream5] POST size={size} attempt={attempt+1}/{retries+1}")
                    resp = await client.post(
                        f"{_ARK_BASE_URL}/images/generations",
                        headers=headers,
                        json=payload,
                    )
                    if resp.status_code != 200:
                        if resp.status_code == 403 and "AccountOverdue" in resp.text:
                            raise AccountOverdueError(
                                f"豆包 ARK 账户欠费，请充值后重试"
                            )
                        raise RuntimeError(
                            f"Seedream5 API 错误: status={resp.status_code} body={resp.text[:300]}"
                        )

                    result = resp.json()
                    data_list = result.get("data", [])
                    if not data_list:
                        raise RuntimeError(f"Seedream5 返回空 data: {result}")

                    item = data_list[0]
                    if "error" in item:
                        raise RuntimeError(
                            f"Seedream5 图片生成失败: code={item['error'].get('code')} "
                            f"msg={item['error'].get('message')}"
                        )

                    if item.get("url"):
                        img_resp = await client.get(item["url"], timeout=120)
                        img_resp.raise_for_status()
                        return img_resp.content

                    if item.get("b64_json"):
                        return base64.b64decode(item["b64_json"])

                    raise RuntimeError("Seedream5 返回数据中既无 url 也无 b64_json")
        except AccountOverdueError:
            raise
        except Exception as e:
            last_err = e
            if attempt < retries:
                wait = 3 * (attempt + 1)
                logger.warning(f"Seedream5 生成失败（{e}），{wait}s 后重试（{attempt+1}/{retries}）")
                await asyncio.sleep(wait)
            else:
                logger.error(f"Seedream5 生成最终失败: {e}")
    raise last_err if last_err else RuntimeError("Seedream5 生成失败")


# ---------------------------------------------------------------------------
# 公开接口（与 jimeng_gen 保持相同函数签名，便于 orchestrator 统一调用）
# ---------------------------------------------------------------------------

async def generate_portrait(
    api_key: str,
    character_appearance: str,
    expression: str,
    global_style: str,
) -> bytes:
    """
    生成角色立绘，9:16 竖版（1600×2848），返回透明 PNG 字节。
    使用绿幕背景生成 + 共用 jimeng_gen._remove_chroma_key 抠像。
    """
    _EXPRESSION_MAP = {
        "normal":    "神情平静自然",
        "happy":     "温柔微笑，眼神明亮",
        "sad":       "神情悲伤，眼角微垂",
        "surprised": "眼睛睁大，嘴微张，惊讶表情",
        "angry":     "眉头紧锁，眼神凌厉，愤怒",
        "shy":       "双颊红晕，羞涩微笑，眼神微避",
        "serious":   "神情严肃，目光坚定",
        "hurt":      "神情痛苦，眼含泪光",
    }
    expr_desc = _EXPRESSION_MAP.get(expression, expression)

    prompt = (
        f"【绿幕抠图专用】纯绿色背景 #00FF00，绿幕，单一均匀纯色背景，绝对不含任何场景环境梯度阴影；"
        f"{global_style}，{character_appearance}，{expr_desc}，"
        f"全身站立，单人居中，"
        f"竖版 9:16 构图"
    )

    logger.info(f"Seedream5立绘生成: {character_appearance[:40]} [{expression}]")
    raw_bytes = await _generate(api_key, prompt, _SIZE_PORTRAIT, output_format="png")
    # 统一抠像入口（rembg 优先，色域抠图回退），保持不同 provider 立绘渲染一致
    try:
        from app.services.ai.matting import cutout_portrait
        png_bytes = cutout_portrait(raw_bytes)
        logger.info(f"Seedream5 立绘抠图完成: {character_appearance[:30]}")
        return png_bytes
    except Exception as e:
        logger.warning(f"Seedream5 立绘抠图失败，返回原图: {e}")
        return raw_bytes


async def generate_background(
    api_key: str,
    scene_description: str,
    global_style: str,
) -> bytes:
    """生成场景背景图，16:9 横版（2560×1440 2K 超清），返回 JPEG 字节。"""
    prompt = (
        f"视觉小说场景背景，{scene_description}，"
        f"无人物，无角色，纯场景环境，"
        f"精致细节，电影质感光线，"
        f"横版16比9宽屏构图，高质量插画"
    )

    logger.info(f"Seedream5背景生成(2560×1440): {scene_description[:50]}")
    return await _generate(api_key, prompt, _SIZE_BACKGROUND, output_format="jpeg")


async def generate_cg(
    api_key: str,
    cg_prompt: str,
) -> bytes:
    """生成 CG 插图，9:16 竖版（1600×2848），返回 JPEG 字节。"""
    prompt = (
        f"视觉小说CG插图，精美场景叙事画面，"
        f"{cg_prompt}，"
        f"电影级构图，光线戏剧化，色彩丰富，高清细腻，"
        f"真实场景背景有深度（室内户外自然建筑），"
        f"竖版9比16构图，高质量动漫插画，"
        f"无绿幕，无纯色背景，无抠图背景"
    )

    logger.info(f"Seedream5 CG生成: {cg_prompt[:50]}")
    return await _generate(api_key, prompt, _SIZE_CG, output_format="jpeg")


async def generate_cover(
    api_key: str,
    title: str,
    synopsis: str,
    characters: list,
    key_scenes: list,
    global_style: str,
) -> bytes:
    """生成故事封面图，3:4 竖版（1728×2304），返回 JPEG 字节。"""
    # 提取角色外貌（最多 2 个，appearance 截断至 60 字防止 prompt 过长）
    char_descs = []
    for c in characters[:2]:
        appearance = c.get("appearance", "") or c.get("description", "")
        name = c.get("name", "")
        if appearance:
            char_descs.append(f"{name}：{appearance[:60]}")

    # 关键场景描述（最多 1 个，截断至 80 字）
    scene_desc_raw = ""
    for s in key_scenes[:1]:
        scene_desc_raw = (s.get("background_description") or s.get("background_desc", ""))[:80]
        if scene_desc_raw:
            break

    char_block  = "，".join(char_descs) if char_descs else "主角人物"
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

    logger.info(f"Seedream5封面生成: {title[:40]}")
    return await _generate(api_key, prompt, _SIZE_COVER, output_format="jpeg")
