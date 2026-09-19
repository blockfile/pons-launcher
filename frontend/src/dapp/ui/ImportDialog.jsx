import { useEffect, useRef, useState } from 'react';
import { LuLock, LuLockOpen, LuUpload, LuX } from 'react-icons/lu';
import { parseImport } from '../keys/parseImport.js';
import { addWallets } from '../keys/walletStore.js';
import { MIN_PASSPHRASE, hasVault, saveVault, unlockVault } from '../keys/vault.js';
import { errText } from './format.js';

/**
 * Wallet import. KEYS NEVER ENTER REACT STATE: the textarea, the file input
 * and the passphrase fields are uncontrolled (read through refs inside the
 * click handler), the parsed list goes straight into walletStore, and every
 * field is cleared before the handler returns. What React keeps is counts and
 * the rejected ROW NUMBERS with their reasons — parseImport never echoes a key.
 *
 * "Remember" saves EVERY wallet in the tab (vault.js), not only these: the label
 * says so, with the count. It never replaces a saved copy this tab has not
 * unlocked (another tab's save, or one kept after Clear): that is refused.
 *
 * With the account unlocked (accountSaves) the import is saved to the account's
 * encrypted copy on its own (account/vaultSync.js follows walletStore), so the
 * passphrase option is not offered: one saved copy, not two.
 */
export default function ImportDialog({ vault = 'none', walletCount = 0, accountSaves = false, onClose, onImported }) {
  const vaultLocked = vault === 'locked';
  const textRef = useRef(null);
  const fileRef = useRef(null);
  const passRef = useRef(null);
  const pass2Ref = useRef(null);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rejects, setRejects] = useState([]);
  const [fileName, setFileName] = useState('');

  useEffect(() => {
    if (textRef.current) textRef.current.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function clearFields() {
    if (textRef.current) textRef.current.value = '';
    if (fileRef.current) fileRef.current.value = '';
    if (passRef.current) passRef.current.value = '';
    if (pass2Ref.current) pass2Ref.current.value = '';
    setFileName('');
  }

  async function doImport() {
    setError('');
    setRejects([]);
    const text = textRef.current ? textRef.current.value : '';
    const file = fileRef.current && fileRef.current.files ? fileRef.current.files[0] : null;
    if (!text.trim() && !file) {
      setError('Paste keys or choose a file.');
      return;
    }
    let pass = '';
    if (remember && !accountSaves) {
      pass = passRef.current ? passRef.current.value : '';
      if (pass.length < MIN_PASSPHRASE) {
        setError(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
        return;
      }
      // Checked again at save time: another tab may have saved since this page loaded.
      if (vault !== 'unlocked' && safeHasVault()) {
        setError('Wallets are already saved on this device. Unlock them first — saving now would replace them.');
        return;
      }
      if (pass !== (pass2Ref.current ? pass2Ref.current.value : '')) {
        setError('The two passphrases differ.');
        return;
      }
    }
    setBusy(true);
    try {
      const found = [];
      const bad = [];
      if (text.trim()) {
        const r = await parseImport({ text });
        found.push(...r.wallets);
        for (const x of r.rejects) bad.push({ source: 'pasted text', row: x.row, reason: x.reason });
      }
      if (file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const r = await parseImport({ file: { name: file.name, bytes } });
        bytes.fill(0);
        found.push(...r.wallets);
        for (const x of r.rejects) bad.push({ source: file.name, row: x.row, reason: x.reason });
      }
      const { added, duplicates } = addWallets(found);
      found.length = 0;
      // The keys are in the tab now, whatever happens to the save: report both.
      let saved = 0;
      let saveError = '';
      if (remember && !accountSaves && added + duplicates > 0) {
        try {
          saved = await saveVault(pass);
        } catch (e) {
          saveError = errText(e);
        }
      }
      pass = '';
      clearFields();
      setRejects(bad);
      onImported({ added, duplicates, rejected: bad.length, saved, saveError });
      if (saveError) setError(`Imported for this tab only — not saved on this device: ${saveError}`);
      else if (!bad.length) onClose();
    } catch (e) {
      clearFields();
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog pane" role="dialog" aria-modal="true" aria-labelledby="tp-import-title">
        <div className="pane-title">
          <h2 id="tp-import-title">Import wallets</h2>
          <button type="button" className="icon quiet" onClick={onClose} aria-label="Close">
            <LuX aria-hidden="true" />
          </button>
        </div>
        <div className="dialog-body">
          <p className="notice-inline">
            Keys stay in this browser tab and are never sent anywhere. Use trading wallets only.
          </p>
          <label htmlFor="tp-keys">Private keys, one per line</label>
          <textarea
            id="tp-keys"
            ref={textRef}
            className="masked"
            rows={6}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="0x…"
            data-testid="import-text"
          />
          <label className="file-pick">
            <LuUpload aria-hidden="true" /> {fileName || 'or choose an export file (XLSX, JSON backup, CSV)'}
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.json,.csv,.txt"
              onChange={(e) => setFileName(e.target.files && e.target.files[0] ? e.target.files[0].name : '')}
              data-testid="import-file"
            />
          </label>
          {accountSaves ? (
            <p className="hint" data-testid="import-account-saves">
              Saved to your account automatically, encrypted in this browser before it is sent.
            </p>
          ) : (
            <label className="check">
              <input type="checkbox" checked={remember} disabled={vaultLocked} onChange={(e) => setRemember(e.target.checked)} />
              Remember on this device — every wallet in this tab ({walletCount} already here, plus these), encrypted with a passphrase
            </label>
          )}
          {vaultLocked && !accountSaves && <p className="hint">Unlock the wallets saved on this device first — saving now would replace them.</p>}
          {remember && !vaultLocked && !accountSaves && (
            <div className="pass-pair">
              <input ref={passRef} type="password" autoComplete="new-password" placeholder={`passphrase (${MIN_PASSPHRASE}+ characters)`} aria-label="Passphrase" />
              <input ref={pass2Ref} type="password" autoComplete="new-password" placeholder="repeat the passphrase" aria-label="Repeat the passphrase" />
            </div>
          )}
          {error && (
            <p className="refusal" role="alert">
              {error}
            </p>
          )}
          {rejects.length > 0 && (
            <ul className="rejects" aria-label="Rows not imported">
              {rejects.map((r, i) => (
                <li key={i}>
                  {r.source}, row {r.row}: {r.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="dialog-foot">
          <button type="button" className="quiet" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="go" onClick={doImport} disabled={busy} data-testid="import-submit">
            {busy ? 'Importing…' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

function safeHasVault() {
  try {
    return hasVault();
  } catch {
    return false;
  }
}

/** Shown on load when an encrypted vault exists and is still locked. */
export function VaultBar({ onUnlocked, onForget }) {
  const passRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function unlock(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const n = await unlockVault(passRef.current ? passRef.current.value : '');
      if (passRef.current) passRef.current.value = '';
      onUnlocked(n);
    } catch {
      setError('Wrong passphrase, or the saved data is damaged.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="vaultbar pane" onSubmit={unlock}>
      <LuLock aria-hidden="true" />
      <span>Wallets saved on this device are locked.</span>
      <input ref={passRef} type="password" autoComplete="current-password" placeholder="passphrase" aria-label="Passphrase" data-testid="vault-pass" />
      <button type="submit" className="go" disabled={busy} data-testid="vault-unlock">
        <LuLockOpen aria-hidden="true" /> Unlock
      </button>
      <button type="button" className="ghost danger" onClick={onForget}>
        Forget
      </button>
      {error && (
        <span className="refusal" role="alert">
          {error}
        </span>
      )}
    </form>
  );
}
