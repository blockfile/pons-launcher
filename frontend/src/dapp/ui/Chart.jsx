import { memo, useEffect, useRef, useState } from 'react';
import { CandlestickSeries, HistogramSeries, createChart, createSeriesMarkers } from 'lightweight-charts';
import { fmtPrice, fmtUsd, quoteSymbol } from './format.js';
import {
  TIMEFRAMES,
  cleanBars,
  crosshairTime,
  displayBar,
  drainBars,
  mcFactor,
  mergeOlderBar,
  minMoveFor,
  ownMarkers,
  tickLabel,
  tradeId,
  upsertBar,
  volumeBar,
} from './chartMath.js';

const RECENT = 500; // trades kept to match a sell hash registered after its trade arrived
const MAX_OWN = 300; // own-sell markers kept

function cssVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

/**
 * The candle chart. lightweight-charts v5 through refs only: the snapshot is
 * setData(), live bars are series.update() batched per animation frame from a
 * queue — never React state, so a burst of trades re-renders nothing. Candles
 * are drawn in quote units x a market-cap factor (MC in USD by default), or in
 * quote units (price) when the toggle says so or the USD price is missing.
 * Own sells (hashes this page sent) are series markers. The TradingView
 * attribution logo stays on (layout.attributionLogo), and App's footer carries
 * the NOTICE line.
 */
function Chart({ hub, venue, interval, onInterval, quoteUsd, own }) {
  const boxRef = useRef(null);
  const apiRef = useRef(null);
  const rawRef = useRef([]);
  const queueRef = useRef(new Map());
  const rafRef = useRef(0);
  const intervalRef = useRef(interval);
  const factorRef = useRef(null);
  const ownTradesRef = useRef(new Map());
  const recentRef = useRef([]);
  const [mode, setMode] = useState('mc');
  const [status, setStatus] = useState(null);

  const factor = mode === 'mc' ? mcFactor(venue, quoteUsd && quoteUsd.usd) : null;
  const mcBlocked = mode === 'mc' && factor === null;

  function isOwnSell(t) {
    return !!t && t.side === 'sell' && own.current.txs.has(String(t.tx).toLowerCase());
  }

  function paintMarkers() {
    const a = apiRef.current;
    if (!a) return;
    a.markers.setMarkers(ownMarkers([...ownTradesRef.current.values()], intervalRef.current, a.colors.own));
  }

  function addOwn(t) {
    ownTradesRef.current.set(tradeId(t), t);
    if (ownTradesRef.current.size > MAX_OWN) {
      const first = ownTradesRef.current.keys().next().value;
      ownTradesRef.current.delete(first);
    }
  }

  function paintAll() {
    const a = apiRef.current;
    if (!a) return;
    const f = factorRef.current;
    const bars = rawRef.current.map((b) => displayBar(b, f));
    const minMove = minMoveFor(bars.map((b) => b.low));
    // minMove is a power of ten; the base is its exact inverse. Math.round(1 / 1e-18)
    // is 999999999999999900, which lightweight-charts' tick maths rejects ('unexpected base').
    const base = 10 ** -Math.round(Math.log10(minMove));
    a.candle.applyOptions({
      priceFormat: { type: 'custom', minMove, base, formatter: f === null ? (p) => fmtPrice(p) : (p) => fmtUsd(p) },
    });
    a.candle.setData(bars);
    a.volume.setData(rawRef.current.map((b) => volumeBar(b, a.colors)));
    paintMarkers();
  }

  useEffect(() => {
    const colors = {
      up: cssVar('--candle-up', '#3fb6e0'),
      down: cssVar('--candle-down', '#d46bd0'),
      upVol: cssVar('--candle-up-vol', 'rgba(63, 182, 224, 0.32)'),
      downVol: cssVar('--candle-down-vol', 'rgba(212, 107, 208, 0.32)'),
      own: cssVar('--marker-own', '#ececf2'),
      text: cssVar('--dim', '#a2a2b0'),
      grid: cssVar('--rule-soft', '#26262d'),
      rule: cssVar('--rule', '#45454f'),
      bg: cssVar('--panel', '#131318'),
    };
    const chart = createChart(boxRef.current, {
      autoSize: true,
      layout: {
        background: { type: 'solid', color: colors.bg },
        textColor: colors.text,
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 11,
        attributionLogo: true,
      },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderColor: colors.rule },
      timeScale: { borderColor: colors.rule, timeVisible: true, secondsVisible: intervalRef.current < 60, tickMarkFormatter: tickLabel },
      localization: { timeFormatter: crosshairTime },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: '',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const markers = createSeriesMarkers(candle, []);
    apiRef.current = { chart, candle, volume, markers, colors };

    // One animation frame's bar updates. A bar at or after the chart's newest
    // time is series.update(); an OLDER bar (a late trade in an earlier bucket,
    // Task 7 contract note 4) either replaces a time the chart already has —
    // series.update(bar, true), lightweight-charts 5.2.1's historicalUpdate — or
    // is a time the chart lacks, merged into the raw list and repainted with
    // setData (update cannot insert into the middle). Any update that throws
    // also falls back to one repaint from the raw list, so a candle is never
    // left wrong until the next snapshot.
    const flush = () => {
      rafRef.current = 0;
      const a = apiRef.current;
      if (!a) return;
      const raw = rawRef.current;
      const f = factorRef.current;
      let repaint = false;
      for (const b of drainBars(queueRef.current)) {
        const how = upsertBar(raw, b);
        const historical = how === 'stale';
        if (historical && mergeOlderBar(raw, b) === 'insert') repaint = true;
        if (repaint) continue; // raw already holds it; paintAll() below draws it
        try {
          a.candle.update(displayBar(b, f), historical);
          a.volume.update(volumeBar(b, a.colors), historical);
        } catch {
          repaint = true;
        }
      }
      if (repaint) paintAll();
    };
    const schedule = () => {
      if (!rafRef.current) rafRef.current = requestAnimationFrame(flush);
    };

    const offs = [
      hub.on('snapshot', (d) => {
        // A snapshot of a timeframe the visitor has already left never paints
        // (its live bars would all be dropped against intervalRef below).
        if (!d || (d.interval !== undefined && Number(d.interval) !== intervalRef.current)) return;
        queueRef.current.clear();
        rawRef.current = cleanBars(d.bars);
        recentRef.current = Array.isArray(d.trades) ? d.trades.slice(-RECENT) : [];
        ownTradesRef.current = new Map();
        for (const t of recentRef.current) if (isOwnSell(t)) addOwn(t);
        if (d.status) setStatus(d.status);
        paintAll();
        chart.timeScale().scrollToRealTime();
      }),
      hub.on('bar', (d) => {
        if (!d || !d.bar || Number(d.interval) !== intervalRef.current) return;
        queueRef.current.set(d.bar.time, d.bar);
        schedule();
      }),
      hub.on('trades', (list) => {
        if (!Array.isArray(list) || !list.length) return;
        const r = recentRef.current;
        r.push(...list);
        if (r.length > RECENT) r.splice(0, r.length - RECENT);
        let added = false;
        for (const t of list) {
          if (isOwnSell(t)) {
            addOwn(t);
            added = true;
          }
        }
        if (added) paintMarkers();
      }),
      hub.on('own', (hashes) => {
        const set = new Set((hashes || []).map((h) => String(h).toLowerCase()));
        let added = false;
        for (const t of recentRef.current) {
          if (t && t.side === 'sell' && set.has(String(t.tx).toLowerCase())) {
            addOwn(t);
            added = true;
          }
        }
        if (added) paintMarkers();
      }),
      hub.on('status', (s) => {
        setStatus((prev) => (prev && s && prev.state === s.state && prev.detail === s.detail ? prev : s || null));
      }),
    ];

    return () => {
      offs.forEach((off) => off());
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      apiRef.current = null;
      chart.remove();
    };
    // Mounted once per token (App keys Chart by token); everything else flows through refs.
  }, [hub]);

  useEffect(() => {
    factorRef.current = factor;
    paintAll();
  }, [factor]);

  useEffect(() => {
    intervalRef.current = interval;
    const a = apiRef.current;
    if (a) a.chart.applyOptions({ timeScale: { secondsVisible: interval < 60 } });
  }, [interval]);

  const sym = quoteSymbol(venue);
  const lagging = status && status.state && status.state !== 'live' && status.state !== 'ok';
  return (
    <section className="pane chart-pane" aria-label="Price chart">
      <div className="chart-head">
        <div className="seg-group" role="group" aria-label="Chart shows">
          <button type="button" className={`seg${mode === 'mc' ? ' is-on' : ''}`} aria-pressed={mode === 'mc'} onClick={() => setMode('mc')}>
            MC $
          </button>
          <button type="button" className={`seg${mode === 'price' ? ' is-on' : ''}`} aria-pressed={mode === 'price'} onClick={() => setMode('price')}>
            Price {sym}
          </button>
        </div>
        <div className="seg-group" role="group" aria-label="Timeframe">
          {TIMEFRAMES.map((t) => (
            <button
              key={t.sec}
              type="button"
              className={`seg${interval === t.sec ? ' is-on' : ''}`}
              aria-pressed={interval === t.sec}
              onClick={() => onInterval(t.sec)}
              data-testid={`tf-${t.label}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {lagging && (
          <span className="chart-status" role="status">
            {String(status.state).split('_').join(' ')}
            {status.detail ? ` — ${status.detail}` : ''}
          </span>
        )}
      </div>
      <div className="chart-box" ref={boxRef} data-testid="chart" />
      {mcBlocked && (
        <p className="chart-note">
          Market cap needs a USD price ({(quoteUsd && quoteUsd.reason) || 'unavailable'}) — showing price in {sym}.
        </p>
      )}
    </section>
  );
}

export default memo(Chart);
