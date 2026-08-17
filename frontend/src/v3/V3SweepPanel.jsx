import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { eth, plural } from './roles.js';

/**
 * Step 6 — collecting the ETH back.
 *
 * After the exit has sold every position, the proceeds are sitting in however
 * many bundle wallets the run used. This gathers them into the main wallet
 * (ready for another run) or the treasury (parked where nothing trades).
 *
 * IT GOES THROUGH RELAY, and the panel says so plainly, because the obvious
 * shortcut is the one that undoes the run: twenty wallets that bought the token
 * all sending ETH straight to one address draws the link the whole strategy
 * avoided on the way in — after the fact, permanently, for every wallet at
 * once.
 *
 * Dust below the floor is left where it is and named. Under a certain amount
 * the Relay fee is most of what is being moved, and paying to move nothing is
 * worse than leaving it.
 */
export default function V3SweepPanel({ step, explorer, reload, report, locked }) {
  const [busy, setBusy] = useState('');
  const [destination, setDestination] = useState('main');
  const [preview, setPreview] = useState(null);
  const [arming, setArming] = useState(false);

  const load = useCallback(async () => {
    try {
      setPreview(await api(`/v3/sweep/preview?destination=${destination}`));
    } catch {
      // No wallets yet, or nothing to sweep. The panel says so from the empty
      // preview rather than raising a toast on a page load.
      setPreview(null);
    }
  }, [destination]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(what, fn) {
    setBusy(what);
    try {
      report(await fn());
      await reload();
      await load();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  const has = preview && preview.wallets.length > 0;

  return (
    <Step {...step}>
      <p className="lede">
        Gathers the ETH left in the run's wallets. Every wallet pays a Relay deposit and a solver
        pays the destination, so no transaction connects the buyers to it.
      </p>

      <div className="row">
        <label>
          send to
          <select value={destination} onChange={(e) => setDestination(e.target.value)}>
            <option value="main">main wallet — ready for another run</option>
            <option value="treasury">treasury — parked, never trades</option>
          </select>
        </label>
        <button className="ghost" onClick={load}>
          refresh
        </button>
        <span className="spacer" />
        {preview && (
          <span className="hint">
            {plural(preview.wallets.length, 'wallet')} · <b>{Number(preview.totalEth).toFixed(6)} ETH</b>
          </span>
        )}
      </div>

      {has ? (
        <>
          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th>Role</th>
                  <th className="num">Balance</th>
                  <th className="num">Sends</th>
                </tr>
              </thead>
              <tbody>
                {preview.wallets.map((w) => (
                  <tr key={w.walletId}>
                    <td>
                      <Address
                        value={w.address}
                        href={explorer ? `${explorer}/address/${w.address}` : ''}
                      />
                    </td>
                    <td>{w.role === 'v3main' ? 'main' : 'bundle'}</td>
                    <td className="num">{eth(w.balanceEth)}</td>
                    <td className="num">{eth(w.sendEth)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">
              Each wallet keeps back gas and a small Relay fee allowance, so it sends slightly less
              than it holds. Anything unspent stays where it is.
            </p>
          </div>

          <div className="row">
            <Busy busy={busy === 'sweep'} disabled={locked} onClick={() => setArming(true)}>
              Sweep to the {destination === 'main' ? 'main wallet' : 'treasury'}
            </Busy>
            {locked && <span className="hint">A run is in progress — stop it first.</span>}
          </div>
        </>
      ) : (
        <p className="hint">
          Nothing worth sweeping. Sell any remaining positions in step 5 first — this moves ETH, not
          tokens.
        </p>
      )}

      {preview?.skipped?.length > 0 && (
        <p className="hint">
          {plural(preview.skipped.length, 'wallet')} skipped: {preview.skipped[0].reason}
          {preview.skipped.length > 1 ? ' (and others)' : ''}.
        </p>
      )}

      <Modal
        open={arming}
        title="Sweep the run's wallets?"
        onCancel={() => setArming(false)}
        confirmLabel="Sweep it"
        onConfirm={async () => {
          await act('sweep', () => api('/v3/sweep', 'POST', { destination, confirm: true }));
          setArming(false);
        }}
      >
        <p>
          One Relay order per wallet, sent one at a time. A wallet that fails is reported and the
          rest still go — nothing is left half-done.
        </p>
        {preview && (
          <>
            <Fact label="To" mono>
              {preview.destination.address}
            </Fact>
            <Fact label="Wallets">{preview.wallets.length}</Fact>
            <Fact label="Total">{Number(preview.totalEth).toFixed(6)} ETH</Fact>
            <Fact label="Route">Relay — no direct transfer</Fact>
          </>
        )}
      </Modal>
    </Step>
  );
}
