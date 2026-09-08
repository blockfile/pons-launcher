// AUTO-FILL — a typed total becomes one Buy amount per bundle wallet, and each
// wallet's Fund follows from it.
//
// Pure and unit-tested (autoFill.test.js) because this is the seam where the
// console's two currencies meet, and that seam is where the bug was: the Buy
// column is denominated in the LAUNCH'S QUOTE ASSET — ETH on a native launch, the
// pair token (NVDA / SPCX / AMD …) on a paired one — while Fund is ALWAYS ETH.
// Adding those two together produced a Fund column that was a meaningless number
// on every paired launch. Nothing in here adds an amount in one unit to an amount
// in another: `splitTotal` works in the quote asset alone, `pairedFunds` works in
// ETH alone, and the only bridge between them is a price quoted server-side by the
// code that will actually spend the ETH.
//
// Moves no money. It writes form fields.

// The pair column's own parser and printer. Reused rather than re-written: an
// unread balance is `null` there and must stay `null` here — see `heldPairFill`.
import { toUnits, fromUnits } from './pairBalance.js';

/**
 * THE FOUR WAYS TO FILL ONE COLUMN, as one choice instead of four boxes.
 *
 * The panel used to stack them: "Auto-fill buys · Distribute across 31 wallets",
 * then a converter with its own "use as total", then "OR FILL FROM THE ETH THE
 * WALLETS ALREADY HOLD". Three mechanisms for one outcome, each with its own
 * heading, its own field and its own button — which is the "Distributions and
 * converts etc." the operator called confusing. They are not three tools. They
 * are three answers to one question: WHAT DECIDES THE SIZE OF THE BUYS.
 *
 *   'pair'      a total in the launch's quote asset, split across the bundle
 *   'eth'       a total in ETH, converted at the live pool into that same total
 *   'held'      whatever ETH the wallets are already holding, priced per wallet
 *   'heldPair'  the QUOTE ASSET the wallets are already holding, wallet by wallet
 *
 * Only 'pair' exists on a native launch: there is one asset, so there is nothing
 * to convert from, nothing to price against a pool and no second token to hold.
 *
 * WHY THE FOURTH ONE EXISTS. The first three all size from ETH or from a typed
 * total, and a bundle that has already been through the swap station holds its
 * value in the QUOTE ASSET: 31 wallets with 0.0031 ETH each — which is the gas
 * reserve and nothing more — and 0.09–0.16 NVDA each. Asked on that screen, the
 * 'held' basis prices what 0.0031 ETH would buy, which is approximately nothing,
 * and reports 31 wallets skipped for dust. The value is not gone; it is in the
 * other column. So 'heldPair' reads THAT column: each wallet's Buy amount becomes
 * the quote asset it is already holding.
 *
 * NOTHING HERE WRITES. It decides which basis is active, whether its action can
 * do anything, and what that action is called — the writes stay exactly where
 * they were: splitTotal + the swap dry run for 'pair' and 'eth', balanceFill for
 * 'held', and heldPairFill below for 'heldPair'. In particular 'eth' still lands
 * on TAKING the quote into the total rather than on distributing it, because a
 * converted figure becoming a written one is a deliberate press and always has
 * been.
 */
export const FILL_BASES = ['pair', 'eth', 'held', 'heldPair'];

/**
 * @param {object} o
 * @param {string} o.basis        the basis the operator has chosen
 * @param {boolean} o.paired      is the launch priced in something other than ETH
 * @param {string} o.symbol       the quote asset's ticker
 * @param {number} o.bundleCount  bundle wallets on the table
 * @param {number} o.fundedCount  how many of them hold any ETH at all
 * @param {number} o.heldPairCount how many hold a READ, non-zero quote-asset
 *                                 balance — what heldPairFill would actually write
 * @param {number} o.unreadPair    how many carry no readable quote-asset balance
 * @param {string} o.totalBuy     the quote-asset total field
 * @param {string} o.ethTotal     the ETH field
 * @param {number|null} o.quotedPair what the live quote says `ethTotal` buys, and
 *                                   ONLY when the quote is about what is typed —
 *                                   a stale answer must not arm a button
 * @returns {{basis: string, unit: string, enabled: boolean, why: string|null, label: string}}
 */
export function fillAction({
  basis = 'pair',
  paired = false,
  symbol = 'ETH',
  bundleCount = 0,
  fundedCount = 0,
  heldPairCount = 0,
  unreadPair = 0,
  totalBuy = '',
  ethTotal = '',
  quotedPair = null,
} = {}) {
  // A native launch has one basis whatever is asked for, and an unknown name
  // falls back to the same one rather than leaving the control in no state.
  const mode = paired && FILL_BASES.includes(basis) ? basis : 'pair';
  // 'eth' and 'held' are sized in ETH; 'pair' and 'heldPair' are sized in the
  // asset the Buy column is denominated in, which is ETH only when native.
  const unit = mode === 'eth' || mode === 'held' ? 'ETH' : paired ? symbol : 'ETH';
  const wallets = `${bundleCount} wallet${bundleCount === 1 ? '' : 's'}`;
  const out = (enabled, why, label) => ({ basis: mode, unit, enabled, why, label });

  if (!bundleCount)
    return out(false, 'No bundle wallets to fill — generate them above first.', 'Fill the Buy column');

  // THE ONE BASIS THAT NEEDS NO SERVER. The other three wait on a quote or a dry
  // run, which is why two of them are two presses. This one reads a balance the
  // table is already showing, so it writes on a single press — and the label says
  // WRITE, and names how many rows it will touch, because that is what happens.
  //
  // The count it is armed on is the count heldPairFill would actually write: a
  // wallet whose balance could not be READ is neither a holder nor an empty one,
  // and it is reported rather than counted in either direction.
  if (mode === 'heldPair') {
    const n = Math.max(0, Math.floor(heldPairCount));
    const label = n > 0 ? `Write ${n} Buy amount${n === 1 ? '' : 's'}` : `Write the ${symbol} they hold`;
    const unread =
      unreadPair > 0
        ? ` ${unreadPair} balance${unreadPair === 1 ? '' : 's'} could not be read at all — a dash is not a zero, so refresh the balances.`
        : '';
    if (n > 0) return out(true, null, label);
    return out(
      false,
      `No bundle wallet is holding any ${symbol}, so there is nothing to size a buy from. Buy it in ` +
        `the swap step first, or size the buys from a total instead.${unread}`,
      label
    );
  }

  if (mode === 'held') {
    const label = 'Price what their ETH would buy';
    return fundedCount > 0
      ? out(true, null, label)
      : out(
          false,
          `No bundle wallet is holding any ETH yet, so there is nothing to spend. Fund them first, ` +
            `or size the buys in ${symbol} instead.`,
          label
        );
  }

  if (mode === 'eth') {
    const label = quotedPair > 0 ? `Use ${Number(quotedPair).toFixed(6)} ${symbol} as the total` : `Use the quote as the ${symbol} total`;
    if (!(Number(ethTotal) > 0))
      return out(false, `Type an ETH figure to see what it buys in ${symbol}.`, label);
    if (!(Number(quotedPair) > 0))
      return out(false, `Pricing ${ethTotal} ETH against the live ${symbol} pool…`, label);
    return out(true, null, label);
  }

  const label = `Distribute across ${wallets}`;
  if (!(Number(totalBuy) > 0)) return out(false, `Type a total in ${unit} to split across ${wallets}.`, label);
  return out(true, null, label);
}

/**
 * Split `total` across `count` wallets: ±30% jitter around equal, so no two buys
 * are the same and the bundle reads as several buyers rather than one pattern.
 *
 * The sum is EXACT — the rounding drift is pushed onto the last wallet — because
 * the operator typed a total and the table must add up to it.
 *
 * The unit is whatever the caller's total is in, and this function neither knows
 * nor needs to know which: it is arithmetic on one currency at a time.
 *
 * `places` is how many decimals the amounts are rounded to. Six on a native
 * launch, which is what this has always done, and on a paired launch the smaller
 * of six and the PAIR TOKEN'S OWN decimals — a 2-decimal quote asset cannot parse
 * "0.123456" and the whole priced plan would be refused for it.
 */
export function splitTotal(count, total, { places = 6, random = Math.random } = {}) {
  const n = Math.max(0, Math.floor(count));
  if (n === 0) return [];
  const scale = 10 ** places;
  const weights = Array.from({ length: n }, () => 1 + (random() - 0.5) * 0.6);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const amounts = weights.map((w) => Math.round((w / wsum) * total * scale) / scale);
  const drift = Math.round((total - amounts.reduce((a, b) => a + b, 0)) * scale) / scale;
  amounts[amounts.length - 1] = Math.round((amounts[amounts.length - 1] + drift) * scale) / scale;
  return amounts;
}

/**
 * THE BUY COLUMN FROM THE QUOTE ASSET THE WALLETS ARE ALREADY HOLDING.
 *
 * The bundle has been through the swap station: the ETH left in each wallet is
 * the gas reserve and the value is in NVDA. This turns that column into the Buy
 * column, wallet by wallet — no quote, no dry run, no server call, because the
 * only figures involved are two readings of the SAME asset and neither of them
 * has to be priced.
 *
 * FLOORED, NEVER ROUNDED, and that is the whole safety of it. The Buy amount is
 * not a suggestion: prepareV2 parses it and preflight then demands the wallet
 * HOLD at least that much, dropping it when it does not. A figure rounded UP by
 * one unit in the last place is a wallet silently dropped at arming — the exact
 * failure this basis exists to avoid — so the amount written is the balance
 * truncated to `places`, and is therefore always ≤ what the wallet holds.
 * `places` is min(6, the pair token's own decimals): the same cap splitTotal
 * writes at and the same one takeConverted floors to.
 *
 * AN UNREAD BALANCE IS NOT ZERO. `pairBalance` is null when the read failed
 * (backend wallets/funding.js: "an unread balance and an empty wallet are
 * different facts and the table must not conflate them"), so such a wallet is
 * returned in `unread`, NAMED, and left exactly as it was. It is never written
 * with a 0 — a 0 reads as a decision — and never quietly dropped from the
 * account either. A wallet that really does hold nothing is `empty`, which is a
 * different fact and is reported as one.
 *
 * AND THE FUND COLUMN GOES TO ZERO for every wallet it writes. These wallets are
 * not waiting on a swap: they already hold their quote asset, so the ETH to buy
 * it is not a thing that needs sending, and the swap dry run will report them
 * `skipped-already-funded` (backend bundle/swapToPair.js: `held >= need`). A
 * leftover Fund figure from an earlier basis is the ETH for a swap that will
 * never happen, so leaving it would invite a funding run for nothing. Zero, not
 * blank: blank is a question, and this is an answer. Every reader of the column
 * filters on `> 0`, so a zero sends nothing and names no requirement.
 *
 * The gas those wallets still need is deliberately NOT written here. It is a
 * different question with a different source (the /gas reserve, or the dry run's
 * own gasReserveEth), and a Fund figure is read elsewhere as "the ETH this wallet
 * must HOLD" — writing a top-up into it would report the bundle as short of ETH
 * for a swap it is not making. The console states the gas shortfall on screen
 * instead and leaves the number to the operator.
 *
 * @param {Array<object>} wallets bundle wallets carrying `id`, `address`, `pairBalance`
 * @param {{places?: number}} o   decimals to floor at
 * @returns {{patches: Record<string, {mode: string, buy: string, fund: string}>,
 *            filled: number, unread: Array<object>, empty: Array<object>, total: string}}
 */
export function heldPairFill(wallets, { places = 6 } = {}) {
  const p = Math.max(0, Math.min(18, Math.floor(Number(places)) || 0));
  // pairBalance.js scales to 18 places; this is the step of the last place we
  // are allowed to keep, and integer division by it truncates — it never rounds.
  const step = 10n ** BigInt(18 - p);

  const patches = {};
  const unread = [];
  const empty = [];
  let totalRaw = 0n;

  for (const w of wallets || []) {
    const held = toUnits(w?.pairBalance);
    if (held === null) {
      unread.push({ walletId: w?.id, address: w?.address });
      continue;
    }
    const floored = (held / step) * step;
    if (floored <= 0n) {
      empty.push({ walletId: w?.id, address: w?.address, heldPair: fromUnits(held) });
      continue;
    }
    patches[w.id] = { mode: 'fixed', buy: fromUnits(floored), fund: '0' };
    totalRaw += floored;
  }

  return { patches, filled: Object.keys(patches).length, unread, empty, total: fromUnits(totalRaw) };
}

/**
 * Turn the swap-to-pair DRY RUN into the Fund column, in ETH.
 *
 * `plan.results[].swapEth` is what that wallet's ETH→pair swap costs, sized and
 * quoted by the endpoint that will spend it — never re-derived here. `reserveEth`
 * is what the wallet keeps on top of that.
 *
 * A wallet with no usable price gets NO number: it is returned in `unpriced` and
 * the caller leaves its Fund blank. A blank is a question the operator can answer;
 * a wrong figure is one they cannot see.
 *
 * A wallet the plan skipped as ALREADY FUNDED needs no swap at all, so its swap
 * cost is zero — known, not unknown, and it still needs the gas reserve.
 *
 * @param {object} plan the dry run's payload
 * @param {number} reserveEth ETH held back per wallet on top of the swap input
 * @returns {{funds: Record<string,string>, unpriced: string[], totalEth: number}}
 */
export function pairedFunds(plan, reserveEth) {
  const funds = {};
  const unpriced = [];
  let totalEth = 0;
  const reserve = Number(reserveEth) || 0;
  for (const r of plan?.results || []) {
    const swap = r.status === 'skipped-already-funded' ? 0 : Number(r.swapEth);
    if (r.swapEth == null && r.status !== 'skipped-already-funded') {
      unpriced.push(r.walletId);
      continue;
    }
    if (!Number.isFinite(swap) || swap < 0) {
      unpriced.push(r.walletId);
      continue;
    }
    const fund = swap + reserve;
    funds[r.walletId] = fund.toFixed(6);
    totalEth += fund;
  }
  return { funds, unpriced, totalEth };
}

/**
 * What each wallet must hold in ETH ON TOP of its swap input.
 *
 * `gasReserveEth` is the dry run's own figure — the swap's gas, the launch's
 * approve and buy at double today's fees, and the preflight buffer — so a wallet
 * funded to this passes the very check that would otherwise refuse it. The sells
 * are this console's own promise, the same one the native path has always made:
 * gas kept back for SELL_RESERVE exits.
 */
export function pairedReserveEth(gasReserveEth, sellGasEth, sells) {
  return (Number(gasReserveEth) || 0) + (Number(sellGasEth) || 0) * sells;
}
