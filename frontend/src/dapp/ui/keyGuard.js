/**
 * A private key pasted where it does not belong (the token CA box is the first
 * field on the page, and both are 0x-hex). Such a value must not be kept in
 * React state or shown: the caller drops it and says why. Shape only — this
 * never parses, stores or sends anything.
 */
const KEY_SHAPE = /^(0x)?[0-9a-fA-F]{64}$/;

export function looksLikeKey(text) {
  return typeof text === 'string' && KEY_SHAPE.test(text.trim());
}
