// A local nonce counter per wallet, so a click signs without a chain read.
//
// seed() comes from /api/tp/wallets (the PENDING nonce) and never moves a counter
// BACKWARDS: a wallet read that was taken before this tab's last broadcast
// landed would otherwise hand out a nonce already used, and the second tx would
// be refused ("nonce too low") or replace the first. resync() is the one call
// allowed to move a counter down — use it with a FRESH pending nonce after a
// nonce error or after any failed broadcast of this wallet's tx (a signed tx
// that never reached the node leaves a gap that stalls every later one).

const key = (address) => String(address).toLowerCase();

function asNonce(n) {
  const v = Number(n);
  if (!Number.isSafeInteger(v) || v < 0) throw new RangeError('nonce must be a non-negative integer');
  return v;
}

export class NonceBook {
  constructor() {
    this.next_ = new Map();
  }

  /** Learn a wallet's pending nonce. Keeps the higher of the known and given value. */
  seed(address, n) {
    const k = key(address);
    const v = asNonce(n);
    const cur = this.next_.get(k);
    if (cur === undefined || v > cur) this.next_.set(k, v);
  }

  /** Hand out the next nonce for a wallet and advance its counter. */
  next(address) {
    const k = key(address);
    const cur = this.next_.get(k);
    if (cur === undefined) throw new Error(`no nonce known for ${address} — load wallets first`);
    this.next_.set(k, cur + 1);
    return cur;
  }

  /** Overwrite a wallet's counter with a fresh pending nonce (may move it down). */
  resync(address, n) {
    this.next_.set(key(address), asNonce(n));
  }

  /** The nonce next() would return, without advancing; undefined if unknown. */
  peek(address) {
    return this.next_.get(key(address));
  }
}
