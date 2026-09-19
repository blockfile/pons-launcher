import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_POSITION_TOKENS, mergePositionMaps, normalizePositionMap, withoutOldestToken } from './positionsMap.js';

const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const T = addr(0x77);
const T2 = addr(0x88);
const A = addr(0xaa);
const B = addr(0xbb);
const tokenN = (i) => addr(0x5000 + i);

test("the book's rule: the later position, then the higher mark; junk dropped", () => {
  // The same cases as ui/positions.js mergePositions (Task 34): both sides must agree.
  const later = 9_000_000; // a genuinely new position, not the same one detected twice
  const mine = { [T]: { [A]: { hwm: '100', seenAt: later, startedAt: later }, [B]: { hwm: '7', seenAt: 1, startedAt: 1 } } };
  const theirs = {
    [T.toUpperCase().replace('0X', '0x')]: { [A]: { hwm: '900', seenAt: 2, startedAt: 2 }, [B]: { hwm: '9', seenAt: 1, startedAt: 1 } },
    [T2]: { [A]: { hwm: '-1', seenAt: 1, startedAt: 1 } },
    bad: 'x',
  };
  assert.deepEqual(mergePositionMaps(mine, theirs), {
    [T]: { [A]: { hwm: '100', seenAt: later, startedAt: later }, [B]: { hwm: '9', seenAt: 1, startedAt: 1 } },
  });
});

test('two devices that each SEE the same empty -> holding transition keep the higher mark', () => {
  // startedAt is when THIS tab first saw the wallet holding, not an identity: two
  // devices on their own 20 s polls date one transition differently. The later record
  // must not throw away the mark the earlier observer had, or the %-left bar reads
  // 100% for a wallet that has already sold part of the position.
  const desktop = { [T]: { [A]: { hwm: '1000000', seenAt: 100, startedAt: 100 } } };
  const phone = { [T]: { [A]: { hwm: '600000', seenAt: 120, startedAt: 120 } } };
  for (const merged of [mergePositionMaps(desktop, phone), mergePositionMaps(phone, desktop)]) {
    assert.deepEqual(merged[T][A], { hwm: '1000000', seenAt: 120, startedAt: 120 });
  }
  // A start far enough apart is a NEW position and does reset the mark.
  const rebought = { [T]: { [A]: { hwm: '600000', seenAt: 9_000_000, startedAt: 9_000_000 } } };
  assert.equal(mergePositionMaps(desktop, rebought)[T][A].hwm, '600000');
  // And a recorded END of a position never lends its mark forward.
  const ended = { [T]: { [A]: { hwm: '1000000', seenAt: 100, startedAt: 100, empty: true } } };
  assert.equal(mergePositionMaps(ended, phone)[T][A].hwm, '600000');
});

test('a new position beats an older one; the same start keeps the higher mark, then the later sighting', () => {
  const old = { [T]: { [A]: { hwm: '900', seenAt: 500, startedAt: 400 } } };
  const fresh = { [T]: { [A]: { hwm: '20', seenAt: 3000, startedAt: 3000, empty: true } } };
  assert.deepEqual(mergePositionMaps(old, fresh)[T][A], { empty: true, hwm: '20', seenAt: 3000, startedAt: 3000 });
  assert.deepEqual(mergePositionMaps(fresh, old)[T][A], { empty: true, hwm: '20', seenAt: 3000, startedAt: 3000 });
  const higher = { [T]: { [A]: { hwm: '950', seenAt: 450, startedAt: 400 } } };
  assert.equal(mergePositionMaps(old, higher)[T][A].hwm, '950');
  const later = { [T]: { [A]: { hwm: '900', seenAt: 800, startedAt: 400 } } };
  assert.equal(mergePositionMaps(old, later)[T][A].seenAt, 800);
  // the plain {hwm, seenAt} shape started when it was last seen, and stays as it came
  const plain = { [T]: { [A]: { hwm: '70', seenAt: 4000 } } };
  assert.deepEqual(mergePositionMaps(old, plain)[T][A], { hwm: '70', seenAt: 4000 });
});

test('records pass through unchanged: unknown plain fields stay, anything else goes, keys sorted', () => {
  const map = {
    [T]: {
      [A]: { startedAt: 2, seenAt: 3, hwm: '5', note: 'kept', flag: false, nested: { x: 1 }, long: 'y'.repeat(101), bad: Number.NaN },
      [B]: { hwm: 5, seenAt: 1 },
    },
  };
  const out = normalizePositionMap(map);
  assert.deepEqual(out, { [T]: { [A]: { flag: false, hwm: '5', note: 'kept', seenAt: 3, startedAt: 2 } } });
  assert.deepEqual(Object.keys(out[T][A]), ['flag', 'hwm', 'note', 'seenAt', 'startedAt']);
  const many = { hwm: '1', seenAt: 1 };
  for (let i = 0; i < 20; i += 1) many[`f${String(i).padStart(2, '0')}`] = i;
  const kept = normalizePositionMap({ [T]: { [A]: many } })[T][A];
  assert.equal(Object.keys(kept).length, 8, 'at most 8 fields');
  assert.equal(kept.hwm, '1', "the book's own fields are never the ones cut");
  assert.equal(kept.seenAt, 1);
  for (const junk of [null, 'x', [], { [T]: 'x' }, { [T]: { [A]: null } }, { [T]: { [A]: { hwm: '1', seenAt: 'x' } } }]) {
    assert.deepEqual(normalizePositionMap(junk), {});
  }
});

test(`at most ${MAX_POSITION_TOKENS} tokens: the least recently seen go; withoutOldestToken drops one more`, () => {
  const many = {};
  for (let i = 0; i <= MAX_POSITION_TOKENS; i += 1) many[tokenN(i)] = { [A]: { hwm: '1', seenAt: 100 + i, startedAt: 100 + i } };
  const kept = normalizePositionMap(many);
  assert.equal(Object.keys(kept).length, MAX_POSITION_TOKENS);
  assert.equal(kept[tokenN(0)], undefined);
  assert.deepEqual(Object.keys(kept), Object.keys(kept).slice().sort(), 'tokens sorted');
  const smaller = withoutOldestToken(kept);
  assert.equal(Object.keys(smaller).length, MAX_POSITION_TOKENS - 1);
  assert.equal(smaller[tokenN(1)], undefined, 'the least recently seen token went');
  assert.ok(smaller[tokenN(MAX_POSITION_TOKENS)]);
  assert.deepEqual(withoutOldestToken({}), {});
});
