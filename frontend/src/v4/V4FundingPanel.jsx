import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Address from '../components/Address.jsx';
import { ROLES, eth } from './roles.js';

/**
 * Step 1 — the funding wallets.
 *
 * One of these pays for a campaign and does nothing else: never buys, never
 * sells, never holds supply. Its address is the single edge every seeded wallet
 * shares, which is why it is a wallet of its own rather than a trading one.
 *
 * THIS LIST IS PLURAL AND EVERY OTHER TREASURY IN THE CONSOLE IS A SINGLETON,
 * and the reason is the nonce. Two campaigns sending from one wallet both read
 * the same pending nonce and the second broadcast silently REPLACES the first —
 * no error anywhere, one transfer simply gone, and a wallet recorded as funded
 * that never received anything. So the runner refuses a second campaign on a
 * busy wallet, and a campaign meant to run alongside another needs a funding
 * wallet of its own. That is the only reason to make more than one.
 *
 * Nothing here deletes. The V4 routes expose no delete at all, deliberately:
 * the wallet in this table may be halfway through signing a three-week
 * schedule, and there is no seed phrase behind it to recover from.
 */
export default function V4FundingPanel({ step, wallets, campaignFor, explorer, reload, report }) {
  const [busy, setBusy] = useState('');

  async function act(what, fn) {
    setBusy(what);
    try {
      report(await fn());
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  const create = (
    <Busy
      busy={busy === 'generate'}
      onClick={() =>
        act('generate', () =>
          api('/v4/wallets/generate', 'POST', { count: 1, role: ROLES.master, label: 'v4 funding' })
        )
      }
    >
      Create funding wallet
    </Busy>
  );

  return (
    <Step {...step}>
      <p className="lede">
        Pays for a campaign and nothing else. Fund it from outside this console — every seed wallet a
        campaign touches traces back to this address, so what pays for it is a decision of its own.
      </p>

      {/* Empty is where this tab STARTS, not a failure. It says what the wallet
          is for and what to do next rather than drawing an empty table. */}
      {wallets.length === 0 ? (
        <div className="notice">
          <h3>No funding wallet yet</h3>
          <p>
            A campaign needs one to send from, and it needs ETH in it before it will start — the
            whole three weeks is paid for up front, Relay fees and gas included.
          </p>
          <div className="row">{create}</div>
        </div>
      ) : (
        <>
          <div className="row">
            {create}
            <span className="spacer" />
            <span className="hint">one campaign at a time per wallet — make another to run two</span>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Address</th>
                  <th className="num">Balance</th>
                  <th>Campaign</th>
                </tr>
              </thead>
              <tbody>
                {wallets.map((w) => {
                  const held = campaignFor[w.id];
                  return (
                    <tr key={w.id}>
                      <td>
                        <Address
                          value={w.address}
                          href={explorer ? `${explorer}/address/${w.address}` : ''}
                        />
                      </td>
                      {/* null is "the RPC did not answer", which is not the same
                          statement as zero — a wallet drawn at 0.000000 when it
                          holds two ETH is the one reading that would have an
                          operator top up a wallet that did not need it. */}
                      <td className="num">
                        {w.balanceEth == null ? <span className="hint">unreadable</span> : eth(w.balanceEth)}
                      </td>
                      <td>
                        {held ? (
                          <>
                            {held.name} <span className="hint">· {held.status}</span>
                          </>
                        ) : w.inCampaign ? (
                          <span className="hint">in a campaign</span>
                        ) : (
                          <span className="hint">free</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Step>
  );
}
