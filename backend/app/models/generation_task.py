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
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    game = relationship("Game", back_populates="tasks")
