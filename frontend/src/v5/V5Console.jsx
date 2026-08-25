import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import Sequence from '../components/Sequence.jsx';
import Step from '../components/Step.jsx';
import ResultPanel from '../components/ResultPanel.jsx';
import { plural } from './roles.js';
import V5WalletsPanel from './V5WalletsPanel.jsx';

/**
 * The v5 tab, whole — the letscash.fun (CashCat) bundler.
 *
 * It owns all of its own state and shares none with the v1/v2/v3/v4 consoles.
 * App renders one or the other; this component holds v5's launcher and bundle
 * wallets, and nothing it does can change what another tab is drawing.
 *
 * SCAFFOLDING PHASE. Only the wallets step works. Fund, Launch, Bundle, Sell and
 * Sweep are drawn as the steps they will be so the flow reads end-to-end, but
 * each is a stub until its own fund-safety review lands.
 */

/**
 * A later step, drawn but not yet built. Titled and threaded onto the spine so
 * the sequence reads whole, with one line saying it is not here yet.
 */
function Stub({ step, children }) {
  return (
    <Step {...step}>
      <p className="lede">{children}</p>
      <div className="notice">
        <h3>Coming soon</h3>
        <p>This step is scaffolding — the controls arrive in a later phase.</p>
      </div>
    </Step>
  );
}

export default function V5Console({ health, credential, report, output, reportedAt }) {
  const [dev, setDev] = useState(null);
  const [bundle, setBundle] = useState([]);
  const [config, setConfig] = useState(null);

  // The explorer base comes with the v5 config; fall back to the health readout,
  // which carries the same value, so a slow config fetch does not blank the links.
  const explorer = config?.explorerUrl || health?.explorer || '';

  /**
   * `report`, held still — App rebuilds its `report` closure every render, so a
   * loader closing over it directly would change identity every render and
   * re-fire the mount effect that lists the loaders. The ref keeps the loaders
   * stable and still reports through whatever `report` currently is. Same guard
   * V4Console keeps, and for the same reason.
   */
  const say = useRef(report);
  say.current = report;

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await api('/v5/config'));
    } catch {
      // The wallet reads carry the tab; a config that will not load leaves the
      // explorer links plain rather than surfacing an error of its own.
    }
  }, []);

  const loadWallets = useCallback(async () => {
    try {
      const out = await api('/v5/wallets');
      setDev(out.dev || null);
      setBundle(out.bundle || []);
    } catch (err) {
      say.current(`ERROR: ${err.message}`);
    }
  }, []);

  useEffect(() => {
    if (!credential) return undefined;
    loadConfig();
    loadWallets();
    return undefined;
  }, [credential, loadConfig, loadWallets]);

  /**
   * The order of work, and where in it the operator is standing.
   *
   * Same rules the v1/v2/v3/v4 sequences use: exactly one step is `now` — the
   * first that is not done and whose predecessor is — and `later` is a statement
   * about order, never a permission. The five stub steps are never done, so once
   * the wallets exist the marker rests on Fund and the rest read as later.
   */
  const steps = useMemo(() => {
    const plan = [
      {
        key: 'wallets',
        n: 1,
        title: 'Wallets',
        done: Boolean(dev) && bundle.length > 0,
        detail: !dev
          ? 'a launcher signs the launch; bundle wallets take the first buy'
          : bundle.length
            ? `launcher · ${plural(bundle.length, 'bundle wallet')}`
            : 'launcher ready — generate the bundle wallets it feeds',
      },
      { key: 'fund', n: 2, title: 'Fund', done: false, detail: 'ETH into the launcher and bundle wallets' },
      { key: 'launch', n: 3, title: 'Launch', done: false, detail: 'the letscash launch and its atomic first buy' },
      { key: 'bundle', n: 4, title: 'Bundle', done: false, detail: 'fan the first-buy supply out to the bundle' },
      { key: 'sell', n: 5, title: 'Sell', done: false, detail: 'unwind the bundle back to ETH' },
      { key: 'sweep', n: 6, title: 'Sweep', done: false, detail: 'collect what is left to one wallet' },
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
        id: `v5-step-${s.n}`,
        state,
        chip: state === 'done' ? 'done' : state === 'now' ? 'now' : 'later',
        wait:
          state === 'later' && blocked
            ? `Waits on step ${waitsOn} — ${plan[waitsOn - 1].title.toLowerCase()} first.`
            : null,
      };
    });
  }, [dev, bundle]);

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

      <V5WalletsPanel
        step={step('wallets')}
        dev={dev}
        bundle={bundle}
        explorer={explorer}
        reload={loadWallets}
        report={report}
      />

      {/* The console's answer, between the wallets and the later steps because
          that is where it falls — the last thing a button here returned.
          Unnumbered: a readout, not a step. */}
      <ResultPanel
        step={{
          id: 'v5-readout',
          title: 'Result',
          state: 'readout',
          chip: reportedAt ? `updated ${reportedAt}` : null,
          railDone: step('wallets')?.state === 'done',
        }}
        output={output}
      />

      <Stub step={step('fund')}>
        ETH goes into the launcher and the bundle wallets before anything launches.
      </Stub>
      <Stub step={step('launch')}>
        The letscash launch fires with its atomic, unfront-runnable first buy into the launcher.
      </Stub>
      <Stub step={step('bundle')}>
        The first-buy supply is fanned out to the bundle wallets — token transfers are untaxed on
        letscash.
      </Stub>
      <Stub step={step('sell')}>
        The bundle unwinds its position back to ETH.
      </Stub>
      <Stub step={{ ...step('sweep'), last: true }}>
        Whatever is left is collected to a single wallet.
      </Stub>
    </div>
  );
}
