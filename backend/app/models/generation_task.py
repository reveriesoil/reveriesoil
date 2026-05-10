"""GenerationTask 模型（开源版：无 Celery）"""
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, String, Text, ForeignKey
from sqlalchemy.orm import relationship

from app.database import Base


class GenerationTask(Base):
    __tablename__ = "generation_tasks"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    game_id = Column(String(36), ForeignKey("games.id"), nullable=False)
    # pending / running / done / failed / cancelled
    status = Column(String(20), default="pending")
    progress = Column(Integer, default=0)
    current_step = Column(String(50))
    current_model = Column(String(100))
    error_msg = Column(Text)
    token_usage = Column(Integer, default=0)
    # 每步起止时间戳（JSON 字符串），格式：[{"step": "outline", "started_at": <epoch_ms>, "finished_at": <epoch_ms>|null, "model": "..."}, ...]
    # 由 update_progress 在 step 切换时维护；前端用此渲染精确耗时，告别 polling 间隔误差。
    step_timings = Column(Text)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    game = relationship("Game", back_populates="tasks")
