'use strict';

/**
 * V7's flap bonding-curve client: quotes, calldata, and the provenance guard for a
 * NON-GRADUATED, native-quoted flap token — the one place the exact flap launcher
 * bytes are built and verified against the chain. READS AND BUILDS ONLY; it never
 * signs (v7/trade.js does that, exactly as v6/trade.js wraps evm/v5/swap.js).
 *
 * This is the flap analog of evm/v5/swap.js + the provenance half of evm/v5/factory.js,
 * collapsed into one file because the flap venue is FIXED, not per-token:
 *
 *   - Every state-0 buy and sell bottoms out in ONE launcher (config.flap.launcher).
 *     The token is an explicit calldata argument, so there is no per-pool hook to
 *     resolve or verify — no candidateHooks probe, no PoolManager, no Permit2.
 *   - Native ETH is the sentinel address(0) on the launcher. A BUY carries native in
 *     as msg.value; a SELL takes the token (after a plain approve) and pays native out
 *     (the launcher unwraps WNATIVE internally). So V7 never touches WNATIVE and needs
 *     no wrap/unwrap — every value hop is native, which is what lets Relay move it.
 *   - The one trade function, swapExactInput, serves both directions. quoteExactInput
 *     PRICES BOTH buys and sells (unlike the letscash hook, which reverted sell quotes),
 *     so there is no getLogs sellability scan anywhere in V7.
 *
 * Selectors, live quote numbers, and the getTokenV8 struct offsets in this file were
 * proven against chain 4663 before it was written (ZYBER 0x1e77…7777): swapExactInput
 * 0xef7ec2e7, quoteExactInput 0xfc847c2b, getFeeRate 0x84e5eed0, getTokenV8 0xf1159a49;
 * circulatingSupply = word[2], dexSupplyThresh = word[8].
 */

const { getAddress, Interface } = require('ethers');
const config = require('../../config');
const { provider } = require('../provider');

// address(0): the launcher's native sentinel. The native leg MUST be this — passing
// WNATIVE on the native leg reverts (verified). WNATIVE only ever appears as a token's
// quoteToken(), where readCurve checks it; it is never a trade leg.
const NATIVE = '0x0000000000000000000000000000000000000000';

const CURVE_IFACE = new Interface([
  // The one trade fn (payable), for both buys and sells. `data` = '0x' for a plain trade.
  'function swapExactInput((address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,bytes data)) payable returns (uint256 amountOut)',
  // Prices both directions; native leg must be address(0).
  'function quoteExactInput((address tokenIn,address tokenOut,uint256 amountIn)) view returns (uint256 amountOut)',
  'function getFeeRate() view returns (uint256)',
]);

const TOKEN_IFACE = new Interface([
  'function state() view returns (uint8)',
  'function quoteToken() view returns (address)',
  'function mainPool() view returns (address)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

// getTokenV8(address) is UNVERIFIED source, so its return is decoded by fixed word
// offset (proven live against ZYBER), not by a struct ABI. tokenCurve() guards the
// decode so a future impl that moved the layout THROWS rather than misreads.
const GET_TOKEN_V8_SELECTOR = '0xf1159a49';
const CIRCULATING_SUPPLY_WORD = 2; // tokens sold off the curve so far
const DEX_SUPPLY_THRESH_WORD = 8; // graduation trigger (tokens-sold threshold)

const LAUNCHER = () => getAddress(config.flap.launcher);

function rpcOf(deps) {
  return deps.provider || deps.rpc || provider;
}

/** ETH out for selling `tokensInWei` tokens (BigInt). The flap quoter prices sells. */
async function quoteSell({ token, tokensInWei }, deps = {}) {
  const rpc = rpcOf(deps);
  const data = CURVE_IFACE.encodeFunctionData('quoteExactInput', [
    [getAddress(token), NATIVE, BigInt(tokensInWei)],
  ]);
  const raw = await rpc.call({ to: LAUNCHER(), data });
  return BigInt(CURVE_IFACE.decodeFunctionResult('quoteExactInput', raw)[0]);
}

/** Tokens out for spending `amountInWei` native (BigInt). Native leg = address(0). */
async function quoteBuy({ token, amountInWei }, deps = {}) {
  const rpc = rpcOf(deps);
  const data = CURVE_IFACE.encodeFunctionData('quoteExactInput', [
    [NATIVE, getAddress(token), BigInt(amountInWei)],
  ]);
  const raw = await rpc.call({ to: LAUNCHER(), data });
  return BigInt(CURVE_IFACE.decodeFunctionResult('quoteExactInput', raw)[0]);
}

/**
 * A native-in BUY: swapExactInput((0x0, token, amountIn, minOut, 0x)) with the native
 * riding in as msg.value. `to` is the launcher, `value` is the spend.
 */
function buildBuyTx({ token, amountInWei, minOut }) {
  const amount = BigInt(amountInWei);
  const data = CURVE_IFACE.encodeFunctionData('swapExactInput', [
    [NATIVE, getAddress(token), amount, BigInt(minOut), '0x'],
  ]);
  return { to: LAUNCHER(), data, value: amount };
}

/**
 * A token-in SELL: swapExactInput((token, 0x0, tokensIn, minOut, 0x)), value 0. The
 * launcher pulls the token via transferFrom (needs the approve below) and pays native
 * out. Requires a prior approve(launcher, amount) at the preceding nonce.
 */
function buildSellTx({ token, tokensInWei, minOut }) {
  const data = CURVE_IFACE.encodeFunctionData('swapExactInput', [
    [getAddress(token), NATIVE, BigInt(tokensInWei), BigInt(minOut), '0x'],
  ]);
  return { to: LAUNCHER(), data, value: 0n };
}

/** A bounded per-sell approve(launcher, amount) on the token itself. */
function buildApproveTx({ token, amount }) {
  const data = TOKEN_IFACE.encodeFunctionData('approve', [LAUNCHER(), BigInt(amount)]);
  return { to: getAddress(token), data, value: 0n };
}

/** The token's curve state as a Number (0 = BondingCurve; ≥1 = migrating/graduated). */
async function tokenState(token, deps = {}) {
  const rpc = rpcOf(deps);
  const raw = await rpc.call({ to: getAddress(token), data: TOKEN_IFACE.encodeFunctionData('state', []) });
  return Number(TOKEN_IFACE.decodeFunctionResult('state', raw)[0]);
}

/** The token's quoteToken() (checksummed). WNATIVE for a native-quoted flap curve. */
async function quoteTokenOf(token, deps = {}) {
  const rpc = rpcOf(deps);
  const raw = await rpc.call({ to: getAddress(token), data: TOKEN_IFACE.encodeFunctionData('quoteToken', []) });
  return getAddress(TOKEN_IFACE.decodeFunctionResult('quoteToken', raw)[0]);
}

/**
 * Curve params for the graduation gate: how much has sold off the curve and the sold
 * threshold that graduates it. Decoded by proven word offset from getTokenV8; guarded so
 * a moved layout throws (0 or thresh < circulating) rather than silently misreading and
 * mis-sizing the graduation guard.
 *
 * @returns {Promise<{circulatingSupply: bigint, dexSupplyThresh: bigint}>}
 */
async function tokenCurve(token, deps = {}) {
  const rpc = rpcOf(deps);
  const data = GET_TOKEN_V8_SELECTOR + getAddress(token).slice(2).toLowerCase().padStart(64, '0');
  const raw = await rpc.call({ to: LAUNCHER(), data });
  const hex = String(raw).replace(/^0x/, '');
  const word = (i) => {
    const slice = hex.slice(i * 64, i * 64 + 64);
    if (slice.length !== 64) throw new Error(`getTokenV8(${token}) returned too few words to read word[${i}]`);
    return BigInt('0x' + slice);
  };
  const circulatingSupply = word(CIRCULATING_SUPPLY_WORD);
  const dexSupplyThresh = word(DEX_SUPPLY_THRESH_WORD);
  if (dexSupplyThresh === 0n || dexSupplyThresh < circulatingSupply) {
    throw new Error(
      `getTokenV8(${token}) decoded dexSupplyThresh=${dexSupplyThresh}, circulatingSupply=${circulatingSupply} — ` +
        `implausible, the flap struct layout may have changed. Refusing to trade rather than mis-size the graduation guard.`
    );
  }
  return { circulatingSupply, dexSupplyThresh };
}

// ── Provenance: is this token a genuine flap launch? ────────────────────────────────
// One eth_getCode: the token must be an EIP-1167 minimal-proxy CLONE of a flap
// tokenMaster. A decoy ERC-20 has its own bytecode (or proxies to some other impl) and
// is rejected before any approve is ever signed — the dusting/honeypot guard. Verbatim
// EIP-1167 shape from evm/v5/factory.js. The allowlist is STATIC (flap ships a single
// verified master), so there is no factory-derived module set and no TTL refresh.

const EIP1167_PREFIX = '363d3d373d3d3d363d73';
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3';

/** The implementation a minimal-proxy delegates to (checksummed), or null if not one. */
function proxyImplementation(code) {
  if (typeof code !== 'string') return null;
  const hex = code.toLowerCase().replace(/^0x/, '');
  if (hex.length !== 90 || !hex.startsWith(EIP1167_PREFIX) || !hex.endsWith(EIP1167_SUFFIX)) return null;
  return getAddress('0x' + hex.slice(20, 60));
}

// Normalise the configured masters, SKIPPING any malformed entry so a mis-checksummed
// env var can't throw. If EVERY entry is bad the set is empty and provenance rejects
// everything — fail-closed, never fail-open.
function normAddrs(list) {
  const out = [];
  for (const a of list || []) {
    try {
      out.push(getAddress(a).toLowerCase());
    } catch {
      /* skip a bad address rather than break v7 */
    }
  }
  return out;
}

let _masters = null;
function masters() {
  if (!_masters) _masters = new Set(normAddrs(config.flap.tokenMasters));
  return _masters;
}

/**
 * @returns {Promise<{ok:true,impl:string}|{ok:false,reason:string}>}
 */
async function verifyProvenanceByCode(token, deps = {}) {
  const rpc = rpcOf(deps);
  const code = await rpc.getCode(getAddress(token));
  const impl = proxyImplementation(code);
  if (!impl) {
    return { ok: false, reason: 'not an EIP-1167 clone of a flap tokenMaster (a decoy ERC-20 has its own bytecode)' };
  }
  if (!masters().has(impl.toLowerCase())) {
    return { ok: false, reason: `implementation ${impl} is not a flap tokenMaster (expected a clone of ${config.flap.tokenMasters.join(', ')})` };
  }
  return { ok: true, impl };
}

module.exports = {
  NATIVE,
  quoteSell,
  quoteBuy,
  buildBuyTx,
  buildSellTx,
  buildApproveTx,
  tokenState,
  quoteTokenOf,
  tokenCurve,
  proxyImplementation,
  verifyProvenanceByCode,
};
