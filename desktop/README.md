# ReverieSoil 梦壤 — 桌面客户端构建说明

## 目录结构

```
desktop/
├── main.js              Electron 主进程（启动后端、协议代理）
├── preload.js           预加载脚本
├── package.json         Electron + electron-builder 配置
├── backend.spec         PyInstaller 打包配置
├── backend-dist/        （构建时生成）PyInstaller 产物
├── web-dist/            （构建时生成）前端构建产物
├── dist-installer/      （构建时生成）最终安装包
├── build/
│   ├── icon.png         源图标（512×512 PNG）
│   └── icon.ico         （构建时生成）Windows 图标
└── build-windows.ps1    Windows 一键构建脚本
```

## 一键构建（Windows）

### 前置条件

| 工具       | 最低版本 | 下载                          |
|-----------|---------|-------------------------------|
| Node.js   | 18+     | https://nodejs.org/           |
| Python    | 3.10+   | https://python.org/           |

### 执行构建

```powershell
# 在 opensource/desktop/ 目录下运行
cd opensource\desktop
.\build-windows.ps1
```

构建过程约需 5~15 分钟（主要耗时在 PyInstaller 打包）。

### 构建产物

- `dist-installer\ReverieSoil 梦壤 Setup 0.2.0.exe` — Windows NSIS 安装包

## 应用架构

```
ReverieSoil.exe（安装后）
└── 启动 Electron 主窗口
    ├── 内嵌启动 resources/backend/server/server.exe（Python FastAPI）
    │   └── 监听 127.0.0.1:59876
    └── 加载 app:///index.html（React SPA）
        ├── /api/*   → 代理到 http://127.0.0.1:59876/api/*
        └── /static/* → 代理到 http://127.0.0.1:59876/static/*
```

## 用户数据存储位置

| 系统    | 路径                                                |
|--------|-----------------------------------------------------|
| Windows | `%APPDATA%\reveriesoil-desktop\`                   |
| macOS   | `~/Library/Application Support/reveriesoil-desktop/` |

内含：
- `dreamit.db` — SQLite 数据库（故事、AI 配置）
- `static/`     — 生成的图片和音频文件

## 开发调试

```powershell
# 终端 1：启动后端（手动）
cd opensource\backend
pip install -r requirements.txt
$env:PORT=59876; $env:CORS_ALLOW_ORIGINS="*"; python server.py

# 终端 2：启动前端 dev server
cd opensource\web
npm install ; npm run dev

# 终端 3：启动 Electron（开发模式，连接 vite dev server）
cd opensource\desktop
npm install ; npx electron .
```
