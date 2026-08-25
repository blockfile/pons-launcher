import { useEffect, useState } from 'react';
import { api, notify } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import BackupControls from '../components/BackupControls.jsx';
import { LuTrash2 } from 'react-icons/lu';
import IconButton from '../v4/IconButton.jsx';
import { MAX_GENERATE, ROLES, eth, plural } from './roles.js';

/**
 * Step 2 — the BUNDLE wallets, and the table the whole run is sized in. The
 * launcher (v5dev) has its own step 1 now (V5LauncherWalletPanel), mirroring the
 * pons v1 Launcher tab's split of "Create dev wallet" from "Generate bundle
 * wallets"; this panel is the v5bundle side only.
 *
 * The v5bundle wallets buy behind the launch and are the ones the Fund step
 * Relay-funds. THREE WAYS to bring them in — generate fresh, import keys you hold,
 * or claim aged/pre-funded ones from the V4 seasoning pool — and the table carries
 * each wallet's Fund and Buy amounts (the shared `rows`), which step 3 (Fund) and
 * step 4 (Launch + bundle) read.
 *
 * DELETE AND BACKUP ARE THE GENERIC CONTROLS, not v5's own. v5 exposes no
 * delete or backup route of its own — a wallet is deleted through
 * `DELETE /api/wallets/:id` (keyed on walletId, the field GET /v5/wallets
 * returns) and the whole keystore is exported through the shared BackupControls,
 * the same file every other console reaches for. The backup is the thing that
 * makes a delete survivable, so it is drawn right beside the deletes.
 *
 * WALLET SETUP ONLY. The launcher's value-OUT path — withdraw and the stuck-tx
 * rescue — used to live here, jammed in below the launcher's own address/
 * balance table. It moved to V5LauncherPanel, an unnumbered utility section at
 * the end of the console: this step is where wallets get set up, not where the
 * launcher's leftover ETH/USDG/token gets moved back out.
 */
// How many sells each wallet keeps gas for when the auto-fill sizes its fund —
// deliberately generous, since a wallet stranded holding a token it can't sell is
// worse than a slightly larger fund. Mirrors the v1 wallets table's own reserve.
const SELL_RESERVE = 3;

export default function V5WalletsPanel({ step, dev, bundle, explorer, reload, report, rows = {}, setRow = () => {} }) {
  const [busy, setBusy] = useState('');
  const [count, setCount] = useState(10);
  // "Distribute a total across the bundle" — the amount typed above the table,
  // and the live gas cost of a buy/sell so the auto-filled fund reserve is real.
  // Same shape the v1 wallets table (components/WalletsPanel.jsx) uses.
  const [totalBuy, setTotalBuy] = useState('');
  const [gas, setGas] = useState(null); // { buyGasEth, sellGasEth }
  // The wallet a delete is being asked about, or null. The whole record rather
  // than an id so the dialog can state its balance — the fact that decides
  // whether deleting it is a tidy-up or a mistake.
  const [deleting, setDeleting] = useState(null);

  // IMPORT — existing BUNDLE wallets by private key (the launcher is imported in
  // step 1's panel). Keys never linger in state past a submit — the field clears
  // only on success, see importBundleNow below.
  const [importKeys, setImportKeys] = useState('');
  const [importLabel, setImportLabel] = useState('');

  // CLAIM SEASONED — aged, pre-funded wallets handed off from the V4 tab's
  // pool. `seasoned.count` is read-only background state, same shape as the
  // v3/v4 consoles' own poll of the same endpoint: quiet on failure, because
  // an unreachable or disabled V4 should just show 0 here, not an error in a
  // panel that has nothing to do with it.
  const [seasoned, setSeasoned] = useState({ count: 0 });
  const [seasonedCount, setSeasonedCount] = useState(10);

  useEffect(() => {
    let alive = true;
    const load = () => api('/v4/seasoned').then((s) => alive && setSeasoned(s)).catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // The current cost of a buy and a sell, used only to size the auto-fill's fund
  // reserve. Read-only background fetch, quiet on failure like the seasoned poll.
  useEffect(() => {
    let alive = true;
    api('/gas')
      .then((g) => alive && setGas(g))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function act(what, fn) {
    setBusy(what);
    try {
      report(await fn());
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  /**
   * Split a typed total across the bundle wallets into a jittered spread and fill
   * each row's Buy AND Fund — the v1 wallets table's "distribute" (see
   * components/WalletsPanel.jsx), on letscash. Moves NO ETH: it only writes the
   * table fields the operator was about to type. Fund = the buy plus a gas reserve
   * (its own buy, plus a few sells) so a funded wallet can both buy and exit. Both
   * fields stay editable.
   */
  async function distribute() {
    const total = Number(totalBuy);
    if (!(total > 0)) return notify('Enter a total buy amount first.', 'error');
    if (!bundle.length) return notify('Generate bundle wallets before distributing.', 'error');

    let g = gas;
    if (!g) {
      try {
        g = await api('/gas');
        setGas(g);
      } catch {
        g = { buyGasEth: '0', sellGasEth: '0' };
      }
    }
    const reserve = Number(g.buyGasEth || 0) + SELL_RESERVE * Number(g.sellGasEth || 0);

    // ±30% jitter around equal, normalised to the exact total; the rounding drift
    // is pushed onto the last wallet so the sum is exactly what was typed.
    const weights = bundle.map(() => 1 + (Math.random() - 0.5) * 0.6);
    const wsum = weights.reduce((a, b) => a + b, 0);
    const amounts = bundle.map((_, i) => Math.round((weights[i] / wsum) * total * 1e6) / 1e6);
    const drift = Math.round((total - amounts.reduce((a, b) => a + b, 0)) * 1e6) / 1e6;
    amounts[amounts.length - 1] = Math.round((amounts[amounts.length - 1] + drift) * 1e6) / 1e6;

    bundle.forEach((w, i) => {
      const buy = amounts[i];
      setRow(w.walletId, { mode: 'fixed', buy: String(buy), fund: (buy + reserve).toFixed(6) });
    });
    report(
      `distributed ${total} ETH across ${bundle.length} wallets — each funded for its buy plus gas for ` +
        `${SELL_RESERVE} sells. Nothing was sent; set the first buy and launch in step 4.`
    );
    notify(`Filled ${bundle.length} wallets for ${total} ETH. No ETH moved — edit, then Fund in step 2.`, 'ok');
  }

  /**
   * Import existing BUNDLE wallets by private key. The backend does the
   * whitespace/comma/newline splitting (routes/v5.js), so the raw text is sent
   * as-is. The field is cleared ONLY on success, so a rejected import leaves it
   * alone to fix without re-pasting; the keys are never echoed anywhere else.
   * (The launcher key is imported in step 1's panel.)
   */
  async function importBundleNow() {
    if (!importKeys.trim()) return;
    setBusy('import');
    try {
      const made = await api('/v5/wallets/import', 'POST', {
        privateKeys: importKeys,
        role: ROLES.bundle,
        label: importLabel.trim() || undefined,
      });
      report(`imported ${plural(made.length, 'wallet')} into the bundle`);
      setImportKeys('');
      setImportLabel('');
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  /** Pull N aged, pre-funded wallets out of the V4 seasoning pool into the v5 bundle role. */
  async function claimSeasoned() {
    setBusy('claim-seasoned');
    try {
      const n = Math.max(1, Math.round(Number(seasonedCount) || 0));
      const out = await api('/v5/wallets/claim-seasoned', 'POST', { count: n });
      report(
        out.available === 0
          ? 'claimed 0 — none available, season some in the V4 tab first'
          : out.shortfall > 0
            ? `claimed ${plural(out.claimed.length, 'wallet')} — only ${out.available} seasoned wallet(s) were available`
            : `claimed ${plural(out.claimed.length, 'seasoned wallet')}`
      );
      await reload();
      try {
        setSeasoned(await api('/v4/seasoned'));
      } catch {
        // Background read — see the mount-time poll above.
      }
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  // Clamped where it is typed, not where it is sent: the field must never offer a
  // number the server has already decided to refuse.
  const wanted = Math.min(MAX_GENERATE, Math.max(1, Math.round(Number(count) || 0)));
  // Both roles, for the shared backup's count and disabled state — the file it
  // writes is the whole keystore regardless, but the button should light up as
  // soon as v5 has a wallet in it.
  const allWallets = [dev, ...bundle].filter(Boolean);

  // The run at a glance, for the summary tiles. `fundedBundle` counts wallets that
  // actually hold ETH (so "generated" and "funded" don't read as the same thing);
  // `totalBuyEth` sums the fixed buy amounts typed in the table (an "all − gas"
  // wallet has no fixed figure, so it is not counted here).
  const fundedBundle = bundle.filter((w) => Number(w.balanceEth) > 0).length;
  const totalBuyEth = bundle.reduce(
    (s, w) => s + (rows[w.walletId]?.mode === 'all' ? 0 : Number(rows[w.walletId]?.buy) || 0),
    0
  );

  const explorerFor = (address) => (explorer ? `${explorer}/address/${address}` : '');

  return (
    <Step {...step}>
      <p className="lede">
        The bundle wallets buy behind the launcher's first buy. This table is where the run is sized —
        what each wallet is <b>funded</b> with (sent via Relay in step 3) and what it <b>buys</b> (step 4)
        — the same shape as the Launcher tab. Nothing moves yet; the amounts here flow to those steps.
      </p>

      {/* The run at a glance, across the top of the step — the counts and figures
          the bundle is judged by, lifted out of the table below. Read-only: every
          value here is already set in the table or read from chain. */}
      <div className="stats">
        <div className="stat">
          <span>Bundle wallets</span>
          <b>{bundle.length}</b>
          <span className="stat-of">no exemption cap on letscash</span>
        </div>
        <div className="stat">
          <span>Funded</span>
          <b>
            {fundedBundle} <span className="stat-of">of {bundle.length}</span>
          </b>
        </div>
        <div className="stat">
          <span>Bundle buy</span>
          <b>{totalBuyEth > 0 ? `${totalBuyEth.toFixed(4)} ETH` : '—'}</b>
        </div>
        <div className={`stat ${dev && Number(dev.balanceEth) > 0 ? 'ok' : ''}`}>
          <span>Launcher</span>
          <b>{dev ? `${eth(dev.balanceEth)} ETH` : '—'}</b>
        </div>
      </div>

      {!dev && (
        <div className="notice warn">
          <h3>No launcher wallet yet</h3>
          <p>Create it in step 1 first — the bundle wallets buy behind its launch, and it funds them.</p>
        </div>
      )}

      {/* The bundle — plural, generated in a batch. THREE WAYS IN: fresh
          (Generate), keys the operator already holds (Import), or aged/pre-funded
          ones handed off from V4's seasoning pool (Seasoned). */}
      <div className="row">
        <span className="ctl-label">Generate</span>
        <input
          type="number"
          min="1"
          max={MAX_GENERATE}
          value={count}
          onChange={(e) => setCount(e.target.value)}
          style={{ width: 90 }}
        />
        <Busy
          busy={busy === 'gen-bundle'}
          className="btn-primary"
          onClick={() =>
            act('gen-bundle', () =>
              api('/v5/wallets/generate', 'POST', {
                count: wanted,
                role: ROLES.bundle,
                label: 'v5 bundle',
              })
            )
          }
        >
          Generate wallets
        </Busy>
        {/* The shared backup, beside the deletes it makes survivable. Every other
            console reaches for this same control; v5 has no reason to differ. */}
        <BackupControls wallets={allWallets} report={report} />
        <span className="spacer" />
        {bundle.length > 0 && (
          <span className="hint">{plural(bundle.length, 'bundle wallet')}</span>
        )}
      </div>
      <p className="hint" style={{ margin: '0 0 12px' }}>
        {MAX_GENERATE} at a time is the ceiling. Unlike v1/v2 there is no 31-wallet cap — letscash has
        no exemption list, so the only cost of more wallets is a longer fan-out. Run it again for more.
      </p>

      {/* IMPORT — bundle wallets the operator already holds the key for. Fresh
          wallets are a fingerprint (they all share a birth timestamp); keys
          brought in from elsewhere do not. This imports into the bundle role
          only — the launcher key is imported up in the Launcher section. */}
      <div className="row">
        <span className="ctl-label">Import</span>
        <input
          value={importLabel}
          onChange={(e) => setImportLabel(e.target.value)}
          placeholder="label (optional)"
          style={{ width: 160 }}
        />
        <Busy busy={busy === 'import'} disabled={!importKeys.trim()} onClick={importBundleNow}>
          Import
        </Busy>
      </div>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <span className="ctl-label" />
        <textarea
          rows={3}
          value={importKeys}
          onChange={(e) => setImportKeys(e.target.value)}
          placeholder="0x… one per line, or comma-separated"
          spellCheck={false}
          autoComplete="off"
          style={{ flex: 1 }}
        />
      </div>
      <p className="hint" style={{ margin: '0 0 12px' }}>
        Each key is encrypted straight into the keystore and never logged or shown again — the field
        clears itself once the import succeeds. These land in the bundle; to import your launcher key,
        use the Launcher wallet section above.
      </p>

      {/* SEASONED — aged, pre-funded wallets from the V4 tab's pool, pulled
          into the bundle role most-aged first. The point of seasoning: these
          look organic on-chain where a batch of fresh wallets does not. */}
      <div className="row">
        <span className="ctl-label">Seasoned</span>
        <input
          type="number"
          min="1"
          max={seasoned.count || 1}
          value={seasonedCount}
          onChange={(e) => setSeasonedCount(e.target.value)}
          title="how many seasoned wallets to claim"
          style={{ width: 70 }}
        />
        <Busy
          busy={busy === 'claim-seasoned'}
          disabled={!seasoned.count}
          title={seasoned.count ? '' : 'no seasoned wallets ready yet'}
          onClick={claimSeasoned}
        >
          Claim seasoned
        </Busy>
        <span className="hint">{seasoned.count} seasoned ready</span>
      </div>
      <p className="hint" style={{ margin: '0 0 12px' }}>
        Aged, pre-funded wallets seasoned in the V4 tab — they read as organic rather than as a batch
        generated together. If none are ready, season some there first.
      </p>

      {/* AUTO-FILL — type one total and spread it across the bundle as a jittered
          split, filling each wallet's Buy and its Fund (buy + gas). Moves no ETH;
          the same control the v1 wallets table carries. */}
      {bundle.length > 0 && (
        <div className="distribute">
          <b className="distribute-title">Auto-fill buys</b>
          <label style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            Total buy
            <input
              type="number"
              min="0"
              step="0.01"
              placeholder="0.5"
              value={totalBuy}
              onChange={(e) => setTotalBuy(e.target.value)}
              style={{ width: 90 }}
            />
            ETH
          </label>
          <Busy className="ghost" disabled={!(Number(totalBuy) > 0)} onClick={distribute}>
            Distribute across {bundle.length} wallet{bundle.length === 1 ? '' : 's'}
          </Busy>
          <span className="hint">
            random split · each funded for its buy + gas for {SELL_RESERVE} sells · fields stay editable ·
            moves no ETH
          </span>
        </div>
      )}

      {bundle.length === 0 ? (
        <div className="notice">
          <h3>No bundle wallets yet</h3>
          <p>
            These are the wallets that buy behind the launcher's first buy. Generate however many the
            strategy wants, then set each one's Fund and Buy below — nothing moves until a later step.
          </p>
        </div>
      ) : (
        <div className="table-scroll" style={{ maxHeight: 460, overflowY: 'auto' }}>
          <table className="wallet-list">
            <thead>
              <tr>
                <th className="num">No.</th>
                <th>Address</th>
                <th className="num">Balance</th>
                <th className="num">Fund (ETH)</th>
                <th>Buy mode</th>
                <th className="num">Buy (ETH)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {bundle.map((w, i) => {
                const row = rows[w.walletId] || {};
                return (
                <tr key={w.walletId}>
                  <td className="num hint">{i + 1}</td>
                  <td>
                    <Address value={w.address} plain href={explorerFor(w.address)} />
                  </td>
                  <td className="num">
                    {w.balanceEth == null ? <span className="hint">unreadable</span> : eth(w.balanceEth)}
                  </td>
                  {/* Fund is what step 3 Relay-sends this wallet; Buy is what it
                      spends buying in step 4 (Launch + bundle). Both are owned by
                      the console's shared `rows`, so the Fund and Launch steps read
                      exactly what is typed here. */}
                  <td className="num">
                    <input
                      type="number"
                      step="0.0001"
                      placeholder="0.0"
                      value={row.fund ?? ''}
                      onChange={(e) => setRow(w.walletId, { fund: e.target.value })}
                      style={{ width: 100 }}
                    />
                  </td>
                  <td>
                    <select value={row.mode ?? 'fixed'} onChange={(e) => setRow(w.walletId, { mode: e.target.value })}>
                      <option value="fixed">fixed</option>
                      <option value="all">all − gas</option>
                    </select>
                  </td>
                  <td className="num">
                    <input
                      type="number"
                      step="0.0001"
                      placeholder="0.0"
                      // "all − gas" is resolved server-side from the live balance,
                      // so a typed amount here would be meaningless.
                      disabled={row.mode === 'all'}
                      value={row.mode === 'all' ? '' : row.buy ?? ''}
                      onChange={(e) => setRow(w.walletId, { buy: e.target.value })}
                      style={{ width: 100 }}
                    />
                  </td>
                  <td className="num">
                    <IconButton
                      icon={LuTrash2}
                      danger
                      label={`Delete bundle wallet ${w.address}`}
                      onClick={() => setDeleting(w)}
                    />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* The key is archived, not destroyed — said plainly, because a dialog that
          implies irreversibility teaches an operator to distrust the one place it
          really is. If the wallet holds ETH, sweeping is a later step; deleting
          does not move it. */}
      <Modal
        open={Boolean(deleting)}
        danger
        title={`Delete ${deleting?.role === ROLES.dev ? 'launcher' : 'bundle'} wallet ${
          deleting ? deleting.address.slice(0, 10) : ''
        }…?`}
        question={
          deleting && deleting.balanceEth != null && Number(deleting.balanceEth) > 0
            ? 'It still holds ETH. Deleting does not move it — the balance stays at the address, reachable only by restoring the key.'
            : 'Its key is archived on the server, not destroyed. Nothing in this console will send from it again.'
        }
        confirmLabel="Delete it"
        onConfirm={() => {
          const w = deleting;
          setDeleting(null);
          act('delete', () => api(`/wallets/${w.walletId}`, 'DELETE'));
        }}
        onCancel={() => setDeleting(null)}
      >
        {deleting && (
          <>
            <Fact label="Address" mono>
              {deleting.address}
            </Fact>
            <Fact label="Balance">
              {deleting.balanceEth == null ? 'unreadable' : `${eth(deleting.balanceEth)} ETH`}
            </Fact>
          </>
        )}
      </Modal>
    </Step>
  );
}
