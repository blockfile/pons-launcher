'use strict';

// swapBundleToPair has each bundle wallet swap its OWN ETH → SPCX through the
// deployed router, so the dev wallet never touches the bundle. It moves real ETH,
// so these assert the safety properties:
//   - every swap is SIMULATED first; a wallet whose simulation reverts or returns
//     0 (empty pool) is SKIPPED, never sent — no ETH into a dead pool;
//   - the sent swap carries minOut = expected − slippage, value = the spendable
//     balance, recipient = the wallet itself;
//   - an underfunded wallet is skipped, not sent;
//   - a non-SPCX pair, or a missing router, is refused up front;
//   - one wallet's failure never aborts the others.
//
// Nothing here touches a chain: provider (balance/call/broadcast), keystore, fees,
// economics, symbol, token balance and receipt are all injected.

const test = require('node:test');
const assert = require('node:assert');
const { getAddress, AbiCoder, Interface } = require('ethers');
const { swapBundleToPair } = require('./swapToPair');

const IFACE = new Interface([
  'function swapExactEthForSpcx(uint256 minSpcxOut, address recipient) payable returns (uint256)',
]);
const CODER = new AbiCoder();

const ROUTER = getAddress('0x' + '11'.repeat(20));
const SPCX = getAddress('0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa');
const WA = getAddress('0x' + 'aa'.repeat(20));
const WB = getAddress('0x' + 'bb'.repeat(20));

const bundle = [
  { id: 'a', address: WA, role: 'bundle' },
  { id: 'b', address: WB, role: 'bundle' },
];

function fakeKeystore(signed) {
  return {
    bundleWallets: () => bundle,
    signer: (id) => ({
      async signTransaction(tx) {
        signed.push({ id, tx });
        return `SIGNED:${id}:${tx.nonce}`;
      },
    }),
  };
}

// eth: per-address wei balance. sim: per-address SPCX out for the simulation, or
// the string 'revert' to make the simulation throw (empty pool). tokenAfter: SPCX
// balance a confirmed wallet ends with (its delta = received).
function fakeProvider({ eth = {}, sim = {}, order = [], tokenAfter = {} } = {}) {
  const balCalls = {};
  return {
    order,
    _tokenAfter: tokenAfter,
    _balCalls: balCalls,
    async getBalance(addr) {
      return eth[getAddress(addr)] ?? 0n;
    },
    async call({ from }) {
      const v = sim[getAddress(from)];
      if (v === 'revert' || v === undefined) throw new Error('execution reverted');
      return CODER.encode(['uint256'], [v]);
    },
    async getTransactionCount() {
      return 7;
    },
    async getCode() {
      return '0x60006000'; // router has code
    },
    async broadcastTransaction(raw) {
      order.push(raw);
      return { hash: `hash:${raw}` };
    },
  };
}

// Token balance: 0 before the swap, `tokenAfter[addr]` after — so the confirmed
// delta is the received SPCX.
function balancesReader(provider) {
  const seen = {};
  return async (_token, addr) => {
    const a = getAddress(addr);
    seen[a] = (seen[a] || 0) + 1;
    return seen[a] === 1 ? 0n : provider._tokenAfter[a] ?? 0n;
  };
}

const baseDeps = (provider, over = {}) => ({
  provider,
  router: ROUTER,
  getFees: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
  pairEconomics: async () => ({ decimals: 18 }),
  getSymbol: async () => 'SPCX',
  readTokenBalance: balancesReader(provider),
  waitForReceipt: async () => ({ status: 1, blockNumber: 42 }),
  ...over,
});

const decodeSwap = (tx) => {
  const [minOut, recipient] = IFACE.decodeFunctionData('swapExactEthForSpcx', tx.data);
  return { minOut, recipient: getAddress(recipient), value: BigInt(tx.value) };
};

test('simulates then swaps each funded wallet, minOut = expected − slippage, to itself', async () => {
  const signed = [];
  const rpc = fakeProvider({
    eth: { [WA]: 10n ** 17n, [WB]: 10n ** 17n }, // 0.1 ETH each
    sim: { [WA]: 2n * 10n ** 18n, [WB]: 3n * 10n ** 18n }, // pool quotes 2 / 3 SPCX
    tokenAfter: { [WA]: 2n * 10n ** 18n, [WB]: 3n * 10n ** 18n },
  });
  const res = await swapBundleToPair({ pairToken: SPCX }, baseDeps(rpc, { keystore: fakeKeystore(signed) }));

  assert.equal(res.confirmed, 2);
  assert.equal(res.skipped, 0);
  assert.equal(signed.length, 2);

  const a = decodeSwap(signed.find((s) => s.id === 'a').tx);
  assert.equal(a.recipient, WA, 'the SPCX recipient is the wallet itself');
  // minOut = 2e18 * (10000-300)/10000 = 1.94e18
  assert.equal(a.minOut, (2n * 10n ** 18n * 9700n) / 10000n);
  // value swapped = balance − reserve, so strictly positive and below the balance
  assert.ok(a.value > 0n && a.value < 10n ** 17n, 'swaps balance minus the gas reserve');

  const resA = res.swaps.find((s) => s.walletId === 'a');
  assert.equal(resA.received, '2.0', 'received is the SPCX balance delta');
});

test('a wallet whose simulation reverts (empty pool) is SKIPPED, never sent', async () => {
  const signed = [];
  const rpc = fakeProvider({
    eth: { [WA]: 10n ** 17n, [WB]: 10n ** 17n },
    sim: { [WA]: 'revert', [WB]: 2n * 10n ** 18n }, // A's pool leg reverts
    tokenAfter: { [WB]: 2n * 10n ** 18n },
  });
  const res = await swapBundleToPair({ pairToken: SPCX }, baseDeps(rpc, { keystore: fakeKeystore(signed) }));

  const a = res.swaps.find((s) => s.walletId === 'a');
  const b = res.swaps.find((s) => s.walletId === 'b');
  assert.equal(a.status, 'skipped');
  assert.match(a.reason, /no route\/liquidity/);
  assert.equal(b.status, 'confirmed');
  assert.equal(signed.length, 1, 'only the wallet with a live route was signed');
  assert.equal(signed[0].id, 'b');
});

test('a simulation that returns 0 SPCX is skipped (no liquidity), not sent', async () => {
  const signed = [];
  const rpc = fakeProvider({ eth: { [WA]: 10n ** 17n }, sim: { [WA]: 0n } });
  const res = await swapBundleToPair(
    { pairToken: SPCX, walletIds: ['a'] },
    baseDeps(rpc, { keystore: fakeKeystore(signed) })
  );
  assert.equal(res.swaps[0].status, 'skipped');
  assert.match(res.swaps[0].reason, /no SPCX|no liquidity/);
  assert.equal(signed.length, 0);
});

test('an underfunded wallet is skipped before any simulation or send', async () => {
  const signed = [];
  const rpc = fakeProvider({ eth: { [WA]: 1n }, sim: { [WA]: 2n * 10n ** 18n } });
  const res = await swapBundleToPair(
    { pairToken: SPCX, walletIds: ['a'] },
    baseDeps(rpc, { keystore: fakeKeystore(signed) })
  );
  assert.equal(res.swaps[0].status, 'skipped');
  assert.match(res.swaps[0].reason, /does not cover/);
  assert.equal(signed.length, 0);
});

test('a dry run simulates every wallet but signs and broadcasts nothing', async () => {
  const signed = [];
  const rpc = fakeProvider({
    eth: { [WA]: 10n ** 17n, [WB]: 10n ** 17n },
    sim: { [WA]: 2n * 10n ** 18n, [WB]: 2n * 10n ** 18n },
  });
  const res = await swapBundleToPair(
    { pairToken: SPCX, dryRun: true },
    baseDeps(rpc, { keystore: fakeKeystore(signed) })
  );
  assert.equal(res.dryRun, true);
  assert.ok(res.swaps.every((s) => s.status === 'planned'));
  assert.ok(res.swaps.every((s) => s.expected === '2.0'));
  assert.equal(signed.length, 0, 'a dry run signs nothing');
  assert.equal(rpc.order.length, 0, 'a dry run broadcasts nothing');
});

test('refuses a launch paired against a non-SPCX token', async () => {
  const rpc = fakeProvider({ eth: { [WA]: 10n ** 17n } });
  await assert.rejects(
    () =>
      swapBundleToPair(
        { pairToken: getAddress('0x' + '99'.repeat(20)) },
        baseDeps(rpc, { keystore: fakeKeystore([]) })
      ),
    /only swaps to SPCX/
  );
});

test('refuses when the router is not deployed', async () => {
  const rpc = fakeProvider({ eth: { [WA]: 10n ** 17n } });
  await assert.rejects(
    () => swapBundleToPair({ pairToken: SPCX }, baseDeps(rpc, { keystore: fakeKeystore([]), router: null })),
    /router is not deployed/
  );
});

test('an explicit walletId that is not a bundle wallet is refused', async () => {
  const rpc = fakeProvider({ eth: { [WA]: 10n ** 17n } });
  await assert.rejects(
    () => swapBundleToPair({ pairToken: SPCX, walletIds: ['ghost'] }, baseDeps(rpc, { keystore: fakeKeystore([]) })),
    /ghost is not a v1 bundle wallet/
  );
});

test('refuses an out-of-range slippage that would disable the on-chain floor', async () => {
  const rpc = fakeProvider({ eth: { [WA]: 10n ** 17n }, sim: { [WA]: 2n * 10n ** 18n } });
  await assert.rejects(
    () => swapBundleToPair({ pairToken: SPCX, slippageBps: 10000 }, baseDeps(rpc, { keystore: fakeKeystore([]) })),
    /slippageBps must be an integer in \[0, 10000\)/
  );
});

test('refuses a router address that has no contract code', async () => {
  const signed = [];
  const rpc = fakeProvider({ eth: { [WA]: 10n ** 17n }, sim: { [WA]: 2n * 10n ** 18n } });
  rpc.getCode = async () => '0x'; // misconfigured router
  await assert.rejects(
    () => swapBundleToPair({ pairToken: SPCX }, baseDeps(rpc, { keystore: fakeKeystore(signed) })),
    /router .* has no contract code/
  );
  assert.equal(signed.length, 0, 'nothing is signed when the router is not a contract');
});

test('the optional standing-rate floor skips a wallet the pool would fill below it', async () => {
  const signed = [];
  // 0.1 ETH → only 0.2 SPCX = ~2 SPCX/ETH; floor of 5 SPCX/ETH rejects it.
  const rpc = fakeProvider({ eth: { [WA]: 10n ** 17n }, sim: { [WA]: 2n * 10n ** 17n } });
  const res = await swapBundleToPair(
    { pairToken: SPCX, walletIds: ['a'] },
    baseDeps(rpc, { keystore: fakeKeystore(signed), minSpcxPerEth: 5 })
  );
  assert.equal(res.swaps[0].status, 'skipped');
  assert.match(res.swaps[0].reason, /below the floor/);
  assert.equal(signed.length, 0, 'no ETH is dumped into a thin/mispriced pool');
});
