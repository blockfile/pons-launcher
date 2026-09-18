'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ZeroAddress } = require('ethers');

const C = require('./constants');
const venue = require('./venue');
const { TpError } = require('./errors');
const { fakeChain } = require('./test-helpers/fakeChain');

const lc = (a) => String(a).toLowerCase();
const ZERO = lc(ZeroAddress);

// ── fixtures ────────────────────────────────────────────────────────────────
// The GRADUATED reference pool that evm/v3/poolswap.js was verified against on
// chain 4663 (poolswap.js:18-32, poolswap.test.js:79-83): token / SPCX pair,
// poolFee 0, tickSpacing 200, hook = the pons meme hook. Its poolId is the
// golden value — a wrong sort, fee, tickSpacing or hook hashes elsewhere.
const GRAD_TOKEN = '0xd8865aa9052a5e2f59641bb613ca84ec9377b101';
const SPCX = '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea';
const GRAD_CURVE = '0x03ef670d7ec0e1c93e1a6cfa3bc24883c3492d81';
const MEME_HOOK = '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044';
const POOL_ID = '0x048c7f7f128df4df2ca6394512ee2f949b9cff0ab4cb39ec84dd28aa8c39ff62';

// An AMZN-paired curve (memory v3-token-quoted-route: PONSA's curve, AMZN pair).
const AMZN = '0x12f190a9f9d7d37a250758b26824b97ce941bf54';
const AMZN_CURVE = '0x11b8bfae26690d21ae1963e5563062bc8bbc6ee2';

// Synthetic addresses where no real one is needed.
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CURVE = '0xca11a000000000000000000000000000000000a1';

// pons v1 (bundle/prepareSell.test.js:13-17, evm/pricing.js:70-74).
const V1_TOKEN = '0x86d26b51fd707abd05b04084fbb6c1db3708e7de';
const DEX_FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
const V1_POOL = '0x1000000000000000000000000000000000000001';
const V1_SQRT = 2146001890159706666683605869625172n;

const V2_REC_SIG =
  'function getLaunchedToken(address token) view returns (tuple(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists))';
const V1_REC_SIG =
  'function getLaunchedToken(address token) view returns (tuple(address token, address deployer, address pairedToken, address positionManager, uint256 positionId, uint256 dexId, uint256 launchConfigId, uint256 restrictionsEndBlock, uint256 supply, bool isToken0, uint24 poolFee, bool exists, uint256 initialBuyAmount))';
const DEX_SIG =
  'function getDexConfig(uint256 id) view returns (tuple(string name, address factory, address positionManager, address swapRouter, uint24 poolFee, int24 tickSpacing, bool enabled))';
const LAUNCH_SIG =
  'function getLaunchConfig(uint256 id) view returns (tuple(address pairToken, uint256 graduationThreshold, int24 initialTick, uint256 supply, uint16 maxWalletBps, uint16 maxTxBps, uint32 restrictionBlocks, uint24 reservedFee, bool enabled, bool routerRequiresDeadline))';
const SLOT0_SIG =
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)';
const LIQ_SIG = 'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)';

function v2Record(over = {}) {
  return {
    token: ZERO,
    curve: ZERO,
    deployer: ZERO,
    creatorFeeRecipient: ZERO,
    pairToken: ZERO,
    graduationThreshold: 0n,
    poolFee: 0,
    tickSpacing: 0,
    creatorTaxBps: 0,
    buybackEnabled: false,
    phase: 0,
    sweptQuote: 0n,
    sweptTokens: 0n,
    sweptAt: 0n,
    exists: false,
    ...over,
  };
}

function v1Record(over = {}) {
  return {
    token: ZERO,
    deployer: ZERO,
    pairedToken: ZERO,
    positionManager: ZERO,
    positionId: 0n,
    dexId: 0n,
    launchConfigId: 0n,
    restrictionsEndBlock: 0n,
    supply: 0n,
    isToken0: false,
    poolFee: 0,
    exists: false,
    initialBuyAmount: 0n,
    ...over,
  };
}

/** A chain where `token` is a contract with ERC-20 metadata that neither factory knows. */
function baseChain(token) {
  const fc = fakeChain();
  fc.setCode(token);
  fc.on(C.PONS_V2_FACTORY, V2_REC_SIG, () => [v2Record()]);
  fc.on(C.PONS_V1_FACTORY, V1_REC_SIG, () => [v1Record()]);
  fc.on(C.PONS_V2_FACTORY, 'function memeHook() view returns (address)', () => [MEME_HOOK]);
  fc.on(token, 'function name() view returns (string)', () => ['Pons Test']);
  fc.on(token, 'function symbol() view returns (string)', () => ['PTEST']);
  fc.on(token, 'function decimals() view returns (uint8)', () => [18]);
  fc.on(token, 'function totalSupply() view returns (uint256)', () => [10n ** 27n]);
  return fc;
}

/** A pons v2 launch of `token` on `curve`, paired with `pair`, in `phase`. */
function v2Chain({ token = TOKEN, curve = CURVE, pair = ZERO, phase = 0, native = pair === ZERO } = {}) {
  const fc = baseChain(token);
  fc.on(C.PONS_V2_FACTORY, V2_REC_SIG, () => [
    v2Record({ token, curve, pairToken: pair, poolFee: 0, tickSpacing: 200, phase, exists: true }),
  ]);
  fc.on(curve, 'function isNativeQuote() view returns (bool)', () => [native]);
  fc.on(curve, 'function feePolicy() view returns (address)', () => [MEME_HOOK]);
  return fc;
}

/** StateView answers `initialised` for exactly `poolId` (or for any id when poolId is null). */
function withPool(fc, poolId, { sqrt = 5100n * 10n ** 29n, liquidity = 121390000000000000000000n } = {}) {
  fc.on(C.STATE_VIEW, SLOT0_SIG, ([id]) =>
    poolId == null || lc(id) === poolId ? [sqrt, 174972, 0, 0] : [0n, 0, 0, 0]
  );
  fc.on(C.STATE_VIEW, LIQ_SIG, ([id]) => [poolId == null || lc(id) === poolId ? liquidity : 0n]);
  return fc;
}

function v1Chain({ router = C.SWAP_ROUTER02, pair = C.WETH, deadline = false } = {}) {
  const fc = baseChain(V1_TOKEN);
  fc.on(C.PONS_V1_FACTORY, V1_REC_SIG, () => [
    v1Record({ token: V1_TOKEN, pairedToken: pair, dexId: 0n, launchConfigId: 1n, poolFee: 10000, exists: true }),
  ]);
  fc.on(C.PONS_V1_FACTORY, DEX_SIG, () => [
    {
      name: 'Uniswap V3',
      factory: DEX_FACTORY,
      positionManager: ZERO,
      swapRouter: router,
      poolFee: 10000,
      tickSpacing: 200,
      enabled: true,
    },
  ]);
  fc.on(C.PONS_V1_FACTORY, LAUNCH_SIG, () => [
    {
      pairToken: pair,
      graduationThreshold: 0n,
      initialTick: 0,
      supply: 10n ** 27n,
      maxWalletBps: 0,
      maxTxBps: 0,
      restrictionBlocks: 0,
      reservedFee: 0,
      enabled: true,
      routerRequiresDeadline: deadline,
    },
  ]);
  fc.on(DEX_FACTORY, 'function getPool(address, address, uint24) view returns (address)', ([a, b, fee]) => [
    lc(a) === V1_TOKEN && lc(b) === lc(pair) && Number(fee) === 10000 ? V1_POOL : ZERO,
  ]);
  fc.on(V1_POOL, 'function token0() view returns (address)', () => [C.WETH]);
  fc.on(
    V1_POOL,
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
    () => [V1_SQRT, 204145, 0, 1, 1, 0, true]
  );
  return fc;
}

async function rejectsWith(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof TpError, `expected a TpError, got ${err && err.stack}`);
    assert.equal(err.code, code);
    return true;
  });
}

test.beforeEach(() => venue._clearCache());

// ── refusals ────────────────────────────────────────────────────────────────

test('a malformed CA is bad_address, before any chain read', async () => {
  const fc = baseChain(TOKEN);
  await rejectsWith(venue.resolveVenue('0x1234', { provider: fc.provider }), 'bad_address');
  await rejectsWith(venue.resolveVenue(42, { provider: fc.provider }), 'bad_address');
  // EIP-55 test vector with one letter's case flipped: a bad checksum.
  await rejectsWith(
    venue.resolveVenue('0x52908400098527886e0F7030069857D2E4169EE7', { provider: fc.provider }),
    'bad_address'
  );
  assert.equal(fc.log.length, 0);
});

test('an address with no code is not_contract', async () => {
  const fc = baseChain(TOKEN);
  const eoa = '0x2222222222222222222222222222222222222222';
  await rejectsWith(venue.resolveVenue(eoa, { provider: fc.provider }), 'not_contract');
});

test('a contract neither pons factory knows is not_pons — its own getters are never trusted', async () => {
  const fc = baseChain(TOKEN); // a perfectly good ERC-20, unknown to both registries
  await rejectsWith(venue.resolveVenue(TOKEN, { provider: fc.provider }), 'not_pons');
});

test('a v2 launch in a phase that is neither 0 nor 2 is migrating (409)', async () => {
  const fc = v2Chain({ phase: 1 });
  await assert.rejects(venue.resolveVenue(TOKEN, { provider: fc.provider }), (err) => {
    assert.equal(err.code, 'migrating');
    assert.equal(err.status, 409);
    return true;
  });
});

test('graduated but the derived pool is not initialised is migrating, never a guessed pool', async () => {
  const fc = withPool(v2Chain({ token: GRAD_TOKEN, curve: GRAD_CURVE, pair: SPCX, phase: 2 }), '0x' + '11'.repeat(32));
  fc.on(SPCX, 'function symbol() view returns (string)', () => ['SPCX']);
  fc.on(SPCX, 'function decimals() view returns (uint8)', () => [18]);
  await rejectsWith(venue.resolveVenue(GRAD_TOKEN, { provider: fc.provider }), 'migrating');
});

test('the curve and the factory disagreeing about the quote asset is refused', async () => {
  const fc = v2Chain({ pair: ZERO, native: false });
  await rejectsWith(venue.resolveVenue(TOKEN, { provider: fc.provider }), 'unavailable');
});

// ── pons v2 curve ───────────────────────────────────────────────────────────

test('v2 phase 0, native: kind curve, the curve is the spender, every Venue key present', async () => {
  const fc = v2Chain();
  const v = await venue.resolveVenue(TOKEN.toUpperCase().replace('0X', '0x'), { provider: fc.provider });
  assert.deepEqual(v, {
    kind: 'curve',
    token: TOKEN,
    name: 'Pons Test',
    symbol: 'PTEST',
    decimals: 18,
    totalSupply: '1000000000000000000000000000',
    pairToken: ZERO,
    pairSymbol: 'ETH',
    pairDecimals: 18,
    nativeQuote: true,
    curve: CURVE,
    poolKey: null,
    poolId: null,
    pool: null,
    phase: 0,
    spenders: { approve: CURVE },
    formerCurve: null,
    hook: null,
    quoteIsCurrency0: null,
    poolFee: null,
    tokenIsToken0: null,
    router: null,
  });
  assert.doesNotThrow(() => JSON.stringify(v)); // no BigInt anywhere: it goes over the wire
});

test('v2 phase 0, AMZN-paired: token-quoted, pair symbol and decimals read from the pair', async () => {
  const fc = v2Chain({ curve: AMZN_CURVE, pair: AMZN });
  fc.on(AMZN, 'function symbol() view returns (string)', () => ['AMZN']);
  fc.on(AMZN, 'function decimals() view returns (uint8)', () => [18]);
  const v = await venue.resolveVenue(TOKEN, { provider: fc.provider });
  assert.equal(v.kind, 'curve');
  assert.equal(v.nativeQuote, false);
  assert.equal(v.pairToken, AMZN);
  assert.equal(v.pairSymbol, 'AMZN');
  assert.equal(v.pairDecimals, 18);
  assert.deepEqual(v.spenders, { approve: AMZN_CURVE });
});

test('a pair token that will not say its decimals is refused — never a guessed unit', async () => {
  const fc = v2Chain({ curve: AMZN_CURVE, pair: AMZN });
  fc.on(AMZN, 'function symbol() view returns (string)', () => ['AMZN']);
  await rejectsWith(venue.resolveVenue(TOKEN, { provider: fc.provider }), 'unavailable');
});

test('hostile metadata is cleaned: control characters dropped, capped at 64 characters', async () => {
  const fc = v2Chain();
  const bell = String.fromCharCode(7);
  fc.on(TOKEN, 'function name() view returns (string)', () => [`Evil${bell}Name` + 'x'.repeat(100)]);
  fc.on(TOKEN, 'function symbol() view returns (string)', () => {
    throw new Error('revert');
  });
  const v = await venue.resolveVenue(TOKEN, { provider: fc.provider });
  assert.equal(v.name.includes(bell), false);
  assert.equal(v.name.startsWith('EvilName'), true);
  assert.equal(v.name.length, 64);
  assert.equal(v.symbol, '0xaaaa...aaaa'); // unreadable symbol falls back to a short address
});

// ── pons v2 graduated ───────────────────────────────────────────────────────

test('poolKeyFor reproduces the on-chain-verified reference poolId (poolswap.js:23-32)', () => {
  const { poolKey, poolId, quoteIsCurrency0 } = venue.poolKeyFor({
    token: GRAD_TOKEN,
    quote: SPCX,
    hook: MEME_HOOK,
    fee: 0,
    tickSpacing: 200,
  });
  assert.equal(poolId, POOL_ID);
  assert.equal(quoteIsCurrency0, true);
  assert.deepEqual(poolKey, { currency0: SPCX, currency1: GRAD_TOKEN, fee: 0, tickSpacing: 200, hooks: MEME_HOOK });
});

test('v2 phase 2: kind graduated with the verified poolKey/poolId; Permit2 + UniversalRouter spenders', async () => {
  const fc = withPool(v2Chain({ token: GRAD_TOKEN, curve: GRAD_CURVE, pair: SPCX, phase: 2 }), POOL_ID);
  fc.on(SPCX, 'function symbol() view returns (string)', () => ['SPCX']);
  fc.on(SPCX, 'function decimals() view returns (uint8)', () => [18]);
  const v = await venue.resolveVenue(GRAD_TOKEN, { provider: fc.provider });
  assert.equal(v.kind, 'graduated');
  assert.equal(v.phase, 2);
  assert.equal(v.poolId, POOL_ID);
  assert.deepEqual(v.poolKey, { currency0: SPCX, currency1: GRAD_TOKEN, fee: 0, tickSpacing: 200, hooks: MEME_HOOK });
  assert.equal(v.quoteIsCurrency0, true);
  assert.equal(v.hook, MEME_HOOK);
  assert.equal(v.curve, null);
  assert.equal(v.formerCurve, GRAD_CURVE);
  assert.equal(v.nativeQuote, false);
  assert.equal(v.pairSymbol, 'SPCX');
  assert.deepEqual(v.spenders, { approve: lc(C.PERMIT2), permit2Router: lc(C.UNIVERSAL_ROUTER) });
});

test('graduated hook: the curve pin wins; factory.memeHook() only when the curve has none', async () => {
  const other = '0x00000000000000000000000000000000deadbeef';
  // pin present, memeHook different → the pin is used
  const a = withPool(v2Chain({ phase: 2 }), null);
  a.on(C.PONS_V2_FACTORY, 'function memeHook() view returns (address)', () => [other]);
  assert.equal((await venue.resolveVenue(TOKEN, { provider: a.provider })).hook, MEME_HOOK);

  // no feePolicy() getter on the curve → memeHook
  venue._clearCache();
  const b = withPool(v2Chain({ phase: 2 }), null);
  b.on(CURVE, 'function feePolicy() view returns (address)', () => {
    throw new Error('revert');
  });
  b.on(C.PONS_V2_FACTORY, 'function memeHook() view returns (address)', () => [other]);
  const v = await venue.resolveVenue(TOKEN, { provider: b.provider });
  assert.equal(v.hook, other);
});

test('graduated native launch: ETH (0x0) is currency0 and the pair reads as ETH', async () => {
  const fc = withPool(v2Chain({ phase: 2 }), null);
  const v = await venue.resolveVenue(TOKEN, { provider: fc.provider });
  assert.equal(v.kind, 'graduated');
  assert.equal(v.poolKey.currency0, ZERO);
  assert.equal(v.poolKey.currency1, TOKEN);
  assert.equal(v.quoteIsCurrency0, true);
  assert.equal(v.nativeQuote, true);
  assert.equal(v.pairSymbol, 'ETH');
});

test('graduated with an initialised but empty pool is refused (poolswap.js:276-282)', async () => {
  const fc = withPool(v2Chain({ phase: 2 }), null, { liquidity: 0n });
  await rejectsWith(venue.resolveVenue(TOKEN, { provider: fc.provider }), 'unavailable');
});

// ── pons v1 ─────────────────────────────────────────────────────────────────

test('v1: the dex factory pool, token0 orientation from the pool, SwapRouter02 as spender', async () => {
  const fc = v1Chain();
  const v = await venue.resolveVenue(V1_TOKEN, { provider: fc.provider });
  assert.equal(v.kind, 'v1');
  assert.equal(v.pool, V1_POOL);
  assert.equal(v.phase, null);
  assert.equal(v.poolFee, 10000);
  assert.equal(v.tokenIsToken0, false); // WETH 0x0bd7… sorts below 0x86d2…
  assert.equal(v.pairToken, lc(C.WETH));
  assert.equal(v.nativeQuote, true);
  assert.equal(v.pairSymbol, 'ETH');
  assert.equal(v.pairDecimals, 18);
  assert.equal(v.router, lc(C.SWAP_ROUTER02));
  assert.deepEqual(v.spenders, { approve: lc(C.SWAP_ROUTER02) });
  assert.equal(v.curve, null);
  assert.equal(v.poolId, null);
});

test('v1 through any router but SwapRouter02, or its deadline shape, or a non-WETH pair, is refused', async () => {
  await rejectsWith(
    venue.resolveVenue(V1_TOKEN, { provider: v1Chain({ router: '0x2626664c2603336e57b271c5c0b26f421741e481' }).provider }),
    'unavailable'
  );
  await rejectsWith(venue.resolveVenue(V1_TOKEN, { provider: v1Chain({ deadline: true }).provider }), 'unavailable');
  await rejectsWith(venue.resolveVenue(V1_TOKEN, { provider: v1Chain({ pair: C.USDG }).provider }), 'unavailable');
});

// ── the cache and the phase ─────────────────────────────────────────────────

test('provenance is cached: a second resolve re-reads only the v2 phase', async () => {
  const fc = v2Chain();
  const first = await venue.resolveVenue(TOKEN, { provider: fc.provider });
  const v1Reads = fc.count('getLaunchedToken', C.PONS_V1_FACTORY);
  const v2Reads = fc.count('getLaunchedToken', C.PONS_V2_FACTORY);
  const nameReads = fc.count('name');

  const again = await venue.resolveVenue(TOKEN, { provider: fc.provider });
  assert.equal(again, first); // same phase → the very same object
  assert.equal(fc.count('getLaunchedToken', C.PONS_V1_FACTORY), v1Reads);
  assert.equal(fc.count('name'), nameReads);
  assert.equal(fc.count('getLaunchedToken', C.PONS_V2_FACTORY), v2Reads + 1);
});

test('concurrent first loads of one token share a single resolution', async () => {
  const fc = v2Chain();
  const [a, b] = await Promise.all([
    venue.resolveVenue(TOKEN, { provider: fc.provider }),
    venue.resolveVenue(TOKEN, { provider: fc.provider }),
  ]);
  assert.equal(a, b);
  assert.equal(fc.count('getCode'), 1);
});

test('refreshPhase: a curve that graduates becomes a NEW graduated Venue, and the cache follows', async () => {
  const fc = withPool(v2Chain({ phase: 0 }), null);
  const onCurve = await venue.resolveVenue(TOKEN, { provider: fc.provider });
  assert.equal(onCurve.kind, 'curve');

  fc.on(C.PONS_V2_FACTORY, V2_REC_SIG, () => [
    v2Record({ token: TOKEN, curve: CURVE, pairToken: ZERO, poolFee: 0, tickSpacing: 200, phase: 2, exists: true }),
  ]);
  const next = await venue.refreshPhase(onCurve, { provider: fc.provider });
  assert.notEqual(next, onCurve);
  assert.equal(next.kind, 'graduated');
  assert.equal(next.formerCurve, CURVE);
  assert.equal(next.name, onCurve.name); // metadata carried across, not re-read
  assert.deepEqual(next.spenders, { approve: lc(C.PERMIT2), permit2Router: lc(C.UNIVERSAL_ROUTER) });

  const viaCache = await venue.resolveVenue(TOKEN, { provider: fc.provider });
  assert.equal(viaCache, next);
});

test('refreshPhase leaves a v1 venue alone and reads nothing', async () => {
  const fc = v1Chain();
  const v = await venue.resolveVenue(V1_TOKEN, { provider: fc.provider });
  const before = fc.log.length;
  assert.equal(await venue.refreshPhase(v, { provider: fc.provider }), v);
  assert.equal(fc.log.length, before);
});

// ── the send path: cachedVenue ──────────────────────────────────────────────

/** A provider that records and refuses EVERY read — proves a code path reads nothing. */
function noChain() {
  const reads = [];
  const refuse = (name) => async () => {
    reads.push(name);
    throw new Error(`${name}: the send path must not read the chain`);
  };
  return {
    reads,
    provider: {
      call: refuse('call'),
      getCode: refuse('getCode'),
      getBlockNumber: refuse('getBlockNumber'),
      getBlock: refuse('getBlock'),
      getTransactionCount: refuse('getTransactionCount'),
    },
  };
}

test('cachedVenue: a hit is the cached Venue with ZERO chain reads — not even the phase', async () => {
  const fc = v2Chain();
  const loaded = await venue.resolveVenue(TOKEN, { provider: fc.provider }); // the page load
  const nc = noChain();
  const hit = await venue.cachedVenue(TOKEN.toUpperCase().replace('0X', '0x'), { provider: nc.provider });
  assert.equal(hit, loaded);
  assert.deepEqual(nc.reads, []);
});

test('cachedVenue: a bad CA is bad_address before any read; a miss is a full resolveVenue', async () => {
  const nc = noChain();
  await rejectsWith(venue.cachedVenue('0x1234', { provider: nc.provider }), 'bad_address');
  await rejectsWith(venue.cachedVenue(undefined, { provider: nc.provider }), 'bad_address');
  assert.deepEqual(nc.reads, []);

  const fc = v2Chain();
  const v = await venue.cachedVenue(TOKEN, { provider: fc.provider }); // never loaded: resolves
  assert.equal(v.kind, 'curve');
  assert.equal(fc.count('getCode'), 1);
  const reads = fc.log.length;
  assert.equal(await venue.cachedVenue(TOKEN, { provider: fc.provider }), v); // now a hit
  assert.equal(fc.log.length, reads);
});

test('cachedVenue follows the shared cache: once refreshPhase sees the graduation, the send path gets the pool', async () => {
  const fc = withPool(v2Chain({ phase: 0 }), null);
  const onCurve = await venue.resolveVenue(TOKEN, { provider: fc.provider });
  fc.on(C.PONS_V2_FACTORY, V2_REC_SIG, () => [
    v2Record({ token: TOKEN, curve: CURVE, pairToken: ZERO, poolFee: 0, tickSpacing: 200, phase: 2, exists: true }),
  ]);
  const nc = noChain();
  // Stale until someone re-reads the phase — by design (Contract note 13).
  assert.equal(await venue.cachedVenue(TOKEN, { provider: nc.provider }), onCurve);

  const next = await venue.refreshPhase(onCurve, { provider: fc.provider }); // the indexer's 10 s check
  const hit = await venue.cachedVenue(TOKEN, { provider: nc.provider });
  assert.equal(hit, next);
  assert.equal(hit.kind, 'graduated');
  assert.deepEqual(nc.reads, []);
});
