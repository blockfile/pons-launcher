/**
 * Exact ETH totals for the sweep preview.
 *
 * The backend sends each row's amount as a raw wei string (`sendWeiRaw`). Summing the
 * decimal `sendEth` strings through Number would round, and the total an operator confirms
 * should be the total that moves — so the sum is taken in BigInt and only the display is cut
 * to six places (truncated, never rounded up), the precision `eth()` shows everywhere else.
 */
const WEI_PER_ETH = 10n ** 18n;
const WEI_PER_SIXTH_PLACE = 10n ** 12n;

export function sumWei(rows) {
  return rows.reduce((sum, r) => sum + BigInt(r.sendWeiRaw || 0), 0n);
}

export function weiToEth(wei) {
  const whole = wei / WEI_PER_ETH;
  const frac = (wei % WEI_PER_ETH) / WEI_PER_SIXTH_PLACE;
  return `${whole}.${frac.toString().padStart(6, '0')}`;
}
