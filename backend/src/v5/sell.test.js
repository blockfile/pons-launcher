'use strict';

// Unit tests for the v5 (letscash) SELL / exit money path. Fully offline: the
// swap client, the keystore signer, the provider, and the token reads are all
// injected. Nothing touches a chain.
//
// The load-bearing guarantees:
//   * the pool is RESOLVED against the chain once, and every sell is built against
//     that verified poolKey (never a config hook).
//   * each seller signs TWO approvals then the sell at CONSECUTIVE nonces.
//   * NO slippage floor by default (minOut 0); a slippageBps applies one.
//   * a wallet holding none, or too short of gas, is skipped — not signed.
//   * fireSell broadcasts approvals-before-sell per wallet and tallies the result.

const test = require('node:test');
const assert = require('node:assert');
const { getAddress } = require('ethers');

const { prepareSell, fireSell } = require('./sell');

const TOKEN = getAddress('0x4F0d7ea112547Af5dAD59959d98B6A8ee3355Bcc');
const HOOK = getAddress('0xEfe669814e5Eec33406Bd50ffa8331618D076aEc');
const ROUTER = getAddress('0x8876789976decbfcbbbe364623c63652db8c0904');
const PERMIT2 = getAddress('0x000000000022d473030f116ddee9f6b43ac78ba3');
const PID = '0x' + 'ab'.repeat(32);
const B = (n) => getAddress('0x' + String(n).repeat(40).slice(0, 40));
const WALLETS = [
  { id: 'b1', address: B(2), role: 'v5bundle' },
  { id: 'b2', address: B(3), role: 'v5bundle' },
  { id: 'b3', address: B(4), role: 'v5bundle' },
];

// Every wallet holds 100 tokens by default; override per address.
function fakeKs(bundle = WALLETS) {
  const ks = { signables: [], signCalls: [] };
  ks.walletsWithRole = (r) => (r === 'v5bundle' ? bundle : []);
  ks.walletWithRole = () => null;
  ks.signer = (id) => {
    ks.signCalls.push(id);
    return {
      signTransaction: async (tx) => {
        ks.signables.push({ id, ...tx });
        return `0xSIGNED:${id}:${tx.nonce}`;
      },
    };
  };
  return ks;
}

function fakeSwap(over = {}) {
  return {
    resolvePoolKey:
      over.resolvePoolKey ||
      (async () => ({ poolKey: { currency0: '0x00', currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK }, hook: HOOK, poolId: PID, liquidity: 10n ** 20n })),
    quoteSell: over.quoteSell || (async ({ tokensInWei }) => ({ expectedOut: BigInt(tokensInWei) / 1000n, minOut: 0n })),
    applySlippage: over.applySlippage || ((out, bps) => (BigInt(out) * BigInt(10000 - bps)) / 10000n),
    buildSellTx:
      over.buildSellTx ||
      (({ minOut }) => ({
        to: ROUTER,
        data: '0xdeadbeef',
        value: 0n,
        _minOut: minOut,
        approvals: [
          { label: 'erc20-approve-permit2', to: TOKEN, data: '0xaaaa', value: 0n },
          { label: 'permit2-approve-router', to: PERMIT2, data: '0xbbbb', value: 0n },
        ],
      })),
  };
}

function fakeProvider(over = {}) {
  const p = { broadcasts: [] };
  p.getBalance = over.getBalance || (async () => 10n ** 18n); // 1 ETH gas
  p.getTransactionCount = over.getTransactionCount || (async () => 10);
  p.broadcastTransaction =
    over.broadcastTransaction ||
    (async (raw) => {
      p.broadcasts.push(raw);
      return { hash: `hash:${raw}` };
    });
  p.getTransactionReceipt = over.getTransactionReceipt || (async () => ({ status: 1, blockNumber: 9 }));
  return p;
}

function deps(over = {}, ks = fakeKs(over.bundle)) {
  const provider = fakeProvider(over.provider);
  const holdMap = over.holdings || {};
  return {
    ks,
    provider,
    swap: fakeSwap(over.swap),
    deps: {
      keystore: ks,
      provider,
      swap: fakeSwap(over.swap),
      getFees: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
      readTokenBalance: async (_t, owner) =>
        owner.toLowerCase() in holdMap ? holdMap[owner.toLowerCase()] : 100n * 10n ** 18n,
      getDecimals: async () => 18,
      getSymbol: async () => 'CAT',
      deadline: 1_800_000_000,
    },
  };
}

// ── prepareSell ───────────────────────────────────────────────────────────────
test('each holder signs two approvals then the sell at consecutive nonces', async () => {
  const { deps: d, ks } = deps();
  const plan = await prepareSell({ token: TOKEN, hook: HOOK },d);

  assert.equal(plan.walletCount, 3);
  assert.equal(plan.hook, HOOK, 'the sell is built against the resolved hook');
  // 3 wallets × (2 approvals + 1 sell) = 9 signed txs.
  assert.equal(ks.signables.length, 9);
  for (const w of plan.wallets) {
    assert.equal(w.approvals.length, 2);
    assert.deepEqual(
      [w.approvals[0].nonce, w.approvals[1].nonce, w.sell.nonce],
      [10, 11, 12],
      'approvals then sell at consecutive nonces'
    );
    assert.equal(w.approvals[0].label, 'erc20-approve-permit2');
    assert.equal(w.approvals[1].label, 'permit2-approve-router');
    assert.ok(w.sell.raw.startsWith('0xSIGNED'));
  }
});

test('the default sell has NO floor; a slippageBps applies one', async () => {
  const { deps: d } = deps();
  const noFloor = await prepareSell({ token: TOKEN, hook: HOOK },d);
  assert.equal(noFloor.wallets[0].sell.minOut, '0');
  assert.equal(noFloor.minOutFloor, '0 (no floor)');

  const withFloor = await prepareSell({ token: TOKEN, slippageBps: 300, hook: HOOK }, d);
  // expectedOut = 100e18/1000 = 1e17; floor = ×(1−3%) = 0.97e17.
  assert.equal(withFloor.wallets[0].sell.minOut, ((10n ** 17n * 9700n) / 10000n).toString());
  assert.equal(withFloor.minOutFloor, '300bps');
});

test('a wallet holding none of the token is skipped, not signed', async () => {
  const zero = {};
  zero[WALLETS[1].address.toLowerCase()] = 0n;
  const { deps: d, ks } = deps({ holdings: zero });
  const plan = await prepareSell({ token: TOKEN, hook: HOOK },d);
  assert.equal(plan.walletCount, 2, 'only the two holders are in the plan');
  assert.ok(plan.skipped.some((s) => s.walletId === 'b2' && /holds none/.test(s.reason)));
  assert.equal(ks.signables.length, 6, '2 holders × 3 txs');
});

test('a wallet too short of gas is skipped (a broadcast approval it cannot pay would strand the sell)', async () => {
  // b1 has almost no ETH; others have 1 ETH.
  const { deps: d } = deps({
    provider: {
      getBalance: async (addr) => (getAddress(addr) === WALLETS[0].address ? 1n : 10n ** 18n),
    },
  });
  const plan = await prepareSell({ token: TOKEN, hook: HOOK },d);
  assert.equal(plan.walletCount, 2);
  assert.ok(plan.skipped.some((s) => s.walletId === 'b1' && /does not cover/.test(s.reason)));
});

test('prepareSell resolves the pool once and refuses when there is no live pool', async () => {
  const { deps: d } = deps({
    swap: {
      resolvePoolKey: async () => {
        throw new Error('No initialised letscash pool for token');
      },
    },
  });
  await assert.rejects(() => prepareSell({ token: TOKEN, hook: HOOK },d), /No initialised letscash pool/);
});

test('prepareSell REFUSES without a verified hook — the decoy-pool guard', async () => {
  const { deps: d, ks } = deps();
  await assert.rejects(() => prepareSell({ token: TOKEN }, d), /verified pool hook is required/);
  await assert.rejects(() => prepareSell({ token: TOKEN, hook: 'not-an-address' }, d), /verified pool hook is required/);
  assert.equal(ks.signCalls.length, 0, 'nothing is signed without a pinned pool');
});

test('prepareSell accepts a USDG quote and denominates the estimate in USDG', async () => {
  // quoteSell returns 2_000_000 base units; with USDG decimals (6) that is 2.0 USDG.
  const { deps: d } = deps({ swap: { quoteSell: async () => ({ expectedOut: 2_000_000n, minOut: 0n }) } });
  d.getDecimals = async (addr) => (addr && addr.toLowerCase() === require('../config').letscash.usdg ? 6 : 18);
  const plan = await prepareSell({ token: TOKEN, hook: HOOK, quote: 'usdg' }, d);
  assert.equal(plan.quoteSymbol, 'USDG');
  assert.equal(plan.quoteIsNative, false);
  assert.equal(plan.wallets[0].estEthOut, '2.0', 'the estimate is denominated in USDG (6 dec), not ETH');
});

test('prepareSell refuses a quote that is neither ETH nor USDG', async () => {
  const { deps: d } = deps();
  await assert.rejects(
    () => prepareSell({ token: TOKEN, hook: HOOK, quote: '0x00000000000000000000000000000000000000ff' }, d),
    /ETH or USDG only/
  );
});

test('prepareSell refuses a bad token and an empty bundle and a no-holders case', async () => {
  const { deps: d } = deps();
  await assert.rejects(() => prepareSell({ token: 'nope' }, d), /launched ERC-20 address/);

  const { deps: empty } = deps({ bundle: [] });
  await assert.rejects(() => prepareSell({ token: TOKEN, hook: HOOK },empty), /no v5bundle wallets/);

  const allZero = Object.fromEntries(WALLETS.map((w) => [w.address.toLowerCase(), 0n]));
  const { deps: none } = deps({ holdings: allZero });
  await assert.rejects(() => prepareSell({ token: TOKEN, hook: HOOK },none), /nothing to sell/);
});

test('prepareSell skips a wallet with an unconfirmed tx in flight (would strand behind it)', async () => {
  // Wallet b2 has a pending tx (pending 11 > latest 10); it must be skipped, not
  // signed past. b1 and b3 (pending==latest) proceed.
  const { deps: d, ks } = deps({
    provider: {
      getTransactionCount: async (addr, tag) => {
        if (getAddress(addr) === WALLETS[1].address) return tag === 'pending' ? 11 : 10;
        return 10;
      },
    },
  });
  const plan = await prepareSell({ token: TOKEN, hook: HOOK }, d);
  assert.equal(plan.walletCount, 2, 'only the two settled wallets are in the plan');
  assert.ok(plan.skipped.some((s) => s.walletId === 'b2' && /in flight/.test(s.reason)));
  assert.equal(ks.signCalls.length, 2, 'the in-flight wallet is never signed');
});

test('prepareSell broadcasts nothing', async () => {
  const { deps: d, provider } = deps();
  await prepareSell({ token: TOKEN, hook: HOOK },d);
  assert.equal(provider.broadcasts.length, 0);
});

// ── fireSell ────────────────────────────────────────────────────────────────
function sellPlan(wallets) {
  return { protocol: 'v5', kind: 'sell', token: TOKEN, symbol: 'CAT', wallets };
}
function walletTxs(id, addr) {
  return {
    walletId: id,
    address: addr,
    tokens: '100',
    approvals: [
      { label: 'erc20-approve-permit2', nonce: 10, raw: `0xa1:${id}` },
      { label: 'permit2-approve-router', nonce: 11, raw: `0xa2:${id}` },
    ],
    sell: { nonce: 12, minOut: '0', raw: `0xsell:${id}` },
  };
}

test('fireSell broadcasts each wallet approvals-before-sell and tallies confirmed', async () => {
  const provider = fakeProvider();
  const res = await fireSell(sellPlan([walletTxs('b1', B(2)), walletTxs('b2', B(3))]), {
    provider,
    dryRun: false,
    warmPool: async () => {},
    waitForReceipt: (rpc, h) => rpc.getTransactionReceipt(h),
  });
  // 2 wallets × 3 broadcasts.
  assert.equal(provider.broadcasts.length, 6);
  // The sell of each wallet is broadcast AFTER its two approvals.
  assert.ok(provider.broadcasts.indexOf('0xsell:b1') > provider.broadcasts.indexOf('0xa2:b1'));
  assert.equal(res.sold, 2);
  assert.equal(res.failed, 0);
});

test('fireSell counts a reverted sell as failed and keeps going', async () => {
  let n = 0;
  const provider = fakeProvider({
    getTransactionReceipt: async () => {
      n += 1;
      return { status: n === 1 ? 0 : 1, blockNumber: 9 };
    },
  });
  const res = await fireSell(sellPlan([walletTxs('b1', B(2)), walletTxs('b2', B(3))]), {
    provider,
    dryRun: false,
    warmPool: async () => {},
    waitForReceipt: (rpc, h) => rpc.getTransactionReceipt(h),
  });
  assert.equal(res.sold, 1);
  assert.equal(res.failed, 1);
});

test('fireSell records a send-failed wallet without throwing the run', async () => {
  const provider = fakeProvider({
    broadcastTransaction: async (raw) => {
      if (raw === '0xa1:b1') throw new Error('nonce too low');
      return { hash: `hash:${raw}` };
    },
  });
  const res = await fireSell(sellPlan([walletTxs('b1', B(2)), walletTxs('b2', B(3))]), {
    provider,
    dryRun: false,
    warmPool: async () => {},
    waitForReceipt: (rpc, h) => rpc.getTransactionReceipt(h),
  });
  assert.equal(res.wallets.find((w) => w.walletId === 'b1').status, 'send-failed');
  assert.equal(res.sold, 1);
  assert.equal(res.failed, 1);
});

test('a dry run broadcasts nothing', async () => {
  const provider = fakeProvider();
  const res = await fireSell(sellPlan([walletTxs('b1', B(2))]), { provider, dryRun: true, warmPool: async () => {} });
  assert.equal(provider.broadcasts.length, 0);
  assert.equal(res.simulated, true);
});

test('fireSell refuses an unsigned or non-sell plan', async () => {
  await assert.rejects(
    () =>
      fireSell(sellPlan([{ walletId: 'b1', address: B(2), approvals: [{ raw: '0xa' }], sell: {} }]), {
        provider: fakeProvider(),
        dryRun: false,
        warmPool: async () => {},
      }),
    /unsigned transactions/
  );
  await assert.rejects(
    () => fireSell({ kind: 'bundle' }, { provider: fakeProvider(), dryRun: false }),
    /not a v5 sell plan/
  );
});
