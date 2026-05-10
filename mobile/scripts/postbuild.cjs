// 删除 vite 自动从 onnxruntime-web bundle 中提取的 wasm 副本
// 我们已通过 public/ort/ 提供同名 wasm，运行时只读 ./ort/，assets 里那份是冗余
const fs = require('fs')
const path = require('path')

const dir = path.join(__dirname, '..', 'dist', 'assets')
if (!fs.existsSync(dir)) {
  console.log('[postbuild] dist/assets not found, skip')
  process.exit(0)
}
let removed = 0
for (const f of fs.readdirSync(dir)) {
  if (/^ort-wasm.*\.wasm$/.test(f)) {
    fs.unlinkSync(path.join(dir, f))
    console.log('[postbuild] removed dup wasm:', f)
    removed++
  }
}
console.log(`[postbuild] removed ${removed} duplicate wasm file(s)`)
