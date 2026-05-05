"""FastAPI 应用入口（开源版）"""
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import engine
from app.models import Game, GenerationTask, AIConfig, SaveRecord
from app.routers import games_router, tasks_router, config_router

_log_handlers = [logging.StreamHandler()]
_log_file = os.environ.get("LOG_FILE")
if _log_file:
    try:
        os.makedirs(os.path.dirname(_log_file), exist_ok=True)
        _fh = logging.FileHandler(_log_file, encoding="utf-8")
        _log_handlers.append(_fh)
    except Exception as _e:
        print(f"[main] failed to attach file log {_log_file}: {_e}", flush=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=_log_handlers,
    force=True,
)
logger = logging.getLogger(__name__)
if _log_file:
    logger.info(f"日志输出到文件: {_log_file}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时自动建表（SQLite），并启用 WAL 模式提升并发写性能
    from sqlalchemy import text, update
    from app.database import Base
    async with engine.begin() as conn:
        await conn.execute(text("PRAGMA journal_mode=WAL"))
        await conn.execute(text("PRAGMA busy_timeout=30000"))
        await conn.run_sync(Base.metadata.create_all)
    os.makedirs(settings.static_dir, exist_ok=True)
    logger.info(f"数据库初始化完成（WAL 模式），静态文件目录: {settings.static_dir}")

    # 清理孤立任务：上次进程意外退出时，BackgroundTasks 丢失
    # 但游戏状态仍停在 "generating"，导致重启后永远显示"等待中"
    from datetime import datetime
    from app.database import SessionLocal
    async with SessionLocal() as db:
        now = datetime.utcnow()
        # 将卡住的 generating 游戏标为 error
        r1 = await db.execute(
            update(Game)
            .where(Game.status == "generating")
            .values(status="error", updated_at=now)
        )
        # 将对应的 pending/running 任务标为 failed
        r2 = await db.execute(
            update(GenerationTask)
            .where(GenerationTask.status.in_(("pending", "running")))
            .values(
                status="failed",
                error_msg="应用重启，任务已中断，请点击故事卡片重试",
                updated_at=now,
            )
        )
        await db.commit()
        if r1.rowcount or r2.rowcount:
            logger.info(f"启动清理：{r1.rowcount} 个游戏、{r2.rowcount} 个任务标记为失败（进程重启所致）")

    yield
    await engine.dispose()


app = FastAPI(
    title="Dream It — 开源版",
    version="0.34.0",
    description="AI 互动故事生成引擎（开源版，无需注册，自带 API 配置，支持故事导出/导入）",
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
