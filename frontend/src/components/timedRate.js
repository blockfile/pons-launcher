// THE CADENCE OF A TIMED FUNDING RUN, IN PLAIN WORDS — and the ceiling on it.
//
// The server-held timed funding job (backend relay/timedFunding.js) fires a tick
// every `intervalMinutes` and funds up to `walletsPerTick` wallets in each one.
// Two numbers, and between them the only question the operator actually has:
// HOW LONG IS THIS GOING TO TAKE. One wallet a minute is 31 minutes for a
// 31-wallet bundle, and nothing on the page said so — the operator found out by
// watching. So the panel states the rate and the run length from the same
// arithmetic the scheduler runs on.
//
// THE CAP IS NOT A PREFERENCE. Every wallet in a tick costs exactly one Relay
// /quote, Relay's measured budget on this box is about four quotes a minute per
// IP, an API key does NOT lift it, and asking while blocked RE-ARMS the block —
// which is how a run once took 43 seconds a wallet instead of four. The
// scheduler refuses more than four per tick; this file names the same ceiling so
// the console cannot offer a fifth in the first place, and says why beside it.
//
// Pure: no fetches, no state, no money. It turns two numbers into a sentence.

// Kept in step with backend timedFunding.js MAX_WALLETS_PER_TICK, which is the
// one that actually refuses the request. A live job's status carries the
// server's own figure (`maxWalletsPerTick`); this is the value to draw before
// any job exists.
export const MAX_WALLETS_PER_TICK = 4;

export const WALLETS_PER_TICK_OPTIONS = [1, 2, 3, 4];

export const TIMED_INTERVALS = [
  // Short intervals for pacing under Relay's per-IP quote limit — four wallets a
  // minute is four quotes a minute, right at the measured budget, and funds a
  // full bundle in minutes rather than the hours the seasoning-style intervals
  // below take. The backend floor is 1 minute (timedFunding MIN_INTERVAL_MS).
  { minutes: 1, label: '1 min' },
  { minutes: 2, label: '2 min' },
  { minutes: 5, label: '5 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hr' },
  { minutes: 120, label: '2 hrs' },
  { minutes: 180, label: '3 hrs' },
  { minutes: 360, label: '6 hrs' },
  { minutes: 720, label: '12 hrs' },
  { minutes: 1440, label: '24 hrs' },
];

export function intervalLabel(minutes) {
  return TIMED_INTERVALS.find((i) => i.minutes === Number(minutes))?.label || `${minutes} min`;
}

/** A span of minutes as an operator reads a clock: "8 min", "1 hr 20 min", "2 days". */
export function formatSpan(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `${h} hr ${rest} min` : `${h} hr`;
  }
  const d = Math.floor(m / 1440);
  const h = Math.round((m % 1440) / 60);
  return h ? `${d} day${d === 1 ? '' : 's'} ${h} hr` : `${d} day${d === 1 ? '' : 's'}`;
}

/**
 * WHAT THE TWO KNOBS ADD UP TO.
 *
 * `minutes` is ticks × interval, deliberately: the pure waiting is only
 * (ticks − 1) intervals, but each tick also spends a few seconds per wallet
 * quoting and broadcasting, plus the gap the scheduler leaves BETWEEN wallets in
 * a tick. Counting one extra interval absorbs that instead of promising a
 * figure the run cannot hit — which is why every sentence here says "about".
 *
 * @param {{wallets?: number, perTick?: number, intervalMinutes?: number, max?: number}} o
 * @returns {{perTick: number, intervalMinutes: number, wallets: number, ticks: number,
 *            minutes: number, overCap: boolean, rate: string, eta: string, sentence: string}}
 */
export function timedRate({
  wallets = 0,
  perTick = 1,
  intervalMinutes = 30,
  max = MAX_WALLETS_PER_TICK,
} = {}) {
  const cap = Math.max(1, Math.floor(Number(max)) || MAX_WALLETS_PER_TICK);
  const askedPerTick = Math.floor(Number(perTick)) || 1;
  const overCap = askedPerTick > cap;
  const n = Math.min(cap, Math.max(1, askedPerTick));
  const every = Math.max(1, Number(intervalMinutes) || 1);
  const count = Math.max(0, Math.floor(Number(wallets)) || 0);

  const ticks = count ? Math.ceil(count / n) : 0;
  const minutes = ticks * every;

  const per = every === 1 ? 'a minute' : every === 60 ? 'an hour' : `every ${intervalLabel(every)}`;
  const rate = `${n} wallet${n === 1 ? '' : 's'} ${per}`;
  const eta = count ? `about ${formatSpan(minutes)} for ${count} wallet${count === 1 ? '' : 's'}` : '';

  return {
    perTick: n,
    intervalMinutes: every,
    wallets: count,
    ticks,
    minutes,
    overCap,
    rate,
    eta,
    sentence: eta ? `${rate} — ${eta}` : rate,
  };
}

/** Why the console will not offer a fifth wallet per tick. One sentence, stated where it bites. */
export function capReason(max = MAX_WALLETS_PER_TICK) {
  return (
    `max ${max} a tick: each wallet costs one Relay quote, this IP gets about ${max} a minute ` +
    '(an API key does not lift it), and quoting while blocked re-arms the block'
  );
}
