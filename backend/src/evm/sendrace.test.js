'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { raceSend, isDuplicateSend } = require('./sendrace');

const sender = (name, { ms = 0, hash = '0xhash', fail = null } = {}) => ({
  name,
  send: async () => {
    if (ms) await new Promise((r) => setTimeout(r, ms));
    if (fail) throw new Error(fail);
    return hash;
  },
});

test('the first path to accept the transaction wins, and the loser is not waited for', async () => {
  const started = Date.now();
  const res = await raceSend('0xraw', [sender('slow', { ms: 80 }), sender('fast', { ms: 5 })]);

  assert.equal(res.winner, 'fast');
  assert.equal(res.hash, '0xhash');
  assert.ok(Date.now() - started < 60, 'it returned on the fast path, not the slow one');
});

test('a duplicate refusal from the losing path is not a failure — it is the same transaction', async () => {
  // The whole point of two paths is that both carry the SAME signed bytes, so
  // the second node answering "already known" means the race worked.
  const res = await raceSend('0xraw', [
    sender('a', { ms: 2 }),
    sender('b', { ms: 4, fail: 'already known' }),
  ]);

  assert.equal(res.winner, 'a');
  await new Promise((r) => setTimeout(r, 10)); // let the loser settle
  const loser = res.attempts.find((x) => x.name === 'b');
  assert.equal(loser.ok, false);
  assert.equal(loser.duplicate, true, 'a duplicate is recorded as such, not as an error');
});

test('every path refusing as a duplicate still means the transaction is in flight', async () => {
  const res = await raceSend('0xraw', [
    sender('a', { fail: 'nonce too low' }),
    sender('b', { fail: 'already known' }),
  ]);

  assert.equal(res.hash, null, 'no path returned a hash');
  assert.equal(res.duplicate, true, 'but the transaction was already accepted somewhere');
  assert.equal(res.winner, null);
});

test('a real failure on every path is raised, with what each one said', async () => {
  await assert.rejects(
    raceSend('0xraw', [sender('a', { fail: 'insufficient funds' }), sender('b', { fail: 'bad chain id' })]),
    (err) => /insufficient funds/.test(err.message) && /bad chain id/.test(err.message)
  );
});

test('one path failing never delays the other', async () => {
  const res = await raceSend('0xraw', [
    sender('broken', { fail: 'connection refused' }),
    sender('good', { ms: 3 }),
  ]);

  assert.equal(res.winner, 'good');
  assert.equal(res.hash, '0xhash');
});

test('what counts as the same transaction coming back', () => {
  for (const msg of [
    'already known',
    'known transaction: 0xabc',
    'nonce too low',
    'ALREADY_EXISTS: transaction already exists',
    'replacement transaction underpriced',
  ]) {
    assert.equal(isDuplicateSend(new Error(msg)), true, msg);
  }
  for (const msg of ['insufficient funds for gas * price + value', 'invalid sender', 'intrinsic gas too low']) {
    assert.equal(isDuplicateSend(new Error(msg)), false, msg);
  }
  assert.equal(isDuplicateSend(null), false);
});
