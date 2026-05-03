from openai import AsyncOpenAI

# OpenAI TTS 音色映射
OPENAI_VOICE_MAP = {
    "male": "onyx",
    "female": "nova",
    "narrator": "alloy",
    "child": "shimmer",
    "elder": "fable",
    "default": "alloy",
}

# SiliconFlow / FishAudio 音色映射（fish-speech 系列）
SILICONFLOW_VOICE_MAP = {
    "male": "中文男声",
    "female": "中文女声",
    "narrator": "中文男声",
    "child": "中文女声",
    "elder": "中文男声",
    "default": "中文男声",
}

# SiliconFlow 常用 TTS 模型列表（判断是否走 siliconflow 分支）
_SILICONFLOW_TTS_MODELS = {
    "FishAudio/fish-speech-1.5",
    "FishAudio/fish-speech-1.4",
    "RVC-Boss/GPT-SoVITS",
    "Qwen/Qwen-TTS",
}


def _is_siliconflow_tts(endpoint: str | None, model: str) -> bool:
    """判断是否为 SiliconFlow TTS 请求"""
    if endpoint and "siliconflow" in endpoint:
        return True
    if model in _SILICONFLOW_TTS_MODELS:
        return True
    return False


async def synthesize_voice(
    text: str,
    character_gender: str = "default",
    api_key: str = "",
    model: str = "tts-1",
    endpoint: str = None,
) -> bytes:
    """合成语音，返回 MP3 字节。兼容 OpenAI TTS 和 SiliconFlow FishAudio。"""
    client = AsyncOpenAI(api_key=api_key, base_url=endpoint)

    if _is_siliconflow_tts(endpoint, model):
        # SiliconFlow：使用中文音色名称，fish-speech 接受 voice 参数
        voice = SILICONFLOW_VOICE_MAP.get(character_gender, "中文男声")
        # fish-speech-1.5 支持中文 reference speaker 名称
        # 若模型不支持 voice 参数，fallback 到 None（仅靠 model 决定音色）
        try:
            response = await client.audio.speech.create(
                model=model,
                voice=voice,
                input=text,
                response_format="mp3",
            )
            return response.content
        except Exception:
            # fish-speech 可能不需要 voice 参数，重试不传
            response = await client.audio.speech.create(
                model=model,
                voice="alloy",    # 通用 fallback
                input=text,
                response_format="mp3",
            )
            return response.content
    else:
        # OpenAI / 其他兼容接口
        voice = OPENAI_VOICE_MAP.get(character_gender, "alloy")
        response = await client.audio.speech.create(
            model=model,
            voice=voice,
            input=text,
            response_format="mp3",
            speed=1.0,
        )
        return response.content
