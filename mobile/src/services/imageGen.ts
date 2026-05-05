/**
 * imageGen.ts — TypeScript 版图像生成服务
 * 直接通过 fetch 调用 SiliconFlow、ARK（豆包）、OpenAI DALL-E 等兼容接口
 * 返回 base64 data URL（"data:image/png;base64,..."）
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
  return dispatch(prompt, 'portrait', cfg)
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
