'use strict';

// Unit tests for the v5 per-wallet BUY money path (the V1-style bundle). Fully
// offline: the swap client, keystore signer, and provider are injected.

const test = require('node:test');
const assert = require('node:assert');
const { getAddress, parseEther } = require('ethers');

const { prepareBundleBuys, fireBundleBuys } = require('./buy');

const TOKEN = getAddress('0x4F0d7ea112547Af5dAD59959d98B6A8ee3355Bcc');
const HOOK = getAddress('0xEfe669814e5Eec33406Bd50ffa8331618D076aEc');
const ROUTER = getAddress('0x8876789976decbfcbbbe364623c63652db8c0904');
const PID = '0x' + 'ab'.repeat(32);
const B = (n) => getAddress('0x' + String(n).repeat(40).slice(0, 40));
const WALLETS = [
  { id: 'b1', address: B(2), role: 'v5bundle' },
  { id: 'b2', address: B(3), role: 'v5bundle' },
  { id: 'b3', address: B(4), role: 'v5bundle' },
];

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
    quoteBuy: over.quoteBuy || (async ({ amountInWei }) => ({ expectedOut: BigInt(amountInWei) * 1000n, minOut: BigInt(amountInWei) * 990n })),
    buildBuyTx: over.buildBuyTx || (({ amountInWei }) => ({ to: ROUTER, data: '0xbuy', value: BigInt(amountInWei) })),
  };
}

function fakeProvider(over = {}) {
  const p = { broadcasts: [] };
  p.getBalance = over.getBalance || (async () => 10n ** 18n); // 1 ETH
  p.getTransactionCount = over.getTransactionCount || (async (_a, _t) => 4);
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
  return {
    ks,
    provider,
    deps: {
      keystore: ks,
      provider,
      swap: fakeSwap(over.swap),
      getFees: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
      getDecimals: async () => 18,
      getSymbol: async () => 'CAT',
      deadline: 1_800_000_000,
      sleep: async () => {}, // no real delay in the pool-resolve retry under test
      ...(over.deps || {}),
    },
  };
}

const BUYS = [
  { walletId: 'b1', amountEth: '0.01' },
  { walletId: 'b2', amountEth: '0.02' },
];

// ── prepareBundleBuys ─────────────────────────────────────────────────────────
test('signs one buy per named wallet, value = the ETH in, against the pinned pool', async () => {
  const { deps: d, ks } = deps();
  const plan = await prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: BUYS }, d);
  assert.equal(plan.walletCount, 2);
  assert.equal(plan.hook, HOOK);
  assert.equal(ks.signables.length, 2, 'one signed buy per wallet');
  const b1 = plan.buys.find((b) => b.walletId === 'b1');
  assert.equal(b1.ethIn, '0.01');
  const s1 = ks.signables.find((s) => s.id === 'b1');
  assert.equal(getAddress(s1.to), ROUTER, 'the buy targets the router');
  assert.equal(s1.value, parseEther('0.01'), 'a native buy rides the ETH as msg.value');
  assert.ok(b1.expectedTokens && b1.minOut, 'a quote + floor are attached');
});

test('a buy carries a positive floor and reports expected tokens (the tax shows in the quote)', async () => {
  const { deps: d } = deps();
  const plan = await prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: BUYS, slippageBps: 200 }, d);
  const b = plan.buys[0];
  assert.ok(BigInt(b.minOut) > 0n, 'buildBuyTx would refuse a zero floor — the plan always has one');
  assert.equal(plan.totalEth, '0.03');
});

test('a wallet short of ETH for the buy + gas is skipped, not signed', async () => {
  const { deps: d, ks } = deps({
    provider: { getBalance: async (addr) => (getAddress(addr) === WALLETS[0].address ? 1n : 10n ** 18n) },
  });
  const plan = await prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: BUYS }, d);
  assert.equal(plan.walletCount, 1);
  assert.ok(plan.skipped.some((s) => s.walletId === 'b1' && /needs/.test(s.reason)));
  assert.equal(ks.signCalls.length, 1);
});

test("mode 'all' buys the whole balance minus the gas reserve", async () => {
  const { deps: d, ks } = deps();
  const plan = await prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: [{ walletId: 'b1', mode: 'all' }] }, d);
  assert.equal(plan.walletCount, 1);
  const s1 = ks.signables.find((s) => s.id === 'b1');
  const gasReserve = 500_000n * 1_000_000_000n; // buyGas × maxFeePerGas from the fakes
  assert.equal(s1.value, 10n ** 18n - gasReserve, "an 'all' buy spends balance − gas reserve");
});

test("mode 'all' skips a wallet too poor to cover its own gas", async () => {
  const { deps: d } = deps({ provider: { getBalance: async () => 1n } }); // 1 wei — under the reserve
  await assert.rejects(
    () => prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: [{ walletId: 'b1', mode: 'all' }] }, d),
    /no wallet could be prepared/
  );
});

test("mode 'all' skips a wallet whose tiny residual quotes to zero output — never signs a floorless buy", async () => {
  const gasReserve = 500_000n * 1_000_000_000n; // buyGas × maxFeePerGas from the fakes
  const { deps: d, ks } = deps({
    provider: { getBalance: async () => gasReserve + 100n }, // 100 wei left to buy after gas
    swap: { quoteBuy: async () => ({ expectedOut: 0n, minOut: 0n }) }, // dust buys nothing
  });
  await assert.rejects(
    () => prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: [{ walletId: 'b1', mode: 'all' }] }, d),
    /no wallet could be prepared/
  );
  assert.equal(ks.signCalls.length, 0, 'a zero-output buy is never signed');
});

test('skips a wallet with an unconfirmed tx in flight', async () => {
  const { deps: d } = deps({
    provider: {
      getTransactionCount: async (addr, tag) =>
        getAddress(addr) === WALLETS[1].address ? (tag === 'pending' ? 6 : 5) : 4,
    },
  });
  const plan = await prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: BUYS }, d);
  assert.equal(plan.walletCount, 1);
  assert.ok(plan.skipped.some((s) => s.walletId === 'b2' && /in flight/.test(s.reason)));
});

test('requires a verified hook, refuses a non-ETH quote, and rejects a bad token', async () => {
  const { deps: d } = deps();
  await assert.rejects(() => prepareBundleBuys({ token: TOKEN, buys: BUYS }, d), /verified pool hook is required/);
  await assert.rejects(() => prepareBundleBuys({ token: TOKEN, hook: HOOK, quote: 'usdg', buys: BUYS }, d), /ETH-only/);
  await assert.rejects(() => prepareBundleBuys({ token: 'nope', hook: HOOK, buys: BUYS }, d), /launched ERC-20/);
});

test('refuses when no wallet has a positive buy amount', async () => {
  const { deps: d } = deps();
  await assert.rejects(
    () => prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: [{ walletId: 'b1', amountEth: '0' }] }, d),
    /no wallet has a positive buy/
  );
});

test('refuses a buys entry naming a wallet not in the bundle, or twice', async () => {
  const { deps: d } = deps();
  await assert.rejects(() => prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: [{ walletId: 'nope', amountEth: '1' }] }, d), /not one of this tab's bundle/);
  await assert.rejects(
    () => prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: [{ walletId: 'b1', amountEth: '1' }, { walletId: 'b1', amountEth: '1' }] }, d),
    /more than once/
  );
});

test('the buy signs the default 500k gas, and a bounded buyGas override raises it / clamps / caps', async () => {
  const { deps: d, ks } = deps();
  await prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: BUYS }, d);
  assert.ok(ks.signables.every((s) => s.gasLimit === 500_000n), 'default buy gas is 500k');

  const { deps: d2, ks: ks2 } = deps();
  await prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: BUYS, buyGas: 1_200_000 }, d2);
  assert.ok(ks2.signables.every((s) => s.gasLimit === 1_200_000n), 'a valid override reaches the signed buys');

  const { deps: d3, ks: ks3 } = deps();
  await prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: BUYS, buyGas: 100_000 }, d3); // below floor
  assert.ok(ks3.signables.every((s) => s.gasLimit === 500_000n), 'never below the safe floor');

  const { deps: d4 } = deps();
  await assert.rejects(() => prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: BUYS, buyGas: 5_000_000 }, d4), /capped at 3,000,000/);
});

test('prepareBundleBuys broadcasts nothing', async () => {
  const { deps: d, provider } = deps();
  await prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: BUYS }, d);
  assert.equal(provider.broadcasts.length, 0);
});

test('refuses when there is no live pool after all retries (buying before launch)', async () => {
  const { deps: d } = deps({
    swap: { resolvePoolKey: async () => { throw new Error('No initialised letscash pool'); } },
  });
  await assert.rejects(() => prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: BUYS }, d), /No initialised letscash pool/);
});

test('retries pool resolution when the pool is still propagating right after launch', async () => {
  let calls = 0;
  const { deps: d } = deps({
    swap: {
      resolvePoolKey: async () => {
        calls += 1;
        // First read misses (RPC node a block behind); the pool resolves on retry.
        if (calls < 2) throw new Error('No initialised letscash pool');
        return { poolKey: { currency0: '0x00', currency1: TOKEN, fee: 0, tickSpacing: 200, hooks: HOOK }, hook: HOOK, poolId: PID, liquidity: 10n ** 20n };
      },
    },
  });
  const plan = await prepareBundleBuys({ token: TOKEN, hook: HOOK, buys: BUYS }, d);
  assert.equal(calls, 2, 'the still-propagating miss was retried, then it resolved');
  assert.ok(plan.walletCount >= 1, 'the bundle prepares once the pool is readable');
});

// ── fireBundleBuys ────────────────────────────────────────────────────────────
function buyPlan(buys) {
  return { protocol: 'v5', kind: 'bundle-buy', token: TOKEN, symbol: 'CAT', buys };
}

test('fireBundleBuys broadcasts every buy and tallies confirmed', async () => {
  const provider = fakeProvider();
  const res = await fireBundleBuys(
    buyPlan([
      { walletId: 'b1', address: B(2), ethIn: '0.01', raw: '0xr1' },
      { walletId: 'b2', address: B(3), ethIn: '0.02', raw: '0xr2' },
    ]),
    { provider, dryRun: false, warmPool: async () => {}, waitForReceipt: (rpc, h) => rpc.getTransactionReceipt(h) }
  );
  assert.equal(provider.broadcasts.length, 2);
  assert.equal(res.bought, 2);
  assert.equal(res.failed, 0);
});

test('fireBundleBuys counts a reverted buy as failed and a send-failed as failed', async () => {
  const provider = fakeProvider({
    broadcastTransaction: async (raw) => {
      if (raw === '0xr1') throw new Error('nonce too low');
      return { hash: `hash:${raw}` };
    },
    getTransactionReceipt: async (h) => ({ status: h === 'hash:0xr2' ? 0 : 1, blockNumber: 9 }),
  });
  const res = await fireBundleBuys(
    buyPlan([
      { walletId: 'b1', address: B(2), ethIn: '0.01', raw: '0xr1' },
      { walletId: 'b2', address: B(3), ethIn: '0.02', raw: '0xr2' },
    ]),
    { provider, dryRun: false, warmPool: async () => {}, waitForReceipt: (rpc, h) => rpc.getTransactionReceipt(h) }
  );
  assert.equal(res.bought, 0);
  assert.equal(res.failed, 2, 'one send-failed + one reverted');
  assert.equal(res.buys.find((b) => b.walletId === 'b1').status, 'send-failed');
});

test('a dry run broadcasts nothing', async () => {
  const provider = fakeProvider();
  const res = await fireBundleBuys(buyPlan([{ walletId: 'b1', address: B(2), ethIn: '0.01', raw: '0xr1' }]), {
    provider,
    dryRun: true,
    warmPool: async () => {},
  });
  assert.equal(provider.broadcasts.length, 0);
  assert.equal(res.simulated, true);
});

test('fireBundleBuys refuses an unsigned or non-buy plan', async () => {
  await assert.rejects(
    () => fireBundleBuys(buyPlan([{ walletId: 'b1', address: B(2), ethIn: '0.01' }]), { provider: fakeProvider(), dryRun: false, warmPool: async () => {} }),
    /unsigned buys/
  );
  await assert.rejects(() => fireBundleBuys({ kind: 'sell' }, { provider: fakeProvider(), dryRun: false }), /not a v5 bundle-buy plan/);
});
