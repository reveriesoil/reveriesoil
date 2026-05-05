/**
 * 客户端人像抠图工具
 * 策略：
 *   1. 若图片已有透明通道（服务端已处理）→ 直接跳过
 *   2. 若绿幕像素占比 > 6% → 色键抠图（快速）
 *   3. 否则 → 从四边采样背景色 + BFS 洪泛填充（通用）
 *   4. 对 alpha 通道做 2 轮 box-blur 羽化边缘
 *
 * 所有运算均在浏览器 Canvas API 上执行，不依赖服务端。
 * 若因 CORS 无法读取像素，静默 fallback 至原始 URL。
 */

const _cache = new Map<string, string>()

// ── 基础工具 ────────────────────────────────────────────────

function colorDist(
  r1: number, g1: number, b1: number,
  r2: number, g2: number, b2: number,
): number {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2
  return Math.sqrt(dr * dr + dg * dg + db * db)
}

/** 统计绿幕像素比例 */
function greenRatio(data: Uint8ClampedArray): number {
  let green = 0
  const total = data.length >> 2
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3]
    if (a > 100 && g > 80 && g > r * 1.35 && g > b * 1.35) green++
  }
  return green / total
}

/** 统计透明像素比例（判断是否已抠图） */
function transparentRatio(data: Uint8ClampedArray): number {
  let t = 0
  const total = data.length >> 2
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 100) t++
  }
  return t / total
}

// ── 色键抠图（绿幕） ─────────────────────────────────────────

function applyChromaKey(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2]
    if (g > 60 && g > r * 1.25 && g > b * 1.25) {
      const excess = g - Math.max(r, b)
      const strength = Math.min(1.0, excess / 70.0)
      data[i + 3] = Math.round(data[i + 3] * (1.0 - strength))
    }
  }
}

// ── alpha 羽化（box-blur） ────────────────────────────────────

function blurAlpha(data: Uint8ClampedArray, w: number, h: number, passes = 2): void {
  const alphaMap = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) alphaMap[i] = data[i * 4 + 3]

  for (let pass = 0; pass < passes; pass++) {
    const next = new Float32Array(w * h)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x
        let sum = alphaMap[idx], count = 1
        if (x > 0)     { sum += alphaMap[idx - 1]; count++ }
        if (x < w - 1) { sum += alphaMap[idx + 1]; count++ }
        if (y > 0)     { sum += alphaMap[idx - w]; count++ }
        if (y < h - 1) { sum += alphaMap[idx + w]; count++ }
        next[idx] = sum / count
      }
    }
    alphaMap.set(next)
  }

  for (let i = 0; i < w * h; i++) {
    data[i * 4 + 3] = Math.round(alphaMap[i])
  }
}

// ── 通用背景色采样 ───────────────────────────────────────────

/** 从图像四边采样，返回占主导地位的背景颜色 */
function sampleBorderColor(
  data: Uint8ClampedArray, w: number, h: number,
): [number, number, number] {
  const colors: Array<[number, number, number]> = []
  const step = Math.max(1, Math.round(Math.min(w, h) / 60))

  const sample = (x: number, y: number) => {
    const i = (y * w + x) * 4
    if (data[i + 3] > 200) colors.push([data[i], data[i + 1], data[i + 2]])
  }

  // 上下边（3 行深度）
  for (let x = 0; x < w; x += step) {
    for (let d = 0; d < 3; d++) { sample(x, d); sample(x, h - 1 - d) }
  }
  // 左右边（3 列深度，跳过角落）
  for (let y = 3; y < h - 3; y += step) {
    for (let d = 0; d < 3; d++) { sample(d, y); sample(w - 1 - d, y) }
  }

  if (colors.length === 0) return [0, 255, 0]

  // 按亮度排序取中位数，避免异常值干扰
  colors.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]))
  return colors[Math.floor(colors.length / 2)]
}

// ── BFS 洪泛填充 ─────────────────────────────────────────────

/**
 * 从四边所有像素出发进行 BFS，颜色距离 <= tol 的像素判为背景。
 * 返回 mask：0 = 背景，255 = 前景。
 */
function floodFillMask(
  data: Uint8ClampedArray, w: number, h: number,
  bgR: number, bgG: number, bgB: number,
  tol: number,
): Uint8Array {
  // 状态：0 = 未知，128 = 背景，255 = 前景
  const mask = new Uint8Array(w * h)
  const qx: number[] = []
  const qy: number[] = []

  const enqueue = (x: number, y: number) => {
    const idx = y * w + x
    if (mask[idx] !== 0) return
    const pi = idx * 4
    const r = data[pi], g = data[pi + 1], b = data[pi + 2], a = data[pi + 3]
    if (a < 20 || colorDist(r, g, b, bgR, bgG, bgB) <= tol) {
      mask[idx] = 128
      qx.push(x)
      qy.push(y)
    }
  }

  // 从四边种子
  for (let x = 0; x < w; x++) { enqueue(x, 0); enqueue(x, h - 1) }
  for (let y = 1; y < h - 1; y++) { enqueue(0, y); enqueue(w - 1, y) }

  // BFS 扩散
  let qi = 0
  while (qi < qx.length) {
    const cx = qx[qi], cy = qy[qi]; qi++
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]]
    for (const [dx, dy] of dirs) {
      const nx = cx + dx, ny = cy + dy
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
      const nidx = ny * w + nx
      if (mask[nidx] !== 0) continue
      const pi = nidx * 4
      const r = data[pi], g = data[pi + 1], b = data[pi + 2], a = data[pi + 3]
      if (a < 20 || colorDist(r, g, b, bgR, bgG, bgB) <= tol) {
        mask[nidx] = 128
        qx.push(nx)
        qy.push(ny)
      } else {
        mask[nidx] = 255 // 前景，不继续扩散
      }
    }
  }

  // 未访问到的孤立像素视为前景
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 0) mask[i] = 255
  }

  return mask
}

/** 将背景 mask 应用到 imageData（背景 alpha → 0） */
function applyMask(data: Uint8ClampedArray, mask: Uint8Array): void {
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 128) data[i * 4 + 3] = 0
  }
}

// ── 主入口 ───────────────────────────────────────────────────

/**
 * 对立绘 URL 进行客户端抠图，返回去除背景后的 Blob URL。
 * 结果会被缓存，同一 URL 只处理一次。
 * 若 CORS 受限或处理失败，静默返回原始 URL。
 */
export async function removeBackground(url: string): Promise<string> {
  if (_cache.has(url)) return _cache.get(url)!

  return new Promise(resolve => {
    const fallback = () => { _cache.set(url, url); resolve(url) }

    const img = new Image()
    img.crossOrigin = 'anonymous'

    img.onerror = fallback
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0)

        let imgData: ImageData
        try {
          imgData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        } catch {
          // CORS 阻止读取像素 → 直接用原图
          fallback()
          return
        }

        const { data, width, height } = imgData

        // 已有较多透明像素 → 服务端已抠图，跳过
        if (transparentRatio(data) > 0.15) {
          fallback()
          return
        }

        if (greenRatio(data) > 0.06) {
          // 快速路径：绿幕色键
          applyChromaKey(data)
        } else {
          // 通用路径：BFS 洪泛 + 背景色采样
          const [bgR, bgG, bgB] = sampleBorderColor(data, width, height)
          const mask = floodFillMask(data, width, height, bgR, bgG, bgB, 42)
          applyMask(data, mask)
        }

        // 羽化边缘（2 轮 box-blur 平滑 alpha）
        blurAlpha(data, width, height, 2)

        ctx.putImageData(imgData, 0, 0)
        canvas.toBlob(blob => {
          const blobUrl = blob ? URL.createObjectURL(blob) : url
          _cache.set(url, blobUrl)
          resolve(blobUrl)
        }, 'image/png')
      } catch {
        fallback()
      }
    }

    img.src = url
  })
}
