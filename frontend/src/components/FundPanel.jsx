import { useState } from 'react';
import { api } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';
import { rolesFor } from '../variant.js';
import Address from './Address.jsx';

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
export default function FundPanel({ step, wallets, rows, dispersers, reload, report, variant = 'v1' }) {
  const roles = rolesFor(variant);
  const isV2 = variant === 'v2';
  const [includeTokens, setIncludeTokens] = useState(false);
  const [tokenAddress, setTokenAddress] = useState('');
  const [busy, setBusy] = useState('');
  const [relayRuns, setRelayRuns] = useState([]);

  async function act(name, fn) {
    setBusy(name);
    try {
      const out = await fn();
      report(out);
      if (out?.mode === 'relay-solver') setRelayRuns(out.results || []);
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
    .filter((w) => w.role === roles.bundle)
    .map((w) => ({ walletId: w.id, amountEth: rows[w.id]?.fund }))
    .filter((t) => Number(t.amountEth) > 0);

  const total = targets.reduce((s, t) => s + Number(t.amountEth), 0);

  // Read, never decided here: the backend picks the path per run from the same
  // two numbers. This only names the choice it is going to make.
  const active = dispersers?.addresses?.length ?? 0;
  const threshold = Number(dispersers?.batchThreshold ?? 0);
  const batches = Boolean(threshold) && targets.length >= threshold;
  const fundEndpoint = isV2 ? '/v2/relay/fund' : '/fund';
  const fundBody = isV2 ? { targets } : { targets, variant };

  return (
    <Step {...step}>
      <p className="lede">
        {isV2 ? (
          <>
            Funds v2 bundle wallets through Relay solver orders, using the <b>Fund</b> column as the
            exact amount each wallet should receive. The dev wallet pays Relay deposit addresses;
            solvers fill the bundle wallets.
          </>
        ) : (
          <>
            Sends ETH from the dev wallet to each bundle wallet, using the <b>Fund</b> column in the
            table above. Blank rows are skipped. Fund a little above what each wallet will buy — it
            pays its own gas.
          </>
        )}
      </p>

      <div className="row">
        <Busy
          busy={busy === 'fund'}
          disabled={!targets.length}
          title={targets.length ? '' : 'enter a fund amount in the table above'}
          onClick={() => act('fund', () => api(fundEndpoint, 'POST', fundBody))}
        >
          {targets.length
            ? isV2
              ? `Relay ${total.toFixed(4)} ETH to ${targets.length} wallet${targets.length === 1 ? '' : 's'}`
              : `Send ${total.toFixed(4)} ETH to ${targets.length} wallet${targets.length === 1 ? '' : 's'}`
            : 'Nothing to send'}
        </Busy>

        {isV2 && targets.length > 0 && (
          <span className="hint">
            strict exact-output Relay deposits — verify balances before preflight
          </span>
        )}

        {!isV2 && targets.length > 0 && Boolean(threshold) && (
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
              api('/sweep', 'POST', {
                includeTokens,
                tokenAddress: tokenAddress.trim() || null,
                variant,
              })
            )
          }
        >
          Sweep back to dev
        </Busy>
      </div>

      {isV2 && relayRuns.length > 0 && (
        <div className="table-scroll" style={{ marginTop: 12 }}>
          <table className="wallet-list">
            <thead>
              <tr>
                <th>Bundle wallet</th>
                <th>Receives</th>
                <th>Relay deposit</th>
                <th>Request</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {relayRuns.map((r) => (
                <tr key={r.requestId || r.walletId}>
                  <td className="addr">
                    <Address value={r.address} />
                  </td>
                  <td className="bal">{Number(r.amountEth || 0).toFixed(6)}</td>
                  <td className="addr">
                    <Address value={r.depositAddress} />
                    <div className="hint">{Number(r.depositEth || 0).toFixed(6)} ETH</div>
                  </td>
                  <td className="addr">
                    {r.requestId ? `${r.requestId.slice(0, 10)}…${r.requestId.slice(-6)}` : '—'}
                  </td>
                  <td>
                    {r.error ? (
                      <span className="fund-state is-part">deposit failed</span>
                    ) : r.simulated ? (
                      <span className="fund-state is-wait">quoted</span>
                    ) : (
                      <span className="fund-state is-in">deposit sent</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Step>
  );
}
