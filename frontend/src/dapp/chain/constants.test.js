import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import * as C from './constants.js';

// Test-only reach into the backend: the browser bundle pins its own copy of every
// address, and this is the check that the copy equals the server's.
const require = createRequire(import.meta.url);
const backend = require('../../../../backend/src/tp/constants.js');
const config = require('../../../../backend/src/config.js');

const SHARED = [
  'CHAIN_ID',
  'PONS_V2_FACTORY',
  'PONS_V1_FACTORY',
  'MULTICALL3',
  'POOL_MANAGER',
  'STATE_VIEW',
  'V4_QUOTER',
  'UNIVERSAL_ROUTER',
  'PERMIT2',
  'SWAP_ROUTER02',
  'QUOTER_V2',
  'WETH',
  'USDG',
  'WETH_USDG_FEE',
  'NATIVE',
];

// Compared with the backend as CONFIGURED: if the server's env overrides one of
// these addresses, this fails on purpose — the pinned bundle must follow.
test('every pinned constant equals backend/src/tp/constants.js', () => {
  for (const key of SHARED) {
    const mine = C[key];
    const theirs = backend[key];
    assert.notEqual(mine, undefined, `${key} is missing from chain/constants.js`);
    const norm = (v) => (typeof v === 'string' ? v.toLowerCase() : Number(v));
    assert.equal(norm(mine), norm(theirs), `${key} differs from the backend`);
  }
});

test('addresses are lower-case 20-byte hex and match the config defaults', () => {
  for (const key of SHARED) {
    if (typeof C[key] !== 'string') continue;
    assert.match(C[key], /^0x[0-9a-f]{40}$/, `${key} must be lower-case hex`);
  }
  assert.equal(C.PONS_V2_FACTORY, config.v2FactoryAddress);
  assert.equal(C.PONS_V1_FACTORY, config.factoryAddress);
  assert.equal(C.SWAP_ROUTER02, config.v3Route.swapRouter);
  assert.equal(C.PERMIT2, config.letscash.permit2);
  assert.equal(C.UNIVERSAL_ROUTER, config.letscash.universalRouter);
  assert.equal(C.WETH, config.v3Route.weth);
  assert.equal(C.USDG, config.v3Route.usdg);
  assert.equal(C.WETH_USDG_FEE, config.v3Route.wethUsdgFee);
  assert.equal(C.MAX_ROUTE_IMPACT_BPS, config.v3Route.maxImpactBps);
  assert.equal(C.CHAIN_ID, config.chainId);
});
