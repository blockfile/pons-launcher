import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESETS_KEY,
  SLIPPAGE_KEY,
  DEFAULT_PRESETS,
  DEFAULT_SLIPPAGE,
  parsePct,
  parseSlippage,
  slippageToBps,
  loadPresets,
  savePresets,
  loadSlippage,
  saveSlippage,
} from './prefs.js';

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    raw: m,
  };
}

const throwing = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
};

test('keys are the documented ones', () => {
  assert.equal(PRESETS_KEY, 'tp.presets.v1');
  assert.equal(SLIPPAGE_KEY, 'tp.slippage.v1');
  assert.deepEqual([...DEFAULT_PRESETS], [25, 30, 50, 75, 100]);
  assert.equal(DEFAULT_SLIPPAGE, 15);
});

test('parsePct accepts whole 1..100 only', () => {
  assert.equal(parsePct('50'), 50);
  assert.equal(parsePct(' 100 '), 100);
  assert.equal(parsePct('0'), null);
  assert.equal(parsePct('101'), null);
  assert.equal(parsePct('33.3'), null);
  assert.equal(parsePct('-5'), null);
  assert.equal(parsePct(''), null);
});

test('parseSlippage accepts 0.1..50 with one decimal', () => {
  assert.equal(parseSlippage('15'), 15);
  assert.equal(parseSlippage('0.5'), 0.5);
  assert.equal(parseSlippage('0'), null);
  assert.equal(parseSlippage('51'), null);
  assert.equal(parseSlippage('1.25'), null);
  assert.equal(slippageToBps(15), 1500);
  assert.equal(slippageToBps(0.5), 50);
});

test('presets round-trip and fall back on garbage', () => {
  const s = memoryStorage();
  assert.deepEqual(loadPresets(s), [25, 30, 50, 75, 100]);
  assert.deepEqual(savePresets(['10', 20, '40', 60, 100], s), [10, 20, 40, 60, 100]);
  assert.deepEqual(loadPresets(s), [10, 20, 40, 60, 100]);
  assert.equal(savePresets([10, 20, 40, 60, 0], s), null);
  assert.deepEqual(loadPresets(s), [10, 20, 40, 60, 100]);
  s.setItem(PRESETS_KEY, '{not json');
  assert.deepEqual(loadPresets(s), [25, 30, 50, 75, 100]);
  s.setItem(PRESETS_KEY, JSON.stringify([1, 2, 3]));
  assert.deepEqual(loadPresets(s), [25, 30, 50, 75, 100]);
});

test('slippage round-trips and falls back', () => {
  const s = memoryStorage();
  assert.equal(loadSlippage(s), 15);
  assert.equal(saveSlippage('7.5', s), 7.5);
  assert.equal(loadSlippage(s), 7.5);
  assert.equal(saveSlippage('99', s), null);
  s.setItem(SLIPPAGE_KEY, 'abc');
  assert.equal(loadSlippage(s), 15);
});

test('a throwing or missing storage never breaks the page', () => {
  assert.deepEqual(loadPresets(throwing), [25, 30, 50, 75, 100]);
  assert.deepEqual(savePresets([5, 10, 15, 20, 100], throwing), [5, 10, 15, 20, 100]);
  assert.equal(loadSlippage(throwing), 15);
  assert.equal(saveSlippage('3', throwing), 3);
  assert.deepEqual(loadPresets(null), [25, 30, 50, 75, 100]);
  assert.equal(loadSlippage(null), 15);
});
