# ReverieSoil v0.6.1

## 主要更新

### 抠像 despill 优化
- 即梦图像生成抠像算法升级：色度阈值 25/45 + 渐变透明 mask + MaxFilter(3) 边缘软化 + 通道 despill 去绿溢色
- 解决人物边缘残留绿边、半透明发丝抠像不干净的问题

### 立绘按需生成
- 仅生成场景中实际用到的角色表情，避免无效请求
- 编排层在 `run` / `run_stream` / `run_images_only` 全部使用 `_collect_used_expressions` 过滤
- 预计单次故事图像生成请求数量下降 30% – 60%

### UI 微调
- 移除"我的故事"卡片中的"已完成"状态徽标，简化视觉
- 故事卡片网格在宽屏下居中显示（开源 Web 端）

## 下载

- Windows 安装包：`ReverieSoil-0.6.1-setup.exe`（约 115 MB）

## 升级方式

Windows 用户直接运行新版安装包即可覆盖升级，配置和数据保留。
