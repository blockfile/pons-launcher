import { useEffect, useState } from 'react';
import { api } from '../api.js';

// Colour carries the meaning here, so each kind gets one that matches what it
// costs you to get wrong: money moving, contracts, and key material. An admin
// view is none of those, so it is grey — see the palette note in styles.css.
const KINDS = {
  fund: 'moved',
  sweep: 'moved',
  deploy: 'built',
  wallets: 'keys',
  export: 'keys',
  admin: 'seen',
};

/**
 * What this user has done, read back later.
 *
 * Launches have their own panel with the full plan; this is everything else —
 * funding, sweeps, deploys, wallets appearing and leaving, key exports. Before
 * it existed, a funding run that half-failed left no trace once the tab was
 * closed.
 *
 * Scoped to the caller, like the wallets and the history, with one exception:
 * a user named in ADMIN_USERS on the server may read another user's log, and
 * gets the selector below to do it. Everyone else never sees the selector, and
 * the backend ignores the parameter it would set — the flag decides what is
 * drawn, never what is allowed.
 *
 * Reading someone else's log writes a line into the ADMIN's own log, so the
 * looking is itself on the record. That is worth knowing before you look,
 * hence the note under the selector rather than a surprise afterwards.
 */
export default function ActivityPanel({ explorer, credential, admin = false, me = '' }) {
  // Rows and whose they are, set together and never separately. Labelling the
  // table from the selector instead would put "alice's log — not yours" above
  // your own entries for as long as the read takes, which is precisely the
  // misreading this panel has to make impossible.
  const [view, setView] = useState(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');
  // Empty string means "my own log", which is what every non-admin gets and
  // what an admin starts on. Never seeded from anywhere else: landing on
  // somebody else's log by default is how you misread one as your own.
  const [viewing, setViewing] = useState('');
  const [people, setPeople] = useState([]);

  async function load() {
    // Captured before the await: by the time it resolves the selector may have
    // moved on, and these rows belong to whoever was asked for, not to whoever
    // is selected now.
    const asked = viewing;
    try {
      const rows = await api(
        `/activity?limit=100${filter ? `&kind=${filter}` : ''}${
          asked ? `&user=${encodeURIComponent(asked)}` : ''
        }`
      );
      setView({ owner: asked || me, entries: rows });
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
  }, [credential, filter, viewing]);

  // A new credential is a different person: drop back to their own log rather
  // than leaving the previous operator's selection pointing at a stranger.
  useEffect(() => {
    setViewing('');
  }, [credential]);

  // The selector's contents are admin-only on the server too; asking as anyone
  // else is a 403, so it is not even requested.
  useEffect(() => {
    if (!admin || !credential) {
      setPeople([]);
      return undefined;
    }
    let live = true;
    api('/users')
      .then((list) => live && setPeople(list))
      // A selector that cannot be filled is not an error worth taking the
      // panel down for — the log itself still reads.
      .catch(() => live && setPeople([]));
    return () => {
      live = false;
    };
  }, [admin, credential]);

  if (error) return credential ? <p className="hint">activity unavailable — {error}</p> : null;
  if (!view) return null;

  const { owner, entries } = view;
  const others = people.filter((p) => p.id !== me);
  // Whose log is ON SCREEN — not whose was last asked for.
  const elsewhere = Boolean(owner) && owner !== me;

  return (
    <details className="disperse-panel">
      <summary>
        Activity
        <span className="hint" style={{ marginLeft: 8 }}>
          {/* Whose log this is belongs in the one line that is visible while
              the panel is closed, not only inside it. */}
          {elsewhere ? `${owner}'s log — not yours` : null}
          {elsewhere ? ' · ' : null}
          {entries.length
            ? `last ${entries.length} actions${elsewhere ? '' : ' on this account'}`
            : 'nothing recorded yet'}
        </span>
      </summary>

      <p className="lede">
        Funding, sweeps, contract deploys, wallets and key exports —{' '}
        {elsewhere ? `${owner}'s, read as an admin` : 'yours only'}. Launches have their own panel
        below. Private keys are never written here; an export is recorded as the fact that it
        happened.
      </p>

      {admin && (
        <div className="row">
          <label className="hint">
            reading
            <select
              value={viewing}
              onChange={(e) => setViewing(e.target.value)}
              style={{ marginLeft: 6 }}
            >
              <option value="">{me ? `${me} (you)` : 'your own log'}</option>
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <span className="spacer" />
          <span className="hint">
            you are an admin — opening someone else&apos;s log is recorded in yours
          </span>
        </div>
      )}

      {/* Amber, not vermilion: reading is not irreversible. But it must be
          impossible to glance at this table and take it for your own. */}
      {elsewhere && (
        <div className="notice warn">
          <h3>viewing {owner}&apos;s activity</h3>
          <ul>
            <li>
              These are {owner}&apos;s actions, not yours. Nothing here is anything you did.
            </li>
            <li>
              {me ? `${me}'s` : 'Your'} own log records that you opened this one.
            </li>
          </ul>
        </div>
      )}

      <div className="row">
        {/* `admin` only for an admin: it is the one kind nobody else can have,
            and offering the filter would advertise that the role exists. */}
        {['', 'fund', 'sweep', 'deploy', 'wallets', 'export']
          .concat(admin ? ['admin'] : [])
          .map((k) => (
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
        <table className="activity-list" data-elsewhere={elsewhere ? 'yes' : undefined}>
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
