import { useState } from 'react';
import { api, downloadBackup } from '../api.js';
import Section, { Busy } from './Section.jsx';
import Modal, { Fact } from './Modal.jsx';

/**
 * The wallet table. Per-row fund / buy-mode / buy-amount inputs live in `rows`,
 * owned by App, because the Fund and Launch panels both read them.
 */
export default function WalletsPanel({ wallets, rows, setRow, reload, report }) {
  const [count, setCount] = useState(5);
  const [showImport, setShowImport] = useState(false);
  const [keys, setKeys] = useState('');
  const [importRole, setImportRole] = useState('bundle');
  const [busy, setBusy] = useState('');
  // 'json' | 'csv' while the export confirmation is open, '' otherwise, plus
  // whatever has been typed into it so far.
  const [exporting, setExporting] = useState('');
  const [typed, setTyped] = useState('');
  // The wallet the delete confirmation is asking about, or null.
  const [deleting, setDeleting] = useState(null);

  async function act(name, fn) {
    setBusy(name);
    try {
      report(await fn());
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  const hasDev = wallets.some((w) => w.role === 'dev');

  // Opens the typed confirmation. Nothing is exported from here.
  function backup(format) {
    setTyped('');
    setExporting(format);
  }

  return (
    <Section step="1" title="Wallets" done={hasDev && wallets.length > 1}>
      <p className="lede">
        The dev wallet signs the launch, makes the uncapped buy, and funds everything else. Bundle
        wallets each buy behind it, and each is capped at 5% of supply.
      </p>

      <div className="row">
        <Busy
          busy={busy === 'dev'}
          className="ghost"
          disabled={hasDev}
          title={hasDev ? 'a dev wallet already exists' : ''}
          onClick={() =>
            act('dev', () => api('/wallets/generate', 'POST', { count: 1, role: 'dev', label: 'dev' }))
          }
        >
          Generate dev wallet
        </Busy>
        <Busy
          busy={busy === 'bundle'}
          className="ghost"
          onClick={() =>
            act('bundle', () =>
              api('/wallets/generate', 'POST', {
                count: Number(count) || 1,
                role: 'bundle',
                label: 'bundle',
              })
            )
          }
        >
          Generate bundle wallets
        </Busy>
        <input
          type="number"
          min="1"
          max="100"
          value={count}
          onChange={(e) => setCount(e.target.value)}
          title="how many"
        />
        <button className="ghost" onClick={() => setShowImport((v) => !v)}>
          Import keys
        </button>
        <Busy
          busy={busy === 'reload'}
          className="ghost"
          onClick={() => act('reload', async () => 'balances refreshed')}
        >
          Refresh balances
        </Busy>

        <span className="spacer" />

        <Busy
          busy={busy === 'backup'}
          className="ghost"
          disabled={!wallets.length}
          onClick={() => backup('json')}
        >
          Download backup
        </Busy>
        <button className="link" disabled={!wallets.length} onClick={() => backup('csv')}>
          as CSV
        </button>
      </div>

      {showImport && (
        <div className="row">
          <textarea
            rows="3"
            placeholder="private keys, one per line"
            value={keys}
            onChange={(e) => setKeys(e.target.value)}
          />
          <select value={importRole} onChange={(e) => setImportRole(e.target.value)}>
            <option value="bundle">bundle</option>
            <option value="dev">dev</option>
          </select>
          <Busy
            busy={busy === 'import'}
            onClick={() =>
              act('import', async () => {
                const made = await api('/wallets/import', 'POST', {
                  privateKeys: keys.split('\n'),
                  role: importRole,
                });
                setKeys('');
                return made;
              })
            }
          >
            Import
          </Busy>
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>Role</th>
            <th>Address</th>
            <th>Balance</th>
            <th>Fund (ETH)</th>
            <th>Buy mode</th>
            <th>Buy (ETH)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {wallets.length === 0 && (
            <tr>
              <td colSpan="7" className="empty">
                No wallets yet. Generate a dev wallet to start.
              </td>
            </tr>
          )}
          {wallets.map((w) => {
            const row = rows[w.id] || {};
            const isDev = w.role === 'dev';
            const bal = Number(w.balanceEth);
            return (
              <tr key={w.id}>
                <td>
                  <span className={`role ${w.role}`}>{w.role}</span>
                </td>
                <td className="addr">{w.address}</td>
                <td>
                  <span className={`bal ${bal === 0 ? 'zero' : ''}`}>{bal.toFixed(6)}</span>
                </td>
                <td>
                  {!isDev && (
                    <input
                      type="number"
                      step="0.0001"
                      placeholder="0.0"
                      value={row.fund ?? ''}
                      onChange={(e) => setRow(w.id, { fund: e.target.value })}
                    />
                  )}
                </td>
                <td>
                  {!isDev && (
                    <select
                      value={row.mode ?? 'fixed'}
                      onChange={(e) => setRow(w.id, { mode: e.target.value })}
                    >
                      <option value="fixed">fixed</option>
                      <option value="all">all − gas</option>
                    </select>
                  )}
                </td>
                <td>
                  {!isDev && (
                    <input
                      type="number"
                      step="0.0001"
                      placeholder="0.0"
                      // "all − gas" is resolved server-side from the live
                      // balance, so an amount here would be meaningless.
                      disabled={row.mode === 'all'}
                      value={row.mode === 'all' ? '' : row.buy ?? ''}
                      onChange={(e) => setRow(w.id, { buy: e.target.value })}
                    />
                  )}
                </td>
                <td>
                  <Busy
                    busy={busy === w.id}
                    className="ghost"
                    title="delete this wallet"
                    onClick={() => setDeleting(w)}
                  >
                    ×
                  </Busy>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Typed confirmation, not a click-through: this hands over every key the
          console holds, and a mis-click should not be enough to do it. */}
      <Modal
        open={Boolean(exporting)}
        danger
        title={`This downloads the PRIVATE KEY of all ${wallets.length} wallets.`}
        question={null}
        confirmLabel={exporting === 'csv' ? 'Download CSV' : 'Download'}
        confirmDisabled={typed !== 'EXPORT'}
        onConfirm={() => {
          const format = exporting;
          setExporting('');
          act('backup', () => downloadBackup(format));
        }}
        onCancel={() => setExporting('')}
      >
        <p>Anyone who opens that file can spend every one of them.</p>
        <label className="modal-type">
          Type EXPORT to continue.
          <input
            data-autofocus
            value={typed}
            autoComplete="off"
            spellCheck="false"
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
      </Modal>

      {/* Deleting a wallet erases its key, so it carries the vermilion: there
          is no undo and no second copy unless a backup was taken. */}
      <Modal
        open={Boolean(deleting)}
        danger
        title="Delete this wallet?"
        question={null}
        confirmLabel="Delete"
        onConfirm={() => {
          const w = deleting;
          setDeleting(null);
          if (w) act(w.id, () => api(`/wallets/${w.id}`, 'DELETE'));
        }}
        onCancel={() => setDeleting(null)}
      >
        <div className="modal-facts">
          <Fact label="Address" mono>
            {deleting?.address || '—'}
          </Fact>
          <Fact label="Role">{deleting?.role || '—'}</Fact>
          <Fact label="Balance">{Number(deleting?.balanceEth || 0).toFixed(6)} ETH</Fact>
        </div>
        <p>Its key is erased from the keystore.</p>
      </Modal>
    </Section>
  );
}
