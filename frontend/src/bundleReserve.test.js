import test from 'node:test';
import assert from 'node:assert/strict';

import { SELL_RESERVE, buyGasReserve, perWalletReserve } from './bundleReserve.js';

// A /gas payload shaped like the live one that surfaced the bug. perGas is
// 0.000022 / 900000 ETH per gas — the value at which a 900k zap costs 0.000022
// ETH, exactly the "zap 0.005392 + gas + buffer" figures from the skipped run.
const PER_GAS = 0.000022 / 900000;
const gas = {
  buyGasEth: String(400_000 * PER_GAS), // a plain curve.buy — ~0.0000098 ETH
  sellGasEth: String(700_000 * PER_GAS), // approve + sell — ~0.0000171 ETH
  zapBuyGasEth: String(900_000 * PER_GAS), // the zap buy — 0.000022 ETH
  gasBufferEth: '0.0004', // config.gasBufferEth
};

const zapBuyGasEth = Number(gas.zapBuyGasEth);
const gasBufferEth = Number(gas.gasBufferEth);

// The backend's ethZap preflight, in ETH: prepareV2 skips a wallet when
// `balance < buy + zapBuyCost + buffer`, and zapBuyCost/buffer in ETH are
// exactly the zapBuyGasEth/gasBufferEth /gas returns.
const backendSkips = (balance, buy) => balance < buy + zapBuyGasEth + gasBufferEth;

test('non-zap reserve uses the plain buy gas', () => {
  assert.equal(buyGasReserve(gas, false), Number(gas.buyGasEth));
});

test('zap reserve uses zapBuyGasEth + gasBufferEth, not the plain buy gas', () => {
  assert.equal(buyGasReserve(gas, true), zapBuyGasEth + gasBufferEth);
  // And it is the zap cost, NOT the ~400k plain buy — the whole bug.
  assert.notEqual(buyGasReserve(gas, true), Number(gas.buyGasEth));
  assert.ok(buyGasReserve(gas, true) > buyGasReserve(gas, false));
});

test('only the buy portion changes with zap mode; the sell reserve is unchanged', () => {
  const sellPortion = SELL_RESERVE * Number(gas.sellGasEth);
  assert.equal(perWalletReserve(gas, false), Number(gas.buyGasEth) + sellPortion);
  assert.equal(perWalletReserve(gas, true), zapBuyGasEth + gasBufferEth + sellPortion);
});

test('missing fields size to no reserve rather than NaN', () => {
  assert.equal(buyGasReserve(null, false), 0);
  assert.equal(buyGasReserve(null, true), 0);
  assert.equal(perWalletReserve(undefined, true), 0);
});

// The worked example from the bug report: a seasoned wallet holding B ≈ 0.005579
// ETH. The auto-fill sizes buy = B − reserve; the backend then either funds it
// or skips it. Before the fix the reserve held back only a plain buy's gas, so
// the buy was too large and every wallet was skipped. After the fix it holds
// back the zap gas the backend actually charges, so the buy fits.
test('a 0.005579-ETH seasoned wallet is skipped with the old reserve but funded with the zap reserve', () => {
  const B = 0.005579;

  // Old (buggy) sizing: reserve = plain buy gas + sell gas.
  const buyOld = B - perWalletReserve(gas, false);
  assert.equal(backendSkips(B, buyOld), true); // short by ~0.0002 ETH — skipped

  // Fixed sizing: reserve swaps the buy portion to the zap cost + buffer.
  const buyZap = B - perWalletReserve(gas, true);
  assert.equal(backendSkips(B, buyZap), false); // fits — NOT skipped

  // The surviving headroom is exactly the 10-sell reserve, nothing wasted.
  const needs = buyZap + zapBuyGasEth + gasBufferEth;
  const margin = B - needs;
  assert.ok(Math.abs(margin - SELL_RESERVE * Number(gas.sellGasEth)) < 1e-12);
});
