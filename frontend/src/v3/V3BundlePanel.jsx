import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { ROLES, eth, plural } from './roles.js';

/**
 * Step 2 — the bundle wallets, and what each one buys.
 *
 * The amount column is the whole configuration of a run. Each wallet buys once,
 * with ETH that arrives from a Relay solver seconds beforehand, and the size of
 * that buy is what step 4's sell is sized to raise. Nothing is funded here: a
 * wallet holding ETH before the run would defeat the point, because the funding
 * transaction is the edge this strategy exists not to leave.
 *
 * THERE IS NO 31-WALLET CAP, unlike the other tabs. That limit is the length of
 * the factory's snipe-tax exemption list and binds only at launch. V3 never
 * launches — its wallets buy after the fact and are on no list — so the only
 * cost of more wallets is a longer run.
 */
export default function V3BundlePanel({ step, wallets, rows, setRow, explorer, reload, report, locked }) {
  const [busy, setBusy] = useState('');
  const [count, setCount] = useState(5);
  const [bulk, setBulk] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [keys, setKeys] = useState('');
  const [deleting, setDeleting] = useState(null);

  async function act(what, fn) {
    setBusy(what);
    try {
      report(await fn());
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  const priced = wallets.filter((w) => Number(rows[w.id]?.buyEth) > 0);
  const total = priced.reduce((sum, w) => sum + Number(rows[w.id].buyEth), 0);

  return (
    <Step {...step}>
      <p className="lede">
        Each wallet buys once, with ETH that lands from a Relay solver moments before. Set what each
        one spends — that figure is what the main wallet's sell is sized to raise.
      </p>

      <div className="row">
        <input
          type="number"
          min="1"
          max="100"
          value={count}
          onChange={(e) => setCount(e.target.value)}
          style={{ width: 90 }}
          disabled={locked}
        />
        <Busy
          busy={busy === 'generate'}
          disabled={locked}
          onClick={() =>
            act('generate', () =>
              api('/v3/wallets/generate', 'POST', {
                count: Number(count),
                role: ROLES.bundle,
                label: 'v3 bundle',
              })
            )
          }
        >
          Generate wallets
        </Busy>
        <button className="ghost" onClick={() => setShowImport(true)} disabled={locked}>
          import keys
        </button>
        <span className="spacer" />
        <input
          type="text"
          inputMode="decimal"
          placeholder="set every buy to…"
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
          style={{ width: 150 }}
        />
        <button
          className="ghost"
          disabled={!bulk}
          onClick={() => wallets.forEach((w) => setRow(w.id, { buyEth: bulk }))}
        >
          apply to all
        </button>
      </div>

      {wallets.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Address</th>
                <th className="num">Balance</th>
                <th className="num">Buy (ETH)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {wallets.map((w, i) => (
                <tr key={w.id}>
                  <td>{i + 1}</td>
                  <td>
                    <Address
                      value={w.address}
                      href={explorer ? `${explorer}/address/${w.address}` : ''}
                    />
                  </td>
                  <td className="num">{eth(w.balanceEth)}</td>
                  <td className="num">
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.0"
                      value={rows[w.id]?.buyEth ?? ''}
                      onChange={(e) => setRow(w.id, { buyEth: e.target.value })}
                      style={{ width: 110, textAlign: 'right' }}
                    />
                  </td>
                  <td>
                    <button className="link danger" onClick={() => setDeleting(w)} disabled={locked}>
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <p className="hint">
            {plural(wallets.length, 'wallet')} · {priced.length} priced ·{' '}
            <b>{total.toFixed(6)} ETH</b> of buying in total. The run is one cycle per priced wallet,
            so {plural(priced.length, 'cycle')} at the interval you set in step 4.
          </p>
        </div>
      )}

      <Modal
        open={showImport}
        title="Import bundle keys"
        onCancel={() => setShowImport(false)}
        confirmLabel="Import"
        onConfirm={async () => {
          await act('import', () =>
            api('/v3/wallets/import', 'POST', {
              privateKeys: keys.split(/\s+/).filter(Boolean),
              role: ROLES.bundle,
              label: 'v3 bundle',
            })
          );
          setKeys('');
          setShowImport(false);
        }}
      >
        <p>One key per line. Each is encrypted into this account's keystore and never leaves the server.</p>
        <textarea rows={6} value={keys} onChange={(e) => setKeys(e.target.value)} placeholder="0x…" />
      </Modal>

      <Modal
        open={Boolean(deleting)}
        title="Delete this bundle wallet?"
        danger
        onCancel={() => setDeleting(null)}
        confirmLabel="Delete it"
        onConfirm={async () => {
          await act('delete', () => api(`/v3/wallets/${deleting.id}`, 'DELETE'));
          setDeleting(null);
        }}
      >
        <p>
          Its key is archived, not destroyed. If it is holding ETH or tokens, sell and sweep first —
          nothing in this console will send from it again.
        </p>
        {deleting && (
          <>
            <Fact label="Address" mono>
              {deleting.address}
            </Fact>
            <Fact label="Balance">{eth(deleting.balanceEth)} ETH</Fact>
          </>
        )}
      </Modal>
    </Step>
  );
}
