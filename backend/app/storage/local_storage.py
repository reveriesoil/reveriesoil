"""local_storage.py — 本地文件存储，替代 MinIO（开源版）"""
import os
import logging
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)


def _ensure_dir(path: str):
    os.makedirs(os.path.dirname(path), exist_ok=True)


async def upload_bytes(data: bytes, object_key: str, content_type: str = "application/octet-stream") -> str:
    """
    将字节数据写入本地 static 目录，返回可访问的 URL 路径。

    object_key 示例: "games/{game_id}/portraits/{char_id}_normal.png"
    返回示例: "/static/games/{game_id}/portraits/{char_id}_normal.png"
    """
    if not data:
        return ""
    dest = Path(settings.static_dir) / object_key
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        dest.write_bytes(data)
        url = f"/static/{object_key}"
        logger.debug(f"文件已写入: {dest} → {url}")
        return url
    except Exception as e:
        logger.error(f"本地存储写入失败 {dest}: {e}")
        return ""


async def delete_file(object_key: str) -> bool:
    """删除本地文件，返回是否成功"""
    dest = Path(settings.static_dir) / object_key
    try:
        if dest.exists():
            dest.unlink()
        return True
    except Exception as e:
        logger.warning(f"删除文件失败 {dest}: {e}")
        return False


def get_local_path(object_key: str) -> str:
    """返回本地文件的绝对路径"""
    return str(Path(settings.static_dir) / object_key)
