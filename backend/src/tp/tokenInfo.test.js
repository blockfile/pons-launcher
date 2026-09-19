'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getAddress } = require('ethers');

const C = require('./constants');
const { fakeChain } = require('./test-helpers/fakeChain');
const T = require('./tokenInfo');

const TOKEN = '0xa962fadd83eb4d6f11a886fa275bbfd349bd7e3c';
const CURVE = '0x03ef670d7ec0e1c93e1a6cfa3bc24883c3492d81';
const DEPLOYER = '0xf50a3fb0ab1ec4c6d5bff7d59be3e9c1e1b6d3a1';
const FEE_TO = '0x5b19ab3c37d1f7b1f3d7e0f8bbd1c2a3e4f5a6b7';
const POOL = '0x2d0e0c8b1fdf4cb2b1f4a5ad0e1c4f5a6b7c8d9e';
const ZERO = '0x0000000000000000000000000000000000000000';
const LOGO_CID = 'bafkreif2nctwv7yv2iuqzw3jfrpe6iq6ko4vqxe7valfgejqtaox26pms4';
const ETH = 10n ** 18n;

const curveSig = (name) => C.ABI.CURVE.find((s) => s.startsWith(`function ${name}(`));
const TOKEN_INFO = C.ABI.PONS_TOKEN[0];
const V2_RECORD = C.ABI.V2_FACTORY[0];
const V1_RECORD = C.ABI.V1_FACTORY[0];
const BALANCE_OF = 'function balanceOf(address) view returns (uint256)';

const curveVenue = {
  kind: 'curve',
  token: TOKEN,
  name: 'Legend',
  symbol: 'LGND',
  decimals: 18,
  pairDecimals: 18,
  curve: CURVE,
  formerCurve: null,
  poolKey: null,
};
const gradVenue = {
  ...curveVenue,
  kind: 'graduated',
  curve: null,
  formerCurve: CURVE,
  poolKey: { currency0: ZERO, currency1: TOKEN, fee: 10000, tickSpacing: 200, hooks: ZERO },
};
const v1Venue = { ...curveVenue, kind: 'v1', curve: null, pool: POOL };

const SOCIALS = ['https://x.com/legend?s=20', '@legendchat', '', 'legend.xyz', ''];

function v2Record({ threshold = 42n * 10n ** 17n, exists = true } = {}) {
  return [[TOKEN, CURVE, DEPLOYER, FEE_TO, ZERO, threshold, 10000, 200, 100, false, 0, 0n, 0n, 0n, exists]];
}

function v2Chain({ info = true } = {}) {
  const chain = fakeChain();
  if (info) chain.on(TOKEN, TOKEN_INFO, () => [DEPLOYER, 'ipfs://' + LOGO_CID, 'A token.', SOCIALS]);
  chain.on(C.PONS_V2_FACTORY, V2_RECORD, () => v2Record());
  chain.on(CURVE, curveSig('launchedAt'), () => [1789821655n]);
  chain.on(CURVE, curveSig('phantomQuote'), () => [168n * 10n ** 16n]);
  chain.on(CURVE, curveSig('launchSupply'), () => [10n ** 27n]);
  return chain;
}

// ── readTokenInfo ────────────────────────────────────────────────────────────

test('readTokenInfo (v2 curve): one multicall; creator from the registry; launch constants from the curve', async () => {
  T._clearCache();
  const chain = v2Chain();
  const info = await T.readTokenInfo(curveVenue, { provider: chain.provider });
  assert.deepEqual(info, {
    token: TOKEN,
    version: 'v2',
    name: 'Legend',
    symbol: 'LGND',
    description: 'A token.',
    socials: {
      x: 'https://x.com/legend',
      telegram: 'https://t.me/legendchat',
      discord: null,
      website: 'https://legend.xyz/',
      farcaster: null,
    },
    logo: { cid: LOGO_CID, path: '/api/tp/logo/' + TOKEN },
    creator: getAddress(DEPLOYER),
    creatorFeeRecipient: getAddress(FEE_TO),
    launchedAt: 1789821655,
    launchedBefore: null,
    graduationThreshold: (42n * 10n ** 17n).toString(),
    phantomQuote: (168n * 10n ** 16n).toString(),
    launchSupply: (10n ** 27n).toString(),
  });
  assert.equal(chain.count('aggregate3'), 1, 'every field in ONE request');
  assert.ok(Object.isFrozen(info) && Object.isFrozen(info.socials) && Object.isFrozen(info.logo));
  assert.equal(T.cachedInfo(TOKEN.toUpperCase().replace('0X', '0x')), info);
});

test('readTokenInfo is cached forever, and concurrent loads share one read', async () => {
  T._clearCache();
  const chain = v2Chain();
  const deps = { provider: chain.provider };
  const [a, b] = await Promise.all([T.readTokenInfo(curveVenue, deps), T.readTokenInfo(curveVenue, deps)]);
  assert.equal(a, b);
  assert.equal(await T.readTokenInfo(curveVenue, deps), a);
  assert.equal(chain.count('aggregate3'), 1);
});

test('a read that fails rejects and is not cached; the next load reads again', async () => {
  T._clearCache();
  const chain = v2Chain();
  const real = chain.provider.call;
  let fail = true;
  chain.provider.call = async (tx) => {
    if (fail) {
      fail = false;
      throw new Error('rpc timeout');
    }
    return real(tx);
  };
  await assert.rejects(T.readTokenInfo(curveVenue, { provider: chain.provider }), /rpc timeout/);
  assert.equal(T.cachedInfo(TOKEN), null);
  const info = await T.readTokenInfo(curveVenue, { provider: chain.provider });
  assert.equal(info.launchedAt, 1789821655);
});

test('a graduated token reads its launch constants from its former curve', async () => {
  T._clearCache();
  const chain = v2Chain();
  const info = await T.readTokenInfo(gradVenue, { provider: chain.provider });
  assert.equal(info.launchedAt, 1789821655);
  assert.equal(info.phantomQuote, (168n * 10n ** 16n).toString());
  assert.equal(chain.count('launchedAt', CURVE), 1);
});

test('v1: the registry deployer, no curve reads, and launchedBefore the last v1 launch', async () => {
  T._clearCache();
  const chain = fakeChain();
  chain.on(TOKEN, TOKEN_INFO, () => [DEPLOYER, 'https://pbs.twimg.com/media/x.png', '', ['', '', '', '', '']]);
  chain.on(C.PONS_V1_FACTORY, V1_RECORD, () => [
    [TOKEN, DEPLOYER, C.WETH, ZERO, 673450n, 0n, 0n, 25741081n, 10n ** 27n, false, 10000, true, 46n * 10n ** 15n],
  ]);
  const info = await T.readTokenInfo(v1Venue, { provider: chain.provider });
  assert.equal(info.version, 'v1');
  assert.equal(info.creator, getAddress(DEPLOYER));
  assert.equal(info.creatorFeeRecipient, null);
  assert.equal(info.launchedAt, null);
  assert.equal(info.launchedBefore, T.V1_LAST_LAUNCH_TS);
  assert.equal(info.launchedBefore, 1786563753);
  assert.equal(info.logo, null, 'a logo outside IPFS is no logo');
  assert.equal(info.graduationThreshold, null);
  assert.equal(info.phantomQuote, null);
  assert.equal(chain.log.filter((l) => l.to === CURVE).length, 0);
});

test('a token whose getTokenInfo reverts still answers the registry fields — no logo, no socials', async () => {
  T._clearCache();
  const chain = v2Chain({ info: false });
  const info = await T.readTokenInfo(curveVenue, { provider: chain.provider });
  assert.equal(info.description, '');
  assert.equal(info.logo, null);
  assert.deepEqual(info.socials, { x: null, telegram: null, discord: null, website: null, farcaster: null });
  assert.equal(info.creator, getAddress(DEPLOYER));
  assert.equal(info.launchedAt, 1789821655);
});

test('readTokenInfo refuses anything but a resolved venue', async () => {
  await assert.rejects(T.readTokenInfo(null), (err) => err.code === 'bad_request');
  await assert.rejects(T.readTokenInfo({ token: TOKEN }), (err) => err.code === 'bad_request');
});

// ── strings ──────────────────────────────────────────────────────────────────

const ch = (n) => String.fromCodePoint(n);

test('description: control and bidi-override characters stripped, line breaks kept, capped at 1000', () => {
  const dirty = 'line one' + ch(10) + 'line' + ch(0) + ' two' + ch(7) + ch(27) + '[31m' + ch(0x202e) + 'txet' + ch(13) + ch(0x9b);
  assert.equal(T.cleanDescription(dirty), 'line one' + ch(10) + 'line two[31mtxet');
  assert.equal(T.cleanDescription('x'.repeat(1500)).length, 1000);
  assert.equal(T.cleanDescription('😀'.repeat(1001)), '😀'.repeat(1000), 'capped by character, not UTF-16 unit');
  assert.equal(T.cleanDescription(42), '');
  assert.equal(T.cleanDescription(undefined), '');
});

test('normaliseSocials: known platforms become https links on their own host; the rest is dropped', () => {
  const cases = [
    // [field, input, expected]
    ['twitter', 'https://x.com/arnzxbt/status/2101288151469916245', 'https://x.com/arnzxbt/status/2101288151469916245'],
    ['twitter', 'http://twitter.com/playfomowar', 'https://x.com/playfomowar'],
    ['twitter', 'https://x.com/useumbraa?s=21&t=bYpPYoelcYrumL0aYRb_AQ', 'https://x.com/useumbraa'],
    ['twitter', 'https://twitter.com/yatsutes/status/2101291325018550538', 'https://x.com/yatsutes/status/2101291325018550538'],
    ['twitter', 'VortaMarkets', 'https://x.com/VortaMarkets'],
    ['twitter', '@legend', 'https://x.com/legend'],
    ['twitter', 'https://www.instagram.com/p/DdIqSwEN6H-/', null],
    ['twitter', 'https://x.com/', null],
    ['twitter', 'javascript:alert(1)', null],
    ['twitter', 'https://user:pw@x.com/legend', null],
    ['telegram', 'https://t.me/+RQ8q4ioXsYxmNWE5', 'https://t.me/+RQ8q4ioXsYxmNWE5'],
    ['telegram', 'https://t.me/Temperuss/519', 'https://t.me/Temperuss/519'],
    ['telegram', 'https://telegram.me/hoodetta', 'https://t.me/hoodetta'],
    ['telegram', 'ClosingBellOnRH', 'https://t.me/ClosingBellOnRH'],
    ['telegram', 'https://t.me/#0xC2612D98C405504E02DE17EA3363238eec1D7777', null],
    ['telegram', 'https://x.com/thedailybeast/status/2087610073220538536', null],
    ['discord', 'https://discord.gg/abc123', 'https://discord.gg/abc123'],
    ['discord', 'https://www.discord.com/invite/abc123', 'https://discord.com/invite/abc123'],
    ['discord', 'https://evil.example/discord.gg', null],
    ['website', 'gmgnpad.com', 'https://gmgnpad.com/'],
    ['website', 'http://www.idleai.xyz', 'https://www.idleai.xyz/'],
    ['website', 'https://thedrivingfly.com/#live-auction', 'https://thedrivingfly.com/#live-auction'],
    ['website', 'https://linktr.ee/ArcadiaGame', 'https://linktr.ee/ArcadiaGame'],
    ['website', 'test', null],
    ['website', 'ftp://files.example.com/', null],
    ['website', 'data:text/html,hi', null],
    ['website', 'https://example.com:8443/', null],
    ['farcaster', 'https://warpcast.com/dwr', 'https://warpcast.com/dwr'],
    ['farcaster', 'https://farcaster.xyz/dwr', 'https://farcaster.xyz/dwr'],
    ['farcaster', 'dwr', null],
  ];
  const key = { twitter: 'x', telegram: 'telegram', discord: 'discord', website: 'website', farcaster: 'farcaster' };
  for (const [field, input, want] of cases) {
    assert.equal(T.normaliseSocials({ [field]: input })[key[field]], want, `${field}: ${input}`);
  }
  assert.deepEqual(T.normaliseSocials(null), { x: null, telegram: null, discord: null, website: null, farcaster: null });
  const long = 'https://example.com/' + 'a'.repeat(400);
  assert.equal(T.normaliseSocials({ website: long }).website, null, 'over the cap: dropped, not truncated into another URL');
});

// ── figures ──────────────────────────────────────────────────────────────────

const INFO = { phantomQuote: (168n * 10n ** 16n).toString(), graduationThreshold: (42n * 10n ** 17n).toString() };

test('figures (curve): progress = (quoteReserve - phantomQuote) / graduationThreshold, 1 once reached', () => {
  const mark = (q) => ({ block: 1, price: 1e-9, quoteReserve: q.toString(), tokenReserve: '1' });
  let f = T.figures(curveVenue, mark(168n * 10n ** 16n + 11_640_000_000_000_000n), INFO);
  assert.equal(f.raised, '11640000000000000');
  assert.ok(Math.abs(f.progress - 0.011640 / 4.2) < 1e-6);
  assert.equal(f.liquidity, null);
  f = T.figures(curveVenue, mark(168n * 10n ** 16n + 42n * 10n ** 17n), INFO);
  assert.equal(f.progress, 1);
  f = T.figures(curveVenue, mark(10n), INFO);
  assert.equal(f.progress, 0, 'below the phantom reserve is 0, never negative');
  assert.equal(f.raised, '0');
  assert.deepEqual(T.figures(curveVenue, null, INFO), { progress: null, raised: null, liquidity: null });
  assert.deepEqual(T.figures(curveVenue, mark(ETH), null), { progress: null, raised: null, liquidity: null });
});

test('figures (graduated): full-range reserves from L and sqrtP, whichever currency the quote is', () => {
  const Q96 = 2n ** 96n;
  const mark = { block: 1, price: 0.25, sqrtPriceX96: (2n * Q96).toString(), liquidity: (10n ** 21n).toString(), tick: 0 };
  // currency0 = native ETH (the quote): amount0 = L / 2, amount1 = 2L
  let f = T.figures(gradVenue, mark, null);
  assert.equal(f.progress, 1);
  assert.deepEqual(f.liquidity, { quote: (5n * 10n ** 20n).toString(), token: (2n * 10n ** 21n).toString() });
  // a pool whose currency0 is the token
  const flipped = { ...gradVenue, poolKey: { ...gradVenue.poolKey, currency0: TOKEN, currency1: '0xffffffffffffffffffffffffffffffffffffffff' } };
  f = T.figures(flipped, mark, null);
  assert.deepEqual(f.liquidity, { quote: (2n * 10n ** 21n).toString(), token: (5n * 10n ** 20n).toString() });
  assert.deepEqual(T.figures(gradVenue, null, null), { progress: 1, raised: null, liquidity: null });
});

test('figures (v1 and anything unknown): the pool balances when known, otherwise null — never a guess', () => {
  assert.deepEqual(T.figures(v1Venue, { block: 1 }, null, { quote: '5', token: '7' }), {
    progress: null,
    raised: null,
    liquidity: { quote: '5', token: '7' },
  });
  assert.deepEqual(T.figures(v1Venue, { block: 1 }, null, null), { progress: null, raised: null, liquidity: null });
  assert.deepEqual(T.figures({ kind: 'other' }, {}, null), { progress: null, raised: null, liquidity: null });
  assert.deepEqual(T.figures(null, null, null), { progress: null, raised: null, liquidity: null });
});

test('launchRef: the launch price is phantomQuote / launchSupply in human units', () => {
  const info = { launchedAt: 1789821655, phantomQuote: (168n * 10n ** 16n).toString(), launchSupply: (10n ** 27n).toString() };
  const ref = T.launchRef(curveVenue, info);
  assert.equal(ref.ts, 1789821655);
  assert.ok(Math.abs(ref.price - 1.68e-9) < 1e-20);
  const usdg = T.launchRef({ ...curveVenue, pairDecimals: 6 }, { ...info, phantomQuote: '5000000000' });
  assert.ok(Math.abs(usdg.price - 5e-6) < 1e-15, 'pair decimals respected');
  assert.equal(T.launchRef(curveVenue, { ...info, launchedAt: null }), null);
  assert.equal(T.launchRef(curveVenue, null), null);
});

// ── v1 pool balances ─────────────────────────────────────────────────────────

function v1PoolChain() {
  const chain = fakeChain();
  const balances = { weth: 5096n * 10n ** 14n, token: 7363n * 10n ** 23n };
  chain.on(C.WETH, BALANCE_OF, () => [balances.weth]);
  chain.on(TOKEN, BALANCE_OF, () => [balances.token]);
  return { chain, balances };
}

test('poolBalances (v1): the pool WETH and token balances, memoised 15 s with one read in flight', async () => {
  T._clearCache();
  const { chain, balances } = v1PoolChain();
  let now = 1_000;
  const deps = { provider: chain.provider, now: () => now };
  const [a, b] = await Promise.all([T.poolBalances(v1Venue, deps), T.poolBalances(v1Venue, deps)]);
  assert.deepEqual(a, { quote: (5096n * 10n ** 14n).toString(), token: (7363n * 10n ** 23n).toString() });
  assert.equal(a, b);
  assert.equal(chain.count('aggregate3'), 1);
  const [call] = chain.log.filter((l) => l.name === 'balanceOf');
  assert.equal(call.args[0].toLowerCase(), POOL);
  now += T.POOL_TTL_MS - 1;
  await T.poolBalances(v1Venue, deps);
  assert.equal(chain.count('aggregate3'), 1, 'still fresh');
  balances.weth = 1n;
  now += 2;
  assert.equal((await T.poolBalances(v1Venue, deps)).quote, '1');
  assert.equal(chain.count('aggregate3'), 2);
  assert.equal(await T.poolBalances(curveVenue, deps), null, 'only a v1 venue has pool balances');
});

test('peekPoolBalances answers the last value at once and refreshes it in the background when stale', async () => {
  T._clearCache();
  const { chain, balances } = v1PoolChain();
  let now = 1_000;
  const deps = { provider: chain.provider, now: () => now };
  assert.equal(T.peekPoolBalances(v1Venue, deps), null, 'nothing known yet');
  await new Promise((r) => setImmediate(r));
  assert.equal(T.peekPoolBalances(v1Venue, deps).quote, (5096n * 10n ** 14n).toString());
  balances.weth = 9n;
  now += T.POOL_TTL_MS;
  assert.equal(T.peekPoolBalances(v1Venue, deps).quote, (5096n * 10n ** 14n).toString(), 'stale, answered at once');
  await new Promise((r) => setImmediate(r));
  assert.equal(T.peekPoolBalances(v1Venue, deps).quote, '9');
  assert.equal(T.peekPoolBalances(curveVenue, deps), null);
});

// ── streamStats ──────────────────────────────────────────────────────────────

test('streamStats: null without indexer stats; else the ring stats, the launch reference and the figures', async () => {
  T._clearCache();
  assert.equal(T.streamStats(null), null);
  assert.equal(T.streamStats({ venue: curveVenue, mark: null }), null, 'an indexer without stats()');

  const chain = v2Chain();
  const launches = [];
  const ix = {
    venue: curveVenue,
    mark: { block: 9, price: 2e-9, quoteReserve: (168n * 10n ** 16n + 21n * 10n ** 17n).toString(), tokenReserve: '1' },
    stats(launch) {
      launches.push(launch);
      return { at: 100, since: 0, price: 2e-9, change: {}, volume: {}, complete: {} };
    },
  };
  const deps = { provider: chain.provider };
  const first = T.streamStats(ix, deps);
  assert.equal(launches[0], null, 'no info cached yet: no launch reference');
  assert.deepEqual(first.figures, { progress: null, raised: null, liquidity: null });
  await new Promise((r) => setImmediate(r));
  assert.ok(T.cachedInfo(TOKEN), 'the missing info was read in the background');
  const second = T.streamStats(ix, deps);
  assert.equal(launches[1].ts, 1789821655);
  assert.ok(Math.abs(launches[1].price - 1.68e-9) < 1e-20);
  assert.equal(second.at, 100);
  assert.equal(second.figures.progress, 0.5);
  assert.equal(chain.count('aggregate3'), 1, 'the stats path itself never reads');
});
