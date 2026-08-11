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

/**
 * A range, with the sign written once: "1.94–4.24%", not "1.94%–4.24%".
 *
 * 27 rows of this are read at a glance, so the second % sign is worth more as
 * space than as punctuation. Ends that round to the same figure collapse to
 * one, which is what a dust-sized buy and the dev row both do — a range with
 * identical ends reads as a mistake rather than as certainty.
 */
export function pctRange(lo, hi) {
  const low = pct(lo);
  const high = pct(hi);
  return low === high ? high : `${low.replace('%', '')}–${high}`;
}

/** Whole tokens, for the tooltip. Rounded: nobody counts the last one. */
export function tokens(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(v).toLocaleString() : '0';
}

/**
 * One share figure — a RANGE, because landing order is unknown.
 *
 * fire.js broadcasts every bundle buy at once and the sequencer decides which
 * arrives first, so a wallet takes the most landing first (behind only the dev
 * buy) and the least landing last (behind the whole rest of the bundle). Both
 * ends are computed; the position between them is not knowable from here. A
 * single number per row would be a claim about ordering nobody can make — and
 * it was one: every wallet buying the same amount used to show the same figure,
 * which is true of at most one of them.
 *
 * `exact` is not decoration either. A v2 curve is fixed by its launch config
 * before the launch is sent, so both ends are arithmetic; a v1 launch has no
 * pool until it runs, so both ends are read off the state the config opens with
 * and carry a ~. Presenting the two with the same confidence would be a lie
 * about which one can be relied on.
 *
 * Vermilion means the same thing here as everywhere else in this console:
 * irreversible or over a cap. A buy over maxWalletBps does not clamp, it
 * reverts, so the wallet spends its gas and buys nothing. That flag is measured
 * at the pool's OPENING price — the same yardstick preflight uses — so it can
 * sit above the range beside it; the tooltip says so rather than leaving the
 * operator to find two numbers that disagree.
 */
export default function Share({ leg, exact, title }) {
  if (!leg || !(leg.estBps > 0)) return null;
  const over = leg.exceedsWallet || leg.exceedsTx;
  const worstBps = leg.worstBps ?? leg.estBps;
  const spread =
    worstBps === leg.estBps
      ? `≈${tokens(leg.estTokens)} tokens`
      : `lands first: ≈${tokens(leg.estTokens)} tokens · lands last: ≈${tokens(
          leg.worstTokens
        )} tokens — every buy is broadcast at once and the sequencer picks the order`;
  return (
    <span
      className={`share ${over ? 'over' : ''}`}
      title={
        title ||
        `${spread}${
          over
            ? ` — ${pct(leg.capBps ?? leg.estBps)} at the pool's opening price, over the ` +
              'launch-window cap: this buy reverts'
            : ''
        }`
      }
    >
      {exact ? '' : '≈'}
      {pctRange(worstBps, leg.estBps)}
      {/* The consequence, in the cell the eye is already on. The figure has
          been vermilion for a while, but a colour only says "wrong" — it
          cannot say WHICH wrong, and the difference here is not "this buy is
          large" but "this buy does not happen and pays gas anyway". That was
          stated in a tooltip nobody hovers and in a notice below the table,
          both of which are somewhere else. One word, no new colour: it takes
          the vermilion the figure above it already has. */}
      {over && <b className="reverts">reverts · gas wasted</b>}
    </span>
  );
}
