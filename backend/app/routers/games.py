"""games router（开源版：无用户鉴权，使用 asyncio 后台任务替代 Celery）"""
import io
import json
import re
import uuid
import zipfile
from datetime import datetime
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, BackgroundTasks, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models import Game, GenerationTask, AIConfig, GameProgress
from app.schemas import (
    GameDetail, GameSummary, GenerateRequest, TaskStatusResponse,
    GameProgressRequest, GameProgressResponse,
)

EXPORT_FORMAT_VERSION = "1"   # 升级导出格式时递增

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

    # 必要凭据校验：无文本/图像 API Key 时直接 400，避免后台任务静默挂死
    text_block = ai_config.get("text_model") or {}
    image_block = ai_config.get("image_model") or {}
    if not (text_block.get("api_key") or "").strip():
        raise HTTPException(
            status_code=400,
            detail="请先在「AI 设置」中填写文本模型 API Key 后再生成"
        )
    image_provider = (image_block.get("provider") or "").lower()
    image_has_credential = bool(
        (image_block.get("api_key") or "").strip()
        or (image_provider == "jimeng" and (image_block.get("access_key_id") or "").strip()
            and (image_block.get("secret_access_key") or "").strip())
    )
    if not image_has_credential:
        raise HTTPException(
            status_code=400,
            detail="请先在「AI 设置」中填写图像模型 API Key（即梦请填写 AK/SK）后再生成"
        )

    story_spec_data = body.story_spec.model_dump()
    if body.story_style:
        story_spec_data["story_style"] = body.story_style
    if body.art_style:
        story_spec_data["art_style"] = body.art_style

    game = Game(
        prompt=body.prompt,
        config_snapshot={
            **_strip_sensitive(ai_config),
            "__story_spec__": story_spec_data,
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
        ai_config, story_spec_data,
        body.character_prompt or "",
    )

    return {"task_id": str(task.id), "game_id": str(game.id)}


def _extract_synopsis_from_script(script: dict) -> str:
    """从剧本数据提取简介，用于历史数据无AI synopsis的情况"""
    # 优先使用已有的 synopsis
    synopsis = (script.get("synopsis") or "").strip()
    if synopsis:
        return synopsis

    genre = script.get("genre", "")
    chars = script.get("characters", [])
    ending = script.get("ending", {})

    parts: list[str] = []
    if genre:
        parts.append(f"【{genre}】")

    # 角色背景（description = outline.background，中文）
    char_parts: list[str] = []
    for char in (chars or [])[:2]:
        if not isinstance(char, dict):
            continue
        name = (char.get("name") or "").strip()
        desc = (char.get("description") or "").strip()  # 来自 outline.background
        personality = (char.get("personality") or "").strip()
        if name and desc:
            char_parts.append(f"{name}——{desc[:40]}")
        elif name and personality:
            # 没有背景则用性格特点
            char_parts.append(f"{name}（{personality.split('，')[0]}）")
        elif name:
            char_parts.append(name)
    if char_parts:
        parts.append("；".join(char_parts) + "。")

    # 结局摘要
    if isinstance(ending, dict):
        ending_text = (ending.get("summary") or ending.get("description") or "").strip()
        if ending_text:
            parts.append(ending_text[:60])

    return "".join(parts) if parts else ""


@router.get("/history", response_model=List[GameSummary])
async def get_history(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(Game).order_by(Game.created_at.desc()).limit(50)
    )
    games = result.scalars().all()
    out = []
    for g in games:
        script = g.script_json or {}
        ai_title = script.get("title") if isinstance(script, dict) else None
        ai_synopsis = script.get("synopsis") if isinstance(script, dict) else None
        # 历史数据无AI synopsis时，从剧本字段构造简介
        if not ai_synopsis and isinstance(script, dict) and script.get("characters"):
            ai_synopsis = _extract_synopsis_from_script(script)
        out.append(GameSummary(
            id=str(g.id),
            title=ai_title or g.title,
            prompt=g.prompt,
            synopsis=ai_synopsis,
            status=g.status,
            estimated_duration=g.estimated_duration,
            cover_url=g.cover_url,
            created_at=g.created_at,
        ))
    return out


# ── 导出 ─────────────────────────────────────────────────────────────────────

def _compute_game_stats(script: dict, token_usage: int = 0) -> dict:
    """从 script_json 计算故事统计数据"""
    if not isinstance(script, dict):
        return {
            "total_images": 0, "portrait_count": 0, "background_count": 0,
            "cg_count": 0, "token_usage": token_usage,
            "total_words": 0, "scene_count": 0,
        }
    characters = script.get("characters") or []
    scenes = script.get("scenes") or []
    portrait_count = sum(len(c.get("portrait_urls") or {}) for c in characters)
    background_count = sum(1 for s in scenes if s.get("background_url"))
    cg_count = sum(1 for s in scenes if s.get("cg_url"))
    total_images = portrait_count + background_count + cg_count
    total_words = 0
    for s in scenes:
        for d in (s.get("dialogues") or []):
            total_words += len(d.get("text") or "")
        total_words += len(s.get("narration") or "")
    return {
        "total_images": total_images,
        "portrait_count": portrait_count,
        "background_count": background_count,
        "cg_count": cg_count,
        "token_usage": token_usage,
        "total_words": total_words,
        "scene_count": len(scenes),
    }


@router.get("/{game_id}/stats")
async def get_game_stats(game_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(Game).where(Game.id == game_id))
    game = result.scalar_one_or_none()
    if not game:
        raise HTTPException(status_code=404, detail="游戏不存在")
    task_result = await db.execute(
        select(GenerationTask)
        .where(GenerationTask.game_id == game.id)
        .order_by(GenerationTask.created_at.desc())
        .limit(1)
    )
    task = task_result.scalar_one_or_none()
    token_usage = task.token_usage if task and task.token_usage else 0
    return _compute_game_stats(game.script_json or {}, token_usage)


@router.get("/{game_id}/export")
async def export_game(game_id: str, db: AsyncSession = Depends(get_db)):
    """将已完成的故事打包为 .rsz 文件（ZIP 格式）供分享导入。"""
    result = await db.execute(select(Game).where(Game.id == game_id))
    game = result.scalar_one_or_none()
    if not game:
        raise HTTPException(status_code=404, detail="游戏不存在")
    if game.status != "ready":
        raise HTTPException(status_code=400, detail="只有生成完成的故事才能导出")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # ── 1. 元数据 ──
        meta = {
            "export_version": EXPORT_FORMAT_VERSION,
            "game_id": str(game.id),
            "prompt": game.prompt,
            "title": (game.script_json or {}).get("title", "") if isinstance(game.script_json, dict) else "",
            "status": game.status,
            "estimated_duration": game.estimated_duration,
            "cover_url": game.cover_url,
            "created_at": game.created_at.isoformat() if game.created_at else None,
            "script_json": game.script_json,
            "assets_manifest": game.assets_manifest,
            "config_snapshot": game.config_snapshot,
        }
        zf.writestr("game_meta.json", json.dumps(meta, ensure_ascii=False, indent=2))

        # ── 2. 资源文件 ──
        assets_dir = Path(settings.static_dir) / "games" / game_id
        if assets_dir.exists():
            for fp in assets_dir.rglob("*"):
                if fp.is_file():
                    rel = fp.relative_to(Path(settings.static_dir))
                    zf.write(fp, f"assets/{rel}")

    buf.seek(0)
    title_raw = (game.script_json or {}).get("title", "") if isinstance(game.script_json, dict) else ""
    safe_title = (title_raw or "story").strip()[:40] or "story"
    from urllib.parse import quote
    ascii_title = re.sub(r"[^\x20-\x7E]", "_", safe_title)
    ascii_clean = re.sub(r"[^\w\-\. ]", "_", ascii_title)
    ascii_filename = f"ReverieSoil_{ascii_clean}.rsz"
    encoded_filename = f"ReverieSoil_{quote(safe_title, safe='')}.rsz"

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=\"{ascii_filename}\"; filename*=UTF-8''{encoded_filename}"},
    )


# ── 导入 ─────────────────────────────────────────────────────────────────────

_IMPORT_MAX_BYTES = 500 * 1024 * 1024  # 500 MB 上限，防止 OOM
_IMPORT_MAX_EXTRACTED = 1024 * 1024 * 1024  # 1 GB 解压总量上限，防 zip bomb


def _replace_game_id(obj, old: str, new: str):
    """递归遍历 JSON 树，将 old game_id 精确替换为 new game_id（避免误伤其他字段）。"""
    if not old:
        return obj
    if isinstance(obj, str):
        if obj == old:
            return new
        if f"games/{old}/" in obj:
            return obj.replace(f"games/{old}/", f"games/{new}/")
        return obj
    if isinstance(obj, dict):
        return {k: _replace_game_id(v, old, new) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_replace_game_id(x, old, new) for x in obj]
    return obj


@router.post("/import", status_code=status.HTTP_201_CREATED, response_model=GameSummary)
async def import_game(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
):
    """从 .rsz / .zip 文件导入故事，生成新的本地副本。"""
    if file.content_type not in ("application/zip", "application/octet-stream") and not (
        file.filename or ""
    ).lower().endswith((".rsz", ".zip")):
        raise HTTPException(status_code=400, detail="请上传 .rsz 或 .zip 格式的故事文件")

    raw = await file.read(_IMPORT_MAX_BYTES + 1)
    if len(raw) > _IMPORT_MAX_BYTES:
        raise HTTPException(status_code=413, detail="文件过大，最大支持 500 MB")

    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as zf:
            if "game_meta.json" not in zf.namelist():
                raise HTTPException(status_code=400, detail="无效的故事文件：缺少 game_meta.json")

            meta = json.loads(zf.read("game_meta.json").decode("utf-8"))
            old_game_id = meta.get("game_id") or ""
            new_game_id = str(uuid.uuid4())

            # 递归 JSON 树遍历替换 game_id（精确匹配，避免误伤）
            updated = _replace_game_id(meta, old_game_id, new_game_id)

            # 提取封面 URL
            cover_url = updated.get("cover_url")
            if not cover_url:
                manifest = updated.get("assets_manifest") or {}
                if isinstance(manifest, dict):
                    cover_url = manifest.get("cover_url") or manifest.get("cover")

            now = datetime.utcnow()
            game = Game(
                id=new_game_id,
                prompt=updated.get("prompt", ""),
                script_json=updated.get("script_json") or {},
                assets_manifest=updated.get("assets_manifest"),
                config_snapshot=updated.get("config_snapshot"),
                status="ready",
                estimated_duration=updated.get("estimated_duration"),
                cover_url=cover_url,
                created_at=now,
                updated_at=now,
            )
            db.add(game)

            # 解压资源文件（防 Zip Slip：校验路径在 assets_base 内 + 解压总量限制）
            assets_base = Path(settings.static_dir).resolve()
            total_extracted = 0
            for name in zf.namelist():
                if not name.startswith("assets/"):
                    continue
                rel = name[len("assets/"):]
                # Zip Slip 一级校验：拒绝路径穿越和绝对路径
                if not rel or ".." in rel.split("/") or rel.startswith(("/", "\\")) or ":" in rel:
                    continue
                if old_game_id:
                    rel = rel.replace(f"games/{old_game_id}/", f"games/{new_game_id}/")
                dest = (assets_base / rel).resolve()
                # 安全校验：目标路径必须在 assets_base 内
                if not str(dest).startswith(str(assets_base)):
                    continue
                data = zf.read(name)
                total_extracted += len(data)
                if total_extracted > _IMPORT_MAX_EXTRACTED:
                    raise HTTPException(status_code=413, detail="解压后内容过大，疑似恶意压缩包")
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(data)

            await db.commit()
            await db.refresh(game)

    except zipfile.BadZipFile:
        raise HTTPException(status_code=400, detail="文件损坏，无法解析")
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"导入失败：{str(exc)[:200]}") from exc

    script = game.script_json or {}
    ai_title = script.get("title") if isinstance(script, dict) else None
    ai_synopsis = script.get("synopsis") if isinstance(script, dict) else None
    if not ai_synopsis and isinstance(script, dict) and script.get("characters"):
        ai_synopsis = _extract_synopsis_from_script(script)

    return GameSummary(
        id=str(game.id),
        title=ai_title or game.title,
        prompt=game.prompt,
        synopsis=ai_synopsis,
        status=game.status,
        estimated_duration=game.estimated_duration,
        cover_url=game.cover_url,
        created_at=game.created_at,
    )


# ── 游戏详情 ──────────────────────────────────────────────────────────────────

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

    # 创建新任务记录（继承上一个任务的 token_usage，让前端可看到累计消耗）
    last_task = (await db.execute(
        select(GenerationTask)
        .where(GenerationTask.game_id == game_id)
        .order_by(GenerationTask.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()
    inherited_tokens = int(last_task.token_usage or 0) if last_task else 0
    task = GenerationTask(game_id=game.id, status="pending", progress=0, token_usage=inherited_tokens)
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


# ── 故事线进度 ──────────────────────────────────────────────────────────────


async def _ensure_game_exists(db: AsyncSession, game_id: str) -> Game:
    result = await db.execute(select(Game).where(Game.id == game_id))
    game = result.scalar_one_or_none()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    return game


@router.get("/{game_id}/progress", response_model=Optional[GameProgressResponse])
async def get_game_progress(game_id: str, db: AsyncSession = Depends(get_db)):
    """获取玩家的故事线进度（已访问场景、做出的选择），无记录时返回 null。"""
    await _ensure_game_exists(db, game_id)
    result = await db.execute(
        select(GameProgress).where(GameProgress.game_id == game_id)
    )
    return result.scalar_one_or_none()


@router.post("/{game_id}/progress")
async def save_game_progress(
    game_id: str,
    body: GameProgressRequest,
    db: AsyncSession = Depends(get_db),
):
    """保存玩家的故事线进度。"""
    await _ensure_game_exists(db, game_id)
    result = await db.execute(
        select(GameProgress).where(GameProgress.game_id == game_id)
    )
    rec = result.scalar_one_or_none()
    if rec is None:
        rec = GameProgress(
            game_id=game_id,
            current_scene=body.current_scene,
            dialogue_index=body.dialogue_index,
            visited_scenes=body.visited_scenes,
            choices_made=body.choices_made,
            play_time=body.play_time,
        )
        db.add(rec)
    else:
        rec.current_scene = body.current_scene
        rec.dialogue_index = body.dialogue_index
        rec.visited_scenes = body.visited_scenes
        rec.choices_made = body.choices_made
        rec.play_time = body.play_time
        rec.updated_at = datetime.utcnow()
    await db.commit()
    await db.refresh(rec)
    return {"message": "进度已保存", "id": str(rec.id)}


# ── 后台任务函数 ──────────────────────────────────────────────────────────────

async def _run_generation_bg(
    game_id: str, task_id: str, prompt: str,
    ai_config: dict, story_spec: dict, character_prompt: str,
):
    """在 FastAPI 的 BackgroundTasks 中运行完整生成流程（无 Celery）"""
    import logging
    logger = logging.getLogger(__name__)
    logger.info(f"[bg] _run_generation_bg 启动 game={game_id} task={task_id}")

    # SessionLocal 必须在 try 外部就绪，否则 except 分支无法落库失败状态
    from app.database import SessionLocal as _Session

    async def _mark_failed(msg: str):
        """统一的失败落库入口（即使后续 import 失败也能写状态）"""
        try:
            async with _Session() as db:
                await db.execute(
                    update(GenerationTask).where(GenerationTask.id == task_id).values(
                        status="failed", error_msg=msg[:500],
                        updated_at=datetime.utcnow(),
                    )
                )
                await db.execute(
                    update(Game).where(Game.id == game_id).values(
                        status="error", updated_at=datetime.utcnow()
                    )
                )
                await db.commit()
        except Exception as _e:
            logger.exception(f"[bg] 写入失败状态时再次出错: {_e}")

    try:
        from app.services.ai.orchestrator import GenerationOrchestrator
        from app.services.ai import text_gen
    except Exception as _imp_e:
        logger.exception(f"[bg] AI 模块导入失败: {_imp_e}")
        await _mark_failed(f"后台任务初始化失败（模块导入异常）: {_imp_e}")
        return

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
        # 立即标记 running，便于前端区分「BG 未启动」与「BG 已启动但卡住」
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

        async def on_portraits_done(current_script: dict, manifest: dict):
            """立绘批次完成后增量保存 portrait_urls（断点续传支持）"""
            import copy
            partial = copy.deepcopy(current_script)
            portraits = manifest.get("portraits", {})
            for char in partial.get("characters", []):
                char_id = char.get("id", "")
                if char_id and char_id in portraits:
                    char["portrait_urls"] = portraits[char_id]
            async with _Session() as db:
                await db.execute(
                    update(Game).where(Game.id == game_id).values(
                        script_json=partial, updated_at=datetime.utcnow()
                    )
                )
                await db.commit()
            logger.info(f"立绘 URL 已增量保存（断点续传）: game={game_id}")

        async def on_backgrounds_done(current_script: dict, manifest: dict):
            """背景批次完成后增量保存 background_url（断点续传支持）。
            在校验报错前调用，确保已成功生成的背景不会在重试时重复生成。"""
            import copy
            partial = copy.deepcopy(current_script)
            bgs = manifest.get("backgrounds", {})
            portraits = manifest.get("portraits", {})
            for char in partial.get("characters", []):
                char_id = char.get("id", "")
                if char_id and char_id in portraits:
                    char["portrait_urls"] = portraits[char_id]
            for scene in partial.get("scenes", []):
                scene_id = scene.get("id", "")
                if scene_id and bgs.get(scene_id):
                    scene["background_url"] = bgs[scene_id]
            async with _Session() as db:
                await db.execute(
                    update(Game).where(Game.id == game_id).values(
                        script_json=partial, updated_at=datetime.utcnow()
                    )
                )
                await db.commit()
            logger.info(f"背景 URL 已增量保存（断点续传）: game={game_id}")

        orchestrator = GenerationOrchestrator(update_progress)
        result = await orchestrator.run(
            game_id, task_id, prompt, ai_config, story_spec,
            character_prompt=character_prompt,
            on_script_ready=on_script_ready,
            on_portraits_done=on_portraits_done,
            on_backgrounds_done=on_backgrounds_done,
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


async def _run_image_regen_bg(game_id: str, task_id: str):
    """仅重新生成图片资产（剧本已存在时的 retry）"""
    from app.database import SessionLocal as _Session
    from app.services.ai.orchestrator import GenerationOrchestrator
    import logging

    logger = logging.getLogger(__name__)

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

        script_json_ref = dict(game.script_json or {})

        async def on_portraits_done_regen(current_script: dict, manifest: dict):
            """立绘批次完成后增量保存 portrait_urls（断点续传支持）"""
            import copy
            partial = copy.deepcopy(script_json_ref)
            portraits = manifest.get("portraits", {})
            for char in partial.get("characters", []):
                char_id = char.get("id", "")
                if char_id and char_id in portraits:
                    char["portrait_urls"] = portraits[char_id]
            async with _Session() as db:
                await db.execute(
                    update(Game).where(Game.id == game_id).values(
                        script_json=partial, updated_at=datetime.utcnow()
                    )
                )
                await db.commit()
            logger.info(f"立绘 URL 已增量保存（断点续传）: game={game_id}")

        async def on_backgrounds_done_regen(current_script: dict, manifest: dict):
            """背景批次完成后增量保存 background_url（断点续传支持）"""
            import copy
            partial = copy.deepcopy(script_json_ref)
            bgs = manifest.get("backgrounds", {})
            portraits = manifest.get("portraits", {})
            for char in partial.get("characters", []):
                char_id = char.get("id", "")
                if char_id and char_id in portraits:
                    char["portrait_urls"] = portraits[char_id]
            for scene in partial.get("scenes", []):
                scene_id = scene.get("id", "")
                if scene_id and bgs.get(scene_id):
                    scene["background_url"] = bgs[scene_id]
            async with _Session() as db:
                await db.execute(
                    update(Game).where(Game.id == game_id).values(
                        script_json=partial, updated_at=datetime.utcnow()
                    )
                )
                await db.commit()
            logger.info(f"背景 URL 已增量保存（断点续传）: game={game_id}")

        result = await orchestrator.run_image_only(
            game_id, task_id, script_json_ref, snapshot,
            on_portraits_done=on_portraits_done_regen,
            on_backgrounds_done=on_backgrounds_done_regen,
        )

        async with _Session() as db:
            await db.execute(
                update(Game).where(Game.id == game_id).values(
                    script_json=result["script_json"],
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
