/**
 * Pure arithmetic behind a click. No network, no keys, no React — every
 * function here is unit-tested and the session (session.js) composes them.
 */

export const CHAIN_ID = 4663;
export const QUOTE_MAX_AGE_MS = 2000;

/** Tokens a click sells from one wallet: floor(balance x pct / 100); 100 % is the exact balance. */
export function sellAmount(balance, pct) {
  const b = BigInt(balance);
  if (b <= 0n) return 0n;
  if (pct >= 100) return b;
  return (b * BigInt(pct)) / 100n;
}

/**
 * The pool quote cache: one quote per wallet for its FULL optimistic balance,
 * refreshed every 2 s while a pool venue is open (quotes: quoteSells() shape,
 * or chain/plan.js attachQuotes() rows, which also carry `worstOut`).
 */
export function buildQuoteCache(sells, quotes, at) {
  const byAddr = new Map();
  const list = Array.isArray(quotes) ? quotes : [];
  for (const s of sells) {
    const key = String(s.address).toLowerCase();
    const q = list.find((x) => x && String(x.address).toLowerCase() === key);
    if (!q) continue;
    byAddr.set(key, {
      amount: BigInt(s.amount),
      amountOut: BigInt(q.amountOut ?? 0),
      worstOut: q.worstOut === undefined || q.worstOut === null ? null : BigInt(q.worstOut),
      impactBps: Number(q.impactBps ?? 0),
      ok: q.ok === true,
      reason: q.reason ?? null,
    });
  }
  return { at, byAddr };
}

/**
 * Quotes for THIS click's amounts from the cache, or null when the cache
 * cannot answer (too old, a wallet missing, a refused quote, or a wallet now
 * holding more than was quoted) — the caller then fetches exact quotes.
 *
 * Scaling a full-balance quote down linearly is CONSERVATIVE: a pool's output
 * is concave in the input, so out(f x A) >= f x out(A) for f <= 1, per wallet
 * and for the cumulative sequential quotes alike. The minimum-out built from a
 * scaled quote can only be lower (more permissive), never above what the pool
 * pays. Impact is scaled the same way and rounded up.
 *
 * Every entry carries `amount` — the amount it prices, as a decimal string.
 * chain/plan.js planSell uses a pool quote ONLY when quote.amount equals the
 * amount it is about to sell (Task 10 contract note 4, plan.js attachQuotes);
 * without it every graduated / v1 wallet would be skipped 'no quote'. The
 * session's sell amounts (sellAmount: floor(balance x pct / 100)) equal
 * planSell's own (sellAmounts: floor(balance x pct*100 / 10000)) for the
 * whole-number percents the UI sends, so the two always match.
 *
 * When the cache was built from attachQuotes rows, each entry also carries
 * `worstOut` — the worst-landing-order floor planSell sizes minOut from —
 * scaled by the same ratio and floored. It stays a lower bound on what the
 * wallet is paid whatever the order the click lands in (session.js,
 * refreshQuotes, gives the argument). An entry built from a bare /quote row
 * carries no worstOut, and planSell treats it as no quote.
 */
export function quotesForClick(cache, sells, nowMs, maxAgeMs = QUOTE_MAX_AGE_MS) {
  if (!cache || !cache.byAddr || nowMs - cache.at > maxAgeMs) return null;
  const out = [];
  for (const s of sells) {
    const c = cache.byAddr.get(String(s.address).toLowerCase());
    const amt = BigInt(s.amount);
    if (!c || !c.ok || c.amount <= 0n || amt > c.amount) return null;
    const impact = c.amount === 0n ? 0 : Math.ceil((c.impactBps * Number((amt * 1_000_000n) / c.amount)) / 1_000_000);
    const entry = {
      address: s.address,
      amount: amt.toString(),
      amountOut: ((c.amountOut * amt) / c.amount).toString(),
    };
    if (c.worstOut !== null && c.worstOut !== undefined) entry.worstOut = ((c.worstOut * amt) / c.amount).toString();
    entry.impactBps = impact;
    entry.ok = true;
    entry.reason = null;
    out.push(entry);
  }
  return out;
}

/**
 * Walk a curve mark forward by sells that are signed but not yet reflected in
 * the latest streamed mark, so a second fast click prices against the curve
 * AFTER the first click's sells. The full gross leaves the quote reserve
 * (fees included), which under-states the reserve — the pessimistic direction:
 * a lower expected output means a lower minimum-out, never a spurious revert.
 */
export function walkCurve(mark, amounts) {
  let q = BigInt(mark.quoteReserve);
  let t = BigInt(mark.tokenReserve);
  for (const raw of amounts) {
    const a = BigInt(raw);
    if (a <= 0n) continue;
    const gross = (q * a) / (t + a);
    q -= gross;
    t += a;
  }
  return { ...mark, quoteReserve: q.toString(), tokenReserve: t.toString() };
}

/**
 * Broadcast error -> what to do about it.
 *   known  the same signed tx is already in the pool: it IS sent; never re-sign
 *   low    the nonce is already used (by this tx landing, or another)
 *   high   a gap: an earlier nonce never arrived
 *   funds  not enough ETH for gas
 *   other  anything else
 */
export function classifyError(message) {
  const m = String(message ?? '').toLowerCase();
  if (m.includes('already known') || m.includes('known transaction') || m.includes('alreadyknown')) return 'known';
  if (
    m.includes('nonce too low') ||
    m.includes('nonce has already been used') ||
    m.includes('replacement transaction underpriced') ||
    m.includes('nonce_expired') ||
    m.includes('oldnonce')
  ) {
    return 'low';
  }
  if (m.includes('nonce too high') || m.includes('nonce gap') || m.includes('future nonce')) return 'high';
  if (m.includes('insufficient funds')) return 'funds';
  return 'other';
}

/**
 * True when a venue's sell pays out a pair TOKEN that the page then swaps to
 * ETH (approve + pairSwap): a token-quoted curve (e.g. AMZN) or a token-quoted
 * graduated pool (e.g. SPCX). A v1 pool always pairs with WETH and unwraps in
 * the sell itself. Same rule as chain/plan.js pairLegGas (Task 10:
 * `venue.kind !== 'v1' && !venue.nativeQuote`), so the row's gas check and
 * planSell's 'no gas' check can never disagree.
 */
export function hasPairLeg(venue) {
  return !!venue && venue.kind !== 'v1' && !venue.nativeQuote;
}

/** Wei a wallet needs for its next sell (plus approvals when not armed, plus the pair -> ETH leg when the venue has one). */
export function gasNeeded(venue, fees, { needsArm = false } = {}) {
  const L = (fees && fees.gasLimits) || {};
  const g = (x) => BigInt(x ?? 0);
  let gas = venue.kind === 'curve' ? g(L.sellCurve) : venue.kind === 'graduated' ? g(L.sellV4) : g(L.sellV1);
  if (needsArm) gas += g(L.approve) + (venue.kind === 'graduated' ? g(L.permit2Approve) : 0n);
  if (hasPairLeg(venue)) gas += g(L.approve) + g(L.pairSwap);
  return gas * BigInt(fees.maxFeePerGas);
}

/** A chain/build.js result {to, data, value} -> the contract's txRequest. */
export function toTxRequest(built, { nonce, gasLimit, fees }) {
  return {
    to: built.to,
    data: built.data,
    value: built.value ?? 0n,
    nonce,
    gasLimit: BigInt(gasLimit),
    maxFeePerGas: BigInt(fees.maxFeePerGas),
    maxPriorityFeePerGas: 0n,
    chainId: CHAIN_ID,
    type: 2,
  };
}

/**
 * A sell whose receipt never arrived but whose nonce the chain has used: did it
 * sell? `before` is the optimistic balance the sell was planned from. If the
 * wallet now holds at most before - amount, it landed.
 */
export function resolveMissed({ before, amount, fresh }) {
  return BigInt(fresh) + BigInt(amount) <= BigInt(before) ? 'landed' : 'reverted';
}

/**
 * Split metas into /broadcast requests of at most `max` txs WITHOUT splitting
 * one wallet's txs across two requests (two concurrent requests could deliver
 * nonce n+1 before n). Returns arrays of indices into metas.
 */
export function chunkByWallet(metas, max = 100) {
  const groups = [];
  const at = new Map();
  metas.forEach((m, i) => {
    if (!at.has(m.key)) {
      at.set(m.key, groups.length);
      groups.push([]);
    }
    groups[at.get(m.key)].push(i);
  });
  const chunks = [];
  let cur = [];
  for (const g of groups) {
    if (cur.length && cur.length + g.length > max) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(...g);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** "3 not armed, 1 not enough ETH for gas" from planSell's skip reasons. */
export function summarizeSkips(skipped) {
  const counts = new Map();
  for (const s of skipped || []) counts.set(s.reason || 'skipped', (counts.get(s.reason || 'skipped') || 0) + 1);
  return [...counts.entries()].map(([reason, n]) => `${n} ${reason}`).join(', ');
}

/** The page's state machine: empty -> token -> wallets -> armed. */
export function stageOf({ venue, rows }) {
  if (!venue) return 'empty';
  if (!rows || rows.length === 0) return 'token';
  return rows.some((r) => r.ticked && r.canSell) ? 'armed' : 'wallets';
}

/**
 * Why no chip can sell, for the sell panel (session.view() shape). Rows stay listed
 * after a 100 % click, so a ticked set holding 0 tokens is reported as such, not
 * as an approval or gas problem.
 */
export function blockedReason(view, fees) {
  if (!fees) return 'Gas price unavailable — retrying.';
  if (view.rows.length === 0) return 'Import the wallets that hold this token.';
  if (view.totals.ticked === 0) return 'Tick at least one wallet.';
  if (BigInt(view.totals.tokens || '0') === 0n) return 'The ticked wallets hold none of this token.';
  if (view.totals.arming > 0) return 'Approvals are landing — selling unlocks per wallet.';
  return 'No ticked wallet can sell: check approvals and ETH for gas.';
}

/** A row's own sell buttons (spec addendum B): fixed, with the same one-click rules as the chips. */
export const ROW_SELL_PCTS = Object.freeze([25, 50, 100]);

/**
 * Why a row's own 25 / 50 / 100 buttons are off, for their tooltip — '' when
 * they are on. A row sells on its own whether or not it is ticked (session.js
 * canSellOne); an unticked wallet that still needs its approval is not armed,
 * so it must be ticked first.
 */
export function rowSellBlocked(row, fees) {
  if (!fees) return 'gas price unavailable — retrying';
  if (!row || row.tokens === '0') return 'this wallet holds none of the token';
  if (row.gasShort) return row.gasShort;
  if (row.needsArm) return row.ticked ? 'its approval is landing' : 'tick it to approve it first';
  if (!row.canSellOne) return row.detail || 'not ready';
  return '';
}
