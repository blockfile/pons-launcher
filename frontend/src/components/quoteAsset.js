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

import { recoverTargets, pairStatus, toUnits, fromUnits } from './pairBalance.js';

/**
 * Every station this console knows about, in the one order they are worked.
 *
 * The three conditional ones are conditional for different reasons. `disperser`
 * belongs to a launcher that batches its funding (v1); v2 funds with individual
 * transfers and has no such contract. `quote` belongs to a launcher that can be
 * priced in something other than ETH. `swap` belongs to a launch that IS priced
 * in something other than ETH, and it is the station this file was extended for.
 *
 * WHY THE SWAP IS A STATION AND NOT A PARAGRAPH. Relay moves native ETH and
 * nothing else — backend/src/relay/funding.js pins both ends to NATIVE — and the
 * funding run sends ETH transfers. So the quote asset can never be SENT to a
 * bundle wallet: every wallet has to BUY its own, locally, with its own ETH,
 * between being funded and being armed. That is a third thing to do, in its own
 * place in the order, and drawing it as a box inside the wallet table left the
 * console explaining an inversion in prose ("run this AFTER the step below")
 * instead of stating an order.
 */
export const ALL_STEPS = ['quote', 'dev', 'disperser', 'wallets', 'fund', 'swap', 'launch', 'sell'];

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
 * @param {boolean} o.paired     is it priced in something other than ETH RIGHT NOW
 * @returns {string[]}
 */
export function stepOrder({ dispersers = false, quote = false, paired = false } = {}) {
  return ALL_STEPS.filter(
    (key) =>
      (key !== 'disperser' || dispersers) &&
      (key !== 'quote' || quote) &&
      // Both, deliberately: a swap station on a launcher with no quote asset to
      // swap into would be a station for nothing. `paired` is a live reading of
      // what the launch is priced in, so this station appears and disappears
      // with the picker in the first one.
      (key !== 'swap' || (quote && paired))
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
          `every Buy amount, the dev buy and the market cap below are in ${sym}, not ETH — and ${sym} ` +
          `can only be BOUGHT by a wallet, never sent to it, which is why ${stepName(nums, 'swap')} exists.`
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
      ? `Sized in ${sym}: the Buy column is ${sym}, the Fund column is always ETH. Sized here, ` +
          `funded with ETH in ${stepName(nums, 'fund')}, swapped into ${sym} in ${stepName(nums, 'swap')}.`
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
      ? `Sends ETH, and only ETH — ${sym} cannot be transferred to a bundle wallet at all. This is the ` +
          `ETH each wallet then spends buying its own ${sym} in ${stepName(nums, 'swap')}.`
      : 'Sends ETH from the dev wallet to each bundle wallet, using the Fund column above.';
  }

  // THE STATION THE OPERATOR'S QUESTION IS ABOUT: "it convert to nvdia, but nvida
  // cant be send tru relay so it needs eth to transfer to bundle right?" — right,
  // and that is the whole reason this is a station rather than a note inside the
  // wallet table. Relay moves NATIVE at both ends (backend relay/funding.js) and
  // the funding run sends ETH transfers, so the quote asset reaches a bundle
  // wallet by being bought BY it and no other way.
  //
  // Its precondition is therefore ETH IN THE WALLETS, which is the step above it —
  // so that is what this line says, with how many wallets are short and where the
  // ETH comes from. It is the sentence the dead "Buy NVDA for 0 wallets" button
  // was hiding in a hint underneath itself.
  if (key === 'swap') {
    // A launch that has already run is not still waiting to be swapped into —
    // the same rule the launch station keeps, and for the same reason: a list of
    // prerequisites for something that has happened is noise.
    if (f.launched) return null;
    if (!f.bundleCount) return `Needs bundle wallets — ${stepName(nums, 'wallets')}.`;
    if (!f.swapTargets)
      return `Needs a Buy amount against at least one wallet — size the bundle in ${stepName(nums, 'wallets')}.`;
    if (f.shortOfEth > 0)
      return (
        `${f.shortOfEth} of ${f.swapTargets} wallet${f.swapTargets === 1 ? '' : 's'} ` +
        `${f.shortOfEth === 1 ? 'has' : 'have'} too little ETH to buy their ${sym}` +
        (f.missingEth ? `, ${f.missingEth} ETH missing in total` : '') +
        `. Send it in ${stepName(nums, 'fund')} — each wallet buys its own ${sym} with its own ETH, ` +
        `because ${sym} cannot be sent to a wallet.`
      );
    if (f.shortOfPair === 0) return null;
    return (
      `Each wallet buys its own ${sym} here, with the ETH it is already holding — ${sym} cannot be ` +
      `sent to a wallet, only bought by it. Run this after ${stepName(nums, 'fund')} and before ` +
      `arming ${stepName(nums, 'launch')}.`
    );
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
        `drops them. Buy it in ${stepName(nums, 'swap')}.`
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
 * HOW MUCH ETH THE BUNDLE IS SHORT OF BEING ABLE TO BUY ITS QUOTE ASSET.
 *
 * The arithmetic behind the operator's own reading of the screen: 31 wallets
 * holding 0.000478 ETH each, each needing about 0.0107, and a control offering to
 * buy for "0 wallets". The count and the missing total are one subtraction, and
 * this is the one place it is done — the station's headline, its gate and the
 * plan's one-line precondition all read it, so they cannot disagree.
 *
 * TWO SOURCES FOR ONE REQUIREMENT, in order of authority:
 *
 *   THE DRY RUN. `swapEth` is what that wallet's ETH→pair swap costs, sized and
 *   quoted by the endpoint that will spend it, and `gasReserveEth` is what it
 *   must keep on top — the same figure the endpoint's own skipped-short refusal
 *   is measured against. When the plan is on screen, that is the requirement.
 *
 *   THE FUND COLUMN. Before the swap has been priced there is still a number:
 *   whatever the fill wrote (which came from this same dry run) or the operator
 *   typed. It is what they intend to send, so it is the honest answer to "have
 *   these wallets got enough yet".
 *
 * A wallet with neither is `unknown`: it is never counted short, because short is
 * the state that turns a station's headline into a refusal.
 *
 * Wallets the plan already settled — holding their ${pair} or swapped this run —
 * have no swap left to fund and are counted ready. A row on "all − gas" names no
 * amount at all and is not in this question, exactly as it is not in shortOfPair.
 *
 * Scaled integers, not floats, for the same reason pairBalance.js works that way:
 * "short" gates a control, and a control must not arm or refuse on one part in
 * 10^17.
 *
 * @param {object} o
 * @param {Array<object>} o.bundle bundle wallets carrying `balanceEth`
 * @param {object} o.rows          App's per-wallet { mode, buy, fund } map
 * @param {object|null} o.plan     the swap-to-pair dry run, when there is one
 * @returns {{ready: number, short: number, unknown: number, targets: number,
 *            missing: string, need: string}}
 */
export function ethShortfall({ bundle = [], rows = {}, plan = null } = {}) {
  const reserve = toUnits(plan?.gasReserveEth) ?? 0n;
  const priced = new Map((plan?.results || []).map((r) => [r.walletId, r]));

  let ready = 0;
  let short = 0;
  let unknown = 0;
  let targets = 0;
  let missingRaw = 0n;
  let needRaw = 0n;

  for (const w of bundle || []) {
    const row = rows[w?.id] || {};
    if ((row.mode ?? 'fixed') === 'all') continue;
    if (!(Number(row.buy) > 0)) continue;
    targets += 1;

    const r = priced.get(w?.id);
    // Nothing left to buy for this wallet, so nothing left to fund it with.
    if (r && (r.status === 'skipped-already-funded' || r.status === 'swapped')) {
      ready += 1;
      continue;
    }

    const swap = r ? toUnits(r.swapEth) : null;
    const typed = toUnits(row.fund);
    const requirement = swap !== null ? swap + reserve : typed !== null && typed > 0n ? typed : null;
    if (requirement === null) {
      unknown += 1;
      continue;
    }

    needRaw += requirement;
    const held = toUnits(w?.balanceEth) ?? 0n;
    if (held >= requirement) ready += 1;
    else {
      short += 1;
      missingRaw += requirement - held;
    }
  }

  return {
    ready,
    short,
    unknown,
    targets,
    missing: fromUnits(missingRaw),
    need: fromUnits(needRaw),
  };
}

/**
 * WHETHER THE SWAP STATION CAN BUY ANYTHING, and why not when it cannot.
 *
 * The rule this exists to enforce: a control that would do nothing is not offered
 * as though it would. The station used to draw "Buy NVDA for 0 wallets" as a
 * button with the blocking reason in small text beneath it; now the reason IS the
 * station's content and the action is visibly unavailable until it can act.
 *
 * The order of the reasons is the order they can be fixed in, nearest first —
 * the same rule launchGate keeps — so an operator is never told about a thin pool
 * while no wallet has an amount typed.
 *
 * @returns {{enabled: boolean, why: string|null, blocked: string|null}}
 *   `why` is the sentence; `blocked` is a short key for the headline, or null
 *   when the station is ready.
 */
export function swapGate({
  symbol = 'the quote asset',
  bundleCount = 0,
  targets = 0,
  allMode = 0,
  funding = { short: 0, missing: '0' },
  plan = null,
  error = '',
  nums,
} = {}) {
  const no = (blocked, why) => ({ enabled: false, why, blocked });

  if (!bundleCount)
    return no('wallets', `No bundle wallets yet — generate them in ${stepName(nums, 'wallets')}.`);

  if (!targets)
    return no(
      'amounts',
      allMode > 0
        ? `No wallet names an amount to buy: all ${allMode} are on "all − gas", which spends whatever ` +
            `${symbol} balance a wallet has and so sizes no swap. Set a Buy amount in ${stepName(nums, 'wallets')}.`
        : `No wallet has a Buy amount yet — fill the Buy column in ${stepName(nums, 'wallets')}.`
    );

  // THE SHORTFALL REFUSES ONLY WHEN IT REFUSES EVERYTHING. A bundle where 20 of
  // 31 wallets can pay is still a run worth making — the other 11 are reported
  // as skipped, exactly as the endpoint would report them — so this fires when
  // there is no priced plan yet, or when the plan can buy for nobody. Blocking a
  // partly-funded bundle outright would be the same defect in the other
  // direction: a live control made dead.
  if (funding.short > 0 && (!plan || plan.wouldSwap === 0))
    return no(
      'eth',
      `${funding.short} wallet${funding.short === 1 ? '' : 's'} ${funding.short === 1 ? 'has' : 'have'} ` +
        `too little ETH to buy ${symbol} — ${Number(funding.missing).toFixed(6)} ETH missing in total. ` +
        `Send it in ${stepName(nums, 'fund')}: this station spends each wallet's OWN ETH, and ${symbol} ` +
        'cannot be transferred to a wallet at all.'
    );

  if (error) return no('price', `Could not price this: ${error}`);
  if (!plan) return no('pricing', `Pricing ${targets} wallet(s) against the live ${symbol} pool…`);

  if (plan.wouldSwap === 0)
    return no(
      'nothing',
      plan.skippedAlreadyFunded >= targets
        ? `Every wallet already holds its ${symbol} — there is nothing left to buy.`
        : `No wallet can be bought for right now. ${refusals(plan, symbol)}`
    );

  return { enabled: true, why: null, blocked: null };
}

/** The plan's own refusals, as a sentence rather than as four dangling clauses. */
function refusals(plan, symbol) {
  const parts = [];
  if (plan?.skippedAlreadyFunded > 0) parts.push(`${plan.skippedAlreadyFunded} already hold theirs`);
  if (plan?.skippedShort > 0) parts.push(`${plan.skippedShort} are short of ETH`);
  if (plan?.skippedImpact > 0)
    parts.push(`${plan.skippedImpact} were refused — the ${symbol} pool is too thin for that size`);
  if (plan?.failed > 0) parts.push(`${plan.failed} could not be priced`);
  return parts.length ? `${listOf(parts)}.` : 'Nothing was sent.';
}

/**
 * WHETHER THE RECOVERY CAN SELL ANYTHING. The mirror of swapGate, and it exists
 * for the same defect: "Sell NVDA from 0 wallets" is not an offer.
 */
export function recoverGate({ symbol = 'the quote asset', holders = 0, plan = null, error = '' } = {}) {
  if (!holders)
    return { enabled: false, why: `No bundle wallet holds any ${symbol}.`, blocked: 'empty' };
  if (error) return { enabled: false, why: `Could not price this: ${error}`, blocked: 'price' };
  if (!plan)
    return {
      enabled: false,
      why: `Pricing ${holders} wallet(s) against the live ${symbol} pool…`,
      blocked: 'pricing',
    };
  if (plan.wouldSwap === 0)
    return {
      enabled: false,
      why: `Nothing can be sold right now. ${sellRefusals(plan, symbol)}`,
      blocked: 'nothing',
    };
  return { enabled: true, why: null, blocked: null };
}

function sellRefusals(plan, symbol) {
  const parts = [];
  if (plan?.skippedImpact > 0)
    parts.push(`${plan.skippedImpact} were refused — the ${symbol} pool is too thin for that size`);
  if (plan?.skippedDust > 0) parts.push(`${plan.skippedDust} hold dust worth less than the gas to sell it`);
  if (plan?.skippedShort > 0) parts.push(`${plan.skippedShort} are short of gas for the sale`);
  if (plan?.skippedEmpty > 0) parts.push(`${plan.skippedEmpty} hold none`);
  if (plan?.failed > 0) parts.push(`${plan.failed} could not be priced`);
  return parts.length ? `${listOf(parts)}.` : 'Nothing was sent.';
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
