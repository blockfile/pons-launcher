'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pons-activity-'));
process.env.HISTORY_PATH = path.join(dir, 'launches.json');

const { activityFor, summariseTransfers, MAX_ENTRIES, _reset } = require('./activity');

test.beforeEach(() => {
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
  _reset();
});

test('entries come back newest first', () => {
  const log = activityFor('alice');
  log.record('fund', 'funded 5');
  log.record('sweep', 'swept 5');

  const [first, second] = log.list();
  assert.equal(first.summary, 'swept 5');
  assert.equal(second.summary, 'funded 5');
  assert.ok(Date.parse(first.at), 'every entry is timestamped');
});

test('users cannot see each other\'s activity', () => {
  activityFor('alice').record('fund', 'alice funded');
  activityFor('bob').record('fund', 'bob funded');

  assert.deepEqual(activityFor('alice').list().map((e) => e.summary), ['alice funded']);
  assert.deepEqual(activityFor('bob').list().map((e) => e.summary), ['bob funded']);
});

test('the log can be filtered to one kind', () => {
  const log = activityFor('alice');
  log.record('fund', 'a');
  log.record('export', 'b');
  log.record('fund', 'c');

  assert.deepEqual(log.list({ kind: 'fund' }).map((e) => e.summary), ['c', 'a']);
});

test('writing is never allowed to fail the action it observes', () => {
  const log = activityFor('alice');
  // A transfer is on chain whether or not the line about it got written.
  // Reporting failure here would tell the operator their funding failed.
  fs.writeFileSync(log._path(), 'not json');
  assert.doesNotThrow(() => log.record('fund', 'still works'));
  assert.equal(log.list()[0].summary, 'still works');
});

test('the log is capped rather than growing forever', () => {
  const log = activityFor('alice');
  for (let i = 0; i < MAX_ENTRIES + 20; i++) log.record('fund', `run ${i}`);

  const all = log.list({ limit: 10_000 });
  assert.equal(all.length, MAX_ENTRIES);
  assert.equal(all[0].summary, `run ${MAX_ENTRIES + 19}`, 'the newest survives');
});

test('a funding result is summarised with its failures intact', () => {
  const s = summariseTransfers([
    { address: '0xa', hash: '0x1' },
    { address: '0xb', error: 'nonce too low' },
    { address: '0xc', hash: '0x2' },
  ]);
  assert.equal(s.wallets, 3);
  assert.equal(s.sent, 2);
  assert.equal(s.failed, 1);
  // The failures are the reason anyone comes back to this log.
  assert.equal(s.results[1].error, 'nonce too low');
});

test('a sweep result is summarised through its nested shape', () => {
  const s = summariseTransfers({
    to: '0xdev',
    results: [{ address: '0xa', eth: { hash: '0x1' } }, { address: '0xb', skipped: 'dust' }],
  });
  assert.equal(s.wallets, 2);
  assert.equal(s.sent, 1);
});
