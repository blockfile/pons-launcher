import { useEffect, useState } from 'react';
import { api } from '../api.js';
import Section, { Busy } from './Section.jsx';
import Address from './Address.jsx';

/**
 * Enable holder-fee sharing for a launched pons v2 token.
 *
 * A post-launch, v2-only action, so it lives in its own panel below the sell
 * step rather than inside the numbered sequence — the same way the v2 tabs keep
 * their strategies detachable. It does two things on chain, both signed by the
 * token's CURRENT creator-fee recipient:
 *
 *   1. deploy the token's holder-fee distributor (once, reused forever), and
 *   2. re-point the creator fee at it.
 *
 * After that the creator's cut of every trade is paid to holders instead of one
 * wallet — in the token's PAIR asset (ETH, or whatever it launched against).
 *
 * It only works when the signing wallet is the current recipient AND the token
 * launched with a non-zero creator tax — otherwise there are simply no fees to
 * share. The panel reads /status to say which of those is true before offering
 * the button, and the backend refuses anything that would only revert.
 */
export default function HolderFeesPanel({ explorer, credential, live, wallets = [] }) {
  const [tokens, setTokens] = useState([]); // launched v2 tokens, for the dropdown
  const [token, setToken] = useState('');
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState(null);

  // A best-effort list of this account's launched v2 tokens, so the operator can
  // pick rather than paste. A 404 (a build without the sell routes) is not an
  // error here — the address field still works.
  async function loadTokens() {
    try {
      const list = await api('/sellable?variant=v2');
      setTokens(Array.isArray(list) ? list : []);
    } catch {
      setTokens([]);
    }
  }

  useEffect(() => {
    const t = setTimeout(loadTokens, credential ? 400 : 0);
    return () => clearTimeout(t);
  }, [credential]);

  // A changed token invalidates the status shown for the previous one.
  useEffect(() => {
    setStatus(null);
    setNote(null);
  }, [token]);

  const valid = /^0x[0-9a-fA-F]{40}$/.test(token.trim());

  // Whether the current recipient is a wallet this console can sign from. The
  // transfer must be signed by it, so if it is not here the operator has to
  // import its key first — said plainly rather than discovered as a failed send.
  const recipient = status?.creatorFeeRecipient || '';
  const held =
    recipient &&
    wallets.some((w) => (w.address || '').toLowerCase() === recipient.toLowerCase());

  async function act(name, fn) {
    setBusy(name);
    setNote(null);
    try {
      const out = await fn();
      if (typeof out === 'string') setNote({ ok: true, text: out });
      return out;
    } catch (err) {
      setNote({ ok: false, text: err.message });
      return null;
    } finally {
      setBusy('');
    }
  }

  const checkStatus = () =>
    act('status', async () => {
      const s = await api(`/v2/holder-fees/status?token=${encodeURIComponent(token.trim())}`);
      setStatus(s);
      if (!s.exists) return 'that address is not a pons v2 launch';
      return null;
    });

  const enable = () =>
    act('enable', async () => {
      const out = await api('/v2/holder-fees/enable', 'POST', {
        token: token.trim(),
        wallet: status.creatorFeeRecipient,
      });
      await checkStatus();
      const pair = status?.pairSymbol || 'the pair asset';
      return (
        `holder fee sharing is on — creator fees now go to holders (paid in ${pair}). ` +
        `Distributor ${out.distributor}` +
        (out.alreadyExisted ? ' (existing distributor reused)' : '')
      );
    });

  const noTax = status?.exists && Number(status.creatorTaxBps) === 0;
  const canEnable =
    live &&
    status?.exists &&
    !status.sharingEnabled &&
    !noTax &&
    held &&
    !busy;

  return (
    <Section title="Enable holder fee sharing (V2)">
      <p className="lede">
        Route a launched token&apos;s creator fee to its <strong>holders</strong> instead of a
        single wallet. It deploys the token&apos;s distributor and points the creator-fee recipient
        at it — two real on-chain transactions, signed by the token&apos;s current creator-fee
        recipient. Fees are paid in the token&apos;s pair asset.
      </p>

      <div className="notice">
        <h3>before it will work</h3>
        <ul>
          <li>The signing wallet must be the token&apos;s <strong>current</strong> creator-fee recipient.</li>
          <li>
            The token must have launched with a <strong>non-zero creator tax</strong> — with no tax
            there are no fees to share.
          </li>
          <li>It is idempotent: an existing distributor is reused, and it is safe to retry.</li>
        </ul>
      </div>

      <div className="row" style={{ alignItems: 'center', gap: 8 }}>
        <label className="hint" style={{ flex: 1, minWidth: 0 }}>
          token
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="0x… launched v2 token"
            style={{ width: '100%', marginLeft: 6 }}
          />
        </label>
        <Busy busy={busy === 'status'} className="ghost" disabled={!valid} onClick={checkStatus}>
          Check
        </Busy>
      </div>

      {tokens.length > 0 && (
        <div className="row" style={{ alignItems: 'center', gap: 8 }}>
          <span className="hint">or pick a launched token</span>
          <select
            value=""
            onChange={(e) => e.target.value && setToken(e.target.value)}
            style={{ flex: 1, minWidth: 0 }}
          >
            <option value="" disabled>
              choose…
            </option>
            {tokens.map((t) => (
              <option key={t.token} value={t.token}>
                {(t.symbol || '—') + ' — ' + t.token}
              </option>
            ))}
          </select>
        </div>
      )}

      {note && (
        <div className={`notice ${note.ok ? '' : 'warn'}`}>
          <h3>{note.ok ? 'done' : 'that did not work'}</h3>
          <ul>
            <li>{note.text}</li>
          </ul>
        </div>
      )}

      {status?.exists && (
        <div className="table-scroll">
          <table className="disperser-list">
            <tbody>
              <tr>
                <td className="hint">creator-fee recipient</td>
                <td>
                  <Address
                    value={status.creatorFeeRecipient}
                    href={`${explorer}/address/${status.creatorFeeRecipient}`}
                  />
                  {!held && !status.sharingEnabled && (
                    <span className="hint"> — not a wallet in this keystore; import its key to sign</span>
                  )}
                </td>
              </tr>
              <tr>
                <td className="hint">creator tax</td>
                <td className={noTax ? 'hint' : ''}>
                  {(Number(status.creatorTaxBps) / 100).toFixed(2)}%
                  {noTax ? ' — zero, so there are no fees to share' : ''}
                </td>
              </tr>
              <tr>
                <td className="hint">sharing</td>
                <td>
                  {status.sharingEnabled ? (
                    <>
                      <strong>on</strong> → distributor{' '}
                      <Address
                        value={status.distributor}
                        href={`${explorer}/address/${status.distributor}`}
                      />
                    </>
                  ) : status.distributor ? (
                    <>
                      off — distributor exists (
                      <Address
                        value={status.distributor}
                        href={`${explorer}/address/${status.distributor}`}
                      />
                      ) but the recipient is not pointed at it
                    </>
                  ) : (
                    'off — no distributor yet'
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {status?.exists && !status.sharingEnabled && (
        <div className="row">
          <span className="hint">
            {!live
              ? 'dry run — enabling is disabled; nothing would be broadcast'
              : noTax
                ? 'this token has no creator tax, so enabling would share nothing'
                : !held
                  ? 'the current recipient is not in this keystore — import its key first'
                  : 'deploys the distributor if needed, then re-points the creator fee at it'}
          </span>
          <span className="spacer" />
          <Busy busy={busy === 'enable'} disabled={!canEnable} onClick={enable}>
            {live ? 'Enable holder fee sharing' : 'Enable (dry run disabled)'}
          </Busy>
        </div>
      )}

      {status?.sharingEnabled && (
        <p className="hint">
          Sharing is already on — the creator fee is paid to holders through the distributor above.
        </p>
      )}
    </Section>
  );
}
