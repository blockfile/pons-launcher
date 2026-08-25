import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Address from '../components/Address.jsx';
import { eth, plural } from './roles.js';

/**
 * Step 2 — moving ETH into the launcher and out to the bundle wallets.
 *
 * TWO DIFFERENT PATHS, because the shared /fund route can only ever do one of
 * them:
 *
 *   v5dev (the launcher)   funded from OUTSIDE this console. The shared
 *                          funding route sources ETH FROM the launcher and
 *                          sends it OUT — there is no route that puts ETH INTO
 *                          it, exactly the limitation DevWalletPanel states
 *                          for pons' own dev wallet (see components/
 *                          DevWalletPanel.jsx). So this panel shows the
 *                          launcher's address and balance and says where the
 *                          ETH has to come from; it never sends anything TO it.
 *   v5bundle (the bundle)  funded FROM the launcher, through POST /fund — the
 *                          same shared spine route pons' own FundPanel calls,
 *                          with the same body shape: `{ targets, variant }`,
 *                          targets being `{ walletId, amountEth }` pairs (see
 *                          components/FundPanel.jsx). Amounts are typed per
 *                          wallet right here — v5 has no upstream "rows" table
 *                          the way pons' step 3 does, so this panel owns that
 *                          little bit of state itself, per the tab isolation
 *                          rule (every tab owns its own modules).
 *
 * `variant: 'v5'` IS SENT DELIBERATELY, and MUST be. It resolves the funding
 * SOURCE: backend/src/wallets/variants.js maps 'v5' → { dev: 'v5dev', bundle:
 * 'v5bundle' }, so /fund sources ETH from the v5dev launcher and sends it to the
 * v5bundle wallets. Omitting `variant` would default to v1 and SILENTLY spend
 * v1's dev wallet instead — a real misdirection of funds — so it is always named
 * explicitly here. (variants.js also fails loud on an unknown variant rather than
 * falling back to v1, for the same reason.)
 */
export default function V5FundPanel({ step, dev, bundle, explorer, reload, report, rows = {}, setRow = () => {} }) {
  const [busy, setBusy] = useState('');

  const explorerFor = (address) => (explorer ? `${explorer}/address/${address}` : '');
  // The per-wallet fund amount is the SHARED `rows.fund` the step-1 wallets table
  // writes (its auto-fill fills it), so what was sized there is what this step
  // sends — the v1 Launcher tab's split between the sizing table and the Fund step.
  const setFund = (walletId, value) => setRow(walletId, { fund: value });

  // Exactly the shape components/FundPanel.jsx builds for pons' own /fund call
  // — walletId + amountEth pairs, blank/zero rows skipped.
  const targets = bundle
    .map((w) => ({ walletId: w.walletId, amountEth: rows[w.walletId]?.fund }))
    .filter((t) => Number(t.amountEth) > 0);
  const total = targets.reduce((s, t) => s + Number(t.amountEth), 0);

  async function send() {
    setBusy('fund');
    try {
      const out = await api('/fund', 'POST', { targets, variant: 'v5' });
      report(out);
      // Clear the fund column for the wallets just funded — their buy amount is a
      // separate field and stays. The balance column re-reads below to show the
      // result.
      targets.forEach((t) => setRow(t.walletId, { fund: '' }));
      // Give the transfers a moment to land before re-reading balances — same
      // pause pons' own FundPanel gives itself.
      setTimeout(reload, 3000);
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <Step {...step}>
      <p className="lede">
        The launcher pays the launch fee and the atomic first buy; the bundle wallets each buy behind
        it, so they need enough ETH for their own buy plus gas. Fund the launcher from outside first,
        then send it out to the bundle wallets below. The per-wallet amounts here are the <b>Fund</b>{' '}
        column from step 1 — <b>Auto-fill</b> there sizes them; edit any row before sending.
      </p>

      <h3 style={{ margin: '0 0 8px' }}>Launcher wallet</h3>
      {!dev ? (
        <div className="notice">
          <h3>No launcher wallet yet</h3>
          <p>Generate it in step 1 before funding anything.</p>
        </div>
      ) : (
        <div className="row">
          <Address value={dev.address} full href={explorerFor(dev.address)} />
          <span className="hint">{eth(dev.balanceEth)} ETH</span>
        </div>
      )}
      {/* Nothing in this console can put ETH into the launcher — every route
          that touches it, /fund included, only ever spends OUT of it. Said
          plainly here for the same reason DevWalletPanel says it about pons'
          dev wallet: an operator who does not know that reaches this step
          with an empty launcher and a failure that reads like a bug. */}
      {dev && Number(dev.balanceEth) === 0 && (
        <div className="notice warn">
          <h3>The launcher is empty</h3>
          <ul>
            <li>
              Send ETH to the address above from wherever you hold funds. Nothing in this console can
              fund it — every transfer here spends out of it, straight to the bundle wallets below.
            </li>
            <li>It needs enough for the launch fee, the atomic first buy, and gas on top of both.</li>
          </ul>
        </div>
      )}

      <h3 style={{ margin: '16px 0 8px' }}>Bundle wallets</h3>
      {bundle.length === 0 ? (
        <div className="notice">
          <h3>No bundle wallets yet</h3>
          <p>Generate them in step 1 — this table fills in once they exist.</p>
        </div>
      ) : (
        <div className="table-scroll" style={{ maxHeight: 460, overflowY: 'auto' }}>
          <table className="wallet-list">
            <thead>
              <tr>
                <th>Address</th>
                <th className="num">Balance</th>
                <th className="num">Fund (ETH)</th>
              </tr>
            </thead>
            <tbody>
              {bundle.map((w) => (
                <tr key={w.walletId}>
                  <td className="addr">
                    <Address value={w.address} plain href={explorerFor(w.address)} />
                  </td>
                  <td className="num">
                    {w.balanceEth == null ? (
                      <span className="hint">unreadable</span>
                    ) : (
                      <span className={`bal ${Number(w.balanceEth) === 0 ? 'zero' : ''}`}>
                        {eth(w.balanceEth)}
                      </span>
                    )}
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      step="0.0001"
                      placeholder="0.0"
                      value={rows[w.walletId]?.fund ?? ''}
                      onChange={(e) => setFund(w.walletId, e.target.value)}
                      style={{ width: 100 }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <Busy
          busy={busy === 'fund'}
          className="btn-primary"
          disabled={!targets.length || !dev}
          title={targets.length ? '' : 'enter a fund amount in the table above'}
          onClick={send}
        >
          {targets.length
            ? `Send ${total.toFixed(4)} ETH to ${plural(targets.length, 'wallet')}`
            : 'Nothing to send'}
        </Busy>
        <span className="spacer" />
        {targets.length > 0 && (
          <span className="hint">from the launcher, one transfer per wallet</span>
        )}
      </div>
    </Step>
  );
}
