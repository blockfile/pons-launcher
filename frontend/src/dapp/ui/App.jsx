import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LazyMotion, MotionConfig, domAnimation } from 'framer-motion';
import { LuLock, LuShieldAlert } from 'react-icons/lu';
import * as api from '../api.js';
import { addresses as storedAddresses, clearWallets } from '../keys/walletStore.js';
import { VAULT_KEY, hasVault, wipeVault } from '../keys/vault.js';
import { USDG } from '../chain/constants.js';
import { createHub } from './hub.js';
import { createSession } from './session.js';
import { realDeps } from './deps.js';
import { loadPresets, loadSlippage, savePresets, saveSlippage, slippageToBps } from './prefs.js';
import { stageOf, summarizeSkips } from './sellMath.js';
import { errText } from './format.js';
import { usePrefersReducedMotion } from './useLiveMark.js';
import TokenBar from './TokenBar.jsx';
import Chart from './Chart.jsx';
import TradesFeed from './TradesFeed.jsx';
import SellPanel from './SellPanel.jsx';
import WalletTable from './WalletTable.jsx';
import ImportDialog, { VaultBar } from './ImportDialog.jsx';
import Toasts from './Toasts.jsx';
import './dapp.css';

// three.js lives in its own lazy chunk and is only requested while no token is open.
const EmptyScene = lazy(() => import('./EmptyScene.jsx'));

const EMPTY_VIEW = { rows: [], totals: { tokens: '0', ticked: 0, sellable: 0, arming: 0, failedArm: 0, convertible: 0 } };
const FEES_EVERY_MS = 15_000;
// While no stream is live (refused, reconnecting, a shared NAT's 429), the mark
// and the venue are polled instead: a curve floor is never priced from a mark
// frozen at page load, and a graduation is still followed.
const MARK_POLL_MS = 3_000;
const OFFLINE_STATUS = { state: 'reconnecting', detail: 'live data paused — the price refreshes every 3 s' };

function safeHasVault() {
  try {
    return hasVault();
  } catch {
    return false;
  }
}

/**
 * The page's state machine: empty (no token) -> token (venue open, no holder
 * rows) -> wallets (rows, none sellable yet) -> armed (a ticked wallet can
 * sell). App holds only what renders slowly — venue, the session VIEW
 * (addresses, balances, statuses), settings. Keys never reach it: they live in
 * walletStore's closure; the session signs through walletStore.signTx. Stream
 * data (bars, trades, marks) goes through the hub to the components that draw
 * it, so a burst of trades re-renders neither App nor the sell panel.
 */
export default function App() {
  const hub = useMemo(() => createHub(), []);
  const own = useRef({ txs: new Set(), addrs: new Set() });
  const sessionRef = useRef(null);
  const streamsRef = useRef([]);
  const streamLiveRef = useRef(false);
  const tfRef = useRef(1);
  const markRef = useRef(null);
  const [venue, setVenue] = useState(null);
  const [opening, setOpening] = useState(false);
  const [tokenError, setTokenError] = useState('');
  const [tf, setTf] = useState(1);
  const [view, setView] = useState(EMPTY_VIEW);
  const [fees, setFees] = useState(null);
  const [quoteUsd, setQuoteUsd] = useState({ usd: null, reason: 'loading' });
  const [presets, setPresets] = useState(() => loadPresets());
  const [slippage, setSlippage] = useState(() => loadSlippage());
  const [importOpen, setImportOpen] = useState(false);
  const [vault, setVault] = useState(() => (safeHasVault() ? 'locked' : 'none'));
  const [walletCount, setWalletCount] = useState(0);
  const [tab, setTab] = useState('wallets');
  const [refreshing, setRefreshing] = useState(false);
  const reducedMotion = usePrefersReducedMotion();
  const token = venue ? venue.token : null;
  const stage = stageOf({ venue, rows: view.rows });

  const toast = useCallback((message, kind = 'info') => hub.emit('toast', { message, kind }), [hub]);
  const getMark = useCallback(() => markRef.current, []);

  const syncOwnAddrs = useCallback(() => {
    const list = storedAddresses();
    own.current.addrs = new Set(list.map((a) => a.toLowerCase()));
    setWalletCount(list.length);
    return list;
  }, []);

  const closeSession = useCallback(() => {
    if (sessionRef.current) sessionRef.current.dispose();
    sessionRef.current = null;
    setView(EMPTY_VIEW);
  }, []);

  useEffect(() => () => closeSession(), [closeSession]);

  const loadInto = useCallback(
    (session, list) => {
      if (session && list.length) session.loadWallets(list).catch((e) => toast(`Could not read the wallets: ${errText(e)}`, 'error'));
    },
    [toast]
  );

  const openToken = useCallback(
    async (ca) => {
      setOpening(true);
      setTokenError('');
      try {
        const [{ venue: v, mark }, f] = await Promise.all([api.getToken(ca), api.getFees()]);
        closeSession();
        markRef.current = mark;
        own.current.txs = new Set();
        const s = createSession({
          venue: v,
          mark,
          fees: f,
          slippageBps: slippageToBps(slippage),
          own: own.current,
          hub,
          deps: realDeps,
          onView: setView,
          onVenue: setVenue, // a graduation the session followed (stream, /wallets, poll)
        });
        sessionRef.current = s;
        s.setLive(streamLiveRef.current); // the same token re-opened keeps its live stream
        s.start();
        setFees(f);
        setVenue(v);
        setTab('wallets');
        loadInto(s, syncOwnAddrs());
      } catch (e) {
        setTokenError(errText(e));
      } finally {
        setOpening(false);
      }
    },
    [closeSession, hub, loadInto, slippage, syncOwnAddrs]
  );

  const closeToken = useCallback(() => {
    closeSession();
    markRef.current = null;
    setVenue(null);
    setTokenError('');
  }, [closeSession]);

  // The session follows a venue the server reports (a graduation): the stream's
  // snapshot and phase event, the /wallets answers and the offline poll.
  const followVenue = useCallback(
    (v) => {
      const session = sessionRef.current;
      if (session && v) session.applyVenue(v).catch((e) => toast(`Re-arming after the venue change failed: ${errText(e)}`, 'error'));
    },
    [toast]
  );

  const setStreamLive = useCallback(
    (on) => {
      if (streamLiveRef.current === on) return;
      streamLiveRef.current = on;
      if (sessionRef.current) sessionRef.current.setLive(on);
      if (!on) hub.emit('status', OFFLINE_STATUS);
    },
    [hub]
  );

  // Close every stream when the token changes or the page unmounts.
  useEffect(() => {
    if (!token) return undefined;
    return () => {
      for (const s of streamsRef.current) s.close();
      streamsRef.current = [];
      streamLiveRef.current = false;
    };
  }, [token]);

  // One stream per (token, timeframe). Make-before-break: the old stream keeps
  // feeding the page until the new one's snapshot arrives, so a timeframe
  // switch opens no gap in which a receipt could be missed. Only the live
  // stream and the NEWEST pending one exist: a pending stream for a timeframe
  // the visitor has already left is closed, never promoted.
  useEffect(() => {
    if (!token) return;
    tfRef.current = tf;
    for (const other of streamsRef.current) if (!other.live) other.close();
    streamsRef.current = streamsRef.current.filter((e) => e.live);
    const entry = { close: () => {}, live: false, interval: tf };
    entry.close = api.openStream(token, tf, (name, data) => {
      const session = sessionRef.current;
      if (name === 'receipt') {
        if (session) session.onReceipt(data); // any stream; the session drops duplicates
        return;
      }
      if (name === 'snapshot') {
        if (!entry.live) {
          if (tfRef.current !== entry.interval) return; // a timeframe already left
          entry.live = true;
          for (const other of streamsRef.current) if (other !== entry) other.close();
          streamsRef.current = [entry];
        } else if (session) {
          session.onReconnect(); // an auto-reconnect: settle what the gap swallowed
        }
        setStreamLive(true);
      }
      if (!entry.live) {
        // The first stream of the token is refused or retrying: say so on the chart.
        const down = name === 'stream:retry' || name === 'stream:error';
        if (down && !streamLiveRef.current && tfRef.current === entry.interval) hub.emit('status', OFFLINE_STATUS);
        return;
      }
      switch (name) {
        case 'snapshot':
          if (data && data.mark) {
            markRef.current = data.mark;
            if (session) session.onMark(data.mark);
          }
          if (data && data.venue) followVenue(data.venue); // a graduation while the stream was away
          hub.emit('snapshot', data);
          break;
        case 'mark':
          markRef.current = data;
          if (session) session.onMark(data);
          hub.emit('mark', data);
          break;
        case 'phase':
          if (data) followVenue(data);
          hub.emit('phase', data);
          break;
        case 'stream:retry':
        case 'stream:error':
          setStreamLive(false);
          break;
        case 'trades':
          if (session) session.onTrades(data); // a mark older than these trades is behind the curve
          hub.emit('trades', data);
          break;
        case 'bar':
          hub.emit('bar', data);
          break;
        case 'status':
          hub.emit('status', data);
          break;
        default:
          break;
      }
    });
    streamsRef.current.push(entry);
  }, [token, tf, hub, followVenue, setStreamLive]);

  // No live stream: poll the mark and the venue so the session never prices a
  // curve floor from a frozen mark and still follows a graduation.
  useEffect(() => {
    if (!token) return undefined;
    let dead = false;
    const id = setInterval(async () => {
      if (streamLiveRef.current) return;
      try {
        const { venue: v, mark } = await api.getToken(token);
        if (dead) return;
        if (mark) {
          markRef.current = mark;
          if (sessionRef.current) sessionRef.current.onMark(mark);
          hub.emit('mark', mark);
        }
        followVenue(v);
      } catch {
        // the next poll (or the stream coming back) catches up
      }
    }, MARK_POLL_MS);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [token, hub, followVenue]);

  // Gas price (and the backend's ETH/USD) stay warm: the click path never fetches them.
  useEffect(() => {
    if (!token) return undefined;
    let dead = false;
    const id = setInterval(async () => {
      try {
        const f = await api.getFees();
        if (dead) return;
        setFees(f);
        if (sessionRef.current) sessionRef.current.setFees(f);
      } catch {
        // keep the last fees
      }
    }, FEES_EVERY_MS);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [token]);

  // USD per ONE quote unit, for market cap. ETH-quoted: the backend's ETH/USD.
  // USDG: 1. Any other pair (AMZN…): a 1-unit pair->ETH quote x ETH/USD. When
  // any input is missing the figure is absent with a reason — never a guess.
  const ethUsd = fees && Number(fees.ethUsd) > 0 ? Number(fees.ethUsd) : null;
  const pairToken = venue ? venue.pairToken : null;
  const nativeQuote = venue ? venue.nativeQuote : true;
  const pairDecimals = venue ? venue.pairDecimals : 18;
  const pairSymbol = venue ? venue.pairSymbol : '';
  useEffect(() => {
    if (!token) return undefined;
    if (ethUsd === null) {
      setQuoteUsd({ usd: null, reason: 'ETH price unavailable' });
      return undefined;
    }
    if (nativeQuote) {
      setQuoteUsd({ usd: ethUsd, reason: null });
      return undefined;
    }
    if (pairToken && String(pairToken).toLowerCase() === String(USDG).toLowerCase()) {
      setQuoteUsd({ usd: 1, reason: null });
      return undefined;
    }
    let dead = false;
    const unit = (10n ** BigInt(pairDecimals ?? 18)).toString();
    const refuse = () => {
      if (!dead) setQuoteUsd({ usd: null, reason: `no ${pairSymbol} → ETH price` });
    };
    api.postPairQuote(pairToken, unit).then((q) => {
      if (dead) return;
      const eth = q && q.ok ? Number(q.amountOut) / 1e18 : NaN;
      if (Number.isFinite(eth) && eth > 0) setQuoteUsd({ usd: eth * ethUsd, reason: null });
      else refuse();
    }, refuse);
    return () => {
      dead = true;
    };
  }, [token, ethUsd, nativeQuote, pairToken, pairDecimals, pairSymbol]);

  const onSell = useCallback(
    async (pct) => {
      const s = sessionRef.current;
      if (!s) return;
      const out = await s.sell(pct);
      const skipped = out.skipped.length ? ` · skipped: ${summarizeSkips(out.skipped)}` : '';
      if (out.sent > 0) {
        const failed = out.failed ? `, ${out.failed} failed` : '';
        toast(`${pct}%: ${out.sent} sell${out.sent === 1 ? '' : 's'} sent${failed}${skipped}`, out.failed ? 'error' : 'ok');
      } else {
        toast(`${pct}%: nothing sent — ${out.reason || 'every send failed'}${skipped}`, 'error');
      }
    },
    [toast]
  );

  const preview = useCallback((pct) => (sessionRef.current ? sessionRef.current.preview(pct) : null), []);

  const onPresets = useCallback((list) => {
    const clean = savePresets(list);
    if (clean) setPresets(clean);
    return clean;
  }, []);

  const onSlippage = useCallback((value) => {
    const n = saveSlippage(value);
    if (n !== null) {
      setSlippage(n);
      if (sessionRef.current) sessionRef.current.setSlippage(slippageToBps(n));
    }
    return n;
  }, []);

  const onTick = useCallback((address, on) => sessionRef.current && sessionRef.current.setTicked(address, on), []);
  const onTickAll = useCallback((on) => sessionRef.current && sessionRef.current.setAllTicked(on), []);
  const onRetryArm = useCallback(() => sessionRef.current && sessionRef.current.arm({ retry: true }), []);
  // Pair-token proceeds (AMZN, SPCX...) -> ETH now: one wallet, or every wallet with some.
  const onConvert = useCallback((address) => sessionRef.current && sessionRef.current.convertPair(address), []);

  const onRefresh = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    setRefreshing(true);
    try {
      await s.loadWallets(syncOwnAddrs());
    } catch (e) {
      toast(`Refresh failed: ${errText(e)}`, 'error');
    } finally {
      setRefreshing(false);
    }
  }, [syncOwnAddrs, toast]);

  // Clear empties this tab. A copy saved on this device is NOT this tab: say so,
  // and offer to delete it too — otherwise it unlocks again on the next visit.
  const onClear = useCallback(() => {
    if (!window.confirm('Remove every wallet from this tab? You will need the keys again to sell.')) return;
    clearWallets();
    realDeps.pairLedger.clear(); // what the page remembered about these wallets goes with them
    syncOwnAddrs();
    if (sessionRef.current) sessionRef.current.reset();
    if (!safeHasVault()) return;
    if (window.confirm('Also delete the encrypted copy of your wallets saved on this device? Otherwise it unlocks again on the next visit.')) {
      wipeVault();
      setVault('none');
      toast('Wallets removed from this tab and deleted from this device', 'ok');
    } else {
      // This tab no longer holds the saved wallets: a save now would replace them.
      setVault('locked');
      toast('The encrypted copy stays on this device — Forget deletes it', 'info');
    }
  }, [syncOwnAddrs, toast]);

  const onImported = useCallback(
    ({ added, duplicates, rejected, saved = 0, saveError = '' }) => {
      const list = syncOwnAddrs();
      if (saved > 0) setVault('unlocked');
      const dup = duplicates ? `, ${duplicates} already here` : '';
      const bad = rejected ? `, ${rejected} rows refused` : '';
      const kept = saved > 0 ? ` · ${saved} saved on this device` : saveError ? ' · NOT saved on this device' : '';
      toast(`${added} wallet${added === 1 ? '' : 's'} added${dup}${bad}${kept}`, rejected || saveError ? 'error' : 'ok');
      loadInto(sessionRef.current, list);
    },
    [loadInto, syncOwnAddrs, toast]
  );

  // Another tab of this page saved, replaced or deleted the vault.
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key !== null && e.key !== VAULT_KEY) return;
      const has = safeHasVault();
      setVault((prev) => {
        if (!has) return 'none';
        if (prev === 'none' || e.key === VAULT_KEY) return 'locked'; // unlocked here is no longer what is stored
        return prev;
      });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const onUnlocked = useCallback(
    (n) => {
      setVault('unlocked');
      const list = syncOwnAddrs();
      toast(`${n} saved wallet${n === 1 ? '' : 's'} unlocked`, 'ok');
      loadInto(sessionRef.current, list);
    },
    [loadInto, syncOwnAddrs, toast]
  );

  const onForget = useCallback(() => {
    if (!window.confirm('Delete the encrypted wallets saved on this device? Keys not kept elsewhere are lost.')) return;
    wipeVault();
    realDeps.pairLedger.clear(); // its entries can be linked to the wallets: they go too
    setVault('none');
    toast('Saved wallets deleted from this device', 'ok');
  }, [toast]);

  const openImport = useCallback(() => setImportOpen(true), []);
  const closeImport = useCallback(() => setImportOpen(false), []);

  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <div className={`dapp stage-${stage}`}>
          <p className="notice" role="note">
            <LuShieldAlert aria-hidden="true" /> Keys stay in this browser tab. Use trading wallets. A browser extension can read this page.
          </p>
          {vault === 'locked' && <VaultBar onUnlocked={onUnlocked} onForget={onForget} />}
          {vault === 'unlocked' && (
            <div className="vaultbar pane" role="status">
              <LuLock aria-hidden="true" />
              <span>These wallets are also saved on this device, encrypted with your passphrase.</span>
              <button type="button" className="ghost danger" onClick={onForget}>
                Forget saved wallets
              </button>
            </div>
          )}
          <TokenBar
            venue={venue}
            opening={opening}
            error={tokenError}
            onOpen={openToken}
            onClose={closeToken}
            hub={hub}
            getMark={getMark}
            quoteUsd={quoteUsd}
            walletCount={walletCount}
            onImport={openImport}
          />
          {!venue ? (
            <section className="empty pane" aria-label="No token open">
              {!reducedMotion && (
                <Suspense fallback={null}>
                  <EmptyScene />
                </Suspense>
              )}
              <div className="empty-copy">
                <h1>Take profit on a pons token</h1>
                <p>Paste the token&apos;s contract address, import the wallets that hold it, and sell a percentage from all of them with one click.</p>
                <p className="hint">pons v2 curves (ETH- or stock-token-paired), graduated pons v2 pools and pons v1 pools. Anything else is refused.</p>
              </div>
            </section>
          ) : (
            <main className="deck">
              <div className="deck-left">
                <Chart key={venue.token} hub={hub} venue={venue} interval={tf} onInterval={setTf} quoteUsd={quoteUsd} own={own} />
                <section className="pane tabs">
                  <div className="tabbar" role="tablist" aria-label="Wallets and trades">
                    <button type="button" role="tab" aria-selected={tab === 'wallets'} className={`seg${tab === 'wallets' ? ' is-on' : ''}`} onClick={() => setTab('wallets')}>
                      Wallets ({view.rows.length})
                    </button>
                    <button type="button" role="tab" aria-selected={tab === 'trades'} className={`seg${tab === 'trades' ? ' is-on' : ''}`} onClick={() => setTab('trades')}>
                      Trades
                    </button>
                  </div>
                  <div className="tab-body" hidden={tab !== 'wallets'}>
                    <WalletTable
                      view={view}
                      venue={venue}
                      getMark={getMark}
                      walletCount={walletCount}
                      onTick={onTick}
                      onTickAll={onTickAll}
                      onRefresh={onRefresh}
                      onRetryArm={onRetryArm}
                      onConvert={onConvert}
                      onImport={openImport}
                      onClear={onClear}
                      refreshing={refreshing}
                    />
                  </div>
                  <div className="tab-body" hidden={tab !== 'trades'}>
                    <TradesFeed key={venue.token} hub={hub} venue={venue} own={own} active={tab === 'trades'} />
                  </div>
                </section>
              </div>
              <aside className="deck-right">
                <SellPanel
                  view={view}
                  venue={venue}
                  fees={fees}
                  presets={presets}
                  onPresets={onPresets}
                  slippage={slippage}
                  onSlippage={onSlippage}
                  onSell={onSell}
                  preview={preview}
                  hub={hub}
                  getMark={getMark}
                />
              </aside>
            </main>
          )}
          <footer className="foot">
            Charts by TradingView Lightweight Charts&trade; &mdash; Copyright &copy; 2025 TradingView, Inc.{' '}
            <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">
              tradingview.com
            </a>
          </footer>
          {importOpen && <ImportDialog vault={vault} walletCount={walletCount} onClose={closeImport} onImported={onImported} />}
          <Toasts hub={hub} />
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}
