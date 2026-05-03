import asyncio
import base64
import io
from typing import Optional

from openai import AsyncOpenAI


def _is_siliconflow(endpoint: Optional[str]) -> bool:
    return bool(endpoint and "siliconflow" in endpoint)


def _is_openrouter(endpoint: Optional[str]) -> bool:
    return bool(endpoint and "openrouter" in endpoint)


async def generate_portrait(
    character_appearance: str,
    expression: str,
    global_style: str,
    api_key: str,
    model: str = "dall-e-3",
    endpoint: str = None,
) -> bytes:
    """生成角色立绘，返回图像字节"""
    client = AsyncOpenAI(api_key=api_key, base_url=endpoint)

    expression_map = {
        "normal": "neutral expression, calm",
        "happy": "smiling warmly, bright eyes",
        "sad": "sad expression, slightly downcast eyes",
        "surprised": "surprised expression, wide eyes",
        "angry": "angry expression, furrowed brows",
        "shy": "blushing, shy expression",
        "serious": "serious expression, determined look",
    }
    expr_desc = expression_map.get(expression, expression)

    # 固定绿幕背景便于抠图，强制 2D 动漫插画风格
    prompt = (
        f"2D anime visual novel character sprite, {character_appearance}, "
        f"{expr_desc}, "
        f"full body standing pose, complete figure from head to feet, long legs visible, "
        f"solid flat bright green background #00FF00, chroma key green screen background, "
        f"single uniform flat color background, absolutely no scenery no environment no landscape, "
        f"2D anime illustration, clean line art, cel-shaded coloring, "
        f"character centered in frame, vertical portrait format, high quality"
    )

    if _is_siliconflow(endpoint):
        response = await client.images.generate(
            model=model,
            prompt=prompt,
            size="576x1024",  # 竖版立绘
            n=1,
        )
        # 硅基流动返回 URL
        import httpx
        async with httpx.AsyncClient() as hc:
            r = await hc.get(response.data[0].url, timeout=60)
            return r.content
    elif _is_openrouter(endpoint):
        response = await client.images.generate(
            model=model,
            prompt=prompt,
            n=1,
        )
        import httpx
        async with httpx.AsyncClient() as hc:
            r = await hc.get(response.data[0].url, timeout=60)
            return r.content
    else:
        response = await client.images.generate(
            model=model,
            prompt=prompt,
            size="1024x1792",
            quality="standard",
            n=1,
            response_format="b64_json",
        )
        return base64.b64decode(response.data[0].b64_json)


async def generate_background(
    scene_description: str,
    global_style: str,
    orientation: str = "landscape",
    api_key: str = "",
    model: str = "dall-e-3",
    endpoint: str = None,
) -> bytes:
    """生成场景背景图，返回图像字节"""
    client = AsyncOpenAI(api_key=api_key, base_url=endpoint)

    prompt = (
        f"Visual novel background, {scene_description}, {global_style}, "
        f"no characters, atmospheric, detailed environment, "
        f"{'wide cinematic shot' if orientation == 'landscape' else 'vertical composition'}, "
        f"high quality illustration"
    )

    if _is_siliconflow(endpoint):
        response = await client.images.generate(
            model=model,
            prompt=prompt,
            size="1024x576" if orientation == "landscape" else "576x1024",
            n=1,
        )
        import httpx
        async with httpx.AsyncClient() as hc:
            r = await hc.get(response.data[0].url, timeout=60)
            return r.content
    elif _is_openrouter(endpoint):
        response = await client.images.generate(
            model=model,
            prompt=prompt,
            n=1,
        )
        import httpx
        async with httpx.AsyncClient() as hc:
            r = await hc.get(response.data[0].url, timeout=60)
            return r.content
    else:
        size = "1792x1024" if orientation == "landscape" else "1024x1792"
        response = await client.images.generate(
            model=model,
            prompt=prompt,
            size=size,
            quality="standard",
            n=1,
            response_format="b64_json",
        )
        return base64.b64decode(response.data[0].b64_json)


async def generate_cg(
    cg_prompt: str,
    api_key: str,
    model: str = "dall-e-3",
    endpoint: Optional[str] = None,
    negative_prompt: str = "",
) -> bytes:
    """
    画师：生成人物互动 CG（宽幅横版构图，用于高潮/重要情感时刻）。
    返回图像字节。
    """
    client = AsyncOpenAI(api_key=api_key, base_url=endpoint)

    full_prompt = (
        f"Visual novel CG illustration, {cg_prompt}, "
        f"cinematic wide composition, two or more characters interacting, "
        f"emotionally evocative, detailed background, "
        f"high quality anime illustration, 16:9 landscape format"
    )

    if _is_siliconflow(endpoint):
        response = await client.images.generate(
            model=model,
            prompt=full_prompt,
            size="1024x576",
            n=1,
        )
        import httpx
        async with httpx.AsyncClient() as hc:
            r = await hc.get(response.data[0].url, timeout=60)
            return r.content
    elif _is_openrouter(endpoint):
        response = await client.images.generate(
            model=model,
            prompt=full_prompt,
            n=1,
        )
        import httpx
        async with httpx.AsyncClient() as hc:
            r = await hc.get(response.data[0].url, timeout=60)
            return r.content
    else:
        response = await client.images.generate(
            model=model,
            prompt=full_prompt,
            size="1792x1024",
            quality="hd",
            n=1,
            response_format="b64_json",
        )
        return base64.b64decode(response.data[0].b64_json)


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
    """生成 3:4 竖版封面图，返回图像字节"""
    client = AsyncOpenAI(api_key=api_key, base_url=endpoint)

    char_desc = ", ".join(
        c.get("appearance", c.get("name", "")) for c in characters[:2]
        if c.get("appearance") or c.get("name")
    )
    scene_desc = next(
        (s.get("background_description") or s.get("background_desc", "")
         for s in scenes if s.get("background_description") or s.get("background_desc")),
        ""
    )
    prompt = (
        f"Visual novel cover art, portrait orientation 3:4, "
        f"title: '{title}', story: {synopsis[:100]}, "
        f"wide establishing scene: {scene_desc[:120]}, "
        f"characters {char_desc} integrated naturally into the environment, "
        f"scene-dominant composition, rich background detail, cinematic atmosphere, "
        f"style: {global_style}, no plain background, no solo portrait close-up, "
        f"dramatic lighting, high quality anime illustration, book cover composition"
    )

    if _is_siliconflow(endpoint):
        response = await client.images.generate(
            model=model, prompt=prompt, size="576x1024", n=1,
        )
        import httpx
        async with httpx.AsyncClient() as hc:
            r = await hc.get(response.data[0].url, timeout=60)
            return r.content
    elif _is_openrouter(endpoint):
        response = await client.images.generate(model=model, prompt=prompt, n=1)
        import httpx
        async with httpx.AsyncClient() as hc:
            r = await hc.get(response.data[0].url, timeout=60)
            return r.content
    else:
        response = await client.images.generate(
            model=model, prompt=prompt,
            size="1024x1792", quality="hd", n=1, response_format="b64_json",
        )
        return base64.b64decode(response.data[0].b64_json)
