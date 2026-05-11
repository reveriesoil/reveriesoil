# ReverieSoil 梦壤 OSS v0.7.3

**发布日期：** 2026-05-11

## 关键修复 — 桌面端 rembg 抠图通道真正生效

v0.7.2 桌面端虽然在代码层面接入了 rembg + pymatting 的语义抠图通道，但 PyInstaller 打包脚本仅复制了 `*.dist-info/` 元数据，未把 `rembg/` `pymatting/` `pooch/` `pymatting_aot/` 的包源码打入产物。运行时 `import rembg` 抛 `ModuleNotFoundError`，被兜底链路降级为纯色键控（chromakey），最终效果与 v0.7.1 完全一致——这正是部分用户反馈"绿幕仍残留"的根因。

本次修复 `desktop/backend.spec`：

- 改用 `collect_all('rembg' / 'pymatting' / 'pooch' / 'pymatting_aot')` 把四个包的 `.py` / `.so` / 资源文件全部纳入产物。
- 显式 `excludes=['torch','torchvision','torchaudio','tensorflow','jax','sklearn','onnx','onnxruntime.tools','rembg.commands','filetype']`，避免 onnxruntime stdhook 通过 `pytorch_export_helpers` 把 PyTorch 拖入产物。
- 追加 `collect_submodules('rembg.sessions')` 确保 `U2netSession` 等子模块都进入 hidden imports。

打包后 `_internal/` 含完整 `rembg/`（31 文件）+ `pymatting/`（95 文件）+ numba/scipy 依赖，无 torch；server.exe smoke test 启动 OK。

## 其他改动

- **手机端**：TTS 占位 UI（v0.7.2 续作）。
- **Web/Desktop 前端**：`HistoryPage` 故事统计 grid 改为 `repeat(auto-fit, minmax(160px, 1fr))`，奇数项时最后一行占满整行实现视觉居中；版本号同步至 0.7.3。

## 下载

| 平台 | 文件 | 大小 |
|------|------|------|
| Windows | `ReverieSoil-0.7.3-setup.exe` | 337 MB |
| Android | `ReverieSoil-0.7.3.apk` | 14.3 MB |

## 升级建议

> 强烈建议 v0.7.1 / v0.7.2 桌面端用户升级到 v0.7.3——这是首个语义抠图通道**真实可用**的桌面版本。后端 API / 数据库无变更，可直接覆盖安装。
