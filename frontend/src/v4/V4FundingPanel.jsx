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
  // Import is folded away by default. Generating is the ordinary path and the
  // one with no caveat attached; pasting a private key is neither, so it is a
  // thing you go and open rather than a thing sitting under the cursor.
  const [showImport, setShowImport] = useState(false);
  const [keys, setKeys] = useState('');

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

  /**
   * Paste existing keys in as funding wallets.
   *
   * ONLY FUNDING WALLETS. The route refuses a seed outright, and the reason is
   * worth repeating where the operator is standing: a seed wallet is worth
   * seasoning because it has no history before the transfer that funds it, and
   * an imported key has one already. Sitting for three weeks afterwards does
   * not give it back a property it never had.
   *
   * A funder is plumbing, so importing one is allowed — and it saves the single
   * transfer in this whole pipeline that nothing randomises. The warning under
   * the box is the real cost: the Relay hop breaks the funder-to-seed edge and
   * does nothing at all about where the funder itself has been.
   */
  const importer = (
    <div className="notice">
      <h3>Import an existing wallet</h3>
      <p>
        Only funding wallets. Seed wallets are generated here and cannot be imported — one that has
        been used before is not fresh, however long it then sits.
      </p>
      <p className="hint">
        Whatever this wallet has already done comes with it. Everything it funds inherits that
        history, because the Relay hop hides which seed a funder paid — not where the funder has
        been. Import one that is already clean, or generate a new one and send it ETH.
      </p>
      <textarea
        rows="3"
        placeholder="funding wallet private keys, one per line"
        value={keys}
        onChange={(e) => setKeys(e.target.value)}
      />
      <div className="row">
        <Busy
          busy={busy === 'import'}
          disabled={!keys.trim()}
          onClick={() =>
            act('import', async () => {
              const made = await api('/v4/wallets/import', 'POST', {
                privateKeys: keys.split('\n'),
                role: ROLES.master,
                label: 'v4 funding',
              });
              // Cleared on success only. A failed paste that wiped the box would
              // mean re-fetching keys from wherever they came from.
              setKeys('');
              setShowImport(false);
              return made;
            })
          }
        >
          Import funding wallet
        </Busy>
        <button className="link" onClick={() => setShowImport(false)}>
          cancel
        </button>
      </div>
    </div>
  );

  return (
    <Step {...step}>
      <p className="lede">
        Pays for a campaign and nothing else. Fund it from outside this console — every seed wallet a
        campaign touches traces back to this address, so what pays for it is a decision of its own.
      </p>

      {showImport && importer}

      {/* Empty is where this tab STARTS, not a failure. It says what the wallet
          is for and what to do next rather than drawing an empty table. */}
      {wallets.length === 0 ? (
        <div className="notice">
          <h3>No funding wallet yet</h3>
          <p>
            A campaign needs one to send from, and it needs ETH in it before it will start — the
            whole three weeks is paid for up front, Relay fees and gas included.
          </p>
          <div className="row">
            {create}
            <button className="link" onClick={() => setShowImport((v) => !v)}>
              or import one
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="row">
            {create}
            <button className="link" onClick={() => setShowImport((v) => !v)}>
              or import one
            </button>
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
