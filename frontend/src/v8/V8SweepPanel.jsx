import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { eth, plural } from './roles.js';

/**
 * Step 4 — collecting the ETH back.
 *
 * IT GOES THROUGH RELAY, and the panel says so plainly, because the obvious
 * shortcut is the one that undoes the whole run: twenty wallets that were
 * carefully funded by twenty different solvers all sending straight back to one
 * address draws exactly the link step 3 avoided — after the fact, permanently,
 * for every wallet at once.
 *
 * WHAT EACH WALLET SENDS IS THE SERVER'S ARITHMETIC, not this panel's. A wallet
 * has to keep back gas for its own transaction and enough for the Relay fee, so
 * it sends slightly less than it holds, and a balance too small to cover both is
 * left where it is — paying a fee to move nothing is worse than leaving it. The
 * figures here are the balances the sweep works FROM, which is why they are
 * labelled as such.
 */
export default function V8SweepPanel({ step, main, bundle, live, explorer, reload, report, locked }) {
  const [busy, setBusy] = useState('');
  const [arming, setArming] = useState(false);

  async function act(what, fn) {
    setBusy(what);
    try {
      report(await fn());
      // Give the last order a moment to land before re-reading balances.
      setTimeout(reload, 3000);
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  // Only the wallets with something in them. A wallet at zero is not swept, and
  // listing it here would put twenty empty rows above the one that matters.
  const holding = bundle.filter((w) => Number(w.balanceEth) > 0);
  const total = holding.reduce((s, w) => s + Number(w.balanceEth || 0), 0);

  return (
    <Step {...step}>
      <p className="lede">
        Sends what is left in the destination wallets back to the source. Every wallet pays a Relay
        deposit and a solver pays the source, so the return trip connects them no more than the way
        out did.
      </p>

      {!main && (
        <div className="notice">
          <h3>No source wallet</h3>
          <p>There is nowhere to sweep to. Create it in step 1 — the sweep is defined against it.</p>
        </div>
      )}

      {main && (
        <div className="row">
          <span className="hint">everything comes back to —</span>
          <Address
            value={main.address}
            plain
            href={explorer ? `${explorer}/address/${main.address}` : ''}
          />
          <span className="hint">{eth(main.balanceEth)} ETH held now</span>
        </div>
      )}

      {holding.length === 0 ? (
        <p className="hint" style={{ marginTop: 12 }}>
          Nothing to sweep — no destination wallet is holding ETH. This moves ETH and nothing else:
          there are no tokens on this tab to sell first.
        </p>
      ) : (
        <>
          <div className="table-card" style={{ maxHeight: 360, marginTop: 12 }}>
            <table className="wallet-list">
              <thead>
                <tr>
                  <th className="num">No.</th>
                  <th>Address</th>
                  <th className="num">Holds</th>
                </tr>
              </thead>
              <tbody>
                {holding.map((w, i) => (
                  <tr key={w.id}>
                    <td className="num hint">{i + 1}</td>
                    <td>
                      <Address
                        value={w.address}
                        plain
                        href={explorer ? `${explorer}/address/${w.address}` : ''}
                      />
                    </td>
                    <td className="num">{eth(w.balanceEth)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">
              Each wallet keeps back its own gas and a Relay fee allowance, so it sends slightly less
              than it holds; a balance too small to cover both is left where it is rather than spent
              on the fee to move it.
            </p>
          </div>

          <div className="row" style={{ marginTop: 12 }}>
            <Busy
              busy={busy === 'sweep'}
              disabled={!main || locked}
              title={
                !main
                  ? 'create the source wallet in step 1 first'
                  : locked
                    ? 'a timed run is going — stop it first'
                    : ''
              }
              onClick={() => setArming(true)}
            >
              Sweep {plural(holding.length, 'wallet')} back to the source
            </Busy>
            <span className="hint">
              {holding.length} holding · <b>{total.toFixed(6)} ETH</b> before fees and gas
            </span>
            {locked && (
              <span className="hint">
                A timed run is still paying these wallets — stop it in step 3 before sweeping.
              </span>
            )}
          </div>
        </>
      )}

      <Modal
        open={arming}
        title={`Sweep ${plural(holding.length, 'wallet')} back to the source?`}
        onCancel={() => setArming(false)}
        confirmLabel="Sweep it"
        onConfirm={async () => {
          setArming(false);
          await act('sweep', () => api('/v8/sweep', 'POST', { confirm: true }));
        }}
      >
        <p>
          One Relay order per wallet, sent one at a time. A wallet that fails is reported and the
          rest still go, so nothing is left half-done — and a wallet holding too little to cover its
          own gas and fee is skipped rather than emptied at a loss.
        </p>
        {main && (
          <Fact label="To" mono>
            {main.address}
          </Fact>
        )}
        <Fact label="Wallets">{holding.length}</Fact>
        <Fact label="They hold">{total.toFixed(6)} ETH</Fact>
        <Fact label="Route">Relay solvers — no direct transfer</Fact>
        <Fact label="Mode">{live ? 'live — this moves real ETH' : 'dry run — broadcasts nothing'}</Fact>
      </Modal>
    </Step>
  );
}
