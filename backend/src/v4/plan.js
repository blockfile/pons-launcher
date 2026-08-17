'use strict';

/**
 * The plan is the state.
 *
 * Starting a campaign rolls EVERY dice once and writes the whole schedule out.
 * Nothing is decided later. The runner does not accumulate anything; it reads
 * this list and sends whatever is due.
 *
 * That is what makes a three-week job recoverable. There is no intent to infer
 * from history after a restart — there is a list of transfers with due times,
 * and each one is either done or not.
 *
 * WHAT IS RANDOMISED, AND WHY EACH ONE: the count per day, so the batch has no
 * daily rhythm; the amount, at six decimals, so no two wallets share a figure
 * and none of them are round; the gap, so the sends have no cadence. Each is a
 * column somebody could group by.
 */

const { parseEther, formatEther } = require('ethers');
const rng = require('./rng');

const DAY_MS = 24 * 60 * 60 * 1000;

// The strategy's own numbers. Every one of them is a field on the campaign —
// these are where the form starts, not what it is limited to.
const DEFAULTS = {
  days: 20,
  perDayMin: 10,
  perDayMax: 30,
  amountMinEth: '0.0031',
  amountMaxEth: '0.0089',
  gapMinMs: 20 * 60_000,
  gapMaxMs: 4 * 3_600_000,
};

const LIMITS = {
  days: [1, 90],
  perDay: [1, 200],
  gapMs: [60_000, 24 * 3_600_000],
};

// Amounts are quoted to six decimals. A range sampled at two has nine possible
// values across the whole campaign, which is not randomness, it is a category.
const AMOUNT_DECIMALS = 6;

// How much of each day the transfers are allowed to occupy. Leaving a margin
// means the last transfer of a day cannot collide with the first of the next.
const DAY_FILL = 0.95;

function num(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got "${value}"`);
  return n;
}

function ethString(value, what) {
  const raw = String(value ?? '').trim();
  if (!/^\d*\.?\d+$/.test(raw)) throw new Error(`${what} must be a number of ETH`);
  return raw;
}

/** Validate and fill in a parameter set. Throws naming the field it refuses. */
function normaliseParams(raw = {}) {
  const days = Math.round(num(raw.days, DEFAULTS.days));
  if (days < LIMITS.days[0] || days > LIMITS.days[1]) {
    throw new Error(`days must be between ${LIMITS.days[0]} and ${LIMITS.days[1]}`);
  }

  const perDayMin = Math.round(num(raw.perDayMin, DEFAULTS.perDayMin));
  const perDayMax = Math.round(num(raw.perDayMax, DEFAULTS.perDayMax));
  if (perDayMin < LIMITS.perDay[0] || perDayMax > LIMITS.perDay[1]) {
    throw new Error(`per-day counts must be between ${LIMITS.perDay[0]} and ${LIMITS.perDay[1]}`);
  }
  if (perDayMin > perDayMax) throw new Error('per-day minimum cannot exceed the maximum');

  const amountMinEth = ethString(raw.amountMinEth ?? DEFAULTS.amountMinEth, 'amount minimum');
  const amountMaxEth = ethString(raw.amountMaxEth ?? DEFAULTS.amountMaxEth, 'amount maximum');
  if (parseEther(amountMinEth) <= 0n) throw new Error('amount minimum must be positive');
  if (parseEther(amountMinEth) > parseEther(amountMaxEth)) {
    throw new Error('amount minimum cannot exceed the maximum');
  }

  const gapMinMs = Math.round(num(raw.gapMinMs, DEFAULTS.gapMinMs));
  const gapMaxMs = Math.round(num(raw.gapMaxMs, DEFAULTS.gapMaxMs));
  if (gapMinMs < LIMITS.gapMs[0] || gapMaxMs > LIMITS.gapMs[1]) {
    throw new Error(`gaps must be between ${LIMITS.gapMs[0]}ms and ${LIMITS.gapMs[1]}ms`);
  }
  if (gapMinMs > gapMaxMs) throw new Error('gap minimum cannot exceed the maximum');

  // The densest day the caller can ask for still has to fit its own gap
  // floor: perDayMax sends, each at least gapMinMs apart, inside DAY_FILL of
  // a day. Rejecting this up front is what lets dayTimes() promise every
  // send lands on its own day without ever having to invent time that is not
  // there — the alternative is a day silently running over into the next.
  if (perDayMax * gapMinMs > DAY_MS * DAY_FILL) {
    throw new Error(
      `gap minimum of ${gapMinMs}ms cannot fit ${perDayMax} sends inside one day — ` +
        'lower the per-day maximum or the gap minimum'
    );
  }

  return { days, perDayMin, perDayMax, amountMinEth, amountMaxEth, gapMinMs, gapMaxMs };
}

/**
 * Can this many wallets fit in this many days?
 *
 * Answered BEFORE anything is generated, and named in both directions. A
 * campaign that quietly funded 600 of 700 wallets would leave 100 wallets the
 * operator believes are seasoned and which have never been touched.
 */
function feasible(walletCount, params) {
  const min = params.days * params.perDayMin;
  const max = params.days * params.perDayMax;
  if (walletCount > max) {
    return {
      ok: false,
      min,
      max,
      reason:
        `${walletCount} wallets will not fit in ${params.days} days at ` +
        `${params.perDayMin}–${params.perDayMax} a day — the ceiling is ${max}. ` +
        'Raise the days, raise the daily maximum, or run fewer wallets.',
    };
  }
  if (walletCount < min) {
    return {
      ok: false,
      min,
      max,
      reason:
        `${walletCount} wallets is below the floor of ${min} for ${params.days} days at ` +
        `${params.perDayMin} a day minimum. Lower the days or the daily minimum.`,
    };
  }
  return { ok: true, min, max, reason: null };
}

/** Split `total` across `days`, each inside [min, max], summing exactly. */
function dailyCounts(total, params, r) {
  const counts = new Array(params.days).fill(params.perDayMin);
  let remaining = total - params.days * params.perDayMin;
  const room = params.perDayMax - params.perDayMin;

  // One at a time into a day that still has room. O(remaining), and remaining
  // is at most days × room — a few hundred for any realistic campaign.
  while (remaining > 0) {
    const open = [];
    for (let d = 0; d < counts.length; d++) {
      if (counts[d] - params.perDayMin < room) open.push(d);
    }
    const d = r.pick(open);
    counts[d] += 1;
    remaining -= 1;
  }
  return counts;
}

/** A random amount in range, quoted to six decimals. */
function amountFor(params, r) {
  const min = Number(params.amountMinEth);
  const max = Number(params.amountMaxEth);
  return (min + r.next() * (max - min)).toFixed(AMOUNT_DECIMALS);
}

/**
 * Shrink `gaps` toward `usable` without ever taking one below `floorMs`.
 *
 * A flat `usable / total` scale is not enough: scaling downward can push a
 * gap below the floor, and clamping it back up (as a naive single pass does)
 * re-adds exactly the excess the scale was trying to remove — so the total
 * can still land above `usable`, and in a dense enough day, above the day
 * itself. Fix: only the gaps that still have room above the floor absorb the
 * reduction, split proportionally to how much room each one has. Every gap
 * that is already at the floor is left untouched, so nothing needs clamping
 * back up and nothing needs a second pass.
 */
function squeezeGaps(gaps, floorMs, usable) {
  let total = gaps.reduce((a, b) => a + b, 0);
  if (total <= usable) return gaps;

  const excess = total - usable;
  let flexTotal = 0;
  const flexIdx = [];
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i] > floorMs) {
      flexIdx.push(i);
      flexTotal += gaps[i] - floorMs;
    }
  }
  // If every gap is already at the floor, count * floorMs alone exceeds
  // `usable` — no redistribution can fix that. normaliseParams rejects that
  // combination of perDayMax and gapMinMs up front, so dayTimes should never
  // actually reach this branch; it is here so a future change to that check
  // fails loudly (via the day-boundary test) rather than silently overflowing.
  if (flexTotal <= 0) return gaps;

  const reduceBy = Math.min(excess, flexTotal);
  for (const i of flexIdx) {
    const share = (gaps[i] - floorMs) / flexTotal;
    gaps[i] -= reduceBy * share;
  }
  return gaps;
}

/**
 * The send times for one day.
 *
 * Gaps are drawn from the configured range, then squeezed if they overrun
 * the day. THE RANGE IS A DISTRIBUTION, NOT A GUARANTEE: at 30 wallets in a day
 * the gaps must average under 48 minutes, so the top of a 4-hour range simply
 * will not be drawn. The daily count is the parameter a filter would key on,
 * so it wins.
 */
function dayTimes(dayStart, count, params, r) {
  const gaps = [];
  for (let i = 0; i < count; i++) {
    gaps.push(params.gapMinMs + r.next() * (params.gapMaxMs - params.gapMinMs));
  }

  const usable = DAY_MS * DAY_FILL;
  squeezeGaps(gaps, params.gapMinMs, usable);
  const total = gaps.reduce((a, b) => a + b, 0);

  // Slide the whole day's run to a random offset in whatever slack is left, so
  // the campaign does not start at the same time every morning. squeezeGaps
  // guarantees total <= usable whenever count * gapMinMs <= usable, which
  // normaliseParams enforces up front — so slack here is never negative and
  // dayStart + slack + total is always < dayStart + DAY_MS. (A clamp to
  // dayStart + DAY_MS here would be tempting insurance, but it is the wrong
  // kind: clamping several tail transfers to the same instant would produce
  // duplicate dueAt values, trading a day-overflow bug for a worse one.)
  const slack = Math.max(0, DAY_MS - total);
  let at = dayStart + Math.floor(r.next() * slack);

  const times = [];
  for (const gap of gaps) {
    at += Math.round(gap);
    times.push(at);
  }
  return times;
}

/**
 * Roll the whole campaign.
 *
 * @param {object} input
 * @param {string[]} input.walletIds  seed wallet ids, each funded exactly once
 * @param {object} input.addresses    walletId -> address
 * @param {object} input.params       from normaliseParams
 * @param {string} input.seed         stored with the campaign; makes this reproducible
 * @param {number} input.now          campaign start, ms since epoch
 */
function generate({ walletIds, addresses, params, seed, now }) {
  const check = feasible(walletIds.length, params);
  if (!check.ok) throw new Error(check.reason);

  const r = rng.make(seed);
  const counts = dailyCounts(walletIds.length, params, r);

  // Shuffle which wallet lands on which day, so creation order is not funding
  // order — consecutive ids funded on consecutive days is itself an edge.
  const pool = walletIds.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = r.int(0, i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }

  const transfers = [];
  const byDay = [];
  let cursor = 0;

  for (let d = 0; d < params.days; d++) {
    const count = counts[d];
    const times = dayTimes(now + d * DAY_MS, count, params, r);
    const ids = pool.slice(cursor, cursor + count);
    cursor += count;

    let dayEth = 0;
    ids.forEach((walletId, i) => {
      const amountEth = amountFor(params, r);
      dayEth += Number(amountEth);
      transfers.push({
        id: `${d + 1}-${i + 1}`,
        walletId,
        address: addresses[walletId],
        amountEth,
        dueAt: times[i],
        day: d + 1,
        status: 'pending',
        attempts: [],
        requestId: null,
        depositAddress: null,
        hash: null,
        sentAt: null,
      });
    });

    byDay.push({ day: d + 1, count, totalEth: dayEth.toFixed(AMOUNT_DECIMALS) });
  }

  transfers.sort((a, b) => a.dueAt - b.dueAt);

  const totalWei = transfers.reduce((sum, t) => sum + parseEther(t.amountEth), 0n);
  return { seed, params, transfers, byDay, totalEth: formatEther(totalWei) };
}

/**
 * What the campaign actually costs the funding wallet.
 *
 * NOT the sum of the amounts. An EXACT_OUTPUT order charges Relay's fee on the
 * SENDER's side, so every deposit is larger than the amount ordered, and every
 * deposit costs gas of its own. A campaign budgeted on the bare sum runs dry
 * near the end — which is the worst possible moment, because the wallets that
 * go unfunded are the ones with the least time left to season.
 */
function estimateCost(transfers, { feePct = 3, gasWei = 0n } = {}) {
  const depositsWei = transfers.reduce((sum, t) => sum + parseEther(t.amountEth), 0n);
  const feesWei = (depositsWei * BigInt(Math.round(feePct * 100))) / 10_000n;
  const totalGasWei = BigInt(gasWei) * BigInt(transfers.length);
  const totalWei = depositsWei + feesWei + totalGasWei;
  return {
    depositsWei,
    feesWei,
    gasWei: totalGasWei,
    totalWei,
    totalEth: formatEther(totalWei),
  };
}

module.exports = {
  DAY_MS,
  DEFAULTS,
  LIMITS,
  normaliseParams,
  feasible,
  generate,
  estimateCost,
  _private: { dailyCounts, dayTimes, amountFor, squeezeGaps },
};
