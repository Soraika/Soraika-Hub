import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    vueDevTools(),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // 把 /api 代理到后端（Server/），前端只写相对路径 —— 同源，免 CORS、免跨域 cookie 问题
    // 目标写 127.0.0.1 而不是 localhost：localhost 在 Node 里可能先解析成 IPv6 ::1，
    // 而后端只监听 IPv4 时会报 ECONNREFUSED（AggregateError）。
    // 可用 API_TARGET 覆盖：端到端验收脚本会自己起一个隔离后端，不想和开发实例抢 3100。
    proxy: {
      '/api': {
        target: process.env.API_TARGET || 'http://127.0.0.1:3100',
        changeOrigin: true,
      },
    },
  },
})

