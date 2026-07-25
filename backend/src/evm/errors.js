'use strict';

// Getting the node's own words in front of the operator.
//
// ethers wraps a JSON-RPC error it cannot classify as "could not coalesce
// error", which tells you nothing at the moment you most need to know — five
// failed transfers with that message are indistinguishable from five different
// causes. The provider's actual message is one level down, in info.error, and
// that is the one worth showing.

/**
 * The most specific message available for an RPC failure.
 * @param {unknown} err
 * @returns {string}
 */
function rpcMessage(err) {
  if (!err) return 'unknown error';

  const inner =
    (err.info && err.info.error && err.info.error.message) ||
    (err.error && err.error.message) ||
    null;
  const short = err.shortMessage || null;
  const code = (err.info && err.info.error && err.info.error.code) || err.error?.code;

  // ethers' own summary is usually the clearer one — unless it gave up, in
  // which case anything else beats it. Order matters: when ethers cannot
  // classify an error its `message` carries the serialised payload, which is
  // far more use for diagnosis than the summary that admits defeat.
  const vague = !short || /could not coalesce|unknown error/i.test(short);
  const chosen = vague ? inner || err.message || short : short;

  if (!chosen) return String(err);
  // The numeric code distinguishes a rate limit from a rejected transaction,
  // which the prose often does not.
  const withCode = vague && code ? `${chosen} (code ${code})` : chosen;
  // A serialised payload can run to thousands of characters; this is going in
  // a table cell next to a wallet address.
  return withCode.length > 300 ? `${withCode.slice(0, 300)}…` : withCode;
}

module.exports = { rpcMessage };
