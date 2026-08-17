'use strict';

// The only module that ever touches plaintext private keys.
//
// Wallets are stored AES-256-GCM encrypted, under a key derived from
// KEYSTORE_PASSPHRASE with scrypt. The GCM auth tag means a wrong passphrase
// fails closed (decryption throws) rather than returning garbage that would
// later be signed with.
//
// One store per user: each user gets their own file, encrypted under the
// same server-wide KEYSTORE_PASSPHRASE (there is no per-user passphrase).
// Instances are memoised in `instances` so repeated calls for the same user
// share one in-memory cache instead of re-reading the file every time.
//
// Each user has TWO files, not one: the live keystore, and an archive beside
// it holding what has been deleted. A delete moves the wallet from one to the
// other rather than dropping it, so a mis-click is recoverable — see the
// header on `remove` below for why the archive is a second encrypted store and
// not an automatic export to disk.
//
// The archive is reachable from the SERVER ONLY. No HTTP route lists, restores
// or purges it; `npm run archive:*` (backend/scripts/archive.js) is the whole
// of the way in, because the archive is the recovery path for the compromise
// that would otherwise reach it. It holds MAX_ARCHIVED wallets and no more —
// read that constant before changing it, the cap destroys keys.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Wallet, HDNodeWallet, getAddress } = require('ethers');
const config = require('../config');
const history = require('../store/history');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const VERSION = 1;

/**
 * How many deleted wallets the archive keeps per user, newest first.
 *
 * THIS CAP DESTROYS PRIVATE KEYS, and that is the whole of what is being traded
 * away. The archive shipped uncapped on purpose: evicting the oldest entry is
 * not housekeeping, it is the irreversible destruction of a key — the same act
 * as purge(), without an operator asking for it — and it destroys exactly the
 * thing the archive exists to protect. An evicted wallet is recoverable only
 * from a backup already downloaded. The operator has weighed that against an
 * archive that grows without bound and chosen the cap; this is that decision,
 * not an oversight.
 *
 * What keeps it from being invisible is the eviction record. remove() returns
 * every entry it dropped and warns to the server log at the point of
 * destruction, and its callers write each evicted address into the user's
 * activity log (see the DELETE route in routes/wallets.js). That line may be the
 * only remaining evidence the key ever existed, so an eviction is never allowed
 * to pass silently.
 */
const MAX_ARCHIVED = 100;

const DEFAULT_ID = 'default';

// v1 uses dev + bundle. v2 uses its own three so the strategies never share a
// wallet — see the note above devWallet().
// Three owners, no overlap:
//   dev / bundle                      — the v1 launcher
//   v2dev / v2bundle                  — the v2 launcher
//   distdev / distfunding / distbundle — the distributor strategy
//
// The dist* names exist because the distributor used to hold v2dev/v2funding/
// v2bundle, and the v2 LAUNCHER then took two of those three. Two features
// spending one wallet while each believed it owned it is the exact bug the
// roles were introduced to prevent, so the older and currently-disabled of the
// two moved rather than the live one.
//
// 'v2funding' is kept for one reason: a keystore written before that move may
// still hold a wallet under it. Nothing reads it now, but dropping it from this
// set would make the wallet unreachable — setRole would refuse to move it out
// and the operator could not recover the key through the console.
//
// v3dev / v3main / v3bundle are the fourth owner — the Relay chain. Their names
// live in v3/roles.js, which is V3's own table and shares nothing with
// variants.js; they are listed HERE because this set is the one gate every
// wallet passes through. add() resolves a role it does not recognise to
// 'bundle', so leaving them out would not fail — it would silently create every
// V3 wallet holding v1's bundle role, on v1's tab, spendable by v1's launcher.
const ROLES = new Set([
  'dev',
  'bundle',
  'v2dev',
  'v2bundle',
  'distdev',
  'distfunding',
  'distbundle',
  'v2funding',
  'v3dev',
  'v3main',
  'v3bundle',
]);
// v3main joins the singletons: the chain sells from one position, and a second
// main wallet would mean half the supply sitting somewhere the engine never
// looks.
const SINGLETON_ROLES = new Set([
  'dev',
  'v2dev',
  'distdev',
  'distfunding',
  'v2funding',
  'v3dev',
  'v3main',
]);
const instances = new Map();
// Same alphabet as users.slug() (backend/src/users/users.js). Duplicated
// rather than imported: this module deliberately consumes nothing from the
// users layer (a keystore is addressed by an id string, not a user record),
// but adoptLegacy is destructive enough that it must not take that id on
// trust — see the comment on adoptLegacy below.
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

function passphrase() {
  if (!config.keystorePassphrase) {
    throw new Error('KEYSTORE_PASSPHRASE is not set — cannot read or write the keystore');
  }
  return config.keystorePassphrase;
}

/** Where a user's keystore lives. 'default' keeps the original path exactly. */
function pathFor(userId) {
  if (userId === DEFAULT_ID) return config.keystorePath;
  const dir = path.dirname(config.keystorePath);
  // userId is validated at creation (users.slug, /^[a-z0-9][a-z0-9-]{0,31}$/)
  // and never taken from a request, so it cannot escape this directory — this
  // function does not re-sanitise, and must never be handed anything else.
  return path.join(dir, `wallets.${userId}.keystore.json`);
}

/**
 * Where a user's ARCHIVE of deleted wallets lives — beside their live keystore,
 * derived the same way from the same directory so the two never separate.
 *
 * 'default' gets a fixed name rather than config.keystorePath, because that
 * path is the live file itself and there is only one of it. Same shape as
 * store/activity.js's pathFor, and the same rule applies: userId is validated
 * at creation and never taken from a request, so this does not re-sanitise.
 */
function archivePathFor(userId) {
  const dir = path.dirname(config.keystorePath);
  return path.join(
    dir,
    userId === DEFAULT_ID ? 'wallets.archive.keystore.json' : `wallets.archive.${userId}.keystore.json`
  );
}

/**
 * One encrypted file: the load/persist/encrypt/decrypt machinery, and nothing
 * about wallets.
 *
 * Extracted so the archive is not a second implementation of the security
 * posture but LITERALLY THE SAME CODE — same AES-256-GCM, same scrypt
 * parameters, same passphrase, same 0600 file mode, same fail-closed GCM tag.
 * An archive encrypted a little differently from the keystore would be a
 * weakening dressed as a feature; there is only one way to encrypt here.
 *
 * Each vault carries its own random salt, so a record cannot be moved between
 * files as ciphertext — it is decrypted out of one and re-encrypted into the
 * other. That is deliberate: the archive stays readable when the live keystore
 * is deleted and recreated, which is exactly the situation a mistaken delete
 * tends to be part of.
 */
function vault(file) {
  let cache = null; // { version, kdf, wallets: [...] }
  let derivedKey = null; // Buffer, memoised per (passphrase, salt)

  function deriveKey(saltHex) {
    if (derivedKey) return derivedKey;
    derivedKey = crypto.scryptSync(passphrase(), Buffer.from(saltHex, 'hex'), SCRYPT.keylen, {
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
    });
    return derivedKey;
  }

  function emptyStore() {
    return { version: VERSION, kdf: { salt: crypto.randomBytes(32).toString('hex'), ...SCRYPT }, wallets: [] };
  }

  function load() {
    if (cache) return cache;
    if (!fs.existsSync(file)) {
      cache = emptyStore();
      return cache;
    }
    cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cache;
  }

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 0600 — the keystore is only ever readable by the account running the app.
    fs.writeFileSync(file, JSON.stringify(cache, null, 2), { mode: 0o600 });
  }

  function encrypt(plaintext) {
    const store = load();
    const key = deriveKey(store.kdf.salt);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      ciphertext: ct.toString('hex'),
    };
  }

  function decrypt(record) {
    const store = load();
    const key = deriveKey(store.kdf.salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(record.tag, 'hex'));
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, 'hex')),
        decipher.final(),
      ]).toString('utf8');
    } catch (_err) {
      // GCM tag mismatch — wrong passphrase, or the file was tampered with.
      throw new Error('could not decrypt wallet — wrong KEYSTORE_PASSPHRASE?');
    }
  }

  function reset() {
    cache = null;
    derivedKey = null;
  }

  return { load, persist, encrypt, decrypt, reset };
}

function build(userId) {
  const live = vault(pathFor(userId));
  // Untouched until something is deleted or the archive is read, so the second
  // scrypt derivation is never paid for on the ordinary path.
  const bin = vault(archivePathFor(userId));

  const load = live.load;
  const persist = live.persist;
  const encrypt = live.encrypt;
  const decrypt = live.decrypt;

  function publicView(w) {
    return { id: w.id, address: w.address, label: w.label, role: w.role, createdAt: w.createdAt };
  }

  /** Every wallet, without keys. Never returns key material. */
  function list() {
    return load().wallets.map(publicView);
  }

  function get(id) {
    const w = load().wallets.find((x) => x.id === id);
    if (!w) throw new Error(`no wallet ${id}`);
    return w;
  }

  function add(privateKey, { label, role }) {
    const wallet = new Wallet(privateKey);
    const store = load();
    if (store.wallets.some((w) => w.address.toLowerCase() === wallet.address.toLowerCase())) {
      // Naming the role it already holds is the difference between a usable
      // error and a dead end: the commonest way to hit this is importing an
      // existing v1 wallet as a v2 one, and the answer is that v2 needs its
      // own — which the bare message did not say.
      const held = store.wallets.find(
        (w) => w.address.toLowerCase() === wallet.address.toLowerCase()
      );
      throw new Error(
        `wallet ${wallet.address} is already in the keystore as a "${held.role}" wallet. ` +
          'A wallet can hold only one role — import a different key, or create a new one.'
      );
    }
    // Only one dev wallet: it is the launch signer and the funding source, and
    // two of them would silently make "the dev wallet" ambiguous. The v2 signer
    // and funder are singular for the same reason — see SINGLETON_ROLES.
    if (SINGLETON_ROLES.has(role) && store.wallets.some((w) => w.role === role)) {
      throw new Error(`a ${role} wallet already exists — delete it first`);
    }
    // EVERY wallet is created here — generate() and importKeys() both funnel
    // through add() — so this is the one line that decides whether a role
    // survives. It used to read `role === 'dev' ? 'dev' : 'bundle'`, which
    // silently collapsed every v2 role into a v1 bundle wallet: the V2 tab
    // looked like it worked, the wallets turned up on the V1 tab, and nothing
    // errored anywhere. Unknown roles still fall back rather than being stored
    // raw, so a typo cannot invent a role no panel will ever show.
    const resolved = ROLES.has(role) ? role : 'bundle';
    const record = {
      id: crypto.randomUUID(),
      address: getAddress(wallet.address),
      label: label || resolved,
      role: resolved,
      createdAt: new Date().toISOString(),
      ...encrypt(wallet.privateKey),
    };
    store.wallets.push(record);
    persist();
    return publicView(record);
  }

  /** Generate `count` fresh wallets. Robinhood Chain is EVM — plain secp256k1. */
  function generate(count, { label, role } = {}) {
    const made = [];
    for (let i = 0; i < count; i++) {
      const w = HDNodeWallet.createRandom();
      made.push(add(w.privateKey, { label: label ? `${label}-${i + 1}` : undefined, role }));
    }
    return made;
  }

  /** Import existing keys (0x-prefixed or bare hex). */
  function importKeys(privateKeys, { label, role } = {}) {
    return privateKeys
      .map((k) => String(k).trim())
      .filter(Boolean)
      .map((k, i) => {
        const key = k.startsWith('0x') ? k : `0x${k}`;
        return add(key, { label: label ? `${label}-${i + 1}` : undefined, role });
      });
  }

  /** An archived entry as anyone outside this module may see it. No key. */
  function archiveView(w) {
    return {
      id: w.id,
      address: w.address,
      label: w.label,
      role: w.role,
      createdAt: w.createdAt,
      deletedAt: w.deletedAt,
    };
  }

  /**
   * Delete a wallet — by moving it to the archive, not by dropping the key.
   *
   * The operator has twice been one click from destroying a funded wallet, and
   * the keystore holds private keys and no mnemonics, so a delete used to be
   * final unless a backup had already been downloaded. The obvious fix — write
   * the key out to a file on the way past — would create a SECOND, PLAINTEXT
   * KEYSTORE on the same disk, which is a worse problem than the one it solves.
   *
   * So the key moves into a second file encrypted exactly as the first: same
   * cipher, same KDF, same passphrase, same 0600 mode (see `vault`). The
   * security posture is unchanged — an attacker who can read the archive could
   * already read the keystore — and a mistaken delete is recoverable.
   *
   * Archive first, then drop from the live store. If the second write fails the
   * key exists in both files, which is a duplicate; the other order loses it.
   * An archived entry for the same address is replaced rather than stacked, so
   * delete → restore → delete leaves one entry, not a pile.
   *
   * The archive holds MAX_ARCHIVED wallets and no more, so a delete can destroy
   * an older key to make room for this one. Every evicted entry comes back in
   * `evicted` — the caller MUST record it; read the comment on MAX_ARCHIVED
   * before treating that as optional.
   */
  function remove(id) {
    const store = load();
    const record = store.wallets.find((w) => w.id === id);
    if (!record) throw new Error(`no wallet ${id}`);

    const archive = bin.load();
    archive.wallets = archive.wallets.filter(
      (w) => w.address.toLowerCase() !== record.address.toLowerCase()
    );
    archive.wallets.unshift({
      id: record.id,
      address: record.address,
      label: record.label,
      role: record.role,
      createdAt: record.createdAt,
      deletedAt: new Date().toISOString(),
      // Re-encrypted under the archive's own salt. Plaintext exists only for
      // the length of this expression, inside the one module allowed to hold it.
      ...bin.encrypt(decrypt(record)),
    });

    // Oldest-first eviction, by deletedAt rather than by position: the cap
    // decides which keys stop existing, so "the oldest" has to mean the oldest
    // DELETE and not merely whatever ended up last in the file. The sort is
    // stable, so entries sharing a timestamp — 101 deletes in the same
    // millisecond is a scripted cleanup, not a hypothetical — keep insertion
    // order, and the wallet just archived stays at the front of its own second.
    archive.wallets.sort((a, b) =>
      String(b.deletedAt || '').localeCompare(String(a.deletedAt || ''))
    );
    const evicted = archive.wallets.slice(MAX_ARCHIVED).map(archiveView);
    archive.wallets = archive.wallets.slice(0, MAX_ARCHIVED);
    // Said on the server log at the moment of destruction, independently of
    // whether the caller remembers to record it: this is a key ceasing to
    // exist, and it must leave a trace even on a path that forgets.
    for (const gone of evicted) {
      console.warn(
        `[pons-launcher] ARCHIVED KEY EVICTED — ${gone.address} dropped from a full archive ` +
          `(${MAX_ARCHIVED} max), deleted ${gone.deletedAt}; its private key is destroyed`
      );
    }
    bin.persist();

    store.wallets = store.wallets.filter((w) => w.id !== id);
    persist();
    return { removed: id, archived: true, address: record.address, evicted };
  }

  /** What has been deleted, newest first. Addresses and dates — never keys. */
  function archived() {
    return bin.load().wallets.map(archiveView);
  }

  /**
   * Every address this account holds OR HAS HELD — the live keystore plus the
   * archive, deduplicated, checksummed.
   *
   * This exists for the sell gate, which asks "did a wallet of ours launch this
   * token?" against the factory's recorded deployer. The live keystore alone is
   * the wrong answer to that question: rotating the dev wallet does not un-launch
   * the tokens it deployed, and comparing against the current dev wallet only
   * orphaned eight of the operator's own tokens — the factory still names the
   * rotated-away wallet, forever. The archive is where a rotated wallet lives
   * (see `remove`), so the union of the two is the honest membership test.
   *
   * IT IS A MEMBERSHIP TEST AND NOT A WEAKENING. Nothing is listed because a
   * wallet holds it; the deployer must still be one of these addresses, and a
   * dusted token's deployer is a stranger who appears in neither file.
   *
   * The archive is capped (MAX_ARCHIVED) and evicts, so a wallet rotated away
   * long ago can be gone from here. That token then stays unlisted and the
   * caller says so — a narrower answer, never a wrong one. Restoring the wallet
   * (`npm run archive:restore`) or re-importing its key puts it back in range.
   *
   * Metadata only, like every other view out of this module: addresses, no keys,
   * and no decryption — so it costs no scrypt derivation on the archive's salt.
   */
  function ownedAddresses() {
    const seen = new Map(); // lowercase → checksummed, first spelling wins
    for (const w of [...load().wallets, ...bin.load().wallets]) {
      try {
        const a = getAddress(w.address);
        if (!seen.has(a.toLowerCase())) seen.set(a.toLowerCase(), a);
      } catch (_err) {
        // A malformed address in either file narrows the gate; it never widens
        // it, and it must not take the whole list down with it.
      }
    }
    return [...seen.values()];
  }

  /**
   * Put an archived wallet back into the live keystore.
   *
   * The live store's rules are the live store's rules: an address already
   * present is refused, and a dev wallet is refused when one already exists,
   * because the keystore permits exactly one and two would silently make "the
   * dev wallet" ambiguous. Restoring keeps the original id and createdAt, so a
   * restored wallet is the same wallet to the activity log and to anything
   * holding its id — only `deletedAt` is dropped, because it is no longer true.
   */
  function restore(id) {
    const archive = bin.load();
    const record = archive.wallets.find((w) => w.id === id);
    if (!record) throw new Error(`no archived wallet ${id}`);

    const store = load();
    if (store.wallets.some((w) => w.address.toLowerCase() === record.address.toLowerCase())) {
      throw new Error(`wallet ${record.address} is already in the keystore`);
    }
    if (record.role === 'dev' && store.wallets.some((w) => w.role === 'dev')) {
      throw new Error('a dev wallet already exists — delete it first');
    }

    const key = bin.decrypt(record);
    // The archive is a recovery path, so it checks rather than assumes: a key
    // that no longer derives the address it is filed under would restore a
    // wallet the operator cannot actually spend from.
    if (getAddress(new Wallet(key).address) !== getAddress(record.address)) {
      throw new Error(`archived key for ${record.address} does not match its address`);
    }

    const restored = {
      id: record.id,
      address: record.address,
      label: record.label,
      role: record.role,
      createdAt: record.createdAt,
      ...encrypt(key),
    };
    // Live first, archive second — same reasoning as remove(), in reverse.
    store.wallets.push(restored);
    persist();

    archive.wallets = archive.wallets.filter((w) => w.id !== id);
    bin.persist();
    return publicView(restored);
  }

  /**
   * Destroy an archived key for good.
   *
   * Deleting has to be able to mean deleting. An operator removing a
   * compromised key expects it gone, and an archive that quietly kept it would
   * be a surprise in the wrong direction — so this is the one call that makes
   * "gone" true, and the console says plainly that a delete only archives.
   */
  function purge(id) {
    const archive = bin.load();
    const record = archive.wallets.find((w) => w.id === id);
    if (!record) throw new Error(`no archived wallet ${id}`);
    archive.wallets = archive.wallets.filter((w) => w.id !== id);
    bin.persist();
    return { purged: id, address: record.address };
  }

  /** A signer for `id`. Plaintext keys exist only inside this call's stack. */
  function signer(id, provider) {
    const record = get(id);
    const wallet = new Wallet(decrypt(record));
    return provider ? wallet.connect(provider) : wallet;
  }

  /** Deliberate key export. Callers must gate this behind explicit confirmation. */
  function exportKey(id) {
    return { address: get(id).address, privateKey: decrypt(get(id)) };
  }

  /**
   * Every wallet with its plaintext key, for the operator to back up offline.
   *
   * There are no mnemonics to return: generate() derives each wallet from its own
   * random HD node but stores only the private key, so the phrase is gone the
   * moment the wallet is created. A private key restores a wallet in any EVM
   * client, which is what a backup needs to do.
   *
   * The most dangerous call in the app — the caller must demand explicit
   * confirmation and log it.
   */
  function exportAll() {
    return load().wallets.map((w) => ({
      ...publicView(w),
      privateKey: decrypt(w),
    }));
  }

  // The roles a wallet can hold. 'dev' and 'bundle' are v1's and are unchanged.
// The three v2 roles exist so the two strategies never share a wallet: the
// tabs were reading the same set, which made every v2 screen say "shared with
// V1" and left an operator unsure which wallets a button was about to spend.
//
// Keeping them in one keystore rather than two is deliberate — the encryption,
// the archive and the backup all keep working for v2 wallets with no second
// implementation to keep in step. The separation is by role, not by file.
function devWallet() {
    const dev = load().wallets.find((w) => w.role === 'dev');
    if (!dev) throw new Error('no dev wallet in the keystore — generate or import one first');
    return publicView(dev);
  }

  function bundleWallets() {
    return load().wallets.filter((w) => w.role === 'bundle').map(publicView);
  }

  /**
   * Move a wallet from one role to another.
   *
   * Exists because the alternative is worse. A wallet already in the keystore
   * cannot be imported again — one key, one role, or the two tabs would be
   * spending the same address while claiming to be separate — so an operator
   * who wants an existing, already-funded wallet as their v2 signer would
   * otherwise have to generate a new one and transfer everything across for no
   * reason but bookkeeping.
   *
   * The singleton rule still holds: moving INTO dev, v2dev or v2funding fails
   * if one already exists, because "the signer" has to be unambiguous.
   */
  function setRole(id, role) {
    if (!ROLES.has(role)) throw new Error(`unknown role "${role}"`);
    const store = load();
    const record = store.wallets.find((w) => w.id === id);
    if (!record) throw new Error(`no wallet ${id}`);
    if (record.role === role) return publicView(record);
    if (SINGLETON_ROLES.has(role) && store.wallets.some((w) => w.role === role)) {
      throw new Error(`a ${role} wallet already exists — delete or move it first`);
    }
    record.role = role;
    persist();
    return publicView(record);
  }

  /** The single wallet holding a given singleton role, or null. */
  function walletWithRole(role) {
    const found = load().wallets.find((w) => w.role === role);
    return found ? publicView(found) : null;
  }

  /** Every wallet holding a given role. */
  function walletsWithRole(role) {
    return load().wallets.filter((w) => w.role === role).map(publicView);
  }

  /** Test seam — drops the in-memory cache and derived key of both files. */
  function _reset() {
    live.reset();
    bin.reset();
  }

  return {
    list,
    generate,
    importKeys,
    remove,
    archived,
    ownedAddresses,
    restore,
    purge,
    signer,
    exportKey,
    exportAll,
    devWallet,
    bundleWallets,
    setRole,
    walletWithRole,
    walletsWithRole,
    _reset,
  };
}

function keystoreFor(userId = DEFAULT_ID) {
  if (!instances.has(userId)) instances.set(userId, build(userId));
  return instances.get(userId);
}

/**
 * Hand the pre-multi-user keystore to a named user, so an existing deployment's
 * wallets are not stranded under 'default' the moment users are created.
 *
 * This is the one call in the module that moves a file full of private keys,
 * so — however well validated the current caller's id is — it is not taken
 * on trust here. An id that is not a validated slug (undefined, '', a path
 * fragment like '../x') throws rather than being interpolated into a path
 * and renamed onto.
 */
function adoptLegacy(userId) {
  if (typeof userId !== 'string' || !ID.test(userId)) {
    throw new Error(`invalid user id "${userId}"`);
  }
  if (userId === DEFAULT_ID) return false;

  const from = config.keystorePath;
  const to = pathFor(userId);
  if (!fs.existsSync(from) || fs.existsSync(to)) return false;
  fs.renameSync(from, to);
  instances.clear();

  // The archive travels with the keystore it belongs to, or the adopting user
  // inherits the wallets without the ability to undo a delete of them — and the
  // stranded file would still hold the previous occupant's keys.
  const binFrom = archivePathFor(DEFAULT_ID);
  const binTo = archivePathFor(userId);
  if (fs.existsSync(binFrom) && !fs.existsSync(binTo)) fs.renameSync(binFrom, binTo);

  // Best effort: --adopt should mean the user's whole prior footprint, not
  // just the wallets. The wallets have already moved by this point, so if
  // history's target happens to exist, we leave history behind rather than
  // fail the adopt (which already succeeded) with no way to signal a partial
  // result — the caller only gets a boolean.
  const historyFrom = config.historyPath;
  const historyTo = history.pathFor(userId);
  if (fs.existsSync(historyFrom) && !fs.existsSync(historyTo)) {
    fs.renameSync(historyFrom, historyTo);
  }

  return true;
}

const def = () => keystoreFor(DEFAULT_ID);

module.exports = {
  keystoreFor,
  adoptLegacy,
  archivePathFor,
  MAX_ARCHIVED,
  // Bound to the default user so every existing caller keeps working.
  list: (...a) => def().list(...a),
  generate: (...a) => def().generate(...a),
  importKeys: (...a) => def().importKeys(...a),
  remove: (...a) => def().remove(...a),
  archived: (...a) => def().archived(...a),
  ownedAddresses: (...a) => def().ownedAddresses(...a),
  restore: (...a) => def().restore(...a),
  purge: (...a) => def().purge(...a),
  signer: (...a) => def().signer(...a),
  exportKey: (...a) => def().exportKey(...a),
  exportAll: (...a) => def().exportAll(...a),
  devWallet: (...a) => def().devWallet(...a),
  bundleWallets: (...a) => def().bundleWallets(...a),
  // Module-level test seam — must clear ALL instances, not just 'default', or
  // a test that reloads this module under a different passphrase (see
  // keystore.test.js) would see another user's stale cache/derivedKey.
  _reset: () => instances.clear(),
};
