import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Capacitor 需要绝对路径前缀为空（Android WebView 使用本地文件）
  base: './',
  build: {
    outDir: 'dist',
    // 单文件拆分：减少首屏体积
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          motion: ['framer-motion'],
        },
      },
    },
  },
  server: {
    port: 5174,
  },
})
