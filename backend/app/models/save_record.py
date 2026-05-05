"""SaveRecord 模型（开源版：无用户系统，多槽位）"""
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import relationship

try:
    from sqlalchemy.dialects.sqlite import JSON
except ImportError:
    from sqlalchemy import JSON

from app.database import Base


class SaveRecord(Base):
    __tablename__ = "save_records"
    __table_args__ = (
        UniqueConstraint("game_id", "slot_index", name="save_records_game_slot_uq"),
    )

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    game_id = Column(String(36), ForeignKey("games.id", ondelete="CASCADE"), nullable=False)
    slot_index = Column(Integer, nullable=False, default=0)
    name = Column(String(100))
    current_scene = Column(String(100), nullable=False)
    dialogue_index = Column(Integer, default=0)
    choices_made = Column(JSON, default=list)
    play_time = Column(Integer, default=0)
    thumbnail = Column(String(1000))
    scene_title = Column(String(200))
    dialogue_preview = Column(String(500))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
