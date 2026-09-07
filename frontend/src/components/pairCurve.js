// THE PAIRED LAUNCH'S CURVE, AND THE ONE PLACE THE CONSOLE'S TWO UNITS MEET.
//
// Pure and unit-tested (pairCurve.test.js) for the same reason autoFill.js is:
// this is a seam between currencies, and every bug this console has had in the
// last month has been at one. `fund: (buy + reserve)` added NVDA to ETH. The
// "dev wallet needs ~ X ETH" readout added a pair-token total to a gas figure.
// And the wallet table's supply share, per-row MC and footer walked pair-token
// buy amounts through the NATIVE curve's phantom reserve — reporting that a
// bundle took 61.20% of supply when the same bundle, on the curve it actually
// runs on, takes 14.95%.
//
// TWO SEPARATE FACTS, and they fail separately, which is why they are two
// functions:
//
//   1. WHICH CURVE. The share, the per-row MC and the footer percentages are
//      arithmetic against the launch's curve. On a paired launch that curve is
//      the FACTORY'S pairTokenEconomics for the chosen quote asset, not the
//      launch config's own constants — those are the native ones. This needs no
//      quote and no network: it is read off /api/v2/configs with the rest of the
//      pair list. `shareInputs`.
//
//   2. WHAT IT IS WORTH IN DOLLARS. That needs a live ETH<->pair rate, which is
//      a quote against a pool and can simply be unavailable. `ethEquivalent`.
//
// Fact 1 failing means NO SHARE AT ALL — the percentages would be a different
// curve's percentages. Fact 2 failing means the percentages stand and only the $
// figure is missing, so the market cap is drawn in the pair token alone. In both
// cases the missing figure is ABSENT and the reason is on screen. A wrong number
// here is what this whole file is an apology for.
//
// Reads nothing, writes nothing, fetches nothing.

/**
 * Is the launch priced in native ETH?
 *
 * `pair` is null on a native launch and on every v1 launch — LaunchForm only
 * hands one up for v2 with a non-native quote asset picked — so this is the
 * single question the rest of the console asks.
 */
export function isNativeLaunch(pair) {
  return !pair || !pair.address;
}

/**
 * The launch config and quote-asset descriptors to feed shared/bundleShare.
 *
 * NATIVE IS UNTOUCHED and deliberately so: `launchConfig` comes back as the very
 * object that went in, and pairDecimals/pairSymbol come back as bundleShare's own
 * defaults, so a native launch produces the identical share object it always did.
 *
 * PAIRED substitutes the pair's own phantom reserve and graduation threshold
 * (`pairedLaunchConfig`, the same expression the backend preflight runs) and
 * names the quote asset, so every quote-denominated figure — reserves, market
 * cap, the raised total, every buy amount — comes out in the pair token.
 *
 * `blocked` is a sentence, not a flag: when it is set the caller must draw NO
 * share and print this instead. It happens when the pair's economics did not
 * reach the console — the factory read failed, or the pair list is the
 * native-only fallback a range-limited RPC produces. Falling back to the
 * config's native constants is exactly the bug.
 *
 * @param {object} input
 * @param {'v1'|'v2'} input.protocol
 * @param {object|null} input.launchConfig straight from /configs or /v2/configs
 * @param {object|null} input.pair the resolved quote asset, null on native
 * @param {function} input.pairedLaunchConfig from shared/bundleShare
 * @param {function} input.hasPairEconomics from shared/bundleShare
 * @returns {{launchConfig: object|null, pairDecimals: number, pairSymbol: string,
 *   blocked: string|null}}
 */
export function shareInputs({ protocol, launchConfig, pair, pairedLaunchConfig, hasPairEconomics }) {
  const native = { launchConfig: launchConfig || null, pairDecimals: 18, pairSymbol: 'ETH', blocked: null };
  if (!launchConfig) return native;
  // v1 has no quote asset at all — it is a Uniswap pool priced in ETH — and
  // shareV1 does not take these descriptors. Nothing about it changes here.
  if (protocol !== 'v2' || isNativeLaunch(pair)) return native;

  if (!hasPairEconomics(pair)) {
    return {
      launchConfig: null,
      pairDecimals: 18,
      pairSymbol: pair.symbol || 'the pair token',
      blocked:
        `no curve to price against: the factory's pairTokenEconomics for ${pair.symbol || 'this pair'} ` +
        'did not reach the console, so what this bundle takes of the supply is not known. ' +
        `Config #${launchConfig.id ?? '?'}'s own phantom reserve and threshold are the NATIVE ones and ` +
        'are not this curve — every approved pair has its own, spanning three orders of magnitude — ' +
        'so nothing is shown rather than a figure off the wrong curve. Re-pick the quote asset in ' +
        'step 5 to read them again.',
    };
  }

  const decimals = Number(pair.decimals);
  return {
    launchConfig: pairedLaunchConfig(launchConfig, pair),
    // The FACTORY's economics decimals, which is what /v2/configs reports and
    // what prepareV2 parses buy amounts with — the launch reverts
    // PairTokenDecimalsMismatch if the token itself disagrees.
    pairDecimals: Number.isFinite(decimals) && decimals >= 0 ? decimals : 18,
    pairSymbol: pair.symbol || 'PAIR',
    blocked: null,
  };
}

/**
 * An amount denominated in the launch's quote asset, expressed in ETH — FOR
 * DISPLAY ONLY, and only ever at the very end.
 *
 * Nothing upstream of this is in ETH on a paired launch: the curve, the market
 * cap, the graduation threshold and every buy amount are the pair token, and
 * they stay the pair token right up to the moment a dollar sign is drawn.
 *
 * NATIVE RETURNS ITS ARGUMENT UNCHANGED — the same value, not a re-derived one —
 * because on a native launch the figure already IS ETH and must reach the
 * formatter as the exact string it was computed as.
 *
 * PAIRED divides by a live rate. `pairPerEth` is how much of the pair token one
 * ETH buys, quoted server-side through the same route the funding swap uses. No
 * rate, an unusable rate or an unusable amount returns NULL, and null means the
 * caller draws no dollar figure and says why — never a guessed rate, never the
 * pair-token number wearing an ETH label, which is the bug.
 *
 * @returns {string|number|null}
 */
export function ethEquivalent(amount, { isNative, pairPerEth }) {
  if (amount === null || amount === undefined || amount === '') return null;
  if (isNative) return amount;
  const rate = Number(pairPerEth);
  const value = Number(amount);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  return String(value / rate);
}

/**
 * The rate itself, from the pair-quote endpoint's answer to a PROBE.
 *
 * The probe is deliberately tiny — 0.001 ETH, the same size and for the same
 * reason as swaproute's IMPACT_PROBE — because what a market cap wants is the
 * near-spot rate, not what a trade of that size would actually fill at. Quoting
 * the market cap itself would price BUYING that much of the pair token, impact
 * and all, which is a different question and a worse answer.
 *
 * Returns null unless the quote is usable. There is no fallback rate: a stale or
 * invented one produces a dollar figure that looks exactly like a real one.
 */
export function pairPerEthFrom(quote, probeEth) {
  const out = Number(quote?.pairOut);
  const probe = Number(probeEth);
  if (!Number.isFinite(out) || out <= 0) return null;
  if (!Number.isFinite(probe) || probe <= 0) return null;
  return out / probe;
}
