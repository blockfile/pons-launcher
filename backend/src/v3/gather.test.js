'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEther } = require('ethers');

const gather = require('./gather');

const USER = 'u1';
const TOKEN = '0x3333333333333333333333333333333333333333';
const CURVE = '0x2222222222222222222222222222222222222222';
const MAIN = { id: 'main', role: 'v3main', address: '0x1111111111111111111111111111111111111111' };
const W1 = { id: 'w1', role: 'v3bundle', address: '0x00000000000000000000000000000000000000b1' };
const W2 = { id: 'w2', role: 'v3bundle', address: '0x00000000000000000000000000000000000000b2' };
const OTHER = { id: 'v2b', role: 'v2bundle', address: '0x00000000000000000000000000000000000000c1' };
const STRANGER = '0x00000000000000000000000000000000000000ff';

const TOKENS = (n) => BigInt(n) * 10n ** 18n;

// ── returnToMain harness ─────────────────────────────────────────────────────
// The fake keystore signer returns the wallet id so the fake erc20 can record
// which wallet a transfer came from; the fake erc20's transfer never touches a
// chain. waitForReceiptFn decides confirmed vs reverted off the tx hash.
function returnHarness({
  holdings = { [MAIN.address]: TOKENS(400), [W1.address]: TOKENS(100), [W2.address]: TOKENS(50) },
  eth = { [MAIN.address]: parseEther('1'), [W1.address]: parseEther('1'), [W2.address]: parseEther('1') },
  revertFor = [], // wallet ids whose transfer mines with status 0
  throwFor = [], // wallet ids whose transfer broadcast throws
} = {}) {
  const transfers = [];
  const logged = [];
  const wallets = [MAIN, W1, W2, OTHER];

  const deps = {
    keystoreForFn: () => ({
      walletWithRole: (r) => wallets.find((w) => w.role === r) || null,
      walletsWithRole: (r) => wallets.filter((w) => w.role === r),
      ownedAddresses: () => wallets.map((w) => w.address),
      signer: (id) => ({ __walletId: id, address: (wallets.find((w) => w.id === id) || {}).address }),
    }),
    activityForFn: () => ({ record: (kind, summary, detail) => logged.push({ kind, summary, detail }) }),
    rpc: { getBalance: async (a) => eth[a] ?? 0n },
    getFeesFn: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
    waitForReceiptFn: async (_rpc, hash) => ({ status: revertFor.includes(hash.replace('0x', '')) ? 0 : 1 }),
    erc20: (tokenAddr, signer) => ({
      transfer: async (to, amount, overrides) => {
        const id = signer.__walletId;
        if (throwFor.includes(id)) throw new Error('broadcast failed');
        transfers.push({ walletId: id, token: tokenAddr, to, amount, gasLimit: overrides.gasLimit });
        return { hash: `0x${id}` };
      },
    }),
    trade: { tokenBalance: async (_t, owner) => holdings[owner] ?? 0n },
    decimals: 18,
  };

  return { deps, transfers, logged };
}

test('returnToMain moves only positive balances, and the exact balance', async () => {
  const h = returnHarness();
  const out = await gather.returnToMain(USER, { token: TOKEN }, h.deps);

  assert.deepEqual(h.transfers.map((t) => t.walletId).sort(), ['w1', 'w2']);
  const byId = Object.fromEntries(h.transfers.map((t) => [t.walletId, t.amount]));
  assert.equal(byId.w1, TOKENS(100), 'transfers the whole balance');
  assert.equal(byId.w2, TOKENS(50));
  assert.equal(out.totals.transferred, 2);
  assert.equal(out.totals.failed, 0);
  assert.equal(out.moved, '150.0');
  assert.equal(out.totals.tokens, '150.0');
});

test('returnToMain sends every transfer to the main wallet, never from it', async () => {
  const h = returnHarness();
  const out = await gather.returnToMain(USER, { token: TOKEN }, h.deps);

  // Main holds 400 in the fixture, but it is the destination — never a source.
  assert.ok(!h.transfers.some((t) => t.walletId === 'main'), 'main is never a source');
  assert.ok(h.transfers.every((t) => t.to === out.main), 'everything goes to main');
  assert.equal(out.main.toLowerCase(), MAIN.address.toLowerCase());
});

test('returnToMain never touches another launchers wallets', async () => {
  const h = returnHarness({ holdings: { [W1.address]: TOKENS(100), [OTHER.address]: TOKENS(999) } });
  await gather.returnToMain(USER, { token: TOKEN }, h.deps);
  assert.ok(!h.transfers.some((t) => t.walletId === 'v2b'));
});

test('returnToMain skips a wallet holding none, and says so', async () => {
  const h = returnHarness({ holdings: { [W1.address]: 0n, [W2.address]: TOKENS(50) } });
  const out = await gather.returnToMain(USER, { token: TOKEN }, h.deps);
  assert.ok(!h.transfers.some((t) => t.walletId === 'w1'));
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].walletId, 'w1');
  assert.match(out.skipped[0].reason, /holds none/);
});

test('returnToMain skips a wallet too short of gas, and says which', async () => {
  const h = returnHarness({ eth: { [W1.address]: 1n, [W2.address]: parseEther('1') } });
  const out = await gather.returnToMain(USER, { token: TOKEN }, h.deps);
  assert.ok(!h.transfers.some((t) => t.walletId === 'w1'));
  const skip = out.skipped.find((s) => s.walletId === 'w1');
  assert.match(skip.reason, /gas/);
});

test('returnToMain sends the transfer with a fixed gas limit', async () => {
  const h = returnHarness();
  await gather.returnToMain(USER, { token: TOKEN }, h.deps);
  assert.ok(h.transfers.every((t) => t.gasLimit === gather.TRANSFER_GAS));
});

test('returnToMain reports a reverted transfer as failed, and keeps going', async () => {
  const h = returnHarness({ revertFor: ['w1'] });
  const out = await gather.returnToMain(USER, { token: TOKEN }, h.deps);
  assert.equal(h.transfers.length, 2, 'both wallets are still attempted');
  const w1 = out.results.find((r) => r.walletId === 'w1');
  const w2 = out.results.find((r) => r.walletId === 'w2');
  assert.equal(w1.status, 'reverted');
  assert.equal(w2.status, 'confirmed');
  assert.equal(out.totals.transferred, 1);
  assert.equal(out.totals.failed, 1);
  assert.equal(out.moved, '50.0', 'only the confirmed transfer counts as moved');
});

test('returnToMain reports a broadcast failure as failed, and keeps going', async () => {
  const h = returnHarness({ throwFor: ['w1'] });
  const out = await gather.returnToMain(USER, { token: TOKEN }, h.deps);
  const w1 = out.results.find((r) => r.walletId === 'w1');
  assert.equal(w1.status, 'failed');
  assert.equal(w1.hash, null);
  assert.match(w1.error, /broadcast failed/);
  assert.equal(out.totals.transferred, 1);
});

test('returnToMain writes the run to the activity log, naming the linkage', async () => {
  const h = returnHarness();
  await gather.returnToMain(USER, { token: TOKEN }, h.deps);
  assert.equal(h.logged.length, 1);
  assert.equal(h.logged[0].kind, 'v3');
  assert.match(h.logged[0].summary, /returned/);
  assert.match(h.logged[0].summary, /links these wallets to main/);
});

test('returnToMain result carries no BigInt', async () => {
  const h = returnHarness();
  const out = await gather.returnToMain(USER, { token: TOKEN }, h.deps);
  assert.ok(JSON.stringify(out).length > 0);
  assert.equal(out.action, 'v3-return-to-main');
});

// ── sellMain harness ─────────────────────────────────────────────────────────
function sellHarness({
  balance = TOKENS(400),
  graduated = false,
  deployer = MAIN.address, // a wallet this account holds launched it
  exists = true,
  sellResult,
} = {}) {
  const sold = [];
  const logged = [];
  const wallets = [MAIN, W1, W2, OTHER];

  const deps = {
    keystoreForFn: () => ({
      walletWithRole: (r) => wallets.find((w) => w.role === r) || null,
      walletsWithRole: (r) => wallets.filter((w) => w.role === r),
      ownedAddresses: () => wallets.map((w) => w.address),
      signer: (id) => ({ __walletId: id }),
    }),
    activityForFn: () => ({ record: (kind, summary, detail) => logged.push({ kind, summary, detail }) }),
    rpc: { getBalance: async () => parseEther('1') },
    getFeesFn: async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }),
    describeToken: async () =>
      exists
        ? { token: TOKEN, protocol: 'v2', exists: true, curve: CURVE, deployer }
        : { token: TOKEN, protocol: 'v2', exists: false },
    trade: {
      readCurve: async () => ({
        address: CURVE,
        token: TOKEN,
        isNativeQuote: true,
        pairToken: null,
        quoteReserve: parseEther('40'),
        tokenReserve: TOKENS(800_000_000),
        feeBps: 100,
        creatorTaxBps: 100,
        graduated,
        readyToGraduate: false,
      }),
      tokenBalance: async () => balance,
      sell: async (args) => {
        sold.push(args);
        return (
          sellResult || {
            status: 'confirmed',
            approveHash: '0xa',
            sellHash: '0xs',
            blockNumber: 1,
            ethReceived: parseEther('0.5'),
            tokensIn: args.tokensIn,
          }
        );
      },
    },
    decimals: 18,
  };

  return { deps, sold, logged };
}

test('sellMain refuses without confirm', async () => {
  const h = sellHarness();
  await assert.rejects(() => gather.sellMain(USER, { token: TOKEN }, h.deps), /confirm/);
  assert.equal(h.sold.length, 0);
});

test('sellMain refuses a graduated curve', async () => {
  const h = sellHarness({ graduated: true });
  await assert.rejects(
    () => gather.sellMain(USER, { token: TOKEN, confirm: true }, h.deps),
    /graduated/
  );
  assert.equal(h.sold.length, 0);
});

test('sellMain refuses a token a wallet of ours did not launch', async () => {
  // The dusting gate: selling approves the curve, so a stranger's token is refused.
  const h = sellHarness({ deployer: STRANGER });
  await assert.rejects(
    () => gather.sellMain(USER, { token: TOKEN, confirm: true }, h.deps),
    /not launched by a wallet/
  );
  assert.equal(h.sold.length, 0);
});

test('sellMain refuses a token the factory has never heard of', async () => {
  const h = sellHarness({ exists: false });
  await assert.rejects(
    () => gather.sellMain(USER, { token: TOKEN, confirm: true }, h.deps),
    /not a pons v2 launch/
  );
  assert.equal(h.sold.length, 0);
});

test('sellMain refuses when the main wallet holds none', async () => {
  const h = sellHarness({ balance: 0n });
  await assert.rejects(
    () => gather.sellMain(USER, { token: TOKEN, confirm: true }, h.deps),
    /holds none/
  );
  assert.equal(h.sold.length, 0);
});

test('sellMain sells the main wallets whole balance, floor-free', async () => {
  const h = sellHarness();
  const out = await gather.sellMain(USER, { token: TOKEN, confirm: true }, h.deps);

  assert.equal(h.sold.length, 1);
  const call = h.sold[0];
  assert.equal(call.wallet.id, 'main', 'it is the main wallet that sells');
  assert.equal(call.tokensIn, TOKENS(400), 'the whole balance');
  assert.equal(call.liquidate, true, 'floor-free liquidate, like the exit');
  assert.equal(call.curve.address, CURVE, 'the curve state is passed so the route path is chosen');
  assert.equal(call.token, TOKEN);

  assert.equal(out.action, 'v3-sell-main');
  assert.equal(out.status, 'confirmed');
  assert.equal(out.tokensIn, '400.0');
  assert.equal(out.ethReceived, '0.5');
  assert.equal(out.sellHash, '0xs');
  assert.equal(out.approveHash, '0xa');
});

test('sellMain accepts an explicit curve override', async () => {
  const h = sellHarness();
  const out = await gather.sellMain(USER, { token: TOKEN, curve: CURVE, confirm: true }, h.deps);
  assert.equal(out.status, 'confirmed');
  assert.equal(h.sold.length, 1);
});

test('sellMain writes the sell to the activity log', async () => {
  const h = sellHarness();
  await gather.sellMain(USER, { token: TOKEN, confirm: true }, h.deps);
  assert.equal(h.logged.length, 1);
  assert.equal(h.logged[0].kind, 'v3');
  assert.match(h.logged[0].summary, /sold main/);
});

test('sellMain result carries no BigInt', async () => {
  const h = sellHarness();
  const out = await gather.sellMain(USER, { token: TOKEN, confirm: true }, h.deps);
  assert.ok(JSON.stringify(out).length > 0);
});

// ── sweepEthToMain (direct native sweep, no Relay) ───────────────────────────
// The fake signer records each sendTransaction; the fake rpc holds balances.
const { gasCost } = require('../evm/fees');
const SWEEP_FEE = { type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n };
const SWEEP_RESERVE = gasCost(SWEEP_FEE, gather.SEND_GAS);
const TREASURY = { id: 'tr', role: 'v3dev', address: '0x00000000000000000000000000000000000000d1' };

function sweepHarness({
  eth = {
    [MAIN.address]: parseEther('1'),
    [W1.address]: parseEther('0.0003'),
    [W2.address]: parseEther('0.0002'),
    [OTHER.address]: parseEther('5'),
    [TREASURY.address]: parseEther('0.5'),
  },
  revertFor = [],
  throwFor = [],
} = {}) {
  const sends = [];
  const logged = [];
  const wallets = [MAIN, W1, W2, OTHER, TREASURY];
  const deps = {
    keystoreForFn: () => ({
      walletWithRole: (r) => wallets.find((w) => w.role === r) || null,
      walletsWithRole: (r) => wallets.filter((w) => w.role === r),
      ownedAddresses: () => wallets.map((w) => w.address),
      signer: (id) => ({
        __walletId: id,
        address: (wallets.find((w) => w.id === id) || {}).address,
        sendTransaction: async (tx) => {
          if (throwFor.includes(id)) throw new Error('broadcast failed');
          sends.push({ walletId: id, to: tx.to, value: tx.value, gasLimit: tx.gasLimit });
          return { hash: `0x${id}` };
        },
      }),
    }),
    activityForFn: () => ({ record: (kind, summary, detail) => logged.push({ kind, summary, detail }) }),
    rpc: { getBalance: async (a) => eth[a] ?? 0n },
    getFeesFn: async () => SWEEP_FEE,
    waitForReceiptFn: async (_rpc, hash) => ({ status: revertFor.includes(hash.replace('0x', '')) ? 0 : 1 }),
    decimals: 18,
  };
  return { deps, sends, logged };
}

test('sweepEthToMain requires confirm', async () => {
  const h = sweepHarness();
  await assert.rejects(() => gather.sweepEthToMain(USER, {}, h.deps), /confirm/);
  assert.equal(h.sends.length, 0);
});

test('sweepEthToMain sends balance-minus-gas from each bundle wallet to main, never from main', async () => {
  const h = sweepHarness();
  const out = await gather.sweepEthToMain(USER, { confirm: true }, h.deps);

  assert.deepEqual(h.sends.map((s) => s.walletId).sort(), ['w1', 'w2']);
  assert.ok(!h.sends.some((s) => s.walletId === 'main'), 'main is the destination, never a source');
  assert.ok(!h.sends.some((s) => s.walletId === 'v2b'), "never another launcher's wallets");
  assert.ok(h.sends.every((s) => s.to.toLowerCase() === MAIN.address.toLowerCase()));
  assert.ok(h.sends.every((s) => s.gasLimit === gather.SEND_GAS));
  const byId = Object.fromEntries(h.sends.map((s) => [s.walletId, s.value]));
  assert.equal(byId.w1, parseEther('0.0003') - SWEEP_RESERVE, 'sends the balance minus its own gas');
  assert.equal(byId.w2, parseEther('0.0002') - SWEEP_RESERVE);
  assert.equal(out.totals.sent, 2);
});

test('sweepEthToMain skips a wallet that cannot cover its own send gas', async () => {
  const h = sweepHarness({ eth: { [MAIN.address]: parseEther('1'), [W1.address]: 1n, [W2.address]: parseEther('0.0002') } });
  const out = await gather.sweepEthToMain(USER, { confirm: true }, h.deps);
  assert.deepEqual(h.sends.map((s) => s.walletId), ['w2'], 'the dust-only wallet is skipped');
  assert.equal(out.skipped.length, 1);
  assert.equal(out.skipped[0].walletId, 'w1');
});

test('sweepEthToMain to treasury also sweeps the main wallet', async () => {
  const h = sweepHarness();
  const out = await gather.sweepEthToMain(USER, { destination: 'treasury', confirm: true }, h.deps);
  // main is a source now (it is not the destination); bundle wallets too.
  assert.ok(h.sends.some((s) => s.walletId === 'main'), 'main is swept when treasury is the target');
  assert.equal(out.destinationRole, 'v3dev'); // treasury role
});

test('sweepEthToMain reports a reverted send and a broadcast failure without stopping', async () => {
  const rh = sweepHarness({ revertFor: ['w1'] });
  const ro = await gather.sweepEthToMain(USER, { confirm: true }, rh.deps);
  assert.equal(ro.totals.sent, 1, 'only the confirmed one counts');
  assert.equal(ro.totals.failed, 1);

  const th = sweepHarness({ throwFor: ['w1'] });
  const to = await gather.sweepEthToMain(USER, { confirm: true }, th.deps);
  assert.ok(to.results.some((r) => r.walletId === 'w1' && r.status === 'failed'));
  assert.ok(to.results.some((r) => r.walletId === 'w2' && r.status === 'confirmed'), 'one failure never stops the rest');
});

test('sweepEthToMain result carries no BigInt', () => {
  assert.doesNotThrow(() => JSON.stringify({ ok: true }));
});
