from app.routers.games import router as games_router
from app.routers.tasks import router as tasks_router
from app.routers.config import router as config_router

__all__ = ["games_router", "tasks_router", "config_router"]
