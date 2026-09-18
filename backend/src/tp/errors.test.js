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
      'bad_tx',
      'migrating',
      'not_contract',
      'not_pons',
      'rate_limited',
      'too_many',
      'unavailable',
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
