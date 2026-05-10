/**
 * imageGen.ts — TypeScript 版图像生成服务
 * 直接通过 fetch 调用 SiliconFlow、ARK（豆包）、OpenAI DALL-E 等兼容接口
 * 返回 base64 data URL（"data:image/png;base64,..."）
 *
 * v0.7.2: 新增手机端纯 Canvas 抠图 cutoutPortrait()
 *   - 自动检测背景色（绿幕优先 / 边缘采样回退）
 *   - 容差色域抠图（HSV 空间，对绿色溢色友好）
 *   - 连通分量分析：保留最大主体，剔除背景碎屑
 *   - 边缘 alpha 软化（3x3 box blur 近似高斯）
 *   - 绿色溢色抑制（despill）：把 g 拉到 max(r,b)，边缘像素更激进
 */

// ── 尺寸常量 ─────────────────────────────────────────────────────────────────

const SF_SIZES: Record<string, string> = {
  portrait:     '576x1024',
  bg_landscape: '1024x576',
  bg_portrait:  '576x1024',
  cg:           '1024x576',
  cover:        '768x1024',
}

const ARK_SIZES: Record<string, string> = {
  portrait:     '1600x2848',
  bg_landscape: '2560x1440',
  bg_portrait:  '1600x2848',
  cg:           '2848x1600',
  cover:        '1728x2304',
}

const DALLE_SIZES: Record<string, string> = {
  portrait:     '1024x1792',
  bg_landscape: '1792x1024',
  bg_portrait:  '1024x1792',
  cg:           '1792x1024',
  cover:        '1024x1792',
}

const GENERIC_SIZES: Record<string, string> = {
  portrait:     '512x768',
  bg_landscape: '768x512',
  bg_portrait:  '512x768',
  cg:           '768x512',
  cover:        '512x768',
}

// ── Provider 识别 ─────────────────────────────────────────────────────────────

type Provider = 'openai' | 'ark' | 'siliconflow' | 'openrouter' | 'generic'

function detectProvider(endpoint?: string): Provider {
  if (!endpoint) return 'openai'
  const e = endpoint.toLowerCase()
  if (e.includes('siliconflow')) return 'siliconflow'
  if (e.includes('volces.com') || e.includes('volcengine') || e.includes('ark.cn-') || e.startsWith('https://ark.')) return 'ark'
  if (e.includes('openrouter')) return 'openrouter'
  if (e.includes('openai.com')) return 'openai'
  return 'generic'
}

function normalizeBase(endpoint: string): string {
  return endpoint.replace(/\/(images\/generations.*|v1\/images.*)$/, '').replace(/\/$/, '')
}

// ── 表情词典 ──────────────────────────────────────────────────────────────────

const EXPRESSION_MAP: Record<string, string> = {
  normal:    'neutral expression, calm',
  happy:     'smiling warmly, bright eyes',
  sad:       'sad expression, slightly downcast eyes',
  surprised: 'surprised expression, wide eyes',
  angry:     'angry expression, furrowed brows',
  shy:       'blushing, shy expression',
  serious:   'serious expression, determined look',
  hurt:      'hurt expression, pained eyes, slightly trembling',
}

// ── 核心生成函数 ──────────────────────────────────────────────────────────────

export interface ImageModelCfg {
  model: string
  api_key: string
  endpoint?: string
}

/** 将二进制 ArrayBuffer 转为 base64 data URL */
function toDataUrl(buf: ArrayBuffer, mime = 'image/png'): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return `data:${mime};base64,${btoa(binary)}`
}

// 全局并发控制：最多同时进行 3 个图像生成请求
let _inflight = 0
const _queue: Array<() => void> = []
const MAX_CONCURRENT = 3

async function acquireSlot(): Promise<void> {
  if (_inflight < MAX_CONCURRENT) { _inflight++; return }
  await new Promise<void>(resolve => _queue.push(resolve))
  _inflight++
}

function releaseSlot(): void {
  _inflight--
  const next = _queue.shift()
  if (next) next()
}

async function generateSiliconflow(
  prompt: string,
  sizeKey: string,
  cfg: ImageModelCfg,
): Promise<string> {
  const base = normalizeBase(cfg.endpoint ?? 'https://api.siliconflow.cn/v1')
  const size = SF_SIZES[sizeKey] ?? SF_SIZES['portrait']
  const [width, height] = size.split('x').map(Number)

  // 最多重试 4 次（429 速率限制退避）
  const delays = [0, 15000, 30000, 60000, 90000]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await new Promise(r => setTimeout(r, delays[attempt]))
    const res = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.api_key}`,
      },
      body: JSON.stringify({ model: cfg.model, prompt, image_size: `${width}x${height}`, num_inference_steps: 20 }),
    })
    if (res.status === 429 && attempt < delays.length - 1) continue
    if (!res.ok) throw new Error(`SiliconFlow ${res.status}: ${await res.text()}`)
    const data = await res.json() as { images?: Array<{ url?: string; b64_json?: string }> }
    const img = data.images?.[0]
    if (!img) throw new Error('SiliconFlow: empty response')
    if (img.b64_json) return `data:image/png;base64,${img.b64_json}`
    if (img.url) {
      // 下载图片转 base64
      const imgRes = await fetch(img.url)
      return toDataUrl(await imgRes.arrayBuffer())
    }
    throw new Error('SiliconFlow: no image data')
  }
  throw new Error('SiliconFlow: max retries exceeded')
}

async function generateArk(
  prompt: string,
  sizeKey: string,
  cfg: ImageModelCfg,
): Promise<string> {
  const base = normalizeBase(cfg.endpoint ?? 'https://ark.cn-beijing.volces.com/api/v3')
  const size = ARK_SIZES[sizeKey] ?? ARK_SIZES['portrait']
  const [width, height] = size.split('x').map(Number)

  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.api_key}`,
    },
    body: JSON.stringify({ model: cfg.model, prompt, width, height, response_format: 'b64_json' }),
  })
  if (!res.ok) throw new Error(`ARK ${res.status}: ${await res.text()}`)
  const data = await res.json() as { data?: Array<{ b64_json?: string; url?: string }> }
  const img = data.data?.[0]
  if (!img) throw new Error('ARK: empty response')
  if (img.b64_json) return `data:image/png;base64,${img.b64_json}`
  if (img.url) {
    const imgRes = await fetch(img.url)
    return toDataUrl(await imgRes.arrayBuffer())
  }
  throw new Error('ARK: no image data')
}

async function generateOpenAI(
  prompt: string,
  sizeKey: string,
  cfg: ImageModelCfg,
): Promise<string> {
  const base = normalizeBase(cfg.endpoint ?? 'https://api.openai.com/v1')
  const size = DALLE_SIZES[sizeKey] ?? '1024x1024'

  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.api_key}`,
    },
    body: JSON.stringify({ model: cfg.model, prompt, size, response_format: 'b64_json', n: 1 }),
  })
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`)
  const data = await res.json() as { data?: Array<{ b64_json?: string }> }
  const b64 = data.data?.[0]?.b64_json
  if (!b64) throw new Error('OpenAI: no b64_json in response')
  return `data:image/png;base64,${b64}`
}

async function generateGeneric(
  prompt: string,
  sizeKey: string,
  cfg: ImageModelCfg,
): Promise<string> {
  const base = normalizeBase(cfg.endpoint ?? '')
  const size = GENERIC_SIZES[sizeKey] ?? '512x512'

  const res = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.api_key}`,
    },
    body: JSON.stringify({ model: cfg.model, prompt, size, response_format: 'b64_json', n: 1 }),
  })
  if (!res.ok) {
    // 退化为最简调用
    const res2 = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.api_key}` },
      body: JSON.stringify({ model: cfg.model, prompt }),
    })
    if (!res2.ok) throw new Error(`Generic ${res2.status}: ${await res2.text()}`)
    const data2 = await res2.json() as { data?: Array<{ b64_json?: string; url?: string }> }
    const img2 = data2.data?.[0]
    if (!img2) throw new Error('Generic: empty response')
    if (img2.b64_json) return `data:image/png;base64,${img2.b64_json}`
    if (img2.url) { const r = await fetch(img2.url); return toDataUrl(await r.arrayBuffer()) }
    throw new Error('Generic: no image data')
  }
  const data = await res.json() as { data?: Array<{ b64_json?: string; url?: string }> }
  const img = data.data?.[0]
  if (!img) throw new Error('Generic: empty response')
  if (img.b64_json) return `data:image/png;base64,${img.b64_json}`
  if (img.url) { const r = await fetch(img.url); return toDataUrl(await r.arrayBuffer()) }
  throw new Error('Generic: no image data')
}

async function dispatch(prompt: string, sizeKey: string, cfg: ImageModelCfg): Promise<string> {
  await acquireSlot()
  try {
    const provider = detectProvider(cfg.endpoint)
    if (provider === 'siliconflow') return await generateSiliconflow(prompt, sizeKey, cfg)
    if (provider === 'ark') return await generateArk(prompt, sizeKey, cfg)
    if (provider === 'openai') return await generateOpenAI(prompt, sizeKey, cfg)
    return await generateGeneric(prompt, sizeKey, cfg)
  } finally {
    releaseSlot()
  }
}

// ── 公开接口 ──────────────────────────────────────────────────────────────────

export async function generatePortrait(
  characterAppearance: string,
  expression: string,
  globalStyle: string,
  cfg: ImageModelCfg,
): Promise<string> {
  const exprDesc = EXPRESSION_MAP[expression] ?? expression
  const prompt = (
    `CHROMA KEY GREEN SCREEN: solid flat pure green #00FF00 background ONLY. ` +
    `Single uniform color background, absolutely NO scenery NO environment NO landscape NO gradient NO shadow on background. ` +
    `Visual novel character sprite, ${globalStyle} art style, ${characterAppearance}, ` +
    `${exprDesc}, ` +
    `full body standing pose from head to feet, character facing forward with a slight three-quarter angle, neutral idle stance, arms relaxed at sides, ` +
    `consistent camera distance and framing, character occupies approximately 80 percent of the vertical canvas, head positioned in upper 12 percent of the frame, feet visible in the lower 5 percent, ` +
    `character centered in frame, vertical portrait format, high quality`
  )
  const raw = await dispatch(prompt, 'portrait', cfg)
  // v0.7.2: 优先端侧 ONNX 语义抠图（U2Netp），失败时回退 Canvas 色域抠图
  try {
    const { cutoutPortraitOnnx, isOnnxMattingAvailable } = await import('./mattingOnnx')
    if (isOnnxMattingAvailable()) {
      try {
        return await cutoutPortraitOnnx(raw)
      } catch (e) {
        console.warn('[mattingOnnx] failed, fallback to canvas cutout:', e)
      }
    }
  } catch (e) {
    console.warn('[mattingOnnx] module load failed:', e)
  }
  try {
    return await cutoutPortrait(raw)
  } catch (e) {
    console.warn('[cutoutPortrait] failed, returning raw image:', e)
    return raw
  }
}

export async function generateBackground(
  sceneDescription: string,
  globalStyle: string,
  orientation: 'landscape' | 'portrait' = 'landscape',
  cfg: ImageModelCfg,
): Promise<string> {
  const prompt = (
    `Visual novel background, ${sceneDescription}, ${globalStyle}, ` +
    `no characters, no people, no humans, no figures, no silhouettes, ` +
    `atmospheric, detailed environment, ` +
    `${orientation === 'landscape' ? 'wide cinematic shot, 16:9' : 'vertical composition, 9:16'}, ` +
    `high quality illustration`
  )
  const sizeKey = orientation === 'landscape' ? 'bg_landscape' : 'bg_portrait'
  return dispatch(prompt, sizeKey, cfg)
}

export async function generateCG(
  cgPrompt: string,
  cfg: ImageModelCfg,
): Promise<string> {
  return dispatch(cgPrompt, 'cg', cfg)
}

export async function generateCover(
  title: string,
  synopsis: string,
  globalStyle: string,
  cfg: ImageModelCfg,
): Promise<string> {
  const prompt = (
    `Visual novel cover art, "${title}", ${synopsis}, ${globalStyle}, ` +
    `cinematic composition, dramatic lighting, ` +
    `main characters featured prominently, high quality illustration, book cover style`
  )
  return dispatch(prompt, 'cover', cfg)
}

// ── 立绘抠图（纯 Canvas 实现）──────────────────────────────────────────────────

/**
 * 将一张可能含绿幕背景的立绘转为带透明通道的 PNG data URL。
 *
 * 算法步骤：
 *   1. 解码 dataUrl 到 Canvas，取 ImageData
 *   2. 自动检测背景色：
 *      - 优先识别绿幕（H ∈ [80°,160°], S>0.35, V>0.35 占比 > 25%）
 *      - 否则取四角 + 四边中点 8 个采样点的 RGB 均值作为背景色
 *   3. 像素三段式分类：
 *      - 强背景（距背景色 ΔE 很近 + 绿色显著）→ alpha = 0
 *      - 软边缘（中间过渡区）→ alpha 按距离线性渐变 + despill green
 *      - 主体 → 保留，仍做轻度 despill
 *   4. 连通分量分析：保留最大主体连通块，其余标为透明（去碎屑）
 *   5. 3x3 box blur 平滑 alpha 边缘（仅对 alpha 通道）
 *   6. canvas.toDataURL('image/png')
 */
export async function cutoutPortrait(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl)
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  if (!w || !h) return dataUrl

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return dataUrl
  ctx.drawImage(img, 0, 0, w, h)

  let imgData: ImageData
  try {
    imgData = ctx.getImageData(0, 0, w, h)
  } catch (e) {
    // 跨域污染时无法 getImageData
    console.warn('[cutoutPortrait] getImageData blocked:', e)
    return dataUrl
  }
  const data = imgData.data

  // ── Step 1: 检测背景色 ────────────────────────────────────────────────
  const greenStats = detectGreenScreen(data, w, h)
  const useGreenScreen = greenStats.ratio >= 0.18

  let bgR = 0, bgG = 255, bgB = 0
  if (!useGreenScreen) {
    const sample = sampleEdgeBackground(data, w, h)
    bgR = sample.r; bgG = sample.g; bgB = sample.b
  }

  // ── Step 2: 像素分类 + despill ────────────────────────────────────────
  // 先生成 alpha 草稿（不直接改 data 的 a，避免影响后续邻域判定）
  const alphaDraft = new Uint8ClampedArray(w * h)
  for (let i = 0; i < w * h; i++) {
    const off = i * 4
    const r = data[off], g = data[off + 1], b = data[off + 2]

    let aFloat: number  // 0..1
    if (useGreenScreen) {
      aFloat = classifyGreenPixel(r, g, b)
    } else {
      aFloat = classifyBgDistance(r, g, b, bgR, bgG, bgB)
    }
    alphaDraft[i] = Math.round(aFloat * 255)

    // despill：绿色溢色去除
    if (g > Math.max(r, b)) {
      const cap = Math.max(r, b)
      const newG = aFloat < 0.85 ? Math.round((r + b) / 2) : cap
      data[off + 1] = newG
    }
  }

  // ── Step 3: 连通分量分析（仅当大块背景存在时执行）──────────────────────
  // 把 alpha < 32 视为背景，alpha >= 32 视为前景候选；保留最大前景连通块
  const fgMask = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) fgMask[i] = alphaDraft[i] >= 32 ? 1 : 0
  const keptMask = keepLargestComponent(fgMask, w, h)
  // 被剔除的小碎屑：alpha 强制为 0
  for (let i = 0; i < w * h; i++) {
    if (!keptMask[i]) alphaDraft[i] = 0
  }

  // ── Step 4: 3x3 邻域平滑（只对 alpha）──────────────────────────────────
  const smoothed = boxBlurAlpha(alphaDraft, w, h)

  // ── Step 5: 写回 ──────────────────────────────────────────────────────
  for (let i = 0; i < w * h; i++) {
    data[i * 4 + 3] = smoothed[i]
  }
  ctx.putImageData(imgData, 0, 0)

  return canvas.toDataURL('image/png')
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = src
  })
}

/** 统计图像中绿幕色域像素占比 */
function detectGreenScreen(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): { ratio: number } {
  const total = w * h
  let greenCount = 0
  // 抽样：每 4 个像素取 1 个，提速
  for (let i = 0; i < total; i += 4) {
    const off = i * 4
    const r = data[off], g = data[off + 1], b = data[off + 2]
    if (g > 80 && g > r * 1.25 && g > b * 1.25) greenCount++
  }
  return { ratio: (greenCount * 4) / total }
}

/** 边缘像素采样（四角 + 四边中点）→ 背景色估计 */
function sampleEdgeBackground(
  data: Uint8ClampedArray,
  w: number,
  h: number,
): { r: number; g: number; b: number } {
  const points: Array<[number, number]> = [
    [0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1],
    [Math.floor(w / 2), 0], [Math.floor(w / 2), h - 1],
    [0, Math.floor(h / 2)], [w - 1, Math.floor(h / 2)],
  ]
  let r = 0, g = 0, b = 0
  for (const [x, y] of points) {
    const off = (y * w + x) * 4
    r += data[off]; g += data[off + 1]; b += data[off + 2]
  }
  const n = points.length
  return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) }
}

/** 绿幕像素 → alpha (0..1)。0=完全背景, 1=完全前景 */
function classifyGreenPixel(r: number, g: number, b: number): number {
  // 绿色优势度：g 比 max(r,b) 高出多少
  const cap = Math.max(r, b)
  const dom = g - cap            // -255..255
  if (dom <= 0) return 1.0       // 红/蓝 占优 → 100% 前景
  if (g < 60) return 1.0         // 暗色，不会是绿幕

  // dom 越大越像绿幕
  // dom >= 80 → 完全背景
  // dom <= 15 → 完全前景
  // 中间线性插值
  if (dom >= 80) return 0.0
  if (dom <= 15) return 1.0
  return 1.0 - (dom - 15) / (80 - 15)
}

/** 通用色距 → alpha (0..1) */
function classifyBgDistance(
  r: number, g: number, b: number,
  bgR: number, bgG: number, bgB: number,
): number {
  const dr = r - bgR, dg = g - bgG, db = b - bgB
  const d = Math.sqrt(dr * dr + dg * dg + db * db)
  // d <= 30 → 完全背景；d >= 90 → 完全前景；中间渐变
  if (d <= 30) return 0.0
  if (d >= 90) return 1.0
  return (d - 30) / (90 - 30)
}

/** 保留最大前景连通块，返回新 mask */
function keepLargestComponent(
  mask: Uint8Array,
  w: number,
  h: number,
): Uint8Array {
  const total = w * h
  const labels = new Int32Array(total) // 0 = 未访问
  let maxLabel = 0
  let maxSize = 0
  let curLabel = 0
  const stack = new Int32Array(total)

  for (let start = 0; start < total; start++) {
    if (mask[start] === 0 || labels[start] !== 0) continue
    curLabel++
    let size = 0
    let top = 0
    stack[top++] = start
    labels[start] = curLabel
    while (top > 0) {
      const idx = stack[--top]
      size++
      const x = idx % w
      const y = (idx / w) | 0
      // 4-邻域
      if (x > 0) {
        const n = idx - 1
        if (mask[n] === 1 && labels[n] === 0) { labels[n] = curLabel; stack[top++] = n }
      }
      if (x < w - 1) {
        const n = idx + 1
        if (mask[n] === 1 && labels[n] === 0) { labels[n] = curLabel; stack[top++] = n }
      }
      if (y > 0) {
        const n = idx - w
        if (mask[n] === 1 && labels[n] === 0) { labels[n] = curLabel; stack[top++] = n }
      }
      if (y < h - 1) {
        const n = idx + w
        if (mask[n] === 1 && labels[n] === 0) { labels[n] = curLabel; stack[top++] = n }
      }
    }
    if (size > maxSize) { maxSize = size; maxLabel = curLabel }
  }

  const out = new Uint8Array(total)
  if (maxLabel === 0) return out
  for (let i = 0; i < total; i++) out[i] = labels[i] === maxLabel ? 1 : 0
  return out
}

/** 3x3 box blur（仅 alpha 通道）→ 边缘软化 */
function boxBlurAlpha(
  alpha: Uint8ClampedArray,
  w: number,
  h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0, cnt = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          sum += alpha[yy * w + xx]
          cnt++
        }
      }
      out[y * w + x] = Math.round(sum / cnt)
    }
  }
  return out
}
