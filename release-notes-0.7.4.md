# ReverieSoil 梦壤 OSS v0.7.4

> 发布日期：2025-01

## 修复

- **历史页面弹窗居中失效**：故事统计、故事封面预览、重试确认三个弹窗在部分分辨率下未居中显示（出现在屏幕右下角等位置）。
  - 根因：framer-motion 的 `animate={{ scale: 1 }}` 会接管元素的 `transform` 属性，覆盖了 CSS 中 `transform: translate(-50%, -50%)` 的居中定位。
  - 修复：拆分定位与动画——外层使用 `position: fixed; inset: 0` + flex 居中容器，内层 motion 元素仅做 `opacity / scale` 动画，并通过 `pointerEvents` 仅在内层接收交互。
  - 影响范围：`opensource/web/src/pages/HistoryPage.tsx` 三个 modal。

## 升级建议

建议所有 v0.7.3 用户升级。本版本仅前端 UI 修复，无数据库 / API 变更，可直接覆盖安装。

## 资产

- `ReverieSoil-0.7.4-setup.exe` — Windows 安装包
- `ReverieSoil-0.7.4.apk` — Android 安装包
