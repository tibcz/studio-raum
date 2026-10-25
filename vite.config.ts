import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        '404': fileURLToPath(new URL('./404.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5182,
    strictPort: true,
    proxy: { '/api': { target: 'http://localhost:4182', ws: true, changeOrigin: false } },
  },
});
