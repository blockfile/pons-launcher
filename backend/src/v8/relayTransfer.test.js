'use strict';

// Unit tests for V8's money path. Fully offline: the keystore, the provider, the Relay
// quote, the fees and every sleep are injected, so nothing here touches a network or a
// clock.

const test = require('node:test');
const assert = require('node:assert/strict');
const { getAddress, parseEther, formatEther } = require('ethers');
const config = require('../config');

const relayTransfer = require('./relayTransfer');

const CHAIN = Number(config.chainId);
const MAIN = getAddress('0x' + 'a1'.repeat(20));
const DEPOSIT = getAddress('0x' + 'de'.repeat(20));
const B = (n) => getAddress('0x' + String(n).padStart(40, '0'));

function bundleWallets(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `b${i + 1}`,
    role: 'v8bundle',
    address: B(i + 1),
    label: null,
  }));
}

// A keystore double holding one v8main and `count` v8bundle wallets, plus whatever other
// tabs' wallets a test wants to prove are unreachable.
function fakeKs({ count = 3, main = { id: 'm1', role: 'v8main', address: MAIN }, extra = [] } = {}) {
  const wallets = [...(main ? [main] : []), ...bundleWallets(count), ...extra];
  const ks = {
    sent: [],
    wallets,
    walletWithRole: (r) => wallets.find((w) => w.role === r) || null,
    walletsWithRole: (r) => wallets.filter((w) => w.role === r),
  };
  ks.signer = (id) => ({
    sendTransaction: async (tx) => {
      ks.sent.push({ id, ...tx });
      return { hash: `hash:${id}:${tx.nonce}` };
    },
  });
  return ks;
}

// A quote depositStep can parse: a 'deposit' step whose tx is FROM the payer, on THIS
// chain, to a deposit address, for slightly more than the ask (the solver fee on top).
function fakeQuote(body, { multiple = 101n } = {}) {
  return {
    steps: [
      {
        id: 'deposit',
        requestId: '0x' + '11'.repeat(32),
        depositAddress: DEPOSIT,
        items: [
          {
            kind: 'transaction',
            data: {
              chainId: CHAIN,
              from: getAddress(body.user),
              to: DEPOSIT,
              value: ((BigInt(body.amount) * multiple) / 100n).toString(),
              gas: '120000',
            },
            check: { endpoint: '/x' },
          },
        ],
      },
    ],
    fees: { relayer: { amount: '1', currency: { symbol: 'ETH' } } },
    details: { operation: 'send' },
  };
}

const FEES = async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n });

function deps(over = {}) {
  const ks = over.keystore || fakeKs(over.ks);
  const slept = [];
  const quoted = [];
  return {
    ks,
    slept,
    quoted,
    d: {
      keystore: ks,
      rpc: {
        getBalance: over.getBalance || (async () => parseEther('100')),
        getTransactionCount: over.getTransactionCount || (async () => 7),
      },
      relayQuote:
        over.relayQuote ||
        (async (body) => {
          quoted.push(body);
          return fakeQuote(body);
        }),
      getFeesFn: over.getFeesFn || FEES,
      dryRun: over.dryRun ?? false,
      sleepFn: async (ms) => {
        slept.push(ms);
      },
      quoteGapMs: over.quoteGapMs ?? 4000,
      quoteRetries: over.quoteRetries ?? 0,
      quoteBackoffMs: over.quoteBackoffMs ?? 1000,
      quoteBatchSize: over.quoteBatchSize ?? 1,
    },
  };
}

// ── planTargets: the refusals ────────────────────────────────────────────────

test('planTargets normalises valid targets and preserves their order', () => {
  const ks = fakeKs({ count: 3 });
  const planned = relayTransfer.planTargets(
    [
      { walletId: 'b2', amountEth: '0.05' },
      { walletId: 'b1', amountEth: '0.01' },
    ],
    ks
  );
  assert.deepEqual(
    planned.map((p) => [p.walletId, p.amountEth]),
    [
      ['b2', '0.05'],
      ['b1', '0.01'],
    ]
  );
  assert.equal(planned[0].amountWei, parseEther('0.05'));
});

test('planTargets refuses a target that is not a v8bundle wallet', () => {
  const ks = fakeKs({
    count: 2,
    extra: [
      { id: 'v7b', role: 'v7bundle', address: B(90) },
      { id: 'v1b', role: 'bundle', address: B(91) },
    ],
  });
  // an id this tab has never heard of
  assert.throws(() => relayTransfer.planTargets([{ walletId: 'nope', amountEth: '0.01' }], ks), /is not a v8bundle wallet/);
  // the SOURCE wallet — a v8 wallet, but not a receiver
  assert.throws(() => relayTransfer.planTargets([{ walletId: 'm1', amountEth: '0.01' }], ks), /is not a v8bundle wallet/);
  // another tab's wallets, by id and by address
  assert.throws(() => relayTransfer.planTargets([{ walletId: 'v7b', amountEth: '0.01' }], ks), /is not a v8bundle wallet/);
  assert.throws(() => relayTransfer.planTargets([{ address: B(91), amountEth: '0.01' }], ks), /is not a v8bundle wallet/);
});

test('planTargets refuses a non-positive or non-numeric amount, an empty list and a duplicate', () => {
  const ks = fakeKs({ count: 2 });
  assert.throws(() => relayTransfer.planTargets([{ walletId: 'b1', amountEth: '0' }], ks), /positive amount/);
  assert.throws(() => relayTransfer.planTargets([{ walletId: 'b1', amountEth: 'abc' }], ks), /amount in ETH/);
  assert.throws(() => relayTransfer.planTargets([{ walletId: 'b1' }], ks), /amount in ETH/);
  assert.throws(() => relayTransfer.planTargets([], ks), /targets\[\] is required/);
  assert.throws(
    () => relayTransfer.planTargets([{ walletId: 'b1', amountEth: '0.01' }, { walletId: 'b1', amountEth: '0.02' }], ks),
    /listed twice/
  );
});

test('planTargets names the missing source wallet rather than failing later', () => {
  const ks = fakeKs({ count: 2, main: null });
  assert.throws(() => relayTransfer.planTargets([{ walletId: 'b1', amountEth: '0.01' }], ks), /no v8main wallet/);
});

// ── THE NO-CAP PROPERTY ──────────────────────────────────────────────────────

test('NO CAP: a 60-wallet fan-out plans and sends all 60 (the 31 is a launch limit v8 does not have)', async () => {
  const { d, ks } = deps({ ks: { count: 60 } });
  const targets = bundleWallets(60).map((w) => ({ walletId: w.id, amountEth: '0.001' }));

  assert.equal(relayTransfer.planTargets(targets, ks).length, 60);

  const out = await relayTransfer.transfer(targets, d);
  assert.equal(out.results.length, 60);
  assert.equal(out.results.filter((r) => r.hash).length, 60);
  assert.equal(out.results.filter((r) => r.error).length, 0);
  assert.equal(ks.sent.length, 60, 'every wallet got its own Relay deposit');
});

// ── transfer: the shape and the money ────────────────────────────────────────

test('transfer returns the contract shape and pays the deposit address, not the wallet', async () => {
  const { d, ks, quoted } = deps();
  const out = await relayTransfer.transfer(
    [
      { walletId: 'b1', amountEth: '0.02' },
      { walletId: 'b2', amountEth: '0.03' },
    ],
    d
  );

  assert.equal(out.mode, 'relay-solver');
  assert.equal(out.from, MAIN);
  // 0.02 and 0.03 each quoted at 101% → 0.0505 total deposited
  assert.equal(out.totalDepositEth, formatEther((parseEther('0.05') * 101n) / 100n));

  for (const r of out.results) {
    for (const key of ['walletId', 'address', 'amountEth', 'requestId', 'depositAddress', 'hash', 'error']) {
      assert.ok(key in r, `results[] entry is missing ${key}`);
    }
    assert.equal(r.error, null);
  }
  assert.deepEqual(
    out.results.map((r) => [r.walletId, r.amountEth]),
    [
      ['b1', '0.02'],
      ['b2', '0.03'],
    ]
  );

  assert.equal(ks.sent.length, 2);
  for (const tx of ks.sent) assert.equal(getAddress(tx.to), DEPOSIT, 'the deposit goes to Relay, never to the wallet');
  for (const tx of ks.sent) assert.equal(tx.id, 'm1', 'every deposit is signed by the main wallet');

  // EXACT_OUTPUT, same chain in and out, refunding the payer.
  for (const body of quoted) {
    assert.equal(body.tradeType, 'EXACT_OUTPUT');
    assert.equal(body.originChainId, CHAIN);
    assert.equal(body.destinationChainId, CHAIN);
    assert.equal(getAddress(body.refundTo), MAIN);
    assert.equal(getAddress(body.user), MAIN);
  }
  assert.deepEqual(
    quoted.map((b) => getAddress(b.recipient)),
    [B(1), B(2)]
  );
});

test('a dry run quotes but broadcasts nothing', async () => {
  const { d, ks } = deps({ dryRun: true });
  const out = await relayTransfer.transfer([{ walletId: 'b1', amountEth: '0.02' }], d);
  assert.equal(ks.sent.length, 0);
  assert.equal(out.results[0].hash, null);
  assert.equal(out.results[0].simulated, true);
});

test('transfer refuses the whole run when a target is not ours — nothing is quoted or sent', async () => {
  const { d, ks, quoted } = deps();
  await assert.rejects(
    () => relayTransfer.transfer([{ walletId: 'b1', amountEth: '0.01' }, { walletId: 'ghost', amountEth: '0.01' }], d),
    /is not a v8bundle wallet/
  );
  assert.equal(quoted.length, 0, 'validation happens before the first quote');
  assert.equal(ks.sent.length, 0);
});

// ── per-target failure isolation ─────────────────────────────────────────────

test('one target failing does not throw the run away — every target is still reported', async () => {
  const { d, ks } = deps({
    relayQuote: async (body) => {
      if (getAddress(body.recipient) === B(2)) throw new Error('Relay said no to this one');
      return fakeQuote(body);
    },
  });

  const out = await relayTransfer.transfer(
    [
      { walletId: 'b1', amountEth: '0.01' },
      { walletId: 'b2', amountEth: '0.01' },
      { walletId: 'b3', amountEth: '0.01' },
    ],
    d
  );

  assert.equal(out.results.length, 3, 'every target appears, failed or not');
  assert.ok(out.results[0].hash);
  assert.equal(out.results[0].error, null);
  assert.equal(out.results[1].hash, null);
  assert.match(out.results[1].error, /Relay said no to this one/);
  assert.ok(out.results[2].hash, 'the run carried on past the failure');
  assert.equal(ks.sent.length, 2);
});

test('a failed BROADCAST is isolated too, and named against its wallet', async () => {
  const ks = fakeKs({ count: 2 });
  ks.signer = (id) => ({
    sendTransaction: async (tx) => {
      if (id === 'm1' && ks.sent.length === 0) {
        ks.sent.push({ id, ...tx, failed: true });
        throw new Error('nonce too low');
      }
      ks.sent.push({ id, ...tx });
      return { hash: `hash:${tx.nonce}` };
    },
  });
  const { d } = deps({ keystore: ks });

  const out = await relayTransfer.transfer(
    [
      { walletId: 'b1', amountEth: '0.01' },
      { walletId: 'b2', amountEth: '0.01' },
    ],
    d
  );
  assert.match(out.results[0].error, /Relay deposit from .* failed/);
  assert.ok(out.results[1].hash);
});

// ── pacing ───────────────────────────────────────────────────────────────────

test('the quotes are paced: one gap between each target, at the configured gap', async () => {
  const { d, slept } = deps({ quoteGapMs: 4000 });
  await relayTransfer.transfer(
    [
      { walletId: 'b1', amountEth: '0.01' },
      { walletId: 'b2', amountEth: '0.01' },
      { walletId: 'b3', amountEth: '0.01' },
    ],
    d
  );
  assert.deepEqual(slept, [4000, 4000], 'three targets → two gaps, no gap before the first');
});

test('a bigger batch size sends more back-to-back before pausing', async () => {
  const { d, slept } = deps({ quoteGapMs: 4000, quoteBatchSize: 2, ks: { count: 4 } });
  await relayTransfer.transfer(
    bundleWallets(4).map((w) => ({ walletId: w.id, amountEth: '0.01' })),
    d
  );
  assert.deepEqual(slept, [4000], 'four targets at batch size 2 → one pause');
});

test('a 429 is met with a long, GROWING backoff, and only the quote is retried', async () => {
  let calls = 0;
  const { d, slept, ks } = deps({
    quoteRetries: 3,
    quoteBackoffMs: 20_000,
    quoteGapMs: 0,
    relayQuote: async (body) => {
      calls += 1;
      if (calls < 3) {
        const err = new Error('Could not process request. Please try again later.');
        err.status = 429;
        err.retryable = true;
        throw err;
      }
      return fakeQuote(body);
    },
  });

  const out = await relayTransfer.transfer([{ walletId: 'b1', amountEth: '0.01' }], d);
  assert.equal(calls, 3, 'quoted three times: two refusals then a fill');
  assert.deepEqual(slept, [20_000, 40_000], 'the backoff grows rather than poking the limiter');
  assert.ok(out.results[0].hash);
  assert.equal(ks.sent.length, 1, 'the deposit itself was broadcast exactly once');
});

test('a specific Relay refusal is surfaced immediately, not retried into', async () => {
  let calls = 0;
  const { d } = deps({
    quoteRetries: 3,
    relayQuote: async () => {
      calls += 1;
      throw new Error('unsupported route');
    },
  });
  const out = await relayTransfer.transfer([{ walletId: 'b1', amountEth: '0.01' }], d);
  assert.equal(calls, 1);
  assert.match(out.results[0].error, /unsupported route/);
});

// ── the guards on the quote itself ───────────────────────────────────────────

test('a quote asking for far more than it delivers is refused (drain guard)', async () => {
  const { d, ks } = deps({ relayQuote: async (body) => fakeQuote(body, { multiple: 300n }) });
  const out = await relayTransfer.transfer([{ walletId: 'b1', amountEth: '0.01' }], d);
  assert.match(out.results[0].error, /refusing \(more than 2x the amount/);
  assert.equal(ks.sent.length, 0, 'nothing was signed');
});

test('a deposit quoted FROM someone other than the main wallet is refused', async () => {
  const { d, ks } = deps({
    relayQuote: async (body) => {
      const q = fakeQuote(body);
      q.steps[0].items[0].data.from = B(77);
      return q;
    },
  });
  const out = await relayTransfer.transfer([{ walletId: 'b1', amountEth: '0.01' }], d);
  assert.match(out.results[0].error, /Relay returned a deposit from/);
  assert.equal(ks.sent.length, 0);
});

test('a deposit quoted on another chain is refused', async () => {
  const { d, ks } = deps({
    relayQuote: async (body) => {
      const q = fakeQuote(body);
      q.steps[0].items[0].data.chainId = CHAIN + 1;
      return q;
    },
  });
  const out = await relayTransfer.transfer([{ walletId: 'b1', amountEth: '0.01' }], d);
  assert.match(out.results[0].error, /this server can only sign chain/);
  assert.equal(ks.sent.length, 0);
});

test('the main wallet is checked against what this run has ALREADY committed, not just its balance', async () => {
  // Enough for one 0.6 ETH order (deposit 0.606 + gas), not for two — and the balance
  // read does not move, exactly as it would not if the first deposit were still unmined.
  const { d, ks } = deps({ getBalance: async () => parseEther('0.7') });
  const out = await relayTransfer.transfer(
    [
      { walletId: 'b1', amountEth: '0.6' },
      { walletId: 'b2', amountEth: '0.6' },
    ],
    d
  );
  assert.ok(out.results[0].hash, 'the first order is affordable');
  assert.match(out.results[1].error, /uncommitted/, 'the second sees the first as already spent');
  assert.equal(ks.sent.length, 1);
});

// ── relayOnce, the primitive the sweep shares ────────────────────────────────

test('relayOnce moves ETH in either direction and always reports what it committed', async () => {
  const { d, ks } = deps();
  const out = await relayTransfer.relayOnce(
    { fromWallet: { id: 'b1', address: B(1) }, toAddress: MAIN, amountWei: parseEther('0.05') },
    d
  );
  assert.equal(out.from, B(1));
  assert.equal(out.to, MAIN);
  assert.equal(out.amountEth, '0.05');
  assert.equal(out.depositEth, formatEther((parseEther('0.05') * 101n) / 100n));
  assert.ok(out.committedWei > out.depositWei, 'the commitment includes the gas ceiling');
  assert.equal(ks.sent[0].id, 'b1');
});

test('relayOnce refuses a non-positive amount before it asks Relay anything', async () => {
  const { d, quoted } = deps();
  await assert.rejects(
    () => relayTransfer.relayOnce({ fromWallet: { id: 'b1', address: B(1) }, toAddress: MAIN, amountWei: 0n }, d),
    /positive amount/
  );
  assert.equal(quoted.length, 0);
});
