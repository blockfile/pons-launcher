import { useState } from 'react';
import { api } from '../api.js';
import Section, { Busy } from './Section.jsx';

/**
 * Wallet table. Per-row fund / buy-mode / buy-amount inputs live in `rows`,
 * owned by App, because the Fund and Launch panels both read them.
 */
export default function WalletsPanel({ wallets, rows, setRow, reload, report }) {
  const [count, setCount] = useState(5);
  const [showImport, setShowImport] = useState(false);
  const [keys, setKeys] = useState('');
  const [importRole, setImportRole] = useState('bundle');
  const [busy, setBusy] = useState('');

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

  return (
    <Section step="1" title="Wallets">
      <div className="row">
        <Busy
          busy={busy === 'dev'}
          className="ghost"
          disabled={hasDev}
          title={hasDev ? 'a dev wallet already exists' : ''}
          onClick={() => act('dev', () => api('/wallets/generate', 'POST', { count: 1, role: 'dev', label: 'dev' }))}
        >
          Generate dev wallet
        </Busy>
        <Busy
          busy={busy === 'bundle'}
          className="ghost"
          onClick={() =>
            act('bundle', () =>
              api('/wallets/generate', 'POST', { count: Number(count) || 1, role: 'bundle', label: 'bundle' })
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
          Import keys…
        </button>
        <Busy busy={busy === 'reload'} className="ghost" onClick={() => act('reload', async () => 'balances refreshed')}>
          Refresh balances
        </Busy>
      </div>

      {showImport && (
        <div className="importBox">
          <textarea
            rows="3"
            placeholder="private keys, one per line"
            value={keys}
            onChange={(e) => setKeys(e.target.value)}
          />
          <div className="row">
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
        </div>
      )}

      <table>
        <thead>
          <tr>
            <th>role</th>
            <th>address</th>
            <th>balance</th>
            <th>fund (ETH)</th>
            <th>buy mode</th>
            <th>buy (ETH)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {wallets.length === 0 && (
            <tr>
              <td colSpan="7" className="empty">
                no wallets yet — generate a dev wallet to start
              </td>
            </tr>
          )}
          {wallets.map((w) => {
            const row = rows[w.id] || {};
            const isDev = w.role === 'dev';
            return (
              <tr key={w.id}>
                <td>
                  <span className={`role ${w.role}`}>{w.role}</span>
                </td>
                <td className="addr">{w.address}</td>
                <td className="addr">{Number(w.balanceEth).toFixed(6)}</td>
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
                    onClick={() => {
                      if (!confirm(`Delete ${w.address}? Its key is erased from the keystore.`)) return;
                      act(w.id, () => api(`/wallets/${w.id}`, 'DELETE'));
                    }}
                  >
                    ×
                  </Busy>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Section>
  );
}
