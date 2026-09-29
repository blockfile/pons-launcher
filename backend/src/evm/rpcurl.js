'use strict';

// An RPC endpoint is a SECRET, because the key is usually IN THE PATH.
//
// QuickNode hands out https://<name>.robinhood-mainnet.quiknode.pro/<token>/ —
// the token is a path segment, not a password, not a query parameter. Anything
// that prints `config.rpcUrl` therefore prints a credential: into a terminal, a
// screenshot, a pasted support thread, a log file. That happened on 2026-09-29
// (scripts/inclusion.js printed the endpoint it was about to measure, the output
// was pasted into a chat, and the endpoint had to be rolled), so the masking
// lives here and both scripts use it rather than each deciding for itself.
//
// What is kept is what identifies the endpoint to a human — scheme and host —
// and what is dropped is everything that authenticates to it.

/**
 * An RPC URL with every credential removed: no path, no query, no fragment, no
 * userinfo. `https://x.quiknode.pro/<token>/` becomes `https://x.quiknode.pro/…`.
 *
 * Anything unparseable returns a fixed string rather than the original, so a
 * malformed URL cannot leak by falling through.
 *
 * @param {string} url
 * @returns {string} safe to print
 */
function maskRpcUrl(url) {
  if (!url) return '(none)';
  try {
    const u = new URL(String(url));
    const hasSecret = (u.pathname && u.pathname !== '/') || u.search || u.username || u.password;
    return `${u.protocol}//${u.host}${hasSecret ? '/…' : ''}`;
  } catch (_err) {
    return '(unprintable endpoint)';
  }
}

module.exports = { maskRpcUrl };
