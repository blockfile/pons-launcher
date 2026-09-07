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
