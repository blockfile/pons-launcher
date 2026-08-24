/**
 * The pons v2 "paired asset" (quote token) the console lets the operator pick.
 *
 * v2 was always priced in native ETH; the factory can now approve ERC-20 quote
 * assets (SPCX / RWAs / USDG), and /api/v2/configs returns them as a `pairTokens`
 * array with native ETH first. This module is the console's pure, testable view
 * of that list — the same arrangement as variant.js: the component draws what
 * these functions decide, and the test beside this file pins the behaviour.
 *
 * The native option is address(0). Sending it as the body's `pairToken` is
 * byte-for-byte the backend default (prepareV2 defaults pairToken to ZeroAddress
 * and treats ZeroAddress as native), so a native launch behaves exactly as it
 * did before this field existed — whether the field is sent or omitted.
 */

// The native sentinel. ethers' ZeroAddress serialises to this lowercased string,
// which is what the backend's nativeOption() puts in `pairTokens[0].address`.
// The frontend has no ethers dependency, so it is written out here literally.
export const NATIVE_PAIR = '0x0000000000000000000000000000000000000000';

/** Is this the native-ETH quote asset? Case-insensitive, null-safe. */
export function isNativePair(address) {
  return !address || String(address).toLowerCase() === NATIVE_PAIR;
}

/**
 * The options the picker offers, native always first and always present.
 *
 * Best-effort exactly like the backend resolver: if the v2 config never loaded,
 * or its `pairTokens` failed to resolve (a range-limited RPC returns nothing but
 * native, or the whole read failed), the picker still has native to select and
 * the form does not crash. Native-only is the graceful floor.
 *
 * @param {object|null} configV2 the parsed /api/v2/configs response
 * @returns {Array<{symbol,address,decimals?,native?}>}
 */
export function pairOptions(configV2) {
  const list = Array.isArray(configV2?.pairTokens) ? configV2.pairTokens : [];
  const usable = list.filter((t) => t && typeof t.address === 'string' && t.symbol);
  if (!usable.some((t) => isNativePair(t.address))) {
    return [{ symbol: 'ETH', address: NATIVE_PAIR, decimals: 18, native: true }, ...usable];
  }
  return usable;
}

/**
 * The token object the picker currently has selected, resolved against the live
 * list so a stale selection (e.g. a token un-approved between reads) falls back
 * to native rather than pointing at nothing.
 */
export function selectedPair(configV2, address) {
  const options = pairOptions(configV2);
  return (
    options.find((t) => t.address.toLowerCase() === String(address || '').toLowerCase()) ||
    options[0]
  );
}

/**
 * The exact value to put in the v2 launch body's `pairToken`. Identity on a real
 * address; an empty/absent selection collapses to the native sentinel, which is
 * the backend default — so ETH keeps today's behaviour and a chosen RWA sends
 * its own address.
 */
export function bodyPairToken(address) {
  return isNativePair(address) ? NATIVE_PAIR : address;
}
