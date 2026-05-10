/**
 * mattingOnnx.ts — 端侧语义抠图（U2Netp / onnxruntime-web）
 *
 * 与桌面端 rembg(u2net) 同源（U^2-Net 系列）的小模型：
 *   - 模型: public/models/u2netp.onnx (~4.4 MB)
 *   - 后端: onnxruntime-web (wasm, simd-threaded)
 *   - 输入: NCHW (1,3,320,320), float32, ImageNet 归一化
 *   - 输出: (1,1,320,320) sigmoid alpha mask, 0..1
 *
 * 使用：
 *   import { cutoutPortraitOnnx, isOnnxMattingAvailable } from './mattingOnnx'
 *   const png = await cutoutPortraitOnnx(rawDataUrl)   // 返回带透明通道的 PNG dataUrl
 *
 * 失败/未就绪时抛错，由调用方回退到 imageGen.cutoutPortrait()（Canvas 抠图）。
 */

import * as ort from 'onnxruntime-web'

const MODEL_URL = './models/u2netp.onnx'
const INPUT_SIZE = 320

// ImageNet 归一化常数（U2Net 训练时使用）
const MEAN = [0.485, 0.456, 0.406]
const STD = [0.229, 0.224, 0.225]

let _session: ort.InferenceSession | null = null
let _initPromise: Promise<ort.InferenceSession> | null = null
let _disabled = false  // 一旦失败标记禁用，避免反复尝试

/** 是否启用了端侧 ONNX 抠图（受用户设置 + 运行时可用性双重控制） */
export function isOnnxMattingAvailable(): boolean {
  return !_disabled
}

/** 强制禁用（设置项关闭时调用） */
export function disableOnnxMatting(): void {
  _disabled = true
}

/** 重置启用状态（设置项打开时调用） */
export function resetOnnxMatting(): void {
  _disabled = false
}

async function getSession(): Promise<ort.InferenceSession> {
  if (_session) return _session
  if (_initPromise) return _initPromise

  _initPromise = (async () => {
    // 配置 wasm 路径（构建后 wasm 文件位于 dist/ort/ 下）
    // ort 1.19 默认使用 ort-wasm-simd-threaded.wasm
    ;(ort.env.wasm as { wasmPaths?: string }).wasmPaths = './ort/'
    // 移动端线程数保守：避免与图片生成 fetch 抢资源
    ort.env.wasm.numThreads = 1
    // simd 让 ort 自行检测；proxy=false 简化 Capacitor WebView 兼容性
    ort.env.wasm.proxy = false

    const session = await ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
    _session = session
    return session
  })()

  try {
    return await _initPromise
  } catch (e) {
    _initPromise = null
    _disabled = true
    throw e
  }
}

/** 预加载模型（可在 App 启动后空闲时调用，缩短首次抠图等待） */
export async function preloadOnnxMatting(): Promise<void> {
  if (_disabled) return
  try {
    await getSession()
  } catch (e) {
    console.warn('[mattingOnnx] preload failed:', e)
  }
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

/** 把 HTMLImageElement 缩放到 320x320 + 归一化为 NCHW Float32Array */
function imageToTensor(img: HTMLImageElement): Float32Array {
  const canvas = document.createElement('canvas')
  canvas.width = INPUT_SIZE
  canvas.height = INPUT_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, INPUT_SIZE, INPUT_SIZE)
  const data = ctx.getImageData(0, 0, INPUT_SIZE, INPUT_SIZE).data

  const N = INPUT_SIZE * INPUT_SIZE
  const out = new Float32Array(3 * N)
  // NCHW: out[c*N + i] = (px[c]/255 - mean[c]) / std[c]
  for (let i = 0; i < N; i++) {
    const off = i * 4
    const r = data[off] / 255
    const g = data[off + 1] / 255
    const b = data[off + 2] / 255
    out[i] = (r - MEAN[0]) / STD[0]
    out[N + i] = (g - MEAN[1]) / STD[1]
    out[2 * N + i] = (b - MEAN[2]) / STD[2]
  }
  return out
}

/** mask 320x320 双线性回采到任意 (w,h)，并归一化 0..1 */
function resampleMask(mask: Float32Array, w: number, h: number): Float32Array {
  // 先求 mask 的 min/max 做拉伸，避免输出整体偏暗或偏白
  let mn = Infinity, mx = -Infinity
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i]
    if (v < mn) mn = v
    if (v > mx) mx = v
  }
  const range = mx - mn > 1e-6 ? mx - mn : 1
  const out = new Float32Array(w * h)
  const sxRatio = (INPUT_SIZE - 1) / Math.max(w - 1, 1)
  const syRatio = (INPUT_SIZE - 1) / Math.max(h - 1, 1)

  for (let y = 0; y < h; y++) {
    const sy = y * syRatio
    const y0 = Math.floor(sy)
    const y1 = Math.min(y0 + 1, INPUT_SIZE - 1)
    const fy = sy - y0
    for (let x = 0; x < w; x++) {
      const sx = x * sxRatio
      const x0 = Math.floor(sx)
      const x1 = Math.min(x0 + 1, INPUT_SIZE - 1)
      const fx = sx - x0
      const v00 = mask[y0 * INPUT_SIZE + x0]
      const v01 = mask[y0 * INPUT_SIZE + x1]
      const v10 = mask[y1 * INPUT_SIZE + x0]
      const v11 = mask[y1 * INPUT_SIZE + x1]
      const v0 = v00 * (1 - fx) + v01 * fx
      const v1 = v10 * (1 - fx) + v11 * fx
      const v = v0 * (1 - fy) + v1 * fy
      out[y * w + x] = (v - mn) / range
    }
  }
  return out
}

/**
 * 主流程：dataUrl → 端侧 U2Netp 推理 → mask → alpha + despill → PNG dataUrl。
 * 失败时抛错，调用方应自行回退。
 */
export async function cutoutPortraitOnnx(dataUrl: string): Promise<string> {
  if (_disabled) throw new Error('onnx matting disabled')

  const session = await getSession()
  const img = await loadImage(dataUrl)
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  if (!w || !h) throw new Error('invalid image dimensions')

  // ── 推理 ──
  const inputData = imageToTensor(img)
  const inputTensor = new ort.Tensor('float32', inputData, [1, 3, INPUT_SIZE, INPUT_SIZE])
  // U2Net 系列输入名通常为 'input.1' 或 'input'，用 inputNames[0] 兼容
  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]
  const feeds: Record<string, ort.Tensor> = {}
  feeds[inputName] = inputTensor

  const outputs = await session.run(feeds)
  const maskTensor = outputs[outputName]
  if (!maskTensor || !(maskTensor.data instanceof Float32Array)) {
    throw new Error('onnx output is not float32')
  }
  const maskRaw = maskTensor.data as Float32Array
  // 仅取前 320*320（U2Net 输出可能含多个分辨率分支）
  const maskMain = maskRaw.subarray(0, INPUT_SIZE * INPUT_SIZE) as Float32Array

  // ── 回采到原图 ──
  const maskFull = resampleMask(maskMain, w, h)

  // ── 写到 canvas，做 despill + 边缘软化 ──
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d context unavailable')
  ctx.drawImage(img, 0, 0, w, h)
  const imgData = ctx.getImageData(0, 0, w, h)
  const data = imgData.data

  for (let i = 0; i < w * h; i++) {
    const off = i * 4
    const r = data[off], g = data[off + 1], b = data[off + 2]
    const m = maskFull[i]   // 0..1

    // alpha：低于 0.05 完全透明，高于 0.95 完全不透明，中间线性
    let a: number
    if (m <= 0.05) a = 0
    else if (m >= 0.95) a = 255
    else a = Math.round(((m - 0.05) / 0.9) * 255)

    // despill: 抑制人物边缘的绿色/背景溢色
    if (a < 220 && g > Math.max(r, b)) {
      const cap = Math.max(r, b)
      data[off + 1] = cap
    }
    data[off + 3] = a
  }
  ctx.putImageData(imgData, 0, 0)

  return canvas.toDataURL('image/png')
}
