import Step from './Step.jsx';
import { isNativePair } from '../pairAssets.js';

/**
 * THE FIRST STATION — what the launch is priced in.
 *
 * It used to be a dropdown two thirds of the way down the launch form, which is
 * the LAST step, and it decides what almost every control above it means. So the
 * operator had to jump forward to pick a quote asset, then come back up to size
 * the bundle in it, fund the wallets for it and swap them into it. That round
 * trip is the whole reason this panel exists: the decision is made once, at the
 * front, and every step below READS it.
 *
 * Nothing here spends, signs or sends. Choosing a quote asset moves no money, so
 * this panel carries no amber and no vermilion — the select is a select, the
 * consequences are stated in grey, and the only thing that ever raises its voice
 * is the standing warning about an asset the wallets are still holding.
 *
 * The launch form keeps a picker of its own (it must state what it is pricing,
 * and an operator who has scrolled to the bottom should not have to scroll back
 * to change their mind), but it no longer OWNS the value: both pickers call the
 * same guarded setter in App, which asks before it strands anything.
 */
export default function QuotePanel({
  step,
  // The approved quote assets, native ETH first — pairOptions(/v2/configs).
  options = [],
  // The picker's own value, owned by App.
  value,
  // The resolved selection: symbol, decimals and curve constants. Native is not
  // a "pair" anywhere in this console, so this is the symbol and nothing else.
  symbol = 'ETH',
  native = true,
  // Has the factory read landed? Native-only until it has, and the picker says
  // so rather than presenting one option as if it were the whole list.
  loading = false,
  // Live facts about the bundle, so the consequences are stated about THIS run
  // rather than in the abstract.
  bundleCount = 0,
  holdings = { wallets: 0, total: '0', unknown: 0 },
  // An asset the console has walked away from while wallets were still holding
  // it. Remembered rather than read: once the launch is priced in something
  // else, that balance is not visible anywhere.
  stranded = null,
  onStrandedDismiss = () => {},
  // Ask App to change the quote asset. It confirms first when the change would
  // cost something; this panel never applies one itself.
  onRequest = () => {},
  // Step key -> live number, so this panel can name another station without
  // knowing where it sits in the plan.
  nums = {},
}) {
  const walletsStep = nums.wallets ? `step ${nums.wallets}` : 'the bundle wallets step';
  const fundStep = nums.fund ? `step ${nums.fund}` : 'the funding step';
  const swapStep = nums.swap ? `step ${nums.swap}` : 'the pair-buying step';
  const launchStep = nums.launch ? `step ${nums.launch}` : 'the launch step';

  return (
    <Step {...step}>
      <p className="lede">
        What this launch is priced in — the asset the curve charges, the dev buy is spent in and
        every bundle buy is denominated in. It is chosen here, first, because everything below is
        measured in it: choosing it after the wallets are funded means funding them again.
      </p>

      <div className="row">
        <span className="ctl-label">Priced in</span>
        {/* A select, in grey. Choosing a quote asset moves no money, so it takes
            none of the money colours — the law gives amber to the one spending
            action of a step and this step has none. */}
        <select
          value={value}
          disabled={loading}
          onChange={(e) => onRequest(e.target.value)}
          title="the asset the curve is priced in — every amount below is denominated in it"
        >
          {options.map((t) => (
            <option key={t.address} value={t.address}>
              {t.symbol}
              {isNativePair(t.address)
                ? ' (native)'
                : ` — ${t.address.slice(0, 6)}…${t.address.slice(-4)}`}
            </option>
          ))}
        </select>
        <span className="hint">
          {loading
            ? 'reading the approved quote assets from the v2 factory…'
            : native
              ? 'native ETH — today\'s behaviour, and the default'
              : `${symbol} — the dev buy and every bundle buy are spent in ${symbol}, not ETH`}
        </span>
      </div>

      {/* WHAT THE CHOICE ACTUALLY CHANGES, in the two shapes it can take. The
          native list is short because native is the simple case: there is no
          second token, so there is no swap, no approval and no balance to keep
          an eye on. Drawing the paired machinery on a native launch was the
          other half of the confusion this panel is fixing. */}
      <div className="notice">
        {/* Named without an article on purpose: "a NVDA-priced launch" and "an
            NVDA-priced launch" are both wrong-looking, and a ticker should not
            make the copy pick one. */}
        <h3>{native ? 'Priced in native ETH' : `Priced in ${symbol}`}</h3>
        {native ? (
          <ul>
            <li>
              every bundle wallet buys with the <b className="crux">ETH you fund it with</b> — one
              asset, one column, no swap
            </li>
            <li>
              the dev buy comes out of the dev wallet's own ETH, inside the launch transaction
            </li>
            <li>
              the supply share, the market cap and the graduation threshold below are all in ETH
            </li>
          </ul>
        ) : (
          <ul>
            <li>
              the Buy column in {walletsStep} is in <b>{symbol}</b>; the Fund column is{' '}
              <b>always ETH</b> — they are two assets in one table and never one sum
            </li>
            <li>
              every bundle wallet must <b className="crux">already hold its {symbol}</b> when the
              launch is armed: the buys are signed before the token exists, and a wallet holding
              none is dropped by preflight
            </li>
            <li>
              {symbol} <b className="crux">cannot be sent to a bundle wallet</b> — every transfer
              path here moves native ETH, at both ends. So each wallet BUYS its own, out of its own
              balance, which is why the ETH has to arrive first. Straight down the page: size the
              bundle in {walletsStep} → fund it with ETH in {fundStep} → each wallet buys {symbol} in{' '}
              {swapStep} → launch.
            </li>
            <li>
              the dev wallet needs its own <b>{symbol}</b> balance for the dev buy — this console
              funds bundle wallets into {symbol}, never the dev wallet
            </li>
            <li>
              the curve, the market cap and the graduation threshold in {walletsStep} and{' '}
              {launchStep} are all in {symbol} — its own curve, not ETH's
            </li>
          </ul>
        )}
      </div>

      {/* THE LIVE STATE OF THE CHOICE. Not a repeat of the pair column: one line
          saying how far the bundle already is into the asset that is selected
          RIGHT NOW, which is the fact that decides whether changing it is free. */}
      {!native && bundleCount > 0 && (
        <p className="hint">
          {holdings.wallets > 0
            ? `${holdings.wallets} of ${bundleCount} bundle wallet${bundleCount === 1 ? '' : 's'} ` +
              `already hold ${Number(holdings.total).toFixed(6)} ${symbol}. Changing the quote asset ` +
              `now leaves it with them — sell it back first, in ${swapStep}.`
            : `No bundle wallet holds ${symbol} yet, so changing the quote asset is still free.`}
          {holdings.unknown > 0 &&
            ` ${holdings.unknown} wallet${holdings.unknown === 1 ? ' has' : 's have'} no ${symbol} balance read yet — refresh balances in ${walletsStep}.`}
        </p>
      )}

      {/* AN ASSET LEFT BEHIND. Deliberately NOT a coloured notice: nothing here
          is live and nothing is irreversible — the tokens are exactly where they
          were and the way back is the control that already exists. One clause
          carries the weight (.crux) and the rest stays grey, which is what the
          law gives to everything that is not a state. */}
      {stranded && (
        <div className="notice">
          <h3>{stranded.wallets} wallet{stranded.wallets === 1 ? '' : 's'} still hold {stranded.symbol}</h3>
          <ul>
            <li>
              {Number(stranded.total).toFixed(6)} {stranded.symbol} was bought for a launch priced in{' '}
              {stranded.symbol}, and this launch is priced in {native ? 'ETH' : symbol} now
            </li>
            <li>
              this console reads the balance of <b className="crux">one quote asset at a time</b>, so
              that {stranded.symbol} is invisible here until the launch is priced in it again — it is
              not lost, and nothing has spent it
            </li>
            <li>
              to get the ETH back: price the launch in {stranded.symbol} again, then use{' '}
              <b>Recover ETH · sell {stranded.symbol} back</b> in {swapStep}. It sells each
              wallet's whole balance and keeps the ETH in the wallet.
            </li>
          </ul>
          <div className="row">
            <button
              type="button"
              className="ghost"
              onClick={() => onRequest(stranded.address)}
              title={`price this launch in ${stranded.symbol} again so its balances can be read and sold`}
            >
              Price in {stranded.symbol} again
            </button>
            <button type="button" className="link" onClick={onStrandedDismiss}>
              dismiss
            </button>
            <span className="hint">moves nothing — it only changes what this console is reading</span>
          </div>
        </div>
      )}
    </Step>
  );
}
