import { DAY_MS } from './roles.js';

/**
 * Where a seed wallet stands — the one question the seed table is organised by.
 *
 * READY is a wallet funded at least `seasonDays` ago, from whichever run funded it:
 * the same `daysSinceFunded >= season` rule as the tab's "usable" count, so the Ready
 * section and that number can never disagree. Everything else is NOT READY, and says
 * why — which is the part an operator acts on.
 *
 * The table used to group by RUN instead, and an aged wallet from the latest run sat
 * under "New campaign" until a later run started. Read on screen, that was "the old
 * campaign did not go up". Grouping by state removes the question.
 *
 *   ready       funded 1+ day ago
 *   aging       funded, not a day old yet — with the hours it still needs
 *   waiting     in a running campaign, its transfer not sent yet (or the campaign
 *               not read yet — a claimed wallet is never shown as free)
 *   halted /    unfunded, and the campaign holding it is stopped for now — resuming
 *   paused      it in step 4 funds it
 *   cancelled   unfunded, its campaign cancelled — it will never be funded
 *   failed      its transfer was abandoned after the runner's retries — never funded
 *   unassigned  no campaign holds it
 *
 * A failed or cancelled wallet holds nothing and stays claimed, so no later campaign
 * can take it: it is safe to archive. `tone` names the existing `.fund-state` class
 * the row's chip uses — jade for ready (already true), amber for a wallet that will
 * never be funded (a shortfall), the outline for one still on its way, grey otherwise.
 */

const HOUR_MS = DAY_MS / 24;

// Order inside "Not ready yet": the wallets that need a decision first, so five failed
// ones are never buried under six hundred fresh ones; then those closest to ready.
const RANK = { failed: 0, cancelled: 1, halted: 2, paused: 3, aging: 4, waiting: 5, unassigned: 6 };

export function seedStatus(wallet, fact, { seasonDays = 1, now = Date.now() } = {}) {
  const w = wallet || {};
  if (w.daysSinceFunded != null) {
    if (w.daysSinceFunded >= seasonDays) return { key: 'ready', ready: true, rank: -1, label: 'ready', tone: 'in' };
    const fundedAt = Date.parse(w.fundedAt || '');
    const hoursLeft = Number.isFinite(fundedAt)
      ? Math.max(1, Math.ceil((fundedAt + seasonDays * DAY_MS - now) / HOUR_MS))
      : null;
    return {
      key: 'aging',
      ready: false,
      rank: RANK.aging,
      label: hoursLeft == null ? 'aging' : `aging · ${hoursLeft}h left`,
      tone: 'wait',
    };
  }

  const not = (key, label, tone = '') => ({ key, ready: false, rank: RANK[key], label, tone });
  if (fact?.status === 'abandoned') return not('failed', 'failed · never funded', 'part');
  if (!fact && !w.campaignId && !w.claimed) return not('unassigned', 'not in a campaign');
  switch (fact?.campaignStatus) {
    case 'cancelled':
      return not('cancelled', 'cancelled · never funded', 'part');
    case 'halted':
      return not('halted', 'campaign halted');
    case 'paused':
      return not('paused', 'campaign paused');
    default:
      return not('waiting', 'waiting', 'wait');
  }
}

/** The list in status order (see RANK); stable, and a copy — the input is not reordered. */
export function orderByStatus(list, statusOf) {
  return list
    .map((w, i) => ({ w, i, rank: statusOf(w).rank }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.w);
}

/** How many wallets are in each status: { unassigned: 600, failed: 5, … }. */
export function statusCounts(list, statusOf) {
  const out = {};
  for (const w of list) {
    const { key } = statusOf(w);
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/** The words the section header uses for each count, in display order. */
export const STATUS_WORDS = [
  ['failed', 'failed'],
  ['cancelled', 'cancelled'],
  ['halted', 'halted'],
  ['paused', 'paused'],
  ['aging', 'aging'],
  ['waiting', 'waiting'],
  ['unassigned', 'not in a campaign'],
];
