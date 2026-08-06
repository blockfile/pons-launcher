import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Colour carries the meaning here, so each kind gets one that matches what it
// costs you to get wrong: money moving, contracts, and key material.
const KINDS = {
  fund: 'moved',
  sweep: 'moved',
  deploy: 'built',
  wallets: 'keys',
  export: 'keys',
};

/**
 * What this user has done, read back later.
 *
 * Launches have their own panel with the full plan; this is everything else —
 * funding, sweeps, deploys, wallets appearing and leaving, key exports. Before
 * it existed, a funding run that half-failed left no trace once the tab was
 * closed.
 *
 * Scoped to the caller, like the wallets and the history. There is no view of
 * another user's activity because there is no admin role to grant one.
 */
export default function ActivityPanel({ explorer, credential }) {
  const [entries, setEntries] = useState(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');

  async function load() {
    try {
      setEntries(await api(`/activity?limit=100${filter ? `&kind=${filter}` : ''}`));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  // Re-read on credential change as well as on mount: the credential decides
  // whose log this is, and the panel mounts before a key is pasted. One
  // restored from sessionStorage is present on the first render, so that case
  // loads the right log straight away.
  useEffect(() => {
    const t = setTimeout(load, credential ? 400 : 0);
    return () => clearTimeout(t);
  }, [credential, filter]);

  if (error) return credential ? <p className="hint">activity unavailable — {error}</p> : null;
  if (!entries) return null;

  return (
    <details className="disperse-panel">
      <summary>
        Activity
        <span className="hint" style={{ marginLeft: 8 }}>
          {entries.length ? `last ${entries.length} actions on this account` : 'nothing recorded yet'}
        </span>
      </summary>

      <p className="lede">
        Funding, sweeps, contract deploys, wallets and key exports — yours only. Launches have their
        own panel below. Private keys are never written here; an export is recorded as the fact that
        it happened.
      </p>

      <div className="row">
        {['', 'fund', 'sweep', 'deploy', 'wallets', 'export'].map((k) => (
          <button
            key={k || 'all'}
            type="button"
            className={filter === k ? '' : 'ghost'}
            onClick={() => setFilter(k)}
          >
            {k || 'all'}
          </button>
        ))}
      </div>

      {entries.length > 0 && (
        <table className="activity-list">
          <tbody>
            {entries.map((e, i) => (
              <tr key={`${e.at}-${i}`} data-kind={KINDS[e.kind] || 'moved'}>
                <td className="hint" style={{ whiteSpace: 'nowrap' }}>
                  {new Date(e.at).toLocaleString()}
                </td>
                <td>
                  <span className={`tag ${KINDS[e.kind] || 'moved'}`}>{e.kind}</span>
                </td>
                <td>
                  {e.summary}
                  {e.failed > 0 && <span className="hint"> · {e.failed} failed</span>}
                  {/* The tx hashes are what you actually came back for. */}
                  {(e.contracts || []).map((c) => (
                    <div key={c.address} className="hint">
                      <a href={`${explorer}/address/${c.address}`} target="_blank" rel="noreferrer">
                        {c.address}
                      </a>
                    </div>
                  ))}
                  {(e.results || [])
                    .filter((r) => r.error)
                    .map((r, n) => (
                      <div key={`${r.address}-${n}`} className="hint">
                        {r.address} — {r.error}
                      </div>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}
