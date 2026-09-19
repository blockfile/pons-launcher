/**
 * The real wiring for session.js. Tests build their own deps from fakes; the
 * page uses this one. The only door to a key is walletStore.signTx, which
 * returns a signed raw transaction — nothing here can read a key.
 */
import { id, keccak256 } from 'ethers';
import * as api from '../api.js';
import { signTx, addresses } from '../keys/walletStore.js';
import { hasVault } from '../keys/vault.js';
import { planArm, planSell } from '../chain/plan.js';
import { approveTx, pairToEthTx } from '../chain/build.js';
import { NonceBook } from '../chain/nonces.js';
import { SWAP_ROUTER02 } from '../chain/constants.js';
import { createPairLedger } from './pairLedger.js';
import { createPositionBook } from './positions.js';

function localStore() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null; // a sandboxed or private window can throw on the mere access
  }
}

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
  // Unconverted pair proceeds across a token switch — and across a reload only for
  // a visitor who chose to remember wallets on this device (its entries can be
  // linked to the wallets: see pairLedger.js). App wipes it on Clear and Forget.
  pairLedger: createPairLedger({ storage: localStore(), hash: id, persist: hasVault }),
  // Each wallet's starting size per token, for the %-left bar (positions.js): the
  // same device rule as pairLedger — on the device only with Remember; App
  // connects it to the account over the hub and wipes it on Clear and Forget.
  positions: createPositionBook({ storage: localStore(), hash: id, persist: hasVault }),
};
