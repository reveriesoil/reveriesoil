"""
图像生成高层接口（开源版）。

职责：提示词构建 + 提供商分发 → 图像字节。
提供商驱动逻辑集中在 image_providers.py。
"""

from typing import Optional

from app.services.ai.image_providers import (
    detect_provider,
    generate_ark,
    generate_generic,
    generate_openai,
    generate_openrouter,
    generate_siliconflow,
)

# ---------------------------------------------------------------------------
# 立绘表情词典（统一维护）
# ---------------------------------------------------------------------------

_EXPRESSION_MAP: dict[str, str] = {
    "normal":    "neutral expression, calm",
    "happy":     "smiling warmly, bright eyes",
    "sad":       "sad expression, slightly downcast eyes",
    "surprised": "surprised expression, wide eyes",
    "angry":     "angry expression, furrowed brows",
    "shy":       "blushing, shy expression",
    "serious":   "serious expression, determined look",
}


# ---------------------------------------------------------------------------
# 内部分发函数
# ---------------------------------------------------------------------------

async def _dispatch(
    prompt: str,
    size_key: str,
    api_key: str,
    model: str,
    endpoint: Optional[str],
    quality: str = "standard",
) -> bytes:
    """统一分发到对应 provider，返回图像字节。"""
    provider = detect_provider(endpoint)
    if provider == "siliconflow":
        return await generate_siliconflow(prompt, size_key, api_key, model, endpoint)
    elif provider == "ark":
        return await generate_ark(prompt, size_key, api_key, model, endpoint)
    elif provider == "openrouter":
        return await generate_openrouter(prompt, api_key, model, endpoint)
    elif provider == "openai":
        return await generate_openai(prompt, size_key, quality, api_key, model, endpoint)
    else:  # generic
        return await generate_generic(prompt, size_key, api_key, model, endpoint)


# ---------------------------------------------------------------------------
# 公开接口
# ---------------------------------------------------------------------------

async def generate_portrait(
    character_appearance: str,
    expression: str,
    global_style: str,
    api_key: str,
    model: str = "dall-e-3",
    endpoint: str = None,
) -> bytes:
    """生成角色立绘（竖版 9:16，绿幕背景），返回图像字节。
    抠图后返回透明背景 PNG；失败时返回原图字节。
    """
    expr_desc = _EXPRESSION_MAP.get(expression, expression)
    # 绿幕指令置顶强化，以便所有模型都遵循；风格由 global_style 决定
    prompt = (
        f"CHROMA KEY GREEN SCREEN: solid flat pure green #00FF00 background ONLY. "
        f"Single uniform color background, absolutely NO scenery NO environment NO landscape NO gradient NO shadow on background. "
        f"Character must NOT have any green, lime, or yellow-green colored elements: no green clothing, no green hair, no green skin, no green accessories. "
        f"Visual novel character sprite, {global_style} art style, {character_appearance}, "
        f"{expr_desc}, "
        f"flat even lighting, no directional light, no shadows on character, no specular highlights, no rim light, no dramatic shading, uniform soft illumination, "
        f"full body standing pose from head to feet, character facing forward with a slight three-quarter angle, neutral idle stance, arms relaxed at sides, "
        f"consistent camera distance and framing, character occupies approximately 80 percent of the vertical canvas, head positioned in upper 12 percent of the frame, feet visible in the lower 5 percent, "
        f"identical scale and pose composition across all expressions of the same character, "
        f"character centered in frame, vertical portrait format, high quality"
    )
    raw = await _dispatch(prompt, "portrait", api_key, model, endpoint, quality="standard")
    try:
        from app.services.ai.jimeng_gen import _remove_chroma_key, _extract_main_character
        png_bytes = _remove_chroma_key(raw)
        return _extract_main_character(png_bytes)
    except Exception:
        return raw


async def generate_background(
    scene_description: str,
    global_style: str,
    orientation: str = "landscape",
    api_key: str = "",
    model: str = "dall-e-3",
    endpoint: str = None,
) -> bytes:
    """生成场景背景图，返回图像字节。
    orientation: "landscape"（横版 16:9）或 "portrait"（竖版 9:16）
    """
    prompt = (
        f"Visual novel background, {scene_description}, {global_style}, "
        f"no characters, atmospheric, detailed environment, "
        f"{'wide cinematic shot' if orientation == 'landscape' else 'vertical composition'}, "
        f"high quality illustration"
    )
    size_key = "bg_landscape" if orientation == "landscape" else "bg_portrait"
    return await _dispatch(prompt, size_key, api_key, model, endpoint, quality="standard")


async def generate_cg(
    cg_prompt: str,
    api_key: str,
    model: str = "dall-e-3",
    endpoint: Optional[str] = None,
    negative_prompt: str = "",
) -> bytes:
    """生成人物互动 CG（宽幅横版 16:9），返回图像字节。"""
    prompt = (
        f"Visual novel CG illustration, {cg_prompt}, "
        f"cinematic composition, characters interacting emotionally, "
        f"rich detailed background environment (indoor/outdoor/nature/architecture), "
        f"dramatic lighting with depth and atmosphere, "
        f"high quality anime illustration, "
        f"no green screen, no chroma key background, no solid color background, no plain background"
    )
    return await _dispatch(prompt, "cg", api_key, model, endpoint, quality="hd")


async def generate_cover(
    title: str,
    synopsis: str,
    characters: list,
    scenes: list,
    global_style: str,
    api_key: str = "",
    model: str = "dall-e-3",
    endpoint: Optional[str] = None,
) -> bytes:
    """生成 3:4 竖版封面图，返回图像字节。"""
    char_desc = ", ".join(
        c.get("appearance", c.get("name", "")) for c in characters[:2]
        if c.get("appearance") or c.get("name")
    )
    prompt = (
        f"Book cover art, portrait orientation 3:4, "
        f"title: '{title}', "
        f"characters: {char_desc}, "
        f"scene-dominant composition, rich background detail, cinematic atmosphere, "
        f"style: {global_style}, no plain background, "
        f"dramatic lighting, high quality anime illustration, book cover composition"
    )
    return await _dispatch(prompt, "cover", api_key, model, endpoint, quality="hd")
