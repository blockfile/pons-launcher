import { memo } from 'react';
import { m } from 'framer-motion';
import { LuExternalLink, LuKeyRound, LuRefreshCw, LuTrash2 } from 'react-icons/lu';
import { addressUrl, fmtPct, fmtPrice, fmtUnits, fmtUsd, pctOfSupply, shortAddr, txUrl } from './format.js';
import { ROW_SELL_PCTS, rowSellBlocked } from './sellMath.js';
import { leftOf, rowValue } from './positions.js';
import { useLiveMark } from './useLiveMark.js';

/**
 * The wallets holding the open token. Rows come from session.view(): address,
 * balances and status — never a key. A status change animates the status cell
 * only (keyed m.span); nothing animates between a click and the network call.
 *
 * THE MONEY LAW (memory frontend-cell-and-caret), as this panel applies it:
 *   .spend  a row's 25 / 50 buttons and Convert — each spends on chain the
 *           instant it is pressed, no dialog: the 2px vermilion frame
 *   .live   a row's 100 button — empties that wallet: the vermilion block,
 *           WHITE label
 *   .amber  Retry approvals — the panel's ONE amber object, shown only when
 *           an approval failed
 * All / None / Invert and the tick boxes move no money: quiet grey.
 *
 * LIVE HOLDINGS (spec addendum C): tokens, value in ETH and USD, % of supply
 * and the %-left bar re-render with the price at most once a second
 * (useLiveMark) — this table only, never App or the sell panel. The bar's grey
 * part is what the wallet holds of its position (positions.js high-water
 * mark); the striped vermilion part is this tab's sells of it still in flight
 * (vermilion = live, the money law).
 */
function StatusCell({ row }) {
  return (
    <m.span
      key={`${row.status}:${row.hash || ''}:${row.detail}`}
      className={`status st-${row.status}`}
      initial={{ opacity: 0, y: -3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: [0.2, 0, 0, 1] }}
    >
      <span className="lamp" aria-hidden="true" />
      <span className="st-word">{row.status}</span>
      {row.detail && <span className="st-detail">{row.detail}</span>}
      {row.hash && (
        <a className="st-tx" href={txUrl(row.hash)} target="_blank" rel="noopener noreferrer" aria-label="Open the transaction">
          <LuExternalLink aria-hidden="true" />
        </a>
      )}
    </m.span>
  );
}

function LeftBar({ row, rec }) {
  const { left, flight, known } = leftOf(row, rec);
  // A balance this read could not fetch is unknown, not zero: an empty track reads as
  // "this wallet is done", which is exactly the wrong thing to tell someone watching a
  // take-profit run. The next read (20 s) fills it in.
  if (!known) {
    const label = 'balance not read — the next read fills this in';
    return (
      <span className="leftbar" title={label}>
        <span className="lb-track lb-unknown" role="img" aria-label={label} />
        <span className="lb-num">&mdash;</span>
      </span>
    );
  }
  const held = left * 100;
  const selling = flight * 100;
  const label = selling > 0 ? `${fmtPct(held, 1)} of the position left, ${fmtPct(selling, 1)} selling` : `${fmtPct(held, 1)} of the position left`;
  return (
    <span className="leftbar" title={label}>
      <span className="lb-track" role="img" aria-label={label}>
        <span className="lb-held" style={{ width: `${held}%` }} />
        {selling > 0 && <span className="lb-flight" style={{ width: `${selling}%` }} />}
      </span>
      <span className="lb-num">{fmtPct(held, 1)}</span>
    </span>
  );
}

function RowSell({ row, fees, onSellOne }) {
  const blocked = rowSellBlocked(row, fees);
  return (
    <span className="rowsell" role="group" aria-label={`Sell from ${row.address}, now`}>
      {ROW_SELL_PCTS.map((p) => (
        <button
          key={p}
          type="button"
          className={p === 100 ? 'live' : 'spend'}
          disabled={blocked !== ''}
          onClick={() => onSellOne(row.address, p)}
          title={blocked || (p === 100 ? 'Sells EVERYTHING in this wallet, now.' : `Sells ${p}% of this wallet, now.`)}
          aria-label={`Sell ${p}% of ${row.address} now`}
          data-testid={`row-sell-${p}`}
        >
          {p}
        </button>
      ))}
    </span>
  );
}

function WalletTable({
  view,
  venue,
  fees,
  hub,
  getMark,
  quoteUsd,
  ethPerQuote,
  positions,
  walletCount,
  onTick,
  onTickAll,
  onInvert,
  onSellOne,
  onRefresh,
  onRetryArm,
  onConvert,
  onImport,
  onClear,
  refreshing,
}) {
  const mark = useLiveMark(hub, getMark);
  const price = mark && Number.isFinite(mark.price) ? mark.price : null;
  const usdPerQuote = quoteUsd && Number.isFinite(quoteUsd.usd) ? quoteUsd.usd : null;
  const noPrice = price === null ? 'no price yet' : '';
  const noEth = noPrice || (ethPerQuote === null ? (quoteUsd && quoteUsd.reason) || `no ${venue.pairSymbol || 'pair'} → ETH price` : '');
  const noUsd = noPrice || (usdPerQuote === null ? (quoteUsd && quoteUsd.reason) || 'no USD price' : '');
  const tickedN = view.rows.filter((r) => r.ticked).length;
  const allTicked = view.rows.length > 0 && tickedN === view.rows.length;
  const someTicked = tickedN > 0 && !allTicked;
  const pairSym = venue.pairSymbol || 'pair';
  const convertible = view.totals.convertible || 0;
  // Rows stay listed after a 100 % sell (their receipts, unconverted proceeds): count the holders only.
  const holding = view.rows.filter((r) => r.tokens !== '0').length;
  const none = view.rows.length === 0;
  return (
    <div className="wallets" data-testid="wallet-table">
      <div className="wallets-head">
        <span className="wallets-count">
          {holding} holding · {view.totals.ticked} ticked · {walletCount} imported
        </span>
        <div className="wallets-pick" role="group" aria-label="Choose which wallets the chips sell from">
          <button type="button" className="seg" onClick={() => onTickAll(true)} disabled={none || allTicked} data-testid="tick-all">
            All
          </button>
          <button type="button" className="seg" onClick={() => onTickAll(false)} disabled={none || tickedN === 0} data-testid="tick-none">
            None
          </button>
          <button type="button" className="seg" onClick={onInvert} disabled={none} data-testid="tick-invert">
            Invert
          </button>
        </div>
        <div className="wallets-actions">
          {view.totals.failedArm > 0 && (
            <button type="button" className="amber" onClick={onRetryArm}>
              Retry approvals ({view.totals.failedArm})
            </button>
          )}
          {convertible > 0 && (
            // Swaps on chain with no dialog: the vermilion frame (money law), never a second amber.
            <button type="button" className="spend" onClick={() => onConvert()} title={`Swap the ${pairSym} these sells paid into ETH now`}>
              Convert {pairSym} → ETH ({convertible})
            </button>
          )}
          <button type="button" className="quiet" onClick={onRefresh} disabled={refreshing}>
            <LuRefreshCw aria-hidden="true" className={refreshing ? 'spin' : ''} /> Refresh
          </button>
          <button type="button" className="go" onClick={onImport}>
            <LuKeyRound aria-hidden="true" /> Import
          </button>
          <button type="button" className="ghost danger" onClick={onClear} disabled={walletCount === 0}>
            <LuTrash2 aria-hidden="true" /> Clear
          </button>
        </div>
      </div>
      {none ? (
        <p className="empty-rows">
          {walletCount === 0 ? 'Import the wallets that hold this token.' : 'None of the imported wallets holds this token.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="tick">
                  <label className="tick-hit">
                    <input
                      type="checkbox"
                      checked={allTicked}
                      ref={(el) => {
                        if (el) el.indeterminate = someTicked;
                      }}
                      onChange={(e) => onTickAll(e.target.checked)}
                      aria-label="Tick every wallet"
                    />
                  </label>
                </th>
                <th>Wallet</th>
                <th>Left</th>
                <th>Sell %</th>
                <th className="num">Tokens</th>
                <th className="num">Value (ETH)</th>
                <th className="num">Value (USD)</th>
                <th className="num">% supply</th>
                <th className="num">ETH for gas</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => {
                const value = rowValue({ tokens: r.tokens, decimals: venue.decimals, price, ethPerQuote, usdPerQuote });
                return (
                  <tr key={r.address} className={r.ticked ? '' : 'is-off'} data-testid="wallet-row">
                    <td className="tick">
                      <label className="tick-hit">
                        <input type="checkbox" checked={r.ticked} onChange={(e) => onTick(r.address, e.target.checked)} aria-label={`Tick ${r.address}`} />
                      </label>
                    </td>
                    <td className="addr">
                      <a href={addressUrl(r.address)} target="_blank" rel="noopener noreferrer" title={r.address}>
                        {shortAddr(r.address)}
                      </a>
                    </td>
                    <td className="left-cell">
                      <LeftBar row={r} rec={positions ? positions[r.address.toLowerCase()] : null} />
                    </td>
                    <td className="rowsell-cell">
                      <RowSell row={r} fees={fees} onSellOne={onSellOne} />
                    </td>
                    <td className="num">{fmtUnits(r.tokens, venue.decimals, 2)}</td>
                    <td className="num" title={value.eth === null ? noEth : ''}>
                      {value.eth === null ? '—' : fmtPrice(value.eth)}
                    </td>
                    <td className="num" title={value.usd === null ? noUsd : ''}>
                      {fmtUsd(value.usd)}
                    </td>
                    <td className="num">{fmtPct(pctOfSupply(r.tokens, venue.totalSupply), 3)}</td>
                    <td className={`num${r.gasShort ? ' is-short' : ''}`} title={r.gasShort || ''}>
                      {fmtUnits(r.ethBalance, 18, 5)}
                    </td>
                    <td className="st">
                      <StatusCell row={r} />
                      {r.canConvert && (
                        <button type="button" className="spend" onClick={() => onConvert(r.address)} aria-label={`Convert this wallet's ${pairSym} to ETH`}>
                          {fmtUnits(r.pairPending, venue.pairDecimals ?? 18, 4)} {pairSym} → ETH
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default memo(WalletTable);
