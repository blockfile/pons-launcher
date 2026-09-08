// WHAT IS STILL MISSING FROM EACH BUNDLE WALLET — and the Fund column that
// would send exactly that and nothing more.
//
// THE RUN THIS EXISTS FOR. A funding run dies partway: the dev wallet sent 7 of
// 31 transfers and threw. Every amount in the Fund column is still the FULL
// amount, and the funding routes send it as a raw value — backend
// wallets/funding.js does `parseEther(String(t.amountEth))` and nothing anywhere
// reads the destination's balance first. So re-running the same list pays those
// 7 wallets twice. The operator's only defence today is to hand-edit 31 fields,
// and one mistyped row over-funds a wallet.
//
// So the column is rewritten to the REMAINING SHORTFALL: `max(0, need - have)`
// per wallet, 0 for the ones already holding their target. A resumed run then
// sends only what is missing, by construction rather than by the operator's
// care.
//
// THREE THINGS THIS FILE IS CAREFUL ABOUT, in the order they can hurt:
//
//   ROUNDING GOES UP, NEVER DOWN. Under-funding is not a smaller transfer, it is
//   a wallet preflight silently DROPS from the run — the failure the whole
//   funding area exists to prevent — while over-funding by a millionth of an ETH
//   costs nothing and comes back on the sweep. See `ceilTo`.
//
//   ONE SNAPSHOT, ONE WRITE. `short` is measured AGAINST the Fund column, so
//   rewriting Fund destroys the reading it came from. `topUpPlan` therefore
//   computes every wallet's figure from the column as it stands and returns them
//   ALL as one patch map; it never walks a column it is mutating.
//
//   AN UNREAD BALANCE IS NOT ZERO. A wallet whose balance could not be read is
//   left alone and named, because "0 held" is a claim, and the claim would be
//   that a funded wallet is empty — which is precisely how the double-send this
//   file prevents would get back in through the other door.
//
// AND IT IS IDEMPOTENT, which needs the `targetFund` argument to be true. After
// one application the column no longer holds the target, it holds the remainder;
// subtracting the balance from THAT a second time under-funds by whatever the
// wallet already held. So an applied plan hands back `nextTarget` — what each
// figure was computed against — and feeding it in reproduces the same column
// exactly, however many times it is pressed. See the test beside this file.
//
// Pure: reads nothing, writes nothing, fetches nothing, moves no money. It
// returns figures and patches; the panel does the writing.
//
// NOT `ethShortfall` (quoteAsset.js), which is a different question with a
// different gate: that one asks whether a wallet can afford the SWAP it is about
// to make, keys off the Buy column, prefers the dry run's `swapEth` over
// anything typed, and counts an unread balance as zero because it is sizing a
// warning rather than an amount to send. This one keys off the Fund column, has
// no other source of truth, and must never treat unread as empty because what it
// produces is spent.

import { toUnits, fromUnits } from './pairBalance.js';

// The scale pairBalance.js works in. Every figure here is an 18-place integer,
// so a balance formatted from wei and an amount typed by hand are compared as
// integers and never as floats.
const PLACES = 18;

// The decimals a WRITTEN Fund figure carries. Six, the same as every other
// number this console puts in that column, and well inside what parseEther will
// accept on the way out.
export const WRITE_PLACES = 6;

/**
 * Round a shortfall to `places` decimals, ALWAYS UPWARD.
 *
 * The direction is the whole point and it is not symmetric. A figure a
 * rounding-unit ABOVE the true shortfall over-sends 0.000001 ETH, which lands in
 * the wallet and comes back on the sweep. A figure a rounding-unit BELOW it
 * leaves the wallet short of what its buy demands, and a short wallet is not a
 * failed run — preflight drops it and the launch simply comes out smaller than
 * it was sized for, with the reason visible only afterwards in a receipt. So the
 * error is spent in the direction that costs a millionth of an ETH.
 */
function ceilTo(raw, places) {
  const p = Math.max(0, Math.min(PLACES, Math.floor(Number(places)) || 0));
  const step = 10n ** BigInt(PLACES - p);
  if (step === 1n) return raw;
  return ((raw + step - 1n) / step) * step;
}

/**
 * WHAT EACH BUNDLE WALLET IS OWED AND WHAT HAS LANDED — the one implementation
 * of `short` in this console's funding column.
 *
 * `need` is the Fund column, deliberately and not a second set of amounts: two
 * places to type the same number is how they diverge. `targetFund` overrides it
 * per wallet with the figure a previous shortfall was computed against, which is
 * what keeps a second application from subtracting the same balance twice.
 *
 * A wallet with no Fund amount is not in this question at all — nothing is being
 * asked of it, so it is neither short nor funded and never appears in `rows`.
 *
 * @param {Array<object>} bundle wallets carrying { id, address, balanceEth }
 * @param {object} rows          App's per-wallet { fund } map
 * @param {{targetFund?: Record<string,string>}} o
 * @returns {{rows: Array<object>, targets: number, funded: number, short: number,
 *            unread: number, needTotal: string, haveTotal: string, shortTotal: string}}
 */
export function fundShortfall(bundle = [], rows = {}, { targetFund = {} } = {}) {
  const out = [];
  let needRaw = 0n;
  let haveRaw = 0n;
  let shortRaw = 0n;
  let funded = 0;
  let short = 0;
  let unread = 0;

  for (const w of bundle || []) {
    const id = w?.id;
    const remembered = targetFund?.[id];
    const target = remembered === undefined || remembered === null ? rows?.[id]?.fund : remembered;
    const need = toUnits(target);
    // No target, an unparseable one, or a zero: nothing is being asked of this
    // wallet, and a wallet nothing is asked of cannot be short.
    if (need === null || need === 0n) continue;
    needRaw += need;

    const have = toUnits(w?.balanceEth);
    if (have === null) {
      unread += 1;
      out.push({
        walletId: id,
        address: w?.address,
        need: fromUnits(need),
        have: null,
        short: null,
        state: 'unread',
      });
      continue;
    }
    haveRaw += have;

    // THE ARITHMETIC. Scaled integers on both sides, same asset on both sides.
    const missing = have >= need ? 0n : need - have;
    shortRaw += missing;
    if (missing === 0n) funded += 1;
    else short += 1;

    out.push({
      walletId: id,
      address: w?.address,
      need: fromUnits(need),
      have: fromUnits(have),
      short: fromUnits(missing),
      state: missing === 0n ? 'funded' : have > 0n ? 'partial' : 'waiting',
    });
  }

  return {
    rows: out,
    targets: out.length,
    funded,
    short,
    unread,
    needTotal: fromUnits(needRaw),
    // Neither total counts a wallet whose balance was not read: an unknown is
    // not a zero and adding it as one would understate what has landed.
    haveTotal: fromUnits(haveRaw),
    shortTotal: fromUnits(shortRaw),
  };
}

/**
 * THE COLUMN, REWRITTEN TO WHAT IS STILL MISSING — as one patch map, computed
 * from the column as it stands right now.
 *
 * Every figure comes out of the single `fundShortfall` reading above, taken
 * BEFORE a patch is built, and they are returned together so the caller applies
 * them in one step. Nothing here reads a value it has written, and nothing here
 * writes: a wallet's row is patched by the panel, from this map.
 *
 * `nextTarget` is what each figure was computed against, to be remembered
 * alongside the write. Hand it back on the next call and the plan is exactly
 * idempotent; lose it and a second application under-funds every partially
 * funded wallet by whatever it was already holding.
 *
 * `unread` wallets get NO patch — not even a zero. A zero reads as a decision,
 * and no decision can be made about a balance nobody has read.
 *
 * @param {Array<object>} bundle wallets carrying { id, address, balanceEth }
 * @param {object} rows          App's per-wallet { fund } map
 * @param {{targetFund?: Record<string,string>, places?: number}} o
 */
export function topUpPlan(bundle = [], rows = {}, { targetFund = {}, places = WRITE_PLACES } = {}) {
  const reading = fundShortfall(bundle, rows, { targetFund });

  // THE COLUMN AS IT STANDS, summed before anything is planned against it. This
  // is the figure the operator is resuming from — "the total was this, and after
  // the rewrite it is that" is the only way to see the number went DOWN.
  let beforeRaw = 0n;
  for (const w of bundle || []) beforeRaw += toUnits(rows?.[w?.id]?.fund) ?? 0n;

  const patches = {};
  const nextTarget = {};
  const unread = [];
  let zeroed = 0;
  let carrying = 0;
  let changed = 0;
  let afterRaw = 0n;

  for (const r of reading.rows) {
    if (r.state === 'unread') {
      unread.push({ walletId: r.walletId, address: r.address, need: r.need });
      continue;
    }
    const rounded = ceilTo(toUnits(r.short) ?? 0n, places);
    patches[r.walletId] = { fund: fromUnits(rounded) };
    nextTarget[r.walletId] = r.need;
    afterRaw += rounded;
    if (rounded === 0n) zeroed += 1;
    else carrying += 1;
    if ((toUnits(rows?.[r.walletId]?.fund) ?? 0n) !== rounded) changed += 1;
  }

  // Wallets this plan does not touch keep whatever their Fund says, so they are
  // still part of what the run would send. Counted here rather than assumed
  // absent, because an unread balance leaves a live amount in the column.
  for (const w of bundle || []) {
    if (patches[w?.id]) continue;
    afterRaw += toUnits(rows?.[w?.id]?.fund) ?? 0n;
  }

  return {
    patches,
    nextTarget,
    unread,
    zeroed,
    carrying,
    changed,
    sendBefore: fromUnits(beforeRaw),
    sendAfter: fromUnits(afterRaw),
    // Positive when the rewrite takes money OFF the run, which is the resuming
    // case. Negative is possible and honest: a wallet that has been drained since
    // the amounts were typed needs more, not less.
    saved: fromUnits(beforeRaw - afterRaw),
    reading,
  };
}
