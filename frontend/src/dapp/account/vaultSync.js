/**
 * The account's encrypted copy, kept in step with this tab (spec Addendum A,
 * "Sync"): the wallets in walletStore and the %-left bars' starting sizes (the
 * positions book, ui/positions.js, which talks to this sync over the page hub).
 *
 *   load()   GET the copy, decrypt it, merge it into this tab. No copy yet: the
 *            first save creates it at once (baseRev 0).
 *   saves    every change (an import, a removal, a position the book saves)
 *            schedules a save DEBOUNCED by 5 s, but never later than 30 s after
 *            the first unsaved change (MAX_WAIT_MS), and a tab starts a scheduled
 *            save at most once every 10 s (MIN_SAVE_GAP_MS). One save is in
 *            flight at a time; a save whose content equals what the server holds
 *            is skipped. A page going hidden saves a pending change at once (best
 *            effort). A save is never on a click's path: the sell code does not
 *            wait for it.
 *   budget   the server takes 30 PUTs a minute per account and 60 per IP
 *            (TP_ACCOUNT_WRITES_PER_MIN, TP_ACCOUNT_WRITES_PER_MIN_IP). One
 *            tab starts at most 6 scheduled saves a minute; a save is one PUT,
 *            plus one per 409 (at most 2 more, only when another tab or device
 *            saved in between). Changes come from imports, removals and buys,
 *            so one account normally makes a few PUTs a minute; even two tabs
 *            saving nonstop and colliding every time make 2 x 6 x 2 = 24. A
 *            429 that still happens waits out its Retry-After.
 *   conflict PUT carries baseRev; a 409 'conflict' (another tab or device saved
 *            first) re-reads the copy, merges it, and saves again (3 rounds).
 *   wallets  an add-wins observed-remove set, with NO CLOCK in it. Every import
 *            into this tab (a new wallet, or one already here imported again)
 *            gets a fresh random tag; a removal tombstones exactly the tags this
 *            tab held for that wallet, i.e. the imports it had seen. A wallet is
 *            in the copy while it has a tag no tombstone names. So a removal on
 *            another device takes a wallet out of this tab only when it had seen
 *            the very import this tab holds; an import it had not seen survives,
 *            whatever either device's clock says. A wallet this tab held before
 *            its first read takes the copy's tags when the copy lists it, and a
 *            fresh tag otherwise (it is here now: it stays and is saved back).
 *            A tombstone is dropped 30 days after the removal, by the remover's
 *            clock: a clock far off can only drop one early, which lets a stale
 *            device bring a removed wallet back. It never loses a key.
 *   positions the book's records pass through unchanged (positionsMap.js): in
 *            from 'positions:save' {positions}; out as 'account:positions'
 *            {positions} after every read of the copy, which is what makes the
 *            book start saving here; 'account:locked' when this sync stops or
 *            blocks. A 409 merges them record by record with the book's rule.
 *            Without a hub the copy's positions are kept as they are. When the
 *            copy would pass the size cap, the positions of the least recently
 *            seen tokens are left out of it, never a wallet.
 *   refuses  NEVER overwrites a copy it cannot read: a different keyId
 *            ('key_mismatch'), a copy that does not decrypt ('undecryptable')
 *            or does not parse ('unreadable') BLOCKS saving for this sync.
 *   retries  the codes the tp routes answer with: 'network', 'rate_limited'
 *            (429), 'unavailable' (502/503), 'store_full' (507) and 'busy'
 *            retry after 5 s, 15 s, then every 60 s, and never before the
 *            Retry-After of a 429 (whole seconds, capped at 10 min). A bodiless
 *            429 or 5xx (nginx's limit_req, a stopped backend) reads as
 *            'rate_limited' / 'unavailable'. A 401 waits for the visitor to
 *            sign in again (retry()).
 *
 * Only this module and keys/vault.js may take the keys out of walletStore
 * (keys/privateExports.test.js). Status reports carry no key and no plaintext.
 */
import {
  _exportForVault,
  _importFromVault,
  addresses as storeAddresses,
  removeWallet,
  subscribe as subscribeWallets,
} from '../keys/walletStore.js';
import { mergePositionMaps, normalizePositionMap, withoutOldestToken } from './positionsMap.js';
import { MAX_PLAIN_BYTES, open, seal } from './envelope.js';
import { hexlify, toUtf8Bytes } from 'ethers';

export const DEBOUNCE_MS = 5000;
export const MAX_WAIT_MS = 30000;
export const MIN_SAVE_GAP_MS = 10000;
export const TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
export const RETRY_MS = [5000, 15000, 60000];
export const MAX_TAGS = 8; // per wallet: more means as many devices imported it at once
export const MAX_TOMB_TAGS = 32; // per tombstone: a dropped one can only bring a wallet back
const MAX_ROUNDS = 3;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const TAG_RE = /^[0-9a-f]{16}$/;
// A copy entry with no tag at all (this code never writes one) counts as one
// import nobody has removed: it stays.
const UNTAGGED = '0000000000000000';
export const MAX_HOLD_MS = 10 * 60 * 1000;
const RETRYABLE = /^(network|rate_limited|unavailable|store_full|busy)$/;

const lower = (a) => String(a).toLowerCase();

const defaultKeys = {
  list: _exportForVault,
  add: _importFromVault,
  addresses: storeAddresses,
  remove: removeWallet,
  subscribe: subscribeWallets,
};

const MESSAGES = {
  no_session: 'Your sign-in expired. Sign in again to keep saving.',
  key_mismatch: 'The saved copy was re-created with another key elsewhere. This tab stopped saving: lock, then unlock again.',
  undecryptable: "The saved copy cannot be decrypted with this wallet's key. This tab will not overwrite it.",
  unreadable: 'The saved copy is unreadable. This tab will not overwrite it.',
  store_full: 'The server has no room for new saved copies right now.',
  network: 'Could not reach the server.',
  busy: 'Another tab or device keeps saving at the same moment.',
  rate_limited: 'The server asked this tab to save less often. It tries again by itself.',
  unavailable: 'Saving is unavailable on the server right now. This tab tries again by itself.',
};

/** Valid tags, each once, sorted, at most `max`. */
function tagList(list, max) {
  const ok = (Array.isArray(list) ? list : []).filter((g) => typeof g === 'string' && TAG_RE.test(g));
  return [...new Set(ok)].sort().slice(0, max);
}

/**
 * The comparable form of a copy: tombstones younger than 30 days
 * ({at, tags}), wallets sorted by address with their tags less the tombstoned
 * ones (a wallet left with none is gone), normalized positions. savedAt is
 * left out.
 *
 *   wallets  [{address, privateKey, tags: ['16 hex', …]}]   at most MAX_TAGS tags
 *   removed  {lowerAddress: {at: ms, tags: ['16 hex', …]}}   at most MAX_TOMB_TAGS
 */
export function normalizeContent(plain, t) {
  const tombs = [];
  const dead = new Map();
  const raw = plain && plain.removed && typeof plain.removed === 'object' && !Array.isArray(plain.removed) ? plain.removed : {};
  for (const [k, v] of Object.entries(raw)) {
    const a = lower(k);
    if (!ADDRESS_RE.test(a) || !v || typeof v !== 'object' || !Number.isSafeInteger(v.at) || v.at < t - TOMBSTONE_MS) continue;
    const tags = tagList(v.tags, MAX_TOMB_TAGS);
    if (!tags.length) continue;
    tombs.push([a, { at: v.at, tags }]);
    dead.set(a, new Set(tags));
  }
  tombs.sort((x, y) => (x[0] < y[0] ? -1 : 1));
  const wallets = [];
  const seen = new Set();
  for (const w of Array.isArray(plain && plain.wallets) ? plain.wallets : []) {
    if (!w || typeof w.address !== 'string' || typeof w.privateKey !== 'string') continue;
    const a = lower(w.address);
    if (!ADDRESS_RE.test(a) || seen.has(a)) continue;
    const named = tagList(w.tags, Infinity);
    const gone = dead.get(a);
    const tags = (named.length ? named : [UNTAGGED]).filter((g) => !gone || !gone.has(g)).slice(0, MAX_TAGS);
    if (!tags.length) continue; // every import of it was removed
    seen.add(a);
    wallets.push({ address: w.address, privateKey: w.privateKey, tags });
  }
  wallets.sort((x, y) => (lower(x.address) < lower(y.address) ? -1 : 1));
  return { wallets, removed: Object.fromEntries(tombs), positions: normalizePositionMap(plain && plain.positions) };
}

/**
 * @param {{
 *   api: {getVault: Function, putVault: Function},
 *   owner: string, key: CryptoKey, keyId: string,
 *   keys?: {list, add, addresses, remove, subscribe},
 *   hub?: {on: Function, emit: Function},
 *   subtle?: SubtleCrypto, getRandomValues?: Function, now?: () => number,
 *   setTimeout?: Function, clearTimeout?: Function, debounceMs?: number,
 *   minGapMs?: number, document?: {visibilityState, addEventListener, removeEventListener},
 *   onStatus?: (s: {state: string, rev: number, savedAt: number|null, error: string, code: string}) => void,
 *   onApplied?: (r: {added: number, removed: number, unreadable: number}) => void,
 * }} deps
 */
export function createVaultSync({
  api,
  owner,
  key,
  keyId,
  keys = defaultKeys,
  hub = null,
  subtle = globalThis.crypto && globalThis.crypto.subtle,
  getRandomValues = (b) => globalThis.crypto.getRandomValues(b),
  now = () => Date.now(),
  setTimeout: setT = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: clearT = (id) => globalThis.clearTimeout(id),
  debounceMs = DEBOUNCE_MS,
  minGapMs = MIN_SAVE_GAP_MS,
  document: doc = globalThis.document,
  onStatus = () => {},
  onApplied = () => {},
}) {
  const me = lower(owner);
  const tagsOf = new Map(); // lower address -> Set of tags: the imports of it this tab holds
  const tombs = new Map(); // lower address -> {tags: Set, at}: the removals this tab knows of
  const untagged = new Set(); // held before the first read, which tags them
  let book = {}; // the positions, in their saved form (positionsMap.js)
  let rev = null; // null until the copy has been read: nothing is written before that
  let lastDigest = null; // digest of the content the server holds
  let applying = false;
  let stopped = false;
  let blocked = false;
  let timer = null;
  let dueBy = null; // a pending change is saved by then at the latest (MAX_WAIT_MS)
  let retryTimer = null;
  let retryIdx = 0;
  let lastPutAt = null; // when this tab last sent a PUT (MIN_SAVE_GAP_MS)
  let holdUntil = 0; // no save before this: the server's Retry-After
  let inFlight = null;
  let again = false;
  let loading = null;
  let status = { state: 'loading', rev: 0, savedAt: null, error: '', code: '' };

  for (const a of keys.addresses()) untagged.add(lower(a));

  /** A new import's tag: 64 random bits, so no removal anywhere can have seen it. */
  const mint = () => hexlify(getRandomValues(new Uint8Array(8))).slice(2);

  /** Tell the positions book whether to save here ('account:positions') or stop ('account:locked'). */
  function tellBook(name, data) {
    if (hub) hub.emit(name, data);
  }

  function report(patch) {
    status = { ...status, ...patch };
    try {
      onStatus(status);
    } catch {
      // a UI bug must not stop the sync
    }
  }

  const result = (ok) => ({ ok, rev: rev ?? 0, code: ok ? '' : status.code, error: ok ? '' : status.error });

  function block(code) {
    blocked = true;
    if (timer !== null) clearT(timer);
    if (retryTimer !== null) clearT(retryTimer);
    timer = null;
    dueBy = null;
    retryTimer = null;
    report({ state: 'blocked', code, error: MESSAGES[code] || 'Saving stopped.' });
    tellBook('account:locked');
  }

  function codeOf(e) {
    const c = e && e.cause;
    if (!c) return 'error';
    if (c.status === 401) return 'no_session';
    const code = (typeof c.code === 'string' && c.code) || 'error';
    // A refusal without the tp routes' JSON {code} (nginx's limit_req 429, a 502
    // while the backend restarts) reaches here as api.js's http_<status>.
    if (code === `http_${c.status}`) {
      if (c.status === 429) return 'rate_limited';
      if (c.status >= 500) return 'unavailable';
    }
    return code;
  }

  /** How long the next scheduled save must still wait: the pacing gap and any Retry-After. */
  function waitLeft() {
    const t = now();
    const gap = lastPutAt === null ? 0 : lastPutAt + minGapMs - t;
    return Math.max(0, gap, holdUntil - t);
  }

  function failed(e) {
    const code = codeOf(e);
    if (code === 'key_mismatch' || code === 'undecryptable' || code === 'unreadable') {
      block(code);
      return result(false);
    }
    const asked = e && e.cause ? Number(e.cause.retryAfterMs) : NaN;
    if (Number.isFinite(asked) && asked > 0) holdUntil = Math.max(holdUntil, now() + Math.min(asked, MAX_HOLD_MS));
    const text = MESSAGES[code] || (e && e.message ? String(e.message).split(String.fromCharCode(10))[0] : 'Saving failed.');
    report({ state: 'error', code, error: text });
    if (RETRYABLE.test(code)) scheduleRetry();
    return result(false);
  }

  function scheduleRetry() {
    if (stopped || blocked || retryTimer !== null) return;
    const ms = Math.max(RETRY_MS[Math.min(retryIdx, RETRY_MS.length - 1)], holdUntil - now());
    retryIdx += 1;
    retryTimer = setT(() => {
      retryTimer = null;
      if (rev === null) load();
      else run();
    }, ms);
  }

  async function digestOf(content) {
    const bytes = toUtf8Bytes(JSON.stringify(content));
    try {
      return hexlify(new Uint8Array(await subtle.digest('SHA-256', bytes)));
    } finally {
      bytes.fill(0);
    }
  }

  /** The size of the plaintext seal() would encrypt for this content. */
  const plainBytes = (content, t) => toUtf8Bytes(JSON.stringify({ v: 2, owner: me, savedAt: t, ...content })).length;

  function localContent(t) {
    const wallets = keys.list().map((w) => {
      const a = lower(w.address);
      if (!tagsOf.has(a)) tagsOf.set(a, new Set([mint()])); // an import no event reported: a fresh one
      return { address: w.address, privateKey: w.privateKey, tags: [...tagsOf.get(a)] };
    });
    const removed = {};
    for (const [a, tomb] of tombs) removed[a] = { at: tomb.at, tags: [...tomb.tags] };
    let content = normalizeContent({ wallets, removed, positions: book }, t);
    // Over the size cap: the least recently seen tokens' positions stay out of
    // the copy (this tab keeps them); a wallet never does.
    while (Object.keys(content.positions).length && plainBytes(content, t) > MAX_PLAIN_BYTES) {
      content = { ...content, positions: withoutOldestToken(content.positions) };
    }
    return content;
  }

  /** Merge a decrypted copy into this tab. */
  function apply(plain) {
    const t = now();
    const copy = normalizeContent(plain, t);
    for (const [a, theirs] of Object.entries(copy.removed)) {
      const tomb = tombs.get(a) || { tags: new Set(), at: 0 };
      for (const g of theirs.tags) tomb.tags.add(g);
      tomb.at = Math.max(tomb.at, theirs.at);
      tombs.set(a, tomb);
    }
    for (const [a, tomb] of [...tombs]) if (tomb.at < t - TOMBSTONE_MS) tombs.delete(a);
    const live = (a, list) => {
      const tomb = tombs.get(a);
      return [...new Set(list)].filter((g) => !tomb || !tomb.tags.has(g)).sort().slice(0, MAX_TAGS);
    };
    const remote = new Map(); // lower address -> {w, tags}: the copy's wallets still present
    for (const w of copy.wallets) {
      const a = lower(w.address);
      const tags = live(a, w.tags);
      if (tags.length) remote.set(a, { w, tags });
    }
    const local = new Set(keys.addresses().map(lower));
    let gained = 0;
    let lost = 0;
    let unreadable = 0;
    applying = true;
    try {
      for (const a of local) {
        const theirs = remote.get(a);
        if (untagged.has(a)) {
          // Held before this first read: the copy's own import when it lists the
          // wallet, otherwise a fresh one (it is here, so it stays).
          untagged.delete(a);
          tagsOf.set(a, new Set(theirs ? theirs.tags : [mint()]));
          continue;
        }
        const mine = tagsOf.get(a) || new Set([mint()]);
        const tags = live(a, [...mine, ...(theirs ? theirs.tags : [])]);
        if (tags.length) {
          tagsOf.set(a, new Set(tags));
        } else {
          // Every import of it this tab holds was seen by the device that removed it.
          tagsOf.delete(a);
          keys.remove(a);
          lost += 1;
        }
      }
      for (const [a, theirs] of remote) {
        if (local.has(a)) continue;
        try {
          const n = keys.add([{ address: theirs.w.address, privateKey: theirs.w.privateKey }]).added;
          if (n) tagsOf.set(a, new Set(theirs.tags));
          gained += n;
        } catch {
          unreadable += 1; // a key that does not derive its address: dropped, never half-imported
        }
      }
      book = mergePositionMaps(book, copy.positions);
    } finally {
      applying = false;
    }
    if (gained || lost || unreadable) {
      try {
        onApplied({ added: gained, removed: lost, unreadable });
      } catch {
        // the page's refresh failing must not undo the merge
      }
    }
  }

  /**
   * Read the server's copy and merge it. Throws on a transport failure. After
   * every read the book hears the account's positions ('account:positions'): it
   * merges them and from then on saves its changes here.
   */
  async function pull() {
    const remote = await api.getVault();
    if (stopped) return;
    if (!remote) {
      apply({ wallets: [], removed: {}, positions: {} }); // no copy: what this tab holds is a fresh import
      rev = 0;
      lastDigest = null;
      tellBook('account:positions', { positions: normalizePositionMap(book) });
      return;
    }
    if (remote.keyId !== keyId) {
      block('key_mismatch');
      return;
    }
    let plain;
    try {
      plain = await open({ key, owner: me, envelope: remote, subtle });
    } catch (e) {
      block(codeOf(e) === 'unreadable' ? 'unreadable' : 'undecryptable');
      return;
    }
    if (stopped) return;
    apply(plain);
    rev = remote.rev;
    lastDigest = await digestOf(normalizeContent(plain, now()));
    status = { ...status, savedAt: remote.updatedAt || status.savedAt };
    if (!stopped) tellBook('account:positions', { positions: normalizePositionMap(book) });
  }

  async function saveOnce() {
    if (stopped || blocked) return result(false);
    if (rev === null) {
      await load();
      if (rev === null || stopped || blocked) return result(false);
    }
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const t = now();
      const content = localContent(t);
      const digest = await digestOf(content);
      if (stopped) return result(false);
      if (digest === lastDigest) {
        report({ state: 'saved', rev, error: '', code: '' });
        return result(true);
      }
      report({ state: 'saving', error: '', code: '' });
      let env;
      try {
        env = await seal({ key, owner: me, plain: { v: 2, owner: me, savedAt: t, ...content }, subtle, getRandomValues });
      } catch (e) {
        return failed(e);
      }
      try {
        lastPutAt = now();
        const r = await api.putVault({ baseRev: rev, kv: env.kv, keyId, iv: env.iv, ct: env.ct });
        rev = r.rev;
        lastDigest = digest;
        retryIdx = 0;
        if (!stopped) report({ state: 'saved', rev, savedAt: r.updatedAt || t, error: '', code: '' });
        return result(true);
      } catch (e) {
        if (codeOf(e) !== 'conflict') return failed(e);
        try {
          await pull();
        } catch (pe) {
          return failed(pe);
        }
        if (stopped || blocked) return result(false);
      }
    }
    return failed(new Error(MESSAGES.busy, { cause: { code: 'busy' } }));
  }

  function run() {
    if (stopped) return Promise.resolve(result(false));
    if (inFlight) {
      again = true;
      return inFlight;
    }
    const p = (async () => {
      try {
        let r;
        do {
          again = false;
          r = await saveOnce();
        } while (again && r.ok && !stopped);
        return r;
      } finally {
        inFlight = null;
      }
    })();
    inFlight = p;
    return p;
  }

  /**
   * (Re)arm the save timer: `delay` after the latest change (the debounce), but
   * by MAX_WAIT_MS after the first unsaved one, and never inside waitLeft().
   */
  function schedule(delay = debounceMs) {
    if (stopped || blocked) return;
    if (timer !== null) clearT(timer);
    const t = now();
    if (dueBy === null) dueBy = t + MAX_WAIT_MS;
    // Never over a parked failure: the strip would read "saving…" for the whole
    // debounce at exactly the moment new keys arrive, which is when the visitor most
    // needs to see that the account is NOT saving.
    if (rev !== null && status.state !== 'saving' && status.state !== 'error') report({ state: 'pending' });
    timer = setT(
      () => {
        timer = null;
        dueBy = null;
        run();
      },
      Math.max(Math.min(delay, dueBy - t), waitLeft(), 0),
    );
  }

  /** Save now what the timer would have saved later; a Retry-After still stands. */
  function saveEarly() {
    if (timer === null || stopped || blocked || holdUntil > now()) return;
    clearT(timer);
    timer = null;
    dueBy = null;
    run();
  }

  // A hidden page may be closing: its pending change goes out now (best effort).
  const onVisibility = () => {
    if (doc && doc.visibilityState === 'hidden') saveEarly();
  };
  const watchesPage = !!doc && typeof doc.addEventListener === 'function';

  function load() {
    if (loading) return loading;
    const p = (async () => {
      try {
        report({ state: 'loading', error: '', code: '' });
        await pull();
        if (stopped || blocked) return result(false);
        retryIdx = 0;
        report({ state: 'saved', rev, error: '', code: '' });
        if (rev === 0) schedule(0); // no copy yet: create it now
        else if ((await digestOf(localContent(now()))) !== lastDigest) schedule(); // this tab holds more
        return result(true);
      } catch (e) {
        return failed(e);
      } finally {
        loading = null;
      }
    })();
    loading = p;
    return p;
  }

  const offKeys = keys.subscribe((ev) => {
    if (applying || stopped || !ev) return;
    const t = now();
    for (const x of ev.addresses || []) {
      const a = lower(x);
      if (!ADDRESS_RE.test(a)) continue;
      untagged.delete(a);
      if (ev.type === 'add' || ev.type === 'duplicate') {
        tagsOf.set(a, new Set([mint()])); // an import (again): a tag no removal anywhere has seen
      } else if (ev.type === 'remove' || ev.type === 'clear') {
        const held = tagsOf.get(a);
        tagsOf.delete(a);
        if (!held || !held.size) continue; // never tagged (removed before the first read): nothing to name
        const tomb = tombs.get(a) || { tags: new Set(), at: 0 };
        for (const g of held) tomb.tags.add(g); // exactly the imports this tab had seen
        tomb.at = Math.max(tomb.at, t);
        tombs.set(a, tomb);
      }
    }
    schedule();
  });
  const offBook = hub
    ? hub.on('positions:save', (d) => {
        if (stopped || blocked) return;
        const next = mergePositionMaps(book, d && d.positions);
        if (JSON.stringify(next) === JSON.stringify(book)) return;
        book = next;
        schedule();
      })
    : () => {};
  if (watchesPage) doc.addEventListener('visibilitychange', onVisibility);

  return {
    load,
    schedule,
    /**
     * Save now (the debounce skipped) and wait for it: Lock, Disconnect and the
     * passphrase-vault move use it before taking wallets away.
     * @returns {Promise<{ok: boolean, rev: number, code: string, error: string}>}
     */
    async flush() {
      if (stopped) return result(false);
      if (timer !== null) {
        clearT(timer);
        timer = null;
      }
      dueBy = null;
      if (loading) await loading;
      return run();
    },
    /** After a sign-in again, or the visitor's Retry (which goes at once, Retry-After or not). */
    retry() {
      if (stopped || blocked) return Promise.resolve(result(false));
      if (retryTimer !== null) clearT(retryTimer);
      retryTimer = null;
      retryIdx = 0;
      holdUntil = 0;
      return rev === null ? load() : run();
    },
    stop() {
      stopped = true;
      if (timer !== null) clearT(timer);
      if (retryTimer !== null) clearT(retryTimer);
      timer = null;
      dueBy = null;
      retryTimer = null;
      offKeys();
      offBook();
      tellBook('account:locked'); // the book stops saving to an account nobody syncs
      if (watchesPage) doc.removeEventListener('visibilitychange', onVisibility);
    },
    status: () => status,
  };
}
