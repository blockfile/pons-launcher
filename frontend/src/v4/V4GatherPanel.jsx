import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { eth } from './roles.js';

/**
 * Step 5 — gather the ETH back.
 *
 * Sweeps leftover ETH from a chosen set of wallets (funding, seeds, withdrawn) to a
 * super-main, THROUGH RELAY. Never direct: a direct seed → super-main transfer would
 * re-link the seasoned wallet to the super-main on chain, which is the one thing V4
 * exists to avoid. The backend refuses a direct path; this panel only offers Relay.
 *
 * Seed balances are tiny (0.0005), and the Relay fee + gas to move one usually exceeds
 * it, so most seeds are skipped as dust — the recoverable ETH is in the funding wallets.
 * A funder mid-campaign is never swept (it would starve the campaign).
 */
const CATS = [
  { key: 'funding', label: 'Funding wallets', hint: 'leftover after campaigns (any mid-campaign are skipped)' },
  { key: 'seeds', label: 'Seed wallets', hint: 'small funded balances — usually dust, mostly skipped' },
  { key: 'withdrawn', label: 'Withdrawn seeds', hint: 'seeds set aside from the pool' },
];

export default function V4GatherPanel({ step, masters = [], explorer, reload, report }) {
  const [busy, setBusy] = useState('');
  const [cats, setCats] = useState({ funding: true, seeds: false, withdrawn: false });
  const [dest, setDest] = useState('');
  const [preview, setPreview] = useState(null);
  const [arming, setArming] = useState(false);

  // Super-mains are the intended destination; fall back to every funding wallet if none
  // is flagged, so the panel still works before super-mains are designated.
  const supers = masters.filter((w) => w.isSuperMain);
  const destOptions = supers.length ? supers : masters;

  const chosen = Object.keys(cats).filter((k) => cats[k]);
  const ready = dest && chosen.length > 0;
  const query = () => `destinationId=${encodeURIComponent(dest)}&categories=${chosen.join(',')}`;

  async function act(what, fn) {
    setBusy(what);
    try {
      report(await fn());
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <Step {...step}>
      <p className="lede">
        Gathers leftover ETH from the wallets you choose to a super-main, <b>through Relay</b> — so no
        wallet is linked to the super-main on chain. Seed balances are tiny and usually skipped as dust;
        the recoverable ETH is in the funding wallets. A funder still running a campaign is left alone.
      </p>

      <div className="row">
        <label>
          to super-main
          <select
            value={dest}
            onChange={(e) => {
              setDest(e.target.value);
              setPreview(null);
            }}
          >
            <option value="">choose one…</option>
            {destOptions.map((w) => (
              <option key={w.id} value={w.id}>
                {w.address.slice(0, 10)}… ·{' '}
                {w.balanceEth == null ? 'unreadable' : `${Number(w.balanceEth).toFixed(4)} ETH`}
                {w.isSuperMain ? ' · super-main' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
        {CATS.map((c) => (
          <label key={c.key} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={Boolean(cats[c.key])}
              onChange={(e) => {
                setCats((p) => ({ ...p, [c.key]: e.target.checked }));
                setPreview(null);
              }}
              style={{ width: 'auto' }}
            />
            <span>
              {c.label} <span className="hint">· {c.hint}</span>
            </span>
          </label>
        ))}
      </div>

      <div className="row">
        <Busy
          busy={busy === 'preview'}
          className="btn-primary"
          disabled={!ready}
          onClick={() =>
            act('preview', async () => {
              const out = await api(`/v4/sweep/preview?${query()}`);
              setPreview(out);
              return `Gather preview: ${out.walletCount} wallet(s), ${out.totalEth} ETH.`;
            })
          }
        >
          Preview
        </Busy>
        <Busy
          busy={busy === 'sweep'}
          className="danger"
          disabled={!preview || !preview.walletCount}
          onClick={() => setArming(true)}
        >
          Gather to super-main
        </Busy>
      </div>

      {preview && (
        <div className="table-card" style={{ marginTop: 8 }}>
          {preview.wallets.length > 0 ? (
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
                      <Address value={w.address} plain href={explorer ? `${explorer}/address/${w.address}` : ''} />
                    </td>
                    <td>{w.role === 'v4master' ? 'funding' : 'seed'}</td>
                    <td className="num">{eth(w.balanceEth)}</td>
                    <td className="num">{eth(w.sendEth)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="hint">
              Nothing clears the dust floor — the chosen wallets are empty or hold less than it costs to
              move. Funding wallets are where the recoverable ETH is.
            </p>
          )}
          <p className="hint">
            {preview.walletCount} wallet(s) → <b>{preview.totalEth} ETH</b> to{' '}
            {preview.destination.address.slice(0, 10)}…
            {preview.skipped.length ? ` · ${preview.skipped.length} skipped (dust or empty)` : ''}
          </p>
        </div>
      )}

      <Modal
        open={arming}
        danger
        title={`Gather ${preview ? preview.walletCount : 0} wallet(s) to the super-main?`}
        question="Each wallet's balance is sent to the super-main through Relay — irreversible."
        confirmLabel="Gather it"
        onCancel={() => setArming(false)}
        onConfirm={async () => {
          await act('sweep', async () => {
            const out = await api('/v4/sweep', 'POST', {
              destinationId: dest,
              categories: chosen,
              minSweepEth: preview?.minSweepEth,
              confirm: true,
            });
            setPreview(null);
            await reload();
            return (
              `Gathered ${out.totals.sent}/${out.totals.wallets} wallet(s) — ${out.totals.eth} ETH.` +
              (out.totals.failed ? ` ${out.totals.failed} failed.` : '')
            );
          });
          setArming(false);
        }}
      >
        {preview && (
          <>
            <Fact label="Wallets">{preview.walletCount}</Fact>
            <Fact label="Total">{preview.totalEth} ETH</Fact>
            <Fact label="To" mono>
              {preview.destination.address}
            </Fact>
            <Fact label="Route">Relay — the wallets stay unlinked from the super-main</Fact>
          </>
        )}
      </Modal>
    </Step>
  );
}
