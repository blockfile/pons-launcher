import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Address from '../components/Address.jsx';
import { eth, plural } from './roles.js';

// The 409 the backend raises when the launcher is busy (a launch/bundle/launcher
// action, or a parked launch) or a job is already running — read as "settle that
// first / it's already going", not an error to fix.
const BUSY_RE = /is busy|already running|unresolved/i;

// Per-wallet state → colour, so the table reads like the launch/sell results.
function stateColor(s) {
  if (s === 'done' || s === 'sent') return 'var(--jade)';
  if (s === 'funding' || s === 'next') return 'var(--dim)';
  if (s === 'failed') return 'var(--vermilion)';
  return 'var(--dim)';
}

/**
 * Step 3 — Relay-fund the bundle wallets.
 *
 * Each bundle wallet is funded through a Relay SOLVER, not by a direct transfer
 * from the launcher: the launcher deposits into a Relay-quoted address and a
 * solver delivers the amount to the wallet, so the wallet's on-chain funder is the
 * solver — the shared-funder link every bundle otherwise leaves is broken. The
 * deposits go out ONE AT A TIME with an 8–9s gap (Relay's rate limit + so they do
 * not land as one burst), driven by a SERVER-SIDE job that keeps running even if
 * this tab is closed — reopen it and the status below picks the run back up.
 *
 * The per-wallet amounts are the Fund column from step 2's table (the shared
 * `rows`); edit any here before starting. The launcher pays every deposit + gas,
 * so it must hold enough ETH (fund it from outside in step 1).
 */
export default function V5FundPanel({ step, dev, bundle, live, explorer, reload, report, rows = {}, setRow = () => {} }) {
  const [busy, setBusy] = useState('');
  const [armed, setArmed] = useState(false);
  const [job, setJob] = useState(null); // last GET /v5/fund/relay/status
  const [blocked, setBlocked] = useState(false);
  const [now, setNow] = useState(() => Date.now()); // ticks the next-run countdown

  const explorerFor = (address) => (explorer ? `${explorer}/address/${address}` : '');
  const setFund = (walletId, value) => setRow(walletId, { fund: value });

  const running = Boolean(job?.running);

  // Read the job status once on mount (a run may already be going from before this
  // tab opened) and whenever the credential/panel remounts — quiet on failure.
  const say = useRef(report);
  say.current = report;
  useEffect(() => {
    let alive = true;
    api('/v5/fund/relay/status')
      .then((j) => alive && setJob(j))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Poll while a job is running, and once more right after it stops, so the final
  // per-wallet states land. Also re-read wallet balances as funds arrive.
  useEffect(() => {
    if (!running) return undefined;
    let alive = true;
    const t = setInterval(async () => {
      try {
        const j = await api('/v5/fund/relay/status');
        if (!alive) return;
        setJob(j);
        // Re-read balances every tick so a wallet's Balance column updates as its
        // solver fill lands, not only when the whole run ends.
        reload();
      } catch {
        // transient — keep the last status
      }
    }, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [running, reload]);

  // Tick the "next in Ns" countdown while running.
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  const targets = bundle
    .map((w) => ({ walletId: w.walletId, amountEth: rows[w.walletId]?.fund }))
    .filter((t) => Number(t.amountEth) > 0);
  const total = targets.reduce((s, t) => s + Number(t.amountEth), 0);

  // Per-wallet job state, keyed by walletId, for the table.
  const jobByWallet = new Map((job?.targets || []).map((t) => [t.walletId, t]));
  const resultByWallet = new Map((job?.results || []).map((r) => [r.walletId, r]));

  async function start() {
    setBusy('start');
    setBlocked(false);
    try {
      const j = await api('/v5/fund/relay', 'POST', { targets, confirm: true });
      setJob(j);
      setArmed(false);
    } catch (err) {
      report(`ERROR: ${err.message}`);
      if (BUSY_RE.test(err.message)) setBlocked(true);
    } finally {
      setBusy('');
    }
  }

  async function stop() {
    setBusy('stop');
    try {
      setJob(await api('/v5/fund/relay/stop', 'POST'));
      reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  const ready = Boolean(dev) && targets.length > 0 && !running;
  const blockedByArm = live && !armed;
  const nextInSec = job?.nextRunAt ? Math.max(0, Math.round((Date.parse(job.nextRunAt) - now) / 1000)) : null;

  return (
    <Step {...step}>
      <p className="lede">
        Each bundle wallet is funded through a <b>Relay solver</b> — its on-chain funder is the solver,
        not your launcher, so the wallets don't share an obvious source. They go out one at a time,
        <b> 8–9s apart</b>, from a server-side job that keeps running even if you close this tab. The
        per-wallet amounts are the <b>Fund</b> column from step 2; edit any below before starting.
      </p>

      {!dev && (
        <div className="notice warn">
          <h3>No launcher wallet yet</h3>
          <p>Create it in step 1 — the launcher pays every Relay deposit.</p>
        </div>
      )}
      {dev && (
        <div className="row">
          <span className="hint">launcher pays the deposits —</span>
          <Address value={dev.address} plain href={explorerFor(dev.address)} />
          <span className="hint">
            {eth(dev.balanceEth)} ETH
            {total > 0 ? ` · this run needs ≈${total.toFixed(4)} ETH + Relay fees + gas` : ''}
          </span>
        </div>
      )}
      {dev && Number(dev.balanceEth) === 0 && (
        <div className="notice warn">
          <h3>The launcher is empty</h3>
          <p>Send ETH to it from outside first — nothing here can fund it, and it pays every Relay deposit.</p>
        </div>
      )}
      {/* THE TRAP this panel most often springs: the launcher is ALSO the wallet
          that pays the step-4 launch (fee + the dev first buy + gas). Funding the
          bundle here spends it, so draining it now leaves the launch unable to
          afford the dev buy — the launch then refuses ("insufficient funds") or the
          operator zeroes the dev buy to get through. Say so before it happens. */}
      {dev && Number(dev.balanceEth) > 0 && total > 0 && (
        <p className="hint" style={{ margin: '4px 0 0' }}>
          This wallet also pays your <b>launch</b> in step 4 — the launch fee, your <b>dev first buy</b>,
          and gas. Funding the bundle here spends it, so leave enough for both: fund the launcher for
          (this run ≈{total.toFixed(4)} ETH + Relay fees) <b>plus</b> (launch fee + dev first buy + gas).
        </p>
      )}

      {blocked && (
        <div className="notice danger">
          <h3>The launcher is busy</h3>
          <p>
            A launch, bundle, or launcher action is running (or a launch is unresolved), or a funding
            job is already going. Settle that first — the funding shares the launcher's nonces.
          </p>
        </div>
      )}

      {bundle.length === 0 ? (
        <div className="notice">
          <h3>No bundle wallets yet</h3>
          <p>Generate them in step 2 and set each one's Fund amount there (or in the table below).</p>
        </div>
      ) : (
        <>
          {running && (
            <div className="stats" style={{ marginTop: 12 }}>
              <div className="stat ok">
                <span>Funded</span>
                <b>
                  {job.sent}
                  <span className="stat-of">/{job.total}</span>
                </b>
              </div>
              <div className={`stat ${job.failed ? 'bad' : ''}`}>
                <span>Failed</span>
                <b>{job.failed}</b>
              </div>
              <div className="stat">
                <span>Remaining</span>
                <b>{job.remaining}</b>
              </div>
              <div className="stat">
                <span>Next</span>
                <b>{job.inFlight ? 'funding…' : nextInSec != null ? `${nextInSec}s` : '—'}</b>
              </div>
            </div>
          )}

          <div className="table-scroll" style={{ maxHeight: 460, overflowY: 'auto', marginTop: 10 }}>
            <table className="wallet-list">
              <thead>
                <tr>
                  <th>Address</th>
                  <th className="num">Balance</th>
                  <th className="num">Fund (ETH)</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {bundle.map((w) => {
                  const jt = jobByWallet.get(w.walletId);
                  const jr = resultByWallet.get(w.walletId);
                  const state = jr?.status || jt?.state || '';
                  return (
                    <tr key={w.walletId}>
                      <td className="addr">
                        <Address value={w.address} plain href={explorerFor(w.address)} />
                      </td>
                      <td className="num">
                        {w.balanceEth == null ? (
                          <span className="hint">unreadable</span>
                        ) : (
                          <span className={`bal ${Number(w.balanceEth) === 0 ? 'zero' : ''}`}>{eth(w.balanceEth)}</span>
                        )}
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          step="0.0001"
                          placeholder="0.0"
                          disabled={running}
                          value={rows[w.walletId]?.fund ?? ''}
                          onChange={(e) => setFund(w.walletId, e.target.value)}
                          style={{ width: 100 }}
                        />
                      </td>
                      <td>
                        {state ? (
                          <span style={{ color: stateColor(state) }}>{state}</span>
                        ) : (
                          <span className="hint">—</span>
                        )}
                        {jr?.hash && (
                          <div className="hint">
                            <a href={explorer ? `${explorer}/tx/${jr.hash}` : undefined} target="_blank" rel="noreferrer">
                              deposit {jr.hash.slice(0, 12)}…
                            </a>
                          </div>
                        )}
                        {jr?.error && <div className="hint">{jr.error}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className={`arm ${live ? 'is-live' : ''}`} style={{ marginTop: 12 }}>
            {live && !running && (
              <label className={`switch ${armed ? 'armed' : ''}`}>
                <input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} />
                Arm
              </label>
            )}
            {running ? (
              <Busy busy={busy === 'stop'} className="danger" onClick={stop}>
                Stop funding
              </Busy>
            ) : (
              <Busy
                busy={busy === 'start'}
                className={live ? 'danger' : 'btn-primary'}
                disabled={!ready || blockedByArm}
                title={
                  !dev
                    ? 'create a launcher in step 1 first'
                    : targets.length === 0
                      ? 'set a Fund amount for at least one wallet'
                      : blockedByArm
                        ? 'flip Arm first — this spends the launcher'
                        : ''
                }
                onClick={start}
              >
                {live
                  ? `Start Relay funding — ${plural(targets.length, 'wallet')}, 8–9s apart`
                  : `Start Relay funding (dry run) — ${plural(targets.length, 'wallet')}`}
              </Busy>
            )}
            <span className="spacer" />
            {job && !running && job.status !== 'idle' && (
              <span className="hint">
                last run: {job.sent}/{job.total} funded{job.failed ? `, ${job.failed} failed` : ''} · {job.status}
              </span>
            )}
          </div>

          {job?.status === 'complete' && job.failed > 0 && (
            <div className="notice danger" style={{ marginTop: 10 }}>
              <h3>Some deposits failed</h3>
              <p>
                {plural(job.failed, 'wallet')} didn't get funded — their ETH never left the launcher.
                Re-run funding with just those wallets' amounts set.
              </p>
            </div>
          )}
        </>
      )}
    </Step>
  );
}
