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

  const total = targets.reduce((s, t) => s + Number(t.amountEth), 0);
  const funded = wallets.filter((w) => w.role !== 'dev' && Number(w.balanceEth) > 0).length;

  return (
    <Section step="2" title="Fund" done={funded > 0}>
      <p className="lede">
        Sends ETH from the dev wallet to each bundle wallet, using the <b>Fund</b> column above.
        Blank rows are skipped. Fund a little above what each wallet will buy — it pays its own gas.
      </p>

      <div className="row">
        <Busy
          busy={busy === 'fund'}
          disabled={!targets.length}
          title={targets.length ? '' : 'enter a fund amount in the table above'}
          onClick={() => act('fund', () => api('/fund', 'POST', { targets }))}
        >
          {targets.length
            ? `Send ${total.toFixed(4)} ETH to ${targets.length} wallet${targets.length === 1 ? '' : 's'}`
            : 'Nothing to send'}
        </Busy>

        <span className="spacer" />

        <label className="hint" style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
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
        <Busy
          busy={busy === 'sweep'}
          className="ghost"
          title="return everything to the dev wallet"
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
