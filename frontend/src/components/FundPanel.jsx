import { useEffect, useRef, useState } from 'react';
import { LuTriangleAlert } from 'react-icons/lu';
import { api, notify } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';
import { rolesFor } from '../variant.js';
import Address from './Address.jsx';
import { runPacedFunding, PACE_MIN_MS, PACE_MAX_MS } from './pacedFunding.js';
// The two knobs of the server-held timed run, and the sentence they add up to.
// Pure and tested; see timedRate.js.
import {
  TIMED_INTERVALS,
  WALLETS_PER_TICK_OPTIONS,
  MAX_WALLETS_PER_TICK,
  capReason,
  intervalLabel,
  timedRate,
} from './timedRate.js';
// Whether the run can run at all, and why not — one expression, drawn on the
// page as well as used to disable the button. Pure and tested; see quoteAsset.js.
import { fundGate } from './quoteAsset.js';
// HOW BIG THE UNTIMED RUN MAY BE BEFORE THE GATEWAY STOPS LISTENING, and what a
// 504 on it actually means. Pure and tested; see quoteWindow.js.
import { fundFailure, quoteWindow, timedAlternative } from './quoteWindow.js';

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
function when(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

// The rate a RUNNING job is actually going at, which is the one it was started
// with — not whatever the field says now. A resumed job keeps its own cadence,
// so the summary is where that number belongs.
function jobRate(job) {
  const per = Number(job?.walletsPerTick) || 1;
  return per > 1 ? `${per}/tick, ` : '';
}

function timedSummary(job) {
  if (!job || job.status === 'idle') return 'no timed funding job';
  if (job.status === 'running') {
    return `${job.completed}/${job.total} done, ${jobRate(job)}next ${when(job.nextRunAt)}`;
  }
  if (job.status === 'stopped') {
    return `stopped at ${job.completed}/${job.total}; ${jobRate(job)}next was ${when(job.nextRunAt)}`;
  }
  if (job.status === 'complete') {
    return `complete: ${job.sent}/${job.total} sent${job.failed ? `, ${job.failed} failed` : ''}`;
  }
  return `${job.status}: ${job.completed || 0}/${job.total || 0}`;
}

export default function FundPanel({
  step,
  wallets,
  rows,
  dispersers,
  reload,
  report,
  // The launch's quote asset, READ ONLY. This step moves ETH whatever the launch
  // is priced in — but on a paired launch the ETH it sends is not what the
  // bundle buys with, it is what the bundle then swaps for the quote asset, and
  // saying so here is the difference between a step that reads top-to-bottom and
  // one an operator has to be told about.
  pair = null,
  // Step key -> live number, so this panel can name another station without
  // knowing where it sits: the numbering closes by KEY, not by position.
  nums = {},
  variant = 'v1',
}) {
  const roles = rolesFor(variant);
  const isV2 = variant === 'v2';
  const [includeTokens, setIncludeTokens] = useState(false);
  const [tokenAddress, setTokenAddress] = useState('');
  const [busy, setBusy] = useState('');
  const [relayRuns, setRelayRuns] = useState([]);
  const [timedInterval, setTimedInterval] = useState(30);
  // How many wallets one tick funds. ONE by default, which is the cadence this
  // scheduler has always had; the ceiling is Relay's quote budget, not taste.
  const [timedPerTick, setTimedPerTick] = useState(1);
  const [timedStatus, setTimedStatus] = useState(null);

  // ── THE UNTIMED RUN'S OWN LIMIT ────────────────────────────────────────────
  //
  // The quote gap, the batch size and what the proxy in front will wait for.
  // They arrive on the SAME poll as the timed job (GET /v2/relay/timed-fund,
  // `quotePacing`) and are held separately from `timedStatus` on purpose: the
  // start/stop/resume responses share that state's shape but carry no pacing,
  // so folding the two together would blank the limit every time a timed
  // control was pressed. Null until the first read answers, which is what makes
  // quoteWindow's documented fallbacks the right thing to draw meanwhile.
  const [quotePace, setQuotePace] = useState(null);
  // The operator's deliberate override of that limit — see the lock control
  // below for why it is a shape change and not a refusal.
  const [untimedArmed, setUntimedArmed] = useState(false);
  // Set when an untimed run's request died without an answer. Not an error: the
  // run is very likely still going server-side, and this is what says so.
  const [blind, setBlind] = useState(null);

  // V1 paced run. The Stop flag is a ref, not state: the loop reads it between
  // wallets and a re-render is not needed for it to take effect. `wake` lets
  // Stop cut the current 8–9 s gap short instead of waiting it out.
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

  // THE UNTIMED RUN, AND THE ONE ANSWER IT CANNOT GIVE.
  //
  // Not `act`: the shared handler reports every rejection as `ERROR: …`, and
  // for THIS request that is wrong in the one case that matters. /v2/relay/fund
  // quotes every wallet before it sends any deposit, so a long run outlives the
  // proxy's patience and the browser is handed a 504 by nginx while the server
  // carries on funding. The operator read that as failure and pressed again —
  // a second run, over wallets the first had already paid. So the failure is
  // classified rather than printed (see fundFailure), and the two branches that
  // are not really failures leave the panel in a state that has to be cleared
  // deliberately before this button can be pressed a second time.
  //
  // `quiet` because this call owns its own notice: api.js's automatic red
  // ticket would say "blocked · 504 Gateway Time-out" over the top of a run
  // that is still going. Every branch below raises one itself.
  async function sendUntimed() {
    setBusy('fund');
    setBlind(null);
    try {
      const out = await api(fundEndpoint, 'POST', fundBody, { quiet: true });
      report(out);
      if (out?.mode === 'relay-solver') setRelayRuns(out.results || []);
      setUntimedArmed(false);
      setTimeout(reload, 3000);
      setTimeout(refreshTimed, 3000);
    } catch (err) {
      const failure = fundFailure({
        // Attached by api.js from the real response. Absent when fetch itself
        // rejected, which is the ambiguous case fundFailure reports as such.
        status: err.status ?? null,
        message: err.message,
        wallets: targets.length,
        window: win,
      });
      report(failure.text);
      if (failure.kind === 'failed') {
        notify(failure.headline, 'error');
      } else {
        // 'note', not 'blocked'. Nothing was blocked; an answer was lost.
        notify(failure.headline, 'info');
        setBlind(failure);
        // Re-lock: whatever the operator overrode, the next press is now a
        // different and worse decision than the one they made a moment ago.
        setUntimedArmed(false);
        // The deposits may well be landing. Read the balances anyway — it is
        // the only progress this console can still show.
        setTimeout(reload, 3000);
      }
    } finally {
      setBusy('');
    }
  }

  async function refreshTimed() {
    if (!isV2) return;
    try {
      const out = await api('/v2/relay/timed-fund');
      setTimedStatus(out);
      if (out.quotePacing) setQuotePace(out.quotePacing);
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
        if (out.quotePacing) setQuotePace(out.quotePacing);
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

  // FAIL CLOSED ON A CHANGED RUN. An override of the untimed limit was granted
  // for a specific number of wallets; change that number and it is a different
  // press, granted again in one click. The alternative is an override still
  // armed from ten minutes and four table edits ago.
  //
  // Below `targets` deliberately: hook order is body order, and reading it from
  // an effect declared above its own declaration is a TDZ crash on first render.
  useEffect(() => {
    setUntimedArmed(false);
  }, [targets.length]);

  // Read, never decided here: the backend picks the path per run from the same
  // two numbers. This only names the choice it is going to make.
  const active = dispersers?.addresses?.length ?? 0;
  // Whether this run can run, and the sentence that says why not. Both halves
  // out of one expression, so a button that refuses can never refuse silently:
  // the two conditions used to live in a `title` and a `disabled` that agreed
  // only by inspection.
  const gate = fundGate({
    targets: targets.length,
    needsDisperser: roles.dispersers,
    dispersers: active,
    nums,
  });
  const fundEndpoint = isV2 ? '/v2/relay/fund' : '/fund';
  const fundBody = isV2 ? { targets } : { targets, variant };
  const canResumeTimed = timedStatus?.status === 'stopped' && Number(timedStatus.remaining) > 0;
  const timedRunning = timedStatus?.status === 'running';
  // The cap comes from the server when a job has been seen, so the console can
  // never offer a rate the scheduler would refuse.
  const perTickCap = Number(timedStatus?.maxWalletsPerTick) || MAX_WALLETS_PER_TICK;
  // What pressing Start would do, in words: the rate, and how long the wallets
  // in the table above would take at it. A resume is the JOB's cadence, not the
  // field's, so it is quoted from the job.
  const rate = canResumeTimed
    ? timedRate({
        wallets: Number(timedStatus.remaining) || 0,
        perTick: Number(timedStatus.walletsPerTick) || 1,
        intervalMinutes: Number(timedStatus.intervalMinutes) || timedInterval,
        max: perTickCap,
      })
    : timedRate({
        wallets: targets.length,
        perTick: timedPerTick,
        intervalMinutes: timedInterval,
        max: perTickCap,
      });

  // ── WHAT ONE PRESS OF THE UNTIMED BUTTON COMMITS TO ────────────────────────
  //
  // Undefined spreads to quoteWindow's defaults, so before the first poll
  // answers this draws the backend's own documented defaults rather than
  // nothing — and is replaced by the live figures the moment they arrive.
  const win = quoteWindow({
    wallets: targets.length,
    gapMs: quotePace?.gapMs,
    batchSize: quotePace?.batchSize,
    timeoutMs: quotePace?.gatewayTimeoutMs,
  });
  // The settings that DO fit, computed from the same cap the timed selects are
  // built from — never a sentence with numbers typed into it.
  const insteadUse = timedAlternative({ wallets: targets.length, perTick: perTickCap });
  // Two reasons to make the press deliberate, one shape. `over` is a forecast
  // and `blind` is a run whose outcome nobody knows; both end in "this press
  // costs more than it looks like", which is exactly what a lock is for.
  const untimedRisky = targets.length > 0 && (win.over || Boolean(blind));
  const untimedLocked = untimedRisky && !untimedArmed;

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

      {/* WHAT THIS ETH IS FOR, when it is not what the bundle buys with. On a
          paired launch the Fund column is the ETH each wallet SWAPS for the
          quote asset — so this step is not the last thing before the launch, and
          the step that is comes back up the page. Saying so is the whole of the
          fix: nothing here changes, it just stops being a surprise. Absent on a
          native launch, where the ETH sent IS the ETH spent. */}
      {pair && (
        <p className="hint">
          This launch is priced in <b>{pair.symbol}</b>, so the ETH sent here is not what the bundle
          buys with — it is what each wallet then <b>swaps for {pair.symbol}</b>. After this run,
          go back to step {nums.wallets ?? 3} and use <b>Pair funding · {pair.symbol}</b>. A wallet
          holding only ETH is dropped by preflight.
        </p>
      )}

      <div className="row">
        {isV2 ? (
          /* THE CONTROL CHANGES SHAPE RATHER THAN DISAPPEARING.

             Refusing outright would remove a working escape hatch — an operator
             who has raised nginx's proxy_read_timeout (they have been told to,
             and may have) is entitled to the one-press run at any size, and
             must not have to edit code to get it. Warning alone leaves the trap
             armed exactly as it was: the whole failure was that the press LOOKED
             ordinary. So over the limit the amber button is not there to be hit
             by reflex; a flat grey control stands in its place, naming the
             limit, and one click puts the amber button back. Two gestures, no
             refusal, and the second one is made after reading the notice below.

             .quiet, and never .quiet.is-on: this control spends nothing and
             moves nothing, and the panel's amber belongs to the funding action
             it reveals. */
          untimedLocked ? (
            <button
              className="quiet"
              title={
                blind
                  ? "the last untimed run's outcome is unknown — check the dev wallet's nonce before starting another"
                  : `${win.sentence}. Unlocks the button as it was; the run will 504 and continue server-side.`
              }
              onClick={() => setUntimedArmed(true)}
            >
              {blind
                ? 'Unlock untimed run — last outcome unknown'
                : `Unlock untimed run — over the ${win.maxWallets}-wallet limit`}
            </button>
          ) : (
            <Busy
              busy={busy === 'fund'}
              disabled={!gate.enabled}
              title={gate.why || ''}
              onClick={sendUntimed}
            >
              {targets.length
                ? `Relay ${total.toFixed(4)} ETH to ${targets.length} wallet${targets.length === 1 ? '' : 's'}`
                : 'Nothing to send'}
            </Busy>
          )
        ) : (
          <>
            {/* V1 funds 1 by 1 through the disperser contract, 8–9 s apart, so
                every bundle wallet is funded by the contract rather than in one
                burst from the dev wallet. The burst/batched send is gone from
                this tab on purpose. */}
            <Busy
              busy={pacing}
              disabled={!gate.enabled}
              title={gate.why || ''}
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

        {/* THE REFUSAL, ON THE PAGE. "Nothing to send" is a state, not a reason,
            and the reason lived in a `title` nobody sees. It names the step that
            fixes it, by that step's live number. */}
        {gate.why && <span className="hint">{gate.why}</span>}

        {/* THE WAY BACK. An unlock granted by mistake is undone here rather
            than by reloading the page — bare text, the bottom rung, because
            re-locking is the safe direction and needs no weight. */}
        {isV2 && untimedRisky && untimedArmed && (
          <button
            className="link"
            title="put the limit back"
            onClick={() => setUntimedArmed(false)}
          >
            re-lock
          </button>
        )}

        {isV2 && targets.length > 0 && (
          <span className="hint">
            strict exact-output Relay deposits — verify balances before preflight
          </span>
        )}

        {/* WHAT THE PRESS COSTS, WHEN IT IS STILL A REASONABLE ONE. Under the
            limit nothing else changes: the same button, plus the seconds it
            will sit there quoting before anything reaches the chain, and the
            window it has to finish inside. The number the whole feature is
            built on is the same one shown here — an operator watching 45 s of
            "working…" should be able to see that 45 s was the deal. */}
        {isV2 && targets.length > 0 && !untimedRisky && win.sentence && (
          <span className="hint">{win.sentence}</span>
        )}

        {!isV2 && targets.length > 0 && (
          <span className="hint">
            {active > 0
              ? `one disperser transaction per wallet, ${PACE_MIN_MS / 1000}–${PACE_MAX_MS / 1000} s apart${active > 1 ? `, rotating across ${active} contracts` : ''}`
              : 'no disperser deployed — deploy one in step 2 first'}
          </span>
        )}

        <span className="spacer" />

        <label className="hint" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
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

      {/* THE OUTCOME NOBODY KNOWS, STATED WHERE THE HAND IS.
          Vermilion, and it is the only thing in the console entitled to it
          here: at this moment the run IS live and IS irreversible — deposits
          are going out and no control can stop them. The same words go to the
          readout, but the sentence that prevents the second press has to be
          beside the button that would make it. */}
      {isV2 && blind && (
        <div className="notice danger">
          <h3>
            <LuTriangleAlert aria-hidden="true" />
            <span>{blind.headline}</span>
            {/* Dismissal is a READING, not an outcome — nothing here can learn
                what the run did, so the only thing that clears this is the
                operator saying they have looked. It also re-locks by leaving
                `untimedArmed` alone: the lock is keyed on this notice. */}
            <button
              className="link"
              style={{ marginLeft: 'auto' }}
              title="clears this notice only — it neither stops nor confirms the run"
              onClick={() => setBlind(null)}
            >
              nonce checked
            </button>
          </h3>
          <ul>
            {blind.lines.map((line, i) => (
              <li key={i}>
                {line.crux && <b className="crux">{line.crux}</b>}
                {line.crux ? ' ' : ''}
                {line.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* THE LIMIT, BEFORE THE PRESS RATHER THAN AFTER IT.
          Grey: this is a forecast, not a live thing and not a settled one, and
          the money colour is spoken for by the funding action itself. One
          .crux carries the clause that cost the operator an evening. */}
      {isV2 && !blind && untimedRisky && (
        <div className="notice">
          <h3>
            <LuTriangleAlert aria-hidden="true" />
            <span>
              Untimed run: {targets.length} wallets · about {win.duration} of quoting · the gateway
              waits {win.limitLabel}
            </span>
          </h3>
          <ul>
            <li>
              Every wallet is quoted before any deposit is sent —{' '}
              {win.batchSize > 1 ? `${win.batchSize} quotes` : 'one quote'} per{' '}
              {(win.gapMs / 1000).toFixed(0)} s, {win.batches} times over — so the browser holds
              this request open for about {win.duration} with nothing on chain. Past{' '}
              {win.limitLabel} the proxy answers 504 Gateway Time-out instead.
            </li>
            <li>
              <b className="crux">The run will continue server-side anyway.</b> The 504 is the
              gateway giving up on the answer, not the funding failing: the deposits keep going
              out, this console can report neither progress nor outcome, and a second press would
              fund every wallet again.
            </li>
            <li>
              Use the row below instead: {insteadUse}. The server holds that job, this tab may
              close, and it is paced at Relay&apos;s own budget rather than against the proxy&apos;s
              patience. Up to {win.maxWallets} wallet{win.maxWallets === 1 ? '' : 's'} still fits
              one untimed press.
            </li>
          </ul>
        </div>
      )}

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

          {/* HOW MANY WALLETS ONE TICK FUNDS. Not amber and never will be: the
              spending action of this panel is the button beside it, and a panel
              gets exactly one. This only sets the rate that button then runs at.
              The list stops at the cap because the cap is Relay's, not ours. */}
          <label
            className="hint"
            style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}
            title={capReason(perTickCap)}
          >
            wallets per tick
            <select
              value={timedPerTick}
              disabled={timedRunning}
              onChange={(e) => setTimedPerTick(Number(e.target.value))}
            >
              {WALLETS_PER_TICK_OPTIONS.filter((n) => n <= perTickCap).map((n) => (
                <option key={n} value={n}>
                  {n}
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
                      walletsPerTick: Number(timedPerTick),
                    })
              )
            }
          >
            {canResumeTimed
              ? 'Resume timed funding'
              : timedPerTick > 1
                ? `Start timed (${timedPerTick} per ${intervalLabel(timedInterval)})`
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

      {/* THE RATE, AND THE CEILING ON IT, IN WORDS. "31 wallets" and "1 min
          apart" is 31 minutes, and the operator used to find that out by
          watching. The second half names the cap and why it exists, so four is
          read as Relay's limit rather than an arbitrary short list. */}
      {isV2 && (
        <div className="row">
          <span className="hint">
            {canResumeTimed ? 'resume continues at ' : ''}
            {rate.sentence}
            {canResumeTimed ? ' still to fund' : ''}
          </span>
          <span className="hint">{capReason(perTickCap)}</span>
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
