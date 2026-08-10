import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// shared/ holds the one copy of the bundle-share arithmetic. It is CommonJS
// because the backend requires it directly at preflight, and the console
// imports the same file so the number the operator watches while typing and the
// number preflight checks against the caps cannot come from two implementations.
const SHARED = fileURLToPath(new URL('../shared/', import.meta.url)).replace(/\\/g, '/');

/**
 * Serve shared/*.js to the browser as ES modules.
 *
 * Rolldown converts CommonJS itself when it bundles for production, but the dev
 * server hands source modules to the browser untouched — `module` would be
 * undefined and the console would not boot under `npm run dev`. This wraps
 * shared/ and nothing else, in the same shape the production build produces, so
 * `import share from '…/shared/x.js'` means module.exports in both.
 */
function sharedCommonJs() {
  return {
    name: 'pons-shared-commonjs',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').startsWith(SHARED)) return null;
      return {
        code: `const module = { exports: {} };\nconst exports = module.exports;\n${code}\nexport default module.exports;`,
        map: null,
      };
    },
  };
}

// In dev the console runs on :5173 and the API on :3100, so /api is proxied.
// In production `npm run build` emits dist/ and the backend serves it, keeping
// the whole thing one origin behind one nginx block.
export default defineConfig({
  plugins: [sharedCommonJs(), react()],
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
