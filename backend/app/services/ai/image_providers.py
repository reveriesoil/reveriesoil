"""
图像生成提供商驱动层。

已验证平台（精确适配）：
  - openai:      OpenAI DALL-E 3（size / quality / response_format=b64_json）
  - ark:         火山引擎 ARK Seedream 5.x（总像素 ≥3686400，不接受 quality）
  - siliconflow: 硅基流动（image_size 参数，httpx 直接调用，URL 响应）

尽量适配平台（best-effort）：
  - openrouter:  OpenRouter（不传 size/quality；模型差异大，直接返回 URL）
  - generic:     通用 OpenAI 兼容接口（先完整参数，400 后退化为最简调用）
"""

import base64
from typing import Literal, Optional

import httpx
from openai import AsyncOpenAI

# ---------------------------------------------------------------------------
# Provider 识别
# ---------------------------------------------------------------------------

ProviderName = Literal["openai", "ark", "siliconflow", "openrouter", "generic"]


def detect_provider(endpoint: Optional[str]) -> ProviderName:
    """根据 endpoint URL 识别图像生成提供商。"""
    if not endpoint:
        return "openai"
    e = endpoint.lower()
    if "siliconflow" in e:
        return "siliconflow"
    if (
        "volces.com" in e
        or "volcengine" in e
        or "/ark." in e
        or e.startswith("https://ark.")
        or "ark.cn-" in e
    ):
        return "ark"
    if "openrouter" in e:
        return "openrouter"
    if "openai.com" in e:
        return "openai"
    return "generic"


# ---------------------------------------------------------------------------
# 尺寸常量
# ---------------------------------------------------------------------------

# 火山 ARK Seedream（总像素 >= 3686400 是硬性限制）
ARK_SIZES: dict[str, str] = {
    "portrait":     "1600x2848",   # 9:16  立绘
    "bg_landscape": "2560x1440",   # 16:9  横版背景
    "bg_portrait":  "1600x2848",   # 9:16  竖版背景
    "cg":           "2848x1600",   # 16:9  CG
    "cover":        "1728x2304",   # 3:4   封面
}

# 硅基流动 Kolors 等（image_size 参数，格式 WxH）
SF_SIZES: dict[str, str] = {
    "portrait":     "576x1024",    # 9:16
    "bg_landscape": "1024x576",    # 16:9
    "bg_portrait":  "576x1024",    # 9:16
    "cg":           "1024x576",    # 16:9
    "cover":        "768x1024",    # 3:4（比 576x1024 更接近 3:4）
}

# OpenAI DALL-E 3（size 参数）
DALLE_SIZES: dict[str, str] = {
    "portrait":     "1024x1792",   # ~9:16
    "bg_landscape": "1792x1024",   # ~16:9
    "bg_portrait":  "1024x1792",
    "cg":           "1792x1024",
    "cover":        "1024x1792",
}

# 通用回退尺寸（尽量适配，部分模型可能不支持）
GENERIC_SIZES: dict[str, str] = {
    "portrait":     "512x768",
    "bg_landscape": "768x512",
    "bg_portrait":  "512x768",
    "cg":           "768x512",
    "cover":        "512x768",
}


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def _normalize_base_url(endpoint: str) -> str:
    """将可能含完整路径的 endpoint 规范化为 base_url。

    去除 /images/generations 等常见后缀，供 OpenAI SDK 使用。
    示例：
      https://api.siliconflow.cn/v1/images/generations → https://api.siliconflow.cn/v1
      https://openrouter.ai/api/v1                     → https://openrouter.ai/api/v1（不变）
    """
    e = endpoint.rstrip("/")
    for suffix in ("/images/generations", "/v1/images/generations"):
        if e.endswith(suffix):
            e = e[: -len(suffix)]
            break
    return e


def _sf_images_url(endpoint: str) -> str:
    """规范化 SiliconFlow 图像端点，兼容 base_url 和完整 URL 两种格式。

    示例：
      https://api.siliconflow.cn/v1                     → https://api.siliconflow.cn/v1/images/generations
      https://api.siliconflow.cn/v1/images/generations  → 不变
    """
    e = endpoint.rstrip("/")
    if not e.endswith("/images/generations"):
        e += "/images/generations"
    return e


async def _download_url(url: str) -> bytes:
    """下载图像 URL，返回原始字节。"""
    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, connect=10.0)) as hc:
        r = await hc.get(url)
        r.raise_for_status()
        return r.content


# ---------------------------------------------------------------------------
# SiliconFlow（已验证）
# ---------------------------------------------------------------------------

async def generate_siliconflow(
    prompt: str,
    size_key: str,
    api_key: str,
    model: str,
    endpoint: str,
) -> bytes:
    """硅基流动图像生成（已验证）。

    关键差异（不使用 OpenAI SDK）：
    - 参数名为 image_size（非 size）
    - 直接 httpx POST 到完整 URL，避免 OpenAI SDK 路径拼接错误
    - 响应结构：images[].url 或 data[].url
    """
    url = _sf_images_url(endpoint)
    image_size = SF_SIZES.get(size_key, SF_SIZES["portrait"])
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    payload = {"model": model, "prompt": prompt, "image_size": image_size, "n": 1}

    async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=10.0)) as hc:
        resp = await hc.post(url, headers=headers, json=payload)
        if resp.status_code != 200:
            raise RuntimeError(
                f"SiliconFlow API 错误 {resp.status_code}: {resp.text[:300]}"
            )
        result = resp.json()
        data = result.get("images") or result.get("data") or []
        if not data or not data[0].get("url"):
            raise RuntimeError(f"SiliconFlow 返回无效数据: {result}")
        return await _download_url(data[0]["url"])


# ---------------------------------------------------------------------------
# 火山引擎 ARK（已验证）
# ---------------------------------------------------------------------------

async def generate_ark(
    prompt: str,
    size_key: str,
    api_key: str,
    model: str,
    endpoint: str,
) -> bytes:
    """火山引擎 ARK Seedream 图像生成（已验证）。

    关键约束：
    - size 总像素必须 >= 3686400（低于此值 API 报错）
    - 不传 quality 参数（Seedream 不支持，会报错）
    - 优先 response_format=b64_json；极少数情况回退 URL
    """
    size = ARK_SIZES.get(size_key, ARK_SIZES["portrait"])
    client = AsyncOpenAI(api_key=api_key, base_url=endpoint)
    response = await client.images.generate(
        model=model, prompt=prompt, size=size, n=1, response_format="b64_json"
    )
    if response.data and response.data[0].b64_json:
        return base64.b64decode(response.data[0].b64_json)
    if response.data and response.data[0].url:
        return await _download_url(response.data[0].url)
    raise RuntimeError("ARK API 返回空数据")


# ---------------------------------------------------------------------------
# OpenAI DALL-E（已验证）
# ---------------------------------------------------------------------------

async def generate_openai(
    prompt: str,
    size_key: str,
    quality: str,
    api_key: str,
    model: str,
    endpoint: Optional[str] = None,
) -> bytes:
    """OpenAI DALL-E 图像生成（已验证）。

    - size / quality / response_format=b64_json 全部有效
    - endpoint 可为 None（官方地址）或自定义兼容地址（如 Azure OpenAI）
    """
    size = DALLE_SIZES.get(size_key, DALLE_SIZES["portrait"])
    base_url = _normalize_base_url(endpoint) if endpoint else None
    client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    response = await client.images.generate(
        model=model, prompt=prompt, size=size, quality=quality,
        n=1, response_format="b64_json"
    )
    return base64.b64decode(response.data[0].b64_json)


# ---------------------------------------------------------------------------
# OpenRouter（尽量适配）
# ---------------------------------------------------------------------------

async def generate_openrouter(
    prompt: str,
    api_key: str,
    model: str,
    endpoint: str,
) -> bytes:
    """OpenRouter 图像生成（尽量适配）。

    策略：
    - 不传 size/quality（各托管模型支持差异极大）
    - 响应通常含 url，下载后返回字节
    - 若返回 b64_json 也能处理
    """
    client = AsyncOpenAI(api_key=api_key, base_url=_normalize_base_url(endpoint))
    response = await client.images.generate(model=model, prompt=prompt, n=1)
    if not response.data:
        raise RuntimeError("OpenRouter 未返回图像数据")
    if response.data[0].b64_json:
        return base64.b64decode(response.data[0].b64_json)
    if response.data[0].url:
        return await _download_url(response.data[0].url)
    raise RuntimeError("OpenRouter 响应既无 b64_json 也无 url")


# ---------------------------------------------------------------------------
# 通用 OpenAI 兼容接口（尽量适配）
# ---------------------------------------------------------------------------

async def generate_generic(
    prompt: str,
    size_key: str,
    api_key: str,
    model: str,
    endpoint: str,
) -> bytes:
    """通用 OpenAI 兼容图像接口（尽量适配）。

    适用场景：LocalAI、Fal.ai、ComfyUI API、自建兼容服务等。

    退化策略（自动逐步降级）：
    1. 携带 size + response_format=b64_json → 解码 b64 或下载 url
    2. 若步骤 1 报 400/422 → 退化为最简调用（仅 model + prompt）
    """
    size = GENERIC_SIZES.get(size_key)
    base_url = _normalize_base_url(endpoint)
    client = AsyncOpenAI(api_key=api_key, base_url=base_url)

    # 第一轮：带 size 和 response_format
    try:
        kw: dict = {"model": model, "prompt": prompt, "n": 1, "response_format": "b64_json"}
        if size:
            kw["size"] = size
        response = await client.images.generate(**kw)
        if response.data:
            if response.data[0].b64_json:
                return base64.b64decode(response.data[0].b64_json)
            if response.data[0].url:
                return await _download_url(response.data[0].url)
    except Exception:
        pass  # 退化到第二轮

    # 第二轮：最简调用
    response = await client.images.generate(model=model, prompt=prompt, n=1)
    if not response.data:
        raise RuntimeError(f"通用接口（{endpoint}）未返回图像数据")
    if response.data[0].b64_json:
        return base64.b64decode(response.data[0].b64_json)
    if response.data[0].url:
        return await _download_url(response.data[0].url)
    raise RuntimeError(f"通用接口（{endpoint}）响应格式无法解析")
