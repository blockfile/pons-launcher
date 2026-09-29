'use strict';

// Hand ONE signed transaction to several paths at once and keep the first
// acceptance.
//
// WHY. A transaction's journey has two parts: this box to an endpoint (4.7ms
// median to QuickNode from the droplet, measured) and the endpoint onward to the
// sequencer, which nothing here can see. The second part is where the tail lives:
// `npm run inclusion` measured 193ms median but 338ms at p95, and on the Tomachi
// launch of 2026-09-29 three of 33 bundle buys took over a second, landing at
// +11/+12 blocks — outside the ~10-block window where the snipe tax is 99%, which
// is the whole protection a bundle has.
//
// The same signed bytes sent down two paths cannot double-spend: same signature,
// same nonce, SAME HASH. The sequencer takes whichever arrives first and answers
// the other "already known". So each send's latency becomes the better of two
// draws, and the tail is where that pays.
//
// THIS MODULE DOES NOT DECIDE TO DO THAT. It is the mechanism; `scripts/inclusion.js
// --dual` is the measurement that says whether the two paths are independent enough
// to be worth it on this chain, from this box. Nothing in the launch path uses it
// until that measurement says so.

// The far end telling us it already has this transaction — which is success, not
// failure, and on a race it is the EXPECTED answer from every path but the winner.
// "nonce too low" belongs here for the same reason: the winning copy was already
// mined, so the nonce moved on.
const DUPLICATE =
  /already known|known transaction|already exists|nonce too low|replacement transaction underpriced/i;

/** Is this refusal just the far end recognising a transaction it already has? */
function isDuplicateSend(err) {
  if (!err) return false;
  const message = typeof err === 'string' ? err : err.message || err.shortMessage || '';
  return DUPLICATE.test(String(message));
}

/**
 * Broadcast one raw transaction down every path at once; resolve on the first
 * acceptance.
 *
 * Never sends different bytes to different paths — the caller passes one `raw`,
 * and every sender carries exactly it.
 *
 * @param {string} raw the signed transaction
 * @param {Array<{name: string, send: (raw: string) => Promise<string>}>} senders
 * @param {{now?: () => number}} [deps]
 * @returns {Promise<{hash: string|null, winner: string|null, duplicate: boolean,
 *   ms: number|null, attempts: Array<{name, ok, ms, hash?, error?, duplicate?}>}>}
 *   `attempts` keeps filling in after this resolves — the losers are not waited for.
 * @throws when every path refused for a reason that is NOT a duplicate
 */
async function raceSend(raw, senders, deps = {}) {
  if (!Array.isArray(senders) || senders.length === 0) {
    throw new Error('raceSend needs at least one path');
  }
  const now = deps.now || (() => Date.now());
  const started = now();
  const attempts = [];
  let settled = false;

  return new Promise((resolve, reject) => {
    let pending = senders.length;
    let duplicateSeen = false;
    const errors = [];

    const finishEmpty = () => {
      if (settled) return;
      settled = true;
      // Every path refused. If any of them refused because it ALREADY HAS this
      // transaction, it is on the wire — report that rather than failing a send
      // that succeeded moments ago down another path.
      if (duplicateSeen) {
        resolve({ hash: null, winner: null, duplicate: true, ms: now() - started, attempts });
        return;
      }
      reject(new Error(errors.map((e) => `${e.name}: ${e.message}`).join(' | ')));
    };

    for (const s of senders) {
      const at = now();
      Promise.resolve()
        .then(() => s.send(raw))
        .then(
          (hash) => {
            attempts.push({ name: s.name, ok: true, ms: now() - at, hash });
            pending -= 1;
            if (settled) return;
            settled = true;
            resolve({ hash, winner: s.name, duplicate: false, ms: now() - started, attempts });
          },
          (err) => {
            const duplicate = isDuplicateSend(err);
            attempts.push({
              name: s.name,
              ok: false,
              duplicate,
              ms: now() - at,
              error: err.shortMessage || err.message || String(err),
            });
            if (duplicate) duplicateSeen = true;
            else errors.push({ name: s.name, message: err.shortMessage || err.message || String(err) });
            pending -= 1;
            if (pending === 0) finishEmpty();
          }
        );
    }
  });
}

module.exports = { raceSend, isDuplicateSend };
