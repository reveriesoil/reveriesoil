"""games router（开源版：无用户鉴权，使用 asyncio 后台任务替代 Celery）"""
from datetime import datetime
from typing import List
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Game, GenerationTask, AIConfig
from app.schemas import (
    GameDetail, GameSummary, GenerateRequest, TaskStatusResponse,
)

router = APIRouter(prefix="/games", tags=["games"])


def _strip_sensitive(cfg: dict) -> dict:
    """移除 API Key 等敏感字段，仅保留 provider/model/endpoint 供快照使用。"""
    if not isinstance(cfg, dict):
        return cfg
    result = {}
    for k, v in cfg.items():
        if k in ("api_key", "access_key_id", "secret_access_key"):
            continue
        if isinstance(v, dict):
            result[k] = _strip_sensitive(v)
        else:
            result[k] = v
    return result


async def _resolve_ai_config(db: AsyncSession, body_config: dict) -> dict:
    """
    合并：优先使用请求中携带的 api_key，否则从数据库已保存配置中补全。
    """
    result = await db.execute(select(AIConfig).limit(1))
    saved = result.scalar_one_or_none()
    saved_text = (saved.text_model or {}) if saved else {}
    saved_image = (saved.image_model or {}) if saved else {}
    saved_voice = (saved.voice_model or {}) if saved else {}
    saved_overrides = (saved.text_agent_overrides or {}) if saved else {}

    def _merge(body_block: dict, saved_block: dict) -> dict:
        merged = dict(saved_block)
        merged.update(body_block)
        # 若 body 中 api_key 为空，从已保存配置补全
        for field in ("api_key", "access_key_id", "secret_access_key"):
            if not merged.get(field) and saved_block.get(field):
                merged[field] = saved_block[field]
        return merged

    text_block = _merge(body_config.get("text_model", {}), saved_text)
    image_block = _merge(body_config.get("image_model", {}), saved_image)
    voice_block = _merge(body_config.get("voice_model", {}), saved_voice)

    # agent overrides 合并
    overrides = dict(saved_overrides)
    body_overrides = body_config.get("text_agent_overrides") or {}
    if isinstance(body_overrides, dict):
        overrides.update(body_overrides)
    if overrides:
        text_block["agent_overrides"] = overrides

    return {
        "text_model": text_block,
        "image_model": image_block,
        "voice_model": voice_block,
        "music_model": {"provider": "local", "enabled": False},
    }


@router.post("/generate", status_code=status.HTTP_202_ACCEPTED)
async def submit_generation(
    body: GenerateRequest,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    ai_config = await _resolve_ai_config(db, body.ai_config)

    game = Game(
        prompt=body.prompt,
        config_snapshot={
            **_strip_sensitive(ai_config),
            "__story_spec__": body.story_spec.model_dump(),
            "__character_prompt__": body.character_prompt or "",
        },
        script_json={},
        status="generating",
    )
    db.add(game)
    await db.flush()

    task = GenerationTask(game_id=game.id, status="pending", progress=0)
    db.add(task)
    await db.flush()
    await db.commit()
    await db.refresh(game)
    await db.refresh(task)

    # 派发后台 asyncio 任务（无 Celery）
    background_tasks.add_task(
        _run_generation_bg,
        str(game.id), str(task.id), body.prompt,
        ai_config, body.story_spec.model_dump(),
        body.character_prompt or "",
    )

    return {"task_id": str(task.id), "game_id": str(game.id)}


@router.get("/history", response_model=List[GameSummary])
async def get_history(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Game).order_by(Game.created_at.desc()).limit(50)
    )
    return result.scalars().all()


@router.get("/{game_id}", response_model=GameDetail)
async def get_game(game_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Game).where(Game.id == game_id))
    game = result.scalar_one_or_none()
    if not game:
        raise HTTPException(status_code=404, detail="游戏不存在")
    return game


@router.delete("/{game_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_game(game_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Game).where(Game.id == game_id))
    game = result.scalar_one_or_none()
    if not game:
        raise HTTPException(status_code=404, detail="游戏不存在")
    await db.delete(game)
    await db.commit()


@router.post("/{game_id}/retry", status_code=status.HTTP_202_ACCEPTED)
async def retry_generation(
    game_id: str,
    background_tasks: BackgroundTasks,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Game).where(Game.id == game_id))
    game = result.scalar_one_or_none()
    if not game:
        raise HTTPException(status_code=404, detail="游戏不存在")
    if game.status not in ("error", "cancelled"):
        raise HTTPException(status_code=400, detail="只有生成失败或已取消的游戏才能重试")

    game.status = "generating"
    game.updated_at = datetime.utcnow()

    config = dict(game.config_snapshot or {})
    story_spec_data = config.pop("__story_spec__", None)
    character_prompt = config.pop("__character_prompt__", "")
    from app.schemas import StorySpec
    story_spec = StorySpec(**story_spec_data).model_dump() if story_spec_data else StorySpec().model_dump()

    # 从 DB 补全凭据（snapshot 中已去掉 api_key）
    db_cfg_result = await db.execute(select(AIConfig).limit(1))
    db_cfg = db_cfg_result.scalar_one_or_none()
    if db_cfg:
        for block_key, saved_block in [
            ("text_model", db_cfg.text_model or {}),
            ("image_model", db_cfg.image_model or {}),
        ]:
            snap_block = config.get(block_key, {})
            for field in ("api_key", "access_key_id", "secret_access_key"):
                if not snap_block.get(field) and saved_block.get(field):
                    snap_block[field] = saved_block[field]
            config[block_key] = snap_block
    ai_config = config

    task = GenerationTask(game_id=game.id, status="pending", progress=0)
    db.add(task)
    await db.flush()
    await db.commit()
    await db.refresh(task)

    existing_script = game.script_json or {}
    has_valid_script = bool(
        isinstance(existing_script, dict)
        and existing_script.get("scenes")
        and existing_script.get("characters")
    )

    if has_valid_script:
        background_tasks.add_task(
            _run_image_regen_bg, str(game.id), str(task.id)
        )
    else:
        background_tasks.add_task(
            _run_generation_bg,
            str(game.id), str(task.id), game.prompt,
            ai_config, story_spec, character_prompt,
        )

    return {"task_id": str(task.id), "game_id": str(game.id)}


@router.get("/{game_id}/active-task", response_model=dict)
async def get_active_task(game_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(GenerationTask)
        .where(
            GenerationTask.game_id == game_id,
            GenerationTask.status.in_(("pending", "running", "done", "failed")),
        )
        .order_by(GenerationTask.created_at.desc())
        .limit(1)
    )
    task = result.scalar_one_or_none()
    if not task:
        return {"task": None}
    from app.schemas import TaskStatusResponse
    return {"task": TaskStatusResponse.model_validate(task)}


# ── 后台任务函数 ──────────────────────────────────────────────────────────────

async def _run_generation_bg(
    game_id: str, task_id: str, prompt: str,
    ai_config: dict, story_spec: dict, character_prompt: str,
):
    """在 FastAPI 的 BackgroundTasks 中运行完整生成流程（无 Celery）"""
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from sqlalchemy.pool import StaticPool
    from app.config import settings
    from app.services.ai.orchestrator import GenerationOrchestrator
    from app.services.ai import text_gen
    import logging

    logger = logging.getLogger(__name__)

    _engine = create_async_engine(
        settings.database_url,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        echo=False,
    )
    _Session = async_sessionmaker(_engine, expire_on_commit=False)

    _counter: dict = {"total": 0}
    text_gen._token_counter.set(_counter)

    async def update_progress(step: str, progress: int, error: str = None, model: str = None):
        async with _Session() as db:
            values = {
                "status": "running", "current_step": step,
                "progress": progress, "updated_at": datetime.utcnow(),
                "token_usage": _counter.get("total", 0),
            }
            if model is not None:
                values["current_model"] = model
            if error:
                values["status"] = "failed"
                values["error_msg"] = error
            await db.execute(
                update(GenerationTask).where(GenerationTask.id == task_id).values(**values)
            )
            await db.commit()

    try:
        await update_progress("outline", 0)

        async def on_script_ready(script: dict):
            async with _Session() as db:
                title = script.get("title", "未命名故事")
                await db.execute(
                    update(Game).where(Game.id == game_id).values(
                        script_json=script, title=title, updated_at=datetime.utcnow()
                    )
                )
                await db.commit()

        orchestrator = GenerationOrchestrator(update_progress)
        result = await orchestrator.run(
            game_id, task_id, prompt, ai_config, story_spec,
            character_prompt=character_prompt,
            on_script_ready=on_script_ready,
        )

        async with _Session() as db:
            title = result["script_json"].get("title", "未命名故事")
            await db.execute(
                update(Game).where(Game.id == game_id).values(
                    script_json=result["script_json"],
                    assets_manifest=result["assets_manifest"],
                    title=title,
                    status="ready",
                    cover_url=result.get("cover_url", ""),
                    updated_at=datetime.utcnow(),
                )
            )
            await db.execute(
                update(GenerationTask).where(GenerationTask.id == task_id).values(
                    status="done", progress=100,
                    current_step="done",
                    token_usage=_counter.get("total", 0),
                    updated_at=datetime.utcnow(),
                )
            )
            await db.commit()

    except Exception as exc:
        logger.exception(f"生成任务失败 game={game_id}: {exc}")
        try:
            async with _Session() as db:
                await db.execute(
                    update(GenerationTask).where(GenerationTask.id == task_id).values(
                        status="failed", error_msg=str(exc)[:500],
                        updated_at=datetime.utcnow(),
                    )
                )
                await db.execute(
                    update(Game).where(Game.id == game_id).values(
                        status="error", updated_at=datetime.utcnow()
                    )
                )
                await db.commit()
        except Exception:
            pass
    finally:
        await _engine.dispose()


async def _run_image_regen_bg(game_id: str, task_id: str):
    """仅重新生成图片资产（剧本已存在时的 retry）"""
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from sqlalchemy.pool import StaticPool
    from app.config import settings
    from app.services.ai.orchestrator import GenerationOrchestrator
    import logging

    logger = logging.getLogger(__name__)

    _engine = create_async_engine(
        settings.database_url,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        echo=False,
    )
    _Session = async_sessionmaker(_engine, expire_on_commit=False)

    async def update_progress(step: str, progress: int, error: str = None, model: str = None):
        async with _Session() as db:
            values = {
                "status": "running", "current_step": step,
                "progress": progress, "updated_at": datetime.utcnow(),
            }
            if model is not None:
                values["current_model"] = model
            if error:
                values["status"] = "failed"
                values["error_msg"] = error
            await db.execute(
                update(GenerationTask).where(GenerationTask.id == task_id).values(**values)
            )
            await db.commit()

    try:
        await update_progress("portraits", 30)

        async with _Session() as db:
            result = await db.execute(select(Game).where(Game.id == game_id))
            game = result.scalar_one_or_none()

        if not game:
            raise ValueError("游戏记录不存在")

        snapshot = dict(game.config_snapshot or {})
        snapshot.pop("__story_spec__", None)
        snapshot.pop("__character_prompt__", "")

        # 从 DB 补全凭据
        async with _Session() as db:
            db_cfg_result = await db.execute(select(AIConfig).limit(1))
            db_cfg = db_cfg_result.scalar_one_or_none()
        if db_cfg:
            for block_key, saved_block in [
                ("image_model", db_cfg.image_model or {}),
            ]:
                snap_block = snapshot.get(block_key, {})
                for field in ("api_key", "access_key_id", "secret_access_key"):
                    if not snap_block.get(field) and saved_block.get(field):
                        snap_block[field] = saved_block[field]
                snapshot[block_key] = snap_block

        orchestrator = GenerationOrchestrator(update_progress)
        result = await orchestrator.run_image_only(game_id, task_id, game.script_json, snapshot)

        async with _Session() as db:
            await db.execute(
                update(Game).where(Game.id == game_id).values(
                    assets_manifest=result["assets_manifest"],
                    status="ready",
                    cover_url=result.get("cover_url", game.cover_url or ""),
                    updated_at=datetime.utcnow(),
                )
            )
            await db.execute(
                update(GenerationTask).where(GenerationTask.id == task_id).values(
                    status="done", progress=100,
                    current_step="done",
                    updated_at=datetime.utcnow(),
                )
            )
            await db.commit()

    except Exception as exc:
        logger.exception(f"图片重生成失败 game={game_id}: {exc}")
        try:
            async with _Session() as db:
                await db.execute(
                    update(GenerationTask).where(GenerationTask.id == task_id).values(
                        status="failed", error_msg=str(exc)[:500],
                        updated_at=datetime.utcnow(),
                    )
                )
                await db.execute(
                    update(Game).where(Game.id == game_id).values(
                        status="error", updated_at=datetime.utcnow()
                    )
                )
                await db.commit()
        except Exception:
            pass
    finally:
        await _engine.dispose()
