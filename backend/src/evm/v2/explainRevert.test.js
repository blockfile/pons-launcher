'use strict';

// The revert decoder is what makes the launch fail-safe legible: when a launch
// will not simulate, the operator needs "ExemptionListTooLong", not "0x021c0d43"
// or "could not coalesce error". This pins that it names the real error — the
// exact one that stranded a bundle's ETH on 2026-08-13 — and that it degrades to
// the plain RPC message when there is nothing custom to name.

const test = require('node:test');
const assert = require('node:assert');
const { explainRevert } = require('./factory');

test('names the custom error behind a revert selector', () => {
  // 0x021c0d43 = keccak256("ExemptionListTooLong()")[:4] — the real revert that
  // reverted the launch and stranded the buys.
  const out = explainRevert({ data: '0x021c0d43' });
  assert.match(out, /ExemptionListTooLong/);
});

test('finds the revert data however ethers nested it', () => {
  const nestings = [
    { data: '0x021c0d43' },
    { info: { error: { data: '0x021c0d43' } } },
    { error: { data: '0x021c0d43' } },
    { revert: { data: '0x021c0d43' } },
  ];
  for (const err of nestings) {
    assert.match(explainRevert(err), /ExemptionListTooLong/, JSON.stringify(err));
  }
});

test('falls back to the plain message when the error is not a v2 custom error', () => {
  const out = explainRevert({ shortMessage: 'insufficient funds for gas' });
  assert.match(out, /insufficient funds/);
});

test('does not throw on a null or shapeless error', () => {
  assert.doesNotThrow(() => explainRevert(null));
  assert.doesNotThrow(() => explainRevert({}));
  assert.doesNotThrow(() => explainRevert('boom'));
});
