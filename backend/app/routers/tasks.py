"""tasks router（开源版：无用户鉴权）"""
import json
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Game, GenerationTask
from app.schemas import TaskStatusResponse

router = APIRouter(prefix="/tasks", tags=["tasks"])
STALE_TIMEOUT = timedelta(hours=2)


def _serialize_task(task: GenerationTask) -> dict:
    """把 ORM 模型转为响应 dict，step_timings 从 JSON 字符串解码为数组。"""
    timings_raw = getattr(task, "step_timings", None)
    timings_list: list = []
    if timings_raw:
        try:
            parsed = json.loads(timings_raw)
            if isinstance(parsed, list):
                timings_list = parsed
        except Exception:
            timings_list = []
    return {
        "id": task.id,
        "game_id": task.game_id,
        "status": task.status,
        "progress": task.progress or 0,
        "current_step": task.current_step,
        "current_model": task.current_model,
        "error_msg": task.error_msg,
        "token_usage": task.token_usage or 0,
        "step_timings": timings_list,
    }


async def _mark_stale(db: AsyncSession, task: GenerationTask):
    if task.status not in ("pending", "running") or not task.updated_at:
        return
    if datetime.utcnow() - task.updated_at <= STALE_TIMEOUT:
        return
    now = datetime.utcnow()
    task.status = "failed"
    task.error_msg = "生成任务超过 2 小时未更新，已自动标记失败，请重新生成"
    task.updated_at = now
    await db.execute(
        update(Game)
        .where(Game.id == task.game_id, Game.status == "generating")
        .values(status="error", updated_at=now)
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)


@router.get("/{task_id}", response_model=TaskStatusResponse)
async def get_task_status(task_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    await _mark_stale(db, task)
    return _serialize_task(task)


@router.post("/{task_id}/cancel")
async def cancel_task(task_id: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    if task.status in ("done", "failed", "cancelled"):
        raise HTTPException(status_code=400, detail="任务已结束，无法取消")
    now = datetime.utcnow()
    task.status = "cancelled"
    task.updated_at = now
    db.add(task)
    await db.execute(
        update(Game).where(Game.id == task.game_id).values(status="error", updated_at=now)
    )
    await db.commit()
    return {"detail": "已取消"}
