// THE LAUNCH'S QUOTE ASSET, AS AN ORDER OF WORK.
//
// A v2 launch can be priced in native ETH or in one of the factory's approved
// quote assets (NVDA / SPCX / AMD …). That single choice decides what almost
// every control above the launch MEANS:
//
//   · the Buy column is denominated in it (prepareV2 parses those numbers and
//     then demands the wallet HOLD that much of it);
//   · the Fund column is the ETH needed to BUY that much of it, priced against
//     a live pool — so it is a different number for every quote asset;
//   · the curve, the market cap and the graduation threshold are all in it;
//   · the dev buy is spent in it, out of the dev wallet's own balance;
//   · every bundle wallet has to be swapped into it before the launch is armed.
//
// It used to be picked in the LAST step, so the operator jumped to the launch
// form, chose the asset, and came back up to fund and swap. This file is the
// pure half of moving that decision to the FRONT: the order of the stations, the
// one-line precondition each station states, whether the controls in it can run
// at all, and — the dangerous edge — what changing the quote asset after wallets
// already hold one would cost.
//
// Pure, and unit-tested beside this file, for the same reason pairCurve.js and
// pairBalance.js are: it decides copy an operator acts on and gating a spend
// hangs off, and neither should be provable only by clicking the console.
//
// Reads nothing, writes nothing, fetches nothing, and moves no money.

import { recoverTargets, pairStatus } from './pairBalance.js';

/**
 * Every station this console knows about, in the one order they are worked.
 *
 * The two conditional ones are conditional for different reasons. `disperser`
 * belongs to a launcher that batches its funding (v1); v2 funds with individual
 * transfers and has no such contract. `quote` belongs to a launcher that can be
 * priced in something other than ETH.
 */
export const ALL_STEPS = ['quote', 'dev', 'disperser', 'wallets', 'fund', 'launch', 'sell'];

/**
 * The step keys this launcher actually has, in order.
 *
 * The numbering closes the gap rather than skipping a number — that is App's
 * job — so this returns keys and never positions. A step that is not in this
 * list is not in the plan at all: it is not drawn, not numbered and not waited
 * on.
 *
 * @param {object} o
 * @param {boolean} o.dispersers does this launcher batch funding through a contract
 * @param {boolean} o.quote      can this launcher be priced in something other than ETH
 * @returns {string[]}
 */
export function stepOrder({ dispersers = false, quote = false } = {}) {
  return ALL_STEPS.filter(
    (key) => (key !== 'disperser' || dispersers) && (key !== 'quote' || quote)
  );
}

/**
 * What the bundle is holding of the launch's quote asset right now.
 *
 * A thin, named reading of the pair column the listing already carries — the
 * same figures the recovery control offers to sell — so the quote step, the
 * change dialog and the launch form all state ONE number rather than three
 * derivations of it. `unknown` is wallets whose pair balance was not read; they
 * are never counted as holding and never counted as empty.
 *
 * @param {Array<object>} bundle the bundle wallets, as /wallets returned them
 * @returns {{wallets: number, total: string, unknown: number}}
 */
export function pairHoldings(bundle) {
  const { targets, total, unknown } = recoverTargets(bundle);
  return { wallets: targets.length, total, unknown };
}

/**
 * How many wallets that are meant to buy do NOT hold enough of the quote asset.
 *
 * This is exactly the state preflight drops a wallet for ("holds 0.0 NVDA,
 * needs 0.029125 NVDA — skipped"), asked at the moment of arming rather than
 * discovered in the report afterwards. Same comparison the pair column makes,
 * out of the same file, so the two can never disagree.
 *
 * A row on "all − gas" names no requirement here — its amount is resolved
 * server-side from whatever the wallet holds — so it is neither short nor ok.
 *
 * @param {Array<object>} bundle bundle wallets carrying `pairBalance`
 * @param {object} rows          App's per-wallet { mode, buy } map
 * @returns {{short: number, ready: number, unknown: number, buying: number}}
 */
export function shortOfPair(bundle, rows = {}) {
  let short = 0;
  let ready = 0;
  let unknown = 0;
  let buying = 0;
  for (const w of bundle || []) {
    const row = rows[w?.id] || {};
    if ((row.mode ?? 'fixed') === 'all') continue;
    if (!(Number(row.buy) > 0)) continue;
    buying += 1;
    const status = pairStatus(w?.pairBalance, row.buy);
    if (status === 'ok') ready += 1;
    else if (status === 'short') short += 1;
    else unknown += 1;
  }
  return { short, ready, unknown, buying };
}

/**
 * WHAT CHANGING THE QUOTE ASSET WOULD COST — the one genuinely dangerous edge
 * in moving this decision around.
 *
 * Three separate things go stale, and they go stale in different ways:
 *
 *   RESTATED. The Buy column keeps its numbers and they silently start meaning a
 *   different token. 12 NVDA and 12 SPCX are the same digits and not remotely
 *   the same launch.
 *
 *   REPRICED. The Fund column was priced against the OLD pool by the endpoint
 *   that would have spent it. Against the new one it is simply a different
 *   number.
 *
 *   STRANDED. Wallets that already bought the old asset keep holding it — and
 *   this console can only READ the balance of the asset the launch is priced in
 *   (the listing takes exactly one `pairToken`), so that holding goes invisible
 *   the moment the pair changes. It is not lost: the recovery control sells it
 *   back to ETH, but only while the launch is priced in it. So the honest
 *   instruction is "sell it back BEFORE you switch, or switch back to recover".
 *
 * `needsConfirm` is false for the case that costs nothing — no wallet holds the
 * old asset and nothing has been typed — so an operator who changes their mind
 * before doing any work is not made to read a dialog about nothing.
 *
 * @param {object} o
 * @param {{address: string, symbol: string}|null} o.from the asset now
 * @param {{address: string, symbol: string}|null} o.to   the asset being picked
 * @param {{wallets: number, total: string}} o.holders    pairHoldings() of the bundle
 * @param {number} o.restated  bundle rows with a Buy amount typed
 * @param {number} o.repriced  bundle rows with a Fund amount typed
 */
export function pairChangeImpact({
  from,
  to,
  holders = { wallets: 0, total: '0' },
  restated = 0,
  repriced = 0,
} = {}) {
  const same =
    String(from?.address || '').toLowerCase() === String(to?.address || '').toLowerCase();
  // Only a non-native asset can be stranded: ETH is what every wallet holds
  // anyway and what the whole console is denominated in when native.
  const leavingNamed = Boolean(from?.symbol) && !from?.native;
  const strands = !same && leavingNamed && holders.wallets > 0
    ? { symbol: from.symbol, address: from.address, wallets: holders.wallets, total: holders.total }
    : null;
  return {
    same,
    strands,
    restated: same ? 0 : restated,
    repriced: same ? 0 : repriced,
    needsConfirm: !same && Boolean(strands || restated > 0 || repriced > 0),
  };
}

/**
 * The record the console keeps of an asset it has just walked away from.
 *
 * It has to be REMEMBERED rather than re-read, because after the change the
 * listing carries the new asset's balances and the old holding is not visible
 * anywhere. Null when there is nothing to remember, which is the usual case.
 */
export function strandedRecord(impact) {
  return impact?.strands ? { ...impact.strands } : null;
}

/**
 * Is a remembered stranding now settled? True once the launch is priced in that
 * asset again AND nothing is holding it — the only two facts that can honestly
 * retire the warning, and both of them are live readings rather than a guess.
 */
export function strandingCleared(stranded, currentAddress, holders) {
  if (!stranded) return true;
  if (String(stranded.address || '').toLowerCase() !== String(currentAddress || '').toLowerCase())
    return false;
  return (holders?.wallets ?? 0) === 0;
}

/** "step 3" / "an earlier step" when the plan does not have that station. */
function stepName(nums, key) {
  const n = nums?.[key];
  return n ? `step ${n}` : 'the step above';
}

/**
 * ONE LINE PER STATION: what it is for, and what has to be true before its
 * controls do anything.
 *
 * Every step says this, in the same voice, in the same place — that consistency
 * is the point. Where a step cannot run, the line names the step that fixes it
 * rather than leaving a disabled control to be hovered for a tooltip.
 *
 * Returns null when there is nothing to require: a finished step is not asked to
 * keep justifying itself.
 *
 * @param {string} key the step key
 * @param {object} f   the live facts (see the tests beside this file)
 * @returns {string|null}
 */
export function stepNeed(key, f = {}) {
  const nums = f.nums || {};
  const sym = f.pairSymbol || 'ETH';
  const paired = Boolean(f.paired);

  if (key === 'quote') {
    return paired
      ? `Nothing has to be true first — this is the launch's first decision. Priced in ${sym}: ` +
          `every Buy amount, the dev buy and the market cap below are in ${sym}, not ETH.`
      : 'Nothing has to be true first — this is the launch\'s first decision. Priced in native ETH: ' +
          'the bundle buys with the ETH you fund it with, and there is no second token to hold.';
  }

  if (key === 'dev') {
    if (f.hasDev) return null;
    return paired
      ? `Needs nothing first. It signs the launch and pays every ETH cost — and on a ${sym}-priced ` +
          `launch it must also hold ${sym} itself, because the dev buy is spent in ${sym}.`
      : 'Needs nothing first. It signs the launch and pays every ETH cost — the launch fee, the ' +
          'funding run and the gas.';
  }

  if (key === 'disperser') {
    if (!f.hasDev) return `Needs a dev wallet with ETH to pay for the deploy — ${stepName(nums, 'dev')}.`;
    if (f.dispersers > 0) return null;
    return 'Optional. Without one, funding sends one transfer per wallet instead of batching them.';
  }

  if (key === 'wallets') {
    if (!f.hasDev) return `Needs a dev wallet first — ${stepName(nums, 'dev')}.`;
    if (!f.bundleCount) return 'Needs bundle wallets. Generate them here — nothing below spends until you fund them.';
    return paired
      ? `Sized in ${sym}: the Buy column is ${sym}, the Fund column is always ETH. Fund in ` +
          `${stepName(nums, 'fund')}, then buy ${sym} here, before the launch.`
      : 'Sized here: the Buy column is what each wallet spends, the Fund column is the ETH it needs ' +
          'to spend it.';
  }

  if (key === 'fund') {
    if (!f.bundleCount) return `Needs bundle wallets — ${stepName(nums, 'wallets')}.`;
    if (!f.fundTargets)
      return `Needs a Fund amount against at least one wallet — type one in ${stepName(nums, 'wallets')}, or press Distribute there.`;
    if (f.needsDisperser && !f.dispersers)
      return `Needs a disperser contract — ${stepName(nums, 'disperser')} — because this launcher funds through one.`;
    return paired
      ? `Sends ETH only. It is what each wallet then spends buying ${sym} back in ${stepName(nums, 'wallets')}.`
      : 'Sends ETH from the dev wallet to each bundle wallet, using the Fund column above.';
  }

  if (key === 'launch') {
    // A launch that has already run is not still waiting for a Buy amount. Every
    // other station's line stays true after the fact — "the Buy column is NVDA"
    // is a statement, not a request — but this one is a list of prerequisites
    // for something that has happened, and reading it afterwards is noise.
    if (f.launched) return null;
    const missing = f.draftMissing || [];
    if (missing.length) return `Needs ${listOf(missing)} before anything here will run.`;
    if (!f.buyTargets) return `Needs a Buy amount against at least one wallet — ${stepName(nums, 'wallets')}.`;
    if (paired && f.shortOfPair > 0)
      return (
        `Needs every buying wallet to already hold its ${sym}: ${f.shortOfPair} do not, and preflight ` +
        `drops them. Buy it in ${stepName(nums, 'wallets')} — "Pair funding".`
      );
    return null;
  }

  if (key === 'sell') {
    return f.sellCount
      ? null
      : 'Needs a launched token a bundle wallet still holds. Nothing is listed until then.';
  }

  return null;
}

/** "a name, a symbol and a logo" */
export function listOf(xs) {
  const list = (xs || []).filter(Boolean);
  if (list.length < 2) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * WHETHER THE FUNDING RUN CAN RUN, and why not when it cannot.
 *
 * The two conditions were already in the panel, one of them only as a `title`
 * nobody sees without a mouse. They live here so the button's disabled state and
 * the sentence beside it come from one expression and cannot drift, and so the
 * combination that matters — amounts typed but no disperser deployed — is
 * pinned by a test rather than by a click.
 *
 * @param {object} o
 * @param {number} o.targets        wallets with a Fund amount above zero
 * @param {boolean} o.needsDisperser does this launcher fund through a contract
 * @param {number} o.dispersers     how many are deployed
 * @param {object} o.nums           step key -> number, for naming a step
 * @returns {{enabled: boolean, why: string|null}}
 */
export function fundGate({ targets = 0, needsDisperser = false, dispersers = 0, nums } = {}) {
  if (!targets)
    return {
      enabled: false,
      why: `Nothing to send: no wallet has a Fund amount. Type one in ${stepName(nums, 'wallets')}, or press Distribute there.`,
    };
  if (needsDisperser && !dispersers)
    return {
      enabled: false,
      why: `No disperser contract deployed — this launcher funds through one. Deploy it in ${stepName(nums, 'disperser')}.`,
    };
  return { enabled: true, why: null };
}

/**
 * WHETHER THE LAUNCH STEP'S TWO BUTTONS CAN RUN, and why not when they cannot.
 *
 * Preflight and the launch itself refuse for overlapping but different reasons —
 * preflight signs and sends nothing, so neither the arm switch nor the exemption
 * cap stops it — and both used to state their reason only in a `title`. The
 * order of the reasons is deliberate: the one nearest to being fixed is said
 * first, so an operator is never told about an arm switch while three fields are
 * still empty.
 *
 * @returns {{preflight: {enabled, why}, fire: {enabled, why}}}
 */
export function launchGate({
  draftMissing = [],
  uploading = false,
  overExempt = 0,
  live = false,
  armed = false,
} = {}) {
  const missing = draftMissing.filter(Boolean);
  const notReady = missing.length
    ? `Needs ${listOf(missing)} first.`
    : uploading
      ? 'The logo is still uploading.'
      : null;

  const fireWhy = notReady
    ? notReady
    : overExempt > 0
      ? `${overExempt} too many wallets are declared exempt — the launch would revert. Remove ${overExempt}.`
      : live && !armed
        ? 'Flip Arm first — this spends real funds.'
        : null;

  return {
    preflight: { enabled: !notReady, why: notReady },
    fire: { enabled: !fireWhy, why: fireWhy },
  };
}
