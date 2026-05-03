"""FastAPI 应用入口（开源版）"""
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import engine
from app.models import Game, GenerationTask, AIConfig
from app.routers import games_router, tasks_router, config_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时自动建表（SQLite）
    from sqlalchemy import text
    from app.database import Base
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    os.makedirs(settings.static_dir, exist_ok=True)
    logger.info(f"数据库初始化完成，静态文件目录: {settings.static_dir}")
    yield
    await engine.dispose()


app = FastAPI(
    title="Dream It — 开源版",
    version="1.0.0",
    description="AI 互动故事生成引擎（开源版，无需注册，自带 API 配置）",
    lifespan=lifespan,
)

# CORS
origins_raw = [o.strip() for o in settings.cors_allow_origins.split(",") if o.strip()]
# "*" 单独一项时允许所有来源（桌面版使用）
if origins_raw == ["*"]:
    allow_all = True
    origins_list = ["*"]
else:
    allow_all = False
    origins_list = origins_raw or [settings.frontend_url, "http://localhost:3000", "http://localhost:5173"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins_list,
    allow_credentials=not allow_all,   # credentials 与通配符互斥
    allow_methods=["*"],
    allow_headers=["*"],
)

# 路由（前缀 /api 与前端 axios baseURL 及 Electron/nginx 代理路径匹配）
app.include_router(games_router, prefix="/api")
app.include_router(tasks_router, prefix="/api")
app.include_router(config_router, prefix="/api")

# 静态文件（图片/音频）
os.makedirs(settings.static_dir, exist_ok=True)
app.mount("/static", StaticFiles(directory=settings.static_dir), name="static")


@app.get("/health")
async def health():
    return {"status": "ok"}
