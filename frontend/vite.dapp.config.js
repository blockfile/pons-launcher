// The take-profit dApp's build: the second half of `npm run build`, after the
// console's (vite.config.js explains why the two pages build separately). It adds
// dist/dapp/index.html and its own chunks, CSS and fonts in dist/dapp/assets/ without
// emptying dist/. Its own folder, because the host gate (backend/src/tp/hostGate.js)
// serves the dApp host /dapp/assets/* and 404s the console's /assets/*.
import { DAPP_ENTRY, pageConfig } from './vite.config.js';

export default pageConfig({ dapp: DAPP_ENTRY }, { emptyOutDir: false, assetsDir: 'dapp/assets' });
