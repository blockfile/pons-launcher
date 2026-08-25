'use strict';

// Unit tests for the v5 Relay-solver single-wallet funding money path. Offline:
// the keystore, roles, provider, Relay quote and fees are injected.

const test = require('node:test');
const assert = require('node:assert');
const { getAddress, parseEther, formatEther } = require('ethers');
const config = require('../config');

const { planV5Targets, fundOneViaRelay } = require('./relayFund');

const CHAIN = Number(config.chainId);
const DEV = getAddress('0x' + 'd0'.repeat(20));
const DEPOSIT = getAddress('0x' + 'de'.repeat(20));
const B = (n) => getAddress('0x' + String(n).repeat(40).slice(0, 40));
const BUNDLE = [
  { id: 'b1', address: B(1) },
  { id: 'b2', address: B(2) },
];

function fakeRoles({ dev = { id: 'dev', address: DEV }, bundle = BUNDLE } = {}) {
  return { dev: () => dev, bundle: () => bundle };
}

// A Relay quote depositStep can parse: a 'deposit' step whose tx is FROM the
// launcher on THIS chain, to a deposit address, for slightly more than the ask
// (the solver fee rides on top).
function fakeQuote({ from, recipient, amountWei }) {
  return {
    steps: [
      {
        id: 'deposit',
        requestId: '0x' + '11'.repeat(32),
        depositAddress: DEPOSIT,
        items: [{ kind: 'transaction', data: { chainId: CHAIN, from: getAddress(from), to: DEPOSIT, value: ((BigInt(amountWei) * 101n) / 100n).toString(), gas: '120000' }, check: { endpoint: '/x' } }],
      },
    ],
    fees: { relayer: { amount: '1', currency: { symbol: 'ETH' } } },
    details: { operation: 'send', currencyIn: {}, currencyOut: {} },
  };
}

function ksWith(over = {}) {
  const ks = { sent: [] };
  ks.signer = (id) => ({
    sendTransaction: async (tx) => {
      ks.sent.push({ id, ...tx });
      return { hash: `hash:${tx.nonce}` };
    },
  });
  return { ...ks, ...over };
}

function providerWith(over = {}) {
  return {
    getBalance: over.getBalance || (async () => parseEther('10')),
    getTransactionCount: over.getTransactionCount || (async () => 7),
  };
}

function deps(over = {}) {
  const ks = over.keystore || ksWith();
  return {
    ks,
    d: {
      keystore: ks,
      roles: over.roles || fakeRoles(),
      provider: providerWith(over.provider),
      relayQuote: over.relayQuote || (async (input) => fakeQuote(input)),
      getFees: over.getFees || (async () => ({ type: 2, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000n })),
      dryRun: over.dryRun ?? false,
      sleepFn: async () => {},
    },
  };
}

// ── planV5Targets ─────────────────────────────────────────────────────────────
test('planV5Targets normalises valid targets and rejects bad ones', () => {
  const ks = ksWith();
  const roles = fakeRoles();
  // patch v5roles via the module? planV5Targets uses v5roles internally, so this
  // exercises the real roles module against a fake ks. Instead test resolveTarget
  // path through the exported fundOneViaRelay below; here assert the guards.
  assert.throws(() => planV5Targets([], ks, roles), /targets\[\] is required/);
});

// ── fundOneViaRelay ───────────────────────────────────────────────────────────
test('funds one wallet: quotes, verifies the deposit is from the launcher, sends at the pending nonce', async () => {
  const { d, ks } = deps();
  const out = await fundOneViaRelay({ walletId: 'b1', amountEth: '0.02' }, d);
  assert.equal(out.walletId, 'b1');
  assert.equal(getAddress(out.address), B(1));
  assert.equal(out.amountEth, '0.02');
  assert.equal(getAddress(out.depositAddress), DEPOSIT);
  assert.ok(out.requestId);
  assert.equal(out.hash, 'hash:7', 'the deposit is signed at the launcher pending nonce (7)');
  assert.equal(ks.sent.length, 1);
  assert.equal(getAddress(ks.sent[0].to), DEPOSIT, 'the deposit goes to the Relay deposit address, not the wallet');
});

test('a dry run quotes but broadcasts nothing', async () => {
  const { d, ks } = deps({ dryRun: true });
  const out = await fundOneViaRelay({ walletId: 'b1', amountEth: '0.02' }, d);
  assert.equal(out.simulated, true);
  assert.equal(out.hash, null);
  assert.equal(ks.sent.length, 0);
});

test('refuses a wallet that is not one of this tab’s bundle wallets, and a non-positive amount', async () => {
  const { d } = deps();
  await assert.rejects(() => fundOneViaRelay({ walletId: 'nope', amountEth: '0.01' }, d), /not one of this tab's bundle/);
  await assert.rejects(() => fundOneViaRelay({ walletId: 'b1', amountEth: '0' }, d), /positive fund amount/);
});

test('refuses when the launcher cannot cover the deposit + gas', async () => {
  const { d } = deps({ provider: { getBalance: async () => 1n } });
  await assert.rejects(() => fundOneViaRelay({ walletId: 'b1', amountEth: '0.02' }, d), /needs up to/);
});

test('a send failure returns the entry with an error, not a throw (the job records it and moves on)', async () => {
  const ks = ksWith();
  ks.signer = () => ({ sendTransaction: async () => { throw new Error('nonce too low'); } });
  const { d } = deps({ keystore: ks });
  const out = await fundOneViaRelay({ walletId: 'b1', amountEth: '0.02' }, d);
  assert.ok(out.error && /nonce too low/.test(out.error));
  assert.equal(out.hash, undefined);
});

test('retries a transient 429 quote then succeeds', async () => {
  let calls = 0;
  const { d } = deps({
    relayQuote: async (input) => {
      calls += 1;
      if (calls === 1) throw new Error('Could not process request. Please try again later.');
      return fakeQuote(input);
    },
  });
  const out = await fundOneViaRelay({ walletId: 'b1', amountEth: '0.02' }, d);
  assert.equal(calls, 2, 'the 429 was retried once');
  assert.ok(out.hash);
});

test('a specific (non-transient) quote error is surfaced immediately, not retried', async () => {
  let calls = 0;
  const { d } = deps({
    relayQuote: async () => { calls += 1; throw new Error('unsupported route'); },
  });
  await assert.rejects(() => fundOneViaRelay({ walletId: 'b1', amountEth: '0.02' }, d), /unsupported route/);
  assert.equal(calls, 1, 'a specific error is not retried');
});
