"""GameProgress 模型（开源版：无用户系统，记录故事线进度）"""
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, String, Integer, UniqueConstraint
from sqlalchemy.orm import relationship

try:
    from sqlalchemy.dialects.sqlite import JSON
except ImportError:
    from sqlalchemy import JSON

from app.database import Base


class GameProgress(Base):
    __tablename__ = "game_progress"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    game_id = Column(String(36), ForeignKey("games.id", ondelete="CASCADE"), nullable=False, unique=True)
    current_scene = Column(String(100), nullable=False)
    dialogue_index = Column(Integer, default=0)
    visited_scenes = Column(JSON, default=list)
    choices_made = Column(JSON, default=list)
    play_time = Column(Integer, default=0)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    game = relationship("Game", back_populates="progress")
