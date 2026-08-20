import { useEffect, useState } from 'react';
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
  // Ticked ids for a bulk delete, and the frozen list the confirmation asks
  // about — frozen when the dialog opens so the count on screen is the count
  // that runs even as the table re-polls behind it.
  const [ticked, setTicked] = useState([]);
  const [bulk, setBulk] = useState(null);
  const [progress, setProgress] = useState('');
  // V4's seasoned seed wallets ready to hand off into this bundle.
  const [seasoned, setSeasoned] = useState({ count: 0 });
  const [seasonedCount, setSeasonedCount] = useState(20);

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

  // Read-only background poll, same shape as the rest of this console's
  // quiet reads: guarded so an unreachable or disabled V4 just leaves this at
  // 0 rather than surfacing an error in a panel that has nothing to do with it.
  useEffect(() => {
    let alive = true;
    api('/v4/seasoned')
      .then((s) => alive && setSeasoned(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  /** Hand N seasoned V4 seed wallets over into this v3 bundle (re-roled server-side to v3bundle). */
  async function claimSeasoned() {
    setBusy('claim-seasoned');
    try {
      const n = Math.max(1, Math.round(Number(seasonedCount) || 0));
      const out = await api('/v3/wallets/claim-seasoned', 'POST', { count: n });
      report(
        out.shortfall > 0
          ? `claimed ${out.claimed} seasoned wallet(s), ${out.shortfall} short — only ${out.available} were ready`
          : `claimed ${out.claimed} seasoned wallet(s)`
      );
      await reload();
      try {
        setSeasoned(await api('/v4/seasoned'));
      } catch {
        // Background read — see the mount-time fetch above.
      }
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  // Ticked ids intersected with what is still on screen, so a wallet deleted
  // since it was ticked cannot be carried in on a stale id.
  const tickedHere = wallets.filter((w) => ticked.includes(w.id));
  const allTicked = wallets.length > 0 && tickedHere.length === wallets.length;

  /**
   * Delete the ticked wallets, one request each, carrying on past failures.
   * Sequential rather than parallel because every delete rewrites the whole
   * keystore file — concurrent writes would race. A run in progress refuses
   * every delete; that refusal is reported once rather than a hundred times.
   */
  async function deleteTicked(list) {
    let done = 0;
    const failures = [];
    for (const w of list) {
      setProgress(`deleting ${done + 1} of ${list.length}…`);
      try {
        await api(`/v3/wallets/${w.id}`, 'DELETE');
        done += 1;
      } catch (err) {
        failures.push(err.message);
      }
    }
    setProgress('');
    setTicked([]);
    const refused = failures.length ? ` ${failures.length} refused: ${failures[0]}` : '';
    return `Deleted ${done} bundle wallet(s).${refused}`;
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
        <input
          type="number"
          min="1"
          max={seasoned.count || 1}
          value={seasonedCount}
          onChange={(e) => setSeasonedCount(e.target.value)}
          title="how many seasoned wallets to claim"
          style={{ width: 70 }}
          disabled={locked}
        />
        <Busy
          busy={busy === 'claim-seasoned'}
          className="ghost"
          disabled={locked || !seasoned.count}
          title={seasoned.count ? '' : 'no seasoned wallets ready yet'}
          onClick={claimSeasoned}
        >
          Use {seasonedCount} seasoned wallets
        </Busy>
        <span className="hint">{seasoned.count} seasoned ready</span>
        <V3BackupControls count={backupCount} report={report} />
        {tickedHere.length > 0 && (
          <Busy busy={busy === 'delete'} className="ghost danger" onClick={() => setBulk(tickedHere)}>
            Delete {tickedHere.length} selected
          </Busy>
        )}
        <span className="spacer" />
        {progress ? (
          <span className="hint">{progress}</span>
        ) : (
          wallets.length > 0 && (
            <span className="hint">
              {plural(wallets.length, 'wallet')} · {plural(wallets.length, 'cycle')} in the run
            </span>
          )
        )}
      </div>

      {wallets.length > 0 && (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  {/* Every wallet, not a visible slice — the table scrolls, so
                      everything this ticks is reachable. */}
                  <input
                    type="checkbox"
                    checked={allTicked}
                    disabled={locked}
                    onChange={(e) => setTicked(e.target.checked ? wallets.map((w) => w.id) : [])}
                  />
                </th>
                <th>#</th>
                <th>Address</th>
                <th className="num">Balance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {wallets.map((w, i) => (
                <tr key={w.id}>
                  <td>
                    <input
                      type="checkbox"
                      checked={ticked.includes(w.id)}
                      disabled={locked}
                      onChange={() =>
                        setTicked((cur) =>
                          cur.includes(w.id) ? cur.filter((x) => x !== w.id) : [...cur, w.id]
                        )
                      }
                    />
                  </td>
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

      <Modal
        open={Boolean(bulk)}
        title={`Delete ${bulk ? bulk.length : 0} bundle wallet${bulk && bulk.length === 1 ? '' : 's'}?`}
        danger
        onCancel={() => setBulk(null)}
        confirmLabel={`Delete ${bulk ? bulk.length : 0} wallets`}
        onConfirm={async () => {
          const list = bulk;
          setBulk(null);
          await act('delete', () => deleteTicked(list));
        }}
      >
        <p>
          Their keys are archived, not destroyed. Any wallet still holding ETH or tokens should be
          swept first — nothing here will send from them again.
        </p>
        {bulk && bulk.some((w) => Number(w.balanceEth) > 0) && (
          <p className="warn">
            {bulk.filter((w) => Number(w.balanceEth) > 0).length} of them still hold ETH. Archiving
            leaves that ETH at those addresses, reachable only by restoring the keys.
          </p>
        )}
      </Modal>
    </Step>
  );
}
