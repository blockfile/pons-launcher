'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// V3's GRADUATED-POOL leg: trade a pons v2 token AFTER its bonding curve bonded.
//
// WHY THIS EXISTS. A pons v2 launch trades on a bonding curve until it graduates
// ("bonds"), at which point the launchpad migrates the liquidity into a Uniswap
// V4 pool and the curve is dead (tokenReserve 0, graduated() true). V3's engine,
// exit and sellMain all refuse a graduated curve — correctly, because the curve
// can no longer fill — but that left a bonded position sellable only by hand on a
// website. A live run bonded mid-flight and stranded 2.7 ETH that way. This module
// is the missing venue: the same position, quoted and built against the migrated
// V4 pool.
//
// It READS, QUOTES and BUILDS only. It never signs and never broadcasts, which is
// what lets every claim below be checked against the chain before a wei moves.
//
// ── WHAT WAS VERIFIED, AND HOW (chain 4663, live) ────────────────────────────
// Reference pool used throughout — token 0xd8865AA9…b101, pairToken SPCX
// 0x4a0E65A3…5eEa, poolFee 0, tickSpacing 200, phase 2, curve 0x03eF670d…92D81
// (tokenReserve 0):
//
//  1. poolId — keccak256(abi.encode(PoolKey)) with currencies sorted ascending,
//     fee/tickSpacing from getLaunchedToken and hooks = the pons meme hook gives
//     0x048c7f7f128df4df2ca6394512ee2f949b9cff0ab4cb39ec84dd28aa8c39ff62, which
//     StateView reports INITIALISED (sqrtPriceX96 5.100e32, tick 174972,
//     liquidity 1.2139e23). Every wrong variant — currencies reversed, hook
//     omitted, fee 3000, tickSpacing 60, ETH substituted for the pair — hashes to
//     a pool that is NOT initialised. Cross-checked at scale: 621 PoolManager
//     Initialize events carrying this hook ALL reproduce from this derivation,
//     and 14/14 sampled phase-2 launches (native- and ERC-20-quoted alike)
//     resolve to a live, liquid pool.
//
//  2. calldata — the SWAP_EXACT_IN_SINGLE param this module emits is BYTE-FOR-BYTE
//     identical to that of a REAL, confirmed direct-to-UniversalRouter V4 sell on
//     this very pons pool: tx 0x766d3e730b9a286ea34d50b46b35bab7d86de1efbf708bd5
//     6377e02232fc061d. That is the fund-critical half of the payload — PoolKey,
//     direction, amounts, sqrtPriceLimit, hookData. See poolswap.test.js.
//
//  3. fill — the exact bytes this module builds, eth_simulateV1'd against LIVE
//     state (balance-overridden sender, approvals in the same block), FILL the
//     pons hook's pool and honour minOut, in all four directions. See the FILL
//     EVIDENCE block in poolswap.test.js for the numbers.
//
// ── THE POOL IS ERC-20-QUOTED AS OFTEN AS IT IS NATIVE ───────────────────────
// A pons launch is quoted in native ETH (pairToken address(0)) or in an approved
// ERC-20 (SPCX, USDG, AMZN…). The V4 pool inherits that: for a native launch
// currency0 is V4's native sentinel address(0) and a sell pays NATIVE ETH straight
// to the recipient (verified — the proceeds land at an explicit recipient, not in
// the router). For an ERC-20-quoted launch the proceeds are that pair token, and
// getting to ETH is a second leg the CALLER sequences through swaproute.js —
// exactly as the curve path already does. `isNativeQuote` on the resolved pool is
// how a caller tells the two apart.
//
// ── THE HOOK: PINNED PER LAUNCH, THEN VERIFIED ───────────────────────────────
// v5 learned the hard way that a launchpad's hook is per-pool and that a config
// default is a footgun. pons is friendlier: the hook is frozen into the launch's
// own CURVE as `feePolicy()`, so it can be read per-launch rather than guessed —
// and it cannot drift if the factory owner ever re-points memeHook(). This module
// reads the curve's pin first and falls back to factory.memeHook() only when the
// curve has no such getter, and then STILL verifies the resulting poolId is
// initialised and liquid before returning it. Two independent gates, no probing.
//
// PROVENANCE comes free: getLaunchedToken(token).exists is the FACTORY vouching
// that this token is one of its launches, so a dusted look-alike is refused before
// any pool is built. No clone-code probe (v6/v7) or log scan is needed.
//
// ── THE HOOK SETS THE FEE, AND THE QUOTER ALREADY NETS IT OUT ────────────────
// poolFee is 0 in the PoolKey WITH a hook attached, so the trading fee is charged
// by the hook, not by the pool: the observed skim is hook.hookFeeBps + the
// launch's creatorTaxBps (200 bps on the reference pool, 300 on another), taken
// off the QUOTE side. The important, measured fact is that the V4Quoter's
// amountOut is ALREADY NET of it: in every live fill the amount the wallet
// actually received equalled expectedOut to the wei. So a minOut sized from a
// quote is directly comparable to what lands, and there is no separate tax maths
// here. A too-tight minOut reverts V4TooLittleReceived (0x8b063d73) — proven both
// directions.
//
// ── WHY THIS IMPORTS evm/v5/swap.js's ENCODERS (tab isolation, deliberately) ──
// The house rule is that each tab owns its modules and duplication beats sharing.
// It is followed here for everything that is a POLICY decision — pons resolution,
// the phase gate, the hook pin, the impact guard, the floors — all of which live
// in this file, in evm/v3/, and nowhere else.
//
// The one thing imported is the PURE, PARAMETERISED V4 CALLDATA ENCODER
// (poolKeyFor / encodeExactInSingleExecute / buildBuyTx / buildSellTx /
// buildPermit2Approvals / the StateView reads). That is not letscash policy: it is
// this chain's UniversalRouter + V4 ABI, including the one non-obvious quirk this
// router carries (the OLDER SIX-field ExactInputSingleParams with
// sqrtPriceLimitX96 — omit it and every following word shifts by 32 bytes and the
// router cannot decode the payload). Every address it uses is passed in from the
// block below, so nothing letscash-shaped leaks in.
//
// Copying 818 lines of fund-critical encoder to satisfy the letter of the rule
// would create a SECOND set of bytes that move real money and can silently drift
// from the first — the failure mode the rule exists to prevent, inverted. And the
// import is not taken on trust: the encoder's output is RE-VERIFIED here for the
// pons hook, independently of v5's own evidence, by the byte-for-byte match
// against the real pons tx and by the live fills recorded above.
// ─────────────────────────────────────────────────────────────────────────────

const { Contract, Interface, getAddress } = require('ethers');

const config = require('../../config');
const { provider } = require('../provider');
// The pons v2 protocol ABI. v3/trade.js already reads CURVE_V2_ABI from here —
// evm/v2 is the launchpad's contract layer, not another tab's module.
const { FACTORY_V2_ABI } = require('../v2/abi');
// The pure V4/UniversalRouter encoder — see the justification above.
const v4 = require('../v5/swap');

// ── The chain's V4 singletons ────────────────────────────────────────────────
// NOT letscash's: every V4 pool on chain 4663 shares them, which was confirmed
// rather than assumed — StateView.poolManager(), V4Quoter.poolManager() and the
// pons memeHook's own poolManager() all return the same PoolManager, and a real
// confirmed pons V4 swap went through this UniversalRouter. Held here (rather than
// reached for out of another tab's config block) so this module owns its
// addresses; every one is overridable through `deps` for tests and redeployments.
//
// Stored lower-case on purpose: the UniversalRouter's mixed-case form is NOT a
// valid EIP-55 checksum, so getAddress() on the literal would throw — always
// normalise from lower-case.
const V4_ADDRESSES = {
  poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
  universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
  quoter: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
};

// V4's native-coin sentinel. Also what pons uses for a native-quoted launch's
// pairToken, so the two line up with no translation.
const NATIVE = '0x0000000000000000000000000000000000000000';

// getLaunchedToken().phase. 0 = still on the bonding curve; 2 = GRADUATED, the
// liquidity has migrated to the V4 pool and only this module can trade it. Any
// other value is a state we have never observed (a migration in flight, most
// likely) and is refused rather than guessed at.
const PHASE_CURVE = 0;
const PHASE_GRADUATED = 2;

// The launch's frozen fee-policy address IS the pool's hook (see the header).
const curvePinIface = new Interface(['function feePolicy() view returns (address)']);

// Generous gas caps for the integration pass (unused gas is refunded). Measured
// live: native buy 156.6k, native sell 172.6k, ERC-20-pair sell 200.6k, each
// approval ~47k. Doubled for headroom, and because a hook's cost varies with how
// many ticks a swap crosses.
const POOL_SWAP_GAS = 500000n;
const POOL_APPROVE_GAS = 100000n;

// The floors a caller gets when it does not name one. Deliberately the SAME
// numbers v3/trade.js already uses for its swap leg, so the pool venue and the
// route venue behave alike: 3% for a cycle, 20% for an exit that must get out.
// Environment-tunable through the very same variables, for the same reason.
const DEFAULT_SLIPPAGE_BPS = Number(process.env.V3_ROUTE_SLIPPAGE_BPS) || 300; // 3%
const EXIT_SLIPPAGE_BPS = Number(process.env.V3_EXIT_ROUTE_SLIPPAGE_BPS) || 2000; // 20%

const norm = (a) => getAddress(String(a).toLowerCase());

/**
 * Resolve addresses + provider once, and build the `deps` handed down to the V4
 * encoder so it never reads another tab's config.
 */
function wire(deps = {}) {
  const rpc = deps.provider || provider;
  const universalRouter = norm(deps.universalRouter || V4_ADDRESSES.universalRouter);
  const quoter = norm(deps.quoter || V4_ADDRESSES.quoter);
  const stateView = norm(deps.stateView || V4_ADDRESSES.stateView);
  const permit2 = norm(deps.permit2 || V4_ADDRESSES.permit2);
  const poolManager = norm(deps.poolManager || V4_ADDRESSES.poolManager);
  const factoryAddress = norm(deps.v2Factory || config.v2FactoryAddress);
  return {
    provider: rpc,
    universalRouter,
    quoter,
    stateView,
    permit2,
    poolManager,
    factoryAddress,
    maxImpactBps: deps.maxImpactBps != null ? Number(deps.maxImpactBps) : Number(config.v3Route.maxImpactBps),
    // What every call into the V4 encoder gets. Addresses only — the pool, the
    // hook and the direction are always passed explicitly at the call site.
    v4: { provider: rpc, universalRouter, quoter, stateView, permit2 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// resolvePonsPool — THE entry point. Everything else takes what this returns.
//
// Asks the pons factory what this token is, refuses anything that is not one of
// its GRADUATED launches, reads the hook the launch itself pinned, derives the
// PoolKey (currencies sorted ascending, as V4 requires) and its poolId, and only
// then confirms against StateView that the pool is initialised and liquid. A
// caller can therefore never build a trade against a PoolKey the chain has never
// heard of, nor against a curve that has not bonded.
//
// @returns {Promise<{token,curve,pairToken,isNativeQuote,poolFee,tickSpacing,
//   phase,hook,hookSource,poolKey,poolId,quoteIsCurrency0,sqrtPriceX96,tick,
//   liquidity}>}
// ─────────────────────────────────────────────────────────────────────────────
async function resolvePonsPool({ token, requireLiquidity = true } = {}, deps = {}) {
  const w = wire(deps);
  if (!token) throw new Error('resolvePonsPool: a token address is required');
  const tokenAddr = norm(token);

  const factory = new Contract(w.factoryAddress, FACTORY_V2_ABI, w.provider);
  const launch = await factory.getLaunchedToken(tokenAddr);

  // PROVENANCE. The factory itself vouches for the token; an unknown address —
  // dust, a look-alike, another launchpad's token — stops here.
  if (!launch.exists) {
    throw new Error(
      `${tokenAddr} is not a pons v2 launch (the factory at ${w.factoryAddress} has no record of it) — ` +
        'refusing to build a trade against a pool it never created'
    );
  }

  const phase = Number(launch.phase);
  const curve = norm(launch.curve);
  if (phase !== PHASE_GRADUATED) {
    throw new Error(
      phase === PHASE_CURVE
        ? `${tokenAddr} has NOT graduated (phase ${phase}) — it still trades on its bonding curve at ${curve}. ` +
          'Trade it there; this module is only for a bonded token.'
        : `${tokenAddr} is in phase ${phase}, which is neither on-curve (${PHASE_CURVE}) nor graduated ` +
          `(${PHASE_GRADUATED}) — most likely mid-migration. Refusing to trade an in-between state.`
    );
  }

  const pairToken = norm(launch.pairToken);
  const isNativeQuote = pairToken === norm(NATIVE);
  const poolFee = Number(launch.poolFee);
  const tickSpacing = Number(launch.tickSpacing);

  // THE HOOK. The launch's own curve pins it (feePolicy, frozen at launch), which
  // survives the factory re-pointing memeHook() later. memeHook() is only the
  // fallback for a curve too old to carry the getter.
  let hook = null;
  let hookSource = 'curve.feePolicy';
  try {
    const raw = await w.provider.call({ to: curve, data: curvePinIface.encodeFunctionData('feePolicy', []) });
    if (raw && raw !== '0x') hook = norm(curvePinIface.decodeFunctionResult('feePolicy', raw)[0]);
  } catch (_err) {
    hook = null; // no pin on this curve — fall back below
  }
  if (!hook || hook === norm(NATIVE)) {
    hook = norm(await factory.memeHook());
    hookSource = 'factory.memeHook';
  }
  if (!hook || hook === norm(NATIVE)) {
    throw new Error(
      `${tokenAddr} graduated but neither its curve (${curve}) nor the factory names a hook — ` +
        'without the hook the PoolKey cannot be built'
    );
  }

  // The PoolKey. V4 requires currency0 < currency1 numerically; the encoder sorts
  // them, and the native sentinel (0x0) is always the smallest, so a native launch
  // lands with ETH as currency0 automatically.
  const { poolKey, poolId, quoteIsCurrency0 } = v4.poolKeyFor(
    { token: tokenAddr, quote: pairToken, hook, poolFee, tickSpacing },
    w.v4
  );

  // THE SECOND GATE. A PoolKey that hashes to an uninitialised pool would settle
  // real funds into nothing, so the chain gets the last word.
  const slot0 = await v4.readSlot0(poolId, w.v4);
  if (slot0.sqrtPriceX96 === 0n) {
    throw new Error(
      `the pool for ${tokenAddr} (poolId ${poolId}, hook ${hook} from ${hookSource}, pair ` +
        `${isNativeQuote ? 'NATIVE' : pairToken}, fee ${poolFee}, tickSpacing ${tickSpacing}) is NOT initialised ` +
        'on-chain — refusing to trade against a pool that does not exist'
    );
  }
  const liquidity = await v4.readLiquidity(poolId, w.v4);
  if (requireLiquidity && liquidity <= 0n) {
    throw new Error(
      `the pool for ${tokenAddr} (poolId ${poolId}) is initialised but holds NO liquidity — a swap against it ` +
        'cannot fill'
    );
  }

  return {
    token: tokenAddr,
    curve,
    pairToken,
    isNativeQuote,
    poolFee,
    tickSpacing,
    phase,
    hook,
    hookSource,
    poolKey,
    poolId,
    quoteIsCurrency0,
    sqrtPriceX96: slot0.sqrtPriceX96,
    tick: slot0.tick,
    liquidity,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PRICE-IMPACT detector — the same shape, and the same lesson, as swaproute.js's
// assessImpact.
//
// The V4Quoter SATURATES on an oversized input: it does NOT revert, it returns
// most of the pool. Measured on the reference pons pool — 0.001 SPCX in quotes at
// 4.22e7 tokens per SPCX, while 1,000,000 SPCX in quotes at 7.8e2 per SPCX and
// hands back 7.8e26 tokens, ~the whole side. A per-quote slippage floor is
// structurally BLIND to that, because the floor is derived from the same saturated
// quote and therefore "expects" the drained output and permits it. Only a
// comparison against a near-spot rate can see it, which is what this is.
//
// The probe is a THOUSANDTH of the trade rather than swaproute's fixed 0.001 of an
// 18-decimal asset, because here the input is sometimes a token amount in the 1e24
// range and sometimes a pair token whose decimals are not ours to assume. A trade
// too small to divide by 1000 IS its own probe, which yields impact 0 — correct,
// since a sub-1000-wei trade cannot drain anything.
//
// The number this returns is a FLOOR on the true impact, not an estimate of it: at
// an absurd size even the thousandth-sized probe saturates, so the two rates
// converge and the reported impact understates reality (a 1,000,000-SPCX buy on the
// reference pool reads 99.90% against a true ~99.998%). That is harmless — anything
// in that regime is already an order of magnitude over any sane cap — and it is the
// safe direction to be wrong in for a guard that refuses on a HIGH reading.
//
// @returns {Promise<{impactBps:number, fullOut:bigint, probeOut:bigint, probeIn:bigint}>}
// ─────────────────────────────────────────────────────────────────────────────
const IMPACT_PROBE_DIVISOR = 1000n;

function probeFor(amountIn) {
  const amt = BigInt(amountIn);
  const probe = amt / IMPACT_PROBE_DIVISOR;
  return probe > 0n ? probe : amt;
}

async function assessImpact({ poolKey, zeroForOne, amountIn, probeIn }, deps = {}) {
  const w = wire(deps);
  const amt = BigInt(amountIn);
  const probe = probeIn != null ? BigInt(probeIn) : probeFor(amt);
  if (amt <= 0n || probe <= 0n) return { impactBps: 10_000, fullOut: 0n, probeOut: 0n, probeIn: probe };

  // v4.quoteBuy means "spend the `quote` currency", and it derives zeroForOne as
  // (quote === currency0). So naming the currency this swap puts IN as the quote
  // makes it an exact-in quote in EITHER direction — one code path for buy and
  // sell, with the direction stated once, here.
  const spends = keyCurrency(poolKey, zeroForOne);
  const quote = (amount) => v4.quoteBuy({ poolKey, quote: spends, amountInWei: amount }, w.v4);
  const [probeRes, fullRes] = await Promise.all([quote(probe), quote(amt)]);
  const probeOut = probeRes.expectedOut;
  const fullOut = fullRes.expectedOut;

  // Without a spot rate there is nothing to compare against — report the worst.
  if (probeOut <= 0n) return { impactBps: 10_000, fullOut, probeOut, probeIn: probe };

  // impactBps = 10000 · (1 − (fullOut/amt) / (probeOut/probe))
  const kept = Number((fullOut * probe * 10_000n) / (probeOut * amt)); // bps KEPT vs spot
  return {
    impactBps: Math.max(0, Math.min(10_000, 10_000 - kept)),
    fullOut,
    probeOut,
    probeIn: probe,
  };
}

/** The currency a swap in `zeroForOne` spends — i.e. the one it puts IN. */
function keyCurrency(poolKey, zeroForOne) {
  return zeroForOne ? poolKey.currency0 : poolKey.currency1;
}

/** Impact of selling `tokensIn` of the launchpad token into the pool. */
async function assessSellImpact({ pool, tokensIn }, deps = {}) {
  // The sell spends the TOKEN, which is currency0 exactly when the pair is not.
  return assessImpact({ poolKey: pool.poolKey, zeroForOne: !pool.quoteIsCurrency0, amountIn: tokensIn }, deps);
}

/** Impact of buying the launchpad token with `amountIn` of the pair currency. */
async function assessBuyImpact({ pool, amountIn }, deps = {}) {
  return assessImpact({ poolKey: pool.poolKey, zeroForOne: pool.quoteIsCurrency0, amountIn }, deps);
}

/** floor(expectedOut · (10000 − bps) / 10000). 0 bps = no floor applied here. */
function applySlippage(expectedOut, slippageBps) {
  return v4.applySlippage(BigInt(expectedOut), slippageBps);
}

/**
 * The two quote functions share everything but direction. Both return the quote
 * AND the impact, because the two reads that produce them are the same two reads:
 * the impact probe's full-amount leg IS the quote.
 */
async function quoteDirection(
  { pool, amountIn, zeroForOne, slippageBps, maxImpactBps, liquidate, what },
  deps
) {
  const w = wire(deps);
  const amt = BigInt(amountIn);
  if (amt <= 0n) throw new Error(`${what}: a positive input amount is required`);

  const impact = await assessImpact({ poolKey: pool.poolKey, zeroForOne, amountIn: amt }, deps);

  // IMPACT GUARD. Refused here rather than merely reported, so an integrator who
  // forgets to look is still safe. `liquidate` is the deliberate opt-out for an
  // exit, which must always get out and accepts the pool's price to do it — the
  // same escape hatch v3/trade.js's route sell already has.
  const cap = maxImpactBps != null ? Number(maxImpactBps) : w.maxImpactBps;
  if (!liquidate && cap > 0 && impact.impactBps > cap) {
    throw new Error(
      `${what}: this trade would move the pool ${(impact.impactBps / 100).toFixed(1)}% (max ${cap / 100}%) — ` +
        'the pool is too thin for this size and most of the value would be lost to price impact. Trade a ' +
        'smaller slice, or pass liquidate:true to accept the price (the exit does).'
    );
  }

  const expectedOut = impact.fullOut;
  if (expectedOut <= 0n) {
    throw new Error(`${what}: the quoter returned no output for ${amt} — refusing to size a trade against nothing`);
  }
  const minOut = applySlippage(expectedOut, slippageBps);

  return {
    pool,
    expectedOut,
    minOut,
    impactBps: impact.impactBps,
    probeOut: impact.probeOut,
    probeIn: impact.probeIn,
    pairToken: pool.pairToken,
    isNativeQuote: pool.isNativeQuote,
    poolId: pool.poolId,
  };
}

/**
 * Quote a SELL: launchpad token in, the pair currency (or native ETH) out.
 *
 * `pool` is a resolvePonsPool() result; omit it and one is resolved. slippageBps
 * sizes minOut — pass a real one, the builders refuse a floorless trade.
 */
async function quoteSellToPair({ token, tokensIn, slippageBps, pool, maxImpactBps, liquidate = false } = {}, deps = {}) {
  const p = pool || (await resolvePonsPool({ token }, deps));
  return quoteDirection(
    {
      pool: p,
      amountIn: tokensIn,
      zeroForOne: !p.quoteIsCurrency0, // the sell spends the token
      slippageBps: slippageBps != null ? slippageBps : liquidate ? EXIT_SLIPPAGE_BPS : DEFAULT_SLIPPAGE_BPS,
      maxImpactBps,
      liquidate,
      what: 'quoteSellToPair',
    },
    deps
  );
}

/** Quote a BUY: the pair currency (or native ETH) in, launchpad token out. */
async function quoteBuyFromPair({ token, amountIn, slippageBps, pool, maxImpactBps, liquidate = false } = {}, deps = {}) {
  const p = pool || (await resolvePonsPool({ token }, deps));
  return quoteDirection(
    {
      pool: p,
      amountIn,
      zeroForOne: p.quoteIsCurrency0, // the buy spends the pair currency
      slippageBps: slippageBps != null ? slippageBps : liquidate ? EXIT_SLIPPAGE_BPS : DEFAULT_SLIPPAGE_BPS,
      maxImpactBps,
      liquidate,
      what: 'quoteBuyFromPair',
    },
    deps
  );
}

/** Both builders take the same shape; only direction and who pays differ. */
function assertBuildable(pool, amount, minOut, recipient, deadline, what) {
  if (!pool || !pool.poolKey || !pool.poolId) {
    throw new Error(`${what}: a verified pool is required — pass the resolvePonsPool() result as \`pool\``);
  }
  if (amount == null || BigInt(amount) <= 0n) throw new Error(`${what}: a positive input amount is required`);
  // NEVER FLOORLESS. The curve leg of a v3 exit is deliberately floor-free (a
  // curve quotes deterministically and reverts atomically), but this is a public
  // AMM pool: a floorless swap is a sandwich to zero. An exit that must get out
  // passes a WIDE floor, not none — the same rule v3/trade.js's swap leg follows.
  if (minOut == null || BigInt(minOut) <= 0n) {
    throw new Error(
      `${what}: minOut must be positive — a pool swap with no floor can be sandwiched to nothing. ` +
        'Size it from quoteSellToPair/quoteBuyFromPair (use a wide slippage for an exit).'
    );
  }
  if (!recipient) throw new Error(`${what}: a recipient is required`);
  if (deadline == null || BigInt(deadline) <= 0n) throw new Error(`${what}: a positive deadline is required`);
}

/**
 * SELL leg: launchpad token -> pair currency (or native ETH), delivered to
 * `recipient`. The UniversalRouter pulls the token from the seller via Permit2, so
 * the two `approvals` steps must land BEFORE this tx.
 *
 * @returns {{to, data, value, approvals}} value is always 0n (no native input).
 */
function buildSellToPair({ pool, tokensIn, minOut, recipient, deadline } = {}, deps = {}) {
  assertBuildable(pool, tokensIn, minOut, recipient, deadline, 'buildSellToPair');
  const w = wire(deps);
  return v4.buildSellTx(
    {
      token: pool.token,
      quote: pool.pairToken, // 0x0 for a native launch — V4's own sentinel
      tokensInWei: BigInt(tokensIn),
      minOut: BigInt(minOut),
      recipient,
      deadline,
      poolKey: pool.poolKey, // the VERIFIED key, never re-derived here
    },
    w.v4
  );
}

/**
 * BUY leg: pair currency (or native ETH) -> launchpad token, delivered to
 * `recipient`.
 *
 * @returns {{to, data, value, approvals?}} On a NATIVE-quoted pool `value` is
 *   exactly amountIn (it rides along as msg.value, so nothing is left in the
 *   router and no SWEEP is needed) and there are no approvals. On an ERC-20-quoted
 *   pool `value` is 0 and `approvals` carries the two Permit2 steps the router
 *   needs to pull the pair token.
 */
function buildBuyFromPair({ pool, amountIn, minOut, recipient, deadline } = {}, deps = {}) {
  assertBuildable(pool, amountIn, minOut, recipient, deadline, 'buildBuyFromPair');
  const w = wire(deps);
  return v4.buildBuyTx(
    {
      token: pool.token,
      quote: pool.pairToken,
      amountInWei: BigInt(amountIn),
      minOut: BigInt(minOut),
      recipient,
      deadline,
      poolKey: pool.poolKey,
    },
    w.v4
  );
}

/**
 * The two-step Permit2 approval an ERC-20 input needs before the UniversalRouter
 * can pull it: token.approve(Permit2, max), then Permit2.approve(token, router,
 * amount, never-expire). Returned unsigned as {to, data, value, label}. Both
 * builders already attach these where they are needed; this is here for a caller
 * that wants to send them separately (v3 sequences its own nonces).
 */
function buildApprovals({ inputToken, amount } = {}, deps = {}) {
  const w = wire(deps);
  return v4.buildPermit2Approvals({ inputToken, amount }, w.v4);
}

/**
 * SAFE SELL entry point: resolve the pool against the chain, quote it (with the
 * impact guard), and build against the verified PoolKey — in one call.
 *
 * @returns {{to,data,value,approvals,pool,expectedOut,minOut,impactBps}}
 */
async function resolveAndBuildSell(
  { token, tokensIn, slippageBps, recipient, deadline, pool, maxImpactBps, liquidate = false } = {},
  deps = {}
) {
  const p = pool || (await resolvePonsPool({ token }, deps));
  const q = await quoteSellToPair({ tokensIn, slippageBps, pool: p, maxImpactBps, liquidate }, deps);
  const tx = buildSellToPair({ pool: p, tokensIn, minOut: q.minOut, recipient, deadline }, deps);
  return { ...tx, pool: p, expectedOut: q.expectedOut, minOut: q.minOut, impactBps: q.impactBps };
}

/** SAFE BUY entry point — the mirror of resolveAndBuildSell. */
async function resolveAndBuildBuy(
  { token, amountIn, slippageBps, recipient, deadline, pool, maxImpactBps, liquidate = false } = {},
  deps = {}
) {
  const p = pool || (await resolvePonsPool({ token }, deps));
  const q = await quoteBuyFromPair({ amountIn, slippageBps, pool: p, maxImpactBps, liquidate }, deps);
  const tx = buildBuyFromPair({ pool: p, amountIn, minOut: q.minOut, recipient, deadline }, deps);
  return { ...tx, pool: p, expectedOut: q.expectedOut, minOut: q.minOut, impactBps: q.impactBps };
}

/**
 * Has this token graduated? A cheap read for the engine's halt path, which today
 * only knows "graduated ⇒ stop". Returns null for a token the factory does not
 * know, so a caller can tell "not a pons launch" from "not bonded yet".
 */
async function isGraduated(token, deps = {}) {
  const w = wire(deps);
  const factory = new Contract(w.factoryAddress, FACTORY_V2_ABI, w.provider);
  const launch = await factory.getLaunchedToken(norm(token));
  if (!launch.exists) return null;
  return Number(launch.phase) === PHASE_GRADUATED;
}

/** The UniversalRouter every built tx is addressed to (mirrors swaproute.SWAP_ROUTER). */
const UNIVERSAL_ROUTER = () => norm(V4_ADDRESSES.universalRouter);

module.exports = {
  // venue
  UNIVERSAL_ROUTER,
  NATIVE,
  PHASE_CURVE,
  PHASE_GRADUATED,
  POOL_SWAP_GAS,
  POOL_APPROVE_GAS,
  DEFAULT_SLIPPAGE_BPS,
  EXIT_SLIPPAGE_BPS,
  // resolution
  resolvePonsPool,
  isGraduated,
  // quotes + the impact guard
  quoteSellToPair,
  quoteBuyFromPair,
  assessImpact,
  assessSellImpact,
  assessBuyImpact,
  applySlippage,
  // calldata
  buildSellToPair,
  buildBuyFromPair,
  buildApprovals,
  // safe entry points — resolve + quote + build in one call
  resolveAndBuildSell,
  resolveAndBuildBuy,
  _private: { V4_ADDRESSES, IMPACT_PROBE_DIVISOR, probeFor, keyCurrency, wire },
};
