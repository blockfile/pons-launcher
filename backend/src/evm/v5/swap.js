'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// letscash.fun (CashCat) — Uniswap-V4 swap CLIENT: buy/sell calldata + quotes.
//
// This is the FUND-CRITICAL piece of the v5 tab. It encodes the exact bytes a
// real wallet will broadcast to move ETH into a letscash token and back out. It
// BUILDS and QUOTES only — it never signs and never broadcasts. Signing lives
// with the keystore; this module is a pure calldata factory plus read-only
// quotes, which is what lets every claim below be checked against the chain
// before a single wei moves.
//
// Everything here was reverse-engineered from live Robinhood-Chain (id 4663)
// state and then VERIFIED three independent ways (see evm/v5/swap.test.js):
//
//   1. poolId  — keccak256(abi.encode(PoolKey)) reproduces the on-chain poolId
//                of the real CRYINGCAT pool byte-for-byte. That proves the
//                PoolKey (currencies, fee, tickSpacing, and above all the HOOK)
//                is exactly the one the chain uses.
//   2. calldata — buildBuyTx / buildSellTx reproduce, BYTE-FOR-BYTE, the
//                `execute()` calldata of REAL, confirmed-successful direct-to-
//                UniversalRouter V4 swaps on this chain (hashes in the test).
//                That proves the UniversalRouter + V4-action ABI encoding — down
//                to the one non-obvious struct field this router still carries
//                (see SWAP QUIRK below).
//   3. fill    — the exact CRYINGCAT buildBuyTx bytes, eth_call'd against live
//                state (balance-overridden sender), FILL the pool through the
//                CashCat hook and honour minOut: a reasonable minOut succeeds and
//                an impossible one reverts. Recorded in the fund-safety handoff;
//                re-runnable ad hoc against the live RPC (this module builds the
//                bytes, eth_call does the rest — no signing).
//
// Modelled on the care of the shelved contracts/EthToSpcxSwap.sol notes: raw V4
// mechanics, spelled out, with the sentinels named rather than left as magic 0s.
//
// ── HOW letscash TRADES ──────────────────────────────────────────────────────
// A letscash launch seeds ONE locked Uniswap-V4 pool holding the whole supply.
// Trades are V4 swaps executed by the canonical UniversalRouter, whose
// `execute(bytes commands, bytes[] inputs, uint256 deadline)` (selector
// 0x3593564c) drives the V4 PoolManager. The CashCat hook skims the tax off the
// QUOTE side of every swap and REJECTS partial/empty fills — so every swap here
// is EXACT-INPUT single-hop: the full input is always consumed against the
// pool, which is a full fill by construction (see PARTIAL-FILL below).
//
// NOTE on how the letscash *website* trades vs. what we broadcast: the letscash
// UI routes through its own front-end helper contracts (a buy router and a sell
// router) that call the UniversalRouter INTERNALLY. Those helpers are not
// verified and add nothing we need — the UniversalRouter is permissionless, so
// we call `execute()` on it DIRECTLY, exactly as hundreds of other direct-to-
// router V4 swaps on this chain do. That direct path is the one we can verify
// byte-for-byte against real txs, and the one this module builds.
//
// ── THE HOOK IS PER-POOL, NOT A GLOBAL CONSTANT (fund-critical) ───────────────
// config.letscash.hook is only a DEFAULT. Scanning live PoolManager Initialize
// events shows letscash-shaped pools (fee 0, tickSpacing 200) live under SEVERAL
// hook addresses at once — 0x75A5…AEC (config default, used by the most recent
// launches), 0xEfe6…aEc (the CashCat hook the CRYINGCAT pool uses), 0xe5e7…044,
// and per-token vanity hooks. A PoolKey built with the WRONG hook hashes to a
// poolId that is simply NOT INITIALIZED — a swap against it cannot fill, and a
// buy sent to it would settle ETH into nothing. So the safe entry point is
// resolvePoolKey(), which asks StateView which candidate hook actually has an
// initialised pool for this token before any calldata is built. Callers that
// already KNOW the hook (e.g. straight off their own letscash launch receipt)
// may pass it explicitly and skip the probe.
//
// ── SWAP QUIRK: this UniversalRouter uses the OLDER ExactInputSingleParams ─────
// This chain's UniversalRouter predates the v4-periphery change that dropped
// `sqrtPriceLimitX96` from the single-swap params. Its SWAP_EXACT_IN_SINGLE
// param is the SIX-field struct:
//     (PoolKey poolKey, bool zeroForOne, uint128 amountIn,
//      uint128 amountOutMinimum, uint160 sqrtPriceLimitX96, bytes hookData)
// We pass sqrtPriceLimitX96 = 0 (no explicit price bound; slippage is enforced
// by amountOutMinimum, never by the price limit — mirroring EthToSpcxSwap.sol).
// Omitting this field shifts every following word by 32 bytes and produces
// calldata the router cannot decode. The V4QUOTER, by contrast, wants the NEWER
// FOUR-field params with NO sqrtPriceLimitX96 — the two interfaces genuinely
// disagree on this chain, and both shapes here were confirmed by eth_call.
// ─────────────────────────────────────────────────────────────────────────────

const { AbiCoder, Interface, getAddress, keccak256, toBeHex } = require('ethers');

const config = require('../../config');
const { provider } = require('../provider');

const coder = AbiCoder.defaultAbiCoder();

// ── Sentinels ────────────────────────────────────────────────────────────────
// V4 uses address(0) for the chain's native coin (ETH here). It is ALWAYS the
// numerically smallest address, so in any native-quoted pool it is currency0.
const NATIVE = '0x0000000000000000000000000000000000000000';

// ActionConstants.OPEN_DELTA — the "settle/take whatever is currently owed"
// sentinel. Passed as the amount to SETTLE and TAKE so the router resolves the
// full swap delta rather than a hard-coded number. Confirmed as literal 0 in the
// real txs (NOT the CONTRACT_BALANCE sentinel, which is a large constant).
const OPEN_DELTA = 0n;

// ── UniversalRouter Commands (Commands.sol) ──────────────────────────────────
// One byte per command in the `commands` string. We only ever emit V4_SWAP: a
// single exact-input single-hop swap is one V4_SWAP whose inputs carry the whole
// action plan. SWEEP (0x04) is documented because it is the command you would
// append to refund leftover native ETH — but we send msg.value EXACTLY equal to
// amountIn, so nothing is left to sweep and no SWEEP is emitted (matches the
// real txs, which carry the bare 0x10 command).
const COMMAND_V4_SWAP = 0x10;
const COMMAND_SWEEP = 0x04; // documented; unused (exact msg.value ⇒ no dust)

// ── V4 Router Actions (Actions.sol) ──────────────────────────────────────────
// One byte per action inside a V4_SWAP input. Our plan is always the canonical
// exact-in triple, in this order:
//   SWAP_EXACT_IN_SINGLE  do the swap, accruing deltas in the PoolManager
//   SETTLE                pay the input currency we now owe
//   TAKE                  collect the output currency we are now owed
// The real direct-to-router swaps on this chain use exactly 0x06,0x0b,0x0e —
// SETTLE/TAKE (with OPEN_DELTA), NOT the SETTLE_ALL/TAKE_ALL variants. We mirror
// the real txs.
const ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
const ACTION_SETTLE = 0x0b;
const ACTION_TAKE = 0x0e;

// The letscash pool shape (every launch uses it). fee 0 and tickSpacing 200 are
// verified; the hook is per-pool (see header) and defaulted from config.
const POOL_FEE = config.letscash.poolFee; // 0
const TICK_SPACING = config.letscash.tickSpacing; // 200

// ── ABI type strings ─────────────────────────────────────────────────────────
// V4 Currency/IHooks are plain `address` and BalanceDelta an int at the ABI
// level, so declaring them as address/int produces byte-identical encodings to
// the canonical structs (same reasoning as EthToSpcxSwap.sol's interface).
const POOLKEY_T = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';

// SWAP_EXACT_IN_SINGLE param — the OLDER six-field struct THIS router uses.
const EXACT_IN_SINGLE_T =
  `tuple(${POOLKEY_T} poolKey,bool zeroForOne,uint128 amountIn,` +
  'uint128 amountOutMinimum,uint160 sqrtPriceLimitX96,bytes hookData)';

// V4Quoter param — the NEWER four-field struct (NO sqrtPriceLimitX96). Yes, this
// differs from the router's struct above; both were confirmed on-chain.
const QUOTE_EXACT_SINGLE_T =
  `tuple(${POOLKEY_T} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)`;

// ── Interfaces ───────────────────────────────────────────────────────────────
const universalRouterIface = new Interface([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);

const quoterIface = new Interface([
  // Non-view on-chain (it reverts to bubble the result) but callable via eth_call.
  `function quoteExactInputSingle(${QUOTE_EXACT_SINGLE_T} params) returns (uint256 amountOut, uint256 gasEstimate)`,
]);

const stateViewIface = new Interface([
  'function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)',
  'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)',
]);

// The CashCat fee HOOK's fee reads (reverse-engineered + verified against the live
// contract). currentFeeRate is on every letscash hook and returns the fee a normal
// trader pays RIGHT NOW (pips; 1e6 = 100%). poolConfigs is the anti-snipe-decay
// hook's per-pool struct — only 0xEfe6…aEc carries a decay window; the others (and,
// empirically, every real pool) launch FLAT, so launchFeeDecay is 0 there. See
// poolFeeStatus for how the two are combined.
const HOOK_DECAY_ADDRESS = '0xefe669814e5eec33406bd50ffa8331618d076aec';
const hookFeeIface = new Interface([
  'function currentFeeRate(bytes32 poolId, address swapper) view returns (uint256)',
  'function poolConfigs(bytes32 poolId) view returns (address creator, uint40 launchTime, uint16 creatorFeeBps, uint24 baseFeeRate, uint24 launchFeeRate, uint32 launchFeeDecay, bool exists)',
]);
// swapper only matters for the factory's one-shot first-buy exemption in the launch
// block; for any normal wallet it is always false, so a dead address gives the real
// trader rate.
const FEE_PROBE_SWAPPER = '0x000000000000000000000000000000000000dEaD';

// ERC-20 approve + Permit2 approve, for the sell (and USDG-in buy) path.
const erc20ApproveIface = new Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const permit2Iface = new Interface([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);

// Max uint values for one-shot approvals.
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n; // Permit2 "infinite" allowance
const MAX_UINT48 = (1n << 48n) - 1n; // Permit2 "never expires" sentinel

// ── deps injection ───────────────────────────────────────────────────────────
// Every exported function takes an optional `deps` so tests can run fully
// offline (no provider) and callers can swap addresses. Defaults come from the
// real provider and config. Addresses are lower-cased then re-checksummed:
// config stores the UniversalRouter as 0x8876…904, which is NOT a valid EIP-55
// checksum as written, so getAddress() on the raw string would throw — always
// normalise from lower-case.
const norm = (a) => getAddress(String(a).toLowerCase());

function resolveDeps(deps = {}) {
  const c = deps.config || config;
  return {
    provider: deps.provider || provider,
    universalRouter: norm(deps.universalRouter || c.letscash.universalRouter),
    quoter: norm(deps.quoter || c.letscash.quoter),
    stateView: norm(deps.stateView || c.letscash.stateView),
    permit2: norm(deps.permit2 || c.letscash.permit2),
    usdg: norm(deps.usdg || c.letscash.usdg),
    defaultHook: norm(deps.hook || c.letscash.hook),
    poolFee: deps.poolFee != null ? deps.poolFee : POOL_FEE,
    tickSpacing: deps.tickSpacing != null ? deps.tickSpacing : TICK_SPACING,
    // Hooks tried, in order, by resolvePoolKey. The config hook first, then the
    // other letscash hooks seen live. Extendable via deps for new deployments.
    candidateHooks: (deps.candidateHooks || [
      c.letscash.hook,
      '0xEfe669814e5Eec33406Bd50ffa8331618D076aEc', // CashCat hook (CRYINGCAT-era)
      '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
    ]).map(norm),
  };
}

// Is this the native-coin quote? Accepts the 0x0 sentinel or 'eth'/'native'.
function isNative(currency) {
  if (currency == null) return false;
  const s = String(currency).toLowerCase();
  return s === NATIVE || s === 'eth' || s === 'native';
}

// Normalise a quote argument to an on-chain currency address (0x0 for ETH).
function quoteAddress(quote, deps) {
  if (isNative(quote)) return NATIVE;
  // A bare 'usdg' alias, or any explicit ERC-20 address, is taken literally.
  if (String(quote).toLowerCase() === 'usdg') return deps.usdg;
  return norm(quote);
}

// ─────────────────────────────────────────────────────────────────────────────
// poolKeyFor — the PoolKey + its poolId for a letscash (token, quote) pair.
//
// Uniswap V4 REQUIRES currency0 < currency1 numerically. For a native-ETH quote
// that is automatic (0x0 is smallest ⇒ ETH is currency0, token is currency1).
// For a USDG (or any ERC-20) quote we must SORT: whichever of {quote, token} is
// numerically smaller becomes currency0. Getting this backwards yields a poolId
// that does not exist on-chain, so the ordering is computed, never assumed.
//
// `hook` defaults to the config hook but SHOULD come from resolvePoolKey (or a
// known-good source) — see the per-pool-hook warning in the header.
//
// Returns { poolKey, poolId, quoteIsCurrency0 }. poolId = keccak256(abi.encode(
// PoolKey)), the canonical V4 pool identifier.
// ─────────────────────────────────────────────────────────────────────────────
function poolKeyFor({ token, quote, hook, poolFee, tickSpacing } = {}, deps) {
  const d = resolveDeps(deps);
  const tokenAddr = norm(token);
  const quoteAddr = quoteAddress(quote, d);
  // The letscash hook is PER-POOL and the config default is WRONG for many
  // tokens — a PoolKey built with the wrong hook hashes to a different (usually
  // uninitialised) pool, and a buy against it either reverts or, if a decoy pool
  // exists under that hook, fills at a price your minOut was never sized for. So
  // a hook MUST be given explicitly: resolved against the chain via
  // resolvePoolKey(), or read from the launch receipt (TokenLaunched.hook /
  // the Initialize event). There is deliberately NO fallback to the config hook.
  if (!hook) {
    throw new Error(
      'poolKeyFor: an explicit hook is required (the letscash hook is per-pool). Resolve it via ' +
        'resolvePoolKey(), or read it from the launch receipt — never the config default.'
    );
  }
  const hookAddr = norm(hook);
  const fee = poolFee != null ? poolFee : d.poolFee;
  const ts = tickSpacing != null ? tickSpacing : d.tickSpacing;

  // Numeric sort of the two currencies.
  const quoteIsCurrency0 = BigInt(quoteAddr) < BigInt(tokenAddr);
  const currency0 = quoteIsCurrency0 ? quoteAddr : tokenAddr;
  const currency1 = quoteIsCurrency0 ? tokenAddr : quoteAddr;

  const poolKey = { currency0, currency1, fee, tickSpacing: ts, hooks: hookAddr };
  const poolId = keccak256(
    coder.encode(
      ['address', 'address', 'uint24', 'int24', 'address'],
      [currency0, currency1, fee, ts, hookAddr]
    )
  );
  return { poolKey, poolId, quoteIsCurrency0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool reads (StateView). getSlot0 returns sqrtPriceX96 = 0 for a pool that was
// never initialised, which is the cheapest possible "does this PoolKey exist?"
// probe — one eth_call, no logs scan.
// ─────────────────────────────────────────────────────────────────────────────
async function readSlot0(poolId, deps) {
  const d = resolveDeps(deps);
  const ret = await d.provider.call({
    to: d.stateView,
    data: stateViewIface.encodeFunctionData('getSlot0', [poolId]),
  });
  const [sqrtPriceX96, tick, protocolFee, lpFee] = stateViewIface.decodeFunctionResult(
    'getSlot0',
    ret
  );
  return { sqrtPriceX96, tick: Number(tick), protocolFee: Number(protocolFee), lpFee: Number(lpFee) };
}

async function readLiquidity(poolId, deps) {
  const d = resolveDeps(deps);
  const ret = await d.provider.call({
    to: d.stateView,
    data: stateViewIface.encodeFunctionData('getLiquidity', [poolId]),
  });
  return stateViewIface.decodeFunctionResult('getLiquidity', ret)[0];
}

// True iff StateView reports the pool initialised (has a price). An initialised
// pool with zero liquidity still cannot be swapped through — resolvePoolKey
// checks both.
async function poolIsInitialized(poolId, deps) {
  const { sqrtPriceX96 } = await readSlot0(poolId, deps);
  return sqrtPriceX96 !== 0n;
}

// ─────────────────────────────────────────────────────────────────────────────
// resolvePoolKey — THE fund-safe way to get a letscash PoolKey.
//
// Because the hook is per-pool, we cannot trust a config constant. This tries
// each candidate hook, computes its poolId, and asks StateView which one is
// actually initialised (and, by default, has liquidity). It returns the first
// live match, or throws — so a caller can never build a buy against a PoolKey
// the chain has never heard of.
//
// Pass `hook` to short-circuit the probe when you already know it. Pass
// requireLiquidity:false to accept an initialised-but-empty pool (rare; e.g. the
// instant after a launch, before the seed add is observed by StateView).
// ─────────────────────────────────────────────────────────────────────────────
async function resolvePoolKey({ token, quote, hook, requireLiquidity = true } = {}, deps) {
  const d = resolveDeps(deps);
  const hooksToTry = hook ? [norm(hook)] : d.candidateHooks;
  const tried = [];
  for (const h of hooksToTry) {
    const { poolKey, poolId, quoteIsCurrency0 } = poolKeyFor({ token, quote, hook: h }, deps);
    const { sqrtPriceX96 } = await readSlot0(poolId, deps);
    const initialized = sqrtPriceX96 !== 0n;
    let liquidity = 0n;
    if (initialized) liquidity = await readLiquidity(poolId, deps);
    tried.push({ hook: h, poolId, initialized, liquidity: liquidity.toString() });
    if (initialized && (!requireLiquidity || liquidity > 0n)) {
      return { poolKey, poolId, hook: h, quoteIsCurrency0, sqrtPriceX96, liquidity };
    }
  }
  const err = new Error(
    `No initialised letscash pool for token ${norm(token)} / quote ${quoteAddress(quote, d)} ` +
      `under any candidate hook (tried ${tried.map((t) => t.hook).join(', ')})`
  );
  err.tried = tried;
  throw err;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quotes (V4Quoter). quoteExactInputSingle is state-mutating on-chain (it
// reverts to return its result) but is safe to eth_call. Returns null-free
// numbers: { expectedOut, minOut }, where minOut = expectedOut · (1 − slippage).
//
// The hook takes its tax off the QUOTE side and is applied INSIDE the quote, so
// expectedOut is already net of tax — no separate tax maths here.
// ─────────────────────────────────────────────────────────────────────────────
function applySlippage(expectedOut, slippageBps) {
  const bps = BigInt(slippageBps || 0);
  if (bps <= 0n) return expectedOut; // no floor
  // floor(expectedOut · (10000 − bps) / 10000)
  return (expectedOut * (10000n - bps)) / 10000n;
}

async function quoteExactInSingle({ poolKey, zeroForOne, amountIn }, deps) {
  const d = resolveDeps(deps);
  const data = quoterIface.encodeFunctionData('quoteExactInputSingle', [
    { poolKey, zeroForOne, exactAmount: amountIn, hookData: '0x' },
  ]);
  const ret = await d.provider.call({ to: d.quoter, data });
  const [amountOut] = quoterIface.decodeFunctionResult('quoteExactInputSingle', ret);
  return amountOut;
}

/**
 * Quote a BUY (quote → token). amountInWei is the quote spent (ETH wei, or USDG
 * base units). slippageBps sizes the returned floor; 0 = no floor.
 */
async function quoteBuy({ token, quote, amountInWei, slippageBps = 0, hook } = {}, deps) {
  const { poolKey, quoteIsCurrency0 } = poolKeyFor({ token, quote, hook }, deps);
  // BUY spends the quote; zeroForOne is true iff the quote is currency0.
  const expectedOut = await quoteExactInSingle(
    { poolKey, zeroForOne: quoteIsCurrency0, amountIn: BigInt(amountInWei) },
    deps
  );
  return { expectedOut, minOut: applySlippage(expectedOut, slippageBps) };
}

/**
 * Quote a SELL (token → quote). tokensInWei is the token amount sold. Default
 * slippageBps 0 mirrors the pons sell path's no-floor behaviour; pass a value to
 * get a floor.
 */
async function quoteSell({ token, quote, tokensInWei, slippageBps = 0, hook } = {}, deps) {
  const { poolKey, quoteIsCurrency0 } = poolKeyFor({ token, quote, hook }, deps);
  // SELL spends the token; zeroForOne is true iff the TOKEN is currency0, i.e.
  // the opposite of the buy direction.
  const expectedOut = await quoteExactInSingle(
    { poolKey, zeroForOne: !quoteIsCurrency0, amountIn: BigInt(tokensInWei) },
    deps
  );
  return { expectedOut, minOut: applySlippage(expectedOut, slippageBps) };
}

// ─────────────────────────────────────────────────────────────────────────────
// The one true calldata builder. Every buy and sell is an exact-in single-hop
// swap; only the direction, the two currencies, who pays, and whether ETH rides
// along as msg.value differ. buildBuyTx / buildSellTx are thin wrappers that fix
// those.
//
// actions = SWAP_EXACT_IN_SINGLE, SETTLE, TAKE:
//   • SWAP: the six-field params (see SWAP QUIRK). amountOutMinimum = minOut is
//     the ONLY slippage floor; sqrtPriceLimitX96 = 0 (no price bound); hookData
//     empty (the CashCat hook needs none — confirmed by the fill simulation).
//   • SETTLE(inputCurrency, OPEN_DELTA, payerIsUser): pay what the swap now owes
//     on the input side. payerIsUser=false when we settle native ETH the router
//     already holds as msg.value; true when the router must pull an ERC-20 from
//     the user via Permit2.
//   • TAKE(outputCurrency, recipient, OPEN_DELTA): send the full output delta to
//     `recipient` (a literal address — not the MSG_SENDER/ADDRESS_THIS sentinel).
// ─────────────────────────────────────────────────────────────────────────────
function encodeExactInSingleExecute(
  { poolKey, zeroForOne, amountIn, minOut, inputCurrency, outputCurrency, recipient, payerIsUser, deadline },
  deps
) {
  const d = resolveDeps(deps);

  const swapParam = coder.encode(
    [EXACT_IN_SINGLE_T],
    [
      {
        poolKey,
        zeroForOne,
        amountIn: BigInt(amountIn),
        amountOutMinimum: BigInt(minOut),
        sqrtPriceLimitX96: 0n,
        hookData: '0x',
      },
    ]
  );
  const settleParam = coder.encode(
    ['address', 'uint256', 'bool'],
    [inputCurrency, OPEN_DELTA, payerIsUser]
  );
  const takeParam = coder.encode(
    ['address', 'address', 'uint256'],
    [outputCurrency, norm(recipient), OPEN_DELTA]
  );

  const actions =
    '0x' +
    [ACTION_SWAP_EXACT_IN_SINGLE, ACTION_SETTLE, ACTION_TAKE]
      .map((a) => a.toString(16).padStart(2, '0'))
      .join('');
  const v4Input = coder.encode(['bytes', 'bytes[]'], [actions, [swapParam, settleParam, takeParam]]);

  const commands = '0x' + COMMAND_V4_SWAP.toString(16).padStart(2, '0');
  const data = universalRouterIface.encodeFunctionData('execute', [
    commands,
    [v4Input],
    BigInt(deadline),
  ]);
  return { to: d.universalRouter, data };
}

/**
 * The pool key + swap direction for a build, from EITHER a pre-resolved
 * `poolKey` (from resolvePoolKey — already verified against the chain) or an
 * explicit `hook`. There is no path here that reaches for the config default:
 * a caller with only {token, quote} must resolve first (see resolveAndBuildBuy).
 */
function keyAndDirection({ token, quote, hook, poolKey }, deps) {
  const d = resolveDeps(deps);
  const quoteAddr = quoteAddress(quote, d);
  if (poolKey) {
    return { key: poolKey, quoteIsCurrency0: norm(poolKey.currency0) === quoteAddr };
  }
  if (!hook) {
    throw new Error(
      'a verified pool is required: pass `poolKey` from resolvePoolKey() or an explicit `hook` from the ' +
        'launch receipt. The config hook is a per-pool default and is wrong for many tokens — use ' +
        'resolveAndBuildBuy()/resolveAndBuildSell() for the safe, self-verifying path.'
    );
  }
  const r = poolKeyFor({ token, quote, hook }, deps);
  return { key: r.poolKey, quoteIsCurrency0: r.quoteIsCurrency0 };
}

/**
 * buildBuyTx — unsigned BUY (quote → token) for the UniversalRouter.
 *
 * Requires a verified pool (`poolKey` from resolvePoolKey, or an explicit `hook`)
 * AND a positive `minOut` — a buy with no floor fills at any price. Prefer
 * resolveAndBuildBuy(), which resolves + quotes + builds in one safe call.
 *
 * @returns {{to, data, value, approvals?}} value = amountInWei for a native-ETH
 *   buy (rides along as msg.value and is settled by the router, payerIsUser=false).
 *   For a USDG/ERC-20 quote there is no msg.value (value 0n); the router pulls
 *   the quote from the user via Permit2, so `approvals` carries the ERC-20→Permit2
 *   and Permit2→router steps that must land first.
 *
 * value is set EXACTLY to amountInWei on the native path, so nothing is left in
 * the router and no SWEEP is needed.
 */
function buildBuyTx({ token, quote, amountInWei, minOut, recipient, deadline, hook, poolKey } = {}, deps) {
  const d = resolveDeps(deps);
  const { key, quoteIsCurrency0 } = keyAndDirection({ token, quote, hook, poolKey }, deps);

  // A buy MUST carry a positive floor. minOut=0/absent would fill at any price;
  // the wrong-pool risk above is only fully closed when the floor is real.
  if (minOut == null || BigInt(minOut) <= 0n) {
    throw new Error('buildBuyTx: minOut must be positive — a buy with no floor fills at any price');
  }

  const tokenAddr = norm(token);
  const quoteAddr = quoteAddress(quote, d);
  const nativeIn = isNative(quoteAddr);

  const tx = encodeExactInSingleExecute(
    {
      poolKey: key,
      zeroForOne: quoteIsCurrency0, // buy spends the quote
      amountIn: amountInWei,
      minOut,
      inputCurrency: quoteAddr, // pay the quote
      outputCurrency: tokenAddr, // receive the token
      recipient,
      payerIsUser: !nativeIn, // native ETH is settled by the router, not pulled
      deadline,
    },
    deps
  );

  const value = nativeIn ? BigInt(amountInWei) : 0n;
  const result = { to: tx.to, data: tx.data, value };
  // A non-native (USDG) buy pulls the quote via Permit2 — same approval shape as
  // a sell's token pull.
  if (!nativeIn) result.approvals = buildPermit2Approvals({ inputToken: quoteAddr, amount: amountInWei }, deps);
  return result;
}

/**
 * buildSellTx — unsigned SELL (token → quote) for the UniversalRouter, PLUS the
 * approval steps it requires.
 *
 * The router pulls the token from the seller via Permit2 (SETTLE payerIsUser=
 * true), so before this tx can succeed the wallet must have:
 *   1. ERC-20 approved the TOKEN to Permit2      (token.approve(permit2, max)) —
 *      a one-time, reusable approval.
 *   2. Permit2 approved the UniversalRouter       (permit2.approve(token, router,
 *      amount, never-expire)) — bounded to THIS sell's `tokensInWei`.
 * Both are returned in `approvals` (unsigned {to,data}) and must land before this
 * tx. Because leg 2 is bounded to this sell's amount, a LATER sell of the same
 * token needs a fresh leg-2 Permit2 approval (leg 1 stays valid).
 *
 * minOut defaults to 0n — the pons sell path uses NO slippage floor. Pass a
 * quoteSell-derived minOut to add one.
 *
 * @returns {{to, data, value, approvals}} value is always 0n (no native in).
 */
function buildSellTx({ token, quote, tokensInWei, minOut = 0n, recipient, deadline, hook, poolKey } = {}, deps) {
  const d = resolveDeps(deps);
  const { key, quoteIsCurrency0 } = keyAndDirection({ token, quote, hook, poolKey }, deps);

  const tokenAddr = norm(token);
  const quoteAddr = quoteAddress(quote, d);

  const tx = encodeExactInSingleExecute(
    {
      poolKey: key,
      zeroForOne: !quoteIsCurrency0, // sell spends the token (opposite of buy)
      amountIn: tokensInWei,
      minOut,
      inputCurrency: tokenAddr, // pay the token
      outputCurrency: quoteAddr, // receive the quote
      recipient,
      payerIsUser: true, // the router pulls the token from the seller (Permit2)
      deadline,
    },
    deps
  );

  return {
    to: tx.to,
    data: tx.data,
    value: 0n,
    approvals: buildPermit2Approvals({ inputToken: tokenAddr, amount: tokensInWei }, deps),
  };
}

/**
 * The two-step Permit2 approval an ERC-20 input (a sell's token, or a USDG buy's
 * quote) needs before the UniversalRouter can pull it. Returned as unsigned
 * {to,data,label}.
 *
 * The ERC-20→Permit2 leg approves MAX (a standard one-time, reusable approval —
 * the router gains an unbounded pull on the token via Permit2). The
 * Permit2→router leg is bounded to `amount` (or MAX if omitted) with a
 * never-expire deadline — so with a specific amount it is NOT "approve once, sell
 * forever": a later sell of the same token needs a fresh Permit2 approval once
 * the allowance is spent.
 */
function buildPermit2Approvals({ inputToken, amount } = {}, deps) {
  const d = resolveDeps(deps);
  const token = norm(inputToken);
  // ERC-20 → Permit2: default infinite (max uint256). If a bounded amount is
  // given, still approve max so the one-time ERC-20 approval is reusable; the
  // real per-trade cap lives in the Permit2 allowance below.
  const erc20Approve = {
    label: 'erc20-approve-permit2',
    to: token,
    data: erc20ApproveIface.encodeFunctionData('approve', [d.permit2, MAX_UINT256]),
    value: 0n,
  };
  // Permit2 → UniversalRouter: uint160 amount, uint48 expiration. Default
  // infinite amount + never-expire. A bounded amount is clamped to uint160.
  const permitAmount = amount == null ? MAX_UINT160 : BigInt(amount) & MAX_UINT160;
  const permit2Approve = {
    label: 'permit2-approve-router',
    to: d.permit2,
    data: permit2Iface.encodeFunctionData('approve', [
      token,
      d.universalRouter,
      permitAmount,
      MAX_UINT48,
    ]),
    value: 0n,
  };
  return [erc20Approve, permit2Approve];
}

/**
 * THE SAFE BUY ENTRY POINT. Resolves the real pool against the chain (verifying
 * the per-pool hook, that it is initialised, and — by default — that it has
 * liquidity), quotes the buy, refuses a non-positive expected/floor, and builds
 * the tx against the VERIFIED poolKey. A caller that only knows {token, quote}
 * should always come through here rather than buildBuyTx directly, so the
 * wrong-hook footgun cannot be reached.
 *
 * @returns {{to,data,value,approvals?,hook,poolKey,expectedOut,minOut}}
 */
async function resolveAndBuildBuy(
  { token, quote, amountInWei, slippageBps = 100, recipient, deadline } = {},
  deps
) {
  const resolved = await resolvePoolKey({ token, quote }, deps); // throws if no live pool
  const { expectedOut, minOut } = await quoteBuy(
    { token, quote, amountInWei, slippageBps, hook: resolved.hook },
    deps
  );
  if (expectedOut <= 0n || minOut <= 0n) {
    throw new Error(
      'resolveAndBuildBuy: the quote returned no output (or a zero floor) — refusing to build a buy ' +
        'with no price protection'
    );
  }
  const tx = buildBuyTx({ token, quote, amountInWei, minOut, recipient, deadline, poolKey: resolved.poolKey }, deps);
  return { ...tx, hook: resolved.hook, poolKey: resolved.poolKey, expectedOut, minOut };
}

/**
 * The safe SELL entry point — resolves + (optionally) quotes + builds against the
 * verified pool. Sells keep the pons no-floor default (minOut 0) unless a
 * slippageBps is given, so this just guarantees the RIGHT pool.
 *
 * @returns {{to,data,value,approvals,hook,poolKey,expectedOut?,minOut}}
 */
async function resolveAndBuildSell(
  { token, quote, tokensInWei, slippageBps = 0, recipient, deadline } = {},
  deps
) {
  const resolved = await resolvePoolKey({ token, quote }, deps);
  let minOut = 0n;
  let expectedOut;
  if (slippageBps > 0) {
    const q = await quoteSell({ token, quote, tokensInWei, slippageBps, hook: resolved.hook }, deps);
    expectedOut = q.expectedOut;
    minOut = q.minOut;
  }
  const tx = buildSellTx(
    { token, quote, tokensInWei, minOut, recipient, deadline, poolKey: resolved.poolKey },
    deps
  );
  return { ...tx, hook: resolved.hook, poolKey: resolved.poolKey, expectedOut, minOut };
}

/**
 * The live TAX status of a pool: what a normal wallet pays RIGHT NOW, the base
 * (steady-state) rate, and — for the one hook that carries an anti-snipe premium —
 * when that premium finishes decaying to base. In practice letscash pools launch
 * FLAT (no premium), so hasDecay is almost always false and currentPct == basePct;
 * the decay fields are there for the rare pool that sets a window.
 *
 * @param {{token:string, quote?:string, hook:string}} input  hook = the pool's pinned hook.
 * @returns {Promise<{poolId,hook,currentPips,currentPct,basePct,launchPct,decaySeconds,launchTime,premiumGoneAt,hasDecay}>}
 */
async function poolFeeStatus({ token, quote = 'eth', hook } = {}, deps) {
  const d = resolveDeps(deps);
  const resolved = await resolvePoolKey({ token, quote, hook }, deps); // verifies the pool is live
  const poolId = resolved.poolId;
  const hookAddr = norm(resolved.hook);

  // The current rate — one call, works on every letscash hook, no clock skew.
  let currentPips = 0;
  try {
    const ret = await d.provider.call({
      to: hookAddr,
      data: hookFeeIface.encodeFunctionData('currentFeeRate', [poolId, FEE_PROBE_SWAPPER]),
    });
    currentPips = Number(hookFeeIface.decodeFunctionResult('currentFeeRate', ret)[0]);
  } catch (_e) {
    // A hook without this view is unexpected — leave 0; the caller renders "—".
  }

  let hasDecay = false;
  let basePips = currentPips;
  let launchPips = currentPips;
  let decaySeconds = 0;
  let launchTime = null;
  let premiumGoneAt = null;
  // Only the decay-capable hook carries the poolConfigs struct with the window.
  if (hookAddr.toLowerCase() === HOOK_DECAY_ADDRESS) {
    try {
      const ret = await d.provider.call({
        to: hookAddr,
        data: hookFeeIface.encodeFunctionData('poolConfigs', [poolId]),
      });
      const c = hookFeeIface.decodeFunctionResult('poolConfigs', ret);
      basePips = Number(c.baseFeeRate);
      launchPips = Number(c.launchFeeRate);
      decaySeconds = Number(c.launchFeeDecay);
      launchTime = Number(c.launchTime);
      premiumGoneAt = launchTime + decaySeconds;
      hasDecay = decaySeconds > 0 && launchPips > basePips;
    } catch (_e) {
      // Not the struct we expect — treat the pool as flat.
    }
  }

  return {
    poolId,
    hook: hookAddr,
    currentPips,
    currentPct: currentPips / 1e4, // 10000 pips = 1%
    basePct: basePips / 1e4,
    launchPct: launchPips / 1e4,
    decaySeconds,
    launchTime,
    premiumGoneAt, // unix seconds, or null when flat
    hasDecay,
  };
}

module.exports = {
  // constants (documented, exported for tests + callers)
  NATIVE,
  OPEN_DELTA,
  COMMAND_V4_SWAP,
  COMMAND_SWEEP,
  ACTION_SWAP_EXACT_IN_SINGLE,
  ACTION_SETTLE,
  ACTION_TAKE,
  POOLKEY_T,
  EXACT_IN_SINGLE_T,
  QUOTE_EXACT_SINGLE_T,
  // pool
  poolKeyFor,
  resolvePoolKey,
  poolIsInitialized,
  readSlot0,
  readLiquidity,
  // quotes
  quoteBuy,
  quoteSell,
  poolFeeStatus,
  // calldata
  buildBuyTx,
  buildSellTx,
  buildPermit2Approvals,
  // SAFE entry points — resolve+verify the pool against the chain, then build
  resolveAndBuildBuy,
  resolveAndBuildSell,
  keyAndDirection,
  // low-level (handy for tests/tools)
  encodeExactInSingleExecute,
  applySlippage,
  isNative,
  quoteAddress,
};
