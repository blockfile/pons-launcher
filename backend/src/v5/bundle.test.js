'use strict';

// Unit tests for the v5 (letscash) BUNDLE fan-out money path. Fully offline: a
// fake keystore records every signing request, a fake provider records every
// broadcast, and the token reads (balance/decimals/symbol) are injected. Nothing
// touches a chain.
//
// The load-bearing guarantees:
//   * the split is EXACT — an equal split leaves the remainder in the launcher,
//     never silently over-credits a wallet.
//   * a fan-out that would move MORE than the launcher holds is refused, and
//     NOTHING is signed.
//   * every transfer is signed at a SEQUENTIAL nonce, value 0, to = the token,
//     with transfer(bundleWallet, amount) calldata.
//   * fireBundle broadcasts the pre-signed transfers and tallies sent/failed.

const test = require('node:test');
const assert = require('node:assert');
const { Interface, parseUnits, getAddress } = require('ethers');

const { prepareBundle, fireBundle, planAllocations } = require('./bundle');
const { ERC20_ABI } = require('../evm/erc20');

const erc20Iface = new Interface(ERC20_ABI);

const DEV = getAddress('0x' + '11'.repeat(20));
const TOKEN = getAddress('0x4F0d7ea112547Af5dAD59959d98B6A8ee3355Bcc');
const B = (n) => getAddress('0x' + String(n).repeat(40).slice(0, 40));
const WALLETS = [
  { id: 'b1', address: B(2), role: 'v5bundle' },
  { id: 'b2', address: B(3), role: 'v5bundle' },
  { id: 'b3', address: B(4), role: 'v5bundle' },
  { id: 'b4', address: B(5), role: 'v5bundle' },
];

function fakeKs(dev = { id: 'dev', address: DEV, role: 'v5dev' }, bundle = WALLETS) {
  const ks = { signables: [], signCalls: [] };
  ks.walletWithRole = (r) => (r === 'v5dev' ? dev : null);
  ks.walletsWithRole = (r) => (r === 'v5bundle' ? bundle : []);
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
  p.estimateGas = over.estimateGas || (async () => 50000n);
  p.getBalance = over.getBalance || (async () => 10n ** 18n); // 1 ETH for gas
  // Respects the block tag so a test can model in-flight txs (pending > latest).
  p.getTransactionCount = over.getTransactionCount || (async (_addr, _tag) => 4);
  p.broadcastTransaction =
    over.broadcastTransaction ||
    (async (raw) => {
      p.broadcasts.push(raw);
      return { hash: `hash:${raw}` };
    });
  p.getTransactionReceipt = over.getTransactionReceipt || (async () => ({ status: 1, blockNumber: 7 }));
  return p;
}

function deps(over = {}, ks = fakeKs(), provider = fakeProvider(over.provider)) {
  return {
    ks,
    provider,
    deps: {
      keystore: ks,
      provider,
      getFees: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n }),
      readTokenBalance: over.readTokenBalance || (async () => 1000n * 10n ** 18n), // 1000 tokens
      getDecimals: over.getDecimals || (async () => 18),
      getSymbol: over.getSymbol || (async () => 'CAT'),
    },
  };
}

// ── planAllocations ───────────────────────────────────────────────────────────
test('equal split divides evenly and leaves the remainder in the launcher', () => {
  // 1000 across 3 wallets → 333 each, 1 token remainder stays behind.
  const out = planAllocations({
    wallets: WALLETS.slice(0, 3),
    balanceWei: 1000n * 10n ** 18n,
    decimals: 18,
    mode: 'equal',
    leaveInLauncher: '0',
  });
  const each = (1000n * 10n ** 18n) / 3n;
  assert.equal(out.perWallet.length, 3);
  assert.ok(out.perWallet.every((p) => p.amountWei === each));
  assert.equal(out.totalWei, each * 3n);
  assert.ok(1000n * 10n ** 18n - out.totalWei > 0n, 'the indivisible remainder stays in the launcher');
});

test('equal split honours leaveInLauncher', () => {
  const out = planAllocations({
    wallets: WALLETS.slice(0, 2),
    balanceWei: 1000n * 10n ** 18n,
    decimals: 18,
    mode: 'equal',
    leaveInLauncher: '200',
  });
  assert.equal(out.leaveWei, 200n * 10n ** 18n);
  assert.equal(out.perWallet[0].amountWei, 400n * 10n ** 18n, '(1000−200)/2 = 400 each');
});

test('amounts mode aligns explicit whole-token amounts to the wallet list', () => {
  const out = planAllocations({
    wallets: WALLETS.slice(0, 3),
    balanceWei: 1000n * 10n ** 18n,
    decimals: 18,
    mode: 'amounts',
    amounts: ['100', '250', '50'],
  });
  assert.deepEqual(
    out.perWallet.map((p) => p.amountWei),
    [100n * 10n ** 18n, 250n * 10n ** 18n, 50n * 10n ** 18n]
  );
  assert.equal(out.totalWei, 400n * 10n ** 18n);
});

test('amounts mode refuses a length that does not match the wallet count', () => {
  assert.throws(
    () =>
      planAllocations({
        wallets: WALLETS.slice(0, 3),
        balanceWei: 1000n * 10n ** 18n,
        decimals: 18,
        mode: 'amounts',
        amounts: ['100', '250'],
      }),
    /one entry per bundle wallet/
  );
});

test('amounts NAMED mode matches by walletId, never by position — and may address a subset', () => {
  // Deliberately out of order and only 2 of the 4 wallets.
  const out = planAllocations({
    wallets: WALLETS,
    balanceWei: 1000n * 10n ** 18n,
    decimals: 18,
    mode: 'amounts',
    amounts: [
      { walletId: 'b3', amount: '300' },
      { walletId: 'b1', amount: '100' },
    ],
  });
  const byId = Object.fromEntries(out.perWallet.map((p) => [p.wallet.id, p.amountWei]));
  assert.equal(byId.b3, 300n * 10n ** 18n, 'b3 gets its named amount, not wallets[0]');
  assert.equal(byId.b1, 100n * 10n ** 18n);
  assert.equal(out.perWallet.length, 2, 'a named subset funds only the wallets it names');
});

test('amounts NAMED mode matches by address too', () => {
  const out = planAllocations({
    wallets: WALLETS,
    balanceWei: 1000n * 10n ** 18n,
    decimals: 18,
    mode: 'amounts',
    amounts: [{ address: WALLETS[2].address, amount: '50' }],
  });
  assert.equal(out.perWallet[0].wallet.id, 'b3');
  assert.equal(out.perWallet[0].amountWei, 50n * 10n ** 18n);
});

test('amounts NAMED mode rejects an unknown wallet and a duplicate', () => {
  assert.throws(
    () =>
      planAllocations({
        wallets: WALLETS,
        balanceWei: 1000n * 10n ** 18n,
        decimals: 18,
        mode: 'amounts',
        amounts: [{ walletId: 'nope', amount: '1' }],
      }),
    /not one of this tab's bundle wallets/
  );
  assert.throws(
    () =>
      planAllocations({
        wallets: WALLETS,
        balanceWei: 1000n * 10n ** 18n,
        decimals: 18,
        mode: 'amounts',
        amounts: [
          { walletId: 'b1', amount: '1' },
          { walletId: 'b1', amount: '2' },
        ],
      }),
    /more than once/
  );
});

test('amounts mixed named/plain is refused when any entry is named', () => {
  assert.throws(
    () =>
      planAllocations({
        wallets: WALLETS,
        balanceWei: 1000n * 10n ** 18n,
        decimals: 18,
        mode: 'amounts',
        amounts: [{ walletId: 'b1', amount: '1' }, '2'],
      }),
    /must name its wallet/
  );
});

test('equal split that rounds to zero per wallet is refused', () => {
  assert.throws(
    () =>
      planAllocations({
        wallets: WALLETS,
        balanceWei: 3n, // 3 wei across 4 wallets
        decimals: 18,
        mode: 'equal',
        leaveInLauncher: '0',
      }),
    /rounds to zero/
  );
});

// ── prepareBundle ─────────────────────────────────────────────────────────────
test('prepareBundle signs one transfer per wallet at sequential nonces, value 0, to = token', async () => {
  const { deps: d, ks } = deps();
  const plan = await prepareBundle({ token: TOKEN, mode: 'equal' }, d);

  assert.equal(plan.count, 4);
  assert.equal(ks.signables.length, 4);
  // nonces 4,5,6,7 (provider.getTransactionCount → 4)
  assert.deepEqual(ks.signables.map((s) => s.nonce), [4, 5, 6, 7]);
  for (const s of ks.signables) {
    assert.equal(s.value, 0n, 'a token transfer carries no ETH value');
    assert.equal(getAddress(s.to), TOKEN, 'the tx targets the token contract');
    const decoded = erc20Iface.decodeFunctionData('transfer', s.data);
    assert.ok(WALLETS.some((w) => getAddress(w.address) === getAddress(decoded[0])), 'recipient is a bundle wallet');
    assert.equal(decoded[1], 250n * 10n ** 18n, '1000/4 = 250 each');
  }
  assert.equal(plan.transfers[0].raw, '0xSIGNED:4');
});

test('prepareBundle broadcasts NOTHING', async () => {
  const { deps: d, provider } = deps();
  await prepareBundle({ token: TOKEN }, d);
  assert.equal(provider.broadcasts.length, 0);
});

test('prepareBundle refuses to over-allocate — and signs nothing', async () => {
  const { deps: d, ks } = deps();
  // 1000 held, ask to send 400+400+400 = 1200.
  await assert.rejects(
    () => prepareBundle({ token: TOKEN, mode: 'amounts', amounts: ['400', '400', '400', '0'] }, d),
    /total .* but the launcher holds only/
  );
  assert.equal(ks.signCalls.length, 0, 'nothing is signed when the split exceeds the balance');
});

test('prepareBundle refuses when the launcher holds none of the token', async () => {
  const { deps: d } = deps({ readTokenBalance: async () => 0n });
  await assert.rejects(() => prepareBundle({ token: TOKEN }, d), /holds 0 CAT/);
});

test('prepareBundle refuses when the launcher cannot cover the gas', async () => {
  const { deps: d } = deps({ provider: { getBalance: async () => 0n } });
  await assert.rejects(() => prepareBundle({ token: TOKEN }, d), /need .* ETH of gas/);
});

test('prepareBundle refuses to size a split while the launcher has txs in flight', async () => {
  // pending nonce ahead of latest ⇒ unmined txs (a launch or prior bundle) exist;
  // balanceOf(latest) would not reflect them, so a split now would over-commit.
  const { deps: d, ks } = deps({
    provider: { getTransactionCount: async (_addr, tag) => (tag === 'pending' ? 6 : 4) },
  });
  await assert.rejects(() => prepareBundle({ token: TOKEN }, d), /still in flight/);
  assert.equal(ks.signCalls.length, 0, 'nothing is signed against an unsettled launcher');
});

test('prepareBundle refuses a bad token address', async () => {
  const { deps: d } = deps();
  await assert.rejects(() => prepareBundle({ token: 'not-an-address' }, d), /launched ERC-20 address/);
});

test('prepareBundle refuses when a transfer would revert (estimateGas throws)', async () => {
  const { deps: d } = deps({
    provider: {
      estimateGas: async () => {
        throw new Error('execution reverted');
      },
    },
  });
  await assert.rejects(() => prepareBundle({ token: TOKEN }, d), /would revert, so nothing was signed/);
});

// ── fireBundle ────────────────────────────────────────────────────────────────
function bundlePlan(transfers) {
  return {
    protocol: 'v5',
    kind: 'bundle',
    token: TOKEN,
    symbol: 'CAT',
    transfers,
  };
}

test('fireBundle broadcasts every transfer and tallies confirmed', async () => {
  const provider = fakeProvider();
  const res = await fireBundle(
    bundlePlan([
      { walletId: 'b1', to: B(2), amount: '250', raw: '0xr1' },
      { walletId: 'b2', to: B(3), amount: '250', raw: '0xr2' },
    ]),
    { provider, dryRun: false, warmPool: async () => {}, waitForReceipt: (rpc, h) => rpc.getTransactionReceipt(h) }
  );
  assert.equal(provider.broadcasts.length, 2);
  assert.equal(res.sent, 2);
  assert.equal(res.failed, 0);
  assert.ok(res.transfers.every((t) => t.status === 'confirmed'));
});

test('fireBundle counts a reverted transfer as failed without dropping the rest', async () => {
  let n = 0;
  const provider = fakeProvider({
    getTransactionReceipt: async () => {
      n += 1;
      return { status: n === 1 ? 0 : 1, blockNumber: 7 }; // first reverts
    },
  });
  const res = await fireBundle(
    bundlePlan([
      { walletId: 'b1', to: B(2), amount: '250', raw: '0xr1' },
      { walletId: 'b2', to: B(3), amount: '250', raw: '0xr2' },
    ]),
    { provider, dryRun: false, warmPool: async () => {}, waitForReceipt: (rpc, h) => rpc.getTransactionReceipt(h) }
  );
  assert.equal(res.sent, 1);
  assert.equal(res.failed, 1);
});

test('fireBundle records a send-failed transfer without throwing the whole run', async () => {
  const provider = fakeProvider({
    broadcastTransaction: async (raw) => {
      if (raw === '0xr1') throw new Error('nonce too low');
      return { hash: `hash:${raw}` };
    },
  });
  const res = await fireBundle(
    bundlePlan([
      { walletId: 'b1', to: B(2), amount: '250', raw: '0xr1' },
      { walletId: 'b2', to: B(3), amount: '250', raw: '0xr2' },
    ]),
    { provider, dryRun: false, warmPool: async () => {}, waitForReceipt: (rpc, h) => rpc.getTransactionReceipt(h) }
  );
  assert.equal(res.failed, 1);
  assert.equal(res.sent, 1);
  assert.equal(res.transfers.find((t) => t.walletId === 'b1').status, 'send-failed');
});

test('a dry run broadcasts nothing and marks every transfer simulated', async () => {
  const provider = fakeProvider();
  const res = await fireBundle(bundlePlan([{ walletId: 'b1', to: B(2), amount: '250', raw: '0xr1' }]), {
    provider,
    dryRun: true,
    warmPool: async () => {},
  });
  assert.equal(provider.broadcasts.length, 0);
  assert.equal(res.simulated, true);
  assert.equal(res.transfers[0].status, 'simulated');
});

test('fireBundle refuses a plan with unsigned transfers', async () => {
  await assert.rejects(
    () =>
      fireBundle(bundlePlan([{ walletId: 'b1', to: B(2), amount: '250' }]), {
        provider: fakeProvider(),
        dryRun: false,
        warmPool: async () => {},
      }),
    /unsigned transfers/
  );
});

test('fireBundle refuses something that is not a bundle plan', async () => {
  await assert.rejects(
    () => fireBundle({ protocol: 'v5', kind: 'launch' }, { provider: fakeProvider(), dryRun: false }),
    /not a v5 bundle plan/
  );
});
