import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import Sequence from '../components/Sequence.jsx';
import ResultPanel from '../components/ResultPanel.jsx';
import { plural } from './roles.js';
import V3TreasuryPanel from './V3TreasuryPanel.jsx';
import V3BundlePanel from './V3BundlePanel.jsx';
import V3MainPanel from './V3MainPanel.jsx';
import V3ChainPanel from './V3ChainPanel.jsx';
import V3ExitPanel from './V3ExitPanel.jsx';
import V3SweepPanel from './V3SweepPanel.jsx';

/**
 * The V3 tab, whole.
 *
 * It owns all of its own state and shares none with the v1/v2 tree beside it.
 * That is the isolation rule expressed in the console: App renders one or the
 * other, this component holds V3's wallets, its token and its running job, and
 * nothing it does can change what the other tab is drawing.
 *
 * SIX STEPS, AND WHY THERE IS NO LAUNCH AMONG THEM. V3 is not a launcher. It
 * takes a token that is already live — launched here on another tab, by a
 * wallet this account holds — and distributes a position across bundle wallets
 * one at a time. The launch belongs to whichever tab made it.
 *
 * The steps are drawn through the same Sequence and Step components the other
 * tabs use. Those are presentation: they decide how a procedure looks, never
 * what a launcher spends, so sharing them costs nothing and keeps one console
 * rather than two that happen to sit in the same page.
 */
export default function V3Console({ health, credential, report, output, reportedAt }) {
  const [wallets, setWallets] = useState({ treasury: null, main: null, bundle: [], running: false });
  const [job, setJob] = useState(null);
  const [token, setToken] = useState('');

  const explorer = health?.explorer || '';

  const loadWallets = useCallback(async () => {
    try {
      setWallets(await api('/v3/wallets'));
    } catch (err) {
      report(`ERROR: ${err.message}`);
    }
  }, [report]);

  const loadJob = useCallback(async () => {
    try {
      setJob(await api('/v3/chain'));
    } catch {
      // A job read failing is not worth a toast — the panel shows its own state
      // and the next poll will answer.
    }
  }, []);

  useEffect(() => {
    if (!credential) return undefined;
    loadWallets();
    loadJob();
    return undefined;
  }, [credential, loadWallets, loadJob]);

  // While a run is going, the whole tab is live: the wallet balances move every
  // cycle, so polling only the chain panel would leave the tables stale exactly
  // when they are most interesting.
  useEffect(() => {
    if (!credential || !job?.running) return undefined;
    const t = setInterval(() => {
      loadJob();
      loadWallets();
    }, 2000);
    return () => clearInterval(t);
  }, [credential, job?.running, loadJob, loadWallets]);

  const bundle = wallets.bundle || [];
  const funded = bundle.filter((w) => Number(w.balanceEth) > 0).length;
  // Every V3 wallet the backup would write, for the count on the confirm dialog.
  const backupCount = [wallets.treasury, wallets.main, ...bundle].filter(Boolean).length;

  /**
   * The order of work, and where in it the operator is standing.
   *
   * Same rules the v1/v2 sequence uses: exactly one step is `now` — the first
   * that is not done and whose predecessor is — and `later` is a statement
   * about order, never a permission. Nothing below is disabled by it.
   */
  const steps = useMemo(() => {
    const plan = [
      {
        key: 'treasury',
        n: 1,
        title: 'Create treasury wallet',
        done: Boolean(wallets.treasury),
        detail: wallets.treasury
          ? `${Number(wallets.treasury.balanceEth).toFixed(4)} ETH`
          : 'it funds the main wallet and pays for nothing else',
      },
      {
        key: 'bundle',
        n: 2,
        title: 'Generate bundle wallets',
        done: bundle.length > 0,
        detail: bundle.length
          ? `${plural(bundle.length, 'wallet')} · ${plural(bundle.length, 'cycle')} · ${funded} funded`
          : 'how many pieces the position is cut into',
      },
      {
        key: 'main',
        n: 3,
        title: 'Fund the main wallet',
        done: Boolean(wallets.main) && Number(wallets.main.balanceEth) > 0,
        detail: wallets.main
          ? `${Number(wallets.main.balanceEth).toFixed(4)} ETH · buys big, then sells to fund the rest`
          : 'the wallet that holds the position and does every sell',
      },
      {
        key: 'chain',
        n: 4,
        title: 'Run the chain',
        done: job?.status === 'complete',
        detail:
          job && job.status !== 'idle'
            ? `${job.status} · ${job.completed}/${job.total} wallet(s) bought`
            : 'one big buy, then sell, transfer and buy per wallet',
      },
      {
        key: 'exit',
        n: 5,
        title: 'Sell everything',
        // No done state: selling empties the list, which is the list you have
        // before you have bought anything.
        done: false,
        detail: 'out of every bundle wallet and the main wallet too',
      },
      {
        key: 'sweep',
        n: 6,
        title: 'Sweep the ETH home',
        // Same reasoning as the exit: an empty set of wallets is both "swept"
        // and "never run", so there is nothing honest to mark done.
        done: false,
        detail: 'through Relay, so the sweep does not link the buyers',
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
        id: `v3-step-${s.n}`,
        state,
        chip: state === 'done' ? 'done' : state === 'now' ? 'now' : 'later',
        wait:
          state === 'later' && blocked
            ? `Waits on step ${waitsOn} — ${plan[waitsOn - 1].title.toLowerCase()} first.`
            : null,
      };
    });
  }, [wallets, bundle, funded, job]);

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

      <V3TreasuryPanel
        step={step('treasury')}
        wallet={wallets.treasury}
        explorer={explorer}
        reload={loadWallets}
        report={report}
        locked={Boolean(job?.running)}
      />

      <V3BundlePanel
        step={step('bundle')}
        wallets={bundle}
        explorer={explorer}
        reload={loadWallets}
        report={report}
        locked={Boolean(job?.running)}
        backupCount={backupCount}
      />

      <V3MainPanel
        step={step('main')}
        wallet={wallets.main}
        treasury={wallets.treasury}
        token={token}
        explorer={explorer}
        reload={loadWallets}
        report={report}
        locked={Boolean(job?.running)}
      />

      <V3ChainPanel
        step={step('chain')}
        wallets={bundle}
        job={job}
        token={token}
        setToken={setToken}
        explorer={explorer}
        reload={loadJob}
        reloadWallets={loadWallets}
        report={report}
      />

      {/* The console's answer, between the run and the exit because that is
          where it falls. Unnumbered — a readout, not a sixth step. */}
      <ResultPanel
        step={{
          id: 'v3-readout',
          title: 'Result',
          state: 'readout',
          chip: reportedAt ? `updated ${reportedAt}` : null,
          railDone: step('chain')?.state === 'done',
        }}
        output={output}
      />

      <V3ExitPanel
        step={step('exit')}
        token={token}
        setToken={setToken}
        explorer={explorer}
        reload={loadWallets}
        report={report}
        locked={Boolean(job?.running)}
      />

      <V3SweepPanel
        step={{ ...step('sweep'), last: true }}
        explorer={explorer}
        reload={loadWallets}
        report={report}
        locked={Boolean(job?.running)}
      />
    </div>
  );
}
