import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import Sequence from '../components/Sequence.jsx';
import ResultPanel from '../components/ResultPanel.jsx';
import { eth, plural, targetsFor, totalEth } from './roles.js';
import V8MainPanel from './V8MainPanel.jsx';
import V8WalletsPanel from './V8WalletsPanel.jsx';
import V8TransferPanel from './V8TransferPanel.jsx';
import V8SweepPanel from './V8SweepPanel.jsx';

/**
 * The V8 tab, whole — a pure ETH mover.
 *
 * THERE IS NO LAUNCHPAD HERE, and the absence is the design. No launch, no
 * token, no buy, no sell, no curve, no market cap: V8 generates wallets, sends
 * ETH from one source wallet out to many destinations through Relay, and sweeps
 * it back. Every panel that would carry a token address on another tab simply
 * does not exist on this one.
 *
 * It owns all of its own state and shares none with the consoles beside it —
 * App renders one or the other, this component holds V8's wallets and its
 * per-wallet amounts, and nothing it does can change what another tab is
 * drawing. Same branch-not-blend rule as V3 and V6.
 *
 * FOUR STEPS: the source wallet, the destinations, the transfer, the sweep. The
 * Step and Sequence components are shared with every other tab because they are
 * presentation — they decide how a procedure LOOKS, never what it spends — and
 * sharing them keeps one console rather than two that happen to sit in the same
 * page.
 */
export default function V8Console({ health, credential, report, output, reportedAt }) {
  const [main, setMain] = useState(null);
  const [bundle, setBundle] = useState([]);
  // The per-wallet amount typed in step 3, keyed by wallet id: { [id]: { amount } }.
  // Owned here rather than in the panel so the step line above can state what is
  // queued without the panel having to hand it up on every keystroke.
  const [rows, setRows] = useState({});
  const setRow = useCallback((id, patch) => {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);
  // The server-held timed run, handed up by the transfer panel, which is the
  // thing already polling it. The console reads it for the step line and to hold
  // the destructive controls while wallets are still being paid.
  const [job, setJob] = useState(null);

  const explorer = health?.explorer || '';
  // The same computation App makes for every other console: dry run unless the
  // server says otherwise. The confirmations below say which one they are in.
  const live = Boolean(health && !health.dryRun);
  const running = job?.status === 'running';

  /**
   * `report`, held still — App rebuilds its `report` closure every render, so a
   * loader closing over it directly would change identity every render and
   * re-fire the mount effect that lists the loaders. The ref keeps the loaders
   * stable and still reports through whatever `report` currently is. The same
   * guard V4Console and V5Console keep, for the same reason.
   */
  const say = useRef(report);
  say.current = report;

  /**
   * The wallets. Written so a backend that is not up yet — or a route that
   * 404s — leaves the tab drawing its empty states rather than a blank page:
   * the error is reported once and the previous lists are left alone.
   */
  const loadWallets = useCallback(async () => {
    try {
      const out = await api('/v8/wallets');
      setMain(out.main || null);
      setBundle(Array.isArray(out.bundle) ? out.bundle : []);
    } catch (err) {
      say.current(`ERROR: ${err.message}`);
    }
  }, []);

  useEffect(() => {
    if (!credential) return undefined;
    loadWallets();
    return undefined;
  }, [credential, loadWallets]);

  // While a timed run is going the balances move on their own — one wallet per
  // interval, for hours — so the tables have to re-read or they are stale
  // exactly when they are most interesting. Twenty seconds: the run's own status
  // is polled by the transfer panel at ten, and this is the heavier read.
  useEffect(() => {
    if (!credential || !running) return undefined;
    const t = setInterval(loadWallets, 20_000);
    return () => clearInterval(t);
  }, [credential, running, loadWallets]);

  const funded = bundle.filter((w) => Number(w.balanceEth) > 0).length;
  // Every V8 key a backup would write, for the count on the confirm dialog.
  const backupCount = [main, ...bundle].filter(Boolean).length;
  // What step 3 would send if it were pressed now — stated on the step line so
  // the total is readable without scrolling to the panel that owns it.
  const queued = targetsFor(bundle, rows);
  const queuedEth = totalEth(queued);

  /**
   * The order of work, and where in it the operator is standing.
   *
   * Same rules the other consoles' sequences use: exactly one step is `now` —
   * the first that is not done and whose predecessor is — and `later` is a
   * statement about ORDER, never a permission. Nothing below is disabled by it;
   * see Step.jsx.
   */
  const steps = useMemo(() => {
    const plan = [
      {
        key: 'main',
        n: 1,
        title: 'The source wallet',
        done: Boolean(main),
        detail: main
          ? `${eth(main.balanceEth)} ETH · everything sends from here`
          : 'the one wallet the ETH leaves from — funded from outside this console',
      },
      {
        key: 'wallets',
        n: 2,
        title: 'Destination wallets',
        done: bundle.length > 0,
        detail: bundle.length
          ? `${plural(bundle.length, 'wallet')} · ${funded} holding ETH`
          : 'generate, import or claim seasoned ones — no 31-wallet cap here',
      },
      {
        key: 'transfer',
        n: 3,
        title: 'Send through Relay',
        // "At least one destination is holding ETH" is what this step being
        // behind you means. It is deliberately NOT a claim that this console
        // sent it: a wallet claimed out of the V4 pool arrives already funded,
        // and a step that went back to `now` after a claim would be arguing with
        // the operator about a wallet that is demonstrably ready to use.
        done: funded > 0 || job?.status === 'complete',
        detail: running
          ? `timed run going · ${job.completed ?? job.sent ?? 0}/${job.total ?? 0} sent`
          : queued.length
            ? `${queuedEth.toFixed(4)} ETH queued for ${plural(queued.length, 'wallet')}`
            : 'a solver pays each wallet, so nothing on chain links them to the source',
      },
      {
        key: 'sweep',
        n: 4,
        title: 'Sweep it back',
        // No done state: sweeping empties the wallets, which is the same set of
        // balances you have before you have sent anything — so "done" would be
        // indistinguishable from "not started".
        done: false,
        detail: funded
          ? `${plural(funded, 'wallet')} still holding ETH`
          : 'everything back to the source, through Relay again',
      },
    ];

    let previousRequired = null;
    let claimed = false;
    return plan.map((s) => {
      const waitsOn = s.needs ?? previousRequired;
      const blocked = waitsOn != null && !plan[waitsOn - 1].done;
      previousRequired = s.done ? null : s.n;

      let state = 'later';
      if (s.done) state = 'done';
      else if (!blocked && !claimed) {
        state = 'now';
        claimed = true;
      }

      return {
        ...s,
        id: `v8-step-${s.n}`,
        state,
        chip: state === 'done' ? 'done' : state === 'now' ? 'now' : 'later',
        wait:
          state === 'later' && blocked
            ? `Waits on step ${waitsOn} — ${plan[waitsOn - 1].title.toLowerCase()} first.`
            : null,
      };
    });
    // `queued` is rebuilt every render (it is derived from the amounts being
    // typed), so the LENGTH is the dependency — the array's identity would
    // defeat the memo on every keystroke anywhere in the console.
  }, [main, bundle, funded, job, running, queued.length, queuedEth]);

  const step = (key) => steps.find((s) => s.key === key) || null;

  return (
    <div className="sequence">
      <Sequence
        steps={steps}
        notice={
          !health
            ? 'Connecting to the server…'
            : !credential
              ? 'Paste the API key in the top bar — without it the console can neither read nor spend.'
              : null
        }
      />

      <V8MainPanel
        step={step('main')}
        wallet={main}
        explorer={explorer}
        reload={loadWallets}
        report={report}
        locked={running}
        backupCount={backupCount}
      />

      <V8WalletsPanel
        step={step('wallets')}
        wallets={bundle}
        explorer={explorer}
        reload={loadWallets}
        report={report}
        locked={running}
        backupCount={backupCount}
      />

      <V8TransferPanel
        step={step('transfer')}
        main={main}
        bundle={bundle}
        rows={rows}
        setRow={setRow}
        live={live}
        explorer={explorer}
        reload={loadWallets}
        report={report}
        onJob={setJob}
      />

      {/* The console's answer, between the send and the sweep because that is
          where it falls: you send, you read this, and only then do you decide to
          bring it back. Unnumbered — a readout, not a fifth step. */}
      <ResultPanel
        step={{
          id: 'v8-readout',
          title: 'Result',
          state: 'readout',
          chip: reportedAt ? `updated ${reportedAt}` : null,
          railDone: step('transfer')?.state === 'done',
        }}
        output={output}
      />

      <V8SweepPanel
        step={{ ...step('sweep'), last: true }}
        main={main}
        bundle={bundle}
        live={live}
        explorer={explorer}
        reload={loadWallets}
        report={report}
        locked={running}
      />
    </div>
  );
}
