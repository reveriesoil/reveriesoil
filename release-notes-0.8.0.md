# ReverieSoil 梦壤 OSS v0.8.0

> 发布日期：2026-05

## 新增

- **人物立绘 Sprite Sheet 优化**：单次图像 API 调用一次性生成同一角色的多个表情，再切分为独立立绘文件，显著降低 API 调用次数并大幅提升同一角色不同表情之间的脸型、发色、服饰一致性。
  - 机制：每个角色的表情列表按每批 ≤4 张切分，调用 Doubao Seedream 4.5/5.0 生成 `N×1024 × 2048` 的横向条带图（绿幕背景 + 10px 黑线分隔 + 8% 安全边距），返回后等宽切分成 N 张子图，每张独立走 rembg 抠图。
  - 启用条件：图像模型配置 `portrait_sprite_sheet: true`，并且使用 `doubao-seedream-4-5-*` 或更高版本的 Seedream 模型。
  - 失败回退：sheet 调用 / 切分 / 抠图任一阶段失败时自动回退到逐表情独立生成。
  - 实测：以 5 角色 27 表情为例，API 调用次数由 27 次降至 8 次（约减少 70%）。
  - 相关代码：`opensource/backend/app/services/ai/sprite_sheet_gen.py`、`opensource/backend/app/services/ai/orchestrator.py`。

## 修复

- **rembg / onnxruntime 运行时缺失 libgomp1**：开源版后端镜像基于 `python:3.11-slim`，缺少 `libgomp1` 时 `onnxruntime` 会 import 失败，导致 rembg 抠图静默回退到色键阈值法，立绘绿幕背景残留明显。本次在 `opensource/backend/Dockerfile` 中显式 `apt-get install libgomp1`。
- **桌面 PyInstaller 打包 rembg**：`opensource/desktop/backend.spec` 已通过 `collect_all('rembg' / 'pooch' / 'pymatting' / 'pymatting_aot')` 完整收集依赖；首次启动自动按 `U2NET_HOME` 加载本地 U2Net 权重，避免运行时联网下载 175 MB。

## 升级建议

- Docker 用户：拉取新代码后执行 `docker compose build --no-cache backend && docker compose up -d backend`，以便加载新增的 `libgomp1` 和最新的 sprite sheet 实现。
- 桌面用户：直接覆盖安装 `ReverieSoil-0.8.0-setup.exe`，本地 SQLite 数据库不会被清空。
- 移动端：Android `ReverieSoil-0.8.0.apk` 支持覆盖升级，版本号 `versionCode 80`。

## 资产

- `ReverieSoil-0.8.0-setup.exe` — Windows 安装包
- `ReverieSoil-0.8.0.apk` — Android 安装包
