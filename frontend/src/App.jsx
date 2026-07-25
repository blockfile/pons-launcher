import { useCallback, useEffect, useState } from 'react';
import { api, setApiKey } from './api.js';
import Guide from './components/Guide.jsx';
import Readiness from './components/Readiness.jsx';
import WalletsPanel from './components/WalletsPanel.jsx';
import FundPanel from './components/FundPanel.jsx';
import LaunchForm from './components/LaunchForm.jsx';
import ResultPanel from './components/ResultPanel.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';

export default function App() {
  const [health, setHealth] = useState(null);
  const [wallets, setWallets] = useState([]);
  const [configs, setConfigs] = useState(null);
  const [history, setHistory] = useState([]);
  const [output, setOutput] = useState('Connecting…');
  const [key, setKey] = useState('');
  const [logo, setLogo] = useState('');
  // Per-wallet fund / buy-mode / buy-amount, keyed by wallet id. Lifted here
  // because both the Fund and Launch panels read the same rows.
  const [rows, setRows] = useState({});

  const setRow = (id, patch) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));

  // Strings stay strings so errors read as errors; everything else is a payload
  // for ResultPanel to lay out.
  const report = (v) => setOutput(v);

  const loadWallets = useCallback(async () => setWallets(await api('/wallets')), []);
  const loadHistory = useCallback(async () => setHistory(await api('/launches?limit=15')), []);

  useEffect(() => {
    (async () => {
      try {
        setHealth(await api('/health'));
        await loadWallets();
        setConfigs(await api('/configs'));
        await loadHistory();
        setOutput('Ready. Run Preflight when the checklist above is complete.');
      } catch (err) {
        setOutput(`ERROR: ${err.message}`);
      }
    })();
  }, [loadWallets, loadHistory]);

  const live = Boolean(health && !health.dryRun);
  const funded = wallets.filter((w) => w.role !== 'dev' && Number(w.balanceEth) > 0).length;

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
            <span>
              factory <b>{health.factory?.slice(0, 10)}…</b>
            </span>
          </div>
        )}

        <div className={`mode ${!health ? '' : live ? 'live' : 'dry'}`}>
          {!health ? 'connecting' : live ? 'live · spends real funds' : 'dry run · broadcasts nothing'}
        </div>

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
      </header>

      <main>
        <Readiness wallets={wallets} funded={funded} logo={logo} apiKey={key || !health?.apiKeyRequired} />
        <Guide />

        <WalletsPanel
          wallets={wallets}
          rows={rows}
          setRow={setRow}
          reload={loadWallets}
          report={report}
        />
        <FundPanel wallets={wallets} rows={rows} reload={loadWallets} report={report} />
        <LaunchForm
          configs={configs}
          wallets={wallets}
          rows={rows}
          live={live}
          reload={loadWallets}
          reloadHistory={loadHistory}
          report={report}
          onLogo={setLogo}
        />
        <ResultPanel output={output} />
        <HistoryPanel entries={history} explorer={health?.explorer || ''} />
      </main>
    </>
  );
}
