/**
 * The real wiring for session.js. Tests build their own deps from fakes; the
 * page uses this one. The only door to a key is walletStore.signTx, which
 * returns a signed raw transaction — nothing here can read a key.
 */
import { keccak256 } from 'ethers';
import * as api from '../api.js';
import { signTx, addresses } from '../keys/walletStore.js';
import { planArm, planSell } from '../chain/plan.js';
import { approveTx, pairToEthTx } from '../chain/build.js';
import { NonceBook } from '../chain/nonces.js';
import { SWAP_ROUTER02 } from '../chain/constants.js';

export const realDeps = {
  api,
  store: { signTx, addresses },
  planArm,
  planSell,
  approveTx,
  pairToEthTx,
  NonceBook,
  swapRouter: SWAP_ROUTER02,
  hashOf: (raw) => keccak256(raw),
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  isHidden: () => typeof document !== 'undefined' && document.hidden === true,
};
