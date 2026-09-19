import { useRef, useState } from 'react';
import { LuCloud, LuCloudOff, LuLoaderCircle, LuLock, LuLockOpen, LuLogOut, LuRefreshCw, LuTrash2, LuWallet } from 'react-icons/lu';
import { accountView } from './accountView.js';

const ICONS = {
  connect: LuWallet,
  unlock: LuLockOpen,
  'signin-again': LuWallet,
  switch: LuWallet,
  retry: LuRefreshCw,
  lock: LuLock,
  disconnect: LuLogOut,
  delete: LuTrash2,
};

const CLASS = { go: 'go', quiet: '', danger: 'ghost danger' };

/**
 * The account strip (spec Addendum A): Connect / Unlock / Lock / Disconnect,
 * the sync state, the banner for a visitor who has not connected, and the move
 * of a passphrase vault into the account. What it shows comes from
 * accountView(); what the buttons do is App's (onAction(id, walletId)).
 *
 * Wallet names and icons come from browser extensions (EIP-6963): the name is
 * React text, the icon a data: URI drawn with <img> only. The passphrase field
 * is uncontrolled and cleared after use; it never enters React state.
 */
export default function AccountBar({ acct, sync, wallets, legacy, leaving = null, onAction, onMigrate }) {
  const [picking, setPicking] = useState(null);
  const [moveError, setMoveError] = useState('');
  const [moving, setMoving] = useState(false);
  const passRef = useRef(null);
  const view = accountView({ acct, sync, wallets, legacy, leaving });
  if (view.hidden) return null;

  function press(action) {
    if (!action.needsWallet) {
      setPicking(null);
      onAction(action.id, null);
      return;
    }
    const known = acct.walletId && wallets.some((w) => w.id === acct.walletId) ? acct.walletId : null;
    const only = wallets.length === 1 ? wallets[0].id : null;
    if (known || only) {
      setPicking(null);
      onAction(action.id, known || only);
      return;
    }
    setPicking(picking === action.id ? null : action.id);
  }

  function pick(walletId) {
    const id = picking;
    setPicking(null);
    if (id) onAction(id, walletId);
  }

  async function move(e) {
    e.preventDefault();
    setMoving(true);
    setMoveError('');
    const pass = passRef.current ? passRef.current.value : '';
    try {
      setMoveError((await onMigrate(pass)) || '');
    } finally {
      if (passRef.current) passRef.current.value = '';
      setMoving(false);
    }
  }

  const SyncIcon = view.syncState === 'error' || view.syncState === 'blocked' ? LuCloudOff : LuCloud;
  return (
    <section className={`accountbar pane${view.banner ? ' is-banner' : ''}`} aria-label="Account" data-testid="account-bar">
      <div className="acct-row">
        {view.busy && <LuLoaderCircle className="spin" aria-hidden="true" />}
        <span className="acct-text" data-testid="account-status">
          {view.text}
        </span>
        {view.sync && (
          <span className={`acct-sync is-${view.syncState}`} role="status" data-testid="account-sync">
            <SyncIcon aria-hidden="true" /> {view.sync}
          </span>
        )}
        <span className="acct-actions">
          {view.actions.map((a) => {
            const Icon = ICONS[a.id];
            return (
              <button key={a.id} type="button" className={CLASS[a.kind]} title={a.title || undefined} onClick={() => press(a)} data-testid={`account-${a.id}`}>
                {Icon && <Icon aria-hidden="true" />} {a.label}
              </button>
            );
          })}
        </span>
      </div>
      {picking && (
        <div className="acct-pick" role="group" aria-label="Choose a wallet">
          {wallets.map((w) => (
            <button key={w.id} type="button" className="go" onClick={() => pick(w.id)} data-testid="account-wallet">
              {w.icon ? <img src={w.icon} alt="" width="16" height="16" /> : <LuWallet aria-hidden="true" />} {w.name}
            </button>
          ))}
        </div>
      )}
      {view.switched && <p className="hint">{view.switched}</p>}
      {view.hint && <p className="hint">{view.hint}</p>}
      {view.error && (
        <p className="refusal" role="alert">
          {view.error}
        </p>
      )}
      {view.migrate && (
        <form className="acct-move" onSubmit={move}>
          <span>
            {view.migrate === 'passphrase'
              ? 'Wallets are also saved on this device with a passphrase. Move them into your account:'
              : 'The wallets saved on this device with a passphrase are in this tab. Move them into your account and delete the device copy:'}
          </span>
          {view.migrate === 'passphrase' && (
            <input ref={passRef} type="password" autoComplete="current-password" placeholder="passphrase" aria-label="Passphrase of the device copy" data-testid="account-move-pass" />
          )}
          <button type="submit" className="go" disabled={moving} data-testid="account-move">
            {moving ? 'Moving…' : 'Move into account'}
          </button>
          {moveError && (
            <span className="refusal" role="alert">
              {moveError}
            </span>
          )}
        </form>
      )}
    </section>
  );
}
