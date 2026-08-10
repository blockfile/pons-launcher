// How a share of supply is written, in the one place that decides it.
//
// The arithmetic is in shared/bundleShare.js and is not repeated here — this is
// only the wording, and it exists as its own file because the wallet table and
// the arm bar both state the same figure and must state it the same way. A
// bundle buy is routinely a tenth of a percent, so a flat two decimal places
// would round most real launches to "0.00%".

/** bps of supply → a percentage, with places enough for a real bundle buy. */
export function pct(bps) {
  const v = Number(bps) / 100;
  if (!Number.isFinite(v) || v <= 0) return '0%';
  if (v < 0.01) return `${v.toFixed(4)}%`;
  if (v < 1) return `${v.toFixed(3)}%`;
  return `${v.toFixed(2)}%`;
}

/** Whole tokens, for the tooltip. Rounded: nobody counts the last one. */
export function tokens(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(v).toLocaleString() : '0';
}

/**
 * One share figure.
 *
 * `exact` is not decoration. A v2 curve is fixed by its launch config before
 * the launch is sent, so that figure is arithmetic; a v1 launch has no pool
 * until it runs, so that figure is the opening tick with no impact term and
 * carries a ~. Presenting the two with the same confidence would be a lie about
 * which one can be relied on.
 *
 * Vermilion means the same thing here as everywhere else in this console:
 * irreversible or over a cap. A buy over maxWalletBps does not clamp, it
 * reverts, so the wallet spends its gas and buys nothing.
 */
export default function Share({ leg, exact, title }) {
  if (!leg || !(leg.estBps > 0)) return null;
  const over = leg.exceedsWallet || leg.exceedsTx;
  return (
    <span
      className={`share ${over ? 'over' : ''}`}
      title={
        title ||
        `≈${tokens(leg.estTokens)} tokens${
          over ? ' — over the launch-window cap, this buy reverts' : ''
        }`
      }
    >
      {exact ? '' : '≈'}
      {pct(leg.estBps)}
    </span>
  );
}
