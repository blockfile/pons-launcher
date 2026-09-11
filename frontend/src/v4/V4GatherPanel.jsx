import { useRef, useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { eth, plural } from './roles.js';
import { sumWei, weiToEth } from './weiTotal.js';

/**
 * Step 5 — sweep the funders' leftover ETH to one super-main.
 *
 * FUNDERS ONLY. Aged seed wallets are never swept, and neither are the other super-mains:
 * the backend refuses any wallet that is not a funder, so nothing this panel sends can reach
 * one. A funder still running a campaign is skipped.
 *
 * Two routes, chosen per sweep:
 *   Relay  (default) the funder stays unlinked from the super-main on chain. A Relay fee +
 *          gas per funder; small balances fall under the dust floor.
 *   Direct a plain send, gas only — recovers almost everything, and publicly links every
 *          funder swept to the super-main, and so to each other. No seed gets a direct
 *          edge, but each funder's seeds end up one Relay hop from the super-main.
 *
 * The preview lists every funder it would sweep, all ticked. Untick any to leave it holding
 * its ETH; only the ticked ones are sent.
 *
 * WHAT IS CONFIRMED IS WHAT WAS PREVIEWED. The POST sends the preview's route and
 * destination, so the dialog and the warning read the preview too — never the live selects —
 * and a preview that comes back after the selects changed is thrown away rather than shown
 * under a route it was not made for.
 */
const ROUTES = [
  { key: 'relay', label: 'Relay — funders stay unlinked (≈3% fee, dust floor)' },
  { key: 'direct', label: 'Direct — gas only, links each funder to the super-main' },
];

/** The one line the result panel shows after a sweep. */
function summarise(out) {
  const t = out.totals;
  const how = out.route === 'direct' ? 'directly' : 'through Relay';
  return (
    `${out.dryRun ? '[dry run — nothing signed] ' : ''}Swept ${t.moved}/${t.wallets} funder(s) ${how} — ${t.eth} ETH.` +
    (t.failed ? ` ${t.failed} failed.` : '') +
    (t.pending ? ` ${t.pending} pending — no receipt yet, check the explorer.` : '') +
    (t.notAttempted ? ` ${t.notAttempted} not attempted — Relay is rate-limiting; run the sweep again in a minute.` : '') +
    (out.skipped.length ? ` ${out.skipped.length} skipped.` : '') +
    (out.logWarning ? ` WARNING: ${out.logWarning}` : '')
  );
}

export default function V4GatherPanel({ step, masters = [], explorer, reload, report }) {
  const [busy, setBusy] = useState('');
  const [dest, setDest] = useState('');
  const [route, setRoute] = useState('relay');
  const [preview, setPreview] = useState(null);
  const [ticked, setTicked] = useState([]);
  const [arming, setArming] = useState(false);
  // Bumped by every reset; a preview whose number is stale when it returns is discarded.
  const previewSeq = useRef(0);

  const supers = masters.filter((w) => w.isSuperMain);
  // A super-main un-flagged in step 1 after being chosen here is no longer a destination.
  const destOk = supers.some((w) => w.id === dest);
  const rows = preview ? preview.wallets : [];
  const tickedRows = rows.filter((w) => ticked.includes(w.walletId));
  const tickedEth = weiToEth(sumWei(tickedRows));
  const allTicked = rows.length > 0 && tickedRows.length === rows.length;
  // The route a confirm would actually send: the preview's once there is one.
  const direct = (preview ? preview.route : route) === 'direct';

  const reset = () => {
    previewSeq.current += 1;
    setPreview(null);
    setTicked([]);
  };
  const toggleTick = (id) => setTicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const toggleAll = () => setTicked(allTicked ? [] : rows.map((w) => w.walletId));
  const link = (address) => (explorer ? `${explorer}/address/${address}` : '');

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
        Sweeps leftover ETH from your <b>funders</b> to one super-main. Aged seed wallets and the other
        super-mains are never touched, and a funder still running a campaign is left alone.
      </p>

      {supers.length === 0 && (
        <p className="hint">
          No super-main yet — flag one in step 1 (the ↑ arrow on a funding wallet), then sweep the funders to it.
        </p>
      )}

      <div className="row">
        <label>
          to super-main
          <select
            value={destOk ? dest : ''}
            disabled={supers.length === 0 || busy !== ''}
            onChange={(e) => {
              setDest(e.target.value);
              reset();
            }}
          >
            <option value="">choose one…</option>
            {supers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.address.slice(0, 10)}… ·{' '}
                {w.balanceEth == null ? 'unreadable' : `${Number(w.balanceEth).toFixed(4)} ETH`}
              </option>
            ))}
          </select>
        </label>
        <label>
          route
          <select
            value={route}
            disabled={busy !== ''}
            onChange={(e) => {
              setRoute(e.target.value);
              reset();
            }}
          >
            {ROUTES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {direct && (
        <p className="hint">
          <b>Direct links on-chain:</b> every funder swept shows up sending straight to this super-main, so the
          funders and the super-main become publicly tied together. No seed gets a direct link, but each funder's
          seeds are then one Relay hop from the super-main — and Relay's order history can connect that hop.
        </p>
      )}

      <div className="row">
        <Busy
          busy={busy === 'preview'}
          className="btn-primary"
          disabled={!destOk}
          onClick={() =>
            act('preview', async () => {
              previewSeq.current += 1;
              const mine = previewSeq.current;
              const out = await api(`/v4/sweep/preview?destinationId=${encodeURIComponent(dest)}&route=${route}`);
              if (mine !== previewSeq.current) {
                return 'Preview discarded — the super-main or route changed while it loaded. Preview again.';
              }
              setPreview(out);
              setTicked(out.wallets.map((w) => w.walletId));
              return `Sweep preview (${out.route}): ${plural(out.walletCount, 'funder')}, ${out.totalEth} ETH.`;
            })
          }
        >
          Preview
        </Busy>
        <Busy
          busy={busy === 'sweep'}
          className="danger"
          disabled={tickedRows.length === 0}
          onClick={() => setArming(true)}
        >
          Sweep {plural(tickedRows.length, 'funder')}
        </Busy>
      </div>

      {preview && (
        <div className="table-card" style={{ marginTop: 8 }}>
          {rows.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <input type="checkbox" checked={allTicked} onChange={toggleAll} aria-label="tick every funder" />
                  </th>
                  <th>Funder</th>
                  <th className="num">Balance</th>
                  <th className="num">Sends</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((w) => (
                  <tr key={w.walletId} className={ticked.includes(w.walletId) ? 'is-on' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        checked={ticked.includes(w.walletId)}
                        onChange={() => toggleTick(w.walletId)}
                        aria-label={`Sweep ${w.address}`}
                      />
                    </td>
                    <td>
                      <Address value={w.address} plain href={link(w.address)} />
                    </td>
                    <td className="num">{eth(w.balanceEth)}</td>
                    <td className="num">{eth(w.sendEth)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="hint">
              No funder has anything to sweep{preview.route === 'relay' ? ' above the dust floor' : ''} — see why
              below.
            </p>
          )}
          <p className="hint">
            {tickedRows.length} of {rows.length} ticked → <b>{tickedEth} ETH</b> to{' '}
            {preview.destination.address.slice(0, 10)}… by {preview.route === 'direct' ? 'direct send' : 'Relay'}
          </p>
          {preview.skipped.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Skipped</th>
                  <th className="num">Balance</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {preview.skipped.map((s) => (
                  <tr key={s.walletId}>
                    <td>
                      <Address value={s.address} plain href={link(s.address)} />
                    </td>
                    <td className="num">{s.balanceEth == null ? '—' : eth(s.balanceEth)}</td>
                    <td>
                      <span className="hint">{s.reason}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      <Modal
        open={arming}
        danger
        title={`Sweep ${plural(tickedRows.length, 'funder')} to the super-main?`}
        question={
          direct
            ? 'Each ticked funder sends its balance straight to the super-main — irreversible, and it publicly links the funders to the super-main.'
            : "Each ticked funder's balance goes to the super-main through Relay — irreversible."
        }
        confirmLabel="Sweep them"
        onCancel={() => setArming(false)}
        onConfirm={async () => {
          await act('sweep', async () => {
            const out = await api('/v4/sweep', 'POST', {
              destinationId: preview.destination.walletId,
              route: preview.route,
              walletIds: tickedRows.map((w) => w.walletId),
              minSweepEth: preview.minSweepEth,
              confirm: true,
            });
            reset();
            await reload();
            return summarise(out);
          });
          setArming(false);
        }}
      >
        {preview && (
          <>
            <Fact label="Funders">{tickedRows.length}</Fact>
            <Fact label="Total">{tickedEth} ETH</Fact>
            <Fact label="To" mono>
              {preview.destination.address}
            </Fact>
            <Fact label="Route">
              {preview.route === 'direct'
                ? 'Direct — each funder is linked to the super-main on-chain'
                : 'Relay — the funders stay unlinked from the super-main'}
            </Fact>
          </>
        )}
      </Modal>
    </Step>
  );
}
