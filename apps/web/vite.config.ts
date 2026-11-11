import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// 开发时把 /api 代理到本地后端；生产环境由 Nginx 做同样的转发，前后端同源，cookie 不跨域。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_TARGET ?? 'http://127.0.0.1:3000', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
  test: { environment: 'jsdom' },
});
