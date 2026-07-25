import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev the console runs on :5173 and the API on :3100, so /api is proxied.
// In production `npm run build` emits dist/ and the backend serves it, keeping
// the whole thing one origin behind one nginx block.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_TARGET || 'http://127.0.0.1:3100',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
