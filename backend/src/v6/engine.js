'use strict';

/**
 * The V6 relay chain: one big buy on a letscash V4 pool, then a cycle per bundle
 * wallet of
 *
 *   sell a slice of the position → Relay the proceeds to the next wallet → it buys
 *
 * roughly seven seconds apart, until every wallet has bought. This is v3's engine,
 * unchanged in shape and every safety decision — the venue is the only difference:
 * a letscash Uniswap-V4 pool (v6/trade.js) instead of a pons v2 bonding curve, and
 * so slices are sized in TOKENS and each sale's proceeds are read from the chain
 * rather than inverted from a curve formula (see v6/sizing.js).
 *
 * WHY THE TIMER LIVES ON THE SERVER, why the interval is a FLOOR not a clock, why a
 * FAILURE HALTS AND KEEPS STATE, and why RESUME PICKS UP AT THE STEP THAT FAILED
 * (via per-cycle done-flags, so a completed sell+transfer is never re-run and the
 * position never sold twice) — all identical to v3/engine.js; read its header for
 * the reasoning. A restart still loses the in-memory job; nothing is ever left
 * pending (each step awaits its own receipt), so a lost job is a stopped run whose
 * every effect is already on chain.
 */

const { randomUUID } = require('crypto');
const { formatEther, parseEther } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const v6roles = require('./roles');
const defaultTrade = require('./trade');
const defaultRelay = require('./relay');
const defaultSizing = require('./sizing');

const DEFAULT_INTERVAL_MS = 7_000;
const MIN_INTERVAL_MS = 3_000;
const MAX_INTERVAL_MS = 600_000;

const DEFAULT_JITTER_PCT = 0;
const MAX_JITTER_PCT = 50;

const FILL_POLL_MS = 1_500;
const FILL_TIMEOUT_MS = 90_000;

// A deposit to a Relay deposit address is a plain value send; 50k is generous and
// only decides how much a cycle keeps back for its own next deposit's gas.
const RELAY_DEPOSIT_GAS = 50_000n;

// Held back from each transfer for Relay's own fee (charged on the sender's side of
// an EXACT_OUTPUT order, and not known until the quote comes back). Unspent ETH stays
// in the main wallet and comes out at the exit.
const RELAY_FEE_PCT = 3;

const FEE_BUMP_PCT = 25;

const READ_RETRIES = 3;
const READ_BACKOFF_MS = 800;

/**
 * The gas a cycle reserves. Pure + module-level so the plan's feasibility check sizes
 * against the EXACT figures the engine uses. mainGas covers the main wallet's THREE
 * sell txs (two Permit2 approvals + the execute) plus its next Relay deposit — a V4
 * sell is heavier than v3's two-tx curve sell.
 */
function gasFigures(fees) {
  return {
    buyGas: gasCost(fees, defaultTrade.BUY_GAS),
    buffer: parseEther(String(config.gasBufferEth)),
    mainGas: gasCost(
      fees,
      defaultTrade.ERC20_APPROVE_GAS + defaultTrade.PERMIT2_APPROVE_GAS + defaultTrade.SELL_GAS + RELAY_DEPOSIT_GAS
    ),
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function errorMessage(err) {
  return err?.shortMessage || err?.reason || err?.message || String(err);
}

function publicCycle(c) {
  return {
    index: c.index,
    kind: c.kind,
    state: c.state,
    step: c.step || null,
    walletId: c.walletId || null,
    address: c.address || null,
    buyEth: c.buyWei == null ? null : formatEther(c.buyWei),
    finalSlice: Boolean(c.finalSlice),
    tokensSold: c.tokensSold == null ? null : c.tokensSold.toString(),
    ethRaised: c.ethRaised == null ? null : formatEther(c.ethRaised),
    transferredEth: c.transferredWei == null ? null : formatEther(c.transferredWei),
    tokensOut: c.tokensOut == null ? null : c.tokensOut.toString(),
    sellHash: c.sellHash || null,
    requestId: c.requestId || null,
    depositAddress: c.depositAddress || null,
    buyHash: c.buyHash || null,
    error: c.error || null,
    startedAt: c.startedAt || null,
    finishedAt: c.finishedAt || null,
  };
}

function publicJob(job) {
  if (!job) return { protocol: 'v6', mode: 'relay-chain', status: 'idle', running: false, cycles: [] };

  const cycles = job.cycles.map(publicCycle);
  const done = cycles.filter((c) => c.kind === 'cycle' && c.state === 'done').length;

  return {
    id: job.id,
    userId: job.userId,
    protocol: 'v6',
    mode: 'relay-chain',
    status: job.status,
    running: job.status === 'running',
    inFlight: job.inFlight,
    token: job.token,
    poolId: job.pool?.poolId || null,
    hook: job.pool?.hook || null,
    symbol: job.symbol,
    bigBuyEth: formatEther(job.bigBuyWei),
    buySlippageBps: job.buySlippageBps,
    intervalMs: job.intervalMs,
    jitterPct: job.jitterPct,
    variancePct: job.variancePct,
    currentIndex: job.currentIndex,
    total: job.targets.length,
    completed: done,
    remaining: Math.max(0, job.targets.length - done),
    failed: cycles.filter((c) => c.state === 'failed').length,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    stoppedAt: job.stoppedAt || null,
    completedAt: job.completedAt || null,
    nextRunAt: job.nextRunAt || null,
    failure: job.failure || null,
    targets: job.targets.map((t, i) => ({ index: i + 1, walletId: t.walletId, address: t.address })),
    cycles,
  };
}

function createEngine(deps = {}) {
  const jobs = new Map();

  const setTimeoutFn = deps.setTimeoutFn || setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn || clearTimeout;
  const nowFn = deps.nowFn || Date.now;
  const idFn = deps.idFn || randomUUID;
  const randomFn = deps.randomFn || Math.random;
  const sleepFn = deps.sleepFn || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const keystoreForFn = deps.keystoreForFn || keystoreFor;
  const activityForFn = deps.activityForFn || activityFor;
  const rpc = deps.rpc || provider;
  const getFeesFn = deps.getFeesFn || getFees;
  const trade = deps.trade || defaultTrade;
  const relay = deps.relay || defaultRelay;
  const sizing = deps.sizing || defaultSizing;
  const fillPollMs = deps.fillPollMs ?? FILL_POLL_MS;
  const fillTimeoutMs = deps.fillTimeoutMs ?? FILL_TIMEOUT_MS;
  const tradeDeps = deps.tradeDeps || {};

  function log(userId, summary, detail = {}) {
    activityForFn(userId).record('v6', summary, detail);
  }

  function clear(job) {
    if (job?.timer) clearTimeoutFn(job.timer);
    if (job) job.timer = null;
  }

  /** interval ± jitterPct, uniform. Exactly interval when jitter is off. */
  function intervalFor(job) {
    if (!job.jitterPct) return job.intervalMs;
    const swing = (job.intervalMs * job.jitterPct) / 100;
    return Math.max(0, Math.round(job.intervalMs + swing * (randomFn() * 2 - 1)));
  }

  function schedule(job, delayMs) {
    clear(job);
    if (job.status !== 'running') return;
    job.nextRunAt = iso(nowFn() + delayMs);
    job.updatedAt = iso(nowFn());
    job.timer = setTimeoutFn(async () => {
      job.timer = null;
      try {
        await runNext(job.userId);
      } catch (err) {
        job.status = 'failed';
        job.inFlight = false;
        job.nextRunAt = null;
        job.failure = { index: job.currentIndex, step: 'engine', walletId: null, error: errorMessage(err) };
        job.updatedAt = iso(nowFn());
        log(job.userId, `[v6] run halted — ${errorMessage(err)}`, { jobId: job.id, error: errorMessage(err) });
      }
    }, delayMs);
    if (typeof job.timer?.unref === 'function') job.timer.unref();
  }

  /** The record for a unit of work, reused on resume so its done-flags survive. */
  function recordFor(job, index) {
    let found = job.cycles.find((c) => c.index === index);
    if (!found) {
      const target = index === 0 ? null : job.targets[index - 1];
      found = {
        index,
        kind: index === 0 ? 'big-buy' : 'cycle',
        walletId: target?.walletId ?? null,
        address: target?.address ?? null,
        buyWei: target?.buyWei ?? null,
        state: 'pending',
        step: null,
      };
      job.cycles.push(found);
    }
    found.error = null;
    found.startedAt = found.startedAt || iso(nowFn());
    return found;
  }

  async function gasFor() {
    const fees = await getFeesFn(FEE_BUMP_PCT);
    return { fees, ...gasFigures(fees) };
  }

  /** Retry an IDEMPOTENT read (fees, balance) through a transient blip. NEVER wraps
   *  a broadcast (sell/deposit/buy) or the fill wait — those halt for a checked,
   *  manual resume, because a failure there may have actually landed. */
  async function retryRead(fn) {
    let lastErr;
    for (let attempt = 1; attempt <= READ_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < READ_RETRIES) await sleepFn(READ_BACKOFF_MS * attempt);
      }
    }
    throw lastErr;
  }

  async function waitForFill(record, address, needWei) {
    const maxAttempts = Math.max(1, Math.ceil(fillTimeoutMs / fillPollMs));
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const balance = BigInt(await rpc.getBalance(address));
      if (balance >= needWei) return balance;
      await sleepFn(fillPollMs);
    }
    throw new Error(
      `the Relay fill for ${address} did not arrive within ${Math.round(fillTimeoutMs / 1000)}s ` +
        `(request ${record.requestId || 'unknown'}) — the deposit was sent, so check the order before retrying`
    );
  }

  async function runBigBuy(job, record) {
    record.step = 'big-buy';
    record.state = 'buying';

    const ks = keystoreForFn(job.userId);
    const main = v6roles.main(ks);
    const out = await trade.buy(
      { wallet: main, token: job.token, quote: 'eth', pool: job.pool, amountWei: job.bigBuyWei, slippageBps: job.buySlippageBps },
      { ...tradeDeps, keystore: ks, rpc }
    );
    if (out.status === 'reverted') throw new Error('the big buy reverted');

    record.buyHash = out.hash;
    record.tokensOut = out.tokensOut;
    log(job.userId, `[v6] big buy of ${formatEther(job.bigBuyWei)} ETH from the main wallet`, {
      jobId: job.id,
      token: job.token,
      hash: out.hash,
      tokensOut: out.tokensOut?.toString?.() ?? null,
    });
  }

  async function runCycle(job, index, record) {
    const target = job.targets[index - 1];
    const ks = keystoreForFn(job.userId);
    const main = v6roles.main(ks);
    const wallet = v6roles.bundle(ks).find((w) => w.id === target.walletId);
    if (!wallet) throw new Error(`wallet ${target.walletId} is no longer a v6 bundle wallet`);

    const { buyGas, buffer, mainGas } = await retryRead(gasFor);

    // Wallets still to be served, including this one — the divisor the slice is drawn
    // against. Recomputed every cycle so the position lands on zero when they run out.
    const remainingWallets = job.targets.length - (index - 1);

    // ── sell ──────────────────────────────────────────────────────────────────
    if (!record.sellDone) {
      record.step = 'selling';
      record.state = 'selling';

      const balance = await retryRead(() => trade.tokenBalance(job.token, main.address, { ...tradeDeps, rpc }));
      if (balance <= 0n) {
        throw new Error(
          'the main wallet holds none of this token — the position is already gone, so there is ' +
            'nothing left to distribute'
        );
      }

      // Size the slice in TOKENS (v6 cannot invert a V4 pool offline). The last
      // wallet takes the whole remaining balance so the position ends on zero —
      // sliceTokens returns the full balance when remainingWallets === 1.
      let tokensIn = sizing.sliceTokens({
        tokenBalance: balance,
        remainingWallets,
        variancePct: job.variancePct,
        roll: randomFn(),
      });
      if (tokensIn > balance) tokensIn = balance;
      record.finalSlice = remainingWallets <= 1;

      const sold = await trade.sell(
        { wallet: main, token: job.token, quote: 'eth', pool: job.pool, tokensIn },
        { ...tradeDeps, keystore: ks, rpc }
      );
      if (sold.status === 'reverted') throw new Error('the sell reverted');

      record.tokensSold = tokensIn;
      record.ethRaised = sold.ethReceived;
      record.sellHash = sold.sellHash;
      record.sellDone = true;
      log(
        job.userId,
        `[v6] cycle ${index}/${job.targets.length}: sold ${
          record.finalSlice ? 'the remaining position' : 'a slice'
        } for ${formatEther(sold.ethReceived)} ETH`,
        { jobId: job.id, walletId: target.walletId, tokensIn: tokensIn.toString(), remainingWallets, hash: sold.sellHash }
      );
    }

    // ── transfer ────────────────────────────────────────────────────────────────
    // Sized from what the sell ACTUALLY raised, never the estimate. The main wallet
    // keeps back its own next round of gas and a small Relay-fee allowance.
    if (!record.transferDone) {
      record.step = 'transferring';
      record.state = 'transferring';

      const spendable = record.ethRaised - mainGas;
      if (spendable <= 0n) {
        throw new Error(
          `this cycle raised ${formatEther(record.ethRaised)} ETH, which does not cover the ` +
            `${formatEther(mainGas)} ETH of gas the next one needs — the slices have become too small to continue`
        );
      }

      const transferWei = (spendable * BigInt(100 - RELAY_FEE_PCT)) / 100n;
      if (transferWei <= buyGas + buffer) {
        throw new Error(
          `this cycle would fund ${target.address} with ${formatEther(transferWei)} ETH, which is ` +
            'not enough to pay for a buy — the position is too small to divide further'
        );
      }

      const sent = await relay.transfer(
        { fromWallet: main, toAddress: target.address, amountWei: transferWei },
        { ...tradeDeps, keystore: ks, rpc }
      );

      record.requestId = sent.requestId;
      record.depositAddress = sent.depositAddress;
      record.transferredWei = transferWei;
      record.transferDone = true;
      log(
        job.userId,
        `[v6] cycle ${index}/${job.targets.length}: transferred ${formatEther(transferWei)} ETH to ${target.address}`,
        { jobId: job.id, walletId: target.walletId, requestId: sent.requestId, hash: sent.hash }
      );
    }

    // ── wait for the fill ─────────────────────────────────────────────────────
    if (!record.fillDone) {
      record.step = 'waiting-fill';
      record.state = 'waiting-fill';
      await waitForFill(record, target.address, (record.transferredWei * 99n) / 100n);
      record.fillDone = true;
    }

    // ── buy ───────────────────────────────────────────────────────────────────
    if (!record.buyDone) {
      record.step = 'buying';
      record.state = 'buying';

      const balance = BigInt(await rpc.getBalance(target.address));
      const spend = balance - buyGas - buffer;
      if (spend <= 0n) {
        throw new Error(`${target.address} holds ${formatEther(balance)} ETH, which does not cover the gas to buy with`);
      }

      const out = await trade.buy(
        { wallet, token: job.token, quote: 'eth', pool: job.pool, amountWei: spend, slippageBps: job.buySlippageBps },
        { ...tradeDeps, keystore: ks, rpc }
      );
      if (out.status === 'reverted') throw new Error('the buy reverted');

      record.buyWei = spend;
      record.buyHash = out.hash;
      record.tokensOut = out.tokensOut;
      record.buyDone = true;
      log(
        job.userId,
        `[v6] cycle ${index}/${job.targets.length}: ${target.address} bought with ${formatEther(spend)} ETH`,
        { jobId: job.id, walletId: target.walletId, hash: out.hash }
      );
    }
  }

  function complete(job) {
    job.status = 'complete';
    job.completedAt = iso(nowFn());
    job.updatedAt = job.completedAt;
    job.nextRunAt = null;
    clear(job);
    log(job.userId, `[v6] run complete — ${job.targets.length} wallet(s) bought`, {
      jobId: job.id,
      token: job.token,
      total: job.targets.length,
    });
    return publicJob(job);
  }

  async function runNext(userId) {
    const job = jobs.get(userId);
    if (!job || job.status !== 'running' || job.inFlight) return publicJob(job);
    if (job.currentIndex > job.targets.length) return complete(job);

    const index = job.currentIndex;
    const startedMs = nowFn();
    const record = recordFor(job, index);

    job.inFlight = true;
    job.updatedAt = iso(nowFn());

    try {
      if (index === 0) await runBigBuy(job, record);
      else await runCycle(job, index, record);

      record.state = 'done';
      record.step = null;
      record.finishedAt = iso(nowFn());
      job.currentIndex = index + 1;
    } catch (err) {
      record.state = 'failed';
      record.error = errorMessage(err);
      record.finishedAt = iso(nowFn());
      job.status = 'failed';
      job.nextRunAt = null;
      job.failure = {
        index,
        step: record.step || record.kind,
        walletId: record.walletId,
        address: record.address,
        error: errorMessage(err),
      };
      job.updatedAt = iso(nowFn());
      job.inFlight = false;
      clear(job);
      log(job.userId, `[v6] run halted at ${record.step || record.kind}: ${errorMessage(err)}`, {
        jobId: job.id,
        index,
        walletId: record.walletId,
        step: record.step,
        error: errorMessage(err),
      });
      return publicJob(job);
    }

    job.inFlight = false;
    job.updatedAt = iso(nowFn());

    if (job.status !== 'running') return publicJob(job);
    if (job.currentIndex > job.targets.length) return complete(job);

    const elapsed = nowFn() - startedMs;
    schedule(job, Math.max(0, intervalFor(job) - elapsed));
    return publicJob(job);
  }

  /**
   * Validate and begin. The chain-state refusals — is the pool live, does this
   * account own the token — belong to the ROUTE, which resolves and verifies the
   * pool (v6/trade.readPool) before calling here. This checks the run's own shape.
   */
  async function start(userId, input = {}) {
    const existing = jobs.get(userId);
    if (existing?.status === 'running') throw new Error('a v6 chain run is already running');

    const { token, pool, symbol = null, bigBuyWei, targets = [] } = input;
    if (!token || !pool || !pool.poolKey || !pool.poolId) {
      throw new Error('token and a resolved pool { poolKey, poolId, hook } are required');
    }

    const bigBuy = BigInt(bigBuyWei ?? 0);
    if (bigBuy <= 0n) throw new Error('the big buy must be a positive amount');

    if (!Array.isArray(targets) || !targets.length) throw new Error('at least one bundle wallet is required');
    const seen = new Set();
    const planned = targets.map((t) => {
      if (seen.has(t.walletId)) throw new Error(`wallet ${t.walletId} is listed twice`);
      seen.add(t.walletId);
      if (!t.address) throw new Error(`wallet ${t.walletId} has no address`);
      return { walletId: t.walletId, address: t.address };
    });

    const intervalMs = Number(input.intervalMs ?? DEFAULT_INTERVAL_MS);
    if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
      throw new Error(`the interval must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS} ms`);
    }
    const jitterPct = Number(input.jitterPct ?? DEFAULT_JITTER_PCT);
    if (!Number.isFinite(jitterPct) || jitterPct < 0 || jitterPct > MAX_JITTER_PCT) {
      throw new Error(`jitter must be between 0 and ${MAX_JITTER_PCT} percent`);
    }
    const variancePct = Number(input.variancePct ?? sizing.DEFAULT_VARIANCE_PCT);
    if (!Number.isFinite(variancePct) || variancePct < 0 || variancePct > sizing.MAX_VARIANCE_PCT) {
      throw new Error(`variance must be between 0 and ${sizing.MAX_VARIANCE_PCT} percent`);
    }
    // The BUY floor (letscash buys require a positive one). Bounded like the bundle's.
    const buySlippageBps = Number(input.buySlippageBps ?? trade.DEFAULT_BUY_SLIPPAGE_BPS);
    if (!Number.isFinite(buySlippageBps) || buySlippageBps <= 0 || buySlippageBps > 5000) {
      throw new Error('the buy slippage floor must be between 1 and 5000 bps');
    }

    const startedAt = iso(nowFn());
    const job = {
      id: idFn(),
      userId,
      status: 'running',
      inFlight: false,
      token,
      pool,
      symbol,
      bigBuyWei: bigBuy,
      buySlippageBps,
      intervalMs,
      jitterPct,
      variancePct,
      currentIndex: 0,
      targets: planned,
      cycles: [],
      startedAt,
      updatedAt: startedAt,
      stoppedAt: null,
      completedAt: null,
      nextRunAt: null,
      failure: null,
      timer: null,
    };
    jobs.set(userId, job);

    log(userId, `[v6] chain started on ${symbol || token} for ${planned.length} wallet(s)`, {
      jobId: job.id,
      token,
      poolId: pool.poolId,
      bigBuyEth: formatEther(bigBuy),
      intervalMs,
      jitterPct,
      variancePct,
      buySlippageBps,
      wallets: planned.length,
    });

    schedule(job, 0);
    return publicJob(job);
  }

  function stop(userId) {
    const job = jobs.get(userId);
    if (!job) return publicJob(job);
    if (job.status !== 'running') return publicJob(job);
    clear(job);
    job.status = 'stopped';
    job.stoppedAt = iso(nowFn());
    job.updatedAt = job.stoppedAt;
    job.nextRunAt = null;
    log(userId, `[v6] run stopped at ${job.currentIndex}/${job.targets.length}`, {
      jobId: job.id,
      currentIndex: job.currentIndex,
      total: job.targets.length,
    });
    return publicJob(job);
  }

  function resume(userId) {
    const job = jobs.get(userId);
    if (!job) throw new Error('no v6 chain run to resume');
    if (job.status === 'running') return publicJob(job);
    if (job.status === 'complete') throw new Error('this v6 run is already complete');
    if (job.currentIndex > job.targets.length) throw new Error('this v6 run has no remaining wallets');

    job.status = 'running';
    job.stoppedAt = null;
    job.failure = null;
    job.updatedAt = iso(nowFn());
    log(userId, `[v6] run resumed at ${job.currentIndex}/${job.targets.length}`, {
      jobId: job.id,
      currentIndex: job.currentIndex,
      total: job.targets.length,
    });
    schedule(job, 0);
    return publicJob(job);
  }

  function status(userId) {
    return publicJob(jobs.get(userId));
  }

  function isRunning(userId) {
    return jobs.get(userId)?.status === 'running';
  }

  function reset() {
    for (const job of jobs.values()) clear(job);
    jobs.clear();
  }

  return { start, stop, resume, status, isRunning, _runNext: runNext, _reset: reset, _jobs: jobs };
}

const singleton = createEngine();

module.exports = singleton;
module.exports.createEngine = createEngine;
module.exports.DEFAULT_INTERVAL_MS = DEFAULT_INTERVAL_MS;
module.exports.MIN_INTERVAL_MS = MIN_INTERVAL_MS;
module.exports.MAX_INTERVAL_MS = MAX_INTERVAL_MS;
module.exports.DEFAULT_JITTER_PCT = DEFAULT_JITTER_PCT;
module.exports.MAX_JITTER_PCT = MAX_JITTER_PCT;
module.exports.FILL_POLL_MS = FILL_POLL_MS;
module.exports.FILL_TIMEOUT_MS = FILL_TIMEOUT_MS;
module.exports.RELAY_DEPOSIT_GAS = RELAY_DEPOSIT_GAS;
module.exports.RELAY_FEE_PCT = RELAY_FEE_PCT;
module.exports.FEE_BUMP_PCT = FEE_BUMP_PCT;
module.exports.gasFigures = gasFigures;
module.exports._private = { publicJob, publicCycle };
