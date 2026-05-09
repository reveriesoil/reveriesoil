"""config router — AI 配置管理（开源版：本地存储，无加密，无用户隔离）"""
import time
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
import httpx

from app.database import get_db
from app.models import AIConfig
from app.schemas import AIConfigRequest, AIConfigResponse

router = APIRouter(prefix="/config", tags=["config"])

AGENT_KEYS = [
    {"key": "outline",        "name": "总编剧（大纲）",        "desc": "Step 1：创作故事大纲、人物档案与场景规划"},
    {"key": "refine",         "name": "剧本统筹师（校审）",    "desc": "Step 2：检查大纲结构、人物一致性、节奏并修正"},
    {"key": "director",       "name": "艺术总监（导演）",      "desc": "Step 3：定义全局艺术风格、人物视觉与声音设计"},
    {"key": "image_prompts",  "name": "执行导演（绘图提示词）", "desc": "Step 4：将艺术指导转化为详细的 AI 绘图 prompt"},
    {"key": "voice_direction","name": "配音导演（TTS 风格）",   "desc": "Step 5：为每个角色生成 TTS 音色风格提示词"},
    {"key": "storyboard",     "name": "分镜师（对话脚本）",     "desc": "Step 6：将场景大纲展开为完整对话台词与选项"},
]


@router.get("/agents")
async def get_agent_list():
    return {"agents": AGENT_KEYS}


@router.get("/models")
async def get_supported_models():
    """开源版：返回空列表，模型由用户自行填写"""
    return {"text": [], "image": [], "voice": []}


@router.post("/save", response_model=AIConfigResponse)
async def save_config(body: AIConfigRequest, db: AsyncSession = Depends(get_db)):
    """保存 AI 配置（唯一一条，始终覆盖写）"""
    result = await db.execute(select(AIConfig).limit(1))
    existing = result.scalar_one_or_none()
    if existing:
        await db.execute(
            update(AIConfig).where(AIConfig.id == existing.id).values(
                config_name=body.config_name,
                text_model=body.text_model,
                image_model=body.image_model,
                voice_model=body.voice_model,
                text_agent_overrides=body.text_agent_overrides,
                is_default=True,
            )
        )
        await db.commit()
        await db.refresh(existing)
        return existing
    else:
        cfg = AIConfig(
            config_name=body.config_name,
            text_model=body.text_model,
            image_model=body.image_model,
            voice_model=body.voice_model,
            text_agent_overrides=body.text_agent_overrides,
            is_default=True,
        )
        db.add(cfg)
        await db.commit()
        await db.refresh(cfg)
        return cfg


@router.get("/load", response_model=list[AIConfigResponse])
async def load_config(db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(AIConfig).limit(1))
    cfg = result.scalar_one_or_none()
    return [cfg] if cfg else []


# ─── Model Test ────────────────────────────────────────────────────────────────

class TestModelRequest(BaseModel):
    model_type: str   # "text" | "image" | "voice"
    endpoint: str
    api_key: str
    model: str


class TestModelResponse(BaseModel):
    success: bool
    message: str
    latency_ms: int


@router.post("/test-model", response_model=TestModelResponse)
async def test_model(body: TestModelRequest):
    """测试模型接口连通性及 API Key 有效性"""
    if not body.endpoint.strip():
        return TestModelResponse(success=False, message="未填写 API Base URL", latency_ms=0)
    if not body.api_key.strip():
        return TestModelResponse(success=False, message="未填写 API Key", latency_ms=0)
    if not body.model.strip():
        return TestModelResponse(success=False, message="未填写模型名称", latency_ms=0)

    base_url = body.endpoint.rstrip("/")
    headers = {
        "Authorization": f"Bearer {body.api_key}",
        "Content-Type": "application/json",
    }

    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            if body.model_type == "text":
                resp = await client.post(
                    f"{base_url}/chat/completions",
                    headers=headers,
                    json={
                        "model": body.model,
                        "messages": [{"role": "user", "content": "Hi"}],
                        "max_tokens": 5,
                        "stream": False,
                    },
                )
            elif body.model_type == "image":
                resp = await client.post(
                    f"{base_url}/images/generations",
                    headers=headers,
                    json={
                        "model": body.model,
                        "prompt": "a white cat",
                        "n": 1,
                        "size": "256x256",
                    },
                )
            elif body.model_type == "voice":
                resp = await client.post(
                    f"{base_url}/audio/speech",
                    headers=headers,
                    json={
                        "model": body.model,
                        "input": "Hi",
                        "voice": "alloy",
                    },
                )
            else:
                return TestModelResponse(success=False, message="未知模型类型", latency_ms=0)

        latency_ms = int((time.monotonic() - t0) * 1000)

        if resp.status_code in (200, 201):
            return TestModelResponse(success=True, message=f"连接成功，响应 {resp.status_code}", latency_ms=latency_ms)

        # 尝试解析错误信息
        try:
            detail = resp.json()
            err_msg = (
                detail.get("error", {}).get("message")
                or detail.get("detail")
                or str(detail)
            )
        except Exception:
            err_msg = resp.text[:200] if resp.text else f"HTTP {resp.status_code}"

        # 常见错误友好提示
        if resp.status_code == 401:
            return TestModelResponse(success=False, message=f"API Key 无效或已过期（401）：{err_msg}", latency_ms=latency_ms)
        if resp.status_code == 403:
            return TestModelResponse(success=False, message=f"无权限访问此模型（403）：{err_msg}", latency_ms=latency_ms)
        if resp.status_code == 404:
            return TestModelResponse(success=False, message=f"接口地址不存在（404），请检查 Base URL：{err_msg}", latency_ms=latency_ms)
        if resp.status_code == 429:
            # 429 说明 key 有效但触发限流，视为连接成功
            return TestModelResponse(success=True, message=f"连接成功（触发限流，Key 有效）", latency_ms=latency_ms)
        if resp.status_code == 400:
            return TestModelResponse(success=False, message=f"模型名称错误或参数不支持（400）：{err_msg}", latency_ms=latency_ms)

        return TestModelResponse(success=False, message=f"HTTP {resp.status_code}：{err_msg}", latency_ms=latency_ms)

    except httpx.ConnectError:
        latency_ms = int((time.monotonic() - t0) * 1000)
        return TestModelResponse(success=False, message="无法连接到服务器，请检查 Base URL 是否正确", latency_ms=latency_ms)
    except httpx.TimeoutException:
        latency_ms = int((time.monotonic() - t0) * 1000)
        return TestModelResponse(success=False, message="连接超时（20s），服务器无响应", latency_ms=latency_ms)
    except Exception as e:
        latency_ms = int((time.monotonic() - t0) * 1000)
        return TestModelResponse(success=False, message=f"请求失败：{str(e)[:120]}", latency_ms=latency_ms)

