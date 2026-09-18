'use strict';

// An offline chain for src/tp tests. NOT a test file (no .test.js suffix), so
// `npm test` never runs it on its own.
//
// call({to, data}) answers from a table keyed by (to, 4-byte selector). A call
// to Multicall3's aggregate3 is unwrapped: every inner call is answered from the
// same table, and an inner call with no entry, or whose handler throws, comes
// back as a failed slot — exactly what allowFailure does on chain. A direct
// call with no entry throws, like a revert.
//
// Handlers get the DECODED arguments (addresses come back EIP-55 checksummed)
// and return the array of return values, which the fake ABI-encodes.

const { Interface } = require('ethers');
const { MULTICALL3 } = require('../constants');

const mcIface = new Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
]);
const AGGREGATE3 = mcIface.getFunction('aggregate3').selector;

const lc = (a) => String(a).toLowerCase();

function fakeChain({ block = 5000, baseFee = 20000000n } = {}) {
  const table = new Map();
  const code = new Map();
  const nonces = new Map();
  const log = [];

  function answer(to, data, blockTag) {
    const key = `${lc(to)}:${String(data).slice(0, 10).toLowerCase()}`;
    const entry = table.get(key);
    if (!entry) {
      const err = new Error(`execution reverted (no fake for ${key})`);
      err.code = 'CALL_EXCEPTION';
      throw err;
    }
    const args = entry.iface.decodeFunctionData(entry.name, data);
    log.push({ to: lc(to), name: entry.name, args, blockTag });
    const values = entry.fn(args, { blockTag });
    return entry.iface.encodeFunctionResult(entry.name, values);
  }

  const provider = {
    async call(tx) {
      const to = lc(tx.to);
      if (to === lc(MULTICALL3) && String(tx.data).slice(0, 10) === AGGREGATE3) {
        const [calls] = mcIface.decodeFunctionData('aggregate3', tx.data);
        log.push({ to, name: 'aggregate3', count: calls.length, blockTag: tx.blockTag });
        const results = calls.map((c) => {
          try {
            return [true, answer(c[0], c[2], tx.blockTag)];
          } catch (_err) {
            return [false, '0x'];
          }
        });
        return mcIface.encodeFunctionResult('aggregate3', [results]);
      }
      return answer(to, tx.data, tx.blockTag);
    },
    async getCode(address) {
      log.push({ name: 'getCode', address: lc(address) });
      return code.get(lc(address)) || '0x';
    },
    async getBlockNumber() {
      return block;
    },
    async getBlock(tag) {
      log.push({ name: 'getBlock', tag });
      return { number: block, baseFeePerGas: baseFee };
    },
    async getTransactionCount(address, tag) {
      log.push({ name: 'getTransactionCount', address: lc(address), tag });
      const n = nonces.get(lc(address));
      if (n instanceof Error) throw n;
      return n == null ? 0 : n;
    },
  };

  const api = {
    provider,
    log,
    /** Answer `signature` (one human-readable function) at `to` with fn(args) -> values[]. */
    on(to, signature, fn) {
      const iface = new Interface([signature]);
      const frag = iface.fragments[0];
      table.set(`${lc(to)}:${frag.selector}`, { iface, name: frag.name, fn });
      return api;
    },
    setCode(address, hex = '0x6080') {
      code.set(lc(address), hex);
      return api;
    },
    setNonce(address, n) {
      nonces.set(lc(address), n);
      return api;
    },
    /** How many answered calls were named `name` (optionally only those sent to `to`). */
    count(name, to) {
      return log.filter((l) => l.name === name && (to == null || l.to === lc(to))).length;
    },
  };
  return api;
}

module.exports = { fakeChain };
