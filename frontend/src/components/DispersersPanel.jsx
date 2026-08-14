import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';
import Address from './Address.jsx';

/**
 * Step 2 — the Disperse contracts funding goes through.
 *
 * Deploying spends real ETH, so the cost is shown before the button is pressed
 * and the button says what it will spend — a deploy control that only says
 * "Deploy" invites the click that finds out afterwards.
 *
 * There is no restart step. The backend reads this list per funding run, so a
 * contract deployed here is in use on the very next Fund.
 *
 * It is a numbered step because it comes second in the order of work and the
 * step after it is the one that uses it, but it is marked optional rather than
 * blocking: below the batching threshold individual transfers are cheaper and
 * are used regardless, so a sequence that refused to continue without one would
 * be lying about what the backend does.
 */
export default function DispersersPanel({ step, explorer, credential, report, onState }) {
  const [state, setState] = useState(null);
  const [count, setCount] = useState(3);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  // The sequence at the top of the page states how many contracts are in use,
  // and it can only get that from the one fetch this panel already makes. No
  // extra request: the answer is handed up as it arrives.
  useEffect(() => {
    onState?.(state);
  }, [state]);

  async function load() {
    try {
      setState(await api('/dispersers'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  // Re-read when the credential changes, not just on mount. It decides whether
  // this route may be read at all, and the panel mounts before a key is pasted
  // — loading once left it stuck on "invalid or missing API key" for the whole
  // session. Debounced to match App, which fires on every keystroke of a paste.
  // A key restored from sessionStorage is already present on the first render,
  // so that case loads immediately and correctly.
  useEffect(() => {
    const t = setTimeout(load, credential ? 400 : 0);
    return () => clearTimeout(t);
  }, [credential]);

  async function act(name, fn) {
    setBusy(name);
    try {
      report(await fn());
      await load();
    } catch (err) {
      report(`ERROR: ${err.message}`);
      // A failed deploy may still have landed some contracts — the backend
      // records those before it reports the error, so re-read either way.
      await load();
    } finally {
      setBusy('');
    }
  }

  // The step keeps its place in the sequence even when there is nothing to draw
  // inside it: a numbered run with a hole where step 2 should be is worse than
  // one that says why it is quiet. Before a key is entered the header already
  // says so, so that case gets nothing rather than the same complaint repeated
  // next to every other panel.
  if (error)
    return (
      <Step {...step}>
        {credential ? <p className="hint">dispersers unavailable — {error}</p> : null}
      </Step>
    );
  if (!state)
    return (
      <Step {...step}>
        <p className="hint">reading the disperser list…</p>
      </Step>
    );

  const { dispersers, addresses, usingFallback, batchThreshold, quote } = state;
  const each = Number(quote?.costEachEth || 0);
  const active = addresses.length;

  return (
    <Step {...step}>
      <p className="lede">
        Funding many wallets one transfer at a time is many concurrent broadcasts, which is what
        rate limiting hits first. A batch is one transaction instead, and several contracts split
        the run between them so a failure costs only its share. Below {batchThreshold} recipients
        individual transfers are cheaper and are used regardless — which is why this step is
        optional, and why skipping it costs nothing until the bundle is large.
      </p>

      {usingFallback && (
        <p className="hint">
          These come from DISPERSER_ADDRESSES in the environment. Deploy one here and this list
          takes over — the env value stops being used.
        </p>
      )}

      {active > 0 && (
        <div className="table-scroll">
          <table className="disperser-list">
            <tbody>
              {addresses.map((addr) => {
                const rec = dispersers.find((d) => d.address.toLowerCase() === addr.toLowerCase());
                return (
                  <tr key={addr}>
                    {/* Shortened text over a full-address href. This row also
                        carries a remove, so the copy button is not only a
                        convenience: checking a contract on an explorer before
                        dropping it from the funding route should not mean
                        retyping 42 characters. */}
                    <td>
                      <Address value={addr} href={`${explorer}/address/${addr}`} />
                    </td>
                    <td className="hint">
                      {rec?.deployedAt ? new Date(rec.deployedAt).toLocaleDateString() : 'from env'}
                    </td>
                    <td>
                      {rec && (
                        <Busy
                          busy={busy === addr}
                          className="ghost"
                          title="stop funding through this contract — it stays on chain"
                          onClick={() => act(addr, () => api(`/dispersers/${addr}`, 'DELETE'))}
                        >
                          remove
                        </Busy>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="row">
        <label className="hint">
          deploy
          <input
            type="number"
            min="1"
            max="10"
            value={count}
            onChange={(e) => setCount(e.target.value)}
            style={{ width: 60, marginLeft: 6 }}
          />
        </label>

        {/* Not the amber primary, and never again: this step is optional and
            usually blocked — on a fresh console there is not yet a dev wallet
            to pay for it — and a filled amber button that names a price was the
            loudest control on the page before step 1 had been done at all.

            .spend rather than ghost because it pays gas out of the dev wallet
            the instant it is clicked and no dialog asks first, so the trigger
            is the only place that warning can live. Tinted, so it still is not
            the loudest control here, and red pulls "careful" rather than the
            "go here" the amber used to. Nothing about the control changes:
            same handler, same enabled state, same label with the same quote. */}
        <Busy
          busy={busy === 'deploy'}
          className="spend"
          disabled={!(Number(count) >= 1)}
          onClick={() =>
            act('deploy', () =>
              api('/dispersers/deploy', 'POST', { count: Number(count), confirm: true })
            )
          }
        >
          {each
            ? `Deploy ${count} for ~${(each * Number(count)).toFixed(6)} ETH`
            : `Deploy ${count}`}
        </Busy>

        <span className="spacer" />

        <span className="hint">
          {quote?.error
            ? `cannot price a deploy — ${quote.error}`
            : `paid by the dev wallet, balance ${Number(quote?.balanceEth || 0).toFixed(6)} ETH`}
        </span>
      </div>
    </Step>
  );
}
