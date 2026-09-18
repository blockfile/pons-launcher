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

export const CONSOLE_ENTRY = fileURLToPath(new URL('./index.html', import.meta.url));
export const DAPP_ENTRY = fileURLToPath(new URL('./dapp/index.html', import.meta.url));

/**
 * The config for one build of one page. `npm run build` runs TWO: the console
 * (this file, which empties dist/ first) and then the take-profit dApp
 * (vite.dapp.config.js: dapp/index.html -> dist/dapp/index.html, adding to
 * dist/assets/). Two builds, not one with two inputs: a module both pages import
 * (react-icons, framer-motion) would otherwise land in ONE shared chunk holding
 * the union of what each page uses, so the key-holding dApp page would load the
 * console's icons and animation features, and the console the dApp's. The dApp
 * is served on its own host by the server.js host gate; see
 * docs/superpowers/specs/2026-09-19-tp-dapp-design.md.
 *
 * `assetsDir` keeps each page's files apart: the console's in dist/assets/, the
 * dApp's in dist/dapp/assets/. The host gate serves the dApp host /dapp/assets/*
 * only, so the console page's bundle is never public on the password-less dApp host.
 */
export function pageConfig(input, { emptyOutDir, assetsDir = 'assets' }) {
  return defineConfig({
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
    // `rolldownOptions` is Vite 8's name; `rollupOptions` is its deprecated alias
    // (node_modules/vite/dist/node/index.d.ts:2170-2178).
    build: {
      outDir: 'dist',
      emptyOutDir,
      assetsDir,
      rolldownOptions: { input },
    },
  });
}

// In dev the console runs on :5173 (the dApp at /dapp/) and the API on :3100, so
// /api is proxied. In production `npm run build` emits dist/ and the backend
// serves it, keeping the whole thing one origin behind one nginx block.
export default pageConfig({ main: CONSOLE_ENTRY }, { emptyOutDir: true });
