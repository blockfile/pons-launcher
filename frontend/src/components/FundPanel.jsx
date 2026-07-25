import { useState } from 'react';
import { api } from '../api.js';
import Section, { Busy } from './Section.jsx';

export default function FundPanel({ wallets, rows, reload, report }) {
  const [includeTokens, setIncludeTokens] = useState(false);
  const [tokenAddress, setTokenAddress] = useState('');
  const [busy, setBusy] = useState('');

  async function act(name, fn) {
    setBusy(name);
    try {
      report(await fn());
      // Give the transfers a moment to land before re-reading balances.
      setTimeout(reload, 3000);
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  const targets = wallets
    .filter((w) => w.role !== 'dev')
    .map((w) => ({ walletId: w.id, amountEth: rows[w.id]?.fund }))
    .filter((t) => Number(t.amountEth) > 0);

  return (
    <Section step="2" title="Fund">
      <p className="hint">
        Sends native ETH from the dev wallet to each bundle wallet using the <em>fund</em> column
        above. Leave a row blank to skip it.
      </p>
      <div className="row">
        <Busy
          busy={busy === 'fund'}
          disabled={!targets.length}
          title={targets.length ? '' : 'enter a fund amount first'}
          onClick={() => act('fund', () => api('/fund', 'POST', { targets }))}
        >
          Disperse to {targets.length || 'no'} wallet{targets.length === 1 ? '' : 's'}
        </Busy>
        <span className="spacer" />
        <label className="inline">
          <input
            type="checkbox"
            checked={includeTokens}
            onChange={(e) => setIncludeTokens(e.target.checked)}
          />
          also sweep tokens
        </label>
        <input
          placeholder="token address (for token sweep)"
          value={tokenAddress}
          onChange={(e) => setTokenAddress(e.target.value)}
        />
        <Busy
          busy={busy === 'sweep'}
          className="ghost"
          onClick={() =>
            act('sweep', () =>
              api('/sweep', 'POST', { includeTokens, tokenAddress: tokenAddress.trim() || null })
            )
          }
        >
          Sweep back to dev
        </Busy>
      </div>
    </Section>
  );
}
