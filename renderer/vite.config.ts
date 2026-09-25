// Vite 构建：目标 chrome108（Electron 22 内置 Chromium 108），Solid 插件
import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'url';

export default defineConfig({
  plugins: [solid()],
  // 相对资源路径：打包后经 file:// 协议加载（默认 '/' 会导致白屏）
  base: './',
  resolve: {
    alias: {
      // 直接引用契约源码，绕过 CJS re-export 的 rollup 静态分析限制
      '@codara/contract': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  build: {
    target: 'chrome108', // 硬约束：Electron 22 / Chromium 108
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5183,
    strictPort: true,
  },
});
