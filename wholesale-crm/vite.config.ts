import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  root: 'client',
  plugins: [react(), tailwind()],
  resolve: { alias: { '@shared': path.resolve(import.meta.dirname, 'shared'), '@': path.resolve(import.meta.dirname, 'client/src') } },
  server: { port: 5173, proxy: { '/api': 'http://localhost:8787' } },
  build: { outDir: '../dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
});
