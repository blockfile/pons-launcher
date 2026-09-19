import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeInfo,
  normalizeFigures,
  safeSocial,
  cleanText,
  curveProgress,
  poolQuoteReserve,
  normalizeStats,
  fmtChange,
  changeDir,
  identicon,
  SOCIAL_KINDS,
  SOCIAL_HOSTS,
} from './tokenFacts.js';

// No escape sequences in this file on purpose (memory: write-tool-escapes).
const LF = String.fromCharCode(10);
const TOKEN = '0x' + '7'.repeat(40);
const PAIR = '0x' + '9'.repeat(40);
const CREATOR = '0x' + 'c'.repeat(40);
const Q96 = 1n << 96n;

test("socials: https links on each network's own hosts only; bare handles become x.com / t.me links", () => {
  assert.deepEqual([...SOCIAL_KINDS], ['x', 'telegram', 'discord', 'website', 'farcaster']);
  assert.equal(safeSocial('x', 'https://x.com/pons'), 'https://x.com/pons');
  assert.equal(safeSocial('x', 'https://twitter.com/pons/status/1'), 'https://x.com/pons/status/1', 'on the canonical host, as the server sends it');
  assert.equal(safeSocial('x', '@VortaMarkets'), 'https://x.com/VortaMarkets');
  assert.equal(safeSocial('telegram', 'ponsfamily'), 'https://t.me/ponsfamily');
  assert.equal(safeSocial('telegram', 'https://t.me/ponsfamily'), 'https://t.me/ponsfamily');
  assert.equal(safeSocial('discord', 'https://discord.gg/abc'), 'https://discord.gg/abc');
  assert.equal(safeSocial('farcaster', 'https://warpcast.com/pons'), 'https://warpcast.com/pons');
  assert.equal(safeSocial('website', 'https://gmgnpad.com/'), 'https://gmgnpad.com/');
  // refused
  assert.equal(safeSocial('website', 'http://gmgnpad.com'), null, 'https only');
  assert.equal(safeSocial('website', 'gmgnpad.com'), null, 'no scheme: not a link here');
  assert.equal(safeSocial('website', 'javascript:alert(1)'), null);
  assert.equal(safeSocial('website', 'data:text/html,hi'), null);
  assert.equal(safeSocial('website', 'https://1.2.3.4/'), null, 'no IP literal');
  assert.equal(safeSocial('website', 'https://[::1]/'), null);
  assert.equal(safeSocial('website', 'https://user:pw@evil.com/'), null, 'no credentials');
  assert.equal(safeSocial('website', 'https://evil.com:8443/'), null, 'no port');
  assert.equal(safeSocial('x', 'https://evil.com/x.com'), null, 'not an X host');
  assert.equal(safeSocial('x', 'https://x.com.evil.com/'), null);
  assert.equal(safeSocial('discord', 'https://discord.evil.gg/'), null);
  assert.equal(safeSocial('telegram', 'test'), null, 'too short for a Telegram handle');
  assert.equal(safeSocial('website', 'https://a.co/' + 'x'.repeat(300)), null, 'over 200 characters');
  assert.equal(safeSocial('website', 42), null);
  assert.equal(safeSocial('twitter', 'https://x.com/a'), null, 'an unknown kind');
});

test('cleanText strips control and bidi-override characters, keeps line breaks (at most one blank line), caps the length', () => {
  const RLO = String.fromCharCode(0x202e);
  const NUL = String.fromCharCode(0);
  const BEL = String.fromCharCode(7);
  assert.equal(cleanText(`  hi${NUL}${BEL} there${RLO}  `, 100), 'hi there');
  assert.equal(cleanText(`a${LF}${LF}${LF}${LF}b${LF}`, 100), `a${LF}${LF}b`);
  assert.equal(cleanText('x'.repeat(50), 10), 'x'.repeat(9) + '…');
  assert.equal(cleanText(null, 10), '');
  assert.equal(cleanText({ toString: () => 'no' }, 10), '');
});

test("normalizeInfo reads Part 02's TokenInfo tolerantly — anything malformed is absent, never thrown", () => {
  const info = normalizeInfo({
    token: TOKEN,
    version: 'v2',
    name: 'Legend',
    symbol: 'LGND',
    creator: CREATOR,
    creatorFeeRecipient: CREATOR,
    description: `Line one${LF}line two`,
    socials: { x: 'https://x.com/pons', telegram: 'http://t.me/x', website: 'https://pons.family', discord: null, farcaster: null },
    logo: { cid: 'bafkreia', path: `/api/tp/logo/${TOKEN}` },
    launchedAt: 1789821655,
    launchedBefore: null,
    graduationThreshold: '4200000000000000000',
    phantomQuote: '1680000000000000000',
    launchSupply: '1000000000000000000000000000',
  });
  assert.deepEqual(info, {
    creator: CREATOR,
    description: `Line one${LF}line two`,
    socials: [
      { kind: 'x', url: 'https://x.com/pons' },
      { kind: 'website', url: 'https://pons.family/' },
    ],
    hasLogo: true,
    launchedAt: 1789821655,
    launchedBefore: null,
    graduationThreshold: '4200000000000000000',
    phantomQuote: '1680000000000000000',
  });
  const none = {
    creator: null,
    description: '',
    socials: [],
    hasLogo: false,
    launchedAt: null,
    launchedBefore: null,
    graduationThreshold: null,
    phantomQuote: null,
  };
  assert.deepEqual(normalizeInfo({ creator: 'x', socials: 'no', logo: null, launchedAt: -5, graduationThreshold: '1e18', phantomQuote: 7 }), none);
  assert.deepEqual(normalizeInfo(null), none, "the server's info: null");
  assert.equal(normalizeInfo({ logo: `/api/tp/logo/${TOKEN}` }).hasLogo, false, 'a bare string is not the {cid, path} form');
  assert.equal(normalizeInfo({ launchedBefore: 1786563753 }).launchedBefore, 1786563753, 'v1: launched at or before');
  assert.deepEqual(normalizeInfo({ socials: { twitter: '@pons' } }).socials, [{ kind: 'x', url: 'https://x.com/pons' }], 'a legacy twitter key');
});

test('curveProgress: (quote reserve - phantom) / threshold, clamped; unknown inputs give null', () => {
  const info = { phantomQuote: '1680000000000000000', graduationThreshold: '4200000000000000000' };
  assert.equal(curveProgress({ quoteReserve: '1680000000000000000' }, info), 0);
  assert.equal(curveProgress({ quoteReserve: '3780000000000000000' }, info), 0.5);
  assert.equal(curveProgress({ quoteReserve: '5880000000000000000' }, info), 1, 'the threshold: ready to graduate');
  assert.equal(curveProgress({ quoteReserve: '9000000000000000000' }, info), 1);
  assert.equal(curveProgress({ quoteReserve: '1000' }, info), 0, 'never below 0');
  assert.equal(curveProgress(null, info), null);
  assert.equal(curveProgress({ quoteReserve: '1' }, { phantomQuote: null, graduationThreshold: '1' }), null);
  assert.equal(curveProgress({ quoteReserve: '1' }, { phantomQuote: '0', graduationThreshold: '0' }), null);
});

test('poolQuoteReserve: a graduated pool from L and sqrtP on either side; anything else has none', () => {
  const L = 29277002188455995918372n;
  const graduated0 = { kind: 'graduated', token: TOKEN, quoteIsCurrency0: true };
  const graduated1 = { kind: 'graduated', token: TOKEN, quoteIsCurrency0: false };
  const mark = { liquidity: L.toString(), sqrtPriceX96: (2n * Q96).toString() };
  assert.equal(poolQuoteReserve(graduated0, mark), L / 2n, 'quote = currency0: L * 2^96 / sqrtP');
  assert.equal(poolQuoteReserve(graduated1, mark), 2n * L, 'quote = currency1: L * sqrtP / 2^96');
  // Without the flag, the PoolKey decides: currency0 is not the token -> the quote is currency0.
  assert.equal(poolQuoteReserve({ kind: 'graduated', token: TOKEN, poolKey: { currency0: '0x' + '0'.repeat(40), currency1: TOKEN } }, mark), L / 2n);
  assert.equal(poolQuoteReserve({ kind: 'graduated', token: TOKEN, poolKey: { currency0: TOKEN, currency1: PAIR } }, mark), 2n * L);
  assert.equal(poolQuoteReserve({ kind: 'v1', token: TOKEN }, mark), null, 'v1 is not full-range: the server figures say');
  assert.equal(poolQuoteReserve({ kind: 'curve', token: TOKEN }, mark), null);
  assert.equal(poolQuoteReserve(graduated0, { liquidity: '5', sqrtPriceX96: '0' }), null);
});

test("normalizeFigures and normalizeStats read Part 02's shapes: fractions become percent, volume stays in quote units", () => {
  assert.deepEqual(normalizeFigures({ progress: 0.27, raised: '1', liquidity: null }), { progress: 0.27, liquidityQuote: null });
  assert.deepEqual(normalizeFigures({ progress: 1, raised: null, liquidity: { quote: '3230600000000000000', token: '5' } }), {
    progress: 1,
    liquidityQuote: 3230600000000000000n,
  });
  assert.deepEqual(normalizeFigures({ progress: 7, liquidity: { quote: 'x' } }), { progress: 1, liquidityQuote: null });
  assert.equal(normalizeFigures(null), null);
  const s = normalizeStats({
    at: 1789825000,
    since: 1789821655,
    price: 2e-9,
    change: { m5: 0.0325, h1: -0.01, h24: null },
    volume: { m5: 0.5, h1: 1.25, h24: 12.5 },
    complete: { m5: true, h1: true, h24: false },
    figures: { progress: 0.5, raised: '1', liquidity: null },
  });
  assert.equal(s.change.m5, 3.25);
  assert.equal(s.change.h1, -1);
  assert.equal(s.change.h24, null);
  assert.deepEqual(s.volume, { m5: 0.5, h1: 1.25, h24: 12.5 });
  assert.deepEqual(s.complete, { m5: true, h1: true, h24: false });
  assert.equal(s.since, 1789821655);
  assert.deepEqual(s.figures, { progress: 0.5, liquidityQuote: null });
  assert.equal(normalizeStats(null), null);
  assert.deepEqual(normalizeStats({ change: 'up', volume: { h24: -3 } }), {
    change: { m5: null, h1: null, h24: null },
    volume: { m5: null, h1: null, h24: null },
    complete: { m5: false, h1: false, h24: false },
    since: null,
    figures: null,
  });
});

test('fmtChange and changeDir: percent in, a signed figure and a direction out', () => {
  assert.equal(fmtChange(3.25), '+3.3%');
  assert.equal(fmtChange(-1), '−1.0%');
  assert.equal(fmtChange(0), '0.0%');
  assert.equal(fmtChange(1234.5), '+1235%');
  assert.equal(fmtChange(null), '—');
  assert.equal(changeDir(2), 'up');
  assert.equal(changeDir(-0.01), 'down');
  assert.equal(changeDir(0), 'flat');
  assert.equal(changeDir(null), 'flat');
});

test('identicon: 5 x 5, mirrored, the same for the same address in any case, different for another', () => {
  const a = identicon(TOKEN);
  assert.equal(a.length, 25);
  for (let r = 0; r < 5; r += 1) for (let c = 0; c < 2; c += 1) assert.equal(a[r * 5 + c], a[r * 5 + 4 - c]);
  assert.ok(a.some(Boolean));
  assert.deepEqual(identicon(TOKEN.toUpperCase().replace('0X', '0x')), a);
  assert.notDeepEqual(identicon(PAIR), a);
});


// The server's table (backend/src/tp/tokenInfo.js SOCIAL_HOSTS), which its own test
// pins with the same literal. Tab isolation: each side owns its copy; change both.
test("SOCIAL_HOSTS is the server's host table, literally", () => {
  assert.deepEqual(SOCIAL_HOSTS, {
    x: {
      'x.com': 'x.com',
      'www.x.com': 'x.com',
      'mobile.x.com': 'x.com',
      'twitter.com': 'x.com',
      'www.twitter.com': 'x.com',
      'mobile.twitter.com': 'x.com',
    },
    telegram: {
      't.me': 't.me',
      'www.t.me': 't.me',
      'telegram.me': 't.me',
      'www.telegram.me': 't.me',
    },
    discord: {
      'discord.gg': 'discord.gg',
      'www.discord.gg': 'discord.gg',
      'discord.com': 'discord.com',
      'www.discord.com': 'discord.com',
      'discordapp.com': 'discord.com',
      'www.discordapp.com': 'discord.com',
    },
    farcaster: {
      'warpcast.com': 'warpcast.com',
      'www.warpcast.com': 'warpcast.com',
      'farcaster.xyz': 'farcaster.xyz',
      'www.farcaster.xyz': 'farcaster.xyz',
    },
  });
  assert.ok(Object.isFrozen(SOCIAL_HOSTS) && Object.values(SOCIAL_HOSTS).every((h) => Object.isFrozen(h)));
});

test('safeSocial renders every link the server sends, unchanged', () => {
  // The links Part 02's normaliseSocials tests (Tasks 21 and 25) pin as its output.
  const SENT = [
    ['x', 'https://x.com/arnzxbt/status/2101288151469916245'],
    ['x', 'https://x.com/playfomowar'],
    ['x', 'https://x.com/useumbraa'],
    ['x', 'https://x.com/VortaMarkets'],
    ['telegram', 'https://t.me/+RQ8q4ioXsYxmNWE5'],
    ['telegram', 'https://t.me/Temperuss/519'],
    ['telegram', 'https://t.me/hoodetta'],
    ['discord', 'https://discord.gg/abc123'],
    ['discord', 'https://discord.com/invite/abc123'],
    ['website', 'https://gmgnpad.com/'],
    ['website', 'https://www.idleai.xyz/'],
    ['website', 'https://thedrivingfly.com/#live-auction'],
    ['website', 'https://linktr.ee/ArcadiaGame'],
    ['website', 'https://46-225-60-163.sslip.io/'],
    ['website', 'https://mobile.io/'],
    ['website', 'https://xn--tda.example/'],
    ['website', 'https://example.com/' + 'a'.repeat(180)],
    ['farcaster', 'https://warpcast.com/dwr'],
    ['farcaster', 'https://farcaster.xyz/dwr'],
  ];
  for (const [kind, url] of SENT) assert.equal(safeSocial(kind, url), url, `${kind}: ${url}`);
  assert.deepEqual(normalizeInfo({ socials: { discord: 'https://discord.com/invite/abc123' } }).socials, [
    { kind: 'discord', url: 'https://discord.com/invite/abc123' },
  ]);
});

test('safeSocial checks and canonicalises with the same table: discordapp.com is shown as discord.com', () => {
  assert.equal(safeSocial('discord', 'https://discordapp.com/invite/abc123'), 'https://discord.com/invite/abc123');
  assert.equal(safeSocial('discord', 'https://www.discordapp.com/invite/abc123'), 'https://discord.com/invite/abc123');
  assert.equal(safeSocial('x', 'https://mobile.twitter.com/pons'), 'https://x.com/pons');
  assert.equal(safeSocial('x', 'https://x.com/pons?s=21'), 'https://x.com/pons', 'the query goes, as on the server');
  assert.equal(safeSocial('farcaster', 'https://www.farcaster.xyz/dwr'), 'https://farcaster.xyz/dwr');
  assert.equal(safeSocial('discord', 'https://mobile.discord.com/invite/abc123'), null, 'not a host in the table');
  assert.equal(safeSocial('x', 'https://x.com/'), null, 'no profile path');
  assert.equal(safeSocial('x', 'https://constructor/pons'), null, 'an Object.prototype key is not a host');
  assert.equal(safeSocial('telegram', 'https://__proto__/ponsfamily'), null);
  assert.equal(safeSocial('website', 'https://a_b.example.com/'), null, 'not a DNS name');
  assert.equal(safeSocial('website', 'https://example.com/' + 'a'.repeat(181)), null, 'over 200 characters');
});
