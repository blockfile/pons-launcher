import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Address from '../components/Address.jsx';
import Modal from '../components/Modal.jsx';
import V4BackupControls from './V4BackupControls.jsx';
import { ROLES, eth } from './roles.js';

/**
 * Step 1 — the funding wallets.
 *
 * One of these pays for a campaign and does nothing else: never buys, never
 * sells, never holds supply. Its address is the single edge every seeded wallet
 * shares, which is why it is a wallet of its own rather than a trading one.
 *
 * THIS LIST IS PLURAL AND EVERY OTHER TREASURY IN THE CONSOLE IS A SINGLETON,
 * and the reason is the nonce. Two campaigns sending from one wallet both read
 * the same pending nonce and the second broadcast silently REPLACES the first —
 * no error anywhere, one transfer simply gone, and a wallet recorded as funded
 * that never received anything. So the runner refuses a second campaign on a
 * busy wallet, and a campaign meant to run alongside another needs a funding
 * wallet of its own. That is the only reason to make more than one.
 *
 * Nothing here deletes. The V4 routes expose no delete at all, deliberately:
 * the wallet in this table may be halfway through signing a three-week
 * schedule, and there is no seed phrase behind it to recover from.
 */
export default function V4FundingPanel({
  step,
  wallets,
  seeds = [],
  planDefaults,
  campaignFor,
  explorer,
  reload,
  report,
}) {
  const [busy, setBusy] = useState('');
  // Import is folded away by default. Generating is the ordinary path and the
  // one with no caveat attached; pasting a private key is neither, so it is a
  // thing you go and open rather than a thing sitting under the cursor.
  const [showImport, setShowImport] = useState(false);
  const [keys, setKeys] = useState('');
  const [showSplit, setShowSplit] = useState(false);
  const [source, setSource] = useState('');
  // What each funder is being filled FOR, rather than how much to send it. The
  // amount is arithmetic on this, and it is arithmetic an operator should not
  // be doing by hand — see splitSizing below.
  const [seedsPer, setSeedsPer] = useState(4);
  const [split, setSplit] = useState(null);
  // The wallet a delete is being asked about, or null. Held as the whole record
  // rather than an id so the dialog can state its balance — which is the fact
  // that decides whether deleting it is a tidy-up or a mistake.
  const [deleting, setDeleting] = useState(null);

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

  const create = (
    <Busy
      busy={busy === 'generate'}
      onClick={() =>
        act('generate', () =>
          api('/v4/wallets/generate', 'POST', { count: 1, role: ROLES.master, label: 'v4 funding' })
        )
      }
    >
      Create funding wallet
    </Busy>
  );

  /**
   * Paste existing keys in as funding wallets.
   *
   * ONLY FUNDING WALLETS. The route refuses a seed outright, and the reason is
   * worth repeating where the operator is standing: a seed wallet is worth
   * seasoning because it has no history before the transfer that funds it, and
   * an imported key has one already. Sitting for three weeks afterwards does
   * not give it back a property it never had.
   *
   * A funder is plumbing, so importing one is allowed — and it saves the single
   * transfer in this whole pipeline that nothing randomises. The warning under
   * the box is the real cost: the Relay hop breaks the funder-to-seed edge and
   * does nothing at all about where the funder itself has been.
   */
  const importer = (
    <div className="notice">
      <h3>Import an existing wallet</h3>
      <p>
        Only funding wallets. Seed wallets are generated here and cannot be imported — one that has
        been used before is not fresh, however long it then sits.
      </p>
      <p className="hint">
        Whatever this wallet has already done comes with it. Everything it funds inherits that
        history, because the Relay hop hides which seed a funder paid — not where the funder has
        been. Import one that is already clean, or generate a new one and send it ETH.
      </p>
      <textarea
        rows="3"
        placeholder="funding wallet private keys, one per line"
        value={keys}
        onChange={(e) => setKeys(e.target.value)}
      />
      <div className="row">
        <Busy
          busy={busy === 'import'}
          disabled={!keys.trim()}
          onClick={() =>
            act('import', async () => {
              const made = await api('/v4/wallets/import', 'POST', {
                privateKeys: keys.split('\n'),
                role: ROLES.master,
                label: 'v4 funding',
              });
              // Cleared on success only. A failed paste that wiped the box would
              // mean re-fetching keys from wherever they came from.
              setKeys('');
              setShowImport(false);
              return made;
            })
          }
        >
          Import funding wallet
        </Busy>
        <button className="link" onClick={() => setShowImport(false)}>
          cancel
        </button>
      </div>
    </div>
  );

  // Every funding wallet except the one paying. The backend excludes the source
  // too — this is only so the count on screen matches what will actually be
  // funded, rather than promising one more wallet than the plan contains.
  const targets = wallets.filter((w) => w.id !== source);

  /**
   * A split's shape, which is a campaign's shape with the dials turned down.
   *
   * ONE DAY, and every target on it. A seasoning campaign is slow because the
   * wallets it feeds have to look unrelated to each other; the funders being
   * filled here are about to spend openly through Relay anyway, so the only
   * thing worth buying is that they do not all arrive in one block from one
   * address. Ten minutes to an hour between them does that in an afternoon.
   */
  /**
   * How much each funder needs, worked out from what it is being filled for.
   *
   * THE MINIMUM IS SIZED ON THE WORST CASE, NOT THE AVERAGE, and that is the
   * whole reason this is computed rather than typed. A split hands every funder
   * a RANDOM amount inside the range, and a seasoning campaign then costs
   * whatever ITS dice rolled. Size the split on the average and roughly half
   * the funders draw less than their campaign will cost — which does not fail
   * here, at the split, where it would be obvious. It fails later, one funder
   * at a time, when the campaign is started and the balance check refuses it.
   *
   * So: seeds × the largest amount a seed can draw, plus Relay's fee and gas.
   * Every funder can then afford the most expensive campaign it could possibly
   * be given. Whatever is left over stays in the funder and is still spendable
   * — it funds the next batch rather than being lost.
   */
  const splitSizing = () => {
    const seedMax = Number(planDefaults?.amountMaxEth ?? 0.0089);
    const n = Math.max(1, Math.round(Number(seedsPer) || 0));
    // 3% Relay fee, and a gas allowance per transfer with room to spare — the
    // preview's own estimate is authoritative and will refuse if this is thin.
    const perFunder = n * seedMax * 1.03 + n * 0.0002;
    return {
      seeds: n,
      seedMax,
      minEth: perFunder.toFixed(6),
      // A spread, or every funder receives an identical figure — the one shape
      // this feature exists to avoid, reintroduced at the hop above it.
      maxEth: (perFunder * 1.18).toFixed(6),
      // What the whole split will cost the source, near enough to warn on.
      totalEth: (perFunder * 1.09 * targets.length * 1.033).toFixed(6),
    };
  };

  const sizing = splitSizing();
  const sourceWallet = wallets.find((w) => w.id === source);
  const shortfall =
    sourceWallet && sourceWallet.balanceEth != null
      ? Number(sizing.totalEth) - Number(sourceWallet.balanceEth)
      : 0;

  const splitParams = () => ({
    days: 1,
    perDayMin: targets.length,
    perDayMax: targets.length,
    amountMinEth: sizing.minEth,
    amountMaxEth: sizing.maxEth,
    gapMinMs: 10 * 60_000,
    gapMaxMs: 60 * 60_000,
  });

  /**
   * Spread one funding wallet across the others, through Relay.
   *
   * WHY THIS EXISTS RATHER THAN TWELVE MANUAL SENDS. One address paying twelve
   * fresh wallets, which then all start depositing to Relay, is the most
   * recognisable pattern this whole feature otherwise leaves behind — and it is
   * on the one hop nothing else randomises. Routed through Relay a solver pays
   * each funder, so there is no on-chain line from the source to any of them.
   *
   * It costs a Relay fee on this hop that a direct transfer would not, and it
   * puts both hops in one solver's records. Neither is hidden from the operator
   * — see the note under the button.
   */
  const splitter = (
    <div className="notice">
      <h3>Split one wallet across the others</h3>
      <p>
        Fills the other funding wallets from this one, through Relay, at random amounts ten minutes
        to an hour apart. A solver pays each of them, so nothing on chain connects them to the
        source.
      </p>
      {wallets.length < 2 ? (
        <p className="hint">
          Needs at least two funding wallets — one to pay and one to be paid. Create another first.
        </p>
      ) : (
        <>
          <div className="row">
            <label>
              from
              <select
                value={source}
                onChange={(e) => {
                  setSource(e.target.value);
                  setSplit(null);
                }}
              >
                <option value="">choose one…</option>
                {wallets.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.address.slice(0, 10)}… · {w.balanceEth == null ? 'unreadable' : `${Number(w.balanceEth).toFixed(4)} ETH`}
                  </option>
                ))}
              </select>
            </label>
            <label>
              seed wallets each will feed
              <input
                type="number"
                min="1"
                max="200"
                value={seedsPer}
                onChange={(e) => {
                  setSeedsPer(e.target.value);
                  setSplit(null);
                }}
                style={{ width: 90 }}
              />
            </label>
          </div>

          <p className="hint">
            {source
              ? `${targets.length} wallet(s) will be funded — every funding wallet except the one paying — ` +
                `${sizing.minEth}–${sizing.maxEth} ETH each. That covers ${sizing.seeds} seed ` +
                `wallet(s) per funder even if every one of them draws the top of the ${sizing.seedMax} ETH ` +
                `range, so no campaign can be refused later for a funder that happened to draw low. ` +
                `Anything unspent stays in the funder.`
              : 'Pick the wallet holding the ETH.'}
          </p>

          {source && shortfall > 0 && (
            <p className="hint">
              This needs about <b>{sizing.totalEth}</b> ETH and the wallet holds{' '}
              <b>{Number(sourceWallet.balanceEth).toFixed(6)}</b> — short by{' '}
              <b>{shortfall.toFixed(6)}</b>. Feed fewer seed wallets per funder, delete a funding
              wallet or two, or add ETH. The preview refuses rather than starting something that
              runs dry.
            </p>
          )}

          {split && (
            <div className="notice">
              <b>{split.walletIds.length}</b> transfer(s), <b>{split.totalEth}</b> ETH before Relay
              fees and gas. The plan below is the plan that starts — same seed, regenerated on the
              server.
            </div>
          )}

          <div className="row">
            <Busy
              busy={busy === 'split-preview'}
              disabled={!source || targets.length === 0}
              onClick={() =>
                act('split-preview', async () => {
                  const out = await api('/v4/campaigns/preview', 'POST', {
                    kind: 'split',
                    masterWalletId: source,
                    walletIds: targets.map((w) => w.id),
                    params: splitParams(),
                  });
                  if (!out.feasible?.ok) throw new Error(out.feasible.reason);
                  setSplit(out);
                  return `Split preview: ${out.walletIds.length} transfer(s), ${out.totalEth} ETH.`;
                })
              }
            >
              Preview split
            </Busy>
            <Busy
              busy={busy === 'split-start'}
              disabled={!split}
              onClick={() =>
                act('split-start', async () => {
                  const out = await api('/v4/campaigns', 'POST', {
                    kind: 'split',
                    name: `split ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
                    masterWalletId: source,
                    walletIds: split.walletIds,
                    // The seed and params the preview returned, posted back so
                    // the server regenerates the same plan rather than trusting
                    // the transfer list this browser is holding.
                    seed: split.seed,
                    params: splitParams(),
                  });
                  setSplit(null);
                  setShowSplit(false);
                  return out;
                })
              }
            >
              Start split
            </Busy>
            <button className="link" onClick={() => setShowSplit(false)}>
              cancel
            </button>
          </div>

          <p className="hint">
            The Relay hop costs a fee a direct transfer would not, and it puts this hop and the
            seasoning that follows in the same solver's records. What it buys is that no one reading
            the chain can tell these wallets came from you.
          </p>
        </>
      )}
    </div>
  );

  return (
    <Step {...step}>
      <p className="lede">
        Pays for a campaign and nothing else. Fund it from outside this console — every seed wallet a
        campaign touches traces back to this address, so what pays for it is a decision of its own.
      </p>

      {showImport && importer}
      {showSplit && splitter}

      {/* The key is archived, not destroyed — `npm run archive:restore` brings
          it back. Said plainly, because a delete dialog that implies
          irreversibility teaches an operator to fear a safe action, and then
          not to believe the one place this really is irreversible: the archive
          is capped, so a delete can evict an OLDER key to make room. */}
      <Modal
        open={Boolean(deleting)}
        danger
        title={`Archive funding wallet ${deleting ? deleting.address.slice(0, 10) : ''}…?`}
        question={
          deleting && deleting.balanceEth != null && Number(deleting.balanceEth) > 0
            ? `It still holds ${Number(deleting.balanceEth).toFixed(6)} ETH. Archiving does not move the ETH — sweep it first, or the balance sits at an address this console no longer lists.`
            : 'Its key moves to the encrypted archive beside the keystore and can be restored from the server. A campaign that still needs this wallet will refuse the delete.'
        }
        confirmLabel="Archive wallet"
        onConfirm={() => {
          const w = deleting;
          setDeleting(null);
          act('delete', async () => {
            const out = await api(`/v4/wallets/${w.id}`, 'DELETE');
            return `Archived ${out.address}. Restore it with: npm run archive:restore ${out.address}`;
          });
        }}
        onCancel={() => setDeleting(null)}
      />

      {/* Empty is where this tab STARTS, not a failure. It says what the wallet
          is for and what to do next rather than drawing an empty table. */}
      {wallets.length === 0 ? (
        <div className="notice">
          <h3>No funding wallet yet</h3>
          <p>
            A campaign needs one to send from, and it needs ETH in it before it will start — the
            whole three weeks is paid for up front, Relay fees and gas included.
          </p>
          <div className="row">
            {create}
            <button className="link" onClick={() => setShowImport((v) => !v)}>
              or import one
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="row">
            {create}
            <button className="link" onClick={() => setShowImport((v) => !v)}>
              or import one
            </button>
            {/* Shown from the FIRST wallet, not the second. Gated on having
                two, the panel's own "needs at least two" explanation could
                never be reached — so an operator holding one funded wallet saw
                no link, no message, and no reason to think splitting was
                possible. Which is exactly the moment they need to know. */}
            <button className="link" onClick={() => setShowSplit((v) => !v)}>
              split one across the others
            </button>
            {/* Beside the deletes, not only in step 2. These are the wallets
                that hold the ETH, and the row's own delete tells the operator
                the key is recoverable — which stops being true once the capped
                archive evicts it. The file is what makes that promise good. */}
            <V4BackupControls
              masters={wallets}
              seeds={seeds}
              report={report}
              reload={reload}
              label="Export keys"
            />
            <span className="spacer" />
            <span className="hint">one campaign at a time per wallet — make another to run two</span>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Address</th>
                  <th className="num">Balance</th>
                  <th>Campaign</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {wallets.map((w) => {
                  const held = campaignFor[w.id];
                  return (
                    <tr key={w.id}>
                      <td>
                        <Address
                          value={w.address}
                          href={explorer ? `${explorer}/address/${w.address}` : ''}
                        />
                      </td>
                      {/* null is "the RPC did not answer", which is not the same
                          statement as zero — a wallet drawn at 0.000000 when it
                          holds two ETH is the one reading that would have an
                          operator top up a wallet that did not need it. */}
                      <td className="num">
                        {w.balanceEth == null ? <span className="hint">unreadable</span> : eth(w.balanceEth)}
                      </td>
                      <td>
                        {held ? (
                          <>
                            {held.name} <span className="hint">· {held.status}</span>
                          </>
                        ) : w.inCampaign ? (
                          <span className="hint">in a campaign</span>
                        ) : (
                          <span className="hint">free</span>
                        )}
                      </td>
                      <td className="num">
                        {/* Offered on every row. The backend decides whether a
                            wallet is actually free — it reads the campaigns,
                            which this table only partly reflects — and refuses
                            with the campaign's name and status. Hiding the
                            control on a guess would leave an operator unable to
                            delete a wallet the server would happily archive. */}
                        <button className="link" onClick={() => setDeleting(w)}>
                          delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Step>
  );
}
