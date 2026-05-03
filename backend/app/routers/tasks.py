"""tasks router（开源版：无用户鉴权）"""
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Game, GenerationTask
from app.schemas import TaskStatusResponse

router = APIRouter(prefix="/tasks", tags=["tasks"])
STALE_TIMEOUT = timedelta(hours=2)


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
    return task


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
