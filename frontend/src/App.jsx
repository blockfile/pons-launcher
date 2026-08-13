import { useCallback, useEffect, useMemo, useState } from 'react';
import { LazyMotion, MotionConfig, domMax } from 'framer-motion';
import { api, getApiKey, setApiKey } from './api.js';
// The console and the backend's preflight run the SAME arithmetic, out of one
// file neither of them owns — see shared/bundleShare.js for why, and
// vite.config.js for how a CommonJS module gets into this bundle. Default
// import because that file is CommonJS: the backend requires it directly.
import bundleShareModule from '../../shared/bundleShare.js';
import Guide from './components/Guide.jsx';
import Sequence from './components/Sequence.jsx';
import DevWalletPanel from './components/DevWalletPanel.jsx';
import WalletsPanel from './components/WalletsPanel.jsx';
import FundPanel from './components/FundPanel.jsx';
import DispersersPanel from './components/DispersersPanel.jsx';
import LaunchForm from './components/LaunchForm.jsx';
import ResultPanel from './components/ResultPanel.jsx';
import SellPanel from './components/SellPanel.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';
import ActivityPanel from './components/ActivityPanel.jsx';
import BundlerV2Panel from './components/BundlerV2Panel.jsx';

const { bundleShare } = bundleShareModule;

const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-4)}` : '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const andList = (xs) =>
  xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

// What a launch cannot be armed without, in the order step 5 asks for it, and
// how the sequence names each one when it is not there yet.
const DRAFT_FIELDS = [
  ['name', 'a name'],
  ['symbol', 'a symbol'],
  ['logo', 'a logo'],
];

/**
 * The animation feature set, declared once for the whole console.
 *
 * domMax is the smallest set that still carries layout animation, which the
 * marker travelling between stations needs — nothing in CSS can move an element
 * between two different parents. It is also the expensive half of the library:
 * dropping to domAnimation, and with it the travelling marker, is worth about
 * 47 kB, and dropping animation altogether about 131 kB. Everything on this page
 * is legible without a single frame of movement, so that trade is available at
 * any time; it is spent here on the one thing static styling cannot say, which
 * is that progress through a procedure is travel and not a jump.
 */
const animation = domMax;

export default function App() {
  // Which strategy is on screen. Not persisted: v1 is the one that has been
  // used for every launch to date, so a reload lands on it rather than on
  // whatever was open last.
  const [mode, setMode] = useState('v1');
  const [health, setHealth] = useState(null);
  const [wallets, setWallets] = useState([]);
  const [configs, setConfigs] = useState(null);
  const [history, setHistory] = useState([]);
  const [output, setOutput] = useState('Connecting…');
  // Seeded from the key api.js restored out of sessionStorage, so a refresh
  // finds the field already filled and every panel below already entitled to
  // read — see the note in api.js for why sessionStorage and not localStorage.
  const [key, setKey] = useState(getApiKey);
  // The three facts step 5 cannot be armed without — name, symbol and a logo
  // pinned to IPFS — handed up by LaunchForm as they are typed. They used to be
  // a row on the checklist above the console; when the six steps replaced it,
  // the logo half of this survived as state with a writer and no reader. Step 5
  // states them now, which is where an operator looks for them.
  const [draft, setDraft] = useState(null);
  // Per-wallet fund / buy-mode / buy-amount, keyed by wallet id. Lifted here
  // because both the Fund and Launch panels read the same rows.
  const [rows, setRows] = useState({});
  // What the launch is shaped like — protocol, the chosen launch config, the
  // dev buy, the creator tax. It is typed in step 5 but it decides what step 3's
  // amounts BUY, so LaunchForm pushes it up here the way it already pushes the
  // logo up for the sequence.
  const [sizing, setSizing] = useState(null);
  // What steps 2 and 6 found, handed up by the panels that already fetched it.
  // The strip at the top of the page states every step's state, and it must not
  // do that by making the same two requests a second time.
  const [dispersers, setDispersers] = useState(null);
  const [sellable, setSellable] = useState(null);

  const setRow = (id, patch) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));

  /**
   * What every bundle amount currently on screen would take of the supply.
   *
   * Computed here rather than in either panel because both read it: the wallet
   * table puts a figure on each row as it is typed, and the arm bar states the
   * total next to the button. Client-side because it has to answer between
   * keystrokes — see shared/bundleShare.js, which is the same module preflight
   * runs, so the live figure and the warning that stops a launch cannot come
   * from two implementations.
   *
   * Every input comes from the live factory configs the panels already fetched.
   * Nothing here is hardcoded: the owner can change supply, caps, the phantom
   * reserve or the graduation threshold between one launch and the next, and a
   * console that remembered last week's numbers would be confidently wrong.
   */
  const share = useMemo(() => {
    if (!sizing?.launchConfig) return null;
    return bundleShare({
      protocol: sizing.protocol,
      launchConfig: sizing.launchConfig,
      creatorTaxBps: sizing.creatorTaxBps,
      devBuyEth: sizing.devBuyEth,
      // Table order is firing order — prepare() walks the same list the same
      // way — and on a curve the order is the price, so it has to match.
      buys: wallets
        .filter((w) => w.role !== 'dev')
        .map((w) => ({
          key: w.id,
          // "all − gas" is resolved server-side from the live balance. The
          // balance is its ceiling and gas is a rounding error beside a buy,
          // so the row is shown rather than left blank — flagged as an
          // approximation in the summary under the table.
          amountEth: rows[w.id]?.mode === 'all' ? w.balanceEth : rows[w.id]?.buy,
        })),
    });
  }, [sizing, wallets, rows]);

  // Strings stay strings so errors read as errors; everything else is a payload
  // for ResultPanel to lay out.
  //
  // Nothing here moves the viewport. Reporting used to reveal as well — the
  // readout scrolled itself into view on every answer — and being thrown to the
  // bottom of the page mid-step is worse than having to look for the answer,
  // most of all during a launch. So the only thing carried alongside the payload
  // is WHEN it arrived: the readout puts it in the chip on its own header, which
  // is how a still panel says it has something new without moving anything.
  const [reportedAt, setReportedAt] = useState('');
  const report = (v) => {
    setOutput(v);
    setReportedAt(new Date().toLocaleTimeString());
  };

  const loadWallets = useCallback(async () => setWallets(await api('/wallets')), []);
  const loadHistory = useCallback(async () => setHistory(await api('/launches?limit=15')), []);

  const loadAll = useCallback(async () => {
    try {
      setHealth(await api('/health'));
      await loadWallets();
      setConfigs(await api('/configs'));
      await loadHistory();
      setOutput('Ready. Run Preflight when the sequence above is complete.');
    } catch (err) {
      setOutput(`ERROR: ${err.message}`);
    }
  }, [loadWallets, loadHistory]);

  // Re-read everything when the key changes: the key decides not just what you
  // may do but what you can see, so a new key means a different console.
  // Debounced because this fires on every keystroke of a pasted key.
  useEffect(() => {
    const t = setTimeout(loadAll, key ? 400 : 0);
    return () => clearTimeout(t);
  }, [loadAll, key]);

  const live = Boolean(health && !health.dryRun);
  const funded = wallets.filter((w) => w.role !== 'dev' && Number(w.balanceEth) > 0).length;

  // Whether this console may read at all, and what it re-reads on. It is not
  // the key: a deployment that injects the key at nginx (the map block in
  // deploy/nginx-rhbond.conf) never puts one in the browser, and health comes
  // back with `user` set instead; a deployment with no key configured needs
  // nothing at all. The panels below key their reloads on this string, so it
  // has to change when the identity changes and be truthy whenever the console
  // is entitled — otherwise they hide their own errors as "no key yet".
  const credential =
    key || health?.user || (health && !health.apiKeyRequired ? 'open' : '');

  // Only ask for a key when one is actually missing. If nginx supplies it, or
  // the deployment has none, the field is not a prompt — it is a lie.
  const needsKey = Boolean(health && health.apiKeyRequired && !health.user);

  /**
   * The order of work, and where in it the operator is standing.
   *
   * Six steps, and the state of each derived from what is actually true right
   * now rather than from anything this component remembers. Exactly one step is
   * `now`: the first that is not done and whose predecessor is. Everything after
   * it is `later` and says which step it is waiting on.
   *
   * `later` is a statement about ORDER, not permission. Nothing below is
   * disabled by it: an operator who wants to generate bundle wallets before a
   * dev wallet exists is allowed to, and the console's job is to say what the
   * sequence expects, not to hold the keys hostage to it.
   *
   * Step 2 is the exception: the backend uses individual transfers below the
   * batching threshold regardless, so it is genuinely optional and never makes
   * a later step wait. Marking it required would be the console lying about the
   * code underneath it.
   *
   * Step 6 has no done state. Selling everything empties the list, which is the
   * same list you have before you have launched anything, so "done" would be
   * indistinguishable from "not started".
   */
  const steps = useMemo(() => {
    const dev = wallets.find((w) => w.role === 'dev');
    const bundle = wallets.filter((w) => w.role === 'bundle');
    const activeDispersers = dispersers?.addresses?.length ?? 0;
    const threshold = dispersers?.batchThreshold;
    const sellCount = Array.isArray(sellable) ? sellable.length : 0;
    const last = history[0];
    const launched = history.length > 0;
    // What step 5 is still missing, in the order the form asks for it. `done`
    // stays "has launched" — a filled-in form is not a launch — so this rides
    // on the detail line, which is where every other step says what it is
    // waiting for.
    const missing = DRAFT_FIELDS.filter(([k]) => !draft?.[k]).map(([, label]) => label);

    const plan = [
      {
        n: 1,
        title: 'Create dev wallet',
        done: Boolean(dev),
        detail: dev
          ? `${short(dev.address)} · ${Number(dev.balanceEth).toFixed(4)} ETH`
          : 'it signs the launch and pays for everything',
      },
      {
        n: 2,
        title: 'Deploy disperser contract',
        optional: true,
        done: activeDispersers > 0,
        needs: dev ? 0 : 1,
        detail: activeDispersers
          ? `${plural(activeDispersers, 'contract')} in use${threshold ? ` · batches ${threshold}+ recipients` : ''}`
          : 'without one, funding sends one transfer per wallet',
      },
      {
        n: 3,
        title: 'Generate bundle wallets',
        done: bundle.length > 0,
        detail: bundle.length
          ? `${plural(bundle.length, 'wallet')} · ${funded} funded`
          : 'each buys behind the dev buy, capped at 5%',
      },
      {
        n: 4,
        title: 'Fund bundle wallets',
        done: funded > 0,
        detail: bundle.length
          ? `${funded} of ${bundle.length} hold ETH`
          : 'ETH out of the dev wallet, one row each',
      },
      {
        n: 5,
        title: 'Launch + bundle',
        done: launched,
        detail: last
          ? `${last.params?.symbol || short(last.token)} · ${
              (last.buys || []).filter((b) => b.status === 'confirmed').length
            }/${(last.buys || []).length} filled${last.dryRun ? ' · dry run' : ''}`
          : // Nothing typed yet is not a shortfall — it is the state every run
            // starts in — so the step says what it is for rather than listing
            // three things the operator has not had a chance to do.
            missing.length === DRAFT_FIELDS.length
            ? 'the dev buy runs inside the launch itself'
            : missing.length
              ? `still needs ${andList(missing)}`
              : 'name, symbol and logo ready',
      },
      {
        n: 6,
        title: 'Sell everything',
        done: false,
        detail: sellCount
          ? `${plural(sellCount, 'token')} your bundle still holds`
          : 'nothing your bundle holds is sellable yet',
      },
    ];

    // The chain of required steps. A step waits on the last required one before
    // it; `needs` set explicitly wins, which is how the optional step still
    // says it cannot be paid for before there is a dev wallet.
    let previousRequired = null;
    let claimed = false;
    return plan.map((s) => {
      const waitsOn = s.needs === 0 ? null : (s.needs ?? previousRequired);
      const blocked = waitsOn != null && !plan[waitsOn - 1].done;
      if (!s.optional) previousRequired = s.done ? null : s.n;

      // `done` outranks everything: deleting every bundle wallet after a launch
      // must not un-launch step 5.
      let state = 'later';
      if (s.done) state = 'done';
      else if (!blocked && !s.optional && !claimed) {
        state = 'now';
        claimed = true;
      }

      return {
        ...s,
        id: `step-${s.n}`,
        state,
        // A blocked optional step is not "optional" yet — it cannot be run at
        // all — so it reads as later, and only says optional once it could be
        // done and is being passed over.
        chip:
          state === 'done'
            ? 'done'
            : state === 'now'
              ? 'now'
              : s.optional && !blocked
                ? 'optional'
                : 'later',
        wait:
          state === 'later' && blocked
            ? `Waits on step ${waitsOn} — ${plan[waitsOn - 1].title.toLowerCase()} first.`
            : state === 'later' && s.optional
              ? 'Optional. Skipping it costs nothing until the bundle is large enough to batch.'
              : null,
      };
    });
  }, [wallets, funded, dispersers, sellable, history, draft]);

  // The step whose panel is drawn where, so a panel never has to know its own
  // number and the order lives in one place — this file, in render order below.
  const step = (n) => steps[n - 1];

  return (
    // reducedMotion="user" hands the whole question to the operating system:
    // every layout and transform animation below is switched off when the
    // machine asks for it, without each component checking. `strict` refuses
    // the full motion component outright, so the heavy import cannot creep back
    // in unnoticed the next time something needs animating.
    <LazyMotion features={animation} strict>
      <MotionConfig reducedMotion="user">
        <header className={`strip ${live ? 'is-live' : ''}`}>
          <h1 className="mark">
            pons<b>·</b>launcher
          </h1>

          {health && (
            <div className="readout">
              <span>
                chain <b>{health.chainId}</b>
              </span>
              {health.multiUser && (
                <span>
                  signed in as <b>{health.user || 'nobody'}</b>
                </span>
              )}
            </div>
          )}

          <div className={`mode ${!health ? '' : live ? 'live' : 'dry'}`}>
            {!health ? 'connecting' : live ? 'live · spends real funds' : 'dry run · broadcasts nothing'}
          </div>

          {needsKey && (
            <>
              <input
                type="password"
                placeholder="API key"
                autoComplete="off"
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setApiKey(e.target.value);
                }}
              />
              {/* A key that survives a refresh needs a way out that is not
                  "close every tab" — a shared screen is the usual reason. */}
              {key && (
                <button
                  className="link"
                  title="clear the key from this tab"
                  onClick={() => {
                    setKey('');
                    setApiKey('');
                  }}
                >
                  forget
                </button>
              )}
            </>
          )}

          {/* Multi-user deployments proxy through nginx, which overwrites this
              field's header with the key mapped to your login — if that map is
              missing an entry, the key you paste here is silently ignored. */}
          {health && health.multiUser && !health.user && (
            <div className="hint">not signed in — nginx may be swallowing the key field; ask whoever runs this deployment to check the login map</div>
          )}
        </header>

        <main>
          {/* Two strategies against the same factory, not two versions of one.
              V1 arms a bundle and fires it the moment trading opens; V2 launches
              with no dev buy and buys once, later, through a contract. Their
              steps do not line up and the mistake that ruins each is different,
              so they get separate tabs rather than a shared sequence with a
              mode switch — a control that is correct in one and dangerous in the
              other is worse than two screens. */}
          <div className="row" style={{ marginBottom: 12 }}>
            <button
              type="button"
              className={mode === 'v1' ? '' : 'ghost'}
              onClick={() => setMode('v1')}
            >
              V1 bundler
            </button>
            <button
              type="button"
              className={mode === 'v2' ? '' : 'ghost'}
              onClick={() => setMode('v2')}
            >
              V2 bundler
            </button>
            <span className="spacer" />
            <span className="hint">
              {mode === 'v1'
                ? 'dev buy, then a bundle at the open block'
                : 'no dev buy, then one contract buy after the snipers exit'}
            </span>
          </div>

          {mode === 'v2' && (
            <BundlerV2Panel
              explorer={health?.explorer || ''}
              credential={credential}
              report={report}
              wallets={wallets}
              configs={configs}
              reload={loadWallets}
            />
          )}

          <div hidden={mode !== 'v1'}>
          <Sequence
            steps={steps}
            notice={
              !health
                ? 'Connecting to the server…'
                : needsKey && !key
                  ? 'Paste the API key in the top bar — without it the console can neither read nor spend.'
                  : null
            }
          />
          <Guide />

          <DevWalletPanel
            step={step(1)}
            wallets={wallets}
            explorer={health?.explorer || ''}
            reload={loadWallets}
            report={report}
          />
          <DispersersPanel
            step={step(2)}
            explorer={health?.explorer || ''}
            credential={credential}
            report={report}
            onState={setDispersers}
          />
          <WalletsPanel
            step={step(3)}
            wallets={wallets}
            rows={rows}
            setRow={setRow}
            share={share}
            reload={loadWallets}
            report={report}
          />
          <FundPanel
            step={step(4)}
            wallets={wallets}
            rows={rows}
            dispersers={dispersers}
            reload={loadWallets}
            report={report}
          />
          <LaunchForm
            step={step(5)}
            configs={configs}
            wallets={wallets}
            rows={rows}
            live={live}
            share={share}
            reload={loadWallets}
            reloadHistory={loadHistory}
            report={report}
            onDraft={setDraft}
            onSizing={setSizing}
          />
          {/* The console's answer, between the launch and the exit because that is
              where it falls: you launch, you read this, and only later do you
              decide to sell. Unnumbered — it is a readout, not a seventh step —
              and never jade, because what lands here is as often a revert as a
              confirmation. The spine passing through it is the launch's, so it
              takes its fill from step 5 rather than from its own contents.

              The chip is the whole of the notification: grey, still, and only
              there once an action has actually answered. It replaces a panel
              that used to come and find the operator. */}
          <ResultPanel
            step={{
              id: 'readout',
              title: 'Result',
              state: 'readout',
              chip: reportedAt ? `updated ${reportedAt}` : null,
              railDone: steps[4].state === 'done',
            }}
            output={output}
          />
          <SellPanel
            step={{ ...step(6), last: true }}
            explorer={health?.explorer || ''}
            credential={credential}
            live={live}
            reload={loadWallets}
            report={report}
            onState={setSellable}
          />

          </div>

          {/* Where the sequence stops. Everything below is a record of runs that
              already happened, and the left edge changes to say so. Outside the
              tab: the history and the activity log are the same records whichever
              strategy produced them. */}
          <div className="divider">
            <span>records</span>
          </div>

          <HistoryPanel entries={history} explorer={health?.explorer || ''} />
          {/* `admin` comes from health, which is the server's answer about this
              caller — it decides whether the user selector is drawn at all. The
              backend checks it again on every read; this flag draws controls, it
              does not grant anything. */}
          <ActivityPanel
            explorer={health?.explorer || ''}
            credential={credential}
            admin={Boolean(health?.admin)}
            me={health?.user || ''}
          />
        </main>
      </MotionConfig>
    </LazyMotion>
  );
}
