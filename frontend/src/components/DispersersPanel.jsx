import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Busy } from './Section.jsx';

/**
 * The Disperse contracts funding goes through.
 *
 * Deploying spends real ETH, so the cost is shown before the button is pressed
 * and the button says what it will spend — a deploy control that only says
 * "Deploy" invites the click that finds out afterwards.
 *
 * There is no restart step. The backend reads this list per funding run, so a
 * contract deployed here is in use on the very next Fund.
 */
export default function DispersersPanel({ explorer, credential, report }) {
  const [state, setState] = useState(null);
  const [count, setCount] = useState(3);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

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

  // Before a key is entered the header already says so; repeating it here
  // would just be noise next to every other panel doing the same.
  if (error) return credential ? <p className="hint">dispersers unavailable — {error}</p> : null;
  if (!state) return null;

  const { dispersers, addresses, usingFallback, batchThreshold, quote } = state;
  const each = Number(quote?.costEachEth || 0);
  const active = addresses.length;

  return (
    <details className="disperse-panel">
      <summary>
        Disperser contracts
        <span className="hint" style={{ marginLeft: 8 }}>
          {active
            ? `${active} in use — funding ${batchThreshold}+ wallets goes through ${active === 1 ? 'it' : 'them'}`
            : 'none — funding sends one transfer per wallet'}
        </span>
      </summary>

      <p className="lede">
        Funding many wallets one transfer at a time is many concurrent broadcasts, which is what
        rate limiting hits first. A batch is one transaction instead, and several contracts split
        the run between them so a failure costs only its share. Below {batchThreshold} recipients
        individual transfers are cheaper and are used regardless.
      </p>

      {usingFallback && (
        <p className="hint">
          These come from DISPERSER_ADDRESSES in the environment. Deploy one here and this list
          takes over — the env value stops being used.
        </p>
      )}

      {active > 0 && (
        <table className="disperser-list">
          <tbody>
            {addresses.map((addr) => {
              const rec = dispersers.find((d) => d.address.toLowerCase() === addr.toLowerCase());
              return (
                <tr key={addr}>
                  <td>
                    <a href={`${explorer}/address/${addr}`} target="_blank" rel="noreferrer">
                      {addr}
                    </a>
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

        <Busy
          busy={busy === 'deploy'}
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
    </details>
  );
}
