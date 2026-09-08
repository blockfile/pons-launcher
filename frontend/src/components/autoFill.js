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

/**
 * THE THREE WAYS TO FILL ONE COLUMN, as one choice instead of three boxes.
 *
 * The panel used to stack them: "Auto-fill buys · Distribute across 31 wallets",
 * then a converter with its own "use as total", then "OR FILL FROM THE ETH THE
 * WALLETS ALREADY HOLD". Three mechanisms for one outcome, each with its own
 * heading, its own field and its own button — which is the "Distributions and
 * converts etc." the operator called confusing. They are not three tools. They
 * are three answers to one question: WHAT DECIDES THE SIZE OF THE BUYS.
 *
 *   'pair'  a total in the launch's quote asset, split across the bundle
 *   'eth'   a total in ETH, converted at the live pool into that same total
 *   'held'  whatever ETH the wallets are already holding, priced per wallet
 *
 * Only 'pair' exists on a native launch: there is one asset, so there is nothing
 * to convert from and nothing to price against a pool.
 *
 * NOTHING HERE WRITES. It decides which basis is active, whether its action can
 * do anything, and what that action is called — the writes stay exactly where
 * they were: splitTotal + the swap dry run for 'pair' and 'eth', balanceFill for
 * 'held'. In particular 'eth' still lands on TAKING the quote into the total
 * rather than on distributing it, because a converted figure becoming a written
 * one is a deliberate press and always has been.
 */
export const FILL_BASES = ['pair', 'eth', 'held'];

/**
 * @param {object} o
 * @param {string} o.basis        the basis the operator has chosen
 * @param {boolean} o.paired      is the launch priced in something other than ETH
 * @param {string} o.symbol       the quote asset's ticker
 * @param {number} o.bundleCount  bundle wallets on the table
 * @param {number} o.fundedCount  how many of them hold any ETH at all
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
  totalBuy = '',
  ethTotal = '',
  quotedPair = null,
} = {}) {
  // A native launch has one basis whatever is asked for, and an unknown name
  // falls back to the same one rather than leaving the control in no state.
  const mode = paired && FILL_BASES.includes(basis) ? basis : 'pair';
  const unit = mode === 'pair' ? (paired ? symbol : 'ETH') : 'ETH';
  const wallets = `${bundleCount} wallet${bundleCount === 1 ? '' : 's'}`;
  const out = (enabled, why, label) => ({ basis: mode, unit, enabled, why, label });

  if (!bundleCount)
    return out(false, 'No bundle wallets to fill — generate them above first.', 'Fill the Buy column');

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
