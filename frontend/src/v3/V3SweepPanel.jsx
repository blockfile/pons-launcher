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
  // The dust floor: wallets that would send less than this are left as dust.
  // Empty = the backend default (0.002 ETH). Lower it to pull small balances,
  // accepting that a Relay fee is then a big share of what moves.
  const [minSweep, setMinSweep] = useState('');
  const [preview, setPreview] = useState(null);
  const [arming, setArming] = useState(false);
  // The direct (no-Relay) sweep — for dust the relayed sweep skips. It links the
  // wallets on-chain, so it takes its own typed confirm, kept apart from the sweep above.
  const [armingDirect, setArmingDirect] = useState(false);
  const [typed, setTyped] = useState('');

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ destination });
      if (minSweep) qs.set('minSweepEth', minSweep);
      setPreview(await api(`/v3/sweep/preview?${qs.toString()}`));
    } catch {
      // No wallets yet, or nothing to sweep. The panel says so from the empty
      // preview rather than raising a toast on a page load.
      setPreview(null);
    }
  }, [destination, minSweep]);

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
        <label>
          min sweep (ETH)
          <input
            type="number"
            step="0.0001"
            min="0"
            value={minSweep}
            onChange={(e) => setMinSweep(e.target.value)}
            placeholder={preview?.minSweepEth ?? '0.002'}
            style={{ width: 110 }}
            title="wallets that would send less than this are left as dust — lower it to pull small balances"
          />
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
          {preview.skipped.length > 1 ? ' (and others)' : ''}. Lower <b>min sweep</b> above to pull
          them — but on a balance that small the Relay fee is a big share of what moves, which is why
          the floor is there.
        </p>
      )}

      {/* DIRECT sweep — the escape hatch for dust the relayed sweep skips. It bypasses
          Relay entirely (only pays 21k gas), so it moves the ~$1 balances the floor
          leaves behind. A direct send LINKS the wallets to the destination on-chain, so
          it is kept visually distinct (danger) and takes its own typed confirm. Always
          shown, because the whole point is the balances the relayed preview above hides. */}
      <div className="table-card" style={{ marginTop: 12 }}>
        <p className="hint" style={{ marginTop: 0 }}>
          <b>Direct sweep</b> — sends each wallet's ETH straight to the{' '}
          {destination === 'main' ? 'main wallet' : 'treasury'} with no Relay, so it moves even the
          dust the sweep above leaves behind (it only pays gas). It <b>links these wallets on-chain</b>
          , so use it for end-of-run cleanup, not the stealth path.
        </p>
        <Busy
          busy={busy === 'direct'}
          className="ghost danger"
          disabled={locked}
          onClick={() => {
            setTyped('');
            setArmingDirect(true);
          }}
        >
          Direct sweep to the {destination === 'main' ? 'main wallet' : 'treasury'}
        </Busy>
        {locked && <span className="hint"> A run is in progress — stop it first.</span>}
      </div>

      <Modal
        open={armingDirect}
        danger
        title="Direct sweep links your wallets on-chain"
        onCancel={() => setArmingDirect(false)}
        confirmLabel="Direct sweep"
        confirmDisabled={typed !== 'LINK'}
        onConfirm={async () => {
          setArmingDirect(false);
          await act('direct', () =>
            api('/v3/tokens/sweep-direct', 'POST', { destination, confirm: true })
          );
        }}
      >
        <p>
          This sends every wallet's ETH DIRECTLY to the{' '}
          {destination === 'main' ? 'main wallet' : 'treasury'} — no Relay. It moves the dust the
          relayed sweep can't, but every wallet sending to one address is a permanent on-chain link
          between them, the exact link the relayed sweep exists to avoid. Each wallet keeps back only
          its 21k gas.
        </p>
        <label className="modal-type">
          Type LINK to continue.
          <input
            data-autofocus
            value={typed}
            autoComplete="off"
            spellCheck="false"
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
      </Modal>

      <Modal
        open={arming}
        title="Sweep the run's wallets?"
        onCancel={() => setArming(false)}
        confirmLabel="Sweep it"
        onConfirm={async () => {
          await act('sweep', () =>
            api('/v3/sweep', 'POST', { destination, minSweepEth: minSweep || undefined, confirm: true })
          );
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
