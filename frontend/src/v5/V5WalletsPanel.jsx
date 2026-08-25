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
 * THE "LAUNCHER" SUBSECTION, below the launcher's own address/balance table,
 * is the value-OUT half of the launcher's story that no other v5 step
 * provides. Every other action in this console either spends the launcher
 * FORWARD (the launch fee + first buy, /fund, the bundle fan-out) or sends
 * value INTO it (every sweep) — nothing sends it to an address outside this
 * console. So leftover launch ETH, swept ETH/USDG, and any token that never
 * got fanned out pile up here with no way out except this Withdraw action or
 * exporting the key. It also surfaces + clears a launcher tx that is stuck
 * (broadcast but neither mined nor dropped), which otherwise bricks every new
 * launch — see backend/src/v5/launcher.js for both.
 */
export default function V5WalletsPanel({ step, dev, bundle, lastLaunch, live, explorer, reload, report }) {
  const [busy, setBusy] = useState('');
  const [count, setCount] = useState(10);
  // The wallet a delete is being asked about, or null. The whole record rather
  // than an id so the dialog can state its balance — the fact that decides
  // whether deleting it is a tidy-up or a mistake.
  const [deleting, setDeleting] = useState(null);

  // GET /v5/launcher/status — read-only, the launcher's ETH/USDG (and, if a
  // token address is known, that token) plus whether it has a stuck tx.
  // `lastLaunch` is optional: this panel is drawn before a launch has ever
  // happened, and the status read is still useful without a token to price.
  const [launcherStatus, setLauncherStatus] = useState(null);
  const [statusBusy, setStatusBusy] = useState(false);

  // The withdraw form — asset selector, destination, amount/all.
  const [asset, setAsset] = useState('eth'); // 'eth' | 'usdg' | 'custom'
  const [customToken, setCustomToken] = useState('');
  const [withdrawTo, setWithdrawTo] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawAll, setWithdrawAll] = useState(false);
  const [withdrawArmed, setWithdrawArmed] = useState(false);
  const [pendingWithdraw, setPendingWithdraw] = useState(null); // the body a confirm dialog is about to fire
  const [cancelling, setCancelling] = useState(false); // confirming the stuck-tx cancel

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

  async function loadLauncherStatus() {
    if (!dev) {
      setLauncherStatus(null);
      return;
    }
    setStatusBusy(true);
    try {
      const q = lastLaunch?.token ? `?token=${encodeURIComponent(lastLaunch.token)}` : '';
      setLauncherStatus(await api(`/v5/launcher/status${q}`));
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setStatusBusy(false);
    }
  }

  // On mount, whenever the launcher wallet appears/changes, and whenever a
  // launch this session pins a token to price — the same triggers V5LaunchPanel
  // watches for its own USDG allowance read.
  useEffect(() => {
    loadLauncherStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dev?.address, lastLaunch?.token]);

  function withdrawBody() {
    const assetValue = asset === 'custom' ? customToken.trim() : asset;
    const b = { confirm: true, to: withdrawTo.trim(), asset: assetValue };
    // Omitted (rather than sent as "all") when the toggle is on — the backend
    // treats a missing amount the same as "all" (v5/launcher.js's isAll()).
    if (!withdrawAll) b.amount = withdrawAmount;
    return b;
  }

  // Opens the confirmation dialog. Nothing is sent until its own button is
  // clicked — same rule Modal.jsx documents (Enter never confirms).
  function withdraw() {
    setPendingWithdraw(withdrawBody());
  }

  async function fireWithdraw() {
    const b = pendingWithdraw;
    setPendingWithdraw(null);
    if (!b) return;

    setBusy('launcher-withdraw');
    try {
      const out = await api('/v5/launcher/withdraw', 'POST', b);
      report(out);
      setWithdrawArmed(false);
      setWithdrawTo('');
      setWithdrawAmount('');
      setWithdrawAll(false);
      await reload();
      await loadLauncherStatus();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  async function fireCancel() {
    setCancelling(false);
    setBusy('launcher-cancel');
    try {
      const out = await api('/v5/launcher/cancel', 'POST', { confirm: true });
      report(out);
      await loadLauncherStatus();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  const assetValue = asset === 'custom' ? customToken.trim() : asset;
  const withdrawToTrim = withdrawTo.trim();
  const stuck = Boolean(launcherStatus?.inFlight > 0);
  const withdrawReady =
    Boolean(dev) &&
    Boolean(withdrawToTrim) &&
    Boolean(assetValue) &&
    (withdrawAll || Number(withdrawAmount) > 0);
  const withdrawBlocked = (live && !withdrawArmed) || stuck;

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

      {/* THE LAUNCHER'S OWN VALUE-OUT PATH. See the header comment: nothing
          else in v5 sends value out of this wallet to an address outside the
          console, so leftover ETH/USDG/token has no way out but this or a
          key export. Only drawn once the launcher exists — there is nothing
          to withdraw from or unstick before then. */}
      {dev && (
        <>
          <h3 style={{ margin: '16px 0 8px' }}>Launcher — withdraw / unstick</h3>
          <p className="hint" style={{ margin: '0 0 12px' }}>
            No other action here moves value OUT of the launcher — the launch fee and first buy spend
            it forward, funding and the bundle fan-out spend it forward, and every sweep sends INTO it.
            This is the only way accumulated ETH, USDG or token leaves without exporting the key.
          </p>

          {stuck && (
            <div className="notice danger">
              <h3>The launcher has a stuck transaction</h3>
              <p>
                The launcher has a stuck/unconfirmed transaction (nonce {launcherStatus.stuckNonce}) —
                new launches are blocked until it clears.
              </p>
              <div className="row">
                <Busy
                  busy={busy === 'launcher-cancel'}
                  className="danger"
                  onClick={() => setCancelling(true)}
                >
                  Cancel / replace stuck tx
                </Busy>
              </div>
            </div>
          )}

          <div className="row" style={{ marginBottom: 12 }}>
            <span className="hint">
              {launcherStatus
                ? `${eth(launcherStatus.eth)} ETH · ${eth(launcherStatus.usdg)} USDG${
                    launcherStatus.token
                      ? ` · ${launcherStatus.token.balance} ${launcherStatus.token.symbol}`
                      : ''
                  }`
                : statusBusy
                  ? 'reading launcher balances…'
                  : 'balances unavailable — try refreshing'}
            </span>
            <span className="spacer" />
            <Busy busy={statusBusy} className="quiet" onClick={loadLauncherStatus}>
              Refresh
            </Busy>
          </div>

          <div className="grid">
            <label>
              Asset
              <select value={asset} onChange={(e) => setAsset(e.target.value)}>
                <option value="eth">ETH</option>
                <option value="usdg">USDG</option>
                <option value="custom">Token address…</option>
              </select>
            </label>
            {asset === 'custom' && (
              <label>
                Token address
                <input
                  value={customToken}
                  onChange={(e) => setCustomToken(e.target.value)}
                  placeholder="0x…"
                />
              </label>
            )}
            <label className="half">
              External address you control
              <input
                value={withdrawTo}
                onChange={(e) => setWithdrawTo(e.target.value)}
                placeholder="0x… — where the funds actually leave to"
              />
            </label>
            <label>
              Amount
              <input
                type="number"
                step="0.0001"
                min="0"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                disabled={withdrawAll}
                placeholder="0.0"
              />
            </label>
            <label className="row" style={{ alignItems: 'center', gap: 7 }}>
              <input
                type="checkbox"
                checked={withdrawAll}
                onChange={(e) => setWithdrawAll(e.target.checked)}
              />
              withdraw all
            </label>
          </div>

          <div className={`arm ${live ? 'is-live' : ''}`} style={{ marginTop: 8 }}>
            {live && (
              <label className={`switch ${withdrawArmed ? 'armed' : ''}`}>
                <input
                  type="checkbox"
                  checked={withdrawArmed}
                  onChange={(e) => setWithdrawArmed(e.target.checked)}
                />
                Arm
              </label>
            )}

            <Busy
              busy={busy === 'launcher-withdraw'}
              className={live ? 'danger' : ''}
              disabled={!withdrawReady || withdrawBlocked}
              title={
                !dev
                  ? 'generate a launcher wallet first'
                  : !withdrawToTrim
                    ? 'enter the external address you control'
                    : asset === 'custom' && !customToken.trim()
                      ? 'enter the token address'
                      : !withdrawAll && !(Number(withdrawAmount) > 0)
                        ? 'enter an amount, or check "withdraw all"'
                        : stuck
                          ? 'cancel the stuck launcher tx above first'
                          : live && !withdrawArmed
                            ? 'flip Arm first — this moves funds out of the launcher'
                            : ''
              }
              onClick={withdraw}
            >
              {live ? 'Withdraw from launcher' : 'Withdraw from launcher (dry run)'}
            </Busy>
          </div>

          <Modal
            open={cancelling}
            danger={live}
            title="Cancel the launcher's stuck transaction?"
            question="This replaces it with a 0-value self-transfer at a bumped fee — the only way to un-stick it short of waiting for a drop."
            confirmLabel="Cancel / replace"
            onConfirm={fireCancel}
            onCancel={() => setCancelling(false)}
          >
            <div className="modal-facts">
              <Fact label="Stuck nonce">{launcherStatus?.stuckNonce ?? '—'}</Fact>
            </div>
          </Modal>

          <Modal
            open={Boolean(pendingWithdraw)}
            danger={live}
            title={live ? 'LIVE WITHDRAWAL — moves funds out of the launcher.' : 'Dry run withdrawal from the launcher'}
            confirmLabel={live ? 'Withdraw' : 'Withdraw (dry run)'}
            onConfirm={fireWithdraw}
            onCancel={() => setPendingWithdraw(null)}
          >
            {!live && <p>Nothing will be broadcast.</p>}
            <div className="modal-facts">
              <Fact label="Asset">
                {pendingWithdraw?.asset === 'eth' ? 'ETH' : pendingWithdraw?.asset === 'usdg' ? 'USDG' : pendingWithdraw?.asset}
              </Fact>
              <Fact label="To" mono>
                {pendingWithdraw?.to}
              </Fact>
              <Fact label="Amount">{pendingWithdraw?.amount || 'all'}</Fact>
            </div>
          </Modal>
        </>
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
