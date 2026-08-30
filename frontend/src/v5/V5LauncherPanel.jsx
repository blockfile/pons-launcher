import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import { LuChevronDown, LuChevronUp } from 'react-icons/lu';
import { IconAction } from '../v4/IconButton.jsx';
import { eth } from './roles.js';

/**
 * Unnumbered, last on the page — the launcher's own value-OUT path.
 *
 * NOT ONE OF THE SIX STEPS. Every other action in this console either spends
 * the launcher FORWARD (the launch fee + first buy, /fund, the bundle
 * fan-out) or sends value INTO it (every sweep) — nothing sends it to an
 * address outside this console. So leftover launch ETH, swept ETH/USDG, and
 * any token that never got fanned out pile up here with no way out except
 * this Withdraw action or exporting the key. It also surfaces + clears a
 * launcher tx that is stuck (broadcast but neither mined nor dropped), which
 * otherwise bricks every new launch — see backend/src/v5/launcher.js for both.
 *
 * This used to live inside step 1 (V5WalletsPanel), jammed in beside the
 * wallet setup it has nothing to do with. It moved here — after step 6 — and
 * folded shut by default, so a step-by-step operator never has to look at it.
 * COLLAPSED IS NOT OPTIONAL WHILE THE LAUNCHER IS FINE: this is a rescue
 * drawer, and a drawer that is always open is not a drawer. The one exception
 * is a stuck transaction, which forces it open and keeps it there — unlike
 * V4CampaignsPanel's halted-campaign cards, a manual collapse cannot override
 * that, because a stuck launcher blocking every new launch is not something
 * an operator gets to scroll past by accident.
 */
export default function V5LauncherPanel({ dev, lastLaunch, live, explorer, reload, report }) {
  const [busy, setBusy] = useState('');

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

  // Folded by default. `stuck` (below) ORs into this rather than merely
  // seeding it, so the drawer cannot be clicked shut while it is blocking
  // new launches.
  const [open, setOpen] = useState(false);

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

  const isOpen = open || stuck;

  return (
    <Step
      id="v5-launcher-tools"
      n={null}
      label="Utility"
      title="Launcher tools — withdraw & rescue"
      state={stuck ? 'now' : 'later'}
      chip={stuck ? 'stuck tx' : null}
      last
    >
      <p className="lede">
        Where leftover ETH, USDG or a launched token leave the launcher — the only path out besides
        exporting the key — and where a stuck launcher transaction gets cleared. Folded away by
        default; it opens itself the moment there is something here that needs a hand.
      </p>

      <IconAction
        icon={isOpen ? LuChevronUp : LuChevronDown}
        disabled={stuck}
        onClick={() => setOpen((o) => !o)}
      >
        {stuck ? 'Open — a stuck tx needs attention' : isOpen ? 'Hide' : 'Show launcher tools'}
      </IconAction>

      {isOpen && dev && (
        <div style={{ marginTop: 14 }}>
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
            <label className="row" style={{ alignItems: 'center', gap: 8 }}>
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
        </div>
      )}

      {isOpen && !dev && (
        <p className="hint" style={{ marginTop: 14 }}>
          No launcher wallet yet — set one up in step 1 before there is anything to withdraw or unstick.
        </p>
      )}
    </Step>
  );
}
