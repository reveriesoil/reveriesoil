# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec — ReverieSoil 开源版后端
在 opensource/backend/ 目录执行：
    pyinstaller ../desktop/backend.spec
"""

import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

_backend_dir = r'c:\Users\Administrator\Desktop\Dream It\opensource\backend'

block_cipher = None

# ── rembg 模型权重打包：避免桌面用户首次运行需联网下载 176MB ──
_u2net_local = os.path.join(os.path.expanduser('~'), '.u2net', 'u2net.onnx')
_extra_datas = []
_extra_binaries = []
_extra_hidden = []
if os.path.exists(_u2net_local):
    # 打包后路径：sys._MEIPASS/u2net_models/u2net.onnx
    # 运行时由 server.py 设置 U2NET_HOME 指向该目录
    _extra_datas.append((_u2net_local, 'u2net_models'))

# ── rembg / 抠像依赖：用 collect_all 收齐源码 + 数据 + entry-points ──
# 仅列 hiddenimports 不足以打包 rembg（含 pooch、dynamic providers），必须 collect_all。
# 注意：不要 collect_all('onnxruntime') / 'numba'，它们会通过 onnxruntime.tools 把 torch 拖进来。
for _pkg in ('rembg', 'pooch', 'pymatting', 'pymatting_aot'):
    try:
        _d, _b, _h = collect_all(_pkg)
        _extra_datas += _d
        _extra_binaries += _b
        # 过滤掉会触发 torch 导入的 rembg.commands（CLI 用不到）
        _extra_hidden += [m for m in _h if not m.startswith('rembg.commands')]
    except Exception as _e:
        # 某些可选包缺失时跳过，rembg 仍可用 plain mask 模式
        print(f'[backend.spec] skip collect_all({_pkg}): {_e}')

# 显式补充 rembg sessions 子模块（懒加载注册）
_extra_hidden += collect_submodules('rembg.sessions')

a = Analysis(
    [os.path.join(_backend_dir, 'server.py')],
    pathex=[_backend_dir],
    binaries=_extra_binaries,
    datas=_extra_datas,
    hiddenimports=_extra_hidden + [
        # ── asyncio / anyio ──────────────────────────────────────
        'anyio',
        'anyio._backends._asyncio',
        'anyio._backends._trio',

        # ── SQLAlchemy + aiosqlite ───────────────────────────────
        'aiosqlite',
        'aiosqlite.connection',
        'sqlalchemy',
        'sqlalchemy.dialects.sqlite',
        'sqlalchemy.dialects.sqlite.aiosqlite',
        'sqlalchemy.dialects.sqlite.base',
        'sqlalchemy.dialects.sqlite.pysqlite',
        'sqlalchemy.ext.asyncio',
        'sqlalchemy.ext.asyncio.engine',
        'sqlalchemy.ext.asyncio.session',
        'sqlalchemy.orm',
        'sqlalchemy.pool',

        # ── pydantic / pydantic-settings ─────────────────────────
        'pydantic',
        'pydantic.v1',
        'pydantic_settings',

        # ── FastAPI / Starlette ──────────────────────────────────
        'fastapi',
        'fastapi.middleware',
        'fastapi.middleware.cors',
        'fastapi.staticfiles',
        'fastapi.responses',
        'starlette',
        'starlette.middleware',
        'starlette.middleware.cors',
        'starlette.staticfiles',
        'starlette.responses',
        'starlette.routing',

        # ── Uvicorn ──────────────────────────────────────────────
        'uvicorn',
        'uvicorn.config',
        'uvicorn.main',
        'uvicorn.logging',
        'uvicorn.loops',
        'uvicorn.loops.asyncio',
        'uvicorn.protocols',
        'uvicorn.protocols.http',
        'uvicorn.protocols.http.auto',
        'uvicorn.protocols.http.h11_impl',
        'uvicorn.protocols.http.httptools_impl',
        'uvicorn.protocols.websockets',
        'uvicorn.protocols.websockets.auto',
        'uvicorn.protocols.websockets.websockets_impl',
        'uvicorn.lifespan',
        'uvicorn.lifespan.on',
        'uvicorn.lifespan.off',

        # ── HTTP / AI 相关 ────────────────────────────────────────
        'httpx',
        'httpx._transports',
        'httpx._transports.default',
        'openai',
        'json_repair',

        # ── app 模块（防止动态导入被剪掉）────────────────────────
        'app',
        'app.main',
        'app.config',
        'app.database',
        'app.models',
        'app.models.game',
        'app.models.generation_task',
        'app.models.ai_config',
        'app.routers',
        'app.routers.games',
        'app.routers.tasks',
        'app.routers.config',
        'app.schemas',
        'app.services',
        'app.services.ai',
        'app.services.ai.text_gen',
        'app.services.ai.image_gen',
        'app.services.ai.voice_gen',
        'app.services.ai.jimeng_gen',
        'app.services.ai.seedream5_gen',
        'app.services.ai.matting',
        'app.services.ai.orchestrator',
        'app.storage',
        'app.storage.local_storage',

        # ── 图像处理（jimeng_gen / seedream5_gen 用于参考图）────
        'numpy',
        'numpy.core',
        'numpy.core._methods',
        'numpy.core._dtype_ctypes',
        'numpy.lib.format',
        'PIL',
        'PIL.Image',
        'PIL.ImageFilter',
        'PIL.ImageOps',
        'PIL._imaging',

        # ── rembg 抠像（U2Net + onnxruntime）───────────────────────
        'rembg',
        'rembg.bg',
        'rembg.session_factory',
        'rembg.sessions',
        'rembg.sessions.u2net',
        'rembg.sessions.base',
        'onnxruntime',
        'onnxruntime.capi',
        'onnxruntime.capi._pybind_state',

        # ── 其他常用标准库隐式导入 ────────────────────────────────
        'email.mime.multipart',
        'email.mime.text',
        'multiprocessing',
        'multiprocessing.reduction',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter', 'matplotlib',
        'cv2', 'pandas', 'IPython',
        'test', 'unittest',
        # ↓ 排除会被 numba/pymatting/onnxruntime 间接拖入的巨型依赖（>3GB）
        'torch', 'torchvision', 'torchaudio',
        'tensorflow', 'jax', 'sklearn',
        'onnx', 'onnxruntime.tools',
        'rembg.commands', 'filetype',
        # ↓ scipy 的 array_api_compat 兼容层会尝试 import torch/cupy/dask/jax，必须排除
        'scipy._lib.array_api_compat.torch',
        'scipy._lib.array_api_compat.cupy',
        'scipy._lib.array_api_compat.dask',
        'scipy._lib.array_api_compat.dask.array',
        'scipy._lib.array_api_compat.jax',
        'dask', 'dask.array', 'cupy',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='server',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,       # 保留控制台以便查看后端日志
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='server',      # 输出目录名：dist/server/
)
