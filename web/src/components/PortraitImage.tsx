import React from 'react'

interface PortraitImageProps {
  src?: string
  className?: string
  alt?: string
}

/**
 * 立绘图片组件：
 * 直接渲染服务端在打包阶段已抠图（透明 PNG）的立绘 URL。
 * 服务端 `app/services/ai/matting.py::cutout_portrait` 在生成立绘时已彻底去除绿幕，
 * 客户端无需再做任何抠图，避免出现「先显示绿幕、再切换透明」的闪烁。
 */
export default function PortraitImage({ src, className, alt }: PortraitImageProps) {
  if (!src) return null
  return <img src={src} className={className} alt={alt} />
}
