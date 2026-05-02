/**
 * gen-page-icons.cjs
 * 将 public/icons/ 下的所有 icon-*.svg 转换为 PNG 格式
 * 用途：为小程序、electron 等场景提供位图图标
 *
 * 运行：node gen-page-icons.cjs
 * 依赖（二选一，优先 sharp）：
 *   npm install sharp
 *   npm install @resvg/resvg-js
 */

'use strict'

const fs   = require('fs')
const path = require('path')

// ── 配置 ──────────────────────────────────────────────────────────────────────
const ICONS_DIR  = path.join(__dirname, 'public/icons')
const OUTPUT_DIR = path.join(__dirname, 'public/icons/png')
// 输出尺寸（可按需调整）：96px 适合 2x 小程序 tabBar；192px 适合高清场景
const SIZES = [48, 96, 192]
// ─────────────────────────────────────────────────────────────────────────────

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true })
}

/** 获取所有 icon-*.svg 文件 */
function getSvgFiles() {
  return fs.readdirSync(ICONS_DIR)
    .filter(f => f.startsWith('icon-') && f.endsWith('.svg'))
    .map(f => ({
      name: f.replace('.svg', ''),
      svgPath: path.join(ICONS_DIR, f),
    }))
}

/** 用 sharp 批量转换 */
async function convertWithSharp(files) {
  const sharp = require('sharp')
  for (const { name, svgPath } of files) {
    const svgBuf = fs.readFileSync(svgPath)
    for (const size of SIZES) {
      const outPath = path.join(OUTPUT_DIR, `${name}-${size}.png`)
      await sharp(svgBuf).resize(size, size).png().toFile(outPath)
      console.log(`✓ ${name}-${size}.png`)
    }
  }
}

/** 用 @resvg/resvg-js 批量转换 */
async function convertWithResvg(files) {
  const { Resvg } = require('@resvg/resvg-js')
  for (const { name, svgPath } of files) {
    const svgStr = fs.readFileSync(svgPath, 'utf-8')
    for (const size of SIZES) {
      const resvg   = new Resvg(svgStr, { fitTo: { mode: 'width', value: size } })
      const pngData = resvg.render()
      const outPath = path.join(OUTPUT_DIR, `${name}-${size}.png`)
      fs.writeFileSync(outPath, pngData.asPng())
      console.log(`✓ ${name}-${size}.png  (resvg)`)
    }
  }
}

async function main() {
  const files = getSvgFiles()
  if (files.length === 0) {
    console.log('没有找到 icon-*.svg 文件，请检查 public/icons/ 目录')
    return
  }

  console.log(`发现 ${files.length} 个 SVG 图标，输出至 ${OUTPUT_DIR}`)
  console.log(`目标尺寸：${SIZES.join('px, ')}px\n`)

  try {
    await convertWithSharp(files)
    console.log('\n✅ 全部转换完成（使用 sharp）')
    return
  } catch (_e1) {
    // sharp 未安装，尝试 resvg
  }

  try {
    await convertWithResvg(files)
    console.log('\n✅ 全部转换完成（使用 @resvg/resvg-js）')
    return
  } catch (_e2) {
    // 两者都没有
  }

  console.log('\n⚠️  未找到可用的 SVG 渲染器，请安装以下任一依赖：')
  console.log('   npm install sharp')
  console.log('   npm install @resvg/resvg-js')
  console.log('\nSVG 文件本身可以直接在小程序 <image> 中使用（Android/iOS 支持 SVG src）。')
  console.log('若需强制 PNG，安装上述依赖后重新运行本脚本。')
}

main().catch(console.error)
