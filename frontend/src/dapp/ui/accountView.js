/**
 * What the account strip shows (AccountBar.jsx), as a pure function of the
 * account state (account/account.js), the sync status (account/vaultSync.js),
 * the discovered wallets and the passphrase vault's state — so it can be
 * tested without a DOM.
 *
 * Buttons follow the money law (memory frontend-cell-and-caret): Connect,
 * Unlock, Sign in are forward actions that move no money -> indigo 'go'; Lock,
 * Disconnect, Retry are quiet; deleting the saved copy is 'danger' (a ghost
 * frame, and the page asks for a typed confirmation). Nothing here is amber.
 */
const short = (a) => (typeof a === 'string' && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a || ''));

const STEP_TEXT = {
  connecting: 'Check your wallet: allow this page to see your account.',
  'signing-in': 'Check your wallet: sign the sign-in message. It is not a transaction and costs nothing.',
  unlocking: 'Check your wallet: sign the unlock message. The signature never leaves this browser.',
  confirming: 'Sign the same message once more: the page checks that your wallet signs the same way every time.',
  deleting: 'Deleting the saved copy…',
};

/**
 * Is the account SAVING right now? What Import asks before it takes the passphrase
 * option away and promises "Saved to your account automatically".
 *
 * Only three codes ever reach state 'blocked'; every other failure parks the sync in
 * state 'error', and 'no_session' (the session cookie of a tab left open past 24 h) is
 * not even retryable, so nothing will save until the visitor signs in again —
 * meanwhile acct.status stays 'unlocked', because account.js only learns the cookie
 * died on resume or an explicit action. Anything but a healthy sync therefore counts
 * as NOT saving: the cost of being wrong that way is a second copy on this device,
 * which the strip's move-form merges back; the cost of being wrong the other way is
 * freshly imported keys that nothing ever stored.
 */
export function accountSaving(acct, sync) {
  if (!acct || acct.status !== 'unlocked' || !sync) return false;
  return sync.state !== 'blocked' && sync.state !== 'error';
}

function syncText(sync) {
  if (!sync) return '';
  switch (sync.state) {
    case 'loading':
      return 'opening your saved wallets…';
    case 'pending':
    case 'saving':
      return 'saving…';
    case 'saved':
      return 'saved to your account';
    case 'error':
      return `not saved: ${sync.error}`;
    case 'blocked':
      return `saving stopped: ${sync.error}`;
    default:
      return '';
  }
}

/**
 * @param {{acct: object, sync: object|null, wallets: Array<{id, name, icon}>, legacy: 'none'|'locked'|'unlocked',
 *   leaving?: null|{how: 'lock'|'disconnect'|'switch', text: string, final: boolean}}} input
 *   leaving: a Lock / Disconnect / Switch waiting for the tab's own signing
 *   (App.leaveWhenQuiet): its text, and the way back until `final`.
 * @returns {{
 *   hidden: boolean, banner: boolean, busy: boolean, text: string, hint: string, error: string,
 *   switched: string, sync: string, syncState: string,
 *   actions: Array<{id: string, label: string, kind: 'go'|'quiet'|'danger', needsWallet: boolean}>,
 *   migrate: null|'passphrase'|'move',
 * }}
 */
export function accountView({ acct, sync = null, wallets = [], legacy = 'none', leaving = null }) {
  const view = {
    hidden: false,
    banner: false,
    busy: false,
    text: '',
    hint: '',
    error: acct.error || '',
    switched: '',
    sync: '',
    syncState: '',
    actions: [],
    migrate: null,
  };
  if (acct.status === 'starting') return { ...view, hidden: true, error: '' };
  // A Lock / Disconnect / Switch waiting for what the tab still has to sign
  // (ui/leaveGate.js): its text, and the way back while it still waits.
  if (leaving) {
    const stay = { id: 'leave-cancel', label: leaving.how === 'disconnect' ? 'Stay connected' : 'Keep unlocked', kind: 'quiet', needsWallet: false };
    return { ...view, busy: true, text: String(leaving.text || ''), error: '', actions: leaving.final ? [] : [stay] };
  }
  if (acct.step) {
    return { ...view, busy: true, text: STEP_TEXT[acct.step] || 'Waiting for your wallet…', error: '' };
  }
  // What Disconnect really does, said where the visitor presses it. The session token
  // is stateless and POST /logout only clears the cookie, so a token captured before
  // the press (a compromised extension, a copied browser profile) stays good for the
  // rest of its 24 h. The one thing that ends every session of an account is Delete
  // saved copy, which the server answers by revoking them — so the button must not
  // imply more than it does.
  const disconnect = {
    id: 'disconnect',
    label: 'Disconnect',
    kind: 'quiet',
    needsWallet: false,
    title: 'Signs this browser out. Your sign-in on other devices is untouched, and a copy of this sign-in taken from this browser stays valid until it expires — use Delete saved copy to end every session of this account.',
  };
  const signedIn = acct.status === 'locked' || acct.status === 'unlocked';
  if (signedIn && acct.walletAddress && acct.address && acct.walletAddress !== acct.address) {
    view.switched = `Your wallet switched to ${short(acct.walletAddress)}. This page is still signed in as ${short(acct.address)}.`;
  }
  if (acct.status === 'out') {
    view.banner = true;
    view.text = 'Wallets you import stay in this tab only and are gone after a refresh. Connect a wallet to keep them in your account, encrypted in this browser before they are sent.';
    if (wallets.length) view.actions.push({ id: 'connect', label: 'Connect wallet', kind: 'go', needsWallet: true });
    else view.hint = 'No browser wallet found. Install MetaMask, Rabby, OKX or Coinbase Wallet to save your wallets, or keep using this tab without saving.';
    return view;
  }
  if (acct.status === 'unsupported') {
    view.text = `Signed in as ${short(acct.address)}.`;
    view.actions.push(disconnect);
    return view;
  }
  if (acct.status === 'locked') {
    view.text = `Signed in as ${short(acct.address)}. Your saved wallets are locked.`;
    if (acct.walletLocked) view.hint = 'Your wallet extension is locked: open it first.';
    if (view.switched) view.actions.push({ id: 'switch', label: `Sign in as ${short(acct.walletAddress)}`, kind: 'go', needsWallet: false });
    else if (wallets.length) view.actions.push({ id: 'unlock', label: 'Unlock', kind: 'go', needsWallet: true });
    else view.hint = 'Your wallet is not available in this browser. Unlock needs it.';
    view.actions.push(disconnect);
    view.actions.push({ id: 'delete', label: 'Delete saved copy', kind: 'danger', needsWallet: false });
    return view;
  }
  // unlocked
  view.sync = syncText(sync);
  view.syncState = sync ? sync.state : '';
  view.text = `${short(acct.address)}`;
  if (view.switched) view.actions.push({ id: 'switch', label: `Sign in as ${short(acct.walletAddress)}`, kind: 'go', needsWallet: false });
  if (sync && sync.state === 'error' && sync.code === 'no_session') {
    view.actions.push({ id: 'signin-again', label: 'Sign in again', kind: 'go', needsWallet: true });
  } else if (sync && sync.state === 'error') {
    view.actions.push({ id: 'retry', label: 'Retry', kind: 'quiet', needsWallet: false });
  }
  view.actions.push({ id: 'lock', label: 'Lock', kind: 'quiet', needsWallet: false });
  view.actions.push(disconnect);
  view.actions.push({ id: 'delete', label: 'Delete saved copy', kind: 'danger', needsWallet: false });
  if (legacy !== 'none' && sync && sync.state !== 'blocked' && sync.state !== 'loading') {
    view.migrate = legacy === 'locked' ? 'passphrase' : 'move';
  }
  return view;
}
