'use strict';

// Warm state for the take-profit dApp: everything the browser needs BEFORE a
// click, so the click itself does no chain read (spec: "the click path does no
// chain reads"). Addresses are public data; no key ever arrives here.
//
//   readWallets  token balance, ETH balance, allowance to the venue's spender,
//                the Permit2 allowance (graduated), the pair-token balance
//                (token-quoted), and the PENDING nonce — for up to 100 wallets.
//   readMark     the venue's price state: curve reserves + fee, or pool slot0 +
//                liquidity, read at ONE block and reported with that block.
//   feeParams    maxFeePerGas = 2 x the latest base fee, priority 0, the gas
//                caps each transaction kind is signed with, and ETH/USD (the
//                page cannot fetch a price itself: its CSP allows only its own
//                origin, and the dApp host 404s the console's /api/eth-price).
//
// Logic copied, never imported (tab isolation):
//   Multicall3 getEthBalance through aggregate3; null — never 0 — for an unread
//   slot                                        evm/erc20.js:77-122
//   the curve's fee maths: fee + creator tax off the OUTPUT, reserves incl. the
//   phantom quote as getReserves reports them   evm/v2/holdings.js:401-451
//   v3 pool price + token0 orientation          evm/pricing.js:21-23,40-58,85-87
//   gas caps                                    see GAS_LIMITS below
// ABI fragments are constants.ABI (Task 1): ERC20 (evm/erc20.js:7-13,
// v5/launch.js:55), CURVE (evm/v2/abi.js:137,147-148), STATE_VIEW
// (evm/v5/swap.js:152-155), V3_POOL (evm/pricing.js:28-31), PERMIT2.allowance
// (Uniswap Permit2 IAllowanceTransfer, 0x927da105 — first exercised on the fork).
// ETH/USD is IMPORTED, not copied: ethPrice.js is shared infra every tab already
// uses (plan Global Constraints; Task 1's isolation test allows it).

const { Interface, formatUnits, getAddress, isAddress } = require('ethers');
const C = require('./constants');
const { TpError } = require('./errors');
// Called through the module object (providers.tpReadProvider()), never
// destructured, so a route test can swap in a provider that refuses every read.
const providers = require('./providers');
const { aggregate3, decodeSlot, one, mcIface } = require('./multicall');
const { ethPriceUsd } = require('../ethPrice');

const lc = (a) => String(a).toLowerCase();

const MAX_WALLETS = 100;
// getTransactionCount has no Multicall3 form, so it is one request per wallet.
// Capped rather than fired 100-wide: this RPC degrades badly under concurrency
// (evm/v2/holdings.js:76-84 — one eth_call took 22 s alongside four others).
const NONCE_CONCURRENCY = 8;
// GET /fees is polled by every open page; one base-fee read per second is plenty.
const FEE_TTL_MS = 1000;
// How long GET /fees waits for ETH/USD. ethPrice.js answers from its 60 s cache
// at once; only a cold or expired cache goes out to the exchanges (4 s timeout
// per source, two sources). Past this wait /fees answers ethUsd: null and the
// fetch finishes in the background, warming the cache for the page's next poll.
const ETH_USD_WAIT_MS = 1500;

// The gas each transaction kind is signed with (decimal strings, like every
// on-chain amount on the wire). Unused gas is refunded, so these are ceilings.
const GAS_LIMITS = Object.freeze({
  approve: '100000', //        bundle/prepareSell.js:62 APPROVE_GAS (= v3/trade.js:62)
  permit2Approve: '100000', // evm/v3/poolswap.js:150 POOL_APPROVE_GAS
  sellCurve: '600000', //      bundle/prepareSell.js:71 SELL_GAS
  sellV4: '500000', //         evm/v3/poolswap.js:149 POOL_SWAP_GAS (native sell 172.6k measured)
  sellV1: '600000', //         bundle/prepareSell.js:71 SELL_GAS — sized to cover the v1
  //                           swap + unwrap too (191,523 measured, prepareSell.js:67-70);
  //                           evm/router.js itself carries no gas cap
  pairSwap: '450000', //       v3/trade.js:72 SWAP_GAS — the gas the swaproute.js
  //                           pair -> USDG -> WETH -> ETH leg is sent with; swaproute.js
  //                           itself carries no gas cap
});

// ABI fragments: constants.ABI (Task 1), each cited there to its repo source.
const erc20Iface = new Interface(C.ABI.ERC20);
const permit2Iface = new Interface(C.ABI.PERMIT2);
const curveIface = new Interface(C.ABI.CURVE);
const stateViewIface = new Interface(C.ABI.STATE_VIEW);
const v3PoolIface = new Interface(C.ABI.V3_POOL);

const Q96 = 2 ** 96;

function providerOf(deps) {
  return deps.provider || providers.tpReadProvider();
}

const str = (v) => (v == null ? null : BigInt(v).toString());

/**
 * Validate and normalise a wallet list: an array of at most 100 addresses,
 * each checksummable. Returns EIP-55 addresses, de-duplicated, first-seen order.
 * Throws TpError bad_request / too_many / bad_address (naming the index, never
 * echoing the value).
 */
function normalizeAddresses(list) {
  if (!Array.isArray(list)) {
    throw new TpError('bad_request', 'addresses must be an array of wallet addresses');
  }
  if (list.length > MAX_WALLETS) {
    throw new TpError('too_many', `at most ${MAX_WALLETS} wallets per request (got ${list.length})`);
  }
  const seen = new Set();
  const out = [];
  list.forEach((a, i) => {
    if (typeof a !== 'string' || !isAddress(a)) {
      throw new TpError('bad_address', `addresses[${i}] is not a valid address`);
    }
    const addr = getAddress(a);
    if (seen.has(addr)) return;
    seen.add(addr);
    out.push(addr);
  });
  return out;
}

/** Run fn over items with at most `limit` in flight; results stay positional. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * WalletState for each address. A field that could not be read is NULL, never
 * 0 — an unread balance and an empty wallet are different facts
 * (evm/erc20.js:77-80). The whole call throws only if the batch itself cannot
 * be sent.
 *
 * @returns {Promise<Array<{address, tokenBalance, ethBalance, nonce, allowance,
 *   permit2: {amount, expiration}|null, pairBalance}>>}
 */
async function readWallets(venue, addresses, deps = {}) {
  if (!venue || !venue.token || !venue.spenders || !venue.spenders.approve) {
    throw new TpError('bad_request', 'a resolved venue is required');
  }
  const list = normalizeAddresses(addresses);
  if (!list.length) return [];
  const provider = providerOf(deps);

  const token = lc(venue.token);
  const spender = lc(venue.spenders.approve);
  const graduated = venue.kind === 'graduated';
  const router = graduated ? lc(venue.spenders.permit2Router) : null;
  const pairToken = venue.nativeQuote ? null : lc(venue.pairToken);
  const MC = lc(C.MULTICALL3);
  const PERMIT2 = lc(C.PERMIT2);

  // Fixed slot layout per wallet, so decoding is positional arithmetic.
  const perWallet = 3 + (graduated ? 1 : 0) + (pairToken ? 1 : 0);
  const calls = [];
  for (const owner of list) {
    calls.push({ target: token, callData: erc20Iface.encodeFunctionData('balanceOf', [owner]) });
    calls.push({ target: token, callData: erc20Iface.encodeFunctionData('allowance', [owner, spender]) });
    calls.push({ target: MC, callData: mcIface.encodeFunctionData('getEthBalance', [owner]) });
    if (graduated) {
      calls.push({
        target: PERMIT2,
        callData: permit2Iface.encodeFunctionData('allowance', [owner, token, router]),
      });
    }
    if (pairToken) {
      calls.push({ target: pairToken, callData: erc20Iface.encodeFunctionData('balanceOf', [owner]) });
    }
  }

  const [slots, nonces] = await Promise.all([
    aggregate3(provider, calls),
    mapLimit(list, NONCE_CONCURRENCY, (owner) =>
      provider.getTransactionCount(owner, 'pending').then(
        (n) => Number(n),
        () => null
      )
    ),
  ]);

  return list.map((address, i) => {
    let k = i * perWallet;
    const balance = one(erc20Iface, 'balanceOf', slots[k++]);
    const allowance = one(erc20Iface, 'allowance', slots[k++]);
    const eth = one(mcIface, 'getEthBalance', slots[k++]);
    let permit2 = null;
    if (graduated) {
      const p = decodeSlot(permit2Iface, 'allowance', slots[k++]);
      permit2 = p ? { amount: BigInt(p[0]).toString(), expiration: Number(p[1]) } : { amount: null, expiration: null };
    }
    const pairBalance = pairToken ? str(one(erc20Iface, 'balanceOf', slots[k++])) : null;
    return {
      address,
      tokenBalance: str(balance),
      ethBalance: str(eth),
      nonce: nonces[i],
      allowance: str(allowance),
      permit2,
      pairBalance,
    };
  });
}

/**
 * Quote per token, in human units, from curve reserves (the quote side already
 * includes the phantom reserve — holdings.js:421-423). Null when the curve holds
 * no tokens (a dead, graduated curve): no price rather than a wrong one.
 */
function priceFromReserves({ quoteReserve, tokenReserve, decimals, pairDecimals }) {
  const t = BigInt(tokenReserve);
  if (t <= 0n) return null;
  const q = Number(formatUnits(BigInt(quoteReserve), pairDecimals));
  return q / Number(formatUnits(t, decimals));
}

/**
 * Quote per token, in human units, from a Uniswap sqrtPriceX96. The pool price
 * is currency1 per currency0 in base units, (sqrtP / 2^96)^2 (evm/pricing.js:
 * 21-23, 85-87): selling token0 multiplies by it, selling token1 divides.
 */
function priceFromSqrt({ sqrtPriceX96, tokenIsToken0, decimals, pairDecimals }) {
  const s = Number(BigInt(sqrtPriceX96)) / Q96;
  if (!(s > 0)) return null;
  const raw = s * s; // currency1 base units per currency0 base unit
  const quotePerTokenBase = tokenIsToken0 ? raw : 1 / raw;
  return quotePerTokenBase * 10 ** (Number(decimals) - Number(pairDecimals));
}

function markFail(venue, what) {
  return new TpError('unavailable', `could not read ${what} for ${venue.token} — try again`, 503);
}

/**
 * The venue's price state, read at one block. `deps.blockTag` pins the block
 * (the indexer passes the block it just indexed); otherwise the latest block
 * number is read first and every value is read AT it, so `block` and the state
 * always agree.
 *
 * @returns {Promise<Mark>} curve: {block, price, quoteReserve, tokenReserve,
 *   feeBps, curveFeeBps, creatorTaxBps}; graduated / v1: {block, price,
 *   sqrtPriceX96, liquidity, tick}. price is quote per token (human), or null.
 */
async function readMark(venue, deps = {}) {
  if (!venue || !venue.kind) throw new TpError('bad_request', 'a resolved venue is required');
  const provider = providerOf(deps);
  const block = deps.blockTag != null ? Number(deps.blockTag) : Number(await provider.getBlockNumber());
  const at = { blockTag: block };

  if (venue.kind === 'curve') {
    const curve = lc(venue.curve);
    const slots = await aggregate3(
      provider,
      [
        { target: curve, callData: curveIface.encodeFunctionData('getReserves') },
        { target: curve, callData: curveIface.encodeFunctionData('feeBps') },
        { target: curve, callData: curveIface.encodeFunctionData('creatorTaxBps') },
      ],
      at
    );
    const reserves = decodeSlot(curveIface, 'getReserves', slots[0]);
    const fee = one(curveIface, 'feeBps', slots[1]);
    const tax = one(curveIface, 'creatorTaxBps', slots[2]);
    if (!reserves || fee == null || tax == null) throw markFail(venue, 'the curve reserves and fees');
    const quoteReserve = BigInt(reserves[0]);
    const tokenReserve = BigInt(reserves[1]);
    return {
      block,
      price: priceFromReserves({
        quoteReserve,
        tokenReserve,
        decimals: venue.decimals,
        pairDecimals: venue.pairDecimals,
      }),
      quoteReserve: quoteReserve.toString(),
      tokenReserve: tokenReserve.toString(),
      // THE SUM the curve takes off a sell's OUTPUT (holdings.js:439-451 quoteSellOut
      // takes feeBps + creatorTaxBps). The browser's curve maths takes this one number.
      feeBps: Number(fee) + Number(tax),
      curveFeeBps: Number(fee),
      creatorTaxBps: Number(tax),
    };
  }

  if (venue.kind === 'graduated') {
    const STATE_VIEW = lc(C.STATE_VIEW);
    const slots = await aggregate3(
      provider,
      [
        { target: STATE_VIEW, callData: stateViewIface.encodeFunctionData('getSlot0', [venue.poolId]) },
        { target: STATE_VIEW, callData: stateViewIface.encodeFunctionData('getLiquidity', [venue.poolId]) },
      ],
      at
    );
    const slot0 = decodeSlot(stateViewIface, 'getSlot0', slots[0]);
    const liquidity = one(stateViewIface, 'getLiquidity', slots[1]);
    if (!slot0 || liquidity == null) throw markFail(venue, 'the Uniswap v4 pool state');
    return {
      block,
      price: priceFromSqrt({
        sqrtPriceX96: slot0[0],
        // Derived from the PoolKey itself rather than trusted from a flag.
        tokenIsToken0: lc(venue.poolKey.currency0) === lc(venue.token),
        decimals: venue.decimals,
        pairDecimals: venue.pairDecimals,
      }),
      sqrtPriceX96: BigInt(slot0[0]).toString(),
      liquidity: BigInt(liquidity).toString(),
      tick: Number(slot0[1]),
    };
  }

  if (venue.kind === 'v1') {
    const pool = lc(venue.pool);
    const slots = await aggregate3(
      provider,
      [
        { target: pool, callData: v3PoolIface.encodeFunctionData('slot0') },
        { target: pool, callData: v3PoolIface.encodeFunctionData('liquidity') },
      ],
      at
    );
    const slot0 = decodeSlot(v3PoolIface, 'slot0', slots[0]);
    const liquidity = one(v3PoolIface, 'liquidity', slots[1]);
    if (!slot0 || liquidity == null) throw markFail(venue, 'the Uniswap v3 pool state');
    // A v3 pool's token0 is the numerically smaller address — the same fact
    // evm/pricing.js:52-56 reads from pool.token0(). The resolver stored it.
    const tokenIsToken0 =
      typeof venue.tokenIsToken0 === 'boolean'
        ? venue.tokenIsToken0
        : BigInt(lc(venue.token)) < BigInt(lc(venue.pairToken));
    return {
      block,
      price: priceFromSqrt({
        sqrtPriceX96: slot0[0],
        tokenIsToken0,
        decimals: venue.decimals,
        pairDecimals: venue.pairDecimals,
      }),
      sqrtPriceX96: BigInt(slot0[0]).toString(),
      liquidity: BigInt(liquidity).toString(),
      tick: Number(slot0[1]),
    };
  }

  throw new TpError('bad_request', `unknown venue kind ${venue.kind}`);
}

let feeMemo = null;

/**
 * The gas half of feeParams. Robinhood Chain orders first-come, first-served
 * and eth_maxPriorityFeePerGas is 0 (spec, "What the research established"), so
 * the tip is 0 and the ceiling is twice the latest base fee. Memoised for 1 s
 * when called without deps.provider. The memo holds ONLY these figures: the
 * price is looked up per call beside it, so a price failure can neither fail
 * nor poison the memo.
 */
async function gasParams(deps) {
  const now = (deps.now || Date.now)();
  if (!deps.provider && feeMemo && now - feeMemo.at < FEE_TTL_MS) return feeMemo.value;
  const provider = providerOf(deps);
  const head = await provider.getBlock('latest');
  if (!head || head.baseFeePerGas == null) {
    throw new TpError('unavailable', 'the chain did not report a base fee — try again', 503);
  }
  const baseFee = BigInt(head.baseFeePerGas);
  const value = {
    maxFeePerGas: (baseFee * 2n).toString(),
    maxPriorityFeePerGas: '0',
    baseFeePerGas: baseFee.toString(),
    block: Number(head.number),
    // The head block's unix time. The page signs deadlines and Permit2 expiries from it
    // rather than the visitor's PC clock, which can be off by minutes or days.
    timestamp: head.timestamp != null && Number.isFinite(Number(head.timestamp)) ? Number(head.timestamp) : null,
    gasLimits: { ...GAS_LIMITS },
  };
  if (!deps.provider) feeMemo = { at: now, value };
  return value;
}

/**
 * USD per ETH for the page's market cap and default USD chart, or null.
 * NEVER rejects: a price outage, a bad figure or a hung exchange is null, so
 * ETH/USD can never fail /fees or the gas figures the page signs with — and
 * never holds them longer than ETH_USD_WAIT_MS. A price is a JS number (plan
 * Global Constraints: prices as numbers, on-chain amounts as strings).
 *
 * The lookup is deps.ethPrice when given (tests), else the shared ethPriceUsd()
 * — except that a caller who injects its own provider without a price gets
 * null: an isolated caller (a test) never reaches the exchanges by accident.
 * Same rule as the gas memo, which is also skipped when a provider is injected.
 * No outbound amplification from a public, polled route: ethPrice.js serves its
 * 60 s cache and makes at most one outbound attempt per 15 s.
 */
function ethUsdOf(deps) {
  const lookup = deps.ethPrice || (deps.provider ? null : ethPriceUsd);
  if (!lookup) return Promise.resolve(null);
  const waitMs = deps.ethUsdWaitMs != null ? Number(deps.ethUsdWaitMs) : ETH_USD_WAIT_MS;
  const price = Promise.resolve()
    .then(() => lookup())
    .then(
      (r) => {
        const usd = Number(r && r.usd);
        return Number.isFinite(usd) && usd > 0 ? usd : null;
      },
      () => null
    );
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([price, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Fee parameters every browser signs with, plus ETH/USD for display. The gas
 * read and the price lookup run side by side; only the gas read can fail it.
 *
 * @returns {Promise<{maxFeePerGas, maxPriorityFeePerGas: '0', baseFeePerGas,
 *   block, gasLimits, ethUsd: number|null}>}
 */
async function feeParams(deps = {}) {
  const [gas, ethUsd] = await Promise.all([gasParams(deps), ethUsdOf(deps)]);
  return { ...gas, ethUsd };
}

module.exports = {
  readWallets,
  readMark,
  feeParams,
  normalizeAddresses,
  priceFromReserves,
  priceFromSqrt,
  GAS_LIMITS,
  MAX_WALLETS,
  NONCE_CONCURRENCY,
  ETH_USD_WAIT_MS,
};
