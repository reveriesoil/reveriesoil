import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Capacitor 需要绝对路径前缀为空（Android WebView 使用本地文件）
  base: './',
  // onnxruntime-web 是预编译 ESM + WASM，让 Vite 不要二次处理
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  build: {
    outDir: 'dist',
    // 单文件拆分：减少首屏体积
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          motion: ['framer-motion'],
          ort: ['onnxruntime-web'],
        },
      },
    },
  },
  server: {
    port: 5174,
  },
})
