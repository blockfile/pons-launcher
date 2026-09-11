import test from 'node:test';
import assert from 'node:assert/strict';

import { sumWei, weiToEth } from './weiTotal.js';

test('sumWei adds raw wei exactly', () => {
  const rows = [{ sendWeiRaw: '499951500000000000' }, { sendWeiRaw: '1' }, { sendWeiRaw: '0' }];
  assert.equal(sumWei(rows), 499951500000000001n);
  assert.equal(sumWei([]), 0n);
});

test('weiToEth prints six places, truncated rather than rounded up', () => {
  assert.equal(weiToEth(0n), '0.000000');
  assert.equal(weiToEth(10n ** 18n), '1.000000');
  assert.equal(weiToEth(499_951_500_000_000_000n), '0.499951');
  assert.equal(weiToEth(1_999_999_999_999_999_999n), '1.999999');
});
