/**
 * The visitor's account (spec Addendum A): a connected browser wallet, a SIWE
 * sign-in held by an httpOnly cookie, and the unlock key of the account's
 * encrypted copy of their wallets.
 *
 *   status    'starting'    resume() has not answered yet
 *             'out'         not signed in (the page works as before: memory only)
 *             'locked'      signed in; the unlock key is not in this tab
 *             'unlocked'    signed in and the key is here: the copy can sync
 *             'unsupported' this wallet cannot give a stable key (it signs the
 *                           same message differently each time, or it is a
 *                           smart-contract wallet): the passphrase vault remains
 *   step      what the wallet is being asked right now, or null:
 *             'connecting' | 'signing-in' | 'unlocking' | 'confirming' | 'deleting'
 *   address       the signed-in account (checksummed), or null
 *   walletAddress the connected wallet's current account, or null. It can
 *                 differ from address (the visitor switched accounts in the
 *                 wallet): the page NEVER wipes anything on its own then — a
 *                 sell may be in flight — it says so and offers a choice.
 *   walletLocked  the wallet reported no accounts (it was locked)
 *   keyEpoch      +1 whenever the unlock key appears or goes: the page restarts
 *                 its sync on a change of this number, not on status changes
 *   error         the last failure as readable text, '' when none
 *
 * The key never enters this state: keyFor() hands it to the sync alone. First
 * unlock of an account (the server holds no copy yet) asks for the unlock
 * signature TWICE and refuses a wallet whose two signatures differ; every later
 * unlock compares the derived keyId with the server's and changes nothing on a
 * mismatch. A key cached on this device (keyCache, 12 h — swept on every page
 * load, so the 12 h holds even for an account nothing reads again) makes a
 * refresh need no wallet at all.
 */
import { checkChallenge, unlockMessage } from './messages.js';
import { deriveVaultKey } from './unlockKey.js';
import { personalSign, requestAccount } from './walletRpc.js';
import { getAddress } from 'ethers';

export const UNSUPPORTED_TEXT =
  'This wallet signs the same message differently each time (a smart-contract, MPC or passkey wallet), so it cannot lock saved wallets. Use "Remember on this device" in Import instead.';

function fail(message, code) {
  return new Error(message, { cause: { code } });
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function textOf(e) {
  const raw = e && typeof e === 'object' && typeof e.message === 'string' ? e.message : String(e || 'failed');
  return raw.split(String.fromCharCode(10))[0].slice(0, 240);
}

/**
 * @param {{
 *   api: {postChallenge: Function, postLogin: Function, getAccountSession: Function, postLogout: Function, deleteVault: Function},
 *   discovery: {provider(id: string): object|null},
 *   keyCache: {get: Function, put: Function, remove: Function},
 *   origin?: string,
 *   subtle?: SubtleCrypto,
 * }} deps
 */
export function createAccount({ api, discovery, keyCache, origin = globalThis.location ? globalThis.location.origin : '', subtle }) {
  let state = {
    status: 'starting',
    step: null,
    address: null,
    walletId: null,
    walletAddress: null,
    walletLocked: false,
    keyEpoch: 0,
    error: '',
  };
  let session = null; // {address, expiresAt, vault: {rev, keyId, ...}|null}
  let unlocked = null; // {address, key, keyId}
  let provider = null;
  let providerId = null;
  let detach = () => {};
  let busy = false;
  const subs = new Set();

  function set(patch) {
    state = { ...state, ...patch };
    for (const fn of [...subs]) {
      try {
        fn(state);
      } catch {
        // a UI listener's bug must not break the account
      }
    }
  }

  function install(k) {
    unlocked = k;
    set({ status: 'unlocked', keyEpoch: state.keyEpoch + 1, error: '' });
  }

  /** Forget the key in this tab. @returns {number} the keyEpoch to publish */
  function drop() {
    if (!unlocked) return state.keyEpoch;
    unlocked = null;
    return state.keyEpoch + 1;
  }

  function attach(id) {
    const wanted = id || providerId;
    if (!wanted) throw fail('Choose a wallet first.', 'no_wallet');
    const p = discovery.provider(wanted);
    if (!p) throw fail('That wallet is no longer available. Reload the page.', 'no_wallet');
    if (p === provider) return;
    detach();
    provider = p;
    providerId = wanted;
    const onAccounts = (list) => {
      if (!Array.isArray(list) || !list.length) {
        set({ walletLocked: true });
        return;
      }
      try {
        set({ walletAddress: getAddress(String(list[0])), walletLocked: false });
      } catch {
        // not an address: ignore the event
      }
    };
    const onDisconnect = () => set({ walletAddress: null });
    if (typeof p.on === 'function') {
      p.on('accountsChanged', onAccounts);
      p.on('disconnect', onDisconnect);
      detach = () => {
        if (typeof p.removeListener === 'function') {
          p.removeListener('accountsChanged', onAccounts);
          p.removeListener('disconnect', onDisconnect);
        }
      };
    } else {
      detach = () => {};
    }
  }

  async function connectWallet(id) {
    attach(id);
    set({ step: 'connecting' });
    const a = await requestAccount(provider);
    set({ walletId: providerId, walletAddress: a, walletLocked: false });
    return a;
  }

  async function run(step, fn) {
    if (busy) return false;
    busy = true;
    set({ error: '', step });
    try {
      return await fn();
    } catch (e) {
      set({ error: textOf(e) });
      return false;
    } finally {
      busy = false;
      set({ step: null });
    }
  }

  /** A key cached on this device for the session's account, if it still matches. */
  async function fromCache() {
    const c = await keyCache.get(session.address);
    if (!c) return false;
    if (session.vault && session.vault.keyId !== c.keyId) {
      await keyCache.remove(session.address);
      return false;
    }
    install({ address: session.address, key: c.key, keyId: c.keyId });
    return true;
  }

  /** On page load: the cookie's session and a cached key. Asks the wallet nothing. */
  async function resume() {
    let s;
    try {
      s = await api.getAccountSession();
    } catch {
      set({ status: 'out', error: 'Could not reach the server to check your sign-in.' });
      return;
    }
    if (!s) {
      session = null;
      set({ status: 'out', address: null });
      return;
    }
    session = s;
    set({ address: s.address });
    if (!(await fromCache())) set({ status: 'locked' });
  }

  /**
   * Connect the wallet and sign in (SIWE). opts.expect: the account the wallet
   * must be on (signing in again as the same account).
   * @returns {Promise<boolean>}
   */
  function signIn(walletId, { expect = null } = {}) {
    return run('connecting', async () => {
      const addr = await connectWallet(walletId);
      if (expect && addr !== expect) {
        throw fail(`Your wallet is on ${short(addr)}. Switch it to ${short(expect)} first.`, 'wrong_account');
      }
      set({ step: 'signing-in' });
      const challenge = await api.postChallenge(addr);
      const message = checkChallenge(challenge, { address: addr, origin });
      const signature = await personalSign(provider, message, addr);
      await api.postLogin({ nonce: challenge.nonce, signature, message, address: addr });
      const s = await api.getAccountSession();
      if (!s || s.address !== addr) throw fail('The server did not keep the sign-in. Try again.', 'no_session');
      session = s;
      if (unlocked && unlocked.address === addr) {
        set({ status: 'unlocked', address: addr });
        return true;
      }
      set({ address: addr, keyEpoch: drop() });
      if (!(await fromCache())) set({ status: 'locked' });
      return true;
    });
  }

  /**
   * Sign the unlock message and derive the key (twice on the first unlock).
   * @returns {Promise<boolean>}
   */
  function unlock(walletId) {
    return run('connecting', async () => {
      if (!session) throw fail('Sign in first.', 'no_session');
      const addr = await connectWallet(walletId);
      if (addr !== session.address) {
        throw fail(`Your wallet is on ${short(addr)}. Switch it to ${short(session.address)} to unlock.`, 'wrong_account');
      }
      const fresh = await api.getAccountSession();
      if (!fresh || fresh.address !== session.address) {
        session = null;
        set({ status: 'out', address: null, keyEpoch: drop() });
        throw fail('Your sign-in expired. Connect again.', 'no_session');
      }
      session = fresh;
      set({ step: 'unlocking' });
      const message = unlockMessage(addr);
      let first;
      try {
        first = await deriveVaultKey({ signature: await personalSign(provider, message, addr), address: addr, subtle });
        if (!session.vault) {
          set({ step: 'confirming' });
          const second = await deriveVaultKey({ signature: await personalSign(provider, message, addr), address: addr, subtle });
          if (second.keyId !== first.keyId) throw fail(UNSUPPORTED_TEXT, 'nondeterministic');
        }
      } catch (e) {
        const code = e && e.cause && e.cause.code;
        if (code === 'nondeterministic' || code === 'smart_wallet') set({ status: 'unsupported' });
        throw e;
      }
      if (session.vault && session.vault.keyId !== first.keyId) {
        throw fail('This wallet gave a different unlock key than the one your saved wallets are locked with. Nothing was changed.', 'key_mismatch');
      }
      await keyCache.put(addr, first);
      install({ address: addr, key: first.key, keyId: first.keyId });
      return true;
    });
  }

  /** Forget the key here and on this device. The session stays. */
  async function lock() {
    const a = state.address;
    const epoch = drop();
    if (a) await keyCache.remove(a);
    set({ status: session ? 'locked' : 'out', error: '', keyEpoch: epoch });
  }

  /**
   * Sign out THIS BROWSER: forget the key, drop the cookie, let go of the wallet.
   * The session token is stateless (an HMAC the server checks, not a row it holds),
   * and POST /logout only clears the cookie — so a copy of it taken from this browser
   * before now stays good until it expires, and other devices are untouched. The only
   * thing that ends every session of an account is DELETE /vault (deleteSaved), which
   * the server answers by revoking them. accountView says so on the button.
   */
  async function disconnect() {
    const a = state.address;
    const epoch = drop();
    if (a) await keyCache.remove(a);
    try {
      await api.postLogout();
    } catch {
      // the cookie expires on its own; the page forgets the session either way
    }
    session = null;
    detach();
    detach = () => {};
    provider = null;
    providerId = null;
    set({ status: 'out', address: null, walletId: null, walletAddress: null, walletLocked: false, error: '', keyEpoch: epoch });
  }

  /**
   * Delete the account's copy on the server, and sign out. The server's DELETE
   * revokes EVERY session of the account and clears this browser's cookie, copy
   * or no copy, so the page signs out with it: the key leaves this tab and this
   * device, the status is 'out'. The wallet stays connected (Connect needs no
   * picker) and the wallets stay in the tab: the page does not clear them. The
   * DELETE is sent even when the server holds no copy (baseRev 0), so the
   * outcome never depends on it. A failed DELETE changes nothing here. The page's
   * sync must be stopped first (it would write the copy back); the next sign-in
   * finds no copy, so its unlock asks for the double signature again.
   */
  function deleteSaved() {
    return run('deleting', async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const s = await api.getAccountSession();
        if (!s) throw fail('Your sign-in expired. Connect again.', 'no_session');
        session = s;
        try {
          await api.deleteVault(s.vault ? s.vault.rev : 0);
          break;
        } catch (e) {
          if (!(e && e.cause && e.cause.code === 'conflict') || attempt === 1) throw e;
        }
      }
      const owner = session.address;
      session = null;
      const epoch = drop();
      await keyCache.remove(owner);
      set({ status: 'out', address: null, error: '', keyEpoch: epoch });
      return true;
    });
  }

  return {
    get: () => state,
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    resume,
    signIn,
    unlock,
    lock,
    disconnect,
    deleteSaved,
    /** The unlock key for the sync alone: {address, key, keyId} or null. Never put it in React state. */
    keyFor: () => (unlocked ? { ...unlocked } : null),
    /** Let go of the wallet's events (the page unmounts). The session and key stay. */
    dispose() {
      detach();
      detach = () => {};
      provider = null;
      providerId = null;
    },
  };
}
