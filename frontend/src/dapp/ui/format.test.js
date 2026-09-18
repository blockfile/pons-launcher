import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPLORER,
  txUrl,
  shortAddr,
  quoteSymbol,
  quoteDecimals,
  venueLabel,
  unitsString,
  toNumber,
  fmtUnits,
  pctOfSupply,
  fmtPct,
  fmtPrice,
  fmtUsd,
  fmtAge,
  errText,
} from './format.js';

test('explorer links use the Robinhood Chain blockscout', () => {
  assert.equal(EXPLORER, 'https://robinhoodchain.blockscout.com');
  assert.equal(txUrl('0xabc'), 'https://robinhoodchain.blockscout.com/tx/0xabc');
});

test('shortAddr keeps 8 leading and 6 trailing characters', () => {
  const a = '0x' + '1234567890'.repeat(4);
  assert.equal(shortAddr(a), '0x123456…567890');
  assert.equal(shortAddr(a, 6, 4), '0x1234…7890');
  assert.equal(shortAddr(''), '');
});

test('quote symbol and decimals follow the venue, never a literal ETH', () => {
  assert.equal(quoteSymbol({ nativeQuote: true, pairSymbol: 'WETH' }), 'ETH');
  assert.equal(quoteSymbol({ nativeQuote: false, pairSymbol: 'AMZN' }), 'AMZN');
  assert.equal(quoteDecimals({ nativeQuote: true, pairDecimals: 6 }), 18);
  assert.equal(quoteDecimals({ nativeQuote: false, pairDecimals: 6 }), 6);
  assert.equal(venueLabel({ kind: 'graduated' }), 'pons v2 · Uniswap v4 pool');
});

test('unitsString is exact', () => {
  assert.equal(unitsString('1500000000000000000', 18), '1.5');
  assert.equal(unitsString('-1', 18), '-0.000000000000000001');
  assert.equal(unitsString('42', 0), '42');
  assert.equal(toNumber('2500000', 6), 2.5);
});

test('fmtUnits groups, truncates and marks dust', () => {
  assert.equal(fmtUnits('1234567891200000000000000', 18, 2), '1,234,567.89');
  assert.equal(fmtUnits('1999999999999999999', 18, 4), '1.9999');
  assert.equal(fmtUnits('1', 18, 4), '<0.0001');
  assert.equal(fmtUnits('0', 18), '0');
  assert.equal(fmtUnits(null, 18), '—');
  assert.equal(fmtUnits('not a number', 18), '—');
  assert.equal(fmtUnits(5_000_000n, 6, 2), '5');
});

test('pctOfSupply and fmtPct', () => {
  assert.equal(pctOfSupply('25', '1000'), 2.5);
  assert.equal(pctOfSupply('1', '0'), null);
  assert.equal(fmtPct(2.5), '2.50%');
  assert.equal(fmtPct(0.001), '<0.01%');
  assert.equal(fmtPct(null), '—');
});

test('fmtPrice collapses leading zeros into a subscript', () => {
  const sub8 = String.fromCharCode(0x2088);
  const sub7 = String.fromCharCode(0x2087);
  assert.equal(fmtPrice(1.234e-9), `0.0${sub8}1234`);
  assert.equal(fmtPrice(9.99996e-9), `0.0${sub7}1`);
  assert.equal(fmtPrice(0.001234), '0.001234');
  assert.equal(fmtPrice(1.5), '1.5');
  assert.equal(fmtPrice(12345.678), '12,345.68');
  assert.equal(fmtPrice(0), '0');
  assert.equal(fmtPrice(NaN), '—');
});

test('fmtUsd is compact and never invents a figure', () => {
  assert.equal(fmtUsd(5400), '$5.40K');
  assert.equal(fmtUsd(2_500_000), '$2.50M');
  assert.equal(fmtUsd(12.345), '$12.35');
  assert.equal(fmtUsd(null), '—');
  assert.equal(fmtUsd(NaN), '—');
});

test('fmtAge and errText', () => {
  assert.equal(fmtAge(4), '4s');
  assert.equal(fmtAge(125), '2m');
  assert.equal(fmtAge(7200), '2h');
  assert.equal(fmtAge(-3), '0s');
  const nl = String.fromCharCode(10);
  assert.equal(errText(new Error(`first line${nl}second`)), 'first line');
  assert.equal(errText('x'.repeat(200), 10).length, 10);
});
