import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, getApiKey, setApiKey } from './api.js';
// The console and the backend's preflight run the SAME arithmetic, out of one
// file neither of them owns — see shared/bundleShare.js for why, and
// vite.config.js for how a CommonJS module gets into this bundle. Default
// import because that file is CommonJS: the backend requires it directly.
import bundleShareModule from '../../shared/bundleShare.js';
import Guide from './components/Guide.jsx';
import Readiness from './components/Readiness.jsx';
import WalletsPanel from './components/WalletsPanel.jsx';
import FundPanel from './components/FundPanel.jsx';
import DispersersPanel from './components/DispersersPanel.jsx';
import LaunchForm from './components/LaunchForm.jsx';
import ResultPanel from './components/ResultPanel.jsx';
import SellPanel from './components/SellPanel.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';
import ActivityPanel from './components/ActivityPanel.jsx';

const { bundleShare } = bundleShareModule;

export default function App() {
  const [health, setHealth] = useState(null);
  const [wallets, setWallets] = useState([]);
  const [configs, setConfigs] = useState(null);
  const [history, setHistory] = useState([]);
  const [output, setOutput] = useState('Connecting…');
  // Seeded from the key api.js restored out of sessionStorage, so a refresh
  // finds the field already filled and every panel below already entitled to
  // read — see the note in api.js for why sessionStorage and not localStorage.
  const [key, setKey] = useState(getApiKey);
  const [logo, setLogo] = useState('');
  // Per-wallet fund / buy-mode / buy-amount, keyed by wallet id. Lifted here
  // because both the Fund and Launch panels read the same rows.
  const [rows, setRows] = useState({});
  // What the launch is shaped like — protocol, the chosen launch config, the
  // dev buy, the creator tax. It is typed in step 3 but it decides what step 1's
  // amounts BUY, so LaunchForm pushes it up here the way it already pushes the
  // logo up for the checklist.
  const [sizing, setSizing] = useState(null);

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
  // Reporting and revealing are two different things. ResultPanel scrolls
  // itself into view when this counter moves, so a panel whose answer is
  // already on screen where the operator is standing can record the outcome
  // without dragging the page down to it — deleting wallets one after another
  // threw the page to the Result panel on every click. Revealing stays the
  // default: for a fund or a launch, the answer is a screen and a half below
  // the button that asked for it.
  const [reveal, setReveal] = useState(0);
  const report = (v, { reveal: bring = true } = {}) => {
    setOutput(v);
    if (bring) setReveal((n) => n + 1);
  };

  const loadWallets = useCallback(async () => setWallets(await api('/wallets')), []);
  const loadHistory = useCallback(async () => setHistory(await api('/launches?limit=15')), []);

  const loadAll = useCallback(async () => {
    try {
      setHealth(await api('/health'));
      await loadWallets();
      setConfigs(await api('/configs'));
      await loadHistory();
      setOutput('Ready. Run Preflight when the checklist above is complete.');
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

  return (
    <>
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
        <Readiness wallets={wallets} funded={funded} logo={logo} health={health} apiKey={key} />
        <Guide />

        <WalletsPanel
          wallets={wallets}
          rows={rows}
          setRow={setRow}
          share={share}
          reload={loadWallets}
          report={report}
        />
        <FundPanel wallets={wallets} rows={rows} reload={loadWallets} report={report} />
        <DispersersPanel explorer={health?.explorer || ''} credential={credential} report={report} />
        <LaunchForm
          configs={configs}
          wallets={wallets}
          rows={rows}
          live={live}
          share={share}
          reload={loadWallets}
          reloadHistory={loadHistory}
          report={report}
          onLogo={setLogo}
          onSizing={setSizing}
        />
        <ResultPanel output={output} reveal={reveal} />
        {/* After the launch, not part of it: exiting is a later decision, and a
            numbered step would imply the sequence is unfinished until it runs. */}
        <SellPanel
          explorer={health?.explorer || ''}
          credential={credential}
          live={live}
          reload={loadWallets}
          report={report}
        />
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
    </>
  );
}
