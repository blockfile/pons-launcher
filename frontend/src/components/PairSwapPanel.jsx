import { useEffect, useState } from 'react';
import { api, notify } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';
import Modal, { Fact } from './Modal.jsx';
import { rolesFor } from '../variant.js';
import { recoverTargets } from './pairBalance.js';
import { ethShortfall, swapGate, recoverGate, swapPricingKey } from './quoteAsset.js';

/**
 * THE STATION BETWEEN FUNDING AND LAUNCHING — where each wallet buys its own
 * quote asset.
 *
 * IT EXISTS BECAUSE OF ONE FACT ABOUT THE MACHINERY. Nothing in this console can
 * SEND the quote asset to a bundle wallet. Relay moves native ETH and nothing
 * else — backend/src/relay/funding.js pins `originCurrency` and
 * `destinationCurrency` to NATIVE at both ends — and the funding run is a list of
 * ETH transfers out of the dev wallet. So on a launch priced in NVDA the order is
 * not "size, fund, launch" with a swap tucked inside one of them; it is:
 *
 *     size the buys in NVDA → fund every wallet with ETH →
 *     EACH WALLET SWAPS ITS OWN ETH FOR NVDA → launch
 *
 * and the third of those is a separate thing to do, at a separate time, with its
 * own precondition. It used to be a box inside the wallet table with a line of
 * copy explaining that it ran AFTER the step below it. An operator read that
 * three times and still asked "this need eth first?" — which is the right
 * question, and the answer is a number in the sequence rather than a paragraph.
 *
 * WHY IT IS A COMPONENT AND NOT A SLICE OF WalletsPanel. The earlier pass
 * declined to extract this, on the grounds that it would "move ~10 hooks and 4
 * effects around live spend paths". That was true of extracting the WHOLE
 * pair area — the converter, the fill-from-balance preview and the market-cap
 * rate are all wired to the table and to the Buy column. It is not true of these
 * two boxes: they read `rows` and the wallet list and nothing else of the table's
 * state, and every input they need (wallets, rows, pair, variant, live, report,
 * reload) was already in App, one level up. So the eight useState, two useEffect
 * and two async runners below arrived here unchanged — same endpoints, same dry
 * runs, same frozen-dialog rule, same reporting — and the panel they left keeps
 * the controls that write the table.
 *
 * THE ONE AMBER IN HERE IS THE SWAP. It is this station's spending action and the
 * only one, so it takes the money colour the law reserves for exactly that. The
 * recovery beside it is a .ghost with a dialog behind it, the boxes carry a plain
 * strong hairline rather than an amber stripe, and nothing else raises its voice.
 *
 * Absent entirely on a native launch: App does not put this station in the plan
 * and does not render this panel, so there is no swap to number, nothing to
 * approve and nothing to explain.
 */
export default function PairSwapPanel({
  step,
  variant = 'v2',
  // The whole wallet list, filtered here by the same role whitelist the table
  // uses — never "everything that is not the dev wallet".
  wallets = [],
  // App's per-wallet { mode, buy, fund } map. The Buy amount IS the requirement:
  // it is the number prepareV2 parses and then demands the wallet hold.
  rows = {},
  // The launch's quote asset, chosen in the first station. This panel is not
  // rendered at all when it is null.
  pair,
  live = false,
  reload = async () => {},
  report = () => {},
  nums = {},
}) {
  const roles = rolesFor(variant);
  const bundle = wallets.filter((w) => w.role === roles.bundle);
  const [busy, setBusy] = useState('');

  // ── THE FUNDING DIRECTION: ETH → the quote asset, per wallet ────────────────
  // The priced dry run, its error, the frozen dialog, and what the last real run
  // did per wallet. Unchanged from the wallet panel they came from.
  const [pairPlan, setPairPlan] = useState(null);
  const [pairErr, setPairErr] = useState('');
  // The plan the dialog is asking about, FROZEN with the targets it was priced
  // against — so what the operator reads is what is broadcast, even if the Buy
  // column is edited while the dialog is open. Same rule the launch dialog keeps.
  const [pairAsk, setPairAsk] = useState(null);
  const [pairOut, setPairOut] = useState(null);

  // ── AND THE WAY BACK OUT OF IT ──────────────────────────────────────────────
  // The mirror of the four above. Buying the quote asset used to be a one-way
  // door: a wallet holding NVDA had no console path back to ETH, so a changed
  // quote asset, an abandoned launch or a mis-sized bundle stranded the token in
  // up to 31 wallets.
  const [backPlan, setBackPlan] = useState(null);
  const [backErr, setBackErr] = useState('');
  const [backAsk, setBackAsk] = useState(null);
  const [backOut, setBackOut] = useState(null);

  // A sell priced against the NVDA pool is not an account of what the SPCX one
  // would pay for anything. Cleared here rather than left on screen reading as
  // current — the debounced effect below cannot do it, because it would leave a
  // stale figure up for its whole delay.
  useEffect(() => {
    setBackPlan(null);
    setBackErr('');
  }, [pair?.address]);

  // ── which wallets are being funded, and with what ───────────────────────────
  // Every bundle wallet with a Buy amount typed — that amount IS the requirement,
  // in the quote asset's own units. A wallet on "all − gas" is deliberately
  // excluded: on a paired launch that mode means "spend whatever pair balance you
  // have", which names no amount to buy, so there is nothing to size a swap
  // against. It is stated below rather than silently dropped.
  const pairTargets = bundle
    .filter((w) => (rows[w.id]?.mode ?? 'fixed') !== 'all' && Number(rows[w.id]?.buy) > 0)
    .map((w) => ({ walletId: w.id, amountPair: String(rows[w.id].buy) }));
  const pairAllMode = bundle.filter((w) => rows[w.id]?.mode === 'all').length;
  const pairTotal = pairTargets.reduce((sum, t) => sum + Number(t.amountPair), 0);
  // Serialised so the preview below re-runs when the AMOUNTS change and not merely
  // when the array identity does (it is rebuilt every render).
  const pairKey = JSON.stringify(pairTargets);
  // AND WHEN THE BALANCES CHANGE, which is the whole point of this station.
  //
  // The dry run is the endpoint's own verdict, and its verdict is a function of
  // what the wallets HOLD as much as of what they were asked to buy. Keying the
  // preview on the amounts alone meant the one event this station exists to wait
  // for — step 4 landing ETH in the wallets — did not re-price it: the table
  // showed the new balances while this panel went on reporting the refusal it had
  // computed against the old ones ("No wallet can be bought for right now. 31 are
  // short of ETH", with every wallet visibly funded). Observed on a live launch.
  //
  // The id is in the key beside the balance so that a wallet appearing or leaving
  // re-prices too, and it is built off `bundle` rather than `pairTargets` because
  // a wallet with no Buy amount still changes what the run would do.
  const pricingKey = swapPricingKey(bundle, pairTargets);

  // ── HAVE THE WALLETS GOT THE ETH YET ────────────────────────────────────────
  // The station's real precondition, and the sentence the old control buried in a
  // hint under a dead button. One subtraction, done in one place — see
  // ethShortfall in quoteAsset.js — reading the dry run's own per-wallet price
  // when there is one and the Fund column when there is not.
  const funding = ethShortfall({ bundle, rows, plan: pairPlan });

  const gate = swapGate({
    symbol: pair.symbol,
    bundleCount: bundle.length,
    targets: pairTargets.length,
    allMode: pairAllMode,
    funding,
    plan: pairPlan,
    error: pairErr,
    nums,
  });

  // The ETH this will cost, priced server-side against live quotes — the operator
  // must not be asked to approve a spend whose size is a guess. It is a dry run of
  // the real endpoint, so the figure on screen is produced by the code that will
  // spend it, including its skips and its refusals. Debounced, because it is a
  // chain read per wallet and the Buy column is typed in.
  useEffect(() => {
    if (pairTargets.length === 0) {
      setPairPlan(null);
      setPairErr('');
      return undefined;
    }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const out = await api('/wallets/swap-to-pair', 'POST', {
          variant,
          pairToken: pair.address,
          targets: JSON.parse(pairKey),
          dryRun: true,
        });
        if (!alive) return;
        setPairPlan(out);
        setPairErr('');
      } catch (err) {
        if (!alive) return;
        setPairPlan(null);
        setPairErr(err.message);
      }
    }, 1200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair?.address, pricingKey, variant]);

  /**
   * Buy the quote asset, one wallet at a time, each with its own ETH.
   *
   * The dev wallet never sends the token on: distributing it would write
   * dev → 20 wallets → they all buy the launch onto the chain, which is the
   * coordination a bundle is trying not to advertise.
   *
   * The result is kept on the panel as well as sent to the readout, because a run
   * where some wallets swapped, some were already funded and some were refused for
   * gas must not be reduced to one line somebody scrolls past.
   */
  async function runPairSwap() {
    setBusy('pair-swap');
    setPairOut(null);
    try {
      const out = await api('/wallets/swap-to-pair', 'POST', {
        variant,
        pairToken: pairAsk.pairToken,
        targets: pairAsk.targets,
      });
      setPairOut(out);
      report(out);
      const stuck = out.count - out.swapped - out.skippedAlreadyFunded;
      notify(
        stuck === 0
          ? `All ${out.count} wallet(s) hold their ${out.pairSymbol}. Spent ${out.totalEth} ETH.`
          : `${out.swapped} swapped, ${stuck} not funded — read the list below.`,
        stuck === 0 ? 'ok' : 'error'
      );
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
      notify(`Pair funding failed — ${err.message}`, 'error');
    } finally {
      setBusy('');
      setPairAsk(null);
    }
  }

  // ── the recovery plan: which wallets are HOLDING the quote asset ────────────
  // Not "which wallets have a Buy amount" — that is the funding question, and it is
  // asked of the table's fields. This one is asked of the CHAIN: the listing already
  // carries each wallet's real pair balance, so the wallets with something to
  // recover are the wallets holding some, whatever the Buy column says. A balance
  // that was not read is left out rather than assumed empty — see recoverTargets.
  const recover = recoverTargets(bundle);
  // Serialised with the BALANCES, not just the ids, so the preview re-prices when a
  // wallet's holding changes rather than only when the set of holders does.
  const recoverKey = JSON.stringify(
    recover.targets.map((t) => ({ walletId: t.walletId, heldPair: t.heldPair }))
  );
  // The endpoint's own shape: no amountPair at all, which is what "sell the whole
  // balance" means. The amount is read on chain per wallet by the code that sells it,
  // so nothing here has to be right about a number.
  const recoverTargetsSent = () => JSON.parse(recoverKey).map(({ walletId }) => ({ walletId }));

  const backGate = recoverGate({
    symbol: pair.symbol,
    holders: recover.targets.length,
    plan: backPlan,
    error: backErr,
  });

  // WHAT THE RECOVERY WOULD RETURN, priced server-side against live quotes — the
  // operator must not be asked to approve a sale whose proceeds are a guess. It is a
  // dry run of the real endpoint, so the figure is produced by the code that will
  // sell, including its impact refusals and its dust skips.
  useEffect(() => {
    if (recover.targets.length === 0) {
      setBackPlan(null);
      setBackErr('');
      return undefined;
    }
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const out = await api('/wallets/swap-from-pair', 'POST', {
          variant,
          pairToken: pair.address,
          targets: recoverTargetsSent(),
          dryRun: true,
        });
        if (!alive) return;
        setBackPlan(out);
        setBackErr('');
      } catch (err) {
        if (!alive) return;
        setBackPlan(null);
        setBackErr(err.message);
      }
    }, 1200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair?.address, recoverKey, variant]);

  /**
   * Sell the quote asset back to ETH, one wallet at a time, each keeping its own
   * proceeds.
   *
   * The ETH lands back in the wallet that held the token — there is no sweep to the
   * dev wallet here, for the same reason the funding direction does not distribute
   * from it: an on-chain line between the dev wallet and the buyers is exactly what
   * a bundle is trying not to draw.
   */
  async function runPairSell() {
    setBusy('pair-sell');
    setBackOut(null);
    try {
      const out = await api('/wallets/swap-from-pair', 'POST', {
        variant,
        pairToken: backAsk.pairToken,
        targets: backAsk.targets,
      });
      setBackOut(out);
      report(out);
      const left = out.count - out.swapped;
      notify(
        left === 0
          ? `All ${out.count} wallet(s) sold their ${out.pairSymbol}. Recovered ${Number(out.totalEthOut).toFixed(6)} ETH.`
          : `${out.swapped} sold, ${left} still holding — read the list below.`,
        left === 0 ? 'ok' : 'error'
      );
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
      notify(`Selling ${pair.symbol} back failed — ${err.message}`, 'error');
    } finally {
      setBusy('');
      setBackAsk(null);
    }
  }

  const fundStep = nums.fund ? `step ${nums.fund}` : 'the funding step';
  const walletsStep = nums.wallets ? `step ${nums.wallets}` : 'the bundle wallets step';
  const launchStep = nums.launch ? `step ${nums.launch}` : 'the launch step';

  return (
    <Step {...step}>
      <p className="lede">
        Every bundle wallet has to be HOLDING {pair.symbol} before the launch is armed — its buy is
        signed in {pair.symbol} before the token exists, and preflight drops a wallet holding less
        than its Buy amount. This is where each one buys its own, with the ETH it was funded with in{' '}
        {fundStep}.
      </p>

      {/* THE MECHANISM, ONCE, IN PLAIN LANGUAGE. This is the operator's own
          question — "it convert to nvdia, but nvida cant be send tru relay so it
          needs eth to transfer to bundle right?" — and they were right, so the
          answer is stated as the reason this station is here rather than left to
          be inferred from an ordering note. Grey: nothing in it is a state, a
          spend or a warning. One .crux clause carries the weight. */}
      <div className="notice">
        <h3>Why {pair.symbol} is bought here and not sent here</h3>
        <ul>
          <li>
            every path this console has for MOVING funds carries <b>native ETH only</b> — the
            funding run is a list of ETH transfers, and the bridge quotes native at both ends
          </li>
          <li>
            so {pair.symbol} <b className="crux">cannot be transferred to a bundle wallet at all</b>
            . Each wallet has to buy its own, locally, out of its own balance — which is why the ETH
            has to arrive first
          </li>
          <li>
            the order is: size the buys in {pair.symbol} ({walletsStep}) → fund every wallet with
            ETH ({fundStep}) → each wallet swaps its own ETH for {pair.symbol} (here) → arm the
            launch ({launchStep})
          </li>
        </ul>
      </div>

      {/* ── BUY. The station's one spending action, and its one amber. ──────────
          When it cannot run, the REASON is the box's content and the button is
          inert: "Buy NVDA for 0 wallets" with the blocking reason in small text
          underneath is a dead control dressed as a live one. */}
      <div className="pair-fund">
        <b className="pair-fund-title">Buy {pair.symbol} · each wallet with its own ETH</b>

        {!gate.enabled ? (
          <>
            {/* PRIMARY CONTENT, not a footnote. How many wallets, how much ETH is
                missing, and which step supplies it — all three in the one
                sentence swapGate builds. */}
            <div className="pair-fund-cost">{gate.why}</div>
            {/* Inert, and labelled for what it will do rather than for the zero
                it would do now. No count in the label: a count of nothing is how
                the old control claimed to be an offer. */}
            <Busy busy={false} disabled title={gate.why}>
              Buy {pair.symbol}
            </Busy>
            <span className="hint">
              unavailable until the wallets can pay for it — nothing here is sent, and nothing is
              waiting on a click
            </span>
          </>
        ) : (
          <>
            <span>
              {pairPlan.wouldSwap} of {pairTargets.length} wallet
              {pairTargets.length === 1 ? '' : 's'} still need{' '}
              <b>
                {pairTotal.toFixed(6)} {pair.symbol}
              </b>
            </span>
            {/* THE AMBER. This station's one spending action: it sends ETH out of
                up to 31 wallets to buy the asset the launch is priced in. */}
            <Busy
              busy={busy === 'pair-swap'}
              onClick={() => setPairAsk({ ...pairPlan, targets: JSON.parse(pairKey) })}
            >
              Buy {pair.symbol} for {pairPlan.wouldSwap} wallet{pairPlan.wouldSwap === 1 ? '' : 's'}
            </Busy>
            <span className="hint">
              each wallet spends its OWN ETH · run this before arming {launchStep} — arming signs
              against each wallet's current nonce
            </span>

            {/* THE PRICE. A spend is never offered without its size: this is the real
                endpoint's own dry run, so the number is produced by the code that will
                spend it, and its skips are the skips the real run will make. */}
            <div className="pair-fund-cost">
              Spends ≈ <b>{Number(pairPlan.totalEth).toFixed(6)} ETH</b> to buy {pairPlan.wouldSwap}{' '}
              wallet{pairPlan.wouldSwap === 1 ? '' : 's'} their {pair.symbol}
              <span className="hint">
                {pairPlan.skippedAlreadyFunded > 0 && ` · ${pairPlan.skippedAlreadyFunded} already funded`}
                {pairPlan.skippedShort > 0 && ` · ${pairPlan.skippedShort} short of ETH`}
                {pairPlan.skippedImpact > 0 &&
                  ` · ${pairPlan.skippedImpact} refused, the pool is too thin for that size`}
                {pairPlan.failed > 0 && ` · ${pairPlan.failed} could not be priced`}
                {pairAllMode > 0 &&
                  ` · ${pairAllMode} on "all − gas" are not funded here: that mode spends whatever ` +
                    `${pair.symbol} balance a wallet has, so there is no amount to buy`}
              </span>
            </div>
          </>
        )}

        {/* What the last real run actually did, per wallet — the console's own
            refusal instrument. A run where some swapped, some were already funded
            and some were refused for gas must never be reduced to a single count. */}
        {pairOut && (
          <div
            className={`notice ${
              pairOut.swapped + pairOut.skippedAlreadyFunded === pairOut.count ? '' : 'danger'
            }`}
          >
            <h3>
              {pairOut.swapped} of {pairOut.count} swapped · {pairOut.totalEth} ETH spent
              {pairOut.skippedAlreadyFunded ? ` · ${pairOut.skippedAlreadyFunded} already funded` : ''}
            </h3>
            <ul>
              {pairOut.results
                .filter((r) => r.status !== 'skipped-already-funded')
                .map((r) => (
                  <li key={r.walletId}>
                    <code>
                      {r.address.slice(0, 6)}…{r.address.slice(-4)}
                    </code>{' '}
                    {r.status} — holds {r.holdingPair} {pairOut.pairSymbol} of {r.needPair}
                    {r.reason ? `. ${r.reason}` : ''}
                  </li>
                ))}
            </ul>
          </div>
        )}
      </div>

      {/* ── THE WAY BACK. Drawn only when there is something to recover — a
          recovery control on an empty bundle is an invitation to press a button
          that would do nothing.

          `|| backOut` is not decoration. A run that empties every wallet also
          empties `recover.targets`, so without it the box — and the per-wallet
          account of what just happened — would unmount at the exact moment it is
          most needed. A run stays on screen until the operator navigates away.

          .ghost, not amber: this station's one amber is the buy above, and a
          dialog stands behind this. */}
      {(recover.targets.length > 0 || backOut) && (
        <div className="pair-fund">
          <b className="pair-fund-title">Recover ETH · sell {pair.symbol} back</b>

          {recover.targets.length === 0 ? (
            <span className="hint">
              No bundle wallet holds {pair.symbol} any more — what the last run did is below.
            </span>
          ) : !backGate.enabled ? (
            <>
              <div className="pair-fund-cost">{backGate.why}</div>
              <Busy busy={false} className="ghost" disabled title={backGate.why}>
                Sell {pair.symbol} back
              </Busy>
              <span className="hint">
                {recover.targets.length} wallet{recover.targets.length === 1 ? '' : 's'} hold{' '}
                {Number(recover.total).toFixed(6)} {pair.symbol} · nothing was sent
              </span>
            </>
          ) : (
            <>
              <span>
                {recover.targets.length} wallet{recover.targets.length === 1 ? '' : 's'} hold{' '}
                <b>
                  {Number(recover.total).toFixed(6)} {pair.symbol}
                </b>
              </span>
              <Busy
                className="ghost"
                busy={busy === 'pair-sell'}
                onClick={() => setBackAsk({ ...backPlan, targets: recoverTargetsSent() })}
              >
                Sell {pair.symbol} from {backPlan.wouldSwap} wallet
                {backPlan.wouldSwap === 1 ? '' : 's'}
              </Busy>
              {/* THE WAY OUT OF A CHANGED MIND, named as such. This is the
                  recovery the quote-asset station points at: change what the
                  launch is priced in and whatever the wallets already bought stays
                  with them, and this is what turns it back into ETH. It has to be
                  run while the launch is still priced in that asset — the listing
                  carries one quote asset's balances at a time. */}
              <span className="hint">
                each wallet sells its WHOLE {pair.symbol} balance and keeps the ETH · run this before
                arming, never against a launch already armed · this is also the way back if you
                change the quote asset in step {nums.quote ?? 1} — sell first, while the launch is
                still priced in {pair.symbol}
              </span>

              <div className="pair-fund-cost">
                Sells{' '}
                <b>
                  {Number(backPlan.totalPairSold).toFixed(6)} {pair.symbol}
                </b>{' '}
                for ≈ <b>{Number(backPlan.totalQuotedEth).toFixed(6)} ETH</b> back into{' '}
                {backPlan.wouldSwap} wallet{backPlan.wouldSwap === 1 ? '' : 's'}
                <span className="hint">
                  {' '}
                  — a live quote, floored at {(backPlan.overshootBps / 100).toFixed(1)}% below it, so a
                  worse fill reverts with the {pair.symbol} intact
                  {backPlan.skippedImpact > 0 &&
                    ` · ${backPlan.skippedImpact} refused, the pool is too thin for that size`}
                  {backPlan.skippedDust > 0 &&
                    ` · ${backPlan.skippedDust} hold dust worth less than the gas to sell it`}
                  {backPlan.skippedShort > 0 && ` · ${backPlan.skippedShort} short of gas for the sale`}
                  {backPlan.failed > 0 && ` · ${backPlan.failed} could not be priced`}
                  {recover.unknown > 0 &&
                    ` · ${recover.unknown} wallet(s) have no ${pair.symbol} balance read yet and are not ` +
                      `included — refresh balances in ${walletsStep}`}
                </span>
              </div>
            </>
          )}

          {/* What the last real sale actually did, per wallet — the same refusal
              instrument the funding run reports through. */}
          {backOut && (
            <div className={`notice ${backOut.swapped === backOut.count ? '' : 'danger'}`}>
              <h3>
                {backOut.swapped} of {backOut.count} sold · {backOut.totalPairSold} {backOut.pairSymbol}{' '}
                for {backOut.totalEthOut} ETH
              </h3>
              <ul>
                {backOut.results.map((r) => (
                  <li key={r.walletId}>
                    <code>
                      {r.address.slice(0, 6)}…{r.address.slice(-4)}
                    </code>{' '}
                    {r.status} — sold {r.soldPair ?? '0'} {backOut.pairSymbol}
                    {r.receivedEth ? ` for ${r.receivedEth} ETH` : ''}, still holds {r.holdingPair}
                    {r.reason ? `. ${r.reason}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* The pair funding confirm. Vermilion when the console is live, exactly as the
          launch dialog is: this buys a token with real ETH from up to 31 wallets and
          there is no undo. One amber object in here — the confirm button — and no
          amber band, which is the defect this console keeps re-growing. */}
      <Modal
        open={Boolean(pairAsk)}
        danger={live}
        title={live ? `Buy ${pair.symbol} with ${pairAsk?.totalEth} ETH?` : `Dry run: buy ${pair.symbol}`}
        question={null}
        confirmLabel={live ? `Buy ${pair.symbol} for ${pairAsk?.wouldSwap} wallet(s)` : 'Run (dry run)'}
        onConfirm={runPairSwap}
        onCancel={() => setPairAsk(null)}
      >
        <div className="modal-facts">
          <Fact label="Pair token" mono>
            {pair.symbol} · {pair.address}
          </Fact>
          <Fact label="Wallets">
            {pairAsk?.wouldSwap} of {pairAsk?.count} (the rest are already funded or refused)
          </Fact>
          <Fact label="Total to spend">{pairAsk?.totalEth} ETH</Fact>
          <Fact label="Each wallet buys">its own {pair.symbol}, with its own ETH</Fact>
        </div>
        <p>
          Every wallet keeps enough ETH for the launch's own approve and buy. A wallet that cannot
          cover both is refused rather than part-funded, and every wallet is reported either way.
          Run this BEFORE arming the launch — arming signs against each wallet's current nonce.
        </p>
      </Modal>

      {/* The recovery confirm. Vermilion when the console is live, exactly as the
          funding dialog beside it: this sells a real position from up to 31 wallets at
          a public pool's price and there is no undo — the ETH comes back, but the
          tokens are gone at whatever the pool paid. One amber object in here, the
          confirm button, and no amber band. */}
      <Modal
        open={Boolean(backAsk)}
        danger={live}
        title={
          live
            ? `Sell ${Number(backAsk?.totalPairSold || 0).toFixed(6)} ${pair.symbol} back to ETH?`
            : `Dry run: sell ${pair.symbol} back`
        }
        question={null}
        confirmLabel={live ? `Sell from ${backAsk?.wouldSwap} wallet(s)` : 'Run (dry run)'}
        onConfirm={runPairSell}
        onCancel={() => setBackAsk(null)}
      >
        <div className="modal-facts">
          <Fact label="Pair token" mono>
            {pair.symbol} · {pair.address}
          </Fact>
          <Fact label="Wallets">
            {backAsk?.wouldSwap} of {backAsk?.count} (the rest hold none, hold dust, or were refused)
          </Fact>
          <Fact label="Total to sell">
            {backAsk?.totalPairSold} {pair.symbol}
          </Fact>
          <Fact label="Expected back">≈ {backAsk?.totalQuotedEth} ETH, at the quote just taken</Fact>
          <Fact label="Each wallet keeps">its own proceeds — nothing is swept anywhere</Fact>
        </div>
        <p>
          Each sale is floored at {((backAsk?.overshootBps ?? 300) / 100).toFixed(1)}% below the live
          quote, so a worse fill reverts and that wallet keeps its {pair.symbol} rather than dumping
          it. A wallet whose whole balance would move the pool too far is refused outright, and one
          holding less than the gas costs to sell is left alone. Every wallet is reported either way.
        </p>
        <p className="hint">
          The quote moves between this dialog and the block that mines it. Run this BEFORE arming a
          launch — each wallet spends two nonces here (an approve and the swap), and arming signs
          against the nonce it reads.
        </p>
      </Modal>
    </Step>
  );
}
