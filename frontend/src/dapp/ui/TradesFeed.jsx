import { memo, useEffect, useRef, useState } from 'react';
import { fmtAge, fmtUnits, quoteDecimals, quoteSymbol, shortAddr, txUrl } from './format.js';
import { mergeTrades, tradeId } from './chartMath.js';

const MAX = 100;

/**
 * The last 100 trades, newest first. It listens on the hub and keeps its own
 * state, painted at most once per animation frame, so a burst re-renders this
 * list only. The age column ticks once a second while the tab is showing.
 * Own rows: a tx this page sent, or a trader that is one of the loaded wallets.
 */
function TradesFeed({ hub, venue, own, active }) {
  const [trades, setTrades] = useState([]);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const bufRef = useRef([]);
  const rafRef = useRef(0);

  useEffect(() => {
    const paint = () => {
      rafRef.current = 0;
      setTrades(bufRef.current);
    };
    const schedule = () => {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(paint);
    };
    const offs = [
      hub.on('snapshot', (d) => {
        bufRef.current = mergeTrades([], (d && d.trades) || [], MAX);
        schedule();
      }),
      hub.on('trades', (list) => {
        if (!Array.isArray(list) || !list.length) return;
        bufRef.current = mergeTrades(bufRef.current, list, MAX);
        schedule();
      }),
      hub.on('own', () => {
        bufRef.current = [...bufRef.current];
        schedule();
      }),
    ];
    return () => {
      offs.forEach((off) => off());
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    };
  }, [hub]);

  useEffect(() => {
    if (!active) return undefined;
    setNowSec(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [active]);

  if (!trades.length) return <p className="empty-rows">No trades in the loaded window yet.</p>;
  const sym = quoteSymbol(venue);
  const qd = quoteDecimals(venue);
  const mine = own.current;
  return (
    <div className="table-wrap feed" data-testid="trades-feed">
      <table>
        <thead>
          <tr>
            <th>Age</th>
            <th>Side</th>
            <th className="num">Tokens</th>
            <th className="num">{sym}</th>
            <th>Trader</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => {
            const isOwn = mine.txs.has(String(t.tx).toLowerCase()) || mine.addrs.has(String(t.trader).toLowerCase());
            return (
              <tr key={tradeId(t)} className={isOwn ? 'is-own' : ''}>
                <td>
                  <a href={txUrl(t.tx)} target="_blank" rel="noopener noreferrer">
                    {fmtAge(nowSec - Number(t.ts))}
                  </a>
                </td>
                <td className={t.side === 'buy' ? 'side-buy' : 'side-sell'}>{t.side}</td>
                <td className="num">{fmtUnits(t.tokenAmt, venue.decimals, 2)}</td>
                <td className="num">{fmtUnits(t.quoteAmt, qd, 4)}</td>
                <td>
                  {shortAddr(String(t.trader || ''), 6, 4)}
                  {isOwn && <span className="you">you</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default memo(TradesFeed);
