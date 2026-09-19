// The dApp's encrypted account (spec Addendum A, and C's saved starting sizes), end
// to end, through the page's OWN modules: api.js, account/account.js,
// account/keyCache.js, account/vaultSync.js, account/envelope.js, ui/hub.js and
// ui/positions.js, wired as App wires them: the positions book and the sync meet
// on a page hub. scripts/tp-fork-smoke.js runs it against the real backend;
// tpSmokeAccount.test.mjs runs it against the frontend's fake account server.
// Nothing here names an /api/tp/account path: every request is the page's own
// api.js, so a client/server mismatch fails here, whichever side moved.
//
// It returns booleans and counts only — never a key, a signature or an address —
// and every wallet it is given is a throwaway made by its caller.
// No escape sequences (memory: write-tool-escapes).
import { SigningKey, computeAddress, getAddress, getBytes, id } from 'ethers';

const WALLET_ID = 'tp-smoke';

/**
 * An EIP-1193 provider over one wallet: eth_requestAccounts / eth_accounts and
 * personal_sign (hex UTF-8 message, as the page sends it). Anything else is
 * refused with 4200; a sign request for another account with 4100.
 * @returns {{provider: object, counts: {signatures: number}}}
 */
export function walletProvider(wallet) {
  const counts = { signatures: 0 };
  const refuse = (code, message) => Object.assign(new Error(message), { code });
  const provider = {
    async request({ method, params } = {}) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [wallet.address];
      if (method === 'personal_sign') {
        const [hex, from] = Array.isArray(params) ? params : [];
        if (getAddress(String(from)) !== getAddress(wallet.address)) throw refuse(4100, 'not this wallet');
        counts.signatures += 1;
        return wallet.signMessage(getBytes(hex));
      }
      throw refuse(4200, 'unsupported method');
    },
    on() {},
    removeListener() {},
  };
  return { provider, counts };
}

/** One device's wallet list in the shape of vaultSync's `keys` port (walletStore is a page singleton). */
export function memoryKeys() {
  const m = new Map();
  const subs = new Set();
  const emit = (type, addresses) => {
    if (addresses.length) for (const fn of [...subs]) fn({ type, addresses });
  };
  return {
    list: () => [...m.values()].map((w) => ({ address: w.address, privateKey: w.privateKey })),
    addresses: () => [...m.values()].map((w) => w.address),
    add(list) {
      const ws = list.map((x) => {
        const address = computeAddress(new SigningKey(x.privateKey).publicKey);
        if (x.address && getAddress(x.address) !== address) throw new Error('a key does not derive its address');
        return { address, privateKey: x.privateKey };
      });
      const got = [];
      for (const w of ws) {
        if (m.has(w.address.toLowerCase())) continue;
        m.set(w.address.toLowerCase(), w);
        got.push(w.address);
      }
      emit('add', got);
      return { added: got.length, duplicates: ws.length - got.length };
    },
    remove(a) {
      const w = m.get(String(a).toLowerCase());
      if (!w) return false;
      m.delete(String(a).toLowerCase());
      emit('remove', [w.address]);
      return true;
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

function bindApi(api, fetch) {
  const o = { fetch };
  return {
    postChallenge: (a) => api.postChallenge(a, o),
    postLogin: (x) => api.postLogin(x, o),
    getAccountSession: () => api.getAccountSession(o),
    postLogout: () => api.postLogout(o),
    getVault: () => api.getVault(o),
    putVault: (x) => api.putVault(x, o),
    deleteVault: (rev) => api.deleteVault(rev, o),
  };
}

async function modules(load) {
  const [api, account, keyCache, vaultSync, envelope, positions, hub] = await Promise.all([
    load('api.js'),
    load('account/account.js'),
    load('account/keyCache.js'),
    load('account/vaultSync.js'),
    load('account/envelope.js'),
    load('ui/positions.js'),
    load('ui/hub.js'),
  ]);
  return { api, account, keyCache, vaultSync, envelope, positions, hub };
}

/**
 * One browser: its own transport (cookie jar), key cache (memory), wallet list,
 * page hub and positions book — the book connected to the hub, as App's first
 * effect connects it.
 */
function makeDevice(mods, { transport, owner, origin, name, now, bodies }) {
  const fetch = transport(name);
  const recorded = async (url, init = {}) => {
    if (init.body !== undefined) bodies.push(String(init.body));
    return fetch(url, init);
  };
  const api = bindApi(mods.api, recorded);
  const { provider, counts } = walletProvider(owner);
  const account = mods.account.createAccount({
    api,
    discovery: { provider: (wid) => (wid === WALLET_ID ? provider : null) },
    keyCache: mods.keyCache.createKeyCache({ indexedDB: null }),
    origin,
  });
  const keys = memoryKeys();
  const book = mods.positions.createPositionBook({ storage: null, hash: id, now });
  const hub = mods.hub.createHub();
  book.connect(hub);
  return { api, account, counts, keys, book, hub };
}

async function signInAndUnlock(device) {
  const signedIn = await device.account.signIn(WALLET_ID);
  const unlocked = signedIn && (await device.account.unlock(WALLET_ID)) && device.account.get().status === 'unlocked';
  return { signedIn, unlocked, error: unlocked ? '' : device.account.get().error || 'not unlocked' };
}

function syncFor(mods, device) {
  const k = device.account.keyFor();
  return mods.vaultSync.createVaultSync({ api: device.api, owner: k.address, key: k.key, keyId: k.keyId, keys: device.keys, hub: device.hub });
}

/**
 * Device 1 signs in, unlocks (a first unlock signs twice), takes the bundle
 * wallets and one recorded position per wallet in `token`, and saves. Device 2
 * signs in, unlocks once, loads — and must get every wallet and every position
 * record back exactly.
 * @param {{load: (rel: string) => Promise<object>, transport: (device: string) => Function,
 *   owner: {address: string, signMessage: Function}, wallets: Array<{address, privateKey}>,
 *   token: string, origin: string, now?: () => number}} deps
 */
export async function accountRoundTrip({ load, transport, owner, wallets, token, origin, now = () => Date.now() }) {
  const mods = await modules(load);
  const bodies = [];
  const out = {
    error: '',
    signedIn1: false,
    unlocked1: false,
    signatures1: 0,
    saved: false,
    rev: 0,
    signedIn2: false,
    unlocked2: false,
    signatures2: 0,
    sameKey: false,
    walletsBack: false,
    positionsBack: false,
    bodiesClean: false,
    requests: 0,
  };
  const finish = () => {
    const sent = bodies.join(' ').toLowerCase();
    out.bodiesClean = wallets.every((w) => !sent.includes(w.privateKey.slice(2).toLowerCase()) && !sent.includes(w.address.slice(2).toLowerCase()));
    out.requests = bodies.length;
    return out;
  };

  const d1 = makeDevice(mods, { transport, owner, origin, name: 'device-1', now, bodies });
  const s1 = await signInAndUnlock(d1);
  out.signedIn1 = s1.signedIn;
  out.unlocked1 = s1.unlocked;
  out.signatures1 = d1.counts.signatures;
  if (!s1.unlocked) {
    out.error = `device 1: ${s1.error}`;
    return finish();
  }
  d1.keys.add(wallets);
  d1.book.observe(
    token,
    wallets.map((w, i) => ({ address: w.address, tokens: String(1000n * BigInt(i + 1)), inflight: '0', balanceKnown: true }))
  );
  const sync1 = syncFor(mods, d1);
  const loaded1 = await sync1.load();
  const flushed = await sync1.flush();
  sync1.stop();
  out.saved = loaded1.ok && flushed.ok && flushed.rev >= 1;
  out.rev = flushed.rev;

  const d2 = makeDevice(mods, { transport, owner, origin, name: 'device-2', now, bodies });
  const s2 = await signInAndUnlock(d2);
  out.signedIn2 = s2.signedIn;
  out.unlocked2 = s2.unlocked;
  out.signatures2 = d2.counts.signatures;
  if (!s2.unlocked) {
    out.error = `device 2: ${s2.error}`;
    return finish();
  }
  out.sameKey = d2.account.keyFor().keyId === d1.account.keyFor().keyId;
  const sync2 = syncFor(mods, d2);
  const loaded2 = await sync2.load();
  sync2.stop();
  const want = new Map(wallets.map((w) => [w.address.toLowerCase(), w.privateKey]));
  const got = d2.keys.list();
  out.walletsBack = loaded2.ok && got.length === want.size && got.every((w) => want.get(w.address.toLowerCase()) === w.privateKey);
  const mine = d1.book.forToken(token);
  const theirs = d2.book.forToken(token);
  out.positionsBack = wallets.every((w) => {
    const a = w.address.toLowerCase();
    return !!mine[a] && !!theirs[a] && JSON.stringify(theirs[a]) === JSON.stringify(mine[a]);
  });
  await d1.account.disconnect();
  await d2.account.disconnect();
  return finish();
}

/**
 * The owner reads the account's copy on a fresh device (sign in, one unlock
 * signature) and compares it with the wallets it should hold. Returns whether
 * the wallets match (addresses AND keys, compared here, never returned), the
 * positions map (throwaway addresses and amounts: not secret) and the error.
 */
export async function readAccountCopy({ load, transport, owner, origin, expect, now = () => Date.now() }) {
  const mods = await modules(load);
  const d = makeDevice(mods, { transport, owner, origin, name: 'reader', now, bodies: [] });
  const s = await signInAndUnlock(d);
  if (!s.unlocked) return { error: s.error, sameWallets: false, positions: {}, signatures: d.counts.signatures };
  const k = d.account.keyFor();
  let plain;
  try {
    const envelope = await d.api.getVault();
    if (!envelope) return { error: 'no saved copy', sameWallets: false, positions: {}, signatures: d.counts.signatures };
    plain = await mods.envelope.open({ key: k.key, owner: k.address.toLowerCase(), envelope });
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 200), sameWallets: false, positions: {}, signatures: d.counts.signatures };
  } finally {
    await d.account.disconnect();
  }
  const want = new Map(expect.map((w) => [w.address.toLowerCase(), w.privateKey]));
  const list = Array.isArray(plain.wallets) ? plain.wallets : [];
  const sameWallets = list.length === want.size && list.every((w) => want.get(String(w.address).toLowerCase()) === w.privateKey);
  const positions = plain.positions && typeof plain.positions === 'object' && !Array.isArray(plain.positions) ? plain.positions : {};
  return { error: '', sameWallets, positions, signatures: d.counts.signatures };
}
