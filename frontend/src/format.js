/**
 * Display formatting shared across panels. Nothing here decides anything: every
 * function is a render-time transform of a value that has already been computed.
 */

/**
 * A 42-character address, shortened for SCANNING.
 *
 * This is display only, and the distinction is the whole reason it lives in one
 * place: the full string is what goes into an api() call, a lookup key, an
 * href, or a confirmation dialog — never the output of this function. A copy
 * button beside a shortened address must read the address from the data it was
 * rendered from, never from the text on screen, or it copies the ellipsis too.
 *
 * The default keeps twelve of the forty hex nibbles (six each end, "0x" being
 * two of the eight leading characters). That is a scanning aid and never a
 * verification: addresses are mined to match a target's first and last few
 * characters precisely so that a truncated on-screen check passes, which is why
 * every Modal in this console still prints the whole thing. Shorter than this
 * would be inside routine address-poisoning range; longer does not fit the
 * wallet table inside its card, which is what forced the truncation.
 */
export function shortAddress(a, lead = 8, tail = 6) {
  if (!a) return '';
  return a.length <= lead + tail + 1 ? a : `${a.slice(0, lead)}…${a.slice(-tail)}`;
}
