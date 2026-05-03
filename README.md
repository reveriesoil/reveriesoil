# ReverieSoil 梦壤

> AI 驱动的视觉小说生成器 · 开源版

输入一段提示词，AI 自动为你创作故事剧本、角色立绘与配音，并生成一部可在浏览器中直接游玩的视觉小说。

[![License](https://img.shields.io/badge/License-Source%20Available-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.0--backend-blue.svg)](https://github.com/reveriesoil/reveriesoil/releases)

---

## 功能特性

- **AI 自动生成故事** — 输入提示词，即可生成完整视觉小说
- **角色 & 场景立绘** — 可对接图像模型（SiliconFlow / 即梦等）
- **角色配音** — 支持 OpenAI TTS 等语音合成接口
- **自带 API Key** — 填写自己的 AI 服务密钥，数据全部本地存储
- **纯浏览器游玩** — 生成完毕后直接在浏览器内体验

---

## 当前版本

**v0.2.0 · Backend Release**

后端开源版（SQLite + FastAPI，**无需 Redis/PostgreSQL**），可与前端配合本地运行完整服务。

---

## 目录结构

```
reveriesoil/
├── web/          # 前端（React 18 + Vite + TypeScript）
│   ├── src/
│   │   ├── pages/       # 页面：首页、生成中、游玩、历史
│   │   ├── components/  # 组件：设置弹窗、进度面板等
│   │   ├── api.ts       # API 层封装
│   │   └── types.ts     # 类型定义
│   ├── public/
│   └── package.json
├── backend/      # 后端（FastAPI + SQLite，开箱即用）
│   ├── app/
│   │   ├── routers/     # API 路由
│   │   ├── services/    # AI 调用 / 任务处理
│   │   └── models/      # 数据模型
│   ├── server.py        # 启动入口
│   ├── requirements.txt
│   ├── .env.example     # 环境变量示例
│   └── Dockerfile
├── data/         # 运行时数据目录（生成后创建）
└── README.md
```

---

## 本地开发（前端）

```bash
git clone https://github.com/reveriesoil/reveriesoil.git
cd reveriesoil/web

npm install
npm run dev
```

访问 [http://localhost:5173](http://localhost:5173)

> 前端默认将 API 请求代理到 `http://localhost:8000`，需要本地运行后端服务。

---

## 本地开发（后端）

```bash
cd reveriesoil/backend

# 复制并配置环境变量
cp .env.example .env
# 编辑 .env 填入你的 AI API Key

pip install -r requirements.txt
python server.py
```

后端默认监听 `http://localhost:8000`，数据存储在本地 SQLite 文件。

---

## 支持的 AI 模型

在设置页面（右上角设置按钮）填写以下信息即可使用任意兼容接口：

### 文字模型（兼容 OpenAI Chat API）
| 服务商 | 示例 Base URL | 示例模型 ID |
|--------|--------------|------------|
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| SiliconFlow | `https://api.siliconflow.cn/v1` | `deepseek-ai/DeepSeek-V3` |
| 任意 OpenAI 兼容接口 | 自定义 | 自定义 |

### 图像模型（可选）
- SiliconFlow: `Kwai-Kolors/Kolors`、`black-forest-labs/FLUX.1-dev`
- 即梦 AI（jimeng）

### 语音模型（可选）
- OpenAI TTS: `tts-1`、`tts-1-hd`

---

## 后续更新

| 版本 | 主要内容 |
|------|----------|
| v0.1.0 | 前端 UI 发布 ✅ |
| v0.2.0 | 后端开源版 ✅ |
| v0.3.0 | Docker 一键部署包 |
| v0.4.0 | 桌面端安装包 |

---

## 参与贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feat/your-feature`
3. 提交改动：`git commit -m "feat: 描述"`
4. 推送分支：`git push origin feat/your-feature`
5. 发起 Pull Request

---

## 许可证

[Source Available License](LICENSE) © 2026 WeiCui / 微萃科技

个人学习与游玩免费，商业使用请联系 reveriesoil@163.com
