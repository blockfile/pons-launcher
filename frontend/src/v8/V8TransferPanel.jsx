import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { clock, eth, plural, targetsFor, totalEth } from './roles.js';

/**
 * The intervals a server-held run may be paced at.
 *
 * The short end is for pacing under Relay's per-IP quote limit — one wallet a
 * minute is about one quote a minute, far under it, and pays a hundred wallets
 * in under two hours. The long end is the seasoning shape: a wallet an hour, or
 * one every six, so the deposits do not read as a schedule at all. Mirrors the
 * v2 funding panel's list, whose 1-minute floor is the backend's own.
 */
const TIMED_INTERVALS = [
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

/**
 * The one-line state of the server-held job.
 *
 * Written to survive a backend that answers with less than this: every field is
 * read through a default, because a status line that throws takes the whole tab
 * down with it, and this one is polled every ten seconds forever.
 */
function timedSummary(job) {
  if (!job || job.status === 'idle' || !job.status) return 'no timed run held on the server';
  const done = job.completed ?? job.sent ?? 0;
  const total = job.total ?? 0;
  const next = job.nextRunAt ? clock(job.nextRunAt) : null;
  if (job.status === 'running') {
    return `${done}/${total} sent${next ? `, next at ${next}` : ''}`;
  }
  if (job.status === 'stopped') {
    return `stopped at ${done}/${total}${next ? `; next was ${next}` : ''}`;
  }
  if (job.status === 'complete') {
    return `complete: ${job.sent ?? done}/${total} sent${job.failed ? `, ${job.failed} failed` : ''}`;
  }
  return `${job.status}: ${done}/${total}`;
}

// Per-wallet state → colour, so the table reads the way the other consoles'
// result tables do. Grey for anything in flight, jade for landed, vermilion for
// failed — no amber, because amber in this panel is the button.
function stateColor(s) {
  if (s === 'done' || s === 'sent' || s === 'confirmed') return 'var(--jade)';
  if (s === 'failed' || s === 'error') return 'var(--vermilion)';
  return 'var(--dim)';
}

/**
 * Step 3 — the money.
 *
 * THE WHOLE POINT OF THIS TAB IS IN THIS PANEL. The source does not pay the
 * destination wallets: it pays a Relay deposit address, and a SOLVER — an
 * unrelated party, different for each order — pays the wallet. On chain the
 * destination's funder is that solver, so there is no transaction linking the
 * wallets to the source and none linking them to each other.
 *
 * TWO WAYS TO SEND, and only ever one of them on screen:
 *   now    — the orders go out back-to-back, in one request. Minutes.
 *   timed  — one wallet per interval, held BY THE SERVER, so it keeps running
 *            with this tab closed. Hours or days, and the deposits stop reading
 *            as a batch at all.
 *
 * The mode is a select rather than two buttons because both of them spend, and
 * the console's law is one amber control per panel: whichever mode is chosen,
 * exactly one control here is the spend, and it is the amber one.
 */
export default function V8TransferPanel({
  step,
  main,
  bundle,
  rows,
  setRow,
  live,
  explorer,
  reload,
  report,
  onJob,
}) {
  const [busy, setBusy] = useState('');
  const [mode, setMode] = useState('now');
  const [intervalMinutes, setIntervalMinutes] = useState(30);
  const [job, setJob] = useState(null);
  const [confirming, setConfirming] = useState(false);
  // What one instant run reported back, if it reported per-wallet rows at all.
  const [runs, setRuns] = useState([]);
  // The amount the fill-all control writes into every row. It moves no ETH — it
  // only types what the operator was about to type a hundred times.
  const [fillAll, setFillAll] = useState('');

  // `onJob` handed up so the console can mark the step and hold destructive
  // controls while a run is going. Kept in a ref so a parent that rebuilds the
  // callback every render cannot re-fire the poll below.
  const hand = useRef(onJob);
  hand.current = onJob;

  const explorerFor = (address) => (explorer ? `${explorer}/address/${address}` : '');

  /**
   * The server-held job, polled every 10 seconds — the interval the v2 funding
   * panel uses, and slow enough that a tab left open for a day-long run is not
   * a load of its own.
   *
   * QUIET ON FAILURE, and that is deliberate rather than lazy: this runs whether
   * or not anything has been started, so on a console whose backend is not up
   * yet it would otherwise raise an error toast every ten seconds forever. The
   * actions below own the visible errors.
   */
  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const out = await api('/v8/transfer/timed');
        if (!alive) return;
        setJob(out);
        hand.current?.(out);
        if (Array.isArray(out.results) && out.results.length) setRuns(out.results);
      } catch {
        // See above — a status read is never worth a toast.
      }
    }
    load();
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  async function refreshTimed() {
    try {
      const out = await api('/v8/transfer/timed');
      setJob(out);
      hand.current?.(out);
    } catch {
      // Same reasoning as the poll.
    }
  }

  async function act(what, fn) {
    setBusy(what);
    try {
      const out = await fn();
      report(out);
      if (Array.isArray(out?.results)) setRuns(out.results);
      // Give the fills a moment to land before re-reading balances.
      setTimeout(reload, 3000);
      setTimeout(refreshTimed, 3000);
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  const targets = targetsFor(bundle, rows);
  const total = totalEth(targets);
  const sourceEth = Number(main?.balanceEth || 0);
  // The source pays the deposits, the Relay fee on each one, and the gas — so a
  // balance merely EQUAL to the total is already short. Flagged, never blocked:
  // the balance may be a poll behind, and this console does not hold an
  // operator's own wallets hostage to its own arithmetic.
  const short = Boolean(main) && total > 0 && sourceEth <= total;

  const running = job?.status === 'running';
  // A stopped job with work left is resumed rather than restarted, so the
  // wallets already paid are not paid twice. `remaining` is read permissively:
  // a backend that does not report it should still offer the resume its own
  // /resume endpoint exists for.
  const canResume = job?.status === 'stopped' && (job.remaining == null || Number(job.remaining) > 0);

  // Per-wallet state out of the job, for the table's last column. Both lists are
  // checked with Array.isArray rather than `|| []`: a field that came back as an
  // object would be a non-iterable in a for…of and would take the whole tab down
  // during render, which is a steep price for a status field.
  const stateOf = new Map();
  const jobTargets = Array.isArray(job?.targets) ? job.targets : [];
  const jobResults = Array.isArray(job?.results) ? job.results : [];
  for (const t of jobTargets) if (t?.walletId) stateOf.set(t.walletId, t.state || t.status);
  for (const r of jobResults) if (r?.walletId) stateOf.set(r.walletId, r.status || r.state);

  return (
    <Step {...step}>
      <p className="lede">
        The source never pays these wallets directly. It pays a <b>Relay deposit address</b>, and a
        solver — a different one per order — pays the wallet. On chain each destination's funder is
        that solver, so nothing connects them to the source, and nothing connects them to each
        other. Type an amount per wallet below; blank rows are skipped.
      </p>

      {!main && (
        <div className="notice">
          <h3>No source wallet yet</h3>
          <p>Create it in step 1 — it pays every Relay deposit, the fee on each one, and the gas.</p>
        </div>
      )}

      {main && (
        <div className="row">
          <span className="hint">source pays the deposits —</span>
          <Address value={main.address} plain href={explorerFor(main.address)} />
          <span className="hint">
            {eth(main.balanceEth)} ETH held
            {total > 0 ? ` · this run needs ≈${total.toFixed(6)} ETH + Relay fees + gas` : ''}
          </span>
        </div>
      )}

      {/* Vermilion, not amber: the panel's amber is the send button, and this is
          the over-cap case the law reserves vermilion for. It states the
          shortfall and blocks nothing. */}
      {short && (
        <div className="notice danger">
          <h3>The source holds less than this run needs</h3>
          <p>
            <span className="crux">
              It holds {eth(main.balanceEth)} ETH and the amounts below come to {total.toFixed(6)}.
            </span>{' '}
            Every order also costs a Relay fee and gas on top, so the source needs comfortably more
            than the total, not the same. Orders that cannot be paid for fail one at a time — the
            earlier wallets are funded and the later ones are not.
          </p>
        </div>
      )}

      {bundle.length === 0 ? (
        <div className="notice">
          <h3>No destination wallets yet</h3>
          <p>Generate, import or claim them in step 2 — there is nothing here to pay.</p>
        </div>
      ) : (
        <>
          {/* FILL — writes the same figure into every row. It is a typing tool
              and moves no ETH, so it is a ghost, and it sits above the table it
              writes into. */}
          <div className="row" style={{ marginTop: 12 }}>
            <span className="ctl-label">Fill</span>
            <input
              type="number"
              step="0.0001"
              min="0"
              placeholder="0.01"
              value={fillAll}
              onChange={(e) => setFillAll(e.target.value)}
              style={{ width: 110 }}
            />
            <Busy
              className="ghost"
              disabled={!(Number(fillAll) > 0) || running}
              title={running ? 'a timed run is going — its queue is held on the server' : ''}
              onClick={() => {
                bundle.forEach((w) => setRow(w.id, { amount: String(Number(fillAll)) }));
                report(
                  `Filled ${plural(bundle.length, 'row')} with ${Number(fillAll)} ETH each — ` +
                    `${(Number(fillAll) * bundle.length).toFixed(6)} ETH in total. Nothing was sent; ` +
                    'edit any row, then send below.'
                );
              }}
            >
              Put it in every row
            </Busy>
            <button
              type="button"
              className="quiet"
              disabled={running}
              onClick={() => bundle.forEach((w) => setRow(w.id, { amount: '' }))}
            >
              Clear amounts
            </button>
            <span className="hint">moves no ETH · every field stays editable</span>
          </div>

          <div className="table-card" style={{ maxHeight: 460, marginTop: 12 }}>
            <table className="wallet-list">
              <thead>
                <tr>
                  <th className="num">No.</th>
                  <th>Address</th>
                  <th className="num">Balance</th>
                  <th className="num">Send (ETH)</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {bundle.map((w, i) => {
                  const state = stateOf.get(w.id);
                  return (
                    <tr key={w.id}>
                      <td className="num hint">{i + 1}</td>
                      <td>
                        <Address value={w.address} plain href={explorerFor(w.address)} />
                      </td>
                      <td className="num">
                        <span className={`bal ${Number(w.balanceEth) === 0 ? 'zero' : ''}`}>
                          {eth(w.balanceEth)}
                        </span>
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          step="0.0001"
                          min="0"
                          placeholder="0.0"
                          // While a server-held run is going, the queue it is
                          // working through is the one it was started with —
                          // typing here would change nothing but the screen.
                          disabled={running}
                          value={rows[w.id]?.amount ?? ''}
                          onChange={(e) => setRow(w.id, { amount: e.target.value })}
                          style={{ width: 110 }}
                        />
                      </td>
                      <td>
                        {state ? (
                          <span style={{ color: stateColor(state) }}>{state}</span>
                        ) : (
                          <span className="hint">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* THE SPEND. One control, whichever mode is chosen — see the header
              note for why the mode is a select and not a second button. */}
          <div className="row" style={{ marginTop: 12 }}>
            <label>
              how to send
              <select
                value={mode}
                disabled={running}
                onChange={(e) => setMode(e.target.value)}
                title={running ? 'a timed run is going — stop it to change the mode' : ''}
              >
                <option value="now">now — every order back to back</option>
                <option value="timed">timed — one wallet per interval, held by the server</option>
              </select>
            </label>

            {mode === 'timed' && (
              <label>
                one wallet every
                <select
                  value={intervalMinutes}
                  disabled={running}
                  onChange={(e) => setIntervalMinutes(Number(e.target.value))}
                >
                  {TIMED_INTERVALS.map((i) => (
                    <option key={i.minutes} value={i.minutes}>
                      {i.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {running ? (
              // Vermilion frame: it stops a run that is spending right now, and
              // there is no dialog behind it. It cannot call back an order that
              // has already gone.
              <Busy
                busy={busy === 'stop'}
                className="spend"
                title="cancel the sends still to come; an order already placed cannot be recalled"
                onClick={() => act('stop', () => api('/v8/transfer/timed/stop', 'POST'))}
              >
                Stop the timed run
              </Busy>
            ) : mode === 'now' ? (
              <Busy
                busy={busy === 'send'}
                disabled={!main || targets.length === 0}
                title={
                  !main
                    ? 'create the source wallet in step 1 first'
                    : targets.length === 0
                      ? 'type an amount against at least one wallet'
                      : ''
                }
                onClick={() => setConfirming(true)}
              >
                {targets.length
                  ? `Send ${total.toFixed(4)} ETH to ${plural(targets.length, 'wallet')} through Relay`
                  : 'Nothing to send'}
              </Busy>
            ) : (
              <Busy
                busy={busy === 'timed-start'}
                disabled={!main || (!canResume && targets.length === 0)}
                title={
                  !main
                    ? 'create the source wallet in step 1 first'
                    : canResume
                      ? 'pick the stopped run back up where it left off'
                      : targets.length === 0
                        ? 'type an amount against at least one wallet'
                        : ''
                }
                onClick={() =>
                  act('timed-start', () =>
                    canResume
                      ? api('/v8/transfer/timed/resume', 'POST')
                      : api('/v8/transfer/timed/start', 'POST', {
                          targets,
                          intervalMinutes: Number(intervalMinutes),
                        })
                  )
                }
              >
                {canResume
                  ? 'Resume the timed run'
                  : `Start timed — ${plural(targets.length, 'wallet')}, one every ${intervalLabel(intervalMinutes)}`}
              </Busy>
            )}
          </div>

          <div className="row">
            <span className="hint">
              {timedSummary(job)} — the server keeps a timed run going with this tab closed.
            </span>
          </div>

          {running && (
            <p className="hint" style={{ margin: '8px 0 0' }}>
              The timed run holds the source wallet until it finishes or is stopped — its queue is
              the one it was started with, so the amounts above are read-only and there is no
              instant send while it is going. Stopping leaves every wallet already paid alone.
            </p>
          )}

          {mode === 'timed' && !running && (
            <p className="hint" style={{ margin: '8px 0 0' }}>
              A timed run is held on the SERVER: it survives closing this tab, and it is stopped only
              from here. Stop leaves the wallets already paid alone and Resume picks up at the next
              one rather than paying anybody twice.
            </p>
          )}
        </>
      )}

      {/* What one run reported, wallet by wallet. Drawn only when the response
          carried rows — the shape is the backend's to decide, so every field is
          read through a guard and a missing one prints an em dash rather than
          blanking the table. */}
      {runs.length > 0 && (
        <div className="table-card" style={{ marginTop: 12, maxHeight: 320 }}>
          <table className="wallet-list">
            <thead>
              <tr>
                <th>Wallet</th>
                <th className="num">Receives</th>
                <th>Relay deposit</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r, i) => (
                <tr key={`${r.requestId || r.hash || r.walletId || 'row'}-${i}`}>
                  <td>
                    {r.address ? (
                      <Address value={r.address} plain href={explorerFor(r.address)} />
                    ) : (
                      <span className="hint">—</span>
                    )}
                  </td>
                  <td className="num">{r.amountEth == null ? '—' : eth(r.amountEth)}</td>
                  <td>
                    {r.depositAddress ? (
                      <Address value={r.depositAddress} plain />
                    ) : (
                      <span className="hint">—</span>
                    )}
                    {r.depositEth != null && <div className="hint">{eth(r.depositEth)} ETH paid in</div>}
                  </td>
                  <td>
                    {r.error ? (
                      <span className="fund-state is-bad">failed</span>
                    ) : r.status === 'sent' || r.status === 'done' ? (
                      <span className="fund-state is-in">sent</span>
                    ) : (
                      <span className="fund-state is-wait">{r.status || 'pending'}</span>
                    )}
                    {r.error && <div className="hint">{r.error}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={confirming}
        title={`Send ${total.toFixed(6)} ETH to ${plural(targets.length, 'wallet')}?`}
        onCancel={() => setConfirming(false)}
        confirmLabel="Send it"
        onConfirm={async () => {
          setConfirming(false);
          await act('send', () => api('/v8/transfer', 'POST', { targets }));
        }}
      >
        <p>
          The source pays one Relay deposit per wallet and a solver delivers each one. The figures
          below are what ARRIVES; the source pays slightly more for the fee and the gas. Orders go
          one after another — a failure is reported and the rest still go.
        </p>
        {main && (
          <Fact label="From" mono>
            {main.address}
          </Fact>
        )}
        <Fact label="Wallets">{targets.length}</Fact>
        <Fact label="Total arriving">{total.toFixed(6)} ETH</Fact>
        <Fact label="Route">Relay solvers — no direct transfer</Fact>
        <Fact label="Mode">{live ? 'live — this spends real ETH' : 'dry run — broadcasts nothing'}</Fact>
      </Modal>
    </Step>
  );
}
