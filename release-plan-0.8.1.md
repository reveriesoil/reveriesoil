# ReverieSoil 梦壤 OSS v0.8.1 更新计划

> 计划日期：2026-05-13
> 预计发布：白日梦模式（Daydream Mode）M1 移植完成后

---

## 主线：白日梦模式（Daydream Mode）首发移植

闭源版本（Dream It）已于 2026-05-13 完成"白日梦模式 M1 骨架"开发并部署到本地 docker。0.8.1 的核心任务是将该模式裁剪后移植到开源版（SQLite + Electron / Android / Docker 单体后端），作为继"全量生成"与"无限剧本"之后的**第三种核心玩法**。

### 1. 功能定位

**白日梦模式**是与"全量生成 / 无限剧本"并列的开放式玩法：

- 玩家自定义世界主题、绘画风格与若干 AI NPC
- 系统由 AI 管理员（Director）实时编排：动态生成事件、推进剧情、判定入睡 / 切换"天"
- 每个 NPC 由独立的智能体扮演，可使用不同的文本模型
- 通过自研记忆压缩机制维持长期人设
- 玩家空闲时 Director 主动驱动剧情（冷场不冷）
- 不支持中途存档，但保留完整时间线回放

### 2. M1（首发）范围

与闭源版 M1 范围一致，**首发不集成立绘 / sprite sheet 生成**：

#### 后端
- 新增 7 张 `daydream_*` 表（worlds / npcs / events / memories / scene_state / sleep_archive / player_actions）
  - 开源版使用 SQLite，需将 `gen_random_uuid()` / `JSONB` / `BIGSERIAL` 等 PG 专有类型适配为 SQLite 兼容写法（`TEXT` + `json` + `INTEGER PRIMARY KEY AUTOINCREMENT`）
  - 全部 DDL 写入 `opensource/backend/init.sql`（或 `app/database.py` 中 `CREATE TABLE IF NOT EXISTS` 启动建表逻辑，沿用开源版现有模式）
- 新增模型层 `app/models/daydream.py`、Pydantic schemas `app/schemas/daydream.py`
- 新增 `app/services/daydream/`：
  - `world_state.py`（WorldState dataclass）
  - `ai_resolver.py`（复用现有 `ai_config_runtime` 解析 NPC 模型覆写）
  - `llm.py`（`chat_text` / `chat_json` 封装）
  - `memory.py`（最近 30 条 + 每 20 条归纳一次摘要 + 保留尾 10 条）
  - `npc_agent.py`、`director.py`
  - `runtime.py`（进程内 `WorldRuntime`：空闲 45s 触发 Director、20s 冷却）
  - `event_bus.py`（asyncio Queue 发布订阅）
- 新增路由 `app/routers/daydream.py`：
  - REST：`POST /daydream/worlds`、`GET /daydream/worlds`、`GET /daydream/worlds/{id}`、`GET /daydream/worlds/{id}/events`
  - WebSocket：`/daydream/ws/{world_id}?token=...`（开源版无登录态时复用本地匿名 token / 设备 ID）
- 注册到 `app/main.py`，前缀 `/api/v1`
- **限流**：复用 `settings.generation_rate_limit`（开源版桌面 / 移动端可放宽或关闭）

#### 前端（`opensource/web` 共用至 desktop + mobile）
- `web/src/api.ts`：新增 Daydream 接口与 `buildDaydreamWsUrl`
- `web/src/pages/DaydreamCreatePage.tsx`：标题 / 主题 / 风格 chips / 动态 NPC 表单
- `web/src/pages/DaydreamPage.tsx`：HUD（Day / sim_clock / location / 状态指示灯）+ 事件流气泡（player.say / npc.say / director.cue / silence / sleep_verdict）+ 玩家输入 + 入睡发起
- `App.tsx`：注册 `/daydream` 与 `/daydream/:worldId` 路由
- `LandingPage.tsx`：主菜单新增"白日梦"入口（手绘 SVG 图标，与「∞ 无限剧本」风格一致）
- **不实现立绘**：M1 仅显示 NPC 姓名 chips 作为占位

#### 跨端注意事项
- **Electron 桌面端**：本地 SQLite，WebSocket 通过 `ws://127.0.0.1:<port>` 直连本地后端，无需 nginx 反代
- **Android 移动端**：Capacitor 内置 WebView 需放行 `ws://`；后端地址沿用 BYOK 配置的 `api_base_url`
- **Docker 部署**：nginx 反代需放行 `/daydream/ws/` 升级（`proxy_http_version 1.1` + `Upgrade` / `Connection` 头）

### 3. 暂不包含（留待 0.8.2+）

- ❌ NPC 立绘 sprite sheet 生成与缓存（仍待沿用 0.8.0 的 sprite sheet 机制接入）
- ❌ 环境图预生成与跨天复用
- ❌ 嵌入式小游戏 iframe 槽
- ❌ 时间线回放
- ❌ 多进程 / 多实例 WorldRuntime 同步（开源版本默认单后端实例，无需 Redis pub/sub）

---

## 次要修复 / 改进（候选）

- **`NpcConfigIn` Pydantic 警告**：闭源版已修复（`model_config = ConfigDict(protected_namespaces=())`），移植时一并带过去。
- **WebSocket 重连**：前端已实现 `client.resume` + `last_seq`，确保移动端切后台再回前台不丢消息。
- **桌面 PyInstaller 打包**：`backend.spec` 需 `collect_all` 新增的 `app.services.daydream` 子包（确保 `runtime.py` 中的动态导入不丢失）。

---

## 版本号同步清单

按"开源版远程仓库更新注意事项"，0.8.1 发布时同步修改以下 4 处：

1. `opensource/desktop/package.json` → `"version": "0.8.1"`
2. `opensource/README.md` → `**v0.8.1**`
3. `opensource/web/src/pages/LandingPage.tsx` → `OSS 0.8.1`
4. `opensource/mobile/package.json` + `opensource/mobile/android/app/build.gradle`（`versionCode 81` / `versionName "0.8.1"`）

---

## 发布流程

1. 将闭源版 daydream M1 代码裁剪移植到 `opensource/backend` + `opensource/web`
2. SQLite DDL 适配 + 本地启动自检（`docker compose up -d backend web`）
3. 桌面端 PyInstaller 验证：`opensource/desktop/build-windows.ps1`
4. 移动端 APK 验证：`opensource/mobile` 的 `gen_android_assets.py` + Capacitor build
5. 修改 4 处版本号 → `git commit -m "chore(release): bump version to v0.8.1"`
6. `git tag v0.8.1` → `git push origin main` + `git push origin v0.8.1`
7. `build-windows.ps1` 生成 `ReverieSoil-0.8.1-setup.exe`
8. PowerShell 5 UTF-8 字节方式调用 GitHub API 创建 Release（中文 body）
9. 上传 exe 与 apk 到 Release assets

---

## 验收标准

- ✅ 主菜单出现"白日梦"入口，图标风格与现有菜单一致
- ✅ 创建世界 → 进入游玩页 → 玩家发言 → NPC 回应 → 空闲 45s 后 Director 主动 cue 一次
- ✅ 入睡 → Director 输出 sleep_verdict → 推进 `day_index` 与 `sim_clock`
- ✅ 断网重连后通过 `client.resume` 续上 `last_seq`，无消息丢失
- ✅ Windows 桌面安装包 / Android APK / Docker 部署三端均能创建并游玩一场白日梦
- ✅ 关闭 backend 容器再启动，已创建的世界与事件流仍可正常加载（持久化验证）

---

## 资产（计划）

- `ReverieSoil-0.8.1-setup.exe` — Windows 安装包
- `ReverieSoil-0.8.1.apk` — Android 安装包
- Docker：`docker compose pull` 重新拉取最新代码后 `--build` 重建后端镜像
