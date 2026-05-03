"""
PyInstaller 打包入口 — 桌面版后端服务器
用法（PyInstaller 在 opensource/backend/ 目录运行）：
    pyinstaller ../desktop/backend.spec
"""
import os
import sys

# PyInstaller 打包后 sys._MEIPASS 为解压目录，需要把它加入路径
if getattr(sys, 'frozen', False):
    base_dir = sys._MEIPASS  # type: ignore[attr-defined]
    # 确保 app 包可以被找到
    if base_dir not in sys.path:
        sys.path.insert(0, base_dir)

import uvicorn  # noqa: E402（必须在 sys.path 修改后导入）
from app.main import app  # noqa: E402

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 59876))
    uvicorn.run(
        app,
        host='127.0.0.1',
        port=port,
        log_level='info',
        # 关闭自动重载（生产模式）
        reload=False,
    )
