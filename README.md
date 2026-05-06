# Dream It — 开源版（ReverieSoil OSS）

**v0.35.0**

基于 AI 的视觉小说生成器。输入一段提示词，AI 自动生成完整的故事剧本、角色立绘、场景背景、CG 插图，并打包成可直接游玩的视觉小说。

无需账号注册，数据全部保存在本地，自带 SQLite 数据库。

---

## 功能特性

- **AI 全流程生成**：故事大纲 → 剧情校验 → 艺术风格 → 绘图提示词 → 完整台词 → 角色立绘 → 场景背景 → CG 图 → 打包游戏
- **携带自己的 API Key**：在设置页面填写 AI 服务密钥，无内置账号体系
- **故事导出与分享**：将已生成的故事打包为 `.rsz` 文件（含所有图片/音频），发送给他人后可直接导入游玩
- **本地存储**：图片和音频保存在本机，无需 MinIO / S3 / 云存储
- **轻量依赖**：SQLite 数据库，无 Redis / Celery / PostgreSQL

---

## 安装方式

### 方式一：Windows 桌面安装包（推荐）

直接下载 `ReverieSoil-0.35.0-setup.exe`，双击安装，无需配置任何环境。

安装后启动即可使用，后端服务由应用自动管理，数据存储在系统用户目录下。

> 如需自行构建安装包，见 [desktop/README.md](desktop/README.md)

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
| 文字模型 Provider | `openai` / `deepseek` / `moonshot` 等 |
| 文字模型 Base URL | 例：`https://api.deepseek.com/v1` |
| 文字模型 API Key | 你的 API Key |
| 文字模型 ID | 例：`deepseek-v3-0324` / `moonshot-v1-32k` |
| 图像模型（可选）| SiliconFlow / 即梦 AI 等 |
| 语音模型（可选）| OpenAI TTS 等 |

配置保存在本地 SQLite 数据库，不会上传至任何服务器。

---

## 支持的模型

### 文字模型（兼容 OpenAI API 格式）

| 服务商 | 模型示例 | 备注 |
|--------|---------|------|
| DeepSeek | `deepseek-v3-0324` | 推荐，支持强制工具调用 |
| Moonshot (Kimi) | `moonshot-v1-32k` | 自动禁用 thinking |
| OpenAI | `gpt-4o`, `gpt-4o-mini` | |
| 其他 | 任意兼容 OpenAI API 格式的服务 | |

### 图像模型

| 服务商 | 模型示例 |
|--------|---------|
| SiliconFlow | `Kwai-Kolors/Kolors` |
| 即梦 AI（jimeng） | `jimeng_seedream5` |

### 语音模型（可选）

| 服务商 | 模型示例 |
|--------|---------|
| OpenAI TTS | `tts-1`, `tts-1-hd` |

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

---

## 许可证

[MIT](LICENSE)
