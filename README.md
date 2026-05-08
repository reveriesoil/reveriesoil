# ReverieSoil 梦壤 — 开源版

**v0.4.5**

基于 AI 的视觉小说生成器。输入一段提示词，AI 自动完成故事剧本创作、角色立绘生成、场景背景绘制与语音合成，打包成可直接在浏览器中游玩的视觉小说。

数据全部保存在本地，内置 SQLite 数据库。

---

## 功能特性

- **AI 全流程生成**：故事大纲 → 剧情校验 → 艺术风格 → 绘图提示词 → 完整台词 → 角色立绘 → 场景背景 → CG 图 → 可玩游戏
- **携带自己的 API Key（BYOK）**：在设置页面填写各 AI 服务的密钥，无内置账号体系，数据不经过第三方服务器
- **故事导出与导入**：将已生成的故事打包为 `.rsz` 文件（含所有图片与音频），可发送给他人直接导入游玩
- **交互程度控制**：支持 5 档交互深度，从沉浸观影到高度分支均可配置
- **本地存储**：图片和音频保存在本机文件系统，无需 MinIO / S3 / 云存储
- **轻量依赖**：SQLite 数据库，无 Redis / Celery / PostgreSQL

---

## 系统要求

### Windows 桌面版
- Windows 10 64 位及以上
- 4 GB 可用内存（推荐 8 GB）
- 约 500 MB 磁盘空间（不含生成的图片/音频）

### Docker 部署
- Docker 20.10+ 及 Docker Compose v2+
- 4 GB 可用内存

---

## 安装方式

### 方式一：Windows 桌面安装包（推荐）

从 [Releases](https://github.com/reveriesoil/reveriesoil/releases) 页面下载最新的 `ReverieSoil-x.x.x-setup.exe`，双击安装，无需额外配置。

安装后启动即可使用，后端服务由应用自动管理，用户数据存储在 `%APPDATA%\reveriesoil-desktop\`。

如需自行构建安装包，参见 [desktop/README.md](desktop/README.md)。

---

### 方式二：Docker 部署（服务器 / 本地开发）

**前置条件**：[Docker](https://www.docker.com/) + [Docker Compose](https://docs.docker.com/compose/)

```bash
git clone https://github.com/reveriesoil/reveriesoil.git
cd reveriesoil
docker compose up --build -d
```

访问 [http://localhost:3000](http://localhost:3000)

数据持久化在 `data/` 目录：

```
data/
  db/         # SQLite 数据库文件
  static/     # 生成的图片和音频
```

---

## 配置 AI 模型

启动后点击右上角**设置**按钮，填写以下信息：

| 字段 | 说明 |
|------|------|
| 文字模型 Provider | `deepseek` / `moonshot` / `openai` 等 |
| 文字模型 Base URL | 例：`https://api.deepseek.com` |
| 文字模型 API Key | 你的 API Key |
| 文字模型 ID | 例：`deepseek-v4-flash` / `kimi-k2.6` |
| 图像模型（可选）| 即梦 AI / 豆包 / OpenAI 兼容服务等 |
| 语音模型（可选）| OpenAI TTS 等 |

配置保存在本地 SQLite 数据库，不会上传至任何服务器。

---

## 支持的模型

### 文字模型（兼容 OpenAI API 格式）

| 服务商 | 推荐模型 ID | Base URL | 备注 |
|--------|------------|----------|------|
| DeepSeek | `deepseek-v4-pro` / `deepseek-v4-flash` | `https://api.deepseek.com` | 推荐；项目会自动禁用 thinking 模式以兼容工具调用 |
| Moonshot (Kimi) | `kimi-k2.6` | `https://api.moonshot.cn/v1` | 项目会自动禁用 thinking 模式 |
| OpenAI | `gpt-4o` / `gpt-4o-mini` | `https://api.openai.com/v1` | |
| 其他 | 任意模型 ID | 自定义 | 支持任意兼容 OpenAI Chat Completions API 的服务 |

### 图像模型

| 服务商 | 模型 ID | 凭据字段 |
|--------|---------|---------|
| 即梦 AI（火山 CV） | `jimeng_seedream46_cvtob` | Access Key ID + Secret Access Key |
| 豆包 SeeDream 5.0（火山 ARK） | `doubao-seedream-5-0-260128` | API Key |
| OpenAI 兼容图像服务 | 自定义 | API Key + Endpoint |

### 语音模型（可选）

| 服务商 | 模型 ID |
|--------|---------|
| OpenAI TTS | `tts-1` / `tts-1-hd` |
| SiliconFlow（FishAudio） | 自定义 |

语音和图像模型均为可选配置，不填写时故事依然可以生成（无立绘、无配音）。

---

## 常见问题

**Q：文字生成正常，但没有立绘/背景图片**

未配置图像模型时，系统仅生成文字剧本，图像资产留空。在设置页面填写图像模型配置后重新生成即可。

**Q：生成过程卡在某一步不动了**

生成任务依赖 AI 服务商的网络连通性。如果超时失败，故事卡片会显示"失败"状态，点击卡片可以选择重试。

**Q：Docker 部署后刷新页面出现 404**

前端是 SPA，nginx 已配置 `try_files $uri /index.html`，但某些旧版 Docker compose 文件可能未正确生效。请确认使用最新的 `docker-compose.yml`。

**Q：导出的 .rsz 文件如何分享给他人**

`.rsz` 是普通 ZIP 格式，包含故事的完整数据和所有生成的图片/音频。对方在自己的 ReverieSoil 中点击"导入故事"选择该文件即可游玩，无需联网。

---

## 项目结构

```
opensource/
├── backend/          # FastAPI 后端（Python）
│   ├── app/
│   │   ├── main.py           入口，FastAPI 应用与 lifespan
│   │   ├── config.py         配置（database_url、static_dir、port 等）
│   │   ├── database.py       SQLite 引擎（aiosqlite + WAL 模式）
│   │   ├── models/           SQLAlchemy 数据模型
│   │   ├── routers/          API 路由（games、tasks、config）
│   │   ├── schemas/          Pydantic 请求/响应模型
│   │   └── services/ai/      AI 智能体（text_gen、image_gen、voice_gen、orchestrator）
│   ├── server.py             uvicorn 启动入口（PyInstaller 打包用）
│   └── requirements.txt
│
├── web/              # 前端（React + Vite）
│   └── src/
│       ├── pages/            主要页面（生成、历史、游玩）
│       ├── components/       共用组件
│       └── api.ts            后端接口封装
│
├── desktop/          # Electron 桌面客户端
│   ├── main.js               主进程（启动 server.exe、注册 app:// 协议代理）
│   ├── backend.spec          PyInstaller 打包配置
│   ├── build-windows.ps1     Windows 一键构建脚本
│   ├── backend-dist/         PyInstaller 产物（server.exe + 依赖）
│   ├── web-dist/             前端构建产物
│   └── dist-installer/       最终 Windows 安装包
│
├── data/             # 运行时数据（Docker 模式）
│   ├── db/                   SQLite 数据库
│   └── static/               生成的图片和音频
│
└── docker-compose.yml        Docker 一键部署配置
```

---

## 本地开发

```bash
# 后端（开发模式，带热重载）
cd backend
pip install -r requirements.txt
uvicorn app.main:app --host 127.0.0.1 --port 59876 --reload

# 前端
cd web
npm install
npm run dev
```

前端默认通过 Vite 代理将 `/api` 请求转发到 `http://127.0.0.1:59876`，无需手动配置跨域。

---

## 许可证

本项目使用自定义 **Source Available License**，核心条款：

- 个人学习、研究与游玩：免费，无需申请
- 修改代码用于个人非商业目的：免费，无需申请
- 公开分发、商业使用或搭建付费服务：**需获得书面授权**

完整条款见 [LICENSE](LICENSE)。

---

## 联系方式

商业合作或授权咨询：reveriesoil@163.com
