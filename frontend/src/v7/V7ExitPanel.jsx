import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { plural } from './roles.js';

/**
 * Step 5 — the exit.
 *
 * Sells every V7 wallet's whole balance, INCLUDING the main wallet's. That last
 * part is the one thing an operator is most likely to get wrong by hand: the
 * bundle wallets are the obvious holders, and the main wallet quietly finishes a
 * run holding whatever the cycles did not need to sell — usually the largest
 * remaining position of the lot.
 *
 * No slippage floor, by decision. The point of this button is that nothing is
 * left holding tokens; a floor turns a guaranteed exit into a maybe-exit.
 */
export default function V7ExitPanel({ step, token, setToken, explorer, reload, report, locked }) {
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);
  const [arming, setArming] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadErr, setLoadErr] = useState(null);

  const load = useCallback(async () => {
    if (!token?.trim()) {
      setPreview(null);
      setLoadErr(null);
      return;
    }
    setLoading(true);
    setLoadErr(null);
    try {
      setPreview(await api(`/v7/exit/preview?token=${encodeURIComponent(token.trim())}`));
    } catch (err) {
      // Distinguish a real failure from "nothing held" — swallowing it silently made a
      // slow or failing preview look like an empty one.
      setPreview(null);
      setLoadErr(err.message);
    } finally {
      setLoading(false);
    }
  }, [token]);

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

  return (
    <Step {...step}>
      <p className="lede">
        Empties every V7 wallet of this token — the bundle wallets and the main wallet, which
        finishes a run still holding whatever it did not sell.
      </p>

      <div className="row">
        <input
          type="text"
          placeholder="token address"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ flex: 1, minWidth: 260 }}
        />
        <button className="ghost" onClick={load} disabled={!token?.trim()}>
          refresh
        </button>
      </div>

      {loading ? (
        <p className="hint">Reading holdings…</p>
      ) : loadErr ? (
        <p className="warn">Could not read holdings: {loadErr}</p>
      ) : preview && preview.wallets.length > 0 ? (
        <>
          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th>Wallet</th>
                  <th>Role</th>
                  <th className="num">Tokens</th>
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
                    <td>{w.role === 'v7main' ? 'main' : 'bundle'}</td>
                    <td className="num">{Number(w.tokens).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">
              {plural(preview.walletCount, 'wallet')} holding{' '}
              <b>{Number(preview.totalTokens).toLocaleString()}</b> tokens in total.
            </p>
          </div>

          <div className="row">
            <Busy busy={busy === 'sell'} className="danger" disabled={locked} onClick={() => setArming(true)}>
              Sell everything
            </Busy>
            {locked && <span className="hint">A run is in progress — stop it first.</span>}
          </div>
        </>
      ) : (
        <p className="hint">
          {token?.trim()
            ? 'No V7 wallet holds any of this token yet.'
            : 'Paste the token the chain traded to see what is still held.'}
        </p>
      )}

      <Modal
        open={arming}
        title="Sell everything?"
        danger
        question="Irreversible, and there is no slippage floor."
        onCancel={() => setArming(false)}
        confirmLabel="Sell it all"
        onConfirm={async () => {
          await act('sell', () => api('/v7/exit', 'POST', { token: token.trim(), confirm: true }));
          setArming(false);
        }}
      >
        <p>
          Every wallet approves exactly its balance and sells it into the curve at whatever price it
          gets. Wallets land in no guaranteed order, so each one after the first sells into a price
          the ones before it moved. A wallet too short of gas is skipped and named rather than
          stranded mid-approval.
        </p>
        {preview && (
          <>
            <Fact label="Token" mono>
              {preview.token}
            </Fact>
            <Fact label="Wallets">{preview.walletCount}</Fact>
            <Fact label="Tokens">{Number(preview.totalTokens).toLocaleString()}</Fact>
            <Fact label="Minimum out">none — 0</Fact>
          </>
        )}
      </Modal>
    </Step>
  );
}
