import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import BackupControls from '../components/BackupControls.jsx';
import { LuTrash2 } from 'react-icons/lu';
import IconButton from '../v4/IconButton.jsx';
import { MAX_GENERATE, ROLES, eth, plural } from './roles.js';

/**
 * Step 1 — the wallets a letscash run is built from.
 *
 * TWO KINDS IN ONE PANEL, because they are set up together and neither is useful
 * without the other:
 *
 *   v5dev     the launcher. Signs the letscash launch and its atomic first buy,
 *             so the first-buy supply lands here before it is fanned out. A
 *             SINGLETON — the backend refuses a second, so once one exists the
 *             console offers a delete rather than another create.
 *   v5bundle  the wallets that first-buy supply is distributed to, and that make
 *             any optional extra on-curve buys. Plural, generated in a batch.
 *
 * DELETE AND BACKUP ARE THE GENERIC CONTROLS, not v5's own. v5 exposes no
 * delete or backup route of its own — a wallet is deleted through
 * `DELETE /api/wallets/:id` (keyed on walletId, the field GET /v5/wallets
 * returns) and the whole keystore is exported through the shared BackupControls,
 * the same file every other console reaches for. The backup is the thing that
 * makes a delete survivable, so it is drawn right beside the deletes.
 */
export default function V5WalletsPanel({ step, dev, bundle, explorer, reload, report }) {
  const [busy, setBusy] = useState('');
  const [count, setCount] = useState(10);
  // The wallet a delete is being asked about, or null. The whole record rather
  // than an id so the dialog can state its balance — the fact that decides
  // whether deleting it is a tidy-up or a mistake.
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

  // Clamped where it is typed, not where it is sent: the field must never offer a
  // number the server has already decided to refuse.
  const wanted = Math.min(MAX_GENERATE, Math.max(1, Math.round(Number(count) || 0)));
  // Both roles, for the shared backup's count and disabled state — the file it
  // writes is the whole keystore regardless, but the button should light up as
  // soon as v5 has a wallet in it.
  const allWallets = [dev, ...bundle].filter(Boolean);

  const explorerFor = (address) => (explorer ? `${explorer}/address/${address}` : '');

  return (
    <Step {...step}>
      <p className="lede">
        The launcher signs the letscash launch and takes the guaranteed first buy; the bundle wallets
        are where that first-buy supply is fanned out. Set both up here — nothing is funded yet.
      </p>

      {/* The launcher — a singleton, so this is a create-once row that becomes a
          delete once one exists. */}
      <h3 style={{ margin: '0 0 8px' }}>Launcher wallet</h3>
      {!dev ? (
        <div className="notice">
          <h3>No launcher wallet yet</h3>
          <p>
            One wallet signs the launch and its atomic first buy. It is a singleton — the backend
            keeps exactly one, so the whole run has a single payer and a single first-buy position.
          </p>
          <div className="row">
            <Busy
              busy={busy === 'gen-dev'}
              className="btn-primary"
              onClick={() =>
                act('gen-dev', () =>
                  api('/v5/wallets/generate', 'POST', { count: 1, role: ROLES.dev, label: 'v5 launcher' })
                )
              }
            >
              Create launcher wallet
            </Busy>
          </div>
        </div>
      ) : (
        <div className="table-scroll" style={{ marginBottom: 16 }}>
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th className="num">Balance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <Address value={dev.address} plain href={explorerFor(dev.address)} />
                </td>
                {/* null is "the RPC did not answer", not zero — a wallet drawn at
                    0 that actually holds ETH is the reading that gets it topped
                    up needlessly. */}
                <td className="num">
                  {dev.balanceEth == null ? <span className="hint">unreadable</span> : eth(dev.balanceEth)}
                </td>
                <td className="num">
                  <IconButton
                    icon={LuTrash2}
                    danger
                    label={`Delete launcher wallet ${dev.address}`}
                    onClick={() => setDeleting(dev)}
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* The bundle — plural, generated in a batch. */}
      <h3 style={{ margin: '4px 0 8px' }}>Bundle wallets</h3>
      <div className="row">
        <input
          type="number"
          min="1"
          max={MAX_GENERATE}
          value={count}
          onChange={(e) => setCount(e.target.value)}
          style={{ width: 90 }}
        />
        <Busy
          busy={busy === 'gen-bundle'}
          className="btn-primary"
          onClick={() =>
            act('gen-bundle', () =>
              api('/v5/wallets/generate', 'POST', {
                count: wanted,
                role: ROLES.bundle,
                label: 'v5 bundle',
              })
            )
          }
        >
          Generate wallets
        </Busy>
        {/* The shared backup, beside the deletes it makes survivable. Every other
            console reaches for this same control; v5 has no reason to differ. */}
        <BackupControls wallets={allWallets} report={report} />
        <span className="spacer" />
        {bundle.length > 0 && (
          <span className="hint">{plural(bundle.length, 'bundle wallet')}</span>
        )}
      </div>
      <p className="hint" style={{ margin: '0 0 12px' }}>
        {MAX_GENERATE} at a time is the ceiling. Unlike v1/v2 there is no 31-wallet cap — letscash has
        no exemption list, so the only cost of more wallets is a longer fan-out. Run it again for more.
      </p>

      {bundle.length === 0 ? (
        <div className="notice">
          <h3>No bundle wallets yet</h3>
          <p>
            These are where the launcher's first-buy supply is distributed. Generate however many the
            strategy wants — nothing is funded until a later step.
          </p>
        </div>
      ) : (
        <div className="table-scroll" style={{ maxHeight: 460, overflowY: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th className="num">No.</th>
                <th>Address</th>
                <th className="num">Balance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {bundle.map((w, i) => (
                <tr key={w.walletId}>
                  <td className="num hint">{i + 1}</td>
                  <td>
                    <Address value={w.address} plain href={explorerFor(w.address)} />
                  </td>
                  <td className="num">
                    {w.balanceEth == null ? <span className="hint">unreadable</span> : eth(w.balanceEth)}
                  </td>
                  <td className="num">
                    <IconButton
                      icon={LuTrash2}
                      danger
                      label={`Delete bundle wallet ${w.address}`}
                      onClick={() => setDeleting(w)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The key is archived, not destroyed — said plainly, because a dialog that
          implies irreversibility teaches an operator to distrust the one place it
          really is. If the wallet holds ETH, sweeping is a later step; deleting
          does not move it. */}
      <Modal
        open={Boolean(deleting)}
        danger
        title={`Delete ${deleting?.role === ROLES.dev ? 'launcher' : 'bundle'} wallet ${
          deleting ? deleting.address.slice(0, 10) : ''
        }…?`}
        question={
          deleting && deleting.balanceEth != null && Number(deleting.balanceEth) > 0
            ? 'It still holds ETH. Deleting does not move it — the balance stays at the address, reachable only by restoring the key.'
            : 'Its key is archived on the server, not destroyed. Nothing in this console will send from it again.'
        }
        confirmLabel="Delete it"
        onConfirm={() => {
          const w = deleting;
          setDeleting(null);
          act('delete', () => api(`/wallets/${w.walletId}`, 'DELETE'));
        }}
        onCancel={() => setDeleting(null)}
      >
        {deleting && (
          <>
            <Fact label="Address" mono>
              {deleting.address}
            </Fact>
            <Fact label="Balance">
              {deleting.balanceEth == null ? 'unreadable' : `${eth(deleting.balanceEth)} ETH`}
            </Fact>
          </>
        )}
      </Modal>
    </Step>
  );
}
