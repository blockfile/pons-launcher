import { test } from 'node:test';
import assert from 'node:assert/strict';
import { id } from 'ethers';
import { createPositionBook, leftOf, rowValue, ethPerQuoteOf, mergePositions, POSITIONS_KEY, MAX_POSITION_TOKENS } from './positions.js';
import { createHub } from './hub.js';

// ── fakes: no network, no keys. Addresses are plain hex, never derived from a key. ──
const T = '0x' + '7'.repeat(40);
const T2 = '0x' + '8'.repeat(40);
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);
const tokenN = (i) => '0x' + (0x5000 + i).toString(16).padStart(40, '0');

function memStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function book({ storage = null, persist = () => true, clock = { t: 1_000 } } = {}) {
  const b = createPositionBook({ storage, hash: id, now: () => clock.t, persist });
  return { b, clock };
}

const row = (address, tokens, over = {}) => ({ address, tokens: String(tokens), inflight: '0', balanceKnown: true, ...over });

test('a wallet first seen holding starts at 100 %: its held + in-flight tokens are the high-water mark', () => {
  const { b } = book();
  b.observe(T, [row(A, 750, { inflight: '250' })]);
  const rec = b.forToken(T)[A];
  assert.equal(rec.hwm, '1000');
  assert.deepEqual(leftOf(row(A, 750, { inflight: '250' }), rec), { left: 0.75, flight: 0.25, hwm: '1000' });
});

test('sells lower the bar and never the mark: 25 % then 50 % of the rest leaves 37.5 %', () => {
  const { b } = book();
  b.observe(T, [row(A, 1000)]);
  b.observe(T, [row(A, 750)]);
  b.observe(T, [row(A, 375)]);
  const rec = b.forToken(T)[A];
  assert.equal(rec.hwm, '1000');
  assert.equal(leftOf(row(A, 375), rec).left, 0.375);
});

test('a later buy raises the mark; a wallet seen empty and then holding again starts a new position', () => {
  const { b, clock } = book();
  b.observe(T, [row(A, 1000)]);
  b.observe(T, [row(A, 1500)]);
  assert.equal(b.forToken(T)[A].hwm, '1500');
  b.observe(T, [row(A, 0)]);
  assert.equal(b.forToken(T)[A].empty, true);
  assert.equal(leftOf(row(A, 0), b.forToken(T)[A]).left, 0);
  clock.t = 5_000;
  b.observe(T, [row(A, 200)]);
  const rec = b.forToken(T)[A];
  assert.equal(rec.hwm, '200');
  assert.equal(rec.startedAt, 5_000);
  assert.equal(rec.empty, undefined);
  // Rendered before the book saw the re-buy, the bar already treats it as a new position.
  assert.equal(leftOf(row(A, 200), { hwm: '1500', seenAt: 1, startedAt: 1, empty: true }).left, 1);
});

test('a balance the server could not read is never observed', () => {
  const { b } = book();
  b.observe(T, [row(A, 1000)]);
  b.observe(T, [row(A, 0, { balanceKnown: false })]);
  assert.equal(b.forToken(T)[A].empty, undefined);
  b.observe(T, [row(B, 0, { balanceKnown: false })]);
  assert.equal(b.forToken(T)[B], undefined);
});

test('leftOf: no record is 100 % of what the row holds; a row above its mark is 100 %; nothing held is 0', () => {
  assert.deepEqual(leftOf(row(A, 40), null), { left: 1, flight: 0, hwm: '40' });
  assert.deepEqual(leftOf(row(A, 40, { inflight: '10' }), { hwm: '20', seenAt: 1, startedAt: 1 }), { left: 0.8, flight: 0.2, hwm: '50' });
  assert.deepEqual(leftOf(row(A, 0), null), { left: 0, flight: 0, hwm: '0' });
  assert.deepEqual(leftOf(row(A, 'x'), { hwm: 'nope' }), { left: 0, flight: 0, hwm: '0' });
});

test('on the device only with Remember: hashed ids, no address or token in storage, back after a reload', () => {
  const storage = memStorage();
  let remember = true;
  const { b } = book({ storage, persist: () => remember });
  b.observe(T, [row(A, 1000)]);
  const raw = storage.getItem(POSITIONS_KEY);
  assert.ok(raw, 'written');
  assert.ok(!raw.toLowerCase().includes('a'.repeat(40)), 'no wallet address');
  assert.ok(!raw.toLowerCase().includes('7'.repeat(40)), 'no token address');
  const again = createPositionBook({ storage, hash: id, now: () => 2_000, persist: () => remember });
  again.observe(T, [row(A, 400)]);
  assert.equal(again.forToken(T)[A].hwm, '1000', 'the reload keeps the mark');
  remember = false;
  again.observe(T, [row(B, 10)]);
  assert.equal(storage.getItem(POSITIONS_KEY), null, 'without Remember nothing stays on the device');
});

test('storage that throws leaves the book working in memory', () => {
  const boom = () => {
    throw new Error('blocked');
  };
  const { b } = book({ storage: { getItem: boom, setItem: boom, removeItem: boom } });
  b.observe(T, [row(A, 1000)]);
  b.observe(T, [row(A, 500)]);
  assert.equal(b.forToken(T)[A].hwm, '1000');
});

test(`at most ${MAX_POSITION_TOKENS} tokens are kept: the least recently seen goes first`, () => {
  const { b, clock } = book();
  for (let i = 0; i <= MAX_POSITION_TOKENS; i += 1) {
    clock.t = 1_000 + i;
    b.observe(tokenN(i), [row(A, 1000 + i)]);
  }
  assert.equal(Object.keys(b.snapshot()).length, MAX_POSITION_TOKENS);
  assert.equal(b.forToken(tokenN(0))[A], undefined, 'the oldest token is gone');
  assert.equal(b.forToken(tokenN(MAX_POSITION_TOKENS))[A].hwm, String(1000 + MAX_POSITION_TOKENS));
});

test("the account's positions arrive over the hub, merge, and every change after is saved back to it", () => {
  const hub = createHub();
  const saves = [];
  hub.on('positions:save', (d) => saves.push(d.positions));
  const { b, clock } = book();
  const off = b.connect(hub);
  b.observe(T, [row(B, 300)]); // before unlock: nothing is saved to an account
  assert.equal(saves.length, 0);
  hub.emit('account:positions', {
    positions: {
      [T]: { [A]: { hwm: '1000', seenAt: 900, startedAt: 800 } },
      [T2]: { [A]: { hwm: '5', seenAt: 1, startedAt: 1 } },
    },
  });
  assert.equal(b.forToken(T)[A].hwm, '1000');
  assert.equal(saves.length, 1, 'the merge pushes what this tab knew (B) to the account');
  assert.deepEqual(Object.keys(saves[0][T]).sort(), [A, B]);
  clock.t = 2_000;
  b.observe(T, [row(A, 1200), row(B, 300)]);
  assert.equal(saves.length, 2);
  assert.equal(saves[1][T][A].hwm, '1200');
  b.observe(T, [row(A, 1100)]); // a sell: the mark does not move, nothing to save
  assert.equal(saves.length, 2);
  hub.emit('account:locked');
  b.observe(T, [row(A, 1300)]);
  assert.equal(saves.length, 2, 'locked: no more saves');
  off();
});

test('a merge keeps the later position; the same position keeps the higher mark', () => {
  const hub = createHub();
  const { b } = book();
  b.connect(hub);
  b.observe(T, [row(A, 100)]); // startedAt 1000 here
  hub.emit('account:positions', { positions: { [T]: { [A]: { hwm: '900', seenAt: 500, startedAt: 400 } } } });
  assert.equal(b.forToken(T)[A].hwm, '100', 'the older position on another device loses');
  hub.emit('account:positions', { positions: { [T]: { [A]: { hwm: '150', seenAt: 1_000, startedAt: 1_000 } } } });
  assert.equal(b.forToken(T)[A].hwm, '150', 'same start: the higher mark');
  hub.emit('account:positions', { positions: { [T]: { [A]: { hwm: '20', seenAt: 3_000, startedAt: 3_000, empty: true } } } });
  assert.equal(b.forToken(T)[A].hwm, '20', 'a newer position wins');
  assert.equal(b.forToken(T)[A].empty, true);
  // The plain {hwm, seenAt} shape: it started when it was last seen.
  hub.emit('account:positions', { positions: { [T]: { [B]: { hwm: '70', seenAt: 4_000 } } } });
  assert.deepEqual(b.forToken(T)[B], { hwm: '70', seenAt: 4_000, startedAt: 4_000 });
});

test('malformed account positions are ignored, never thrown', () => {
  const hub = createHub();
  const { b } = book();
  b.connect(hub);
  hub.emit('account:positions', null);
  hub.emit('account:positions', { positions: 'x' });
  hub.emit('account:positions', {
    positions: {
      nottoken: { [A]: { hwm: '1', seenAt: 1, startedAt: 1 } },
      [T]: { nota: { hwm: '1', seenAt: 1, startedAt: 1 }, [A]: { hwm: '-5', seenAt: 1, startedAt: 1 }, [B]: { hwm: '7', seenAt: 'x', startedAt: 1 } },
    },
  });
  assert.deepEqual(b.snapshot(), {});
});

test('subscribers hear every change; clear() forgets memory and device and stops saving to the account', () => {
  const storage = memStorage();
  const hub = createHub();
  const saves = [];
  hub.on('positions:save', (d) => saves.push(d));
  const { b } = book({ storage });
  b.connect(hub);
  hub.emit('account:positions', { positions: {} });
  let heard = 0;
  const off = b.subscribe(() => {
    heard += 1;
  });
  b.observe(T, [row(A, 1000)]);
  assert.equal(heard, 1);
  const before = saves.length;
  b.clear();
  assert.equal(heard, 2);
  assert.deepEqual(b.snapshot(), {});
  assert.equal(storage.getItem(POSITIONS_KEY), null);
  b.observe(T, [row(A, 10)]);
  assert.equal(saves.length, before, 'cleared: the account is not overwritten until it is unlocked again');
  off();
});

test('rowValue: tokens x price in the quote, then ETH and USD; unknown inputs give null, never a guess', () => {
  const v = rowValue({ tokens: '2000000000000000000', decimals: 18, price: 0.5, ethPerQuote: 1, usdPerQuote: 3000 });
  assert.deepEqual(v, { quote: 1, eth: 1, usd: 3000 });
  assert.deepEqual(rowValue({ tokens: '1000', decimals: 3, price: null, ethPerQuote: 1, usdPerQuote: 1 }), { quote: null, eth: null, usd: null });
  assert.deepEqual(rowValue({ tokens: '1000', decimals: 3, price: 2, ethPerQuote: null, usdPerQuote: null }), { quote: 2, eth: null, usd: null });
});

test('ethPerQuoteOf: 1 for ETH-quoted; a token pair goes through its USD price; unknown is null', () => {
  assert.equal(ethPerQuoteOf({ nativeQuote: true }, { usd: null }, null), 1);
  assert.equal(ethPerQuoteOf({ nativeQuote: false }, { usd: 150 }, 3000), 0.05);
  assert.equal(ethPerQuoteOf({ nativeQuote: false }, { usd: null, reason: 'no AMZN → ETH price' }, 3000), null);
  assert.equal(ethPerQuoteOf({ nativeQuote: false }, { usd: 150 }, null), null);
  assert.equal(ethPerQuoteOf(null, { usd: 1 }, 1), null);
});

test('mergePositions: the rule Task 29 merges a 409 with — later position, then higher mark; junk dropped; 20 tokens', () => {
  const mine = { [T]: { [A]: { hwm: '100', seenAt: 5, startedAt: 5 }, [B]: { hwm: '7', seenAt: 1, startedAt: 1 } } };
  const theirs = {
    [T.toUpperCase().replace('0X', '0x')]: { [A]: { hwm: '900', seenAt: 2, startedAt: 2 }, [B]: { hwm: '9', seenAt: 1, startedAt: 1 } },
    [T2]: { [A]: { hwm: '-1', seenAt: 1, startedAt: 1 } },
    bad: 'x',
  };
  assert.deepEqual(mergePositions(mine, theirs), {
    [T]: { [A]: { hwm: '100', seenAt: 5, startedAt: 5 }, [B]: { hwm: '9', seenAt: 1, startedAt: 1 } },
  });
  const many = {};
  for (let i = 0; i <= MAX_POSITION_TOKENS; i += 1) many[tokenN(i)] = { [A]: { hwm: '1', seenAt: i, startedAt: i } };
  const merged = mergePositions(many, null);
  assert.equal(Object.keys(merged).length, MAX_POSITION_TOKENS);
  assert.equal(merged[tokenN(0)], undefined);
});
