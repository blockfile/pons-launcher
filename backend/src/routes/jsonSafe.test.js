'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { jsonSafe } = require('./launch');

// A plan that reaches the wire carrying a BigInt does not serialise badly — it
// throws, and the caller gets "Do not know how to serialize a BigInt" with no
// clue which field. That happened on a real v2 preflight.
test('BigInts survive as strings, at any depth', () => {
  const plan = {
    fees: { type: 2, maxFeePerGas: 1234n, maxPriorityFeePerGas: 10n },
    buys: [{ amountIn: 5n, address: '0xa' }],
    nested: { deep: { wei: 7n } },
  };
  const out = jsonSafe(plan);

  assert.equal(out.fees.maxFeePerGas, '1234');
  assert.equal(out.fees.type, 2, 'plain numbers stay numbers');
  assert.equal(out.buys[0].amountIn, '5');
  assert.equal(out.nested.deep.wei, '7');
  assert.doesNotThrow(() => JSON.stringify(out));
});

test('nothing else is disturbed', () => {
  const out = jsonSafe({ a: null, b: undefined, c: true, d: 'x', e: [1, 'two', false] });
  assert.deepEqual(out, { a: null, b: undefined, c: true, d: 'x', e: [1, 'two', false] });
});
