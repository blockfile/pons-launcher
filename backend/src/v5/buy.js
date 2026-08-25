'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// v5 — per-wallet BUY money path (the V1-style bundle).
//
// Instead of the untaxed fan-out (v5/bundle.js — the launcher's first-buy supply
// TRANSFERRED to the bundle wallets), this makes each bundle wallet BUY the token
// from the pool itself, exactly as the pons v1 bundle does. On letscash that buy
// pays the CashCat hook's anti-snipe tax, which decays from the launch premium to
// the base rate over the config's window — so unlike v1 there is NO launch-block
// race here: the operator funds the wallets and fires the buys WHEN THEY CHOOSE,
// typically after the tax has stabilised at base. The preflight quote reflects the
// tax as it stands right now, so the cost of buying early vs. waiting is visible.
//
// Mirrors v5/sell.js's discipline (sign-at-preflight, broadcast-at-fire, pinned
// pool hook, per-wallet settled-nonce skip) but is simpler: an ETH buy is a SINGLE
// tx per wallet — the ETH rides as msg.value, so there are no Permit2 approvals
// (those are only for pulling an ERC-20 in). It builds on the already fund-safe
// swap client (resolvePoolKey / quoteBuy / buildBuyTx).
// ─────────────────────────────────────────────────────────────────────────────

const { formatEther, formatUnits, getAddress, isAddress, parseEther } = require('ethers');
const config = require('../config');
const { provider, warmPool } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { waitForReceipt } = require('../evm/receipt');
const { keystoreFor } = require('../wallets/keystore');
const { getDecimals, getSymbol } = require('../evm/erc20');
const swap = require('../evm/v5/swap');
const v5roles = require('./roles');

// A V4 execute() buy — settle the native input, take the token out, and the hook's
// tax skim on top. Fixed cap (unused gas refunded); generous for the hooked swap.
const BUY_GAS = 500_000n;
const DEADLINE_SECONDS = 3600;
const FEE_BUMP_PCT = 25;
// Default slippage floor on a bundle buy — a buy MUST carry a positive floor
// (buildBuyTx refuses minOut 0). This is NOT just preflight→broadcast drift: the
// bundle wallets all buy the SAME pool in the same/adjacent blocks, so each buy is
// quoted at the pre-bundle price but executes after the ones ahead of it have
// already pushed the price up — the ones that land later get fewer tokens than
// their quote and, with a tight floor, REVERT (1 buys, the rest revert). The
// floor therefore has to absorb the bundle's OWN cumulative price impact, which is
// self-inflicted and expected. 30% by default so a normal bundle into a fresh pool
// goes through; raise it (or use the untaxed fan-out) for a very thin pool, lower
// it for a single buy. The operator can always override via slippageBps.
const DEFAULT_SLIPPAGE_BPS = 3000;

function toSignable({ to, data, value = 0n }, { nonce, gasLimit, fees, chainId }) {
  return { to, data, value: BigInt(value), nonce, gasLimit, chainId, ...fees };
}
function stringifyFees(fees) {
  return Object.fromEntries(
    Object.entries(fees).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v])
  );
}

/**
 * Build a signed ETH→token buy for every bundle wallet that has a buy amount.
 *
 * @param {object} input
 * @param {string} input.token          the launched ERC-20 to buy.
 * @param {string} [input.hook]         the launch receipt's pool hook (route pins it).
 * @param {Array}  input.buys           [{ walletId|address, amountEth }] per-wallet ETH buy sizes.
 * @param {number} [input.slippageBps]  buy floor (default 100 = 1%).
 * @param {object} [deps]               injectable for tests.
 * @returns {Promise<object>} a plan whose buys[].raw are signed. Broadcast NOTHING.
 */
async function prepareBundleBuys(input, deps = {}) {
  const ks = deps.keystore || keystoreFor();
  const roles = deps.roles || v5roles;
  const prov = deps.provider || provider;
  const swapClient = deps.swap || swap;
  const getFeesFn = deps.getFees || getFees;
  const decimalsOf = deps.getDecimals || getDecimals;
  const symbolOf = deps.getSymbol || getSymbol;
  const dryRun = deps.dryRun ?? config.dryRun;

  const { token, quote = 'eth', hook, buys, slippageBps = DEFAULT_SLIPPAGE_BPS } = input || {};
  if (!token || !isAddress(String(token))) throw new Error('token must be the launched ERC-20 address');
  const tokenAddr = getAddress(token);

  // The buy gas cap is a fixed 500k, but a caller can raise it — the one lever if
  // 500k ever proved too low for a pool (which would otherwise re-OOG on every
  // retry). Bounded, and never below the safe floor. Mirrors the sell's sellGas.
  const buyGasLimit = (() => {
    if (input.buyGas == null) return BUY_GAS;
    const g = BigInt(input.buyGas);
    if (g < BUY_GAS) return BUY_GAS;
    if (g > 3_000_000n) throw new Error('buyGas override is capped at 3,000,000');
    return g;
  })();

  // ETH-only for now — a USDG-quoted buy pulls USDG via Permit2 (like the sell's
  // input side) and needs the two approvals; that is a later pass.
  const q = String(quote).toLowerCase();
  const isNativeQuote = q === 'eth' || q === 'native' || q === '0x0000000000000000000000000000000000000000';
  if (!isNativeQuote) throw new Error('per-wallet buys are ETH-only for now — a USDG buy needs Permit2 approvals');

  // Pin the pool to the launch receipt's hook (decoy-pool guard, same as the sell).
  if (!hook || !isAddress(String(hook))) {
    throw new Error('a verified pool hook is required (from the launch receipt) — the buy must target the exact pool');
  }
  const hookAddr = getAddress(hook);

  const wallets = roles.bundle(ks);
  if (!wallets.length) throw new Error('no v5bundle wallets to buy from — generate or fund some first');

  // Resolve the pool. Prefer the AUTHORITATIVE pool the caller hands in (the
  // combined Launch + bundle passes the launch receipt's Initialize event: exact
  // poolId + full key with the config's REAL fee/tickSpacing). Using it directly
  // avoids two failure modes that wrongly skipped a fresh launch's bundle: (1)
  // re-deriving the poolId from a hardcoded fee/tickSpacing, which is wrong for any
  // config whose tickSpacing isn't the default → "no pool"; and (2) the StateView
  // liquidity/price probe missing a just-seeded pool a load-balanced RPC hasn't
  // caught up on. The receipt already PROVES the pool exists, so no probe is needed.
  let resolved;
  if (input.poolKey && input.poolId) {
    const pk = input.poolKey;
    resolved = {
      poolKey: {
        currency0: getAddress(pk.currency0),
        currency1: getAddress(pk.currency1),
        fee: Number(pk.fee),
        tickSpacing: Number(pk.tickSpacing),
        hooks: getAddress(pk.hooks),
      },
      poolId: input.poolId,
      hook: getAddress(pk.hooks),
    };
  } else {
    // No receipt pool (a plain manual buy). Resolve against the chain, and retry a
    // few times for the "still propagating right after a launch" case. Tunable/
    // injectable so a settled-pool buy and the offline tests don't wait.
    const sleep = deps.sleep || ((ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()));
    const poolTries = input.poolWaitTries != null ? Number(input.poolWaitTries) : 5;
    const poolDelayMs = input.poolWaitMs != null ? Number(input.poolWaitMs) : 2000;
    for (let attempt = 0; ; attempt += 1) {
      try {
        resolved = await swapClient.resolvePoolKey({ token: tokenAddr, quote, hook: hookAddr }, { provider: prov });
        break;
      } catch (err) {
        if (attempt >= poolTries) throw err;
        await sleep(poolDelayMs);
      }
    }
  }
  const [decimals, symbol] = await Promise.all([decimalsOf(tokenAddr), symbolOf(tokenAddr)]);

  // Match each requested buy to its bundle wallet (by id or address); drop zeros.
  const byId = new Map(wallets.map((w) => [w.id, w]));
  const byAddr = new Map(wallets.map((w) => [getAddress(w.address), w]));
  const requested = [];
  const seen = new Set();
  for (const b of Array.isArray(buys) ? buys : []) {
    const wallet = b.walletId != null ? byId.get(b.walletId) : b.address != null ? byAddr.get(getAddress(b.address)) : null;
    if (!wallet) throw new Error(`buys names "${b.walletId ?? b.address}", not one of this tab's bundle wallets`);
    if (seen.has(wallet.id)) throw new Error(`buys names wallet ${wallet.id} more than once`);
    seen.add(wallet.id);
    // 'all' spends the wallet's whole balance minus a gas reserve — its amount is
    // resolved from the LIVE balance in the loop below, not from the request (the
    // "all − gas" mode the v1 wallets table offers). 'fixed' (the default) takes
    // the typed ETH amount as now.
    if (String(b.mode || '').toLowerCase() === 'all') {
      requested.push({ wallet, mode: 'all' });
    } else {
      const amountWei = parseEther(String(b.amountEth ?? b.amount ?? '0').trim() || '0');
      if (amountWei < 0n) throw new Error(`a negative buy for ${wallet.address} makes no sense`);
      if (amountWei > 0n) requested.push({ wallet, mode: 'fixed', amountWei });
    }
  }
  if (!requested.length) throw new Error('no wallet has a positive buy amount — set at least one');

  const fees = deps.fees || (await getFeesFn(FEE_BUMP_PCT));
  const chainId = BigInt(deps.chainId ?? config.chainId);
  const gasReserve = gasCost(fees, buyGasLimit);
  const nowSec = deps.nowMs != null ? Math.floor(deps.nowMs / 1000) : Math.floor(Date.now() / 1000);
  const deadline = deps.deadline ?? nowSec + DEADLINE_SECONDS;

  const out = [];
  const skipped = [];
  const warnings = [];
  for (const req of requested) {
    const wallet = req.wallet;
    const balance = await prov.getBalance(wallet.address);
    // Resolve 'all − gas' from the live balance; a 'fixed' buy uses its typed
    // amount and must leave the gas reserve behind. Either way `amountWei` is
    // what the quote and the signed value are built from below.
    let amountWei;
    if (req.mode === 'all') {
      amountWei = balance - gasReserve;
      if (amountWei <= 0n) {
        const why = `holds ${formatEther(balance)} ETH — too little to buy anything after the ${formatEther(gasReserve)} gas reserve`;
        skipped.push({ walletId: wallet.id, address: wallet.address, reason: why });
        warnings.push(`${wallet.address}: ${why}`);
        continue;
      }
    } else {
      amountWei = req.amountWei;
      if (balance < amountWei + gasReserve) {
        const why = `holds ${formatEther(balance)} ETH but the buy + gas needs ${formatEther(amountWei + gasReserve)} — fund it first`;
        skipped.push({ walletId: wallet.id, address: wallet.address, reason: why });
        warnings.push(`${wallet.address}: ${why}`);
        continue;
      }
    }

    // Quote the buy — this is where the CURRENT anti-snipe tax shows up: a buy made
    // while the premium is high returns fewer tokens than the same ETH after decay.
    let expectedOut;
    let minOut;
    try {
      const qres = await swapClient.quoteBuy(
        { token: tokenAddr, quote, amountInWei: amountWei, slippageBps, hook: hookAddr, poolKey: resolved.poolKey },
        { provider: prov }
      );
      expectedOut = qres.expectedOut;
      minOut = qres.minOut;
    } catch (_err) {
      const why = 'could not quote the buy (is the pool live and past launch?) — skipped';
      skipped.push({ walletId: wallet.id, address: wallet.address, reason: why });
      warnings.push(`${wallet.address}: ${why}`);
      continue;
    }
    if (expectedOut == null || expectedOut <= 0n || minOut == null || minOut <= 0n) {
      // buildBuyTx refuses a non-positive floor, and a buy with no price protection
      // is exactly what we must not sign.
      const why = 'the quote returned no output — refusing a buy with no price floor';
      skipped.push({ walletId: wallet.id, address: wallet.address, reason: why });
      warnings.push(`${wallet.address}: ${why}`);
      continue;
    }

    // Per-wallet settled-nonce skip (mirror the sell): never sign a buy past an
    // unconfirmed tx that could be evicted and strand it.
    const [pendingNonce, latestNonce] = await Promise.all([
      prov.getTransactionCount(wallet.address, 'pending'),
      prov.getTransactionCount(wallet.address, 'latest'),
    ]);
    if (pendingNonce > latestNonce) {
      const why = 'has an unconfirmed tx in flight — its buy is skipped until it settles (re-run then)';
      skipped.push({ walletId: wallet.id, address: wallet.address, reason: why });
      warnings.push(`${wallet.address}: ${why}`);
      continue;
    }

    const tx = swapClient.buildBuyTx(
      { token: tokenAddr, quote, amountInWei: amountWei, minOut, recipient: wallet.address, deadline, poolKey: resolved.poolKey },
      { provider: prov }
    );
    const signer = ks.signer(wallet.id, prov);
    const raw = await signer.signTransaction(
      toSignable({ to: tx.to, data: tx.data, value: tx.value }, { nonce: pendingNonce, gasLimit: buyGasLimit, fees, chainId })
    );

    out.push({
      walletId: wallet.id,
      address: wallet.address,
      ethIn: formatEther(amountWei),
      ethInWei: amountWei.toString(),
      expectedTokens: formatUnits(expectedOut, decimals),
      expectedTokensWei: expectedOut.toString(),
      minOut: minOut.toString(),
      nonce: pendingNonce,
      raw, // SIGNED — the route strips this before the plan leaves the server
    });
  }

  if (!out.length) {
    throw new Error(
      `no wallet could be prepared to buy — every one was skipped (too short of ETH, no live pool quote, ` +
        `or a tx in flight). Reasons: ${skipped.map((s) => `${s.address} (${s.reason})`).join('; ')}`
    );
  }

  const totalEth = out.reduce((s, w) => s + BigInt(w.ethInWei), 0n);
  const totalTokens = out.reduce((s, w) => s + BigInt(w.expectedTokensWei), 0n);
  return {
    protocol: 'v5',
    kind: 'bundle-buy',
    token: tokenAddr,
    symbol,
    decimals,
    hook: resolved.hook,
    poolId: resolved.poolId,
    quote: 'eth',
    slippageBps,
    walletCount: out.length,
    totalEth: formatEther(totalEth),
    totalExpectedTokens: formatUnits(totalTokens, decimals),
    buys: out,
    skipped,
    fees: stringifyFees(fees),
    buyGas: buyGasLimit.toString(),
    chainId: chainId.toString(),
    dryRun,
    warnings,
  };
}

/**
 * Broadcast the pre-signed buys. They are INDEPENDENT — each wallet buys with its
 * own ETH, one tx, no cross-wallet ordering — so they go out together and one
 * wallet's failure strands nothing but its own buy.
 *
 * @param {object} plan   from prepareBundleBuys (buys[].raw are signed).
 * @param {object} [deps] injectable: { provider, waitForReceipt, warmPool, dryRun }.
 * @returns {Promise<object>} { token, symbol, bought, failed, pending, buys:[{address, status, hash}] }
 */
async function fireBundleBuys(plan, deps = {}) {
  const rpc = deps.provider || provider;
  const dryRun = deps.dryRun ?? config.dryRun;
  const awaitReceipt = deps.waitForReceipt || waitForReceipt;
  const warm = deps.warmPool || warmPool;

  if (!plan || plan.kind !== 'bundle-buy' || !Array.isArray(plan.buys)) {
    throw new Error('not a v5 bundle-buy plan — re-run preflight');
  }
  if (dryRun) {
    return {
      simulated: true,
      protocol: 'v5',
      kind: 'bundle-buy',
      token: plan.token,
      symbol: plan.symbol,
      bought: 0,
      failed: 0,
      pending: 0,
      buys: plan.buys.map((b) => ({ address: b.address, ethIn: b.ethIn, status: 'simulated', hash: null })),
    };
  }
  if (plan.buys.some((b) => !b.raw)) throw new Error('plan has unsigned buys — re-run preflight');

  await warm(Math.min(plan.buys.length, 6), rpc);

  // Independent wallets — broadcast concurrently.
  const results = await Promise.all(
    plan.buys.map(async (b) => {
      const r = { walletId: b.walletId, address: b.address, ethIn: b.ethIn, hash: null, status: 'broadcast' };
      try {
        const resp = await rpc.broadcastTransaction(b.raw);
        r.hash = resp.hash;
      } catch (err) {
        r.status = 'send-failed';
        r.error = err.message;
      }
      return r;
    })
  );

  await Promise.all(
    results.map(async (r) => {
      if (!r.hash) return;
      let receipt = null;
      try {
        receipt = await awaitReceipt(rpc, r.hash);
      } catch (_err) {
        receipt = null;
      }
      r.status = !receipt ? 'pending' : receipt.status === 1 ? 'confirmed' : 'reverted';
      r.blockNumber = receipt?.blockNumber ?? null;
    })
  );

  const bought = results.filter((r) => r.status === 'confirmed').length;
  const failed = results.filter((r) => r.status === 'reverted' || r.status === 'send-failed').length;
  const pending = results.filter((r) => r.status === 'pending').length;
  return {
    protocol: 'v5',
    kind: 'bundle-buy',
    token: plan.token,
    symbol: plan.symbol,
    bought,
    failed,
    pending,
    buys: results,
  };
}

module.exports = {
  prepareBundleBuys,
  fireBundleBuys,
  toSignable,
  BUY_GAS,
  DEFAULT_SLIPPAGE_BPS,
  FEE_BUMP_PCT,
};
