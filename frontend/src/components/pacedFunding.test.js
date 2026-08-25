import test from 'node:test';
import assert from 'node:assert/strict';

import { pacedDelayMs, runPacedFunding } from './pacedFunding.js';

// ── pacedDelayMs ─────────────────────────────────────────────────────────────
test('pacedDelayMs stays inside [4000, 7000] and is an integer', () => {
  for (let i = 0; i < 2000; i++) {
    const ms = pacedDelayMs();
    assert.ok(Number.isInteger(ms), `${ms} is not an integer`);
    assert.ok(ms >= 4000 && ms <= 7000, `${ms} out of range`);
  }
});

test('pacedDelayMs covers both ends of the range', () => {
  assert.equal(pacedDelayMs(4000, 7000, () => 0), 4000);
  assert.equal(pacedDelayMs(4000, 7000, () => 0.999999), 7000);
  assert.equal(pacedDelayMs(10, 20, () => 0.5), 15);
});

// ── runPacedFunding ──────────────────────────────────────────────────────────
const D1 = '0x1111111111111111111111111111111111111111';
const D2 = '0x2222222222222222222222222222222222222222';

function harness({ postImpl } = {}) {
  const h = { posts: [], waits: [], reports: [], stop: false };
  h.post =
    postImpl ||
    (async (body) => {
      h.posts.push(body);
      const t = body.targets[0];
      return [
        {
          walletId: t.walletId,
          address: `0xADDR_${t.walletId}`,
          amountEth: t.amountEth,
          hash: `0xh${h.posts.length}`,
          batched: true,
          disperser: body.disperser,
        },
      ];
    });
  h.wait = async (ms) => {
    h.waits.push(ms);
  };
  h.report = (text) => h.reports.push(text);
  h.stopped = () => h.stop;
  return h;
}

const THREE = [
  { walletId: 'w1', amountEth: '0.01' },
  { walletId: 'w2', amountEth: '0.02' },
  { walletId: 'w3', amountEth: '0.03' },
];

test('posts one wallet per request, in order, with variant v1 and viaDisperser', async () => {
  const h = harness();
  const out = await runPacedFunding({ targets: THREE, dispersers: [D1], ...h });

  assert.equal(h.posts.length, 3);
  assert.deepEqual(
    h.posts.map((p) => p.targets),
    [[THREE[0]], [THREE[1]], [THREE[2]]]
  );
  for (const p of h.posts) {
    assert.equal(p.variant, 'v1');
    assert.equal(p.viaDisperser, true);
    assert.equal(p.disperser, D1);
  }
  assert.deepEqual(out, { funded: 3, total: 3, stopped: false, error: null });
});

test('waits between wallets but not after the last one', async () => {
  const h = harness();
  await runPacedFunding({ targets: THREE, dispersers: [D1], ...h });
  assert.equal(h.waits.length, 2, 'two gaps for three wallets');
  for (const ms of h.waits) assert.ok(ms >= 4000 && ms <= 7000, `${ms} out of range`);
});

test('rotates across several dispersers', async () => {
  const h = harness();
  await runPacedFunding({ targets: THREE, dispersers: [D1, D2], ...h });
  assert.deepEqual(
    h.posts.map((p) => p.disperser),
    [D1, D2, D1]
  );
});

test('reports progress per wallet and a final summary', async () => {
  const h = harness();
  await runPacedFunding({ targets: THREE, dispersers: [D1], ...h });
  const last = h.reports[h.reports.length - 1];
  assert.match(last, /funded 0xADDR_w1 0\.01 ETH via 0x1111/);
  assert.match(last, /0xh1/);
  assert.match(last, /funded 3\/3 wallets via disperser/);
});

test('reports dry-run rows as simulated', async () => {
  const h = harness({
    postImpl: async (body) => {
      h.posts.push(body);
      const t = body.targets[0];
      return [{ walletId: t.walletId, address: `0xADDR_${t.walletId}`, amountEth: t.amountEth, hash: null, simulated: true }];
    },
  });
  const out = await runPacedFunding({ targets: THREE.slice(0, 1), dispersers: [D1], ...h });
  assert.deepEqual(out, { funded: 1, total: 1, stopped: false, error: null });
  assert.match(h.reports[h.reports.length - 1], /simulated 0xADDR_w1 0\.01 ETH \(dry run\)/);
});

test('stops on the first thrown request error and says what was funded and what remains', async () => {
  const h = harness({
    postImpl: async (body) => {
      h.posts.push(body);
      if (h.posts.length === 2) throw new Error('rate limited');
      const t = body.targets[0];
      return [
        {
          walletId: t.walletId,
          address: `0xADDR_${t.walletId}`,
          amountEth: t.amountEth,
          hash: '0xh',
          batched: true,
          disperser: body.disperser,
        },
      ];
    },
  });
  const out = await runPacedFunding({ targets: THREE, dispersers: [D1], ...h });

  assert.equal(h.posts.length, 2, 'the third wallet is never posted');
  assert.deepEqual(out, { funded: 1, total: 3, stopped: false, error: 'rate limited' });
  const last = h.reports[h.reports.length - 1];
  assert.match(last, /stopped at wallet 2\/3: rate limited/);
  assert.match(last, /funded: 1 wallet\(s\); remaining: 2/);
  assert.match(last, /clear the funded rows' Fund amounts before re-sending/);
});

test('treats a result row carrying error as a failure and stops', async () => {
  const h = harness({
    postImpl: async (body) => {
      h.posts.push(body);
      const t = body.targets[0];
      if (h.posts.length === 1) {
        return [
          {
            walletId: t.walletId,
            address: `0xADDR_${t.walletId}`,
            amountEth: t.amountEth,
            error: 'execution reverted',
            disperser: body.disperser,
          },
        ];
      }
      return [];
    },
  });
  const out = await runPacedFunding({ targets: THREE, dispersers: [D1], ...h });
  assert.equal(h.posts.length, 1);
  assert.deepEqual(out, { funded: 0, total: 3, stopped: false, error: 'execution reverted' });
  assert.match(h.reports[h.reports.length - 1], /stopped at wallet 1\/3: execution reverted/);
});

test('an operator Stop ends the run before the next post', async () => {
  const h = harness();
  h.wait = async () => {
    h.stop = true; // pressed during the gap
  };
  const out = await runPacedFunding({ targets: THREE, dispersers: [D1], ...h });
  assert.equal(h.posts.length, 1);
  assert.deepEqual(out, { funded: 1, total: 3, stopped: true, error: null });
  assert.match(h.reports[h.reports.length - 1], /stopped by operator after 1\/3 wallets/);
});

test('refuses to start without a disperser and posts nothing', async () => {
  const h = harness();
  const out = await runPacedFunding({ targets: THREE, dispersers: [], ...h });
  assert.equal(h.posts.length, 0);
  assert.deepEqual(out, {
    funded: 0,
    total: 3,
    stopped: false,
    error: 'no disperser deployed — deploy one in step 2 first',
  });
  assert.match(h.reports[h.reports.length - 1], /ERROR: no disperser deployed/);
});
