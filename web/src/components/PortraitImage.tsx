import React, { useEffect, useRef, useState } from 'react'
import { removeBackground } from '../utils/removeBackground'

interface PortraitImageProps {
  src?: string
  className?: string
  alt?: string
}

/**
 * 立绘图片组件：自动在客户端进行背景去除。
 * - 先显示原图（避免等待感）
 * - 后台异步处理，处理完毕后无缝替换为透明版本
 * - 结果缓存，同一 URL 只计算一次
 */
export default function PortraitImage({ src, className, alt }: PortraitImageProps) {
  const [displaySrc, setDisplaySrc] = useState<string | undefined>(src)
  const latestUrl = useRef<string | undefined>()

  useEffect(() => {
    if (!src) { setDisplaySrc(undefined); return }

    // 立即显示原图（无延迟）
    setDisplaySrc(src)
    latestUrl.current = src

    removeBackground(src).then(processed => {
      // 确保 URL 未在异步期间切换
      if (latestUrl.current === src) setDisplaySrc(processed)
    })
  }, [src])

  if (!displaySrc) return null

  return <img src={displaySrc} className={className} alt={alt} />
}
