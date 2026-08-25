import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';
import { rolesFor } from '../variant.js';
import Address from './Address.jsx';
import { runPacedFunding, PACE_MIN_MS, PACE_MAX_MS } from './pacedFunding.js';

/**
 * Step 4 — moving ETH from the dev wallet out to the bundle wallets.
 *
 * The amounts are typed in the table in step 3, not here: they are read next to
 * the buy each wallet is being funded FOR, and splitting the two would mean
 * scrolling between a number and its reason.
 *
 * Which path the run takes is the backend's decision, made per run from the
 * recipient count. It is stated here rather than left to be discovered, because
 * "why did this fund run get rate limited" is the question step 2 exists to
 * answer and the answer is only visible at this moment.
 */
const TIMED_INTERVALS = [
  // Short intervals for pacing under Relay's per-IP quote limit — one wallet per
  // minute is ~1 quote/min, far under it, and funds a bundle in minutes rather
  // than the hours the seasoning-style intervals below take. The backend floor is
  // 1 minute (timedFunding MIN_INTERVAL_MS).
  { minutes: 1, label: '1 min' },
  { minutes: 2, label: '2 min' },
  { minutes: 5, label: '5 min' },
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hr' },
  { minutes: 120, label: '2 hrs' },
  { minutes: 180, label: '3 hrs' },
  { minutes: 360, label: '6 hrs' },
  { minutes: 720, label: '12 hrs' },
  { minutes: 1440, label: '24 hrs' },
];

function intervalLabel(minutes) {
  return TIMED_INTERVALS.find((i) => i.minutes === Number(minutes))?.label || `${minutes} min`;
}

function when(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

function timedSummary(job) {
  if (!job || job.status === 'idle') return 'no timed funding job';
  if (job.status === 'running') {
    return `${job.completed}/${job.total} done, next ${when(job.nextRunAt)}`;
  }
  if (job.status === 'stopped') {
    return `stopped at ${job.completed}/${job.total}; next was ${when(job.nextRunAt)}`;
  }
  if (job.status === 'complete') {
    return `complete: ${job.sent}/${job.total} sent${job.failed ? `, ${job.failed} failed` : ''}`;
  }
  return `${job.status}: ${job.completed || 0}/${job.total || 0}`;
}

export default function FundPanel({ step, wallets, rows, dispersers, reload, report, variant = 'v1' }) {
  const roles = rolesFor(variant);
  const isV2 = variant === 'v2';
  const [includeTokens, setIncludeTokens] = useState(false);
  const [tokenAddress, setTokenAddress] = useState('');
  const [busy, setBusy] = useState('');
  const [relayRuns, setRelayRuns] = useState([]);
  const [timedInterval, setTimedInterval] = useState(30);
  const [timedStatus, setTimedStatus] = useState(null);

  // V1 paced run. The Stop flag is a ref, not state: the loop reads it between
  // wallets and a re-render is not needed for it to take effect. `wake` lets
  // Stop cut the current 4–7 s gap short instead of waiting it out.
  const [pacing, setPacing] = useState(false);
  const stopRef = useRef(false);
  const wakeRef = useRef(null);

  function pacedWait(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        wakeRef.current = null;
        resolve();
      }, ms);
      wakeRef.current = () => {
        clearTimeout(t);
        wakeRef.current = null;
        resolve();
      };
    });
  }

  function stopPaced() {
    stopRef.current = true;
    if (wakeRef.current) wakeRef.current();
  }

  async function sendPaced() {
    stopRef.current = false;
    setPacing(true);
    try {
      await runPacedFunding({
        targets,
        dispersers: dispersers?.addresses || [],
        post: (body) => api('/fund', 'POST', body),
        wait: pacedWait,
        report,
        stopped: () => stopRef.current,
      });
    } finally {
      setPacing(false);
      // Give the last transfer a moment to land before re-reading balances.
      setTimeout(reload, 3000);
    }
  }

  async function act(name, fn) {
    setBusy(name);
    try {
      const out = await fn();
      report(out);
      if (out?.mode === 'relay-solver') setRelayRuns(out.results || []);
      if (out?.mode === 'relay-solver-timed') {
        setTimedStatus(out);
        if (out.results?.length) setRelayRuns(out.results);
      }
      // Give the transfers a moment to land before re-reading balances.
      setTimeout(reload, 3000);
      if (isV2) setTimeout(refreshTimed, 3000);
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  async function refreshTimed() {
    if (!isV2) return;
    try {
      const out = await api('/v2/relay/timed-fund');
      setTimedStatus(out);
      if (out.results?.length) setRelayRuns(out.results);
    } catch (_err) {
      // Funding status is nice-to-have; a transient poll miss should not paint
      // over the main action readout.
    }
  }

  useEffect(() => {
    if (!isV2) return undefined;
    let alive = true;
    async function load() {
      try {
        const out = await api('/v2/relay/timed-fund');
        if (!alive) return;
        setTimedStatus(out);
        if (out.results?.length) setRelayRuns(out.results);
      } catch (_err) {
        // Kept quiet for the same reason as refreshTimed: the normal wallet
        // reload owns visible errors, this is just a background status line.
      }
    }
    load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [isV2]);

  // A WHITELIST. "Everything that is not the dev wallet" used to be the same
  // set and is not any more: the keystore also holds v2dev, v2funding and
  // v2bundle roles, and funding those from here would move real ETH into
  // wallets this panel is not about.
  const targets = wallets
    .filter((w) => w.role === roles.bundle)
    .map((w) => ({ walletId: w.id, amountEth: rows[w.id]?.fund }))
    .filter((t) => Number(t.amountEth) > 0);

  const total = targets.reduce((s, t) => s + Number(t.amountEth), 0);

  // Read, never decided here: the backend picks the path per run from the same
  // two numbers. This only names the choice it is going to make.
  const active = dispersers?.addresses?.length ?? 0;
  const fundEndpoint = isV2 ? '/v2/relay/fund' : '/fund';
  const fundBody = isV2 ? { targets } : { targets, variant };
  const canResumeTimed = timedStatus?.status === 'stopped' && Number(timedStatus.remaining) > 0;
  const timedRunning = timedStatus?.status === 'running';

  return (
    <Step {...step}>
      <p className="lede">
        {isV2 ? (
          <>
            Funds v2 bundle wallets through Relay solver orders, using the <b>Fund</b> column as the
            exact amount each wallet should receive. The dev wallet pays Relay deposit addresses;
            solvers fill the bundle wallets.
          </>
        ) : (
          <>
            Sends ETH from the dev wallet to each bundle wallet through the disperser contract, one
            wallet at a time and {PACE_MIN_MS / 1000}–{PACE_MAX_MS / 1000} seconds apart, using the{' '}
            <b>Fund</b> column in the table above. Blank rows are skipped. Fund a little above what
            each wallet will buy — it pays its own gas. Stop halts before the next wallet.
          </>
        )}
      </p>

      <div className="row">
        {isV2 ? (
          <Busy
            busy={busy === 'fund'}
            disabled={!targets.length}
            title={targets.length ? '' : 'enter a fund amount in the table above'}
            onClick={() => act('fund', () => api(fundEndpoint, 'POST', fundBody))}
          >
            {targets.length
              ? `Relay ${total.toFixed(4)} ETH to ${targets.length} wallet${targets.length === 1 ? '' : 's'}`
              : 'Nothing to send'}
          </Busy>
        ) : (
          <>
            {/* V1 funds 1 by 1 through the disperser contract, 4–7 s apart, so
                every bundle wallet is funded by the contract rather than in one
                burst from the dev wallet. The burst/batched send is gone from
                this tab on purpose. */}
            <Busy
              busy={pacing}
              disabled={!targets.length || !dispersers?.addresses?.length}
              title={
                !targets.length
                  ? 'enter a fund amount in the table above'
                  : !dispersers?.addresses?.length
                    ? 'no disperser deployed — deploy one in step 2 first'
                    : ''
              }
              onClick={sendPaced}
            >
              {targets.length
                ? `Send ${total.toFixed(4)} ETH to ${targets.length} wallet${targets.length === 1 ? '' : 's'} — 1 by 1 via disperser, ${PACE_MIN_MS / 1000}–${PACE_MAX_MS / 1000} s apart`
                : 'Nothing to send'}
            </Busy>
            {pacing && (
              <button
                className="spend"
                title="stop before the next wallet; a transfer already sent cannot be cancelled"
                onClick={stopPaced}
              >
                Stop
              </button>
            )}
          </>
        )}

        {isV2 && targets.length > 0 && (
          <span className="hint">
            strict exact-output Relay deposits — verify balances before preflight
          </span>
        )}

        {!isV2 && targets.length > 0 && (
          <span className="hint">
            {active > 0
              ? `one disperser transaction per wallet, ${PACE_MIN_MS / 1000}–${PACE_MAX_MS / 1000} s apart${active > 1 ? `, rotating across ${active} contracts` : ''}`
              : 'no disperser deployed — deploy one in step 2 first'}
          </span>
        )}

        <span className="spacer" />

        <label className="hint" style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <input
            type="checkbox"
            checked={includeTokens}
            onChange={(e) => setIncludeTokens(e.target.checked)}
          />
          also sweep tokens
        </label>
        {includeTokens && (
          <input
            placeholder="token address"
            value={tokenAddress}
            onChange={(e) => setTokenAddress(e.target.value)}
          />
        )}
        {/* .spend, not ghost: this empties every bundle wallet back to dev on
            the first click, with no confirmation dialog anywhere behind it.
            Tinted vermilion rather than filled — the filled amber beside it is
            step 4's own action and has to stay the loudest thing in the row. */}
        <Busy
          busy={busy === 'sweep'}
          disabled={pacing}
          className="spend"
          title="return everything to the dev wallet"
          onClick={() =>
            act('sweep', () =>
              api('/sweep', 'POST', {
                includeTokens,
                tokenAddress: tokenAddress.trim() || null,
                variant,
              })
            )
          }
        >
          Sweep back to dev
        </Busy>
      </div>

      {isV2 && (
        <div className="row">
          <label className="hint" style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
            timed funding
            <select
              value={timedInterval}
              disabled={timedRunning}
              onChange={(e) => setTimedInterval(Number(e.target.value))}
            >
              {TIMED_INTERVALS.map((i) => (
                <option key={i.minutes} value={i.minutes}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>

          <Busy
            busy={busy === 'timed-start'}
            disabled={timedRunning || (!canResumeTimed && !targets.length)}
            title={
              timedRunning
                ? 'timed funding is already running'
                : canResumeTimed
                  ? 'resume the server-held timed funding job'
                  : targets.length
                    ? ''
                    : 'enter a fund amount in the table above'
            }
            onClick={() =>
              act('timed-start', () =>
                canResumeTimed
                  ? api('/v2/relay/timed-fund/resume', 'POST')
                  : api('/v2/relay/timed-fund/start', 'POST', {
                      targets,
                      intervalMinutes: Number(timedInterval),
                    })
              )
            }
          >
            {canResumeTimed
              ? 'Resume timed funding'
              : `Start timed (${intervalLabel(timedInterval)} apart)`}
          </Busy>

          {timedRunning && (
            <Busy
              busy={busy === 'timed-stop'}
              className="spend"
              title="cancel future timed sends; a deposit already broadcasting cannot be cancelled"
              onClick={() => act('timed-stop', () => api('/v2/relay/timed-fund/stop', 'POST'))}
            >
              Stop timed
            </Busy>
          )}

          <span className="hint">
            {timedSummary(timedStatus)} — server keeps running if this tab closes
          </span>
        </div>
      )}

      {isV2 && relayRuns.length > 0 && (
        <div className="table-scroll" style={{ marginTop: 12 }}>
          <table className="wallet-list">
            <thead>
              <tr>
                <th>Bundle wallet</th>
                <th>Receives</th>
                <th>Relay deposit</th>
                <th>Request</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {relayRuns.map((r) => (
                <tr key={`${r.requestId || r.hash || r.walletId}-${r.index ?? ''}`}>
                  <td className="addr">
                    <Address value={r.address} />
                  </td>
                  <td className="bal">{Number(r.amountEth || 0).toFixed(6)}</td>
                  <td className="addr">
                    <Address value={r.depositAddress} />
                    <div className="hint">{Number(r.depositEth || 0).toFixed(6)} ETH</div>
                  </td>
                  <td className="addr">
                    {r.requestId ? `${r.requestId.slice(0, 10)}…${r.requestId.slice(-6)}` : '—'}
                  </td>
                  <td>
                    {r.error ? (
                      <span className="fund-state is-part">deposit failed</span>
                    ) : r.status === 'funding' ? (
                      <span className="fund-state is-wait">funding</span>
                    ) : r.simulated ? (
                      <span className="fund-state is-wait">quoted</span>
                    ) : (
                      <span className="fund-state is-in">deposit sent</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Step>
  );
}
