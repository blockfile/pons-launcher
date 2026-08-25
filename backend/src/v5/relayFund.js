'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// v5 — RELAY-solver funding for the bundle wallets.
//
// Instead of the launcher transferring ETH straight to each bundle wallet (which
// leaves every bundle wallet sharing one obvious on-chain funder), each wallet is
// funded through a Relay.link SOLVER: the launcher deposits into a Relay-quoted
// deposit address, and whichever solver Relay picks delivers the exact amount to
// the bundle wallet. So the bundle wallet's on-chain funder is the solver, not the
// launcher — the shared-funder link is broken.
//
// Same chain in and out (origin == destination == config.chainId), exactly like
// the pons v2 relay path — the point here is solver obfuscation + timing, not a
// cross-chain hop. The pacing (one wallet at a time, an 8-9s gap between each) is
// owned by v5/relayFundJob.js; THIS file is the single-wallet money path it calls.
//
// It reuses the SHARED Relay HTTP primitives (relay/funding.js: quoteDeposit,
// depositStep, normaliseTx, publicFees/publicDetails) so the quote/deposit shape
// and the fee-refresh-at-send discipline stay in one place — but it sources from
// the v5dev launcher and validates against v5bundle wallets, per the tab-isolation
// rule (every tab owns its own money path).
// ─────────────────────────────────────────────────────────────────────────────

const { formatEther, getAddress, isAddress, parseEther } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { rpcMessage } = require('../evm/errors');
const { getFees, gasCost } = require('../evm/fees');
const { keystoreFor } = require('../wallets/keystore');
const v5roles = require('./roles');
const { quoteDeposit, depositStep, _private: relayPrivate } = require('../relay/funding');

// Same +50% headroom the shared relay path uses — Relay's quoted maxFeePerGas can
// go stale between quote and broadcast on this chain, so the fee ceiling is
// refreshed at send time.
const RELAY_FEE_BUMP_PCT = 50;

// A transient Relay refusal (a 429 "try again later", a gateway blip) is retried
// with a long backoff so the rate-limit window can refill; a specific error (bad
// address, unsupported route) is surfaced on the first try. The 8-9s job pacing
// already keeps requests well under the limit, so this is a safety net, not the
// primary pacing.
const RELAY_TRANSIENT_RE = /try again later|could not process|rate.?limit|too many|timeout|temporar|\b(?:429|502|503|504)\b/i;
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

async function withQuoteRetry(fn, { retries = 2, backoffMs, sleepFn = sleep } = {}) {
  const back = backoffMs ?? config.relayQuote429BackoffMs ?? 15_000;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === retries || !RELAY_TRANSIENT_RE.test(err?.message || '')) throw err;
      await sleepFn(back * (attempt + 1));
    }
  }
  throw lastErr;
}

/**
 * Resolve a { walletId | address, amountEth } target to a live v5bundle wallet +
 * a positive wei amount. Throws on anything that is not one of this tab's bundle
 * wallets or a non-positive amount — nothing is quoted or sent for a bad target.
 */
function resolveTarget(target, roles, ks) {
  const wallets = roles.bundle(ks);
  const byId = new Map(wallets.map((w) => [w.id, w]));
  const byAddr = new Map(wallets.map((w) => [getAddress(w.address), w]));
  const wallet =
    target.walletId != null
      ? byId.get(target.walletId)
      : target.address != null && isAddress(String(target.address))
        ? byAddr.get(getAddress(target.address))
        : null;
  if (!wallet) throw new Error(`${target.walletId ?? target.address} is not one of this tab's bundle wallets`);
  const amountWei = parseEther(String(target.amountEth ?? target.amount ?? '0').trim() || '0');
  if (amountWei <= 0n) throw new Error(`wallet ${wallet.id} needs a positive fund amount`);
  return { wallet, amountWei };
}

/**
 * Validate a whole targets[] list up front (before any job starts), so a bad
 * wallet id / zero amount / duplicate is rejected once, not mid-run. Returns the
 * normalised plan the job iterates.
 */
function planV5Targets(targets, ks) {
  if (!Array.isArray(targets) || !targets.length) throw new Error('targets[] is required');
  const roles = v5roles;
  if (!roles.dev(ks)) throw new Error('no v5dev launcher wallet — create one first');
  const seen = new Set();
  return targets.map((t) => {
    const { wallet, amountWei } = resolveTarget(t, roles, ks);
    if (seen.has(wallet.id)) throw new Error(`wallet ${wallet.id} is listed twice`);
    seen.add(wallet.id);
    return { walletId: wallet.id, address: getAddress(wallet.address), amountWei, amountEth: formatEther(amountWei) };
  });
}

/**
 * Fund ONE bundle wallet through a Relay solver, from the v5dev launcher.
 *
 * Quotes an EXACT_OUTPUT deposit (the shared quoteDeposit), verifies the deposit
 * comes FROM the launcher on THIS chain (depositStep's guards), checks the
 * launcher can cover deposit + gas, then sends the deposit at the launcher's
 * pending nonce with a refreshed fee ceiling. Returns the per-wallet result; on a
 * send failure it returns the entry with an `error` rather than throwing, so the
 * pacing job records it and moves on.
 *
 * @param {{walletId?:string,address?:string,amountEth:string|number}} target
 * @param {object} [deps] injectable for tests: { keystore, roles, provider, relayQuote, getFees, dryRun, sleepFn, retries }.
 */
async function fundOneViaRelay(target, deps = {}) {
  const ks = deps.keystore || keystoreFor();
  const roles = deps.roles || v5roles;
  const rpc = deps.provider || provider;
  const relayQuote = deps.relayQuote || quoteDeposit;
  const getFeesFn = deps.getFees || getFees;
  const dryRun = deps.dryRun ?? config.dryRun;

  const dev = roles.dev(ks);
  if (!dev) throw new Error('no v5dev launcher wallet — create one first');
  const { wallet, amountWei } = resolveTarget(target, roles, ks);

  const quote = await withQuoteRetry(
    () => relayQuote({ from: dev.address, recipient: wallet.address, amountWei, chainId: config.chainId }),
    { retries: deps.retries ?? 2, backoffMs: deps.backoffMs, sleepFn: deps.sleepFn }
  );
  const deposit = depositStep(quote, { expectedFrom: dev.address, expectedChainId: config.chainId });

  const fees = await getFeesFn(RELAY_FEE_BUMP_PCT);
  const depositValue = BigInt(deposit.tx.value);
  const gas = gasCost(fees, relayPrivate.gasLimitOf(deposit.tx));

  const base = {
    walletId: wallet.id,
    address: getAddress(wallet.address),
    amountEth: formatEther(amountWei),
    requestId: deposit.requestId,
    depositAddress: deposit.depositAddress,
    depositEth: formatEther(depositValue),
    fees: relayPrivate.publicFees(quote),
    details: relayPrivate.publicDetails(quote),
  };

  const balance = await rpc.getBalance(dev.address);
  if (balance < depositValue + gas) {
    throw new Error(
      `the launcher holds ${formatEther(balance)} ETH but this Relay deposit needs up to ` +
        `${formatEther(depositValue + gas)} (deposit + max gas) — fund the launcher first`
    );
  }

  if (dryRun) return { ...base, hash: null, simulated: true };

  // One deposit at a time (the pacing job calls this ~9s apart), signed at the
  // launcher's PENDING nonce so sequential deposits never collide on a nonce.
  const signer = ks.signer(dev.id, rpc);
  const nonce = await rpc.getTransactionCount(dev.address, 'pending');
  try {
    const sent = await signer.sendTransaction(relayPrivate.normaliseTx(deposit.tx, nonce, fees));
    return { ...base, hash: sent.hash };
  } catch (err) {
    return { ...base, error: rpcMessage(err) };
  }
}

module.exports = {
  planV5Targets,
  fundOneViaRelay,
  resolveTarget,
  RELAY_FEE_BUMP_PCT,
  RELAY_TRANSIENT_RE,
};
