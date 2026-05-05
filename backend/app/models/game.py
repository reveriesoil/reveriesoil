"""Game 模型（开源版：无用户系统）"""
import uuid
from datetime import datetime

from sqlalchemy import Column, DateTime, Integer, String, Text
from sqlalchemy.orm import relationship

try:
    from sqlalchemy.dialects.sqlite import JSON
except ImportError:
    from sqlalchemy import JSON

from app.database import Base


class Game(Base):
    __tablename__ = "games"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    prompt = Column(Text, nullable=False)
    title = Column(String(200))
    script_json = Column(JSON, nullable=False, default=dict)
    assets_manifest = Column(JSON)
    config_snapshot = Column(JSON)
    # generating / ready / error
    status = Column(String(20), default="generating")
    estimated_duration = Column(Integer)
    cover_url = Column(String(1000))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    tasks = relationship("GenerationTask", back_populates="game", cascade="all, delete-orphan", passive_deletes=True)
    progress = relationship("GameProgress", back_populates="game", cascade="all, delete-orphan", passive_deletes=True, uselist=False)
