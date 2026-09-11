'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, parseEther } = require('ethers');
const sweep = require('./sweep');

const A = {
  f1: '0x1111111111111111111111111111111111111111',
  f2: '0x2222222222222222222222222222222222222222',
  sm1: '0x3333333333333333333333333333333333333333',
  sm2: '0x6666666666666666666666666666666666666666',
  s1: '0x4444444444444444444444444444444444444444',
  s2: '0x5555555555555555555555555555555555555555',
  x1: '0x7777777777777777777777777777777777777777',
};

// f1, f2: funders. sm1, sm2: flagged super-mains. s1, s2: aged seed wallets (s1 withdrawn).
const MASTERS = [
  { id: 'f1', address: A.f1, role: 'v4master' },
  { id: 'f2', address: A.f2, role: 'v4master' },
  { id: 'sm1', address: A.sm1, role: 'v4master' },
  { id: 'sm2', address: A.sm2, role: 'v4master' },
];
const SEEDS = [
  { id: 's1', address: A.s1, role: 'v4seed' },
  { id: 's2', address: A.s2, role: 'v4seed' },
];

// EVERY wallet holds ETH — seeds and super-mains included — so "was not swept" can never
// pass just because a wallet happened to be empty.
const RICH = {
  [A.f1]: parseEther('0.5'),
  [A.f2]: parseEther('0.5'),
  [A.sm1]: parseEther('1'),
  [A.sm2]: parseEther('1'),
  [A.s1]: parseEther('0.5'),
  [A.s2]: parseEther('0.5'),
};

const GWEI = 1_000_000_000n;
const FEES = { type: 2, maxFeePerGas: GWEI, maxPriorityFeePerGas: 1_000_000n };
const FUNDERS = ['f1', 'f2'];
const NEVER = ['sm1', 'sm2', 's1', 's2'];

// A signed "transaction" in these fakes is the signing wallet's id, hex-encoded — enough for
// the sweep to hash it and for the fake node to know who sent it.
const rawOf = (id) => `0x${Buffer.from(id).toString('hex')}`;
const idOfRaw = (raw) => Buffer.from(raw.slice(2), 'hex').toString();
const hashOf = (id) => keccak256(rawOf(id));

function fakeKs(log, { extraMasters = [], signFails = [] } = {}) {
  const masters = [...MASTERS, ...extraMasters];
  return {
    walletsWithRole: (r) => {
      log.roleReads.push(r);
      return r === 'v4master' ? masters : r === 'v4seed' ? SEEDS : [];
    },
    walletWithRole: () => null,
    signer: (id) => ({
      populateTransaction: async (tx) => {
        if (signFails.includes(id)) throw new Error('keystore could not decrypt this wallet');
        return { ...tx, nonce: 0, chainId: 4663 };
      },
      signTransaction: async (tx) => {
        log.signed.push({ from: id, ...tx });
        return rawOf(id);
      },
    }),
  };
}

function fakeStore({
  superMains = ['sm1', 'sm2'],
  campaigns = [],
  claimed = ['s1', 's2'],
  withdrawn = ['s1'],
  graduated = [],
} = {}) {
  return {
    superMainIds: () => new Set(superMains),
    // The same array on every call, so a test can start a campaign mid-sweep by pushing to it.
    campaigns: () => campaigns,
    claimedSeedIds: () => new Set(claimed),
    withdrawnSeedIds: () => new Set(withdrawn),
    graduated: () => graduated.map((id) => ({ id })),
  };
}

function harness(o = {}) {
  const balances = o.balances || RICH;
  const log = {
    roleReads: [],
    signed: [],
    broadcast: [],
    transfers: [],
    balanceReads: [],
    estimates: [],
    activity: null,
  };
  const ks = fakeKs(log, { extraMasters: o.extraMasters, signFails: o.signFails });
  const store = fakeStore(o.store);
  const deps = {
    keystoreForFn: () => ks,
    storeForFn: () => store,
    activityForFn: () => ({
      record: (tab, msg, data) => {
        if (o.activityFails) throw new Error('ENOSPC: no space left on device');
        log.activity = { tab, msg, data };
      },
    }),
    rpc: {
      getBalance: async (a) => {
        log.balanceReads.push(a);
        return BigInt(balances[a] ?? 0n);
      },
      estimateGas: async (tx) => {
        log.estimates.push(tx);
        return o.estimateGas ? o.estimateGas(tx) : 40_000n;
      },
      broadcastTransaction: async (raw) => {
        const id = idOfRaw(raw);
        log.broadcast.push(id);
        if (o.onBroadcast) o.onBroadcast(id, store);
        if ((o.broadcastFails || []).includes(id)) throw new Error('could not read the block number');
        return { hash: keccak256(raw) };
      },
      getTransaction: async (hash) => ((o.nodeHas || []).map(hashOf).includes(hash) ? { hash } : null),
    },
    relay: {
      transfer: async ({ fromWallet, toAddress, amountWei }, tDeps) => {
        log.transfers.push({ from: fromWallet.id, to: toAddress, amountWei });
        if (o.relayFail) await o.relayFail(log.transfers.length, tDeps, store);
        return o.relaySimulated ? { hash: null, simulated: true } : { hash: '0xh', requestId: '0xr' };
      },
    },
    // What relay.js would fetch through; never the network in a test.
    fetch: async () => ({ status: o.fetchStatus ?? 200 }),
    getFeesFn: async () => o.fees || FEES,
    waitForReceiptFn: o.waitForReceipt || (async () => ({ status: 1 })),
    dryRun: o.dryRun ?? false,
  };
  return { deps, log, store };
}

const mentioned = (out) => [...(out.wallets || []), ...(out.skipped || [])].map((r) => r.walletId);

// ── the aged-wallet rule ─────────────────────────────────────────────────────

test('funders are the v4masters that are not super-mains — the seed role is never read', () => {
  const log = { roleReads: [], signed: [] };
  const out = sweep._private.funders(fakeKs(log), fakeStore());
  assert.deepEqual(out.map((w) => w.id), FUNDERS);
  assert.ok(!log.roleReads.includes('v4seed'));
});

test('a seed re-roled into v4master by hand is still never a funder — the store remembers it was a seed', async () => {
  for (const record of ['claimed', 'withdrawn', 'graduated']) {
    const { deps, log } = harness({
      extraMasters: [{ id: 'x1', address: A.x1, role: 'v4master' }],
      store: { [record]: ['x1'] },
      balances: { ...RICH, [A.x1]: parseEther('0.5') },
    });
    const p = await sweep.preview('u', { destinationId: 'sm1', route: 'direct' }, deps);
    assert.ok(!mentioned(p).includes('x1'), `${record}: not even considered`);
    assert.ok(!log.balanceReads.includes(A.x1), `${record}: its balance is never read`);
    await assert.rejects(
      () => sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: ['x1'], confirm: true }, deps),
      /not a funder/
    );
    assert.equal(log.signed.length, 0, `${record}: nothing signed`);
  }
});

for (const route of ['relay', 'direct']) {
  test(`${route}: preview names funders only — never a super-main, never an aged seed`, async () => {
    const { deps, log } = harness();
    const p = await sweep.preview('u', { destinationId: 'sm1', route }, deps);
    assert.equal(p.route, route);
    assert.deepEqual(p.wallets.map((w) => w.walletId), FUNDERS);
    for (const id of NEVER) assert.ok(!mentioned(p).includes(id), `${id} is not even considered`);
    assert.ok(!log.roleReads.includes('v4seed'), 'the seed role is never read');
    assert.ok(!log.balanceReads.includes(A.s1) && !log.balanceReads.includes(A.s2), 'no seed balance is read');
  });

  test(`${route}: run moves funders only, to the chosen super-main`, async () => {
    const { deps, log } = harness();
    const out = await sweep.run('u', { destinationId: 'sm1', route, walletIds: FUNDERS, confirm: true }, deps);
    const sends = route === 'direct' ? log.signed : log.transfers;
    assert.deepEqual(sends.map((t) => t.from), FUNDERS);
    assert.ok(sends.every((t) => t.to === A.sm1), 'every send lands at the chosen super-main');
    for (const id of NEVER) assert.ok(!mentioned(out).includes(id));
    assert.ok(!log.roleReads.includes('v4seed'));
  });

  test(`${route}: a run naming a seed, a super-main or an unknown id is refused whole — nothing read, nothing sent`, async () => {
    for (const bad of ['s1', 's2', 'sm1', 'sm2', 'nope']) {
      const { deps, log } = harness();
      await assert.rejects(
        () => sweep.run('u', { destinationId: 'sm1', route, walletIds: ['f1', bad], confirm: true }, deps),
        /not a funder/
      );
      assert.equal(log.balanceReads.length, 0, `${bad}: refused before any balance is read`);
      assert.equal(log.signed.length + log.transfers.length, 0, `${bad}: nothing sent`);
    }
  });
}

// ── the destination ──────────────────────────────────────────────────────────

test('the destination must be a flagged super-main', async () => {
  for (const bad of ['f1', 's1', 'nope', undefined]) {
    const { deps } = harness();
    await assert.rejects(() => sweep.preview('u', { destinationId: bad }, deps), /super-main/);
  }
});

test('with no super-main flagged, the sweep says to flag one first', async () => {
  const { deps } = harness({ store: { superMains: [] } });
  await assert.rejects(() => sweep.preview('u', { destinationId: 'sm1' }, deps), /flag one in step 1/);
});

// ── live campaigns ───────────────────────────────────────────────────────────

test('a funder whose campaign is running, paused or halted is skipped and named, never sent', async () => {
  for (const status of ['running', 'paused', 'halted']) {
    const { deps, log } = harness({ store: { campaigns: [{ status, masterWalletId: 'f2' }] } });
    const p = await sweep.preview('u', { destinationId: 'sm1' }, deps);
    assert.deepEqual(p.wallets.map((w) => w.walletId), ['f1'], status);
    assert.match(p.skipped.find((s) => s.walletId === 'f2').reason, /campaign/);

    const out = await sweep.run('u', { destinationId: 'sm1', walletIds: FUNDERS, confirm: true }, deps);
    assert.deepEqual(log.transfers.map((t) => t.from), ['f1'], `${status}: f2 is held back`);
    assert.ok(out.skipped.some((s) => s.walletId === 'f2'), 'a ticked funder that went busy is named');
  }
});

test('a funder whose campaign is complete or cancelled is free to sweep', async () => {
  const { deps } = harness({
    store: {
      campaigns: [
        { status: 'complete', masterWalletId: 'f1' },
        { status: 'cancelled', masterWalletId: 'f2' },
      ],
    },
  });
  const p = await sweep.preview('u', { destinationId: 'sm1' }, deps);
  assert.deepEqual(p.wallets.map((w) => w.walletId), FUNDERS);
});

test('a funder a live split still owes a transfer is skipped; once it is paid, the funder is free', async () => {
  const owing = {
    status: 'running',
    kind: 'split',
    masterWalletId: 'sm1',
    transfers: [{ walletId: 'f2', status: 'pending' }],
  };
  const { deps } = harness({ store: { campaigns: [owing] } });
  const p = await sweep.preview('u', { destinationId: 'sm1' }, deps);
  assert.deepEqual(p.wallets.map((w) => w.walletId), ['f1']);
  assert.match(p.skipped.find((s) => s.walletId === 'f2').reason, /owed/);

  const paid = { ...owing, transfers: [{ walletId: 'f2', status: 'sent' }] };
  const later = harness({ store: { campaigns: [paid] } });
  const p2 = await sweep.preview('u', { destinationId: 'sm1' }, later.deps);
  assert.deepEqual(p2.wallets.map((w) => w.walletId), FUNDERS);
});

for (const route of ['relay', 'direct']) {
  test(`${route}: a campaign started on a funder mid-sweep stops that funder being swept`, async () => {
    const start = (store) => store.campaigns().push({ status: 'running', masterWalletId: 'f2', name: 'late' });
    const { deps, log } = harness(
      route === 'relay'
        ? {
            relayFail: async (n, _tDeps, store) => {
              if (n === 1) start(store);
            },
          }
        : {
            onBroadcast: (id, store) => {
              if (id === 'f1') start(store);
            },
          }
    );
    const out = await sweep.run('u', { destinationId: 'sm1', route, walletIds: FUNDERS, confirm: true }, deps);
    const sent = route === 'direct' ? log.broadcast : log.transfers.map((t) => t.from);
    assert.deepEqual(sent, ['f1'], 'f2 is left alone');
    assert.ok(!out.wallets.some((w) => w.walletId === 'f2'));
    assert.match(out.skipped.find((s) => s.walletId === 'f2').reason, /campaign/);
  });
}

// ── route ────────────────────────────────────────────────────────────────────

test('route defaults to relay and refuses anything else', async () => {
  const { deps } = harness();
  assert.equal((await sweep.preview('u', { destinationId: 'sm1' }, deps)).route, 'relay');
  await assert.rejects(() => sweep.preview('u', { destinationId: 'sm1', route: 'bridge' }, deps), /route/);
  await assert.rejects(
    () => sweep.run('u', { destinationId: 'sm1', route: 'bridge', walletIds: FUNDERS, confirm: true }, deps),
    /route/
  );
});

test('route: null means relay on preview and run alike; an empty string is refused on both', async () => {
  const { deps } = harness();
  assert.equal((await sweep.preview('u', { destinationId: 'sm1', route: null }, deps)).route, 'relay');
  const out = await sweep.run('u', { destinationId: 'sm1', route: null, walletIds: FUNDERS, confirm: true }, deps);
  assert.equal(out.route, 'relay');
  await assert.rejects(() => sweep.preview('u', { destinationId: 'sm1', route: '' }, deps), /route/);
  await assert.rejects(
    () => sweep.run('u', { destinationId: 'sm1', route: '', walletIds: FUNDERS, confirm: true }, deps),
    /route/
  );
});

test('the relay route never signs a direct send; the direct route never places a Relay order', async () => {
  const relay = harness();
  await sweep.run('u', { destinationId: 'sm1', walletIds: FUNDERS, confirm: true }, relay.deps);
  assert.equal(relay.log.signed.length, 0);

  const direct = harness();
  await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: FUNDERS, confirm: true }, direct.deps);
  assert.equal(direct.log.transfers.length, 0);
});

// ── relay amounts and rate limit ─────────────────────────────────────────────

test('relay: sends 97% of the balance after gas, and skips a funder under the dust floor', async () => {
  const { deps } = harness({ balances: { [A.f1]: parseEther('0.5'), [A.f2]: parseEther('0.001') } });
  const p = await sweep.preview('u', { destinationId: 'sm1' }, deps);
  const gas = 50_000n * GWEI;
  assert.equal(p.wallets[0].sendWeiRaw, (((parseEther('0.5') - gas) * 97n) / 100n).toString());
  assert.match(p.skipped.find((s) => s.walletId === 'f2').reason, /floor/);
});

test('relay stops at the first rate-limit refusal; the rest are not attempted and keep their ETH', async () => {
  for (const message of ['Could not process request. Please try again later.', 'Relay returned 429']) {
    const { deps, log } = harness({
      relayFail: async (n) => {
        if (n === 1) throw new Error(message);
      },
    });
    const out = await sweep.run('u', { destinationId: 'sm1', walletIds: FUNDERS, confirm: true }, deps);
    assert.equal(log.transfers.length, 1, `${message}: no second quote while Relay is blocking`);
    assert.deepEqual(out.wallets.map((w) => w.status), ['failed', 'not-attempted']);
    assert.equal(out.totals.notAttempted, 1);
  }
});

test('relay: an HTTP 429 stops the sweep however Relay words the refusal', async () => {
  const { deps, log } = harness({
    fetchStatus: 429,
    relayFail: async (n, tDeps) => {
      if (n === 1) {
        await tDeps.fetch('https://relay.example/quote/v2', {});
        throw new Error('Quota exceeded');
      }
    },
  });
  const out = await sweep.run('u', { destinationId: 'sm1', walletIds: FUNDERS, confirm: true }, deps);
  assert.equal(log.transfers.length, 1);
  assert.deepEqual(out.wallets.map((w) => w.status), ['failed', 'not-attempted']);
});

test('relay keeps going past an error that is not a rate limit', async () => {
  const { deps, log } = harness({
    relayFail: async (n) => {
      if (n === 1) throw new Error('Relay quote did not include a deposit transaction');
    },
  });
  const out = await sweep.run('u', { destinationId: 'sm1', walletIds: FUNDERS, confirm: true }, deps);
  assert.equal(log.transfers.length, 2);
  assert.deepEqual(out.wallets.map((w) => w.status), ['failed', 'sent']);
});

test('relay under DRY_RUN reports each order simulated', async () => {
  const { deps } = harness({ relaySimulated: true });
  const out = await sweep.run('u', { destinationId: 'sm1', walletIds: FUNDERS, confirm: true }, deps);
  assert.ok(out.wallets.every((w) => w.status === 'simulated'));
});

// ── direct amounts ───────────────────────────────────────────────────────────

test('directGasLimit: the estimate plus 20%, never under the 30k floor, the floor when it fails', async () => {
  const at = (est) => ({ estimateGas: async () => est });
  assert.equal(await sweep._private.directGasLimit(at(40_000n), A.f1, A.sm1), 48_000n);
  assert.equal(await sweep._private.directGasLimit(at(21_195n), A.f1, A.sm1), 30_000n);
  const broken = {
    estimateGas: async () => {
      throw new Error('rpc down');
    },
  };
  assert.equal(await sweep._private.directGasLimit(broken, A.f1, A.sm1), 30_000n);
});

test('direct: the gas estimate comes from a funder that holds ETH — never an empty one, never a seed', async () => {
  const { deps, log } = harness({ balances: { ...RICH, [A.f1]: 0n } });
  await sweep.preview('u', { destinationId: 'sm1', route: 'direct' }, deps);
  assert.equal(log.estimates.length, 1);
  assert.equal(log.estimates[0].from, A.f2);
  assert.equal(log.estimates[0].to, A.sm1);
});

test('direct: sends the balance minus its own gas ceiling, signed with that gas limit', async () => {
  const { deps, log } = harness({ balances: { [A.f1]: parseEther('0.5') } });
  const out = await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: ['f1'], confirm: true }, deps);
  const reserve = 48_000n * GWEI; // 40k estimate × 1.2, at a 1 gwei ceiling
  assert.equal(log.signed.length, 1);
  assert.equal(log.signed[0].value, parseEther('0.5') - reserve);
  assert.equal(log.signed[0].gasLimit, 48_000n);
  assert.equal(log.signed[0].maxFeePerGas, GWEI);
  assert.equal(out.wallets[0].status, 'confirmed');
  assert.equal(out.wallets[0].hash, hashOf('f1'));
  assert.equal(out.totals.moved, 1);
});

test('direct: legacy (type-0) fees reserve gasLimit × gasPrice', async () => {
  const { deps, log } = harness({ fees: { type: 0, gasPrice: 2n * GWEI }, balances: { [A.f1]: parseEther('0.5') } });
  await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: ['f1'], confirm: true }, deps);
  assert.equal(log.signed[0].value, parseEther('0.5') - 48_000n * 2n * GWEI);
  assert.equal(log.signed[0].gasPrice, 2n * GWEI);
});

test('direct: a funder that cannot cover its own gas is skipped and named', async () => {
  const { deps } = harness({ balances: { [A.f1]: parseEther('0.5'), [A.f2]: 40_000n * GWEI } });
  const p = await sweep.preview('u', { destinationId: 'sm1', route: 'direct' }, deps);
  assert.deepEqual(p.wallets.map((w) => w.walletId), ['f1']);
  assert.match(p.skipped.find((s) => s.walletId === 'f2').reason, /own gas/);
});

test('direct: a reverted receipt and a missing receipt each report as such', async () => {
  const receipts = { [hashOf('f1')]: { status: 0 }, [hashOf('f2')]: null };
  const { deps } = harness({ waitForReceipt: async (_rpc, hash) => receipts[hash] });
  const out = await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: FUNDERS, confirm: true }, deps);
  assert.deepEqual(out.wallets.map((w) => w.status), ['reverted', 'pending']);
  assert.equal(out.totals.moved, 0);
  assert.equal(out.totals.failed, 1);
  assert.equal(out.totals.pending, 1);
});

test('direct: a broadcast that throws after the node took the transaction is not reported as failed', async () => {
  const { deps } = harness({ broadcastFails: ['f1'], nodeHas: ['f1'] });
  const out = await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: FUNDERS, confirm: true }, deps);
  const f1 = out.wallets.find((w) => w.walletId === 'f1');
  assert.equal(f1.status, 'confirmed');
  assert.equal(f1.hash, hashOf('f1'));
  assert.equal(out.totals.moved, 2);
});

test('direct: a broadcast the node never saw is failed — with its hash, so it can be looked up', async () => {
  const { deps } = harness({ broadcastFails: ['f1'] });
  const out = await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: FUNDERS, confirm: true }, deps);
  const f1 = out.wallets.find((w) => w.walletId === 'f1');
  assert.equal(f1.status, 'failed');
  assert.equal(f1.hash, hashOf('f1'));
  assert.match(f1.error, /block number/);
  assert.equal(out.wallets.find((w) => w.walletId === 'f2').status, 'confirmed', 'one failure does not stop the rest');
});

test('direct: a wallet that cannot be signed for is failed with no hash — nothing was sent', async () => {
  const { deps, log } = harness({ signFails: ['f1'] });
  const out = await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: FUNDERS, confirm: true }, deps);
  const f1 = out.wallets.find((w) => w.walletId === 'f1');
  assert.equal(f1.status, 'failed');
  assert.equal(f1.hash, null);
  assert.deepEqual(log.broadcast, ['f2']);
});

test('direct waits at most 30 s for each receipt', async () => {
  let opts;
  const { deps } = harness({
    waitForReceipt: async (_rpc, _hash, o) => {
      opts = o;
      return { status: 1 };
    },
  });
  await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: ['f1'], confirm: true }, deps);
  assert.equal(opts.timeoutMs, 30_000);
});

test('direct under DRY_RUN signs nothing and reports simulated', async () => {
  const { deps, log } = harness({ dryRun: true });
  const out = await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: FUNDERS, confirm: true }, deps);
  assert.equal(log.signed.length, 0);
  assert.equal(log.broadcast.length, 0);
  assert.ok(out.wallets.every((w) => w.status === 'simulated'));
  assert.equal(out.dryRun, true);
});

// ── run gates ────────────────────────────────────────────────────────────────

test('run requires confirm', async () => {
  const { deps, log } = harness();
  await assert.rejects(() => sweep.run('u', { destinationId: 'sm1', walletIds: FUNDERS }, deps), /confirm/);
  assert.equal(log.transfers.length, 0);
});

test('run requires the ticked walletIds', async () => {
  for (const walletIds of [undefined, [], 'f1']) {
    const { deps } = harness();
    await assert.rejects(() => sweep.run('u', { destinationId: 'sm1', walletIds, confirm: true }, deps), /walletIds/);
  }
});

test('an unticked funder is left alone and not reported', async () => {
  const { deps, log } = harness();
  const out = await sweep.run('u', { destinationId: 'sm1', walletIds: ['f2'], confirm: true }, deps);
  assert.deepEqual(log.transfers.map((t) => t.from), ['f2']);
  assert.ok(!mentioned(out).includes('f1'));
});

test('run refuses when nothing ticked clears the floor', async () => {
  const { deps } = harness({ balances: { [A.f1]: parseEther('0.001') } });
  await assert.rejects(
    () => sweep.run('u', { destinationId: 'sm1', walletIds: ['f1'], confirm: true }, deps),
    /nothing to sweep/
  );
});

// ── the record ───────────────────────────────────────────────────────────────

test('the activity log records the route, and a direct sweep says it links the funders', async () => {
  const { deps, log } = harness();
  await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: FUNDERS, confirm: true }, deps);
  assert.equal(log.activity.tab, 'v4');
  assert.equal(log.activity.data.route, 'direct');
  assert.match(log.activity.msg, /links these funders/);
});

test('a sweep that ran is still reported when the activity log cannot be written', async () => {
  const { deps } = harness({ activityFails: true });
  const out = await sweep.run('u', { destinationId: 'sm1', route: 'direct', walletIds: FUNDERS, confirm: true }, deps);
  assert.equal(out.totals.moved, 2);
  assert.match(out.logWarning, /activity log/);
});
