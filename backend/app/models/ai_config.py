"""AI 配置模型（开源版：本地配置，无加密）"""
import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, String
from sqlalchemy.orm import relationship

try:
    from sqlalchemy.dialects.sqlite import JSON
except ImportError:
    from sqlalchemy import JSON

from app.database import Base


class AIConfig(Base):
    __tablename__ = "ai_configs"

    id = Column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    config_name = Column(String(100), nullable=False, default="默认配置")
    text_model = Column(JSON)
    image_model = Column(JSON)
    voice_model = Column(JSON)
    text_agent_overrides = Column(JSON)
    is_default = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
