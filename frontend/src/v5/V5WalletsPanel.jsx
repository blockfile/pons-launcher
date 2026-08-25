import { useEffect, useState } from 'react';
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
 *
 * WALLET SETUP ONLY. The launcher's value-OUT path — withdraw and the stuck-tx
 * rescue — used to live here, jammed in below the launcher's own address/
 * balance table. It moved to V5LauncherPanel, an unnumbered utility section at
 * the end of the console: this step is where wallets get set up, not where the
 * launcher's leftover ETH/USDG/token gets moved back out.
 */
export default function V5WalletsPanel({ step, dev, bundle, explorer, reload, report }) {
  const [busy, setBusy] = useState('');
  const [count, setCount] = useState(10);
  // The wallet a delete is being asked about, or null. The whole record rather
  // than an id so the dialog can state its balance — the fact that decides
  // whether deleting it is a tidy-up or a mistake.
  const [deleting, setDeleting] = useState(null);

  // IMPORT — existing wallets by private key, into either v5 role. The role
  // selector is here (not split into a launcher-only and a bundle-only
  // control) because one textarea covers both: importing a launcher key is
  // just as much "get a wallet into v5" as generating bundle wallets is.
  // Keys never linger in state past a submit — see importKeysNow below.
  const [importRole, setImportRole] = useState(ROLES.bundle);
  const [importKeys, setImportKeys] = useState('');
  const [importLabel, setImportLabel] = useState('');

  // CLAIM SEASONED — aged, pre-funded wallets handed off from the V4 tab's
  // pool. `seasoned.count` is read-only background state, same shape as the
  // v3/v4 consoles' own poll of the same endpoint: quiet on failure, because
  // an unreachable or disabled V4 should just show 0 here, not an error in a
  // panel that has nothing to do with it.
  const [seasoned, setSeasoned] = useState({ count: 0 });
  const [seasonedCount, setSeasonedCount] = useState(10);

  useEffect(() => {
    let alive = true;
    const load = () => api('/v4/seasoned').then((s) => alive && setSeasoned(s)).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

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

  /**
   * Import existing wallets by private key into a v5 role. The backend does
   * the whitespace/comma/newline splitting (routes/v5.js), so the raw
   * textarea text is sent as-is rather than pre-split here.
   *
   * The textarea is cleared ONLY on success — a rejected import (a bad key,
   * or a second v5dev landing on the keystore's singleton guard) leaves the
   * field alone so the operator can fix it without re-pasting everything.
   * Either way the keys never get echoed anywhere else: nothing here logs
   * them, stores them past this state, or reflects them back into the UI.
   */
  async function importKeysNow() {
    if (!importKeys.trim()) return;
    setBusy('import');
    try {
      const made = await api('/v5/wallets/import', 'POST', {
        privateKeys: importKeys,
        role: importRole,
        label: importLabel.trim() || undefined,
      });
      report(`imported ${plural(made.length, 'wallet')} into ${importRole === ROLES.dev ? 'the launcher' : 'the bundle'}`);
      setImportKeys('');
      setImportLabel('');
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  /** Pull N aged, pre-funded wallets out of the V4 seasoning pool into the v5 bundle role. */
  async function claimSeasoned() {
    setBusy('claim-seasoned');
    try {
      const n = Math.max(1, Math.round(Number(seasonedCount) || 0));
      const out = await api('/v5/wallets/claim-seasoned', 'POST', { count: n });
      report(
        out.available === 0
          ? 'claimed 0 — none available, season some in the V4 tab first'
          : out.shortfall > 0
            ? `claimed ${plural(out.claimed.length, 'wallet')} — only ${out.available} seasoned wallet(s) were available`
            : `claimed ${plural(out.claimed.length, 'seasoned wallet')}`
      );
      await reload();
      try {
        setSeasoned(await api('/v4/seasoned'));
      } catch {
        // Background read — see the mount-time poll above.
      }
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

      {/* The bundle — plural, generated in a batch. THREE WAYS IN, grouped
          under one "Add wallets" idea because they are all just different
          sources for the same table below: fresh (Generate), keys the
          operator already holds (Import — either role), or aged/pre-funded
          ones handed off from V4's seasoning pool (Seasoned). */}
      <h3 style={{ margin: '4px 0 8px' }}>Bundle wallets</h3>

      <div className="row">
        <span className="ctl-label">Generate</span>
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

      {/* IMPORT — wallets the operator already holds the key for. Fresh
          wallets are a fingerprint (they all share a birth timestamp); keys
          brought in from elsewhere do not. Role selector covers both v5
          roles from one control, since a launcher key is imported exactly
          the same way as a bundle key. */}
      <div className="row">
        <span className="ctl-label">Import</span>
        <select value={importRole} onChange={(e) => setImportRole(e.target.value)} style={{ width: 140 }}>
          <option value={ROLES.bundle}>Bundle wallet</option>
          <option value={ROLES.dev}>Launcher</option>
        </select>
        <input
          value={importLabel}
          onChange={(e) => setImportLabel(e.target.value)}
          placeholder="label (optional)"
          style={{ width: 160 }}
        />
        <Busy busy={busy === 'import'} disabled={!importKeys.trim()} onClick={importKeysNow}>
          Import
        </Busy>
      </div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <span className="ctl-label" />
        <textarea
          rows={3}
          value={importKeys}
          onChange={(e) => setImportKeys(e.target.value)}
          placeholder="0x… one per line, or comma-separated"
          style={{ flex: 1 }}
        />
      </div>
      <p className="hint" style={{ margin: '0 0 12px' }}>
        Each key is encrypted straight into the keystore and never logged or shown again — the field
        clears itself once the import succeeds. Launcher (v5dev) is a singleton: importing a second
        fails loudly, the same way generating one does once a launcher already exists.
      </p>

      {/* SEASONED — aged, pre-funded wallets from the V4 tab's pool, pulled
          into the bundle role most-aged first. The point of seasoning: these
          look organic on-chain where a batch of fresh wallets does not. */}
      <div className="row">
        <span className="ctl-label">Seasoned</span>
        <input
          type="number"
          min="1"
          max={seasoned.count || 1}
          value={seasonedCount}
          onChange={(e) => setSeasonedCount(e.target.value)}
          title="how many seasoned wallets to claim"
          style={{ width: 70 }}
        />
        <Busy
          busy={busy === 'claim-seasoned'}
          disabled={!seasoned.count}
          title={seasoned.count ? '' : 'no seasoned wallets ready yet'}
          onClick={claimSeasoned}
        >
          Claim seasoned
        </Busy>
        <span className="hint">{seasoned.count} seasoned ready</span>
      </div>
      <p className="hint" style={{ margin: '0 0 12px' }}>
        Aged, pre-funded wallets seasoned in the V4 tab — they read as organic rather than as a batch
        generated together. If none are ready, season some there first.
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
