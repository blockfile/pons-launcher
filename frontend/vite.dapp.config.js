// The take-profit dApp's build: the second half of `npm run build`, after the
// console's (vite.config.js explains why the two pages build separately). It adds
// dist/dapp/index.html and its own chunks to dist/assets/ without emptying dist/.
import { DAPP_ENTRY, pageConfig } from './vite.config.js';

export default pageConfig({ dapp: DAPP_ENTRY }, { emptyOutDir: false });
