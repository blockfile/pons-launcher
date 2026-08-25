import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import Sequence from '../components/Sequence.jsx';
import ResultPanel from '../components/ResultPanel.jsx';
import { plural, eth } from './roles.js';
import V5LauncherWalletPanel from './V5LauncherWalletPanel.jsx';
import V5WalletsPanel from './V5WalletsPanel.jsx';
import V5FundPanel from './V5FundPanel.jsx';
import V5LaunchPanel from './V5LaunchPanel.jsx';
import V5BundlePanel from './V5BundlePanel.jsx';
import V5SellPanel from './V5SellPanel.jsx';
import V5SweepPanel from './V5SweepPanel.jsx';
import V5LauncherPanel from './V5LauncherPanel.jsx';

/**
 * The v5 tab, whole — the letscash.fun (CashCat) bundler.
 *
 * It owns all of its own state and shares none with the v1/v2/v3/v4 consoles.
 * App renders one or the other; this component holds v5's launcher and bundle
 * wallets, and nothing it does can change what another tab is drawing.
 *
 * Six numbered steps — Create launcher wallet, Bundle wallets, Fund (Relay,
 * 8–9s apart), Launch + bundle, Sell, Sweep — mirroring the pons v1 Launcher
 * tab's flow (its own step for the launcher wallet; launch and bundle as one
 * action). Two unnumbered utilities follow: the manual Bundle tools (fan-out /
 * extra buys / recovery) and the Launcher rescue.
 */

export default function V5Console({ health, credential, report, output, reportedAt }) {
  const [dev, setDev] = useState(null);
  const [bundle, setBundle] = useState([]);
  const [config, setConfig] = useState(null);
  // The per-wallet fund/buy sizing, owned here so the Wallets table (which writes
  // it), the Fund step, and the Launch + bundle step all read the SAME values —
  // the shape the v1 Launcher tab keeps in App.jsx. Keyed by walletId:
  // { [walletId]: { fund, mode, buy } }.
  const [rows, setRows] = useState({});
  const setRow = useCallback((id, patch) => {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }, []);
  // The live launch menu (GET /v5/launch/configs) — the picker's source, plus
  // launchEnabled/launchFeeWei. Heavier than /v5/config (it walks the on-chain
  // config range), so it is its own load rather than folded into loadConfig.
  const [launchConfigs, setLaunchConfigs] = useState(null);
  // The last launch response this session has seen, confirmed or not — enough
  // to give the Launch step a real `done` state and a one-line detail, the same
  // way App.jsx's own step 5 reads `history.length > 0` rather than tracking
  // nothing at all. Not persisted: a reload of the page forgets it, same as
  // every other piece of state here.
  const [lastLaunch, setLastLaunch] = useState(null);

  // The explorer base comes with the v5 config; fall back to the health readout,
  // which carries the same value, so a slow config fetch does not blank the links.
  const explorer = config?.explorerUrl || health?.explorer || '';
  // Same computation App.jsx makes for the pons consoles: dry-run unless the
  // server says otherwise. v5's own money paths (fund, launch) read this to
  // decide whether an Arm switch and a vermilion confirmation stand between a
  // click and a real spend.
  const live = Boolean(health && !health.dryRun);

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

  const loadLaunchConfigs = useCallback(async () => {
    try {
      setLaunchConfigs(await api('/v5/launch/configs'));
    } catch (err) {
      say.current(`ERROR: ${err.message}`);
    }
  }, []);

  useEffect(() => {
    if (!credential) return undefined;
    loadConfig();
    loadWallets();
    loadLaunchConfigs();
    return undefined;
  }, [credential, loadConfig, loadWallets, loadLaunchConfigs]);

  /**
   * The order of work, and where in it the operator is standing.
   *
   * Same rules the v1/v2/v3/v4 sequences use: exactly one step is `now` — the
   * first that is not done and whose predecessor is — and `later` is a statement
   * about order, never a permission — see Step.jsx: every control below stays
   * live regardless of which step is marked current. Bundle, Sell and Sweep
   * have no session-held "last result" the way Launch keeps `lastLaunch`, so
   * none of them claims `done` here — the marker rests on whichever of
   * Wallets, Fund or Launch is the first not yet true.
   */
  const steps = useMemo(() => {
    const plan = [
      {
        key: 'launcher',
        n: 1,
        title: 'Create launcher wallet',
        done: Boolean(dev),
        detail: dev ? `launcher · ${eth(dev.balanceEth)} ETH` : 'the wallet that signs the launch + first buy, and funds the bundle',
      },
      {
        key: 'wallets',
        n: 2,
        title: 'Bundle wallets',
        done: bundle.length > 0,
        detail: bundle.length ? plural(bundle.length, 'bundle wallet') : 'the wallets that buy behind the launch',
      },
      {
        key: 'fund',
        n: 3,
        title: 'Fund',
        // At least one bundle wallet holding ETH is what "started funding" means.
        done: bundle.some((w) => Number(w.balanceEth) > 0),
        detail: 'Relay-fund the bundle wallets, 8–9s apart',
      },
      {
        key: 'launch',
        n: 4,
        title: 'Launch + bundle',
        done: Boolean(lastLaunch),
        detail: lastLaunch
          ? `${lastLaunch.plan?.params?.symbol || lastLaunch.token || '—'} · ${
              lastLaunch.launch?.status || (lastLaunch.pending ? 'pending' : '—')
            }`
          : 'launch, then every bundle wallet buys — one action',
      },
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
  }, [dev, bundle, lastLaunch]);

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

      <V5LauncherWalletPanel
        step={step('launcher')}
        dev={dev}
        explorer={explorer}
        reload={loadWallets}
        report={report}
      />

      <V5WalletsPanel
        step={step('wallets')}
        dev={dev}
        bundle={bundle}
        explorer={explorer}
        reload={loadWallets}
        report={report}
        rows={rows}
        setRow={setRow}
      />

      <V5FundPanel
        step={step('fund')}
        dev={dev}
        bundle={bundle}
        live={live}
        explorer={explorer}
        reload={loadWallets}
        report={report}
        rows={rows}
        setRow={setRow}
      />

      <V5LaunchPanel
        step={step('launch')}
        dev={dev}
        bundle={bundle}
        launchConfigs={launchConfigs}
        live={live}
        explorer={explorer}
        reload={loadWallets}
        report={report}
        onLaunched={setLastLaunch}
        rows={rows}
      />

      {/* The console's answer, between Launch and Sell — the same place the v1
          Launcher tab puts it (App.jsx). You launch, read this, then decide to
          sell. Unnumbered: a readout, not a step. */}
      <ResultPanel
        step={{
          id: 'v5-readout',
          title: 'Result',
          state: 'readout',
          chip: reportedAt ? `updated ${reportedAt}` : null,
          railDone: step('launch')?.state === 'done',
        }}
        output={output}
      />

      <V5SellPanel
        step={step('sell')}
        dev={dev}
        bundle={bundle}
        lastLaunch={lastLaunch}
        live={live}
        explorer={explorer}
        reload={loadWallets}
        report={report}
      />

      <V5SweepPanel
        step={step('sweep')}
        dev={dev}
        bundle={bundle}
        lastLaunch={lastLaunch}
        live={live}
        explorer={explorer}
        reload={loadWallets}
        report={report}
      />

      {/* Not one of the numbered steps — the combined step 3 already launches
          AND buys the bundle. This is the MANUAL bundle: the untaxed fan-out,
          topping up with extra per-wallet buys, or firing the bundle by hand
          when a combined run confirmed the launch but skipped the buys
          (bundleSkipped). Unnumbered and rendered here, after the flow, so the
          step-by-step operator never has to choose between two "bundle" steps. */}
      <V5BundlePanel
        step={{
          id: 'v5-bundle-tools',
          n: null,
          label: 'Utility',
          title: 'Bundle tools — untaxed fan-out',
          state: 'later',
          chip: null,
        }}
        dev={dev}
        bundle={bundle}
        lastLaunch={lastLaunch}
        live={live}
        explorer={explorer}
        reload={loadWallets}
        report={report}
      />

      {/* Not one of the numbered steps — a folded-away utility for the launcher's own
          value-OUT path (withdraw, and clearing a stuck tx). Last on the
          page, deliberately outside the numbered flow: see its own header
          comment for why it forces itself open when the launcher is stuck. */}
      <V5LauncherPanel
        dev={dev}
        lastLaunch={lastLaunch}
        live={live}
        explorer={explorer}
        reload={loadWallets}
        report={report}
      />
    </div>
  );
}
