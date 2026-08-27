'use strict';

/**
 * The V3 chain: one big buy, then a cycle per bundle wallet of
 *
 *   sell enough tokens → Relay the proceeds to the next wallet → that wallet buys
 *
 * roughly seven seconds apart, until every wallet has bought.
 *
 * WHY THE TIMER LIVES ON THE SERVER. A run is minutes long and the operator
 * should be able to close the browser, lose their connection, or walk away
 * without stranding a half-distributed position. React cannot promise that; a
 * job here can. The shape is the one relay/timedFunding.js established — a Map
 * of jobs, one re-armed setTimeout, unref'd so it never holds the process open,
 * every dependency injectable so the tests drive a fake clock rather than
 * waiting.
 *
 * A restart still loses the job. That is the same trade the timed funder makes,
 * and it is acceptable here for one more reason: nothing is ever left pending.
 * Each step waits for its own receipt, so a lost job is a stopped run whose
 * every effect is already on chain and readable.
 *
 * THE INTERVAL IS A FLOOR, NOT A CLOCK. The next cycle is scheduled at
 * max(0, interval − however long this one took). A cycle that ran long because
 * Relay was slow does NOT cause the next one to fire early to catch up —
 * catching up would bunch two buys together, which is the exact shape the whole
 * strategy exists to avoid.
 *
 * FAILURE HALTS THE RUN AND KEEPS STATE. No retries, no skipping. Skipping
 * means a systemic fault — the curve graduated, the main wallet is dry, Relay
 * is down — burns every remaining wallet before anyone notices. Retrying a sell
 * whose first attempt actually landed sells the position twice.
 *
 * RESUME PICKS UP AT THE STEP THAT FAILED, NOT THE START OF THE CYCLE. This is
 * load-bearing and easy to get wrong: if the sell and the transfer succeeded
 * and only the buy failed, the ETH is already sitting in the bundle wallet, and
 * re-running the cycle from the top would sell a second position and send a
 * second transfer to pay for a buy that was already funded. Each cycle record
 * carries a done-flag per step, and the runner skips what is already done.
 */

const { randomUUID } = require('crypto');
const { formatEther, parseEther } = require('ethers');
const config = require('../config');
const { provider } = require('../evm/provider');
const { getFees, gasCost } = require('../evm/fees');
const { keystoreFor } = require('../wallets/keystore');
const { activityFor } = require('../store/activity');
const v3roles = require('./roles');
const defaultTrade = require('./trade');
const defaultRelay = require('./relay');
const defaultSizing = require('./sizing');

const DEFAULT_INTERVAL_MS = 7_000;
// Below this the Relay fill dominates the cycle and the interval stops
// describing anything — the run is then paced by the solver, not by the setting.
const MIN_INTERVAL_MS = 3_000;
const MAX_INTERVAL_MS = 600_000;

const DEFAULT_JITTER_PCT = 0;
// Past this the interval is not an interval.
const MAX_JITTER_PCT = 50;

const FILL_POLL_MS = 1_500;
// Same-chain Relay fills land in seconds. Ninety is a stall, not a slow fill.
const FILL_TIMEOUT_MS = 90_000;

// A deposit to a Relay deposit address is a plain value send with no calldata.
// 50k is generous and is only used to decide how much a cycle keeps back.
const RELAY_DEPOSIT_GAS = 50_000n;

// Held back from each transfer for Relay's own fee. An EXACT_OUTPUT order
// charges the fee on the SENDER's side, so the deposit is always larger than
// the amount ordered — and how much larger is not known until the quote comes
// back, which is after the size has to be chosen. Anything unspent stays in the
// main wallet and comes out at the exit.
const RELAY_FEE_PCT = 3;

// How far below its quote a CYCLE sell may fill before it REVERTS instead of dust-filling
// the slice. A dust fill — the curve moved between the quote and the sell, or a tax bit — is a
// ~99% miss, while a normal cycle's price impact is a fraction of a percent, so this sits
// safely in the gap and catches only catastrophic misfills. minQuoteOut = expected *
// (100 - this)/100; a rejected fill reverts (nothing sold, resume-safe) rather than spending
// the slice for nothing. The EXIT stays floor-free (it must always liquidate). Env-tunable;
// set to 100 to disable (minQuoteOut 0 = the old always-fill behaviour).
const CYCLE_SELL_MAX_SLIPPAGE_PCT = Number(process.env.V3_CYCLE_SELL_MAX_SLIPPAGE_PCT) || 50;

// Same headroom trade.js uses, so the gas figures the sell is sized against are
// the ones the transactions will actually quote.
const FEE_BUMP_PCT = 25;

// SAFE AUTO-RETRY, and only here. The reads a cycle makes BEFORE it broadcasts
// anything — the fees, the curve, the main wallet's token balance — are
// idempotent: re-doing one changes nothing on chain, so a transient RPC blip on
// one is retried in place instead of halting the whole run and waiting for a
// manual resume. This is the ONE place a retry is safe. The broadcasts (sell,
// deposit, buy) and the fill wait are NEVER retried — a failure there may have
// actually landed, and re-running it would double-sell or double-send, which is
// exactly why those still halt for a checked, manual resume.
const READ_RETRIES = 3;
const READ_BACKOFF_MS = 800;

// The gas a cycle reserves, given a fees object. Module-level and pure so the
// plan's feasibility check can size against the EXACT figures the engine's
// gasFor() uses — a drift here would let the plan bless a run the engine then
// halts (or refuse one it would have finished).
function gasFigures(fees) {
  return {
    buyGas: gasCost(fees, BigInt(config.buyGasLimit)),
    buffer: parseEther(String(config.gasBufferEth)),
    mainGas: gasCost(fees, defaultTrade.APPROVE_GAS + defaultTrade.SELL_GAS + RELAY_DEPOSIT_GAS),
  };
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function errorMessage(err) {
  return err?.shortMessage || err?.reason || err?.message || String(err);
}

/**
 * Everything a job holds, as JSON. Every wei figure becomes a decimal string
 * and an ETH string: this object is serialised straight onto a response, and
 * JSON.stringify throws on a BigInt rather than skipping it.
 */
function publicCycle(c) {
  return {
    index: c.index,
    kind: c.kind,
    state: c.state,
    step: c.step || null,
    walletId: c.walletId || null,
    address: c.address || null,
    // What this wallet ACTUALLY bought with — decided by what the sell raised,
    // not set in advance. Null until the buy has happened.
    buyEth: c.buyWei == null ? null : formatEther(c.buyWei),
    sliceEth: c.sliceWei == null ? null : formatEther(c.sliceWei),
    finalSlice: Boolean(c.finalSlice),
    tokensSold: c.tokensSold == null ? null : c.tokensSold.toString(),
    ethRaised: c.ethRaised == null ? null : formatEther(c.ethRaised),
    transferredEth: c.transferredWei == null ? null : formatEther(c.transferredWei),
    tokensOut: c.tokensOut == null ? null : c.tokensOut.toString(),
    approveHash: c.approveHash || null,
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
  if (!job) return { protocol: 'v3', mode: 'relay-chain', status: 'idle', running: false, cycles: [] };

  const cycles = job.cycles.map(publicCycle);
  const done = cycles.filter((c) => c.kind === 'cycle' && c.state === 'done').length;

  return {
    id: job.id,
    userId: job.userId,
    protocol: 'v3',
    mode: 'relay-chain',
    status: job.status,
    running: job.status === 'running',
    inFlight: job.inFlight,
    token: job.token,
    curve: job.curve,
    symbol: job.symbol,
    bigBuyEth: formatEther(job.bigBuyWei),
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
    targets: job.targets.map((t, i) => ({
      index: i + 1,
      walletId: t.walletId,
      address: t.address,
    })),
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
  // Injectable so trade/relay can be handed the same fakes the engine got.
  const tradeDeps = deps.tradeDeps || {};

  function log(userId, summary, detail = {}) {
    activityForFn(userId).record('v3', summary, detail);
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
        // runNext handles its own failures; anything reaching here is a bug in
        // the engine rather than in a step, and must still stop the run.
        job.status = 'failed';
        job.inFlight = false;
        job.nextRunAt = null;
        job.failure = { index: job.currentIndex, step: 'engine', walletId: null, error: errorMessage(err) };
        job.updatedAt = iso(nowFn());
        log(job.userId, `[v3] run halted — ${errorMessage(err)}`, { jobId: job.id, error: errorMessage(err) });
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

  /**
   * The gas figures a cycle has to work around.
   *
   * They come from the real trade module rather than the injected one: they
   * describe transactions this engine does not build, so they are data, and a
   * test that substitutes the trading behaviour should not have to restate
   * them.
   */
  async function gasFor() {
    const fees = await getFeesFn(FEE_BUMP_PCT);
    // buyGas: what a bundle wallet needs to make its buy, plus prepareV2's buffer.
    // mainGas: what the main wallet keeps back out of each sale for its own next
    // approve, sell and deposit — or the run walks itself dry a few cycles in.
    return { fees, ...gasFigures(fees) };
  }

  /**
   * Retry an IDEMPOTENT read through a transient failure before letting it halt
   * the run. Only ever wraps reads that broadcast nothing — see READ_RETRIES.
   */
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

  /**
   * Poll until the solver's fill lands.
   *
   * The deadline is expressed in polls rather than in wall-clock time so the
   * loop is deterministic under a fake clock, and so a machine that sleeps
   * mid-run cannot silently double the timeout.
   */
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
    const main = v3roles.main(ks);
    const out = await trade.buy(
      { wallet: main, curveAddress: job.curve, amountWei: job.bigBuyWei },
      { ...tradeDeps, keystore: ks, rpc }
    );
    if (out.status === 'reverted') throw new Error('the big buy reverted');

    record.buyHash = out.hash;
    record.tokensOut = out.tokensOut;
    log(job.userId, `[v3] big buy of ${formatEther(job.bigBuyWei)} ETH from the main wallet`, {
      jobId: job.id,
      token: job.token,
      hash: out.hash,
      tokensOut: out.tokensOut?.toString?.() ?? null,
    });
  }

  async function runCycle(job, index, record) {
    const target = job.targets[index - 1];
    const ks = keystoreForFn(job.userId);
    const main = v3roles.main(ks);
    const wallet = v3roles.bundle(ks).find((w) => w.id === target.walletId);
    if (!wallet) throw new Error(`wallet ${target.walletId} is no longer a v3 bundle wallet`);

    const { buyGas, buffer, mainGas } = await retryRead(gasFor);

    // How many wallets, including this one, still have to be served. This is
    // the divisor the slice is drawn against, and recomputing it every cycle is
    // what makes the position land on zero exactly when the wallets run out.
    const remainingWallets = job.targets.length - (index - 1);

    // ── sell ────────────────────────────────────────────────────────────────
    if (!record.sellDone) {
      record.step = 'selling';
      record.state = 'selling';

      // Read fresh every cycle, and REJECT a degenerate read so a transient RPC glitch
      // (empty / half-migrated reserves) is retried rather than trusted. A bad read would
      // otherwise value the whole position at dust, size a dust slice, and sell it — the
      // exact failure that then wedges the cycle. retryRead retries a throw, so a
      // zero-reserve read throws here and is retried instead of being sold against.
      const curve = await retryRead(async () => {
        const c = await trade.readCurve(job.curve, { ...tradeDeps, rpc });
        // A graduated / ready-to-graduate curve is a REAL terminal state, not a blip — return
        // it so the clear "graduated — run the exit" halt below fires. (A pons curve may zero
        // its reserves at graduation; without this, that would be retried as an empty read and
        // then halt with the less-actionable "empty reserves" message.)
        if (c.graduated || c.readyToGraduate) return c;
        if (c.quoteReserve <= 0n || c.tokenReserve <= 0n) {
          throw new Error('the curve returned empty reserves this read — retrying before sizing a sell');
        }
        return c;
      });
      // A curve that graduated — OR is about to — mid-run must stop the run here, before
      // another sell is signed against it. readyToGraduate is the same line the START route
      // refuses on: past it the remaining position can only be sold on the migrated pool,
      // not on the curve, so continuing would strand it. The run's own bundle buys push
      // toward this, so a long run can cross it even though the start was clear.
      if (curve.graduated) {
        throw new Error(
          'the curve graduated mid-run — the remaining position cannot be sold on the curve. Run the exit to ' +
            'recover it on the migrated pool.'
        );
      }
      if (curve.readyToGraduate) {
        throw new Error(
          'the curve is ready to graduate mid-run — the remaining position can only be sold on the migrated ' +
            'pool now, not on the curve. Run the exit to recover it.'
        );
      }

      const balance = await retryRead(() => trade.tokenBalance(curve.token, main.address, { ...tradeDeps, rpc }));
      if (balance <= 0n) {
        throw new Error(
          'the main wallet holds none of this token — the position is already gone, so there is ' +
            'nothing left to distribute'
        );
      }

      let tokensIn;
      if (remainingWallets <= 1) {
        // THE LAST WALLET TAKES THE WHOLE REMAINDER. Not a computed slice: the
        // point of the run is that the position ends at zero rather than near
        // it, and arithmetic against a moving price cannot promise that.
        tokensIn = balance;
        record.finalSlice = true;
      } else {
        // What the position is worth if sold right now, price impact included —
        // NOT a spot price times a balance, which would overstate a large
        // position and make the early slices too big.
        const valueWei = sizing.quoteSellOut({
          tokensIn: balance,
          quoteReserve: curve.quoteReserve,
          tokenReserve: curve.tokenReserve,
          feeBps: curve.feeBps,
          creatorTaxBps: curve.creatorTaxBps,
        });

        const sliceWei = sizing.sliceFor({
          valueWei,
          remainingWallets,
          variancePct: job.variancePct,
          roll: randomFn(),
        });

        // headroomPct 0: unlike the old model there is no fixed obligation on
        // the other side of this sell to fall short of. Whatever it raises is
        // what the next wallet buys with.
        tokensIn = sizing.tokensToRaise({
          targetWei: sliceWei,
          quoteReserve: curve.quoteReserve,
          tokenReserve: curve.tokenReserve,
          feeBps: curve.feeBps,
          creatorTaxBps: curve.creatorTaxBps,
          headroomPct: 0,
        });
        if (tokensIn > balance) tokensIn = balance;
        record.sliceWei = sliceWei;

        // VIABILITY, CHECKED BEFORE THE SELL — not after. This slice's EXPECTED raise
        // (sliceWei) must cover the main wallet's own next-round gas and still leave enough,
        // after the Relay fee, to fund the next buy. If it cannot, HALT NOW WITHOUT SELLING.
        // The whole point: a sell that raised dust would be recorded done and freeze
        // record.ethRaised below the gas floor, so Resume would re-hit the same wall forever,
        // and re-selling on Resume would sell the position twice. Halting before the sell
        // means NOTHING was sold — so a Resume re-sizes against a fresh read and sells this
        // slice exactly once. Healthy curve → this was a momentary thin read, Resume clears
        // it; genuinely too small → run the Exit.
        const expectSpendable = sliceWei - mainGas;
        const expectTransfer = expectSpendable > 0n ? (expectSpendable * BigInt(100 - RELAY_FEE_PCT)) / 100n : 0n;
        if (expectSpendable <= 0n || expectTransfer <= buyGas + buffer) {
          throw new Error(
            `this cycle's quote came back too thin to continue — the curve valued the position at ` +
              `${formatEther(valueWei)} ETH this read, so a slice would raise about ${formatEther(sliceWei)} ETH, ` +
              `under the ${formatEther(mainGas + buyGas + buffer)} ETH of gas + buy the next step needs. ` +
              `NOTHING WAS SOLD. If the curve is healthy this was a momentary bad read — press Resume to retry; ` +
              `if the position is genuinely too small to divide further, run the Exit to recover it.`
          );
        }
      }

      // The sell FLOOR (see trade.js): quote what the curve should pay for tokensIn and refuse
      // a fill more than CYCLE_SELL_MAX_SLIPPAGE_PCT below it. A dust fill then REVERTS instead
      // of spending the slice's tokens for nothing; a reverted sell sold nothing, so the cycle
      // halts resume-safe (sellDone stays false) and retries once the price is stable.
      const expectedWei = sizing.quoteSellOut({
        tokensIn,
        quoteReserve: curve.quoteReserve,
        tokenReserve: curve.tokenReserve,
        feeBps: curve.feeBps,
        creatorTaxBps: curve.creatorTaxBps,
      });
      const minQuoteOut = (expectedWei * BigInt(100 - CYCLE_SELL_MAX_SLIPPAGE_PCT)) / 100n;

      const sold = await trade.sell(
        { wallet: main, curveAddress: job.curve, token: curve.token, tokensIn, minQuoteOut },
        { ...tradeDeps, keystore: ks, rpc }
      );
      if (sold.status === 'reverted') {
        throw new Error(
          `the sell reverted — the curve would have paid more than ${CYCLE_SELL_MAX_SLIPPAGE_PCT}% below the quote ` +
            `(it moved between the quote and the sell, or a tax bit), so the floor rejected it. NOTHING WAS SOLD, so ` +
            `the position is intact — Resume retries when the price is stable, or run the Exit.`
        );
      }

      record.tokensSold = tokensIn;
      record.ethRaised = sold.ethReceived;
      record.approveHash = sold.approveHash;
      record.sellHash = sold.sellHash;
      record.sellDone = true;
      log(
        job.userId,
        `[v3] cycle ${index}/${job.targets.length}: sold ${
          record.finalSlice ? 'the remaining position' : 'a slice'
        } for ${formatEther(sold.ethReceived)} ETH`,
        {
          jobId: job.id,
          walletId: target.walletId,
          tokensIn: tokensIn.toString(),
          remainingWallets,
          hash: sold.sellHash,
        }
      );
    }

    // ── transfer ────────────────────────────────────────────────────────────
    // Sized from what the sell ACTUALLY raised, never from the estimate. The
    // main wallet keeps back its own next round of gas, and a small allowance
    // for the Relay fee — which is charged on the sender's side of an
    // EXACT_OUTPUT order and is not known until the quote comes back.
    if (!record.transferDone) {
      record.step = 'transferring';
      record.state = 'transferring';

      const spendable = record.ethRaised - mainGas;
      if (spendable <= 0n) {
        // The pre-sell viability check above normally stops a thin cycle BEFORE selling. If
        // it still gets here, the sell fired against a healthy quote but FILLED far below it
        // — the curve moved (a large sell landed) between the read and the sell. The slice's
        // tokens are already sold, so Resume would re-hit this same step; the honest path is
        // the Exit, which sells the remaining position at market and recovers it.
        throw new Error(
          `this cycle's sell filled at only ${formatEther(record.ethRaised)} ETH — below the ${formatEther(mainGas)} ` +
            `ETH of gas the next step needs. The curve moved between the quote and the sell, so those tokens are ` +
            `already spent and Resume would stop here again. Run the Exit to sell the remaining position and recover it.`
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
        `[v3] cycle ${index}/${job.targets.length}: transferred ${formatEther(transferWei)} ETH to ${target.address}`,
        { jobId: job.id, walletId: target.walletId, requestId: sent.requestId, hash: sent.hash }
      );
    }

    // ── wait for the fill ───────────────────────────────────────────────────
    // 99% of what was ordered: the order is EXACT_OUTPUT so the full amount
    // should land, and the tolerance exists only so a rounding difference of a
    // few wei cannot hang a cycle for the whole timeout.
    if (!record.fillDone) {
      record.step = 'waiting-fill';
      record.state = 'waiting-fill';
      await waitForFill(record, target.address, (record.transferredWei * 99n) / 100n);
      record.fillDone = true;
    }

    // ── buy ─────────────────────────────────────────────────────────────────
    // Everything that arrived, less gas. The wallet was funded for this one
    // buy and has no other job, so leaving a remainder behind would only strand
    // dust across every wallet in the run.
    if (!record.buyDone) {
      record.step = 'buying';
      record.state = 'buying';

      const balance = BigInt(await rpc.getBalance(target.address));
      const spend = balance - buyGas - buffer;
      if (spend <= 0n) {
        throw new Error(
          `${target.address} holds ${formatEther(balance)} ETH, which does not cover the gas to buy with`
        );
      }

      const out = await trade.buy(
        { wallet, curveAddress: job.curve, amountWei: spend },
        { ...tradeDeps, keystore: ks, rpc }
      );
      if (out.status === 'reverted') throw new Error('the buy reverted');

      // Report what was ACTUALLY spent — trade.buy may trim the spend to fit a fee tick.
      const actualSpend = out.spent ?? spend;
      record.buyWei = actualSpend;
      record.buyHash = out.hash;
      record.tokensOut = out.tokensOut;
      record.buyDone = true;
      log(
        job.userId,
        `[v3] cycle ${index}/${job.targets.length}: ${target.address} bought with ${formatEther(actualSpend)} ETH`,
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
    log(job.userId, `[v3] run complete — ${job.targets.length} wallet(s) bought`, {
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
      log(job.userId, `[v3] run halted at ${record.step || record.kind}: ${errorMessage(err)}`, {
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

    // A stop that arrived while this cycle was in flight is honoured here: the
    // work that was already running finished, and nothing new is scheduled.
    if (job.status !== 'running') return publicJob(job);
    if (job.currentIndex > job.targets.length) return complete(job);

    const elapsed = nowFn() - startedMs;
    schedule(job, Math.max(0, intervalFor(job) - elapsed));
    return publicJob(job);
  }

  /**
   * Validate and begin.
   *
   * The chain-state refusals — is this a pons v2 token, did we launch it, has
   * the curve graduated — belong to the route, which has already resolved the
   * curve address by the time it gets here. What this checks is the shape of
   * the run itself.
   */
  async function start(userId, input = {}) {
    const existing = jobs.get(userId);
    if (existing?.status === 'running') throw new Error('a v3 chain run is already running');

    const { token, curve, symbol = null, bigBuyWei, targets = [] } = input;
    if (!token || !curve) throw new Error('token and curve are required');

    const bigBuy = BigInt(bigBuyWei ?? 0);
    if (bigBuy <= 0n) throw new Error('the big buy must be a positive amount');

    if (!Array.isArray(targets) || !targets.length) {
      throw new Error('at least one bundle wallet is required');
    }
    // No per-wallet amount: the position is divided across however many wallets
    // there are, one cycle each, sized as the run goes.
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

    const startedAt = iso(nowFn());
    const job = {
      id: idFn(),
      userId,
      status: 'running',
      inFlight: false,
      token,
      curve,
      symbol,
      bigBuyWei: bigBuy,
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

    log(userId, `[v3] chain started on ${symbol || token} for ${planned.length} wallet(s)`, {
      jobId: job.id,
      token,
      curve,
      bigBuyEth: formatEther(bigBuy),
      intervalMs,
      jitterPct,
      variancePct,
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
    log(userId, `[v3] run stopped at ${job.currentIndex}/${job.targets.length}`, {
      jobId: job.id,
      currentIndex: job.currentIndex,
      total: job.targets.length,
    });
    return publicJob(job);
  }

  function resume(userId) {
    const job = jobs.get(userId);
    if (!job) throw new Error('no v3 chain run to resume');
    if (job.status === 'running') return publicJob(job);
    if (job.status === 'complete') throw new Error('this v3 run is already complete');
    if (job.currentIndex > job.targets.length) throw new Error('this v3 run has no remaining wallets');

    job.status = 'running';
    job.stoppedAt = null;
    job.failure = null;
    job.updatedAt = iso(nowFn());
    log(userId, `[v3] run resumed at ${job.currentIndex}/${job.targets.length}`, {
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
