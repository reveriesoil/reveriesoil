from pydantic import BaseModel
from typing import Optional, Dict, Any, List
from datetime import datetime


class StorySpec(BaseModel):
    duration_minutes: int = 15
    branch_enabled: bool = True
    scene_count: Optional[int] = None
    title: Optional[str] = None
    depth: Optional[int] = 2
    interaction_level: Optional[int] = 2


class AIModelConfig(BaseModel):
    provider: str
    model: str
    api_key: Optional[str] = ""
    endpoint: Optional[str] = None


class GenerateRequest(BaseModel):
    prompt: str
    character_prompt: Optional[str] = ""
    story_style: Optional[str] = None
    art_style: Optional[str] = None
    ai_config: Dict[str, Any]
    story_spec: StorySpec


class TaskStatusResponse(BaseModel):
    id: str
    game_id: str
    status: str
    progress: int
    current_step: Optional[str] = None
    current_model: Optional[str] = None
    error_msg: Optional[str] = None
    token_usage: Optional[int] = 0
    # 每步起止时间戳（后端为 JSON 字符串，接口输出为数组）
    step_timings: Optional[List[Dict[str, Any]]] = None

    class Config:
        from_attributes = True


class GameSummary(BaseModel):
    id: str
    title: Optional[str] = None
    prompt: str
    synopsis: Optional[str] = None
    status: str
    estimated_duration: Optional[int] = None
    cover_url: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True


class GameDetail(GameSummary):
    script_json: Dict[str, Any] = {}
    assets_manifest: Optional[Dict[str, Any]] = None
    config_snapshot: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True


class AIConfigRequest(BaseModel):
    config_name: str = "默认配置"
    text_model: Dict[str, Any]
    image_model: Dict[str, Any]
    voice_model: Optional[Dict[str, Any]] = None
    text_agent_overrides: Optional[Dict[str, Any]] = None
    is_default: bool = True


class AIConfigResponse(BaseModel):
    id: str
    config_name: str
    text_model: Dict[str, Any]
    image_model: Dict[str, Any]
    voice_model: Optional[Dict[str, Any]] = None
    text_agent_overrides: Optional[Dict[str, Any]] = None
    is_default: bool
    created_at: datetime

    class Config:
        from_attributes = True


class GameProgressRequest(BaseModel):
    current_scene: str
    dialogue_index: int = 0
    visited_scenes: List[str] = []
    choices_made: List[Any] = []
    play_time: int = 0


class GameProgressResponse(BaseModel):
    id: Optional[str] = None
    game_id: str
    current_scene: str
    dialogue_index: int = 0
    visited_scenes: List[str] = []
    choices_made: List[Any] = []
    play_time: int = 0
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True
