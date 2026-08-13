'use strict';

// The money-critical fail-safe, isolated so it can be tested without a chain.
//
// prepareV2 signs every bundle buy up front and fireV2 broadcasts them the
// instant the launch is sent. So the ONE thing that must never happen is
// signing a launch that will revert: the buys go out regardless, pay into a
// curve address that was never created, and the ETH is unrecoverable. This is
// exactly how 1.798 ETH was lost on 2026-08-13.
//
// estimateLaunchGasOrThrow is the gate. If the launch will not simulate, it
// throws and nothing downstream runs. There is no gas fallback any more.

const test = require('node:test');
const assert = require('node:assert');
const { estimateLaunchGasOrThrow } = require('./prepareV2');

const LAUNCH_TX = { to: '0x' + '11'.repeat(20), data: '0xabcd', value: 0n };
const FROM = '0x' + '22'.repeat(20);

test('returns the estimate plus 20% when the launch simulates', async () => {
  const provider = { estimateGas: async () => 1_000_000n };
  const gas = await estimateLaunchGasOrThrow(LAUNCH_TX, FROM, { provider });
  assert.equal(gas, 1_200_000n);
});

test('THROWS instead of falling back when the launch would revert', async () => {
  const provider = {
    estimateGas: async () => {
      throw { data: '0x021c0d43' }; // ExemptionListTooLong()
    },
  };
  await assert.rejects(
    () => estimateLaunchGasOrThrow(LAUNCH_TX, FROM, { provider }),
    /nothing was signed/
  );
});

test('the thrown error names the real revert reason', async () => {
  const provider = {
    estimateGas: async () => {
      throw { data: '0x021c0d43' };
    },
  };
  await assert.rejects(
    () => estimateLaunchGasOrThrow(LAUNCH_TX, FROM, { provider }),
    /ExemptionListTooLong/
  );
});

test('never resolves to a fallback gas value on failure', async () => {
  const provider = {
    estimateGas: async () => {
      throw new Error('execution reverted');
    },
  };
  let resolved = false;
  try {
    await estimateLaunchGasOrThrow(LAUNCH_TX, FROM, { provider });
    resolved = true;
  } catch (_err) {
    // expected
  }
  assert.equal(resolved, false, 'a failed estimate must never resolve to a gas number');
});
