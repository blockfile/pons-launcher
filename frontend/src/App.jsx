import { useCallback, useEffect, useState } from 'react';
import { api, setApiKey } from './api.js';
import WalletsPanel from './components/WalletsPanel.jsx';
import FundPanel from './components/FundPanel.jsx';
import LaunchForm from './components/LaunchForm.jsx';
import HistoryPanel from './components/HistoryPanel.jsx';
import Section from './components/Section.jsx';

export default function App() {
  const [health, setHealth] = useState(null);
  const [wallets, setWallets] = useState([]);
  const [configs, setConfigs] = useState(null);
  const [history, setHistory] = useState([]);
  const [output, setOutput] = useState('connecting…');
  const [key, setKey] = useState('');
  // Per-wallet fund / buy-mode / buy-amount, keyed by wallet id. Lifted here
  // because both the Fund and Launch panels read the same rows.
  const [rows, setRows] = useState({});

  const setRow = (id, patch) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));

  const report = (v) => setOutput(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

  const loadWallets = useCallback(async () => setWallets(await api('/wallets')), []);
  const loadHistory = useCallback(async () => setHistory(await api('/launches?limit=15')), []);

  useEffect(() => {
    (async () => {
      try {
        setHealth(await api('/health'));
        await loadWallets();
        setConfigs(await api('/configs'));
        await loadHistory();
        setOutput('ready');
      } catch (err) {
        setOutput(`ERROR: ${err.message}`);
      }
    })();
  }, [loadWallets, loadHistory]);

  const live = health && !health.dryRun;

  return (
    <>
      <header>
        <h1>pons&#8203;-launcher</h1>
        <div className={`status ${health ? (live ? 'live' : 'dry') : ''}`}>
          {!health
            ? 'connecting…'
            : live
              ? `LIVE · chain ${health.chainId}`
              : 'DRY RUN · nothing is broadcast'}
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
        />
        <Section step="4" title="Result">
          <pre>{output}</pre>
        </Section>
        <HistoryPanel entries={history} explorer={health?.explorer || ''} />
      </main>
    </>
  );
}
