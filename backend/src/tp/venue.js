'use strict';

// CA -> Venue for the take-profit dApp. PONS TOKENS ONLY.
//
// PROVENANCE IS THE PONS FACTORIES' OWN REGISTRY, never the token's word about
// itself. getLaunchedToken(ca).exists is asked of the pons v2 factory AND the
// pons v1 factory in ONE Multicall3 request — the same two reads, batched the
// same way, that the console's sell picker uses (evm/v2/holdings.js:597-640),
// with v2 winning if both ever answered (holdings.js:587-592). Anything neither
// registry knows is refused: approving an unknown contract is the dusting attack
// (evm/v2/holdings.js:1-23), and this page is public.
//
// PROVENANCE IS CACHED FOREVER (a launch record never changes); THE PHASE IS NOT.
// A v2 token can graduate, which moves it to a different venue with a
// different spender; a phase change produces a NEW Venue object, which
// replaces the cache entry. Two lookups share the cache:
//   resolveVenue  the LOAD path (GET /token/:ca, POST /wallets): a hit re-reads
//                 the phase (refreshPhase) — one eth_call, off the click path.
//   cachedVenue   the SEND path (POST /broadcast, POST /quote): a hit is the
//                 cached Venue with NO read, so a click's first
//                 eth_sendRawTransaction never waits on an RPC round trip.
//                 The indexer keeps the phase fresh (refreshPhase every 10 s
//                 while a page streams the token).
//
// Logic copied, never imported (tab isolation — see the plan's Global Constraints):
//   graduated resolution: phase gate (0 curve / 2 graduated / else refuse), hook =
//   curve.feePolicy() else factory.memeHook(), fee + tickSpacing FROM THE LAUNCH
//   RECORD, then the slot0 != 0 and liquidity > 0 gates    evm/v3/poolswap.js:202-301
//   PoolKey sort + poolId = keccak256(abi.encode(key))   evm/v5/swap.js:247-281
//   v1 pool = dexConfig.factory.getPool(token, pair, fee), token0 orientation
//                                                         evm/pricing.js:27-58
//   v1 spender = the dex config's swapRouter              bundle/prepareSell.js:169-173
//   curve spender = the curve (it pulls the token with transferFrom inside sell)
//                                                         bundle/prepareSell.js:211-218
//   native vs token-quoted: curve.isNativeQuote() else pairToken == address(0)
//                                                         bundle/prepareSell.js:405
// ABI fragments are constants.ABI (Task 1), which cites each one: V2_FACTORY
// (evm/v2/abi.js:88,93), V1_FACTORY (evm/abi.js:16-41), CURVE (evm/v2/abi.js:
// 134 + poolswap.js:143 feePolicy), ERC20, STATE_VIEW (evm/v5/swap.js:152-155),
// V3_FACTORY / V3_POOL (evm/pricing.js:27-31).

const { AbiCoder, Interface, isAddress, keccak256 } = require('ethers');
const C = require('./constants');
const { TpError } = require('./errors');
// Called through the module object (providers.tpReadProvider()), never
// destructured, so a route test can swap in a provider that refuses every read.
const providers = require('./providers');
const { aggregate3, decodeSlot, one } = require('./multicall');

const lc = (a) => String(a).toLowerCase();
const ZERO = lc(C.NATIVE); // pons' native pairToken == V4's native sentinel, address(0)

const V2_FACTORY = lc(C.PONS_V2_FACTORY);
const V1_FACTORY = lc(C.PONS_V1_FACTORY);
const STATE_VIEW = lc(C.STATE_VIEW);
const PERMIT2 = lc(C.PERMIT2);
const UNIVERSAL_ROUTER = lc(C.UNIVERSAL_ROUTER);
const SWAP_ROUTER02 = lc(C.SWAP_ROUTER02);
const WETH = lc(C.WETH);

// getLaunchedToken().phase — evm/v3/poolswap.js:135-140.
const PHASE_CURVE = 0;
const PHASE_GRADUATED = 2;

// A cap, not an eviction policy anyone should rely on: only GENUINE pons tokens
// are cached (refusals never are), so this is bounded by the launchpad itself.
const MAX_CACHE = 5000;

const v2FactoryIface = new Interface(C.ABI.V2_FACTORY);
const v1FactoryIface = new Interface(C.ABI.V1_FACTORY);
const erc20Iface = new Interface(C.ABI.ERC20);
const curveIface = new Interface(C.ABI.CURVE);
const stateViewIface = new Interface(C.ABI.STATE_VIEW);
const v3FactoryIface = new Interface(C.ABI.V3_FACTORY);
const v3PoolIface = new Interface(C.ABI.V3_POOL);

const coder = AbiCoder.defaultAbiCoder();

const cache = new Map(); // token (lower-case) -> latest Venue
const inflight = new Map(); // token -> Promise<Venue>, so a burst of loads reads once

function providerOf(deps) {
  return deps.provider || providers.tpReadProvider();
}

// Token names and symbols come from a pasted CA and are attacker-controlled
// text. The page renders them as React text only; here they are also stripped
// of control characters and capped, so the payload stays small and plain.
// Filtered by code point on purpose: no escape sequences in this source.
//
// The same code points tokenInfo.keepCode strips, because name, symbol and pairSymbol
// are spliced into RUNNING TEXT the visitor acts on — "Convert <symbol> -> ETH" on the
// convert button, "<amount> <symbol> -> ETH" on each row, "Swap the <pairSymbol> into
// ETH now" in its tooltip. One unterminated RLO (U+202E) in a symbol reverses
// everything after it inside that box, so the button can be made to read as if it
// converted the other way round. C1 controls (128-159) and the bidi isolates
// (U+2066-2069) go for the same reason.
function cleanText(value, fallback) {
  if (value == null) return fallback;
  const kept = Array.from(String(value)).filter((ch) => {
    const c = ch.codePointAt(0);
    if (c < 32 || c === 127 || (c >= 128 && c <= 159)) return false;
    if ((c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return false;
    return true;
  });
  const s = kept.slice(0, 64).join('').trim();
  return s || fallback;
}

const shortAddr = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;

/**
 * PoolKey + poolId for a pons graduated pool. Currencies sorted ascending
 * (V4 requires currency0 < currency1; the native sentinel 0x0 always sorts
 * first). Copied from evm/v5/swap.js:247-281.
 */
function poolKeyFor({ token, quote, hook, fee, tickSpacing }) {
  const t = lc(token);
  const q = lc(quote);
  const h = lc(hook);
  const quoteIsCurrency0 = BigInt(q) < BigInt(t);
  const currency0 = quoteIsCurrency0 ? q : t;
  const currency1 = quoteIsCurrency0 ? t : q;
  const poolKey = { currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: h };
  const poolId = keccak256(
    coder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [currency0, currency1, poolKey.fee, poolKey.tickSpacing, h]
    )
  );
  return { poolKey, poolId, quoteIsCurrency0 };
}

/** Every Venue carries every key; what does not apply to its kind is null. */
function makeVenue(base, fields) {
  return {
    ...base,
    curve: null,
    poolKey: null,
    poolId: null,
    pool: null,
    phase: null,
    // extras beyond the plan's interface contract (see "Contract notes")
    formerCurve: null,
    hook: null,
    quoteIsCurrency0: null,
    poolFee: null,
    tokenIsToken0: null,
    router: null,
    ...fields,
  };
}

/** The phase-independent part of a Venue — what refreshPhase carries across. */
function baseOf(v) {
  return {
    kind: v.kind,
    token: v.token,
    name: v.name,
    symbol: v.symbol,
    decimals: v.decimals,
    totalSupply: v.totalSupply,
    pairToken: v.pairToken,
    pairSymbol: v.pairSymbol,
    pairDecimals: v.pairDecimals,
    nativeQuote: v.nativeQuote,
  };
}

function remember(venue) {
  if (!cache.has(venue.token) && cache.size >= MAX_CACHE) {
    cache.delete(cache.keys().next().value); // oldest first
  }
  cache.set(venue.token, venue);
}

/** The pool's hook: the launch's own pin first, the factory's memeHook() only as fallback. */
function pickHook(pin, meme) {
  if (pin != null && lc(pin) !== ZERO) return { hook: lc(pin), source: 'curve.feePolicy' };
  if (meme != null && lc(meme) !== ZERO) return { hook: lc(meme), source: 'factory.memeHook' };
  return null;
}

async function readHook(curve, deps) {
  const slots = await aggregate3(providerOf(deps), [
    { target: curve, callData: curveIface.encodeFunctionData('feePolicy') },
    { target: V2_FACTORY, callData: v2FactoryIface.encodeFunctionData('memeHook') },
  ]);
  return pickHook(one(curveIface, 'feePolicy', slots[0]), one(v2FactoryIface, 'memeHook', slots[1]));
}

/**
 * The v2 Venue for the phase in `rec` (a getLaunchedToken record). `hookInfo`
 * may be passed when the caller already read it; otherwise it is read here.
 */
async function venueForPhase(base, rec, hookInfo, deps) {
  const phase = Number(rec.phase);
  const curve = lc(rec.curve);

  if (phase === PHASE_CURVE) {
    if (curve === ZERO) {
      throw new TpError('unavailable', `the factory names no curve for ${base.token}`, 503);
    }
    return makeVenue({ ...base, kind: 'curve' }, { curve, phase, spenders: { approve: curve } });
  }

  if (phase === PHASE_GRADUATED) {
    const h = hookInfo || (await readHook(curve, deps));
    if (!h) {
      throw new TpError(
        'unavailable',
        `${base.token} graduated but neither its curve nor the factory names a hook, so its pool cannot be found`,
        503
      );
    }
    const { poolKey, poolId, quoteIsCurrency0 } = poolKeyFor({
      token: base.token,
      quote: base.pairToken,
      hook: h.hook,
      fee: rec.poolFee,
      tickSpacing: rec.tickSpacing,
    });
    // THE SECOND GATE (poolswap.js:266-282): the chain has the last word on
    // whether that PoolKey is a real, liquid pool.
    const slots = await aggregate3(providerOf(deps), [
      { target: STATE_VIEW, callData: stateViewIface.encodeFunctionData('getSlot0', [poolId]) },
      { target: STATE_VIEW, callData: stateViewIface.encodeFunctionData('getLiquidity', [poolId]) },
    ]);
    const slot0 = decodeSlot(stateViewIface, 'getSlot0', slots[0]);
    const liquidity = one(stateViewIface, 'getLiquidity', slots[1]);
    if (!slot0 || BigInt(slot0[0]) === 0n) {
      throw new TpError(
        'migrating',
        `${base.token} has graduated but its Uniswap v4 pool (${poolId}) is not live yet — try again shortly`,
        409
      );
    }
    if (liquidity == null || BigInt(liquidity) === 0n) {
      throw new TpError('unavailable', `the Uniswap v4 pool for ${base.token} holds no liquidity — a sell cannot fill`, 503);
    }
    return makeVenue(
      { ...base, kind: 'graduated' },
      {
        poolKey,
        poolId,
        phase,
        formerCurve: curve,
        hook: h.hook,
        quoteIsCurrency0,
        // The UniversalRouter pulls the token through Permit2 (poolswap.js:494-499),
        // so the token approves Permit2 and Permit2 approves the router.
        spenders: { approve: PERMIT2, permit2Router: UNIVERSAL_ROUTER },
      }
    );
  }

  throw new TpError(
    'migrating',
    `${base.token} is in phase ${phase} — neither on its curve nor graduated, most likely mid-migration. Try again shortly.`,
    409
  );
}

async function fromV2(meta, rec, deps) {
  const curve = lc(rec.curve);
  const pairToken = lc(rec.pairToken);
  const recordSaysNative = pairToken === ZERO;
  const calls = [
    { target: curve, callData: curveIface.encodeFunctionData('isNativeQuote') },
    { target: curve, callData: curveIface.encodeFunctionData('feePolicy') },
    { target: V2_FACTORY, callData: v2FactoryIface.encodeFunctionData('memeHook') },
  ];
  if (!recordSaysNative) {
    calls.push({ target: pairToken, callData: erc20Iface.encodeFunctionData('symbol') });
    calls.push({ target: pairToken, callData: erc20Iface.encodeFunctionData('decimals') });
  }
  const slots = await aggregate3(providerOf(deps), calls);

  const curveSaysNative = one(curveIface, 'isNativeQuote', slots[0]);
  if (curveSaysNative != null && Boolean(curveSaysNative) !== recordSaysNative) {
    throw new TpError(
      'unavailable',
      `the curve and the factory disagree about what ${meta.token} is priced in — refusing to guess`,
      422
    );
  }

  let pairSymbol = 'ETH';
  let pairDecimals = 18;
  if (!recordSaysNative) {
    const d = one(erc20Iface, 'decimals', slots[4]);
    if (d == null) {
      throw new TpError('unavailable', `the pair token ${pairToken} did not answer decimals()`, 503);
    }
    pairDecimals = Number(d);
    pairSymbol = cleanText(one(erc20Iface, 'symbol', slots[3]), shortAddr(pairToken));
  }

  const base = { kind: null, ...meta, pairToken, pairSymbol, pairDecimals, nativeQuote: recordSaysNative };
  const hookInfo = pickHook(one(curveIface, 'feePolicy', slots[1]), one(v2FactoryIface, 'memeHook', slots[2]));
  return venueForPhase(base, rec, hookInfo, deps);
}

async function fromV1(meta, rec, deps) {
  const provider = providerOf(deps);
  const pairToken = lc(rec.pairedToken);
  const poolFee = Number(rec.poolFee);

  const cfg = await aggregate3(provider, [
    { target: V1_FACTORY, callData: v1FactoryIface.encodeFunctionData('getDexConfig', [rec.dexId]) },
    { target: V1_FACTORY, callData: v1FactoryIface.encodeFunctionData('getLaunchConfig', [rec.launchConfigId]) },
  ]);
  const dex = one(v1FactoryIface, 'getDexConfig', cfg[0]);
  const launch = one(v1FactoryIface, 'getLaunchConfig', cfg[1]);
  if (!dex || !launch) {
    throw new TpError('unavailable', `could not read the dex/launch config of pons v1 token ${meta.token}`, 503);
  }

  // The v1 sell is token -> WETH through SwapRouter02, unwrapped to the seller
  // in the same tx (evm/router.js:81-170). Any other pair or router shape would
  // leave the proceeds on the router, so it is refused rather than guessed at.
  if (pairToken !== WETH) {
    throw new TpError(
      'unavailable',
      `${meta.token} is a pons v1 launch paired with ${pairToken}; only WETH-paired v1 launches can be sold here`,
      422
    );
  }
  const router = lc(dex.swapRouter);
  if (router !== SWAP_ROUTER02 || Boolean(launch.routerRequiresDeadline)) {
    throw new TpError(
      'unavailable',
      `${meta.token} trades through router ${router}${launch.routerRequiresDeadline ? ' (deadline shape)' : ''}; ` +
        `this page sells pons v1 tokens through SwapRouter02 ${SWAP_ROUTER02} only`,
      422
    );
  }

  const dexFactory = lc(dex.factory);
  const found = await aggregate3(provider, [
    { target: dexFactory, callData: v3FactoryIface.encodeFunctionData('getPool', [meta.token, pairToken, poolFee]) },
  ]);
  const poolAddr = one(v3FactoryIface, 'getPool', found[0]);
  if (poolAddr == null || lc(poolAddr) === ZERO) {
    throw new TpError('unavailable', `no ${poolFee / 10000}% pool for ${meta.token} — the dex factory has none`, 503);
  }
  const pool = lc(poolAddr);

  const ps = await aggregate3(provider, [
    { target: pool, callData: v3PoolIface.encodeFunctionData('token0') },
    { target: pool, callData: v3PoolIface.encodeFunctionData('slot0') },
  ]);
  const token0 = one(v3PoolIface, 'token0', ps[0]);
  const slot0 = decodeSlot(v3PoolIface, 'slot0', ps[1]);
  if (token0 == null || !slot0 || BigInt(slot0[0]) === 0n) {
    throw new TpError('unavailable', `the pons v1 pool ${pool} did not answer token0()/slot0()`, 503);
  }

  return makeVenue(
    { ...meta, kind: 'v1', pairToken, pairSymbol: 'ETH', pairDecimals: 18, nativeQuote: true },
    {
      pool,
      poolFee,
      tokenIsToken0: lc(token0) === meta.token,
      router,
      spenders: { approve: router },
    }
  );
}

async function resolveFresh(token, deps) {
  const provider = providerOf(deps);
  const [code, slots] = await Promise.all([
    provider.getCode(token),
    aggregate3(provider, [
      { target: V2_FACTORY, callData: v2FactoryIface.encodeFunctionData('getLaunchedToken', [token]) },
      { target: V1_FACTORY, callData: v1FactoryIface.encodeFunctionData('getLaunchedToken', [token]) },
      { target: token, callData: erc20Iface.encodeFunctionData('name') },
      { target: token, callData: erc20Iface.encodeFunctionData('symbol') },
      { target: token, callData: erc20Iface.encodeFunctionData('decimals') },
      { target: token, callData: erc20Iface.encodeFunctionData('totalSupply') },
    ]),
  ]);

  if (!code || code === '0x') {
    throw new TpError('not_contract', `${token} has no contract code on chain ${C.CHAIN_ID}`);
  }

  const v2rec = one(v2FactoryIface, 'getLaunchedToken', slots[0]);
  const v1rec = one(v1FactoryIface, 'getLaunchedToken', slots[1]);
  const isV2 = Boolean(v2rec && v2rec.exists);
  const isV1 = !isV2 && Boolean(v1rec && v1rec.exists);
  if (!isV2 && !isV1) {
    throw new TpError(
      'not_pons',
      `${token} is not a pons launch — neither the pons v2 nor the pons v1 factory has a record of it`
    );
  }

  const decimals = one(erc20Iface, 'decimals', slots[4]);
  const totalSupply = one(erc20Iface, 'totalSupply', slots[5]);
  if (decimals == null || totalSupply == null) {
    throw new TpError('unavailable', `${token} did not answer decimals()/totalSupply()`, 503);
  }
  const meta = {
    token,
    name: cleanText(one(erc20Iface, 'name', slots[2]), ''),
    symbol: cleanText(one(erc20Iface, 'symbol', slots[3]), shortAddr(token)),
    decimals: Number(decimals),
    totalSupply: BigInt(totalSupply).toString(),
  };

  return isV2 ? fromV2(meta, v2rec, deps) : fromV1(meta, v1rec, deps);
}

/**
 * CA -> Venue, the LOAD path: a cache hit re-reads the phase. (The send path
 * uses cachedVenue, which does not.) Throws TpError: bad_address,
 * not_contract, not_pons, migrating, unavailable. `deps.provider` replaces the
 * shared read provider (tests; the indexer's chart provider).
 */
async function resolveVenue(ca, deps = {}) {
  if (typeof ca !== 'string' || !isAddress(ca)) {
    throw new TpError('bad_address', 'that is not a valid token contract address');
  }
  const token = lc(ca);
  const cached = cache.get(token);
  if (cached) return refreshPhase(cached, deps);
  if (inflight.has(token)) return inflight.get(token);

  const pending = resolveFresh(token, deps)
    .then((venue) => {
      remember(venue);
      return venue;
    })
    .finally(() => inflight.delete(token));
  inflight.set(token, pending);
  return pending;
}

/**
 * Re-read a v2 token's phase. The SAME object comes back when nothing changed;
 * a NEW Venue (also cached) when it did. A v1 venue has no phase and is
 * returned as is, with no read. Throws TpError('migrating') while the phase is
 * neither 0 nor 2 — callers that poll (the indexer) retry.
 */
async function refreshPhase(venue, deps = {}) {
  if (!venue || venue.kind === 'v1') return venue;
  const raw = await providerOf(deps).call({
    to: V2_FACTORY,
    data: v2FactoryIface.encodeFunctionData('getLaunchedToken', [venue.token]),
  });
  const rec = v2FactoryIface.decodeFunctionResult('getLaunchedToken', raw)[0];
  if (!rec.exists) {
    throw new TpError('not_pons', `${venue.token} is no longer in the pons v2 registry`);
  }
  if (Number(rec.phase) === venue.phase) return venue;
  const next = await venueForPhase(baseOf(venue), rec, null, deps);
  remember(next);
  return next;
}

/**
 * The SEND path's lookup (POST /broadcast, POST /quote): the cached Venue with
 * NO chain read, or a full resolveVenue on a miss (a token this process has not
 * loaded yet). Unlike resolveVenue it does not re-read the phase on a hit, so a
 * click never waits on an RPC round trip before its first
 * eth_sendRawTransaction (spec: only latency counts).
 *
 * How stale can a hit be? Only the phase can change, and:
 *   - while a page streams the token, its indexer re-reads the phase every
 *     10 s (indexer.js PHASE_MS) through refreshPhase, which replaces this
 *     cache entry the moment it changes;
 *   - every GET /token/:ca and POST /wallets goes through resolveVenue, which
 *     re-reads it too;
 *   - POST /broadcast re-reads it ONCE with refreshPhase when a batch is refused
 *     against the cached venue (the page re-armed for Permit2 after a
 *     graduation) — off the happy path. POST /quote does the same on a
 *     'graduated' quote.
 * A curve sell admitted against a curve that has just graduated reverts on the
 * dead curve (evm/v2/curve.js:78 — a graduated curve reverts trades): the
 * signer's own transaction, exactly as when a click races the graduation.
 */
async function cachedVenue(ca, deps = {}) {
  if (typeof ca !== 'string' || !isAddress(ca)) {
    throw new TpError('bad_address', 'that is not a valid token contract address');
  }
  const hit = cache.get(lc(ca));
  if (hit) return hit;
  return resolveVenue(ca, deps);
}

/** Tests only: forget every resolved venue. */
function _clearCache() {
  cache.clear();
  inflight.clear();
}

module.exports = {
  resolveVenue,
  refreshPhase,
  cachedVenue,
  poolKeyFor,
  PHASE_CURVE,
  PHASE_GRADUATED,
  _clearCache,
};
