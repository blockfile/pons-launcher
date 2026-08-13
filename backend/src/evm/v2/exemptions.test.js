'use strict';

// The forwarder's exemption limit is one below the factory's, and the
// difference is a revert rather than a truncation: launchAndBuy appends its own
// buy recipient before passing the list on, so a caller-supplied 32 arrives as
// 33 and fails. Probed against the live contracts — factory-direct takes 32 and
// reverts at 33; launchAndBuy takes 31 and reverts at 32.
//
// This is the cap a bundle actually meets, because launchAndBuy is the only
// path with an atomic dev buy. A launcher written to the documented 32 reverts
// on exactly the configuration an operator is most likely to want, which is why
// it is worth a test rather than a comment.

const test = require('node:test');
const assert = require('node:assert');
const { MAX_SNIPE_TAX_EXEMPTIONS, MAX_EXEMPTIONS_VIA_FORWARDER } = require('./abi');

test('the forwarder allows exactly one fewer than the factory', () => {
  assert.equal(MAX_SNIPE_TAX_EXEMPTIONS, 32);
  assert.equal(MAX_EXEMPTIONS_VIA_FORWARDER, 31);
  assert.equal(MAX_EXEMPTIONS_VIA_FORWARDER, MAX_SNIPE_TAX_EXEMPTIONS - 1);
});

test('a 32-wallet bundle is refused on the forwarder path, and says why', async () => {
  const { buildLaunchAndBuyTx } = require('./factory');
  const wallets = Array.from({ length: 32 }, (_, i) => `0x${String(i + 1).padStart(40, '0')}`);
  await assert.rejects(
    () =>
      buildLaunchAndBuyTx({
        params: {},
        launchConfigId: 0,
        quoteIn: 1n,
        recipient: wallets[0],
        exemptions: wallets,
        value: 1n,
      }),
    (err) => {
      assert.match(err.message, /launchAndBuy allows 31/);
      assert.match(err.message, /appends the buy recipient/);
      return true;
    }
  );
});

test('31 is accepted on the forwarder path', async () => {
  const { buildLaunchAndBuyTx } = require('./factory');
  const wallets = Array.from({ length: 31 }, (_, i) => `0x${String(i + 1).padStart(40, '0')}`);
  // Reaching the encode step at all means the guard passed; whether the encode
  // then succeeds depends on params this test does not care about.
  await assert.doesNotReject(
    () =>
      buildLaunchAndBuyTx({
        params: {},
        launchConfigId: 0,
        quoteIn: 1n,
        recipient: wallets[0],
        exemptions: wallets,
        value: 1n,
      }).catch((err) => {
        if (/allows 31/.test(err.message)) throw err;
        return null;
      })
  );
});
