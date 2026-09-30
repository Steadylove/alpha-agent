import { defineConfig } from 'vite';
export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true, rollupOptions: {
    output: { manualChunks: { charts: ['lightweight-charts'] } },
    onwarn(warning, warn) { if (warning.code === 'MODULE_LEVEL_DIRECTIVE' && warning.message.includes('use client')) return; warn(warning); },
  } },
  server: { port: 5188, proxy: { '/api': { target: 'http://127.0.0.1:8018', changeOrigin: false } } },
});
