import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import V3BackupControls from './V3BackupControls.jsx';
import { ROLES, eth, plural } from './roles.js';

/**
 * Step 2 — the bundle wallets.
 *
 * THERE IS NO AMOUNT TO SET HERE, and that is the design rather than an
 * omission. The position is divided across however many wallets exist: each
 * cycle sells `what is left ÷ how many wallets are left`, jittered, and the last
 * wallet takes the remainder. So the only thing this step decides is HOW MANY
 * pieces the position is cut into — which is exactly the wallet count, and
 * nothing else needs typing.
 *
 * The alternative, setting each wallet's buy up front, cannot work: every sell
 * moves the price down, so amounts fixed in advance either run the position out
 * early or leave a bag behind. The run has to size itself as it goes.
 *
 * Nothing is funded here either. A wallet holding ETH before the run would
 * defeat the point — the funding transaction is the edge this strategy exists
 * not to leave.
 *
 * NO 31-WALLET CAP, unlike the other tabs. That limit is the length of the
 * factory's snipe-tax exemption list and binds only at launch. V3 never
 * launches, so the only cost of more wallets is a longer run and a smaller
 * average buy.
 */
export default function V3BundlePanel({ step, wallets, explorer, reload, report, locked, backupCount }) {
  const [busy, setBusy] = useState('');
  const [count, setCount] = useState(20);
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

  return (
    <Step {...step}>
      <p className="lede">
        How many pieces the position is cut into. Each wallet buys once, with ETH from a sale that
        happened seconds before — the sizes are worked out during the run, so there is nothing to set
        here but the count.
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
          className="btn-primary"
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
        <V3BackupControls count={backupCount} report={report} />
        <span className="spacer" />
        {wallets.length > 0 && (
          <span className="hint">
            {plural(wallets.length, 'wallet')} · {plural(wallets.length, 'cycle')} in the run
          </span>
        )}
      </div>

      {wallets.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Address</th>
                <th className="num">Balance</th>
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
            More wallets means smaller, more frequent buys and a longer run; fewer means larger,
            chunkier ones. Preview in step 4 works out what an average buy comes to.
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
