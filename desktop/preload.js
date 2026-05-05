/**
 * Electron 预加载脚本
 * 在沙箱渲染进程中安全地暴露必要 API
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // 应用版本
  getVersion: () => ipcRenderer.invoke('get-version'),
  // 在系统浏览器打开链接
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
})
