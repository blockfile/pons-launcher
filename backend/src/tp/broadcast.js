'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Take-profit dApp — the broadcast proxy.
//
// The browser signs; this module puts the signed bytes on the wire. It is NOT a
// general relay: every transaction is decoded and checked against the allowlist
// for the named token's venue, and ONE bad transaction rejects the WHOLE batch
// before anything is sent. What passes can only ever
//   - approve THIS token (or its pair token) to the one spender the venue needs,
//   - sell THIS token on its own curve / pool,
//   - swap the pair token to ETH along the one route the dApp uses,
// and every recipient those calls name must be the signing wallet itself. So the
// worst a bug (or an XSS) in the page can make this proxy do is sell the visitor's
// tokens into ETH that stays in the visitor's own wallet (spec §Security).
//
// CANONICAL ENCODING ONLY. Every call — and, for the routers, every nested call —
// is decoded with ethers and RE-ENCODED; the bytes must match exactly. The V4 and
// SwapRouter02 decoders read calldata with their own offset arithmetic, so an
// encoding ethers reads one way could be read another way on-chain. Demanding the
// canonical bytes makes the two readings the same reading.
//
// TYPE 2 ONLY. An EIP-7702 (type 4) transaction can carry an authorization that
// delegates the wallet to arbitrary code while its `to`/`data` look like a plain
// approve (memory: robinhood-anvil-7702-accounts — a sweeper delegation empties
// the account). Anything but an EIP-1559 type-2 transaction is refused.
//
// FEES. Priority fee exactly 0 (plan Global Constraints) and a gas limit of at
// most 1,000,000 (the dApp's largest is 600,000, Part 02 feeParams). Otherwise a
// compromised page could sign allowlisted sells that burn the wallet's ETH on
// tips or on a huge gas limit, and this proxy would relay them.
//
// A SECOND ENDPOINT (spec: "and the sequencer endpoint too if configured"). With
// TP_SEQUENCER_URL set, every raw transaction is ALSO sent there at the same
// moment. The same signed bytes have the same hash, so a duplicate is harmless
// (the second copy is "already known" or dropped). The primary's answer decides
// the pace: the sequencer is waited on only when the primary refused, for at most
// SEQUENCER_TIMEOUT_MS, and a transaction counts as sent if either one accepted it.
//
// Copied (tab-isolation rule), not imported:
//   - ERC-20 / Permit2 / UniversalRouter / V4 action shapes: backend/src/evm/v5/swap.js:92-179,451-493
//   - curve.sell:                           backend/src/evm/v2/abi.js:133
//   - SwapRouter02 exactInputSingle/multicall/unwrapWETH9: backend/src/evm/abi.js SWAP_ROUTER_02_ABI,
//     backend/src/evm/router.js:116-170
//   - exactInput + the pair route shape:    backend/src/evm/v3/swaproute.js:32-36,54,64-70,175-182
//   - per-wallet send ordering:             backend/src/bundle/fireSell.js:137-171
//   - rpcMessage:                           backend/src/evm/errors.js:16-40
// ─────────────────────────────────────────────────────────────────────────────

const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const { AbiCoder, FetchRequest, Interface, JsonRpcProvider, Transaction } = require('ethers');

const C = require('./constants');
const { TpError } = require('./errors');
const providers = require('./providers');

const coder = AbiCoder.defaultAbiCoder();

const MAX_TXS = 100;
// A V4 sell is ~0.9 KB signed; 8 KB is far above anything the dApp builds.
const MAX_RAW_HEX = 2 + 2 * 8192;
// Part 02 feeParams: sellCurve / sellV1 600k are the largest limits the page signs.
const MAX_GAS_LIMIT = 1_000_000n;
const RECEIPT_POLL_MS = 250;
const RECEIPT_TIMEOUT_MS = 120_000;
// Hashes watched at once, process-wide (TP_WATCH_MAX): a few dozen 100-wallet clicks.
const MAX_WATCHED = Number(process.env.TP_WATCH_MAX) > 0 ? Number(process.env.TP_WATCH_MAX) : 2000;
// How long a refused-by-the-primary send waits for the sequencer's answer.
const SEQUENCER_TIMEOUT_MS = 5000;
// At most one "[tp] sequencer send failed" log line per minute.
const SEQUENCER_WARN_EVERY_MS = 60_000;

// swaproute.js:54 — the USDG<->pair tiers the route may use.
const PAIR_FEE_TIERS = [3000, 500, 100, 10000];
// Uniswap v3's four standard tiers; a pons v1 pool is the 1% one (spec 2026-07-25).
const V1_FEE_TIERS = [100, 500, 3000, 10000];

// v5/swap.js:105,117-119 — one V4_SWAP command; SWAP_EXACT_IN_SINGLE, SETTLE, TAKE.
const V4_COMMANDS = '0x10';
const V4_ACTIONS = '0x060b0e';
// v5/swap.js:130-135 — the router's OLDER six-field ExactInputSingleParams.
const POOLKEY_T = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const EXACT_IN_SINGLE_T =
  `tuple(${POOLKEY_T} poolKey,bool zeroForOne,uint128 amountIn,` +
  'uint128 amountOutMinimum,uint160 sqrtPriceLimitX96,bytes hookData)';

const erc20Iface = new Interface(['function approve(address spender, uint256 amount) returns (bool)']);
const curveIface = new Interface([
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
]);
const permit2Iface = new Interface([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
]);
const universalRouterIface = new Interface([
  'function execute(bytes commands, bytes[] inputs, uint256 deadline) payable',
]);
const swapRouterIface = new Interface([
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function exactInput(tuple(bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
]);

const SEL = {
  approve: erc20Iface.getFunction('approve').selector, // 0x095ea7b3
  sell: curveIface.getFunction('sell').selector, // 0xd04c6983
  permit2Approve: permit2Iface.getFunction('approve').selector, // 0x87517c45
  execute: universalRouterIface.getFunction('execute').selector, // 0x3593564c
  multicall: swapRouterIface.getFunction('multicall(bytes[])').selector, // 0xac9650d8
  multicallDeadline: swapRouterIface.getFunction('multicall(uint256,bytes[])').selector, // 0x5ae401dc
  exactInputSingle: swapRouterIface.getFunction('exactInputSingle').selector, // 0x04e45aaf
  exactInput: swapRouterIface.getFunction('exactInput').selector, // 0xb858183f
  unwrapWETH9: swapRouterIface.getFunction('unwrapWETH9').selector, // 0x49404b7c
};

/** Every receipt the watcher sees: {token, hash, from, status, block, gasUsed, sid?}. */
const receiptBus = new EventEmitter();
receiptBus.setMaxListeners(0); // one listener per open stream

const lc = (a) => String(a).toLowerCase();
const bad = (message) => new TpError('bad_tx', message);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── decoding ─────────────────────────────────────────────────────────────────

/**
 * A signed raw transaction → the fields validateTx needs. Throws TpError('bad_tx')
 * for anything that is not a signed EIP-1559 (type 2) transaction.
 *
 * @returns {{hash, from, to, nonce, chainId, selector, data, value, gasLimit, maxPriorityFeePerGas}}
 *   addresses and hex lower-case; value, gasLimit and maxPriorityFeePerGas decimal strings.
 */
function decodeRaw(raw) {
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw) || raw.length > MAX_RAW_HEX) {
    throw bad('not a hex-encoded signed transaction');
  }
  let tx;
  try {
    tx = Transaction.from(raw);
  } catch (_err) {
    throw bad('not a valid signed transaction');
  }
  if (tx.type !== 2) throw bad(`transaction type ${tx.type} is not allowed — only EIP-1559 (type 2)`);
  if (!tx.signature || !tx.from) throw bad('transaction is not signed');
  const data = lc(tx.data || '0x');
  return {
    hash: lc(tx.hash),
    from: lc(tx.from),
    to: tx.to ? lc(tx.to) : null,
    nonce: Number(tx.nonce),
    chainId: Number(tx.chainId),
    selector: data.length >= 10 ? data.slice(0, 10) : data,
    data,
    value: tx.value.toString(),
    gasLimit: tx.gasLimit.toString(),
    // A type-2 transaction always carries it; null only if ethers ever leaves it out.
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas == null ? null : tx.maxPriorityFeePerGas.toString(),
  };
}

/** Decode `data` as iface.key and demand the canonical encoding. */
function canonicalCall(iface, key, data, what) {
  const fn = iface.getFunction(key);
  let args;
  try {
    args = iface.decodeFunctionData(fn, data);
  } catch (_err) {
    throw bad(`${what}: the calldata does not decode`);
  }
  if (lc(iface.encodeFunctionData(fn, args)) !== lc(data)) {
    throw bad(`${what}: the calldata is not canonically encoded`);
  }
  return args;
}

/** Decode ABI `types` from `data` and demand the canonical encoding. */
function canonicalValues(types, data, what) {
  let values;
  try {
    values = coder.decode(types, data);
  } catch (_err) {
    throw bad(`${what}: the parameters do not decode`);
  }
  if (lc(coder.encode(types, values)) !== lc(data)) {
    throw bad(`${what}: the parameters are not canonically encoded`);
  }
  return values;
}

// ── the allowlist ────────────────────────────────────────────────────────────

/** The V4 sell poolswap.js/v5 swap.js build: exact-in single, SETTLE the token, TAKE the quote to `from`. */
function checkV4Sell(d, venue) {
  const token = lc(venue.token);
  const key = venue.poolKey || {};
  const [commands, inputs] = canonicalCall(universalRouterIface, 'execute', d.data, 'V4 sell');
  if (lc(commands) !== V4_COMMANDS || inputs.length !== 1) throw bad('V4 sell must be exactly one V4_SWAP command');
  const [actions, params] = canonicalValues(['bytes', 'bytes[]'], inputs[0], 'V4 sell input');
  if (lc(actions) !== V4_ACTIONS || params.length !== 3) {
    throw bad('V4 sell must be SWAP_EXACT_IN_SINGLE, SETTLE, TAKE');
  }

  const [swap] = canonicalValues([EXACT_IN_SINGLE_T], params[0], 'V4 swap');
  const pk = swap.poolKey;
  if (
    lc(pk.currency0) !== lc(key.currency0) ||
    lc(pk.currency1) !== lc(key.currency1) ||
    Number(pk.fee) !== Number(key.fee) ||
    Number(pk.tickSpacing) !== Number(key.tickSpacing) ||
    lc(pk.hooks) !== lc(key.hooks)
  ) {
    throw bad("V4 sell targets a pool that is not this token's");
  }
  const tokenIsCurrency0 = lc(key.currency0) === token;
  if (!tokenIsCurrency0 && lc(key.currency1) !== token) throw bad('the venue pool does not contain this token');
  // A sell spends the token (poolswap.js:372-376).
  if (swap.zeroForOne !== tokenIsCurrency0) throw bad('V4 swap is a buy, not a sell');
  if (BigInt(swap.amountIn) <= 0n) throw bad('V4 sell of 0 tokens');
  if (BigInt(swap.sqrtPriceLimitX96) !== 0n) throw bad('V4 sell must not set a price limit');
  if (lc(swap.hookData) !== '0x') throw bad('V4 sell must not carry hook data');

  const [settleCurrency, settleAmount, payerIsUser] = canonicalValues(
    ['address', 'uint256', 'bool'],
    params[1],
    'V4 settle'
  );
  if (lc(settleCurrency) !== token || BigInt(settleAmount) !== 0n || payerIsUser !== true) {
    throw bad('V4 settle must pay this token, OPEN_DELTA, from the user');
  }

  const [takeCurrency, takeRecipient, takeAmount] = canonicalValues(
    ['address', 'address', 'uint256'],
    params[2],
    'V4 take'
  );
  const quoteCurrency = tokenIsCurrency0 ? lc(key.currency1) : lc(key.currency0);
  if (lc(takeCurrency) !== quoteCurrency || BigInt(takeAmount) !== 0n) {
    throw bad("V4 take must collect this pool's quote currency, OPEN_DELTA");
  }
  if (lc(takeRecipient) !== d.from) throw bad('V4 sell pays a third address');
}

/** pair → USDG → WETH (or USDG → WETH when the pair is USDG), swaproute.js:64-70. */
function checkPairPath(pathHex, pairToken) {
  const h = lc(pathHex).slice(2);
  const addr = (from) => '0x' + h.slice(from, from + 40);
  const fee = (from) => parseInt(h.slice(from, from + 6), 16);
  const usdg = lc(C.USDG);
  const weth = lc(C.WETH);
  const wethUsdgFee = Number(C.WETH_USDG_FEE);
  const pair = lc(pairToken);
  if (h.length === 86) {
    if (pair !== usdg || addr(0) !== usdg || fee(40) !== wethUsdgFee || addr(46) !== weth) {
      throw bad('pair swap path is not USDG -> WETH');
    }
    return;
  }
  if (h.length === 132) {
    if (
      addr(0) !== pair ||
      !PAIR_FEE_TIERS.includes(fee(40)) ||
      addr(46) !== usdg ||
      fee(86) !== wethUsdgFee ||
      addr(92) !== weth
    ) {
      throw bad('pair swap path is not pair -> USDG -> WETH');
    }
    return;
  }
  throw bad('pair swap path has the wrong length');
}

/**
 * SwapRouter02.multicall = [swap to the router in WETH, unwrapWETH9 to the seller].
 * v1 sell (router.js:116-170): exactInputSingle(token -> WETH).
 * Pair → ETH (swaproute.js:175-182): exactInput(pair -> USDG -> WETH).
 */
function checkRouterMulticall(d, venue) {
  const args = canonicalCall(swapRouterIface, d.selector, d.data, 'router multicall');
  const calls = d.selector === SEL.multicall ? args[0] : args[1];
  if (calls.length !== 2) throw bad('router multicall must be exactly [swap, unwrapWETH9]');
  const [swapData, unwrapData] = calls;
  const swapSel = lc(swapData).slice(0, 10);
  const router = lc(C.SWAP_ROUTER02);

  if (swapSel === SEL.exactInputSingle && venue.kind === 'v1') {
    const [p] = canonicalCall(swapRouterIface, 'exactInputSingle', swapData, 'v1 sell');
    if (lc(p.tokenIn) !== lc(venue.token)) throw bad('v1 sell spends a different token');
    if (lc(p.tokenOut) !== lc(C.WETH)) throw bad('v1 sell must pay WETH');
    // The launch's own pool: anyone can seed a token/WETH pool at another tier at any
    // price, so a sell there could fill for dust. venue.js always records poolFee for v1.
    const pinnedFee = venue.poolFee == null ? null : Number(venue.poolFee);
    if (Number.isInteger(pinnedFee) ? Number(p.fee) !== pinnedFee : !V1_FEE_TIERS.includes(Number(p.fee))) {
      throw bad("v1 sell names a fee tier that is not the launch pool's");
    }
    if (lc(p.recipient) !== router) throw bad('v1 sell must leave the WETH in the router for the unwrap');
    if (BigInt(p.amountIn) <= 0n) throw bad('v1 sell of 0 tokens');
    if (BigInt(p.sqrtPriceLimitX96) !== 0n) throw bad('v1 sell must not set a price limit');
  } else if (swapSel === SEL.exactInput && venue.kind !== 'v1' && !venue.nativeQuote) {
    const [p] = canonicalCall(swapRouterIface, 'exactInput', swapData, 'pair to ETH swap');
    checkPairPath(p.path, venue.pairToken);
    if (lc(p.recipient) !== router) throw bad('pair swap must leave the WETH in the router for the unwrap');
    if (BigInt(p.amountIn) <= 0n) throw bad('pair swap of 0');
  } else {
    throw bad('router multicall carries a swap this token does not use');
  }

  const [, recipient] = canonicalCall(swapRouterIface, 'unwrapWETH9', unwrapData, 'unwrap');
  if (lc(recipient) !== d.from) throw bad('the unwrapped ETH goes to a third address');
}

/**
 * Throws TpError('bad_tx') unless `decoded` is one of the calls this venue allows.
 * Pure — no chain reads — so validating 100 transactions costs microseconds.
 */
function validateTx(decoded, venue) {
  if (!venue || !venue.token || !venue.kind) throw new TpError('bad_request', 'no venue to validate against');
  const d = decoded;
  if (Number(d.chainId) !== Number(C.CHAIN_ID)) throw bad(`chain id ${d.chainId} is not ${C.CHAIN_ID}`);
  // Fees (see the header): tip exactly 0, gas limit capped. A missing field is refused.
  if (!/^\d+$/.test(String(d.maxPriorityFeePerGas)) || BigInt(d.maxPriorityFeePerGas) !== 0n) {
    throw bad(`priority fee ${d.maxPriorityFeePerGas} is not 0`);
  }
  if (!/^\d+$/.test(String(d.gasLimit)) || BigInt(d.gasLimit) > MAX_GAS_LIMIT) {
    throw bad(`gas limit ${d.gasLimit} is above ${MAX_GAS_LIMIT}`);
  }
  if (!d.to) throw bad('contract creation is not allowed');
  if (BigInt(d.value || '0') !== 0n) throw bad('a sell or an approval never carries ETH');

  const to = lc(d.to);
  const sel = lc(d.selector);
  const token = lc(venue.token);
  const spenders = venue.spenders || {};

  // 1. token.approve(the one spender this venue needs)
  if (to === token && sel === SEL.approve) {
    const [spender] = canonicalCall(erc20Iface, 'approve', d.data, 'token approve');
    if (!spenders.approve || lc(spender) !== lc(spenders.approve)) {
      throw bad(`approve names spender ${lc(spender)}, not this venue's ${spenders.approve ? lc(spenders.approve) : 'spender'}`);
    }
    return;
  }

  // 2. curve.sell(tokensIn, minQuoteOut, recipient = the seller)
  if (venue.kind === 'curve' && to === lc(venue.curve) && sel === SEL.sell) {
    const [tokensIn, , recipient] = canonicalCall(curveIface, 'sell', d.data, 'curve sell');
    if (BigInt(tokensIn) <= 0n) throw bad('curve sell of 0 tokens');
    if (lc(recipient) !== d.from) throw bad('curve sell pays a third address');
    return;
  }

  // 3. graduated: Permit2.approve(token, UniversalRouter, amount, expiration)
  if (venue.kind === 'graduated' && to === lc(C.PERMIT2) && sel === SEL.permit2Approve) {
    const [permitToken, spender] = canonicalCall(permit2Iface, 'approve', d.data, 'Permit2 approve');
    if (lc(permitToken) !== token) throw bad('Permit2 approve names a different token');
    if (lc(spender) !== lc(C.UNIVERSAL_ROUTER)) throw bad('Permit2 approve names a spender that is not the router');
    return;
  }

  // 4. graduated: UniversalRouter.execute(V4 sell)
  if (venue.kind === 'graduated' && to === lc(C.UNIVERSAL_ROUTER) && sel === SEL.execute) {
    checkV4Sell(d, venue);
    return;
  }

  // 5. SwapRouter02.multicall: the v1 sell, or the pair -> ETH leg
  if (to === lc(C.SWAP_ROUTER02) && (sel === SEL.multicall || sel === SEL.multicallDeadline)) {
    checkRouterMulticall(d, venue);
    return;
  }

  // 6. token-quoted venue: pairToken.approve(SwapRouter02) for the ETH leg
  if (!venue.nativeQuote && venue.pairToken && to === lc(venue.pairToken) && sel === SEL.approve) {
    const [spender] = canonicalCall(erc20Iface, 'approve', d.data, 'pair token approve');
    if (lc(spender) !== lc(C.SWAP_ROUTER02)) throw bad('pair token approve names a spender that is not SwapRouter02');
    return;
  }

  throw bad(`a call to ${to} with selector ${sel} is not allowed for this token`);
}

// ── sending ──────────────────────────────────────────────────────────────────

/** backend/src/evm/errors.js:16-40 — a readable one-line RPC error. */
function sendError(err) {
  if (!err) return 'unknown error';
  const inner = (err.info && err.info.error && err.info.error.message) || (err.error && err.error.message) || null;
  const short = err.shortMessage || null;
  const code = (err.info && err.info.error && err.info.error.code) || (err.error && err.error.code);
  const vague = !short || /could not coalesce|unknown error/i.test(short);
  const chosen = vague ? inner || err.message || short : short;
  if (!chosen) return String(err);
  const withCode = vague && code ? `${chosen} (code ${code})` : chosen;
  return withCode.length > 300 ? `${withCode.slice(0, 300)}…` : withCode;
}

// ── the optional second endpoint ─────────────────────────────────────────────

let sequencer = null; // { url, provider, agent } — built on first use, never at require time

/**
 * The TP_SEQUENCER_URL endpoint as a JsonRpcProvider, or null when the variable is
 * blank. Read at CALL time, so the process env (and a test) decides; built lazily
 * and cached per URL. staticNetwork: no eth_chainId round trip, so building it
 * touches nothing; batchMaxCount 1: some RH nodes mishandle batch arrays
 * (providers.js tpChartProvider, evm/provider.js:117-122).
 *
 * ALWAYS its own getUrlFunc and keep-alive agent (an http.Agent or an https.Agent,
 * matching the URL). evm/provider.js registers a PROCESS-WIDE https-only getUrl
 * whenever RPC_URL is https (the default); a provider without its own inherits it,
 * and node then refuses a plain-http sequencer URL on every send (Protocol "http:"
 * not supported) — the same trap providers.js tpChartProvider documents.
 */
function sequencerProvider() {
  const url = String(process.env.TP_SEQUENCER_URL || '').trim();
  if (!url) return null;
  if (sequencer && sequencer.url === url) return sequencer.provider;
  resetSequencer();
  let agent = null;
  try {
    const request = new FetchRequest(url);
    request.timeout = SEQUENCER_TIMEOUT_MS;
    // One socket per transaction of a full batch: every wallet sends at once.
    const agentOptions = { keepAlive: true, keepAliveMsecs: 10000, maxSockets: MAX_TXS, maxFreeSockets: 32 };
    agent = /^https:/i.test(url) ? new https.Agent(agentOptions) : new http.Agent(agentOptions);
    request.getUrlFunc = FetchRequest.createGetUrlFunc({ agent });
    sequencer = {
      url,
      agent,
      provider: new JsonRpcProvider(request, C.CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 }),
    };
  } catch (err) {
    if (agent) agent.destroy();
    // A malformed URL must never stop a sell: the primary still sends.
    warnSequencer(`TP_SEQUENCER_URL is unusable: ${err.message}`);
    return null;
  }
  return sequencer.provider;
}

/** Drop the cached sequencer provider and its socket pool (a changed URL; tests). */
function resetSequencer() {
  if (sequencer) {
    try {
      sequencer.provider.destroy();
    } catch (_err) {
      // already destroyed
    }
    if (sequencer.agent) sequencer.agent.destroy();
  }
  sequencer = null;
}

let lastSequencerWarn = 0;
function warnSequencer(message) {
  const now = Date.now();
  if (now - lastSequencerWarn < SEQUENCER_WARN_EVERY_MS) return;
  lastSequencerWarn = now;
  console.warn(`[tp] sequencer send failed: ${message}`);
}

/** Reject after `ms`; the timer never keeps the process alive. */
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
    if (timer.unref) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** The node holds this exact transaction already: it is on its way. */
const accepted = (err) => err === null || /already known/i.test(sendError(err));

/**
 * Send ONE signed transaction to the primary and, when configured, the sequencer at
 * the same moment. Resolves null when either endpoint accepted it (or already held
 * it), else the primary's error as one readable line. Waits on the sequencer only
 * when the primary refused, and then for at most `timeoutMs`.
 */
async function sendOne(rpc, seqRpc, raw, timeoutMs) {
  const first = Promise.resolve()
    .then(() => rpc.send('eth_sendRawTransaction', [raw]))
    .then(() => null, (err) => err);
  const second = seqRpc
    ? withTimeout(Promise.resolve().then(() => seqRpc.send('eth_sendRawTransaction', [raw])), timeoutMs).then(
        () => null,
        (err) => err
      )
    : null;

  const firstErr = await first;
  if (accepted(firstErr)) {
    if (second) {
      second.then((err) => {
        if (!accepted(err)) warnSequencer(sendError(err));
      });
    }
    return null;
  }
  if (second) {
    const secondErr = await second;
    if (accepted(secondErr)) return null;
    warnSequencer(sendError(secondErr));
  }
  return sendError(firstErr);
}

/**
 * Validate every transaction, then send them all.
 *
 * Wallets go out CONCURRENTLY; one wallet's own transactions go out in nonce order,
 * each awaited only as far as the node's acknowledgement (fireSell.js:137-171). A
 * transaction whose predecessor failed to broadcast is NOT sent: it would sit behind
 * a nonce gap that never fills.
 *
 * The raw bytes go through `send('eth_sendRawTransaction')`, not
 * provider.broadcastTransaction: ethers' broadcastTransaction also reads the block
 * number alongside the send, so a failed side-read would report a transaction that
 * DID reach the sequencer as failed and hold back the wallet's next nonce. The shared
 * provider still retries a rate-limited broadcast (evm/provider.js:75-79).
 *
 * With TP_SEQUENCER_URL set, each transaction also goes to that endpoint (sendOne).
 * One wallet's NEXT nonce waits only for the primary's answer, so the sequencer may
 * see nonce N+1 before N and refuse it as too high. That is harmless: the primary
 * got both, in order.
 *
 * @param {object} venue a Venue from venue.js
 * @param {string[]} raws signed raw transactions (hex)
 * @param {{provider?: object, sequencer?: object|null, sequencerTimeoutMs?: number}} [deps]
 *   tests only. Injecting `provider` also turns the env's sequencer OFF unless
 *   `sequencer` is passed too, so a test can never reach a real endpoint.
 * @returns {Promise<Array<{hash, from, nonce, ok, error}>>} in the order of `raws`
 */
async function broadcast(venue, raws, deps = {}) {
  if (!Array.isArray(raws) || raws.length === 0) {
    throw new TpError('bad_request', 'txs must be a non-empty list of signed transactions');
  }
  if (raws.length > MAX_TXS) throw new TpError('too_many', `at most ${MAX_TXS} transactions per broadcast`);

  // 1. EVERY transaction is checked before ANY is sent.
  const decoded = raws.map((raw, i) => {
    try {
      const d = decodeRaw(raw);
      validateTx(d, venue);
      return d;
    } catch (err) {
      if (err instanceof TpError) throw new TpError(err.code, `tx ${i}: ${err.message}`, err.status);
      throw err;
    }
  });
  const hashes = new Set();
  const slots = new Set();
  decoded.forEach((d, i) => {
    if (hashes.has(d.hash)) throw bad(`tx ${i}: the same transaction appears twice`);
    hashes.add(d.hash);
    const slot = `${d.from}:${d.nonce}`;
    if (slots.has(slot)) throw bad(`tx ${i}: two transactions from ${d.from} share nonce ${d.nonce}`);
    slots.add(slot);
  });

  // 2. Send.
  const rpc = deps.provider || providers.tpSendProvider();
  const seqRpc = deps.provider ? deps.sequencer || null : sequencerProvider();
  const seqTimeoutMs = deps.sequencerTimeoutMs ?? SEQUENCER_TIMEOUT_MS;
  const bySender = new Map();
  decoded.forEach((d, i) => {
    if (!bySender.has(d.from)) bySender.set(d.from, []);
    bySender.get(d.from).push(i);
  });

  const results = new Array(raws.length);
  await Promise.all(
    [...bySender.values()].map(async (indexes) => {
      indexes.sort((a, b) => decoded[a].nonce - decoded[b].nonce);
      let failedNonce = null;
      for (const i of indexes) {
        const d = decoded[i];
        const base = { hash: d.hash, from: d.from, nonce: d.nonce };
        if (failedNonce !== null) {
          results[i] = { ...base, ok: false, error: `not sent: nonce ${failedNonce} of this wallet failed first` };
          continue;
        }
        const error = await sendOne(rpc, seqRpc, raws[i], seqTimeoutMs);
        if (error === null) {
          results[i] = { ...base, ok: true, error: null };
        } else {
          results[i] = { ...base, ok: false, error };
          failedNonce = d.nonce;
        }
      }
    })
  );
  return results;
}

// Hashes being watched right now, over every watchReceipts call in the process.
let watchedNow = 0;

/**
 * Poll each hash's receipt every 250 ms for at most 120 s and announce each one on
 * receiptBus as it lands. Fire-and-forget for the route; the returned promise
 * (resolving to the hashes that never landed) exists for tests.
 *
 * The polls run on tpReceiptProvider: a lane of their own (socket pool and process-wide
 * cap), so a 100-wallet click's polls never queue another visitor's click quote or
 * wallet read. At most TP_WATCH_MAX hashes are watched at once across ALL calls. A hash
 * over the cap is simply not watched: the page settles it from its wallet's nonce and
 * balance (its missed-receipt sweep), so dropping it costs latency, never a wrong row.
 *
 * @param {string} token the venue's token (the stream filters on it)
 * @param {string[]} hashes
 * @param {{provider?: object, pollMs?: number, timeoutMs?: number, sid?: string, maxWatched?: number}} [deps]
 */
function watchReceipts(token, hashes, deps = {}) {
  const rpc = deps.provider || providers.tpReceiptProvider();
  const pollMs = deps.pollMs ?? RECEIPT_POLL_MS;
  const timeoutMs = deps.timeoutMs ?? RECEIPT_TIMEOUT_MS;
  const cap = deps.maxWatched ?? MAX_WATCHED;
  const all = [...new Set((hashes || []).map(lc))];
  const room = Math.max(0, cap - watchedNow);
  const waiting = new Set(all.slice(0, room));
  const unwatched = all.slice(room);
  watchedNow += waiting.size;
  const deadline = Date.now() + timeoutMs;
  const tokenLc = lc(token);
  // The chart stream that asked for these receipts (plan Task 7, tp/stream.js). Only
  // that stream forwards them, so no other viewer of the token can link this
  // visitor's wallets. Anything but 32 lower-case hex is dropped: no stream hears it.
  const sid = typeof deps.sid === 'string' && /^[0-9a-f]{32}$/.test(deps.sid) ? deps.sid : null;

  return (async () => {
    try {
      await pollUntilDone();
    } finally {
      watchedNow -= waiting.size;
    }
    return [...waiting, ...unwatched];
  })();

  async function pollUntilDone() {
    while (waiting.size) {
      await Promise.all(
        [...waiting].map(async (hash) => {
          let receipt = null;
          try {
            receipt = await rpc.getTransactionReceipt(hash);
          } catch (_err) {
            return; // a blip mid-poll is not a failure; the next tick retries
          }
          if (!receipt || !waiting.has(hash)) return;
          waiting.delete(hash);
          watchedNow -= 1;
          try {
            receiptBus.emit('receipt', {
              token: tokenLc,
              hash,
              from: receipt.from ? lc(receipt.from) : null,
              status: Number(receipt.status) === 1 ? 'landed' : 'reverted',
              block: Number(receipt.blockNumber),
              gasUsed: String(receipt.gasUsed),
              ...(sid ? { sid } : {}),
            });
          } catch (_err) {
            // a listener's failure must not stop the other receipts
          }
        })
      );
      if (!waiting.size || Date.now() >= deadline) break;
      await sleep(pollMs);
    }
  }
}

module.exports = {
  decodeRaw,
  validateTx,
  broadcast,
  watchReceipts,
  receiptBus,
  MAX_TXS, // routes/tp.js checks the batch size before it touches the venue
  _private: {
    SEL,
    MAX_TXS,
    MAX_GAS_LIMIT,
    EXACT_IN_SINGLE_T,
    checkPairPath,
    sendError,
    sequencerProvider,
    resetSequencer,
  },
};
