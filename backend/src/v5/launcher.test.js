'use strict';

// Unit tests for v5 LAUNCHER RESCUE — withdraw value OUT of the launcher, and
// cancel/replace a stuck launcher tx. Fully offline (fake keystore/provider).

const test = require('node:test');
const assert = require('node:assert');
const { Interface, parseEther, getAddress } = require('ethers');

const { withdrawFromLauncher, cancelStuckLauncherTx, launcherStatus } = require('./launcher');
const config = require('../config');

const DEV = getAddress('0x' + '11'.repeat(20));
const EXT = getAddress('0x' + '22'.repeat(20));
const USDG = getAddress(config.letscash.usdg);
const erc20Iface = new Interface(['function transfer(address to, uint256 amount) returns (bool)']);

function fakeKs(dev = { id: 'dev', address: DEV, role: 'v5dev' }) {
  const ks = { signables: [], signCalls: [] };
  ks.walletWithRole = (r) => (r === 'v5dev' ? dev : null);
  ks.walletsWithRole = () => [];
  ks.signer = (id) => {
    ks.signCalls.push(id);
    return {
      signTransaction: async (tx) => {
        ks.signables.push(tx);
        return `0xSIGNED:${tx.nonce}`;
      },
    };
  };
  return ks;
}

function fakeProvider(over = {}) {
  const p = { broadcasts: [] };
  p.getBalance = over.getBalance || (async () => 10n ** 18n); // 1 ETH
  p.getTransactionCount = over.getTransactionCount || (async (_a, _t) => 5); // pending==latest by default
  p.broadcastTransaction =
    over.broadcastTransaction ||
    (async (raw) => {
      p.broadcasts.push(raw);
      return { hash: `hash:${raw}` };
    });
  p.getTransactionReceipt = over.getTransactionReceipt || (async () => ({ status: 1, blockNumber: 7 }));
  return p;
}

function baseDeps(over = {}, ks = fakeKs(), provider = fakeProvider(over.provider)) {
  return {
    ks,
    provider,
    deps: {
      keystore: ks,
      provider,
      dryRun: false,
      getFees: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
      getDecimals: async () => (over.decimals ?? 6),
      getSymbol: async () => (over.symbol ?? 'USDG'),
      readTokenBalance: over.readTokenBalance || (async () => 1_000_000_000n), // 1000 USDG
      waitForReceipt: (rpc, h) => rpc.getTransactionReceipt(h),
    },
  };
}

// ── withdraw ETH ──────────────────────────────────────────────────────────────
test('withdraw ETH "all" sends balance minus the send gas to the external address', async () => {
  const { deps: d, ks } = baseDeps();
  const res = await withdrawFromLauncher({ to: EXT, asset: 'eth', amount: 'all' }, d);
  assert.equal(res.status, 'confirmed');
  const signed = ks.signables[0];
  assert.equal(getAddress(signed.to), EXT);
  // value = 1 ETH − 21000 × maxFeePerGas(1e9) = 1e18 − 21000e9
  assert.equal(signed.value, 10n ** 18n - 21_000n * 1_000_000_000n);
});

test('withdraw ETH refuses an amount that exceeds balance + gas', async () => {
  const { deps: d } = baseDeps();
  await assert.rejects(() => withdrawFromLauncher({ to: EXT, asset: 'eth', amount: '2' }, d), /withdrawal \+ gas needs/);
});

test('withdraw refuses a bad destination address', async () => {
  const { deps: d } = baseDeps();
  await assert.rejects(() => withdrawFromLauncher({ to: 'nope', asset: 'eth' }, d), /address you control/);
});

// ── withdraw ERC-20 (USDG) ──────────────────────────────────────────────────
test('withdraw USDG "all" transfers the full token balance to the external address', async () => {
  const { deps: d, ks } = baseDeps();
  const res = await withdrawFromLauncher({ to: EXT, asset: 'usdg', amount: 'all' }, d);
  assert.equal(res.asset, 'USDG');
  const signed = ks.signables[0];
  assert.equal(getAddress(signed.to), USDG, 'the tx targets the USDG contract');
  assert.equal(signed.value, 0n);
  const decoded = erc20Iface.decodeFunctionData('transfer', signed.data);
  assert.equal(getAddress(decoded[0]), EXT);
  assert.equal(decoded[1], 1_000_000_000n, 'the full USDG balance');
});

test('withdraw ERC-20 refuses when the launcher has no ETH for the transfer gas', async () => {
  const { deps: d } = baseDeps({ provider: { getBalance: async () => 0n } });
  await assert.rejects(() => withdrawFromLauncher({ to: EXT, asset: 'usdg', amount: 'all' }, d), /needs .* ETH .* transfer gas/);
});

// ── in-flight guard ──────────────────────────────────────────────────────────
test('withdraw refuses while the launcher has a tx in flight (cancel it first)', async () => {
  const { deps: d, ks } = baseDeps({
    provider: { getTransactionCount: async (_a, tag) => (tag === 'pending' ? 6 : 5) },
  });
  await assert.rejects(() => withdrawFromLauncher({ to: EXT, asset: 'eth', amount: 'all' }, d), /unconfirmed tx in flight/);
  assert.equal(ks.signCalls.length, 0, 'nothing is signed while an in-flight tx exists');
});

// ── cancel ─────────────────────────────────────────────────────────────────────
test('cancel does nothing when the launcher has no unconfirmed tx', async () => {
  const { deps: d, provider } = baseDeps();
  const res = await cancelStuckLauncherTx({}, d);
  assert.equal(res.nothingStuck, true);
  assert.equal(provider.broadcasts.length, 0);
});

test('cancel replaces the stuck tx at its own nonce with a bumped fee', async () => {
  const { deps: d, ks } = baseDeps({
    provider: { getTransactionCount: async (_a, tag) => (tag === 'pending' ? 6 : 5) },
  });
  const res = await cancelStuckLauncherTx({ feeBumpPct: 200 }, d);
  assert.equal(res.status, 'confirmed');
  assert.equal(res.nonce, 5, 'the replacement uses the stuck nonce (latest)');
  const signed = ks.signables[0];
  assert.equal(signed.nonce, 5);
  assert.equal(getAddress(signed.to), DEV, 'a 0-value self-transfer');
  assert.equal(signed.value, 0n);
});

// ── gas override + cancel bump + erc-20 over-send (test-integrity gaps) ────────
test('withdraw signs the default 21000 gas, and honours a bounded gas override', async () => {
  const { deps: d, ks } = baseDeps();
  await withdrawFromLauncher({ to: EXT, asset: 'eth', amount: '0.1' }, d);
  assert.equal(ks.signables[0].gasLimit, 21_000n, 'default ETH send gas');

  const { deps: d2, ks: ks2 } = baseDeps();
  await withdrawFromLauncher({ to: EXT, asset: 'eth', amount: '0.1', gas: 120_000 }, d2);
  assert.equal(ks2.signables[0].gasLimit, 120_000n, 'override reaches the signed gasLimit (contract recipient)');
});

test('withdraw rejects a gas override below 21000 or above 500000', async () => {
  const { deps: d } = baseDeps();
  await assert.rejects(() => withdrawFromLauncher({ to: EXT, asset: 'eth', amount: '0.1', gas: 1000 }, d), /at least 21000/);
  await assert.rejects(() => withdrawFromLauncher({ to: EXT, asset: 'eth', amount: '0.1', gas: 9_000_000 }, d), /capped at 500,000/);
});

test('withdraw ERC-20 refuses an amount over the token balance', async () => {
  const { deps: d } = baseDeps({ readTokenBalance: async () => 5_000_000n }); // 5 USDG
  await assert.rejects(() => withdrawFromLauncher({ to: EXT, asset: 'usdg', amount: '10' }, d), /withdrawal is/);
});

test('cancel actually applies the fee bump to the replacement tx', async () => {
  // A getFees that ECHOES its bump arg into maxFeePerGas, so we can prove the bump
  // reaches the signed replacement (the whole point of cancel — out-bid the stuck tx).
  const ks = fakeKs();
  const provider = fakeProvider({ getTransactionCount: async (_a, tag) => (tag === 'pending' ? 6 : 5) });
  await cancelStuckLauncherTx(
    { feeBumpPct: 200 },
    {
      keystore: ks,
      provider,
      dryRun: false,
      getFees: async (bump = 0) => ({ type: 2, maxFeePerGas: BigInt(bump), maxPriorityFeePerGas: 1n }),
      waitForReceipt: (rpc, h) => rpc.getTransactionReceipt(h),
    }
  );
  assert.equal(ks.signables[0].maxFeePerGas, 200n, 'the feeBumpPct is threaded into the replacement fee');
});

// ── status ─────────────────────────────────────────────────────────────────────
test('launcherStatus reports balances and flags a stuck nonce', async () => {
  const { deps: d } = baseDeps({
    provider: { getTransactionCount: async (_a, tag) => (tag === 'pending' ? 8 : 5) },
  });
  const s = await launcherStatus({}, d);
  assert.equal(s.address, DEV);
  assert.equal(s.eth, '1.0');
  assert.equal(s.inFlight, 3, 'pending 8 − latest 5');
  assert.equal(s.stuckNonce, 5);
});
