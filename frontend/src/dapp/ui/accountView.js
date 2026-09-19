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
 * @param {{acct: object, sync: object|null, wallets: Array<{id, name, icon}>, legacy: 'none'|'locked'|'unlocked'}} input
 * @returns {{
 *   hidden: boolean, banner: boolean, busy: boolean, text: string, hint: string, error: string,
 *   switched: string, sync: string, syncState: string,
 *   actions: Array<{id: string, label: string, kind: 'go'|'quiet'|'danger', needsWallet: boolean}>,
 *   migrate: null|'passphrase'|'move',
 * }}
 */
export function accountView({ acct, sync = null, wallets = [], legacy = 'none' }) {
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
  if (acct.step) {
    return { ...view, busy: true, text: STEP_TEXT[acct.step] || 'Waiting for your wallet…', error: '' };
  }
  const disconnect = { id: 'disconnect', label: 'Disconnect', kind: 'quiet', needsWallet: false };
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
