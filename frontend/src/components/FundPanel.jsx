import { useState } from 'react';
import { api } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';

/**
 * Step 4 — moving ETH from the dev wallet out to the bundle wallets.
 *
 * The amounts are typed in the table in step 3, not here: they are read next to
 * the buy each wallet is being funded FOR, and splitting the two would mean
 * scrolling between a number and its reason.
 *
 * Which path the run takes is the backend's decision, made per run from the
 * recipient count. It is stated here rather than left to be discovered, because
 * "why did this fund run get rate limited" is the question step 2 exists to
 * answer and the answer is only visible at this moment.
 */
export default function FundPanel({ step, wallets, rows, dispersers, reload, report }) {
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

  // A WHITELIST. "Everything that is not the dev wallet" used to be the same
  // set and is not any more: the keystore also holds v2dev, v2funding and
  // v2bundle roles, and funding those from here would move real ETH into
  // wallets this panel is not about.
  const targets = wallets
    .filter((w) => w.role === 'bundle')
    .map((w) => ({ walletId: w.id, amountEth: rows[w.id]?.fund }))
    .filter((t) => Number(t.amountEth) > 0);

  const total = targets.reduce((s, t) => s + Number(t.amountEth), 0);

  // Read, never decided here: the backend picks the path per run from the same
  // two numbers. This only names the choice it is going to make.
  const active = dispersers?.addresses?.length ?? 0;
  const threshold = Number(dispersers?.batchThreshold ?? 0);
  const batches = Boolean(threshold) && targets.length >= threshold;

  return (
    <Step {...step}>
      <p className="lede">
        Sends ETH from the dev wallet to each bundle wallet, using the <b>Fund</b> column in the
        table above. Blank rows are skipped. Fund a little above what each wallet will buy — it pays
        its own gas.
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

        {targets.length > 0 && Boolean(threshold) && (
          <span className="hint">
            {batches && active > 0
              ? `batched through ${active} disperser contract${active === 1 ? '' : 's'} — one transaction`
              : batches
                ? `${targets.length} recipients and no disperser deployed — one transfer per wallet, which is what rate limiting hits first. Deploy one in step 2.`
                : `${targets.length} recipient${targets.length === 1 ? '' : 's'}, below the ${threshold} batching threshold — individual transfers are cheaper here`}
          </span>
        )}

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
        {/* .spend, not ghost: this empties every bundle wallet back to dev on
            the first click, with no confirmation dialog anywhere behind it.
            Tinted vermilion rather than filled — the filled amber beside it is
            step 4's own action and has to stay the loudest thing in the row. */}
        <Busy
          busy={busy === 'sweep'}
          className="spend"
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
    </Step>
  );
}
