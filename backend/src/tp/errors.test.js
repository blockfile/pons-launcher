'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { TpError, CODES, isTpError, sendError } = require('./errors');

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('CODES is exactly the contract list', () => {
  assert.deepEqual(
    [...CODES].sort(),
    [
      'bad_address',
      'bad_request',
      'bad_signature',
      'bad_tx',
      'challenge_expired',
      'conflict',
      'forbidden',
      'key_mismatch',
      'migrating',
      'no_session',
      'not_contract',
      'not_pons',
      'rate_limited',
      'store_full',
      'too_large',
      'too_many',
      'unavailable',
      'unknown_nonce',
    ]
  );
  assert.ok(Object.isFrozen(CODES));
});

test('TpError carries code, message and status (default 400)', () => {
  const e = new TpError('not_pons', 'not a pons token');
  assert.ok(e instanceof Error);
  assert.ok(isTpError(e));
  assert.equal(e.name, 'TpError');
  assert.equal(e.code, 'not_pons');
  assert.equal(e.message, 'not a pons token');
  assert.equal(e.status, 400);
  assert.equal(new TpError('rate_limited', 'slow down', 429).status, 429);
  assert.equal(new TpError('bad_request').message, 'bad_request');
});

test('TpError refuses an unknown code or an impossible status', () => {
  assert.throws(() => new TpError('nope', 'x'), /unknown code/);
  assert.throws(() => new TpError('bad_tx', 'x', 200), /status/);
  assert.throws(() => new TpError('bad_tx', 'x', 404.5), /status/);
});

test('sendError answers a TpError with its own status and {error, code}', () => {
  const res = fakeRes();
  sendError(res, new TpError('too_many', 'at most 100 addresses', 413));
  assert.equal(res.statusCode, 413);
  assert.deepEqual(res.body, { error: 'at most 100 addresses', code: 'too_many' });
});

test('a TpError may carry numeric extra fields, which the answer spreads beside {error, code}', () => {
  const e = new TpError('conflict', 'changed elsewhere', 409, { rev: 7 });
  assert.deepEqual(e.extra, { rev: 7 });
  assert.ok(Object.isFrozen(e.extra));
  const res = fakeRes();
  sendError(res, e);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { rev: 7, error: 'changed elsewhere', code: 'conflict' });
  assert.equal(new TpError('bad_tx', 'x').extra, undefined);
});

test('extra is numbers only and can never replace error or code', () => {
  assert.throws(() => new TpError('conflict', 'x', 409, { rev: '7' }), /extra/);
  assert.throws(() => new TpError('conflict', 'x', 409, { rev: Number.NaN }), /extra/);
  assert.throws(() => new TpError('conflict', 'x', 409, { code: 1 }), /extra/);
  assert.throws(() => new TpError('conflict', 'x', 409, { error: 1 }), /extra/);
  assert.throws(() => new TpError('conflict', 'x', 409, [1]), /extra/);
  assert.throws(() => new TpError('conflict', 'x', 409, null), /extra/);
});

test('sendError hides the text of a non-TpError behind 502 unavailable', () => {
  const res = fakeRes();
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try {
    sendError(res, new Error('upstream said: secret internals'));
  } finally {
    console.error = original;
  }
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.code, 'unavailable');
  assert.doesNotMatch(res.body.error, /secret internals/);
  assert.equal(logged.length, 1);
});
