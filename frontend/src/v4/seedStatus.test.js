import test from 'node:test';
import assert from 'node:assert/strict';

import { seedStatus, orderByStatus, statusCounts } from './seedStatus.js';

const NOW = Date.parse('2026-09-12T12:00:00Z');
const HOUR = 3_600_000;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const at = (w, fact) => seedStatus(w, fact, { seasonDays: 1, now: NOW });

test('a wallet funded a day or more ago is ready, from whatever run', () => {
  const s = at({ daysSinceFunded: 12, fundedAt: iso(12 * 24 * HOUR), campaignId: 'old' }, { status: 'sent' });
  assert.equal(s.key, 'ready');
  assert.equal(s.ready, true);
  assert.equal(at({ daysSinceFunded: 1, fundedAt: iso(25 * HOUR), campaignId: 'new' }, { status: 'sent' }).ready, true);
});

test('readiness follows the clock, not the last server read: a wallet turns ready at 24h on its own', () => {
  // The server's daysSinceFunded was read an hour ago, when the wallet was 23h old,
  // and still says 0. The funding time says it has now crossed the line.
  const stale = { daysSinceFunded: 0, fundedAt: iso(24 * HOUR + 60_000), campaignId: 'c' };
  assert.equal(at(stale, { status: 'sent' }).key, 'ready');
  // One minute short is still aging.
  assert.equal(at({ daysSinceFunded: 0, fundedAt: iso(24 * HOUR - 60_000) }, { status: 'sent' }).key, 'aging');
  // Exactly 24h is ready — the server's floor((now - fundedAt) / day) >= 1 agrees.
  assert.equal(at({ daysSinceFunded: 0, fundedAt: iso(24 * HOUR) }, { status: 'sent' }).key, 'ready');
  // With no readable funding time, the server's day count still decides.
  assert.equal(at({ daysSinceFunded: 2, fundedAt: null }, { status: 'sent' }).key, 'ready');
});

test('a wallet funded under a day ago is aging, with the hours it still needs', () => {
  const s = at({ daysSinceFunded: 0, fundedAt: iso(10 * HOUR), campaignId: 'c' }, { status: 'sent' });
  assert.equal(s.key, 'aging');
  assert.equal(s.ready, false);
  assert.equal(s.label, 'aging · 14h left');
  // Minutes from ready still says 1h, never 0h.
  assert.equal(at({ daysSinceFunded: 0, fundedAt: iso(23.9 * HOUR) }, { status: 'sent' }).label, 'aging · 1h left');
  // A funded wallet with no readable time is still aging — just without a countdown.
  assert.equal(at({ daysSinceFunded: 0, fundedAt: null }, { status: 'sent' }).label, 'aging');
});

test('an abandoned transfer is a failed wallet that was never funded', () => {
  const s = at({ daysSinceFunded: null, campaignId: 'c', claimed: true }, { status: 'abandoned', campaignStatus: 'complete' });
  assert.equal(s.key, 'failed');
  assert.equal(s.label, 'failed · never funded');
  assert.equal(s.tone, 'part');
});

test('an unfunded wallet takes the state of the campaign holding it', () => {
  const w = { daysSinceFunded: null, campaignId: 'c', claimed: true };
  assert.equal(at(w, { status: 'pending', campaignStatus: 'cancelled' }).key, 'cancelled');
  assert.equal(at(w, { status: 'pending', campaignStatus: 'cancelled' }).label, 'cancelled · never funded');
  assert.equal(at(w, { status: 'pending', campaignStatus: 'halted' }).label, 'campaign halted');
  assert.equal(at(w, { status: 'pending', campaignStatus: 'paused' }).label, 'campaign paused');
  assert.equal(at(w, { status: 'pending', campaignStatus: 'running' }).key, 'waiting');
});

test('a claimed wallet whose campaign has not been read yet reads as waiting, not as free', () => {
  assert.equal(at({ daysSinceFunded: null, campaignId: 'c', claimed: true }, undefined).key, 'waiting');
});

test('a wallet no campaign holds is not in a campaign', () => {
  const s = at({ daysSinceFunded: null, campaignId: null, claimed: false }, undefined);
  assert.equal(s.key, 'unassigned');
  assert.equal(s.label, 'not in a campaign');
});

test('orderByStatus puts problems first and fresh wallets last, keeping order within a status', () => {
  const rows = [
    { id: 'fresh1', daysSinceFunded: null, campaignId: null },
    { id: 'wait1', daysSinceFunded: null, campaignId: 'c' },
    { id: 'aging1', daysSinceFunded: 0, fundedAt: iso(HOUR), campaignId: 'c' },
    { id: 'failed1', daysSinceFunded: null, campaignId: 'c' },
    { id: 'fresh2', daysSinceFunded: null, campaignId: null },
    { id: 'halted1', daysSinceFunded: null, campaignId: 'h' },
  ];
  const facts = {
    wait1: { status: 'pending', campaignStatus: 'running' },
    aging1: { status: 'sent' },
    failed1: { status: 'abandoned', campaignStatus: 'complete' },
    halted1: { status: 'pending', campaignStatus: 'halted' },
  };
  const statusOf = (w) => at(w, facts[w.id]);
  assert.deepEqual(
    orderByStatus(rows, statusOf).map((w) => w.id),
    ['failed1', 'halted1', 'aging1', 'wait1', 'fresh1', 'fresh2']
  );
  assert.deepEqual(rows[0].id, 'fresh1', 'the input list is not reordered in place');
});

test('statusCounts counts each status', () => {
  const rows = [
    { id: 'a', daysSinceFunded: null, campaignId: null },
    { id: 'b', daysSinceFunded: null, campaignId: null },
    { id: 'c', daysSinceFunded: null, campaignId: 'x' },
  ];
  const facts = { c: { status: 'abandoned' } };
  assert.deepEqual(statusCounts(rows, (w) => at(w, facts[w.id])), { unassigned: 2, failed: 1 });
});
