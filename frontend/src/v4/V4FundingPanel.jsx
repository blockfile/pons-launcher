import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Address from '../components/Address.jsx';
import Modal from '../components/Modal.jsx';
import { LuTrash2, LuX, LuKeyRound, LuSplit, LuArrowUp, LuArrowDown } from 'react-icons/lu';
import IconButton, { IconAction } from './IconButton.jsx';
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
  // How many funding wallets to generate at once — the backend takes up to 5000, so a
  // batch of 80 is one click, not eighty.
  const [genCount, setGenCount] = useState(1);
  const [showSplit, setShowSplit] = useState(false);
  const [source, setSource] = useState('');
  // What each funder is being filled FOR, rather than how much to send it. The
  // amount is arithmetic on this, and it is arithmetic an operator should not
  // be doing by hand — see splitSizing below.
  const [seedsPer, setSeedsPer] = useState(4);
  const [split, setSplit] = useState(null);
  // Which funders THIS split pays. Default: the IDLE ones (not already in a campaign),
  // so a new batch is pre-selected and the running ones are left alone — but every
  // funder has a checkbox, so the operator chooses exactly who receives. Held as
  // explicit overrides OVER that default, so generating more funders never resets a
  // choice already made (a funder with no entry falls back to its idle default).
  const [pick, setPick] = useState({});
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

  // Two tiers of funding wallet. A "super-main" is one the operator has flagged as the
  // top tier — the wallet that fills the OTHER funders through a split. It is still an
  // ordinary v4master (the flag re-roles nothing); the split, the backup and the delete
  // all treat it the same. The only thing the flag changes is that it lives in its own
  // group here, and the splitter draws its source from it, so the payer and the paid are
  // never confused for one another.
  const superMains = wallets.filter((w) => w.isSuperMain);
  const funders = wallets.filter((w) => !w.isSuperMain);

  const toggleSuperMain = (w) =>
    act(`super-${w.id}`, () =>
      api(w.isSuperMain ? '/v4/masters/super-main/clear' : '/v4/masters/super-main', 'POST', { ids: [w.id] }).then(
        () => `${w.address.slice(0, 10)}… is now a ${w.isSuperMain ? 'funder' : 'super-main'}.`
      )
    );

  // One funding-wallet table, reused for the super-main group and the funder group so
  // the row (balance, campaign, promote/demote, archive) is written once. The up/down
  // arrow moves a wallet between the two tiers; everything else is exactly the old row.
  const walletTable = (rows, emptyHint) => (
    <div className="table-scroll" style={{ maxHeight: 340, overflowY: 'auto' }}>
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
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4}>
                <span className="hint">{emptyHint}</span>
              </td>
            </tr>
          ) : (
            rows.map((w) => {
              const held = campaignFor[w.id];
              return (
                <tr key={w.id}>
                  <td>
                    <Address value={w.address} plain href={explorer ? `${explorer}/address/${w.address}` : ''} />
                  </td>
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
                    <IconButton
                      icon={w.isSuperMain ? LuArrowDown : LuArrowUp}
                      label={
                        w.isSuperMain
                          ? `Return ${w.address} to the funder pool`
                          : `Make ${w.address} a super-main`
                      }
                      onClick={() => toggleSuperMain(w)}
                    />
                    <IconButton
                      icon={LuTrash2}
                      danger
                      label={`Archive funding wallet ${w.address}`}
                      onClick={() => setDeleting(w)}
                    />
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );

  const genN = Math.min(5000, Math.max(1, Math.round(Number(genCount) || 1)));
  const create = (
    <div className="row" style={{ gap: 8, alignItems: 'center' }}>
      <input
        type="number"
        min="1"
        max="5000"
        value={genCount}
        onChange={(e) => setGenCount(e.target.value)}
        style={{ width: 90 }}
        aria-label="how many funding wallets to create"
      />
      <Busy
        busy={busy === 'generate'}
        className="btn-primary"
        onClick={() =>
          act('generate', () =>
            api('/v4/wallets/generate', 'POST', { count: genN, role: ROLES.master, label: 'v4 funding' }).then(
              (made) => `Created ${made.length} funding wallet${made.length === 1 ? '' : 's'}.`
            )
          )
        }
      >
        {genN === 1 ? 'Create funding wallet' : `Create ${genN} funding wallets`}
      </Busy>
    </div>
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
          className="btn-primary"
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
        <IconAction icon={LuX} onClick={() => setShowImport(false)}>
          Cancel
        </IconAction>
      </div>
    </div>
  );

  // Every funding wallet except the one paying. The backend excludes the source
  // too — this is only so the count on screen matches what will actually be
  // funded, rather than promising one more wallet than the plan contains.
  // A split pays the FUNDERS, never another super-main — so the targets are the funder
  // tier minus the paying wallet. When no super-main is flagged, `funders` is every
  // wallet and this is the old "everyone except the source" behaviour, unchanged.
  // Every funder that could receive (all funders except the paying wallet). Each is
  // picked by default when idle; the operator overrides per wallet.
  const eligible = funders.filter((w) => w.id !== source);
  const isPicked = (w) => (w.id in pick ? pick[w.id] : !w.inCampaign);
  const togglePick = (w) => {
    setPick((p) => ({ ...p, [w.id]: !isPicked(w) }));
    setSplit(null);
  };
  const setAllPicks = (value) => {
    setPick(Object.fromEntries(eligible.map((w) => [w.id, value])));
    setSplit(null);
  };
  const resetPicks = () => {
    setPick({});
    setSplit(null);
  };
  const targets = eligible.filter(isPicked);
  // The payer is chosen from the super-mains when any are flagged; otherwise from every
  // funding wallet, so a setup with no super-mains still works exactly as before.
  const sourceOptions = superMains.length > 0 ? superMains : wallets;

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
    // No random wait before the first send. A seasoning campaign earns that
    // offset — starting at the same hour daily is a pattern. A split does not:
    // these wallets spend openly through Relay within hours, and the offset was
    // costing up to twenty-two hours of doing nothing before the first funder
    // was paid.
    promptStart: true,
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
                {sourceOptions.map((w) => (
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

          {source && eligible.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                <span className="hint">
                  Funders this split pays — <b>{targets.length}</b> of {eligible.length} selected
                  {' '}(new/idle funders are ticked by default)
                </span>
                <span className="spacer" />
                <button type="button" className="link" onClick={() => setAllPicks(true)}>
                  all
                </button>
                <button type="button" className="link" onClick={resetPicks}>
                  idle only
                </button>
                <button type="button" className="link" onClick={() => setAllPicks(false)}>
                  none
                </button>
              </div>
              <div className="table-scroll" style={{ maxHeight: 200, overflowY: 'auto', marginTop: 4 }}>
                <table>
                  <tbody>
                    {eligible.map((w) => (
                      <tr key={w.id}>
                        <td style={{ width: 28 }}>
                          <input
                            type="checkbox"
                            checked={isPicked(w)}
                            onChange={() => togglePick(w)}
                            style={{ width: 'auto' }}
                            aria-label={`Fund ${w.address}`}
                          />
                        </td>
                        <td>
                          <Address value={w.address} plain href={explorer ? `${explorer}/address/${w.address}` : ''} />
                        </td>
                        <td className="num">
                          {w.balanceEth == null ? <span className="hint">unreadable</span> : eth(w.balanceEth)}
                        </td>
                        <td>
                          <span className="hint">{w.inCampaign ? 'in a campaign' : 'idle'}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <p className="hint">
            {source
              ? `${targets.length} funder(s) selected — ${sizing.minEth}–${sizing.maxEth} ETH each. ` +
                `That covers ${sizing.seeds} seed wallet(s) per funder even if every one of them draws ` +
                `the top of the ${sizing.seedMax} ETH range, so no campaign can be refused later for a ` +
                `funder that happened to draw low. Anything unspent stays in the funder.`
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
              className="btn-primary"
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
            <IconAction icon={LuX} onClick={() => setShowSplit(false)}>
              Cancel
            </IconAction>
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
            <IconAction icon={LuKeyRound} onClick={() => setShowImport((v) => !v)}>
              Import one
            </IconAction>
          </div>
        </div>
      ) : (
        <>
          <div className="row">
            {create}
            <IconAction icon={LuKeyRound} onClick={() => setShowImport((v) => !v)}>
              Import one
            </IconAction>
            {/* Shown from the FIRST wallet, not the second. Gated on having
                two, the panel's own "needs at least two" explanation could
                never be reached — so an operator holding one funded wallet saw
                no link, no message, and no reason to think splitting was
                possible. Which is exactly the moment they need to know. */}
            <IconAction icon={LuSplit} onClick={() => setShowSplit((v) => !v)}>
              Split one across the others
            </IconAction>
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
            {/* Funding wallets on their own — they hold the ETH, and keeping that tier
                backed up separately from the seeds is its own need. */}
            <V4BackupControls
              fundersOnly
              masters={wallets}
              seeds={seeds}
              report={report}
              reload={reload}
              label="Export funding wallets"
            />
            <span className="spacer" />
            <span className="hint">one campaign at a time per wallet — make another to run two</span>
          </div>

          {/* Capped rather than paged. Funding wallets are counted in tens, not
              hundreds, and a pager over twenty rows is more machinery than the
              problem — but twenty-one of them still pushed step 2 off the
              screen. About nine rows before it scrolls, which keeps the whole
              step visible while every wallet stays reachable. */}
          {/* Offered on every row: the up/down arrow moves a wallet between the two
              tiers, and delete is offered on every row because the BACKEND decides
              whether a wallet is actually free — it reads the campaigns, which this
              table only partly reflects — and refuses with the campaign's name and
              status. Hiding a control on a guess would leave an operator unable to act
              on a wallet the server would happily archive.

              Capped rather than paged: funding wallets are counted in tens, and the
              scroll keeps step 2 on screen while every wallet stays reachable. */}
          {superMains.length > 0 ? (
            <>
              <div className="row" style={{ marginTop: 4 }}>
                <b>Super-main funding wallets</b>
                <span className="hint">· they fund the funders below, through splits</span>
              </div>
              {walletTable(superMains)}
              <div className="row" style={{ marginTop: 12 }}>
                <b>Funder wallets</b>
                <span className="hint">· funded by the super-mains; each drips into seed wallets</span>
              </div>
              {walletTable(funders, 'No funders yet — every funding wallet is currently a super-main.')}
            </>
          ) : (
            walletTable(wallets, 'No funding wallets yet.')
          )}
        </>
      )}
    </Step>
  );
}
