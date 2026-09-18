import { memo } from 'react';
import { m } from 'framer-motion';
import { LuExternalLink, LuKeyRound, LuRefreshCw, LuTrash2 } from 'react-icons/lu';
import { addressUrl, fmtPct, fmtPrice, fmtUnits, pctOfSupply, quoteSymbol, shortAddr, toNumber, txUrl } from './format.js';

/**
 * The wallets holding the open token. Rows come from session.view(): address,
 * balances and status — never a key. A status change animates the status cell
 * only (keyed m.span); nothing animates between a click and the network call.
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

function WalletTable({ view, venue, getMark, walletCount, onTick, onTickAll, onRefresh, onRetryArm, onImport, onClear, refreshing }) {
  const mark = getMark();
  const price = mark && Number.isFinite(mark.price) ? mark.price : null;
  const sym = quoteSymbol(venue);
  const allTicked = view.rows.length > 0 && view.rows.every((r) => r.ticked);
  return (
    <div className="wallets" data-testid="wallet-table">
      <div className="wallets-head">
        <span className="wallets-count">
          {view.rows.length} holding · {view.totals.ticked} ticked · {walletCount} imported
        </span>
        <div className="wallets-actions">
          {view.totals.failedArm > 0 && (
            <button type="button" className="amber" onClick={onRetryArm}>
              Retry approvals ({view.totals.failedArm})
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
      {view.rows.length === 0 ? (
        <p className="empty-rows">
          {walletCount === 0 ? 'Import the wallets that hold this token.' : 'None of the imported wallets holds this token.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="tick">
                  <input type="checkbox" checked={allTicked} onChange={(e) => onTickAll(e.target.checked)} aria-label="Tick every wallet" />
                </th>
                <th>Wallet</th>
                <th className="num">Tokens</th>
                <th className="num">% supply</th>
                <th className="num">Value ({sym})</th>
                <th className="num">ETH for gas</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((r) => {
                const value = price === null ? null : toNumber(r.tokens, venue.decimals) * price;
                return (
                  <tr key={r.address} className={r.ticked ? '' : 'is-off'} data-testid="wallet-row">
                    <td className="tick">
                      <input type="checkbox" checked={r.ticked} onChange={(e) => onTick(r.address, e.target.checked)} aria-label={`Tick ${r.address}`} />
                    </td>
                    <td className="addr">
                      <a href={addressUrl(r.address)} target="_blank" rel="noopener noreferrer" title={r.address}>
                        {shortAddr(r.address)}
                      </a>
                    </td>
                    <td className="num">{fmtUnits(r.tokens, venue.decimals, 2)}</td>
                    <td className="num">{fmtPct(pctOfSupply(r.tokens, venue.totalSupply), 3)}</td>
                    <td className="num">{value === null ? '—' : fmtPrice(value)}</td>
                    <td className={`num${r.gasShort ? ' is-short' : ''}`} title={r.gasShort || ''}>
                      {fmtUnits(r.ethBalance, 18, 5)}
                    </td>
                    <td className="st">
                      <StatusCell row={r} />
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
