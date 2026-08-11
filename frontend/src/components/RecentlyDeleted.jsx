import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Busy } from './Section.jsx';
import Modal, { Fact } from './Modal.jsx';

const when = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

/**
 * What was deleted, and the way back.
 *
 * Deleting a wallet no longer destroys its key: the entry moves into an archive
 * beside the keystore, encrypted the same way with the same passphrase (see
 * backend/src/wallets/keystore.js). This is that archive, drawn small on
 * purpose — it is a way out of a mis-click, not a seventh station of the
 * sequence — and it is not drawn at all until there is something in it.
 *
 * Filtered by role, so the dev wallet's archive is in step 1 where the dev
 * wallet lives and the bundle's is in step 3 with the table. Role is the same
 * whitelist the rest of the console uses: an entry with a role this build does
 * not know about is shown by neither, rather than falling into the bundle's
 * bulk affordances by default.
 *
 * The list is metadata — address, role, dates. The backend route returns
 * nothing else, and it must stay that way: an archive that could be read for
 * key material would be a keystore with a friendlier name.
 */
export default function RecentlyDeleted({ role, wallets, reload, report }) {
  const [entries, setEntries] = useState([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  // The entry the purge confirmation is asking about, frozen at the moment it
  // opened. Null means no dialog, and no dialog means nothing is destroyed.
  const [purging, setPurging] = useState(null);

  const read = useCallback(async () => {
    try {
      const all = await api('/wallets/archive');
      setEntries(Array.isArray(all) ? all : []);
    } catch (_err) {
      // A console that cannot read the archive is a console with nothing extra
      // to offer, not a broken one — before a key is pasted this request is a
      // 401. Silence, and no affordance, is the right answer to that.
      setEntries([]);
    }
  }, []);

  // Re-read whenever the wallet list is replaced: App fetches a fresh array on
  // every reload, and a delete or a restore is exactly when this changes.
  useEffect(() => {
    read();
  }, [read, wallets]);

  const mine = entries.filter((e) => e.role === role);

  async function restore(entry) {
    setBusy(entry.id);
    try {
      report(await api(`/wallets/archive/${entry.id}/restore`, 'POST'));
      await reload().catch(() => {});
      await read();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  async function purge(entry) {
    setBusy(entry.id);
    try {
      report(await api(`/wallets/archive/${entry.id}`, 'DELETE', { confirm: true }));
      await read();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  if (!mine.length) return null;

  return (
    <div className="archive">
      <button className="link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Recently deleted ({mine.length})
      </button>
      <span className="hint">
        deleted keys are archived, not destroyed — restore one here, or purge it to destroy it
      </span>

      {open && (
        <table className="archive-list">
          <thead>
            <tr>
              <th>Address</th>
              <th>Created</th>
              <th>Deleted</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {mine.map((e) => (
              <tr key={e.id}>
                <td className="addr">{e.address}</td>
                <td className="hint">{when(e.createdAt)}</td>
                <td className="hint">{when(e.deletedAt)}</td>
                <td>
                  <Busy
                    busy={busy === e.id}
                    className="ghost"
                    title="put this wallet back in the keystore"
                    onClick={() => restore(e)}
                  >
                    Restore
                  </Busy>{' '}
                  {/* The one control in this console that destroys a key
                      outright, now that a delete does not. Vermilion is spent
                      in the dialog rather than on the trigger, the same as
                      every other delete here. */}
                  <button
                    className="link"
                    disabled={busy === e.id}
                    title="destroy this key permanently"
                    onClick={() => setPurging(e)}
                  >
                    purge
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* The sentence that used to be on the delete dialog, moved to the one
          action it is now true of. */}
      <Modal
        open={Boolean(purging)}
        danger
        title="Destroy this key permanently?"
        question={null}
        confirmLabel="Purge key"
        onConfirm={() => {
          const target = purging;
          setPurging(null);
          if (target) purge(target);
        }}
        onCancel={() => setPurging(null)}
      >
        <div className="modal-facts">
          <Fact label="Address" mono>
            {purging?.address}
          </Fact>
          <Fact label="Role">{purging?.role}</Fact>
          <Fact label="Deleted">{when(purging?.deletedAt)}</Fact>
        </div>

        <p>
          Its private key is destroyed — erased from the archive, which holds raw keys and no
          mnemonic, so nothing here can regenerate it. Afterwards this wallet is recoverable only
          from a backup already downloaded.
        </p>

        <div className="notice danger">
          <h3>Anything this wallet holds goes with it</h3>
          <ul>
            <li>
              The console reads balances for wallets in the keystore, so an archived one shows{' '}
              <b className="crux">no balance here</b> — this dialog cannot tell you whether it is
              empty.
            </li>
            <li>
              If it may still hold ETH or a launched token, cancel, <b>Restore</b> it, move the
              funds out, then delete and purge. A key that no longer exists is a wallet nobody can
              ever spend from.
            </li>
          </ul>
        </div>
      </Modal>
    </div>
  );
}
