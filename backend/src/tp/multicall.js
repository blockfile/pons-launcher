'use strict';

// One Multicall3 aggregate3 request per chunk of reads, allowFailure on every
// call, so a token that reverts on one getter costs itself a field and never
// the whole batch.
//
// Copied (tab isolation — never imported) from:
//   evm/v2/holdings.js:90      the 250-call chunk
//   evm/v2/holdings.js:124-141 multicall(): chunk, allowFailure true, positional slots
//   evm/v2/holdings.js:143-151 decodeOr(): a failed or empty slot decodes to null
// The aggregate3 / getEthBalance fragments are constants.ABI.MULTICALL3 (Task 1,
// from evm/erc20.js:50-56).
//
// Sent through provider.call() rather than an ethers Contract so a test's fake
// provider only has to answer call({to, data}) — see test-helpers/fakeChain.js.

const { Interface } = require('ethers');
const C = require('./constants');

const mcIface = new Interface(C.ABI.MULTICALL3);

// Same ceiling holdings.js chunks at: keeps one request bounded.
const MULTICALL_CHUNK = 250;

/**
 * @param {{call: Function}} provider
 * @param {Array<{target: string, callData: string}>} calls
 * @param {{blockTag?: number|string}} [opts] read every chunk at this block
 * @returns {Promise<Array<{success: boolean, returnData: string}>>} positional
 */
async function aggregate3(provider, calls, opts = {}) {
  if (!Array.isArray(calls) || !calls.length) return [];
  const to = String(C.MULTICALL3).toLowerCase();
  const out = [];
  for (let i = 0; i < calls.length; i += MULTICALL_CHUNK) {
    const slice = calls.slice(i, i + MULTICALL_CHUNK);
    const data = mcIface.encodeFunctionData('aggregate3', [
      slice.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData })),
    ]);
    const request = { to, data };
    if (opts.blockTag != null) request.blockTag = opts.blockTag;
    const raw = await provider.call(request);
    const [results] = mcIface.decodeFunctionResult('aggregate3', raw);
    for (const r of results) out.push({ success: Boolean(r[0]), returnData: r[1] });
  }
  return out;
}

/** The decoded Result of one slot, or null when the call failed or returned nothing. */
function decodeSlot(iface, name, slot) {
  if (!slot || !slot.success || !slot.returnData || slot.returnData === '0x') return null;
  try {
    return iface.decodeFunctionResult(name, slot.returnData);
  } catch (_err) {
    return null;
  }
}

/** The first return value of one slot, or null. */
function one(iface, name, slot) {
  const r = decodeSlot(iface, name, slot);
  return r == null ? null : r[0];
}

module.exports = { aggregate3, decodeSlot, one, mcIface, MULTICALL_CHUNK };
