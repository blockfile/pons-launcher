import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LazyMotion, MotionConfig, domAnimation } from 'framer-motion';
import { LuLock, LuShieldAlert } from 'react-icons/lu';
import * as api from '../api.js';
import { addresses as storedAddresses, clearWallets } from '../keys/walletStore.js';
import { VAULT_KEY, hasVault, unlockVault, wipeVault } from '../keys/vault.js';
import { createAccount } from '../account/account.js';
import { createDiscovery } from '../account/discover.js';
import { createKeyCache } from '../account/keyCache.js';
import { createVaultSync } from '../account/vaultSync.js';
import { USDG } from '../chain/constants.js';
import { createHub } from './hub.js';
import { createSession } from './session.js';
import { createFeed } from './feed.js';
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
import AccountBar from './AccountBar.jsx';
import { useStore } from './useStore.js';
import Toasts from './Toasts.jsx';
import './dapp.css';

// three.js lives in its own lazy chunk and is only requested while no token is open.
const EmptyScene = lazy(() => import('./EmptyScene.jsx'));

const EMPTY_VIEW = { rows: [], totals: { tokens: '0', ticked: 0, sellable: 0, arming: 0, failedArm: 0, convertible: 0 } };
const FEES_EVERY_MS = 15_000;

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
  const markRef = useRef(null);
  const followRef = useRef(() => {});
  // The open token's streams, liveness and offline poll (feed.js): events reach
  // the session of THAT token only, and a switch never inherits a live stream.
  const feedRef = useRef(null);
  if (feedRef.current === null) {
    feedRef.current = createFeed({
      api,
      hub,
      getSession: () => sessionRef.current,
      setMark: (m) => {
        markRef.current = m;
      },
      followVenue: (v) => followRef.current(v),
    });
  }
  const feed = feedRef.current;
  // The account (spec Addendum A): wallet discovery, the SIWE session and the
  // unlock key. Made once per page. The key never reaches React: the sync gets
  // it from account.keyFor(); React sees the account's state and keyEpoch only.
  const discovery = useMemo(() => createDiscovery(), []);
  const account = useMemo(() => createAccount({ api, discovery, keyCache: createKeyCache() }), [discovery]);
  const acct = useStore(account);
  const discovered = useStore(discovery);
  const syncRef = useRef(null);
  const [sync, setSync] = useState(null);
  const [syncGen, setSyncGen] = useState(0); // +1 restarts the sync for the same key
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
        s.setLive(feed.isLive(v.token)); // the same token re-opened keeps its live stream; another token never does
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
    [closeSession, feed, hub, loadInto, slippage, syncOwnAddrs]
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

  followRef.current = followVenue;

  // The token's live feed (feed.js): its streams (make-before-break across a
  // timeframe switch), its liveness and the offline mark/venue poll. A token
  // switch closes the old token's feed before the new one opens.
  useEffect(() => {
    if (!token) return undefined;
    feed.open(token);
    return () => feed.close();
  }, [feed, token]);

  useEffect(() => {
    if (token) feed.setTimeframe(tf);
  }, [feed, token, tf]);

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
    const fromAccount = account.get().status === 'unlocked';
    const ask = fromAccount
      ? "Remove every wallet from this tab AND from your account's saved copy? You will need the keys again to sell."
      : 'Remove every wallet from this tab? You will need the keys again to sell.';
    if (!window.confirm(ask)) return;
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
  }, [account, syncOwnAddrs, toast]);

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

  // ── the account ─────────────────────────────────────────────────────────────
  useEffect(() => {
    discovery.start();
    account.resume();
    return () => {
      discovery.stop();
      account.dispose();
    };
  }, [account, discovery]);

  // The account copy changed this tab's wallets (another device's import or removal).
  const onSyncApplied = useCallback(
    ({ added, removed, unreadable }) => {
      const list = syncOwnAddrs();
      const s = sessionRef.current;
      // Only the rows of the wallets that left go (session.removeRows); a row with
      // a sell, an approval or a pair leg in flight goes once that settles. Never
      // the session's reset here: this runs whenever another device's change
      // arrives, and a reset forgets every OTHER wallet's sells in flight, the
      // curve walk and the owed pair legs — the reload would then offer tokens
      // that are still being sold, and the next click would sell them twice.
      let finishing = 0;
      if (s && removed) {
        const held = new Set(list.map((a) => a.toLowerCase()));
        finishing = s.removeRows(s.view().rows.map((r) => r.address).filter((a) => !held.has(a.toLowerCase()))).deferred;
      }
      if (added) loadInto(s, list); // lists the wallets another device imported
      const n = (k) => `${k} wallet${k === 1 ? '' : 's'}`;
      if (added) toast(`${n(added)} from your account`, 'ok');
      if (removed) {
        const still = finishing ? ` — ${finishing} had a sell in flight, which still settles on chain` : '';
        toast(`${n(removed)} removed on another device${still}`, 'info');
      }
      if (unreadable) toast(`${n(unreadable)} in your account could not be read and were skipped`, 'error');
    },
    [loadInto, syncOwnAddrs, toast]
  );

  // One sync per unlock key: started when a key appears, stopped when it goes.
  useEffect(() => {
    const k = account.keyFor();
    if (!k) {
      setSync(null);
      return undefined;
    }
    const s = createVaultSync({ api, owner: k.address, key: k.key, keyId: k.keyId, hub, onStatus: setSync, onApplied: onSyncApplied });
    syncRef.current = s;
    s.load();
    return () => {
      s.stop();
      if (syncRef.current === s) syncRef.current = null;
    };
  }, [account, acct.keyEpoch, syncGen, hub, onSyncApplied]);

  const connectFlow = useCallback(
    async (walletId) => {
      if ((await account.signIn(walletId)) && account.get().status === 'locked') await account.unlock(walletId);
    },
    [account]
  );

  /**
   * Lock or disconnect. The account's wallets leave the tab, after the last
   * changes are saved (or the visitor accepts that they are not). Wallets of a
   * tab that was never unlocked are the visitor's own import: they stay. The
   * sync's stop() tells the positions book to stop saving ('account:locked').
   */
  const leaveAccount = useCallback(
    async (how) => {
      const wasOpen = account.get().status === 'unlocked';
      const s = syncRef.current;
      if (s) {
        const r = await s.flush();
        if (!r.ok && !window.confirm(`Your latest changes are not saved to your account (${r.error || 'not saved'}). Continue? The wallets leave this tab.`)) {
          return false;
        }
        s.stop();
        syncRef.current = null;
      }
      if (how === 'disconnect') await account.disconnect();
      else await account.lock();
      if (wasOpen) {
        clearWallets();
        // The %-left bars' starting sizes (ui/positions.js, Task 34; absent before it)
        // name these wallets too: they go with them. The account copy keeps its own.
        if (realDeps.positions) realDeps.positions.clear();
        syncOwnAddrs();
        // Every row goes — through removeRows, not the session's reset: a sell
        // still in flight keeps counting until it settles, so unlocking again at
        // once never offers those tokens a second time.
        const session = sessionRef.current;
        if (session) session.removeRows(session.view().rows.map((r) => r.address));
      }
      return true;
    },
    [account, syncOwnAddrs]
  );

  const onAccountAction = useCallback(
    async (id, walletId) => {
      if (id === 'connect') await connectFlow(walletId);
      else if (id === 'unlock') await account.unlock(walletId);
      else if (id === 'lock') await leaveAccount('lock');
      else if (id === 'disconnect') await leaveAccount('disconnect');
      else if (id === 'retry' && syncRef.current) await syncRef.current.retry();
      else if (id === 'signin-again') {
        if ((await account.signIn(walletId, { expect: account.get().address })) && syncRef.current) await syncRef.current.retry();
      } else if (id === 'switch') {
        const wid = account.get().walletId;
        if (await leaveAccount('lock')) await connectFlow(wid);
      } else if (id === 'delete') {
        const typed = window.prompt('This deletes the encrypted copy of your wallets from your account and signs it out here and on every other device. The server keeps the deleted copy, still encrypted, for 30 days in case you ask for it back. The wallets stay in this tab until you close it. Type DELETE to confirm.');
        if (typed !== 'DELETE') return;
        const s = syncRef.current;
        if (s) {
          s.stop();
          syncRef.current = null;
        }
        // Deleted = signed out (the server revoked every session of the account):
        // the key is gone, so the sync stays stopped; the wallets stay in this tab.
        if (await account.deleteSaved()) toast('Saved copy deleted and signed out. The wallets stay in this tab until you close it.', 'ok');
        else setSyncGen((g) => g + 1); // not deleted: still signed in, and an unlocked account keeps saving
      }
    },
    [account, connectFlow, leaveAccount, toast]
  );

  // A passphrase vault on this device -> the account. The device copy is deleted
  // only after the account has saved the wallets (a revision came back).
  const onMigrate = useCallback(
    async (pass) => {
      const s = syncRef.current;
      if (!s) return 'Unlock your account first.';
      let n = walletCount;
      if (vault === 'locked') {
        try {
          n = await unlockVault(pass);
        } catch {
          return 'Wrong passphrase, or the saved data is damaged.';
        }
        loadInto(sessionRef.current, syncOwnAddrs());
      }
      const r = await s.flush();
      if (!r.ok || r.rev < 1) return `Not moved: ${r.error || 'the account did not save'}. The copy on this device was kept.`;
      wipeVault();
      setVault('none');
      toast(`${n} wallet${n === 1 ? '' : 's'} moved into your account; the copy on this device was deleted`, 'ok');
      return '';
    },
    [loadInto, syncOwnAddrs, toast, vault, walletCount]
  );

  const openImport = useCallback(() => setImportOpen(true), []);
  const closeImport = useCallback(() => setImportOpen(false), []);

  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">
        <div className={`dapp stage-${stage}`}>
          <p className="notice" role="note">
            <LuShieldAlert aria-hidden="true" /> Keys stay in this browser tab. Use trading wallets. A browser extension can read this page.
          </p>
          <AccountBar acct={acct} sync={sync} wallets={discovered} legacy={vault} onAction={onAccountAction} onMigrate={onMigrate} />
          {vault === 'locked' && acct.status !== 'unlocked' && <VaultBar onUnlocked={onUnlocked} onForget={onForget} />}
          {vault === 'unlocked' && acct.status !== 'unlocked' && (
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
          {importOpen && (
            <ImportDialog vault={vault} walletCount={walletCount} accountSaves={acct.status === 'unlocked' && !!sync && sync.state !== 'blocked'} onClose={closeImport} onImported={onImported} />
          )}
          <Toasts hub={hub} />
        </div>
      </MotionConfig>
    </LazyMotion>
  );
}
