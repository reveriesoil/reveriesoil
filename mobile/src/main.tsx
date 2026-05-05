import React from 'react'
import { createRoot } from 'react-dom/client'
import { defineCustomElements } from '@ionic/pwa-elements/loader'
import { Capacitor } from '@capacitor/core'
import App from './App.tsx'
import './index.css'

// Capacitor PWA 元素（文件选择、相机等原生对话框）
defineCustomElements(window).catch(() => {})

// 锁定横屏（仅在原生平台）
async function lockLandscape() {
  if (!Capacitor.isNativePlatform()) return
  try {
    const { ScreenOrientation } = await import('@capacitor/screen-orientation')
    await ScreenOrientation.lock({ orientation: 'landscape' })
  } catch {
    // 插件不可用时忽略（如 web 预览模式）
  }
}
lockLandscape()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
