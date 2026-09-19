/**
 * Lock, Disconnect and Switch (App.leaveWhenQuiet, then App.leaveAccount) take
 * the account's wallets — their keys — out of this tab. Whatever the tab still
 * has to sign with them must be signed first, or it never is:
 *   - on a token-quoted venue (AMZN, SPCX, USDG…) every landed sell is followed
 *     by a pair -> ETH swap that this tab signs with that wallet's key. Take the
 *     key while the sell is in flight, or while the swap is queued or being
 *     signed, and the proceeds stay in the pair token;
 *   - a sell click between its start and its broadcast (a pool click awaits its
 *     /quote) signs once it has its answer.
 * session.pendingWork() counts what is left. This module waits for it, words
 * it for the account strip and for the last confirmation, and says when the
 * visitor must agree before the keys go anyway. Counts only: no address, no
 * key, no network.
 */
import { fmtUnits } from './format.js';

/** How long a leave waits for the tab's own signing before it asks. */
export const LEAVE_WAIT_MS = 60_000;
/** How often the wait re-reads session.pendingWork(). */
export const LEAVE_POLL_MS = 250;

const HOW = {
  lock: { verb: 'Locking', act: 'lock', Act: 'Lock', ing: 'locks', back: 'Unlock again' },
  disconnect: { verb: 'Disconnecting', act: 'disconnect', Act: 'Disconnect', ing: 'disconnects', back: 'Connect and unlock again' },
  switch: { verb: 'Switching accounts', act: 'switch accounts', Act: 'Switch accounts', ing: 'switches', back: 'Sign in to this account and unlock again' },
};
const words = (how) => HOW[how] || HOW.lock;
const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const whole = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

/**
 * session.pendingWork()'s answer with every field checked, or all zeros for
 * null (no token open: nothing to wait for).
 * @returns {{clicks: number, sending: number, legs: number, owed: number,
 *   owedAmount: string, stranded: number, strandedAmount: string,
 *   retryInMs: number|null, symbol: string|null, decimals: number}}
 */
export function normalizeWork(work) {
  const w = work && typeof work === 'object' ? work : {};
  const amount = (v) => {
    try {
      const n = BigInt(v ?? 0);
      return n > 0n ? n.toString() : '0';
    } catch {
      return '0';
    }
  };
  return {
    clicks: whole(w.clicks),
    sending: whole(w.sending),
    legs: whole(w.legs),
    owed: whole(w.owed),
    owedAmount: amount(w.owedAmount),
    stranded: whole(w.stranded),
    strandedAmount: amount(w.strandedAmount),
    retryInMs: Number.isFinite(w.retryInMs) && w.retryInMs >= 0 ? w.retryInMs : null,
    symbol: typeof w.symbol === 'string' && w.symbol ? w.symbol : null,
    decimals: Number.isSafeInteger(w.decimals) && w.decimals >= 0 ? w.decimals : 18,
  };
}

/** Something the tab must still sign before the keys may leave: the leave waits for it. */
export function inFlight(work) {
  const w = normalizeWork(work);
  return w.clicks > 0 || w.sending > 0 || w.legs > 0;
}

function inFlightWords(w) {
  const parts = [];
  if (w.clicks) parts.push(`${count(w.clicks, 'sell click')} being signed`);
  if (w.sending) parts.push(`${count(w.sending, 'wallet')} still sending`);
  if (w.legs) parts.push(`${count(w.legs, `${w.symbol || 'pair'} → ETH swap`)} to send`);
  return parts.join(', ');
}

/** The reason a sell click is refused while a leave runs (session.holdSells). */
export function pausedReason(how) {
  return `sells are paused while your account ${words(how).ing}`;
}

/** The strip's text once the wait is over and the leave itself runs (no way back from here). */
export function leavingText(how) {
  return `${words(how).verb}: saving your latest changes first…`;
}

/** The strip's text while the leave waits for the tab's signing. */
export function waitingText(how, work, msLeft) {
  const w = normalizeWork(work);
  const secs = Math.max(0, Math.ceil((Number(msLeft) || 0) / 1000));
  const why = w.sending || w.legs ? ` The ${w.symbol || 'pair'} → ETH swaps are signed with the wallets' keys, which leave this tab.` : '';
  return `${words(how).verb} once this tab has signed what it still owes: ${inFlightWords(w) || 'nothing left'} (up to ${secs} s). New sells are paused.${why}`;
}

/**
 * The confirmation shown before the keys leave anyway, or null when the leave
 * strands nothing:
 *   - still in flight after the wait (a sell not mined, a swap not sent);
 *   - proceeds a refused swap left in the pair token (session `owed`): it
 *     retries on its own, but only while the key is in this tab;
 *   - proceeds held by a wallet another device removed (session `stranded`):
 *     this tab may not sign for it at all, so it is named as stranded rather
 *     than as retrying.
 * `persisted`: the pair ledger is kept on this device (a passphrase vault
 * exists, ui/deps.js), so a later visit still lists the proceeds for Convert.
 * @param {'lock'|'disconnect'|'switch'} how
 * @param {object|null} work session.pendingWork() read after the wait
 * @param {{persisted?: boolean, waitedMs?: number}} [opts]
 * @returns {string|null}
 */
export function leaveWarning(how, work, { persisted = false, waitedMs = LEAVE_WAIT_MS } = {}) {
  const w = normalizeWork(work);
  const h = words(how);
  const sym = w.symbol || 'pair token';
  const lines = [];
  if (inFlight(w)) lines.push(`Still not done after ${Math.round(waitedMs / 1000)} s: ${inFlightWords(w)}.`);
  if (w.owed) {
    let when = '';
    if (w.retryInMs !== null) when = w.retryInMs < 1000 ? ' now' : ` in ${Math.ceil(w.retryInMs / 1000)} s`;
    lines.push(
      `${count(w.owed, 'wallet')} ${w.owed === 1 ? 'holds' : 'hold'} ${fmtUnits(w.owedAmount, w.decimals, 4)} ${sym} from sells this page has not turned into ETH yet: the swap was refused and retries on its own${when}.`
    );
  }
  if (w.stranded) {
    // Removed on another device: this tab may not sign for it at all, so there is no
    // retry to promise — and the row goes as soon as its last transaction settles.
    lines.push(
      `${count(w.stranded, 'wallet')} removed on another device ${w.stranded === 1 ? 'holds' : 'hold'} ${fmtUnits(w.strandedAmount, w.decimals, 4)} ${sym} this page can no longer swap: sell it from that ${sym} yourself.`
    );
  }
  if (!lines.length) return null;
  if (w.sending || w.legs || w.owed) {
    lines.push(`If you ${h.act} now, this tab can no longer sign those swaps, and the ${sym} stays in the wallets.`);
    lines.push(
      persisted
        ? `${h.back} and press Convert to turn it into ETH.`
        : `${h.back} in this tab and press Convert to turn it into ETH. Once this tab is closed or reloaded the page no longer lists it: you would have to sell the ${sym} yourself.`
    );
  } else {
    lines.push(`If you ${h.act} now, the click still being signed is not sent.`);
  }
  lines.push(`${h.Act} anyway? Cancel keeps everything as it is.`);
  return lines.join(' ');
}

/**
 * Wait until the tab has nothing left to sign, the visitor takes the leave
 * back, or `timeoutMs` passes. `read` is called on every poll (App passes a
 * function that also holds the sells of whatever session is open).
 * @param {{read: () => object|null, isCancelled?: () => boolean,
 *   onWait?: (work: object, msLeft: number) => void, sleep?: (ms: number) => Promise<void>,
 *   now?: () => number, timeoutMs?: number, pollMs?: number}} deps
 * @returns {Promise<'quiet'|'cancelled'|'timeout'>}
 */
export async function waitForQuiet({
  read,
  isCancelled = () => false,
  onWait = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  timeoutMs = LEAVE_WAIT_MS,
  pollMs = LEAVE_POLL_MS,
}) {
  const end = now() + timeoutMs;
  for (;;) {
    if (isCancelled()) return 'cancelled';
    const work = normalizeWork(read());
    if (!inFlight(work)) return 'quiet';
    const left = end - now();
    if (left <= 0) return 'timeout';
    onWait(work, left);
    await sleep(Math.min(pollMs, left));
  }
}
