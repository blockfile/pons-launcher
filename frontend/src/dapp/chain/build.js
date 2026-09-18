// Calldata for every transaction the dApp signs. PURE: no provider, no reads,
// no signing. Every builder returns {to, data, value: 0n}; plan.js adds the
// nonce, gas and chain fields.
//
// Each encoding is copied from a verified backend builder (tab isolation: copied,
// never imported) and build.test.js checks it against that builder's bytes or its
// ABI:
//   approve            backend/src/evm/v5/swap.js:174-176 (ERC-20 approve)
//   permit2 approve    backend/src/evm/v5/swap.js:177-179, 632-659
//   curve sell         backend/src/evm/v2/abi.js:133, bundle/prepareSell.js:211-218
//   v4 sell            backend/src/evm/v5/swap.js:451-493, 590-618 via
//                      evm/v3/poolswap.js:501-516 (byte-identical to a real,
//                      filled pons pool sell — poolswap.test.js:121-129)
//   v1 sell            backend/src/evm/router.js:116-170 (SwapRouter02 shape)
//   pair -> ETH        backend/src/evm/v3/swaproute.js:64-70, 175-182, plus the
//                      one-hop USDG -> WETH path for a USDG pair (Task 4
//                      quotePairToEth, Task 5 checkPairPath)
//
// Addresses a transaction is SENT TO are pinned constants (or the venue's own
// token / curve); none comes from a route or quote response.

import { AbiCoder, Interface, dataLength, dataSlice, getAddress, solidityPacked } from 'ethers';

import {
  NATIVE,
  PAIR_FEE_TIERS,
  PERMIT2,
  SWAP_ROUTER02,
  UNIVERSAL_ROUTER,
  USDG,
  V1_POOL_FEE,
  WETH,
  WETH_USDG_FEE,
} from './constants.js';

const coder = AbiCoder.defaultAbiCoder();
const norm = (a) => getAddress(String(a).toLowerCase());

const MAX_UINT48 = (1n << 48n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

// ── Interfaces (human-readable ABI, copied from the files named above) ───────
const erc20Iface = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);
const permit2Iface = new Interface([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);
const curveIface = new Interface([
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
]);
const universalRouterIface = new Interface([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);
const swapRouter02Iface = new Interface([
  // backend/src/evm/abi.js:61-63 (SwapRouter02: NO deadline field in the params)
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  // backend/src/evm/v3/swaproute.js:33
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
]);

// ── UniversalRouter / V4 plan (backend/src/evm/v5/swap.js:96-145) ────────────
const COMMANDS_V4_SWAP = '0x10'; // Commands.V4_SWAP
const ACTIONS_EXACT_IN = '0x060b0e'; // SWAP_EXACT_IN_SINGLE, SETTLE, TAKE
const OPEN_DELTA = 0n; // settle / take the whole open delta
const POOLKEY_T = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
// The OLDER six-field ExactInputSingleParams THIS router decodes (with
// sqrtPriceLimitX96) — omit the field and every later word shifts 32 bytes.
const EXACT_IN_SINGLE_T =
  `tuple(${POOLKEY_T} poolKey,bool zeroForOne,uint128 amountIn,` +
  'uint128 amountOutMinimum,uint160 sqrtPriceLimitX96,bytes hookData)';

function uint(value, what, max = MAX_UINT256) {
  let n;
  try {
    n = BigInt(value);
  } catch {
    throw new TypeError(`${what} is not an integer`);
  }
  if (n < 0n || n > max) throw new RangeError(`${what} is out of range`);
  return n;
}

function positive(value, what, max) {
  const n = uint(value, what, max);
  if (n === 0n) throw new RangeError(`${what} must be positive`);
  return n;
}

/** token.approve(spender, amount) — an exact approval, never unlimited by default. */
export function approveTx(token, spender, amount) {
  return {
    to: norm(token),
    data: erc20Iface.encodeFunctionData('approve', [norm(spender), uint(amount, 'approve amount')]),
    value: 0n,
  };
}

/** Permit2.approve(token, spender, amount, expiration): the router's pull right, bounded and expiring. */
export function permit2ApproveTx(token, spender, amount, expiration) {
  return {
    to: norm(PERMIT2),
    data: permit2Iface.encodeFunctionData('approve', [
      norm(token),
      norm(spender),
      uint(amount, 'permit2 amount', MAX_UINT160),
      positive(expiration, 'permit2 expiration', MAX_UINT48),
    ]),
    value: 0n,
  };
}

/**
 * curve.sell(tokensIn, minQuoteOut, recipient). A curve quotes deterministically
 * and reverts atomically, so minOut 0 is accepted here (the backend's own exit is
 * floor-free: bundle/prepareSell.js:12-18); plan.js always passes a real floor.
 */
export function curveSellTx(curve, amount, minOut, recipient) {
  return {
    to: norm(curve),
    data: curveIface.encodeFunctionData('sell', [
      positive(amount, 'sell amount'),
      uint(minOut, 'minOut'),
      norm(recipient),
    ]),
    value: 0n,
  };
}

/**
 * A graduated pons token sold into its Uniswap V4 pool through the
 * UniversalRouter: one V4_SWAP command running SWAP_EXACT_IN_SINGLE, SETTLE (the
 * router pulls the token from the seller via Permit2) and TAKE (the whole output
 * to `recipient`). The PoolKey is the venue's verified one, never re-derived.
 *
 * NEVER FLOORLESS: a public pool swap without a floor can be sandwiched to
 * nothing (backend/src/evm/v3/poolswap.js:480-488), so minOut must be > 0.
 */
export function v4SellTx(venue, amount, minOut, recipient, deadline) {
  const key = venue && venue.poolKey;
  if (!key) throw new Error('v4SellTx: the venue carries no poolKey');
  const token = norm(venue.token);
  const currency0 = norm(key.currency0);
  const currency1 = norm(key.currency1);
  if (BigInt(currency0) >= BigInt(currency1)) throw new Error('v4SellTx: poolKey currencies are not sorted');
  if (token !== currency0 && token !== currency1) throw new Error('v4SellTx: the token is not in the poolKey');
  const tokenIsCurrency0 = token === currency0;
  const outputCurrency = tokenIsCurrency0 ? currency1 : currency0;

  const poolKey = {
    currency0,
    currency1,
    fee: Number(key.fee),
    tickSpacing: Number(key.tickSpacing),
    hooks: norm(key.hooks),
  };
  const swapParam = coder.encode(
    [EXACT_IN_SINGLE_T],
    [
      {
        poolKey,
        zeroForOne: tokenIsCurrency0, // a sell spends the token
        amountIn: positive(amount, 'sell amount', MAX_UINT128),
        amountOutMinimum: positive(minOut, 'minOut', MAX_UINT128),
        sqrtPriceLimitX96: 0n,
        hookData: '0x',
      },
    ]
  );
  const settleParam = coder.encode(['address', 'uint256', 'bool'], [token, OPEN_DELTA, true]);
  const takeParam = coder.encode(['address', 'address', 'uint256'], [outputCurrency, norm(recipient), OPEN_DELTA]);
  const v4Input = coder.encode(['bytes', 'bytes[]'], [ACTIONS_EXACT_IN, [swapParam, settleParam, takeParam]]);
  return {
    to: norm(UNIVERSAL_ROUTER),
    data: universalRouterIface.encodeFunctionData('execute', [
      COMMANDS_V4_SWAP,
      [v4Input],
      positive(deadline, 'deadline'),
    ]),
    value: 0n,
  };
}

/**
 * A pons v1 token sold into its Uniswap v3 WETH pool through SwapRouter02, as
 * backend/src/evm/router.js:116-170 does: multicall[exactInputSingle paying the
 * ROUTER (its literal address — address(0) reverts "TF", router.js:95-101),
 * unwrapWETH9(0, recipient)]. The floor sits on the swap's amountOutMinimum.
 *
 * `deadline` is accepted for a uniform signature and NOT encoded: SwapRouter02's
 * exactInputSingle has no deadline field (routerRequiresDeadline is false), and
 * the verified repo shape is multicall(bytes[]) (0xac9650d8) — the SwapRouter02
 * selector the broadcast allowlist admits. minOut is the price protection.
 */
export function v1SellTx(venue, amount, minOut, recipient, deadline) {
  void deadline;
  const pair = norm(venue.pairToken);
  if (pair !== norm(WETH)) throw new Error('v1SellTx: a pons v1 pool pairs with WETH; this venue names another pair');
  const router = norm(SWAP_ROUTER02);
  const fee = venue.poolFee != null ? Number(venue.poolFee) : V1_POOL_FEE;
  const swap = swapRouter02Iface.encodeFunctionData('exactInputSingle', [
    [
      norm(venue.token),
      pair,
      fee,
      router,
      positive(amount, 'sell amount'),
      positive(minOut, 'minOut'),
      0n,
    ],
  ]);
  const unwrap = swapRouter02Iface.encodeFunctionData('unwrapWETH9', [0n, norm(recipient)]);
  return {
    to: router,
    data: swapRouter02Iface.encodeFunctionData('multicall', [[swap, unwrap]]),
    value: 0n,
  };
}

const ROUTE_SHAPE = 'pair route: expected pair -> USDG -> WETH, or USDG -> WETH for a USDG pair';

/**
 * The route a /quote/pair answer describes, validated against the pinned hops.
 * Two shapes exist (backend/src/tp/quote.js quotePairToEth, and the
 * backend/src/tp/broadcast.js checkPairPath that admits the swap):
 *   pairToken -(tier)- USDG -(0.01%)- WETH   path of 3 addresses, fees [tier, 100]
 *   USDG -(0.01%)- WETH                      path of 2 addresses, fees [100] — a USDG pair
 * `path` may also be the packed bytes: 66 bytes (20+3+20+3+20) or 43 (20+3+20).
 * @returns {{tokens: string[], fees: number[]}}
 */
export function routeHops(route) {
  if (!route) throw new Error('pair route: no route');
  let tokens;
  let fees;
  if (typeof route.path === 'string') {
    const size = dataLength(route.path);
    if (size === 66) {
      tokens = [dataSlice(route.path, 0, 20), dataSlice(route.path, 23, 43), dataSlice(route.path, 46, 66)];
      fees = [Number(BigInt(dataSlice(route.path, 20, 23))), Number(BigInt(dataSlice(route.path, 43, 46)))];
    } else if (size === 43) {
      tokens = [dataSlice(route.path, 0, 20), dataSlice(route.path, 23, 43)];
      fees = [Number(BigInt(dataSlice(route.path, 20, 23)))];
    } else {
      throw new Error('pair route: a packed path must be 66 bytes (pair -> USDG -> WETH) or 43 (USDG -> WETH)');
    }
  } else {
    tokens = Array.isArray(route.path) ? route.path : [];
    fees = Array.isArray(route.fees) ? route.fees.map(Number) : [];
  }
  const threeHop = tokens.length === 3 && fees.length === 2;
  const oneHop = tokens.length === 2 && fees.length === 1;
  if (!threeHop && !oneHop) throw new Error(ROUTE_SHAPE);
  const hops = tokens.map(norm);
  const usdg = norm(USDG);
  const weth = norm(WETH);
  if (oneHop) {
    // A single hop exists only when the pair token IS USDG.
    if (hops[0] !== usdg) throw new Error(ROUTE_SHAPE);
    if (hops[1] !== weth) throw new Error('pair route: must run through USDG to WETH');
    if (fees[0] !== WETH_USDG_FEE) throw new Error('pair route: the WETH/USDG hop must be the 0.01% pool');
    return { tokens: hops, fees };
  }
  if (hops[1] !== usdg || hops[2] !== weth) throw new Error('pair route: must run through USDG to WETH');
  if ([usdg, weth, norm(NATIVE)].includes(hops[0])) throw new Error('pair route: bad pair token');
  if (!PAIR_FEE_TIERS.includes(fees[0])) throw new Error('pair route: unknown pair fee tier');
  if (fees[1] !== WETH_USDG_FEE) throw new Error('pair route: the WETH/USDG hop must be the 0.01% pool');
  return { tokens: hops, fees };
}

/** A packed Uniswap v3 path — token, fee, token[, fee, token] (swaproute.js:57-70). */
function packPath(tokens, fees) {
  const types = [];
  const values = [];
  tokens.forEach((token, i) => {
    types.push('address');
    values.push(token);
    if (i < fees.length) {
      types.push('uint24');
      values.push(fees[i]);
    }
  });
  return solidityPacked(types, values);
}

/**
 * Pair-token proceeds -> native ETH in the same wallet (the V3 route sell leg,
 * backend/src/evm/v3/swaproute.js:175-182): multicall[exactInput(path, ROUTER,
 * amountIn, minOut), unwrapWETH9(0, recipient)]. The path is pair -> USDG -> WETH,
 * or USDG -> WETH when the pair is USDG. Needs approveTx(pairToken, SWAP_ROUTER02,
 * amountIn) at the nonce before it. `deadline` is not encoded (see v1SellTx).
 */
export function pairToEthTx(route, amountIn, minOut, recipient, deadline) {
  void deadline;
  const { tokens, fees } = routeHops(route);
  const path = packPath(tokens, fees);
  const router = norm(SWAP_ROUTER02);
  const swap = swapRouter02Iface.encodeFunctionData('exactInput', [
    [path, router, positive(amountIn, 'pair amount'), positive(minOut, 'minOut')],
  ]);
  const unwrap = swapRouter02Iface.encodeFunctionData('unwrapWETH9', [0n, norm(recipient)]);
  return {
    to: router,
    data: swapRouter02Iface.encodeFunctionData('multicall', [[swap, unwrap]]),
    value: 0n,
  };
}
