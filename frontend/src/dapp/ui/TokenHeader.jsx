import { memo, useEffect, useMemo, useState } from 'react';
import { LuCheck, LuCopy, LuGlobe, LuX } from 'react-icons/lu';
import { FaDiscord, FaTelegram, FaXTwitter } from 'react-icons/fa6';
import { SiFarcaster } from 'react-icons/si';
import * as api from '../api.js';
import { useLiveMark, useLiveStats } from './useLiveMark.js';
import { addressUrl, errText, fmtAge, fmtPct, fmtPrice, fmtUnits, fmtUsd, quoteDecimals, quoteSymbol, shortAddr, toNumber, venueLabel } from './format.js';
import { changeDir, curveProgress, fmtChange, identicon, normalizeFigures, normalizeInfo, normalizeStats, poolQuoteReserve } from './tokenFacts.js';
import { ethPerQuoteOf } from './positions.js';

/**
 * The token header (spec addendum D): logo, name, symbol, CA with copy, venue,
 * price (ETH and USD), market cap, 5 m / 1 h / 24 h change, 24 h volume, curve
 * progress or pool liquidity, age, creator, description and socials.
 *
 * DATA (Part 02): `info` and `figures` come with GET /token/:ca (App keeps them
 * as tokenFacts); `info` null means the server could not read it, and ONE
 * re-read follows INFO_RETRY_MS later. The stream's `stats` bring the changes,
 * the volume and fresh figures. Curve progress and a graduated pool's liquidity
 * are computed from the live mark first (the freshest); the server's figures
 * fill in the rest (v1 liquidity).
 *
 * ATTACKER-CONTROLLED: name, symbol, description and socials were typed by
 * whoever launched the token. React text only, never HTML; links are the https
 * URLs tokenFacts.safeSocial let through, opened with rel="noopener
 * noreferrer"; the logo comes from this origin's /api/tp/logo/:ca only (CSP
 * img-src 'self' data:), and a generated grey identicon stands in when there is
 * none or it will not load.
 *
 * THE MONEY LAW: nothing here spends. Copy and close are quiet icons; the
 * links are indigo text (forward, no money); the changes use the chart's own
 * up / down hues, never vermilion or jade. Re-renders at most once a second
 * (useLiveMark, useLiveStats) — this header only, never App.
 */
const LF = String.fromCharCode(10);
const INFO_RETRY_MS = 5_000;
const AGE_EVERY_MS = 30_000;
const LONG_DESCRIPTION = 140;

const SOCIAL = Object.freeze({
  x: { Icon: FaXTwitter, label: 'X' },
  telegram: { Icon: FaTelegram, label: 'Telegram' },
  discord: { Icon: FaDiscord, label: 'Discord' },
  website: { Icon: LuGlobe, label: 'Website' },
  farcaster: { Icon: SiFarcaster, label: 'Farcaster' },
});

/**
 * The token's info, normalised: the one GET /token/:ca brought (App's
 * tokenFacts.info), or — when that was null — a re-read, backing off, until it
 * lands or INFO_TRIES is out.
 *
 * More than one try matters since the server stopped awaiting readTokenInfo: info
 * null is now the NORMAL answer on a token's first load (the multicall is still in
 * flight behind the 12-slot read lane, up to a 20 s RPC timeout), not a failure. One
 * try that also came back null used to leave `known` false with the dep array
 * unchanged, so React never ran the effect again: no logo, no description and an
 * em dash for the bonding curve for the rest of the session on that token, even
 * though the server had the answer a second later.
 */
const INFO_TRIES = 5;

function useTokenInfo(token, initial) {
  const [state, setState] = useState(() => ({ info: initial ? normalizeInfo(initial) : null, error: '' }));
  const [attempt, setAttempt] = useState(0);
  const known = state.info !== null;
  useEffect(() => {
    setAttempt(0);
  }, [token]);
  useEffect(() => {
    if (known || attempt >= INFO_TRIES) return undefined;
    let dead = false;
    const last = attempt + 1 >= INFO_TRIES;
    const timer = setTimeout(() => {
      api.getToken(token).then(
        (res) => {
          if (dead) return;
          if (res && res.info) setState({ info: normalizeInfo(res.info), error: '' });
          else {
            // Only the last try is a failure the header says out loud; before that the
            // read is simply not back yet.
            setState({ info: null, error: last ? 'the server could not read it' : '' });
            setAttempt((n) => n + 1);
          }
        },
        (e) => {
          if (dead) return;
          setState({ info: null, error: last ? errText(e) : '' });
          setAttempt((n) => n + 1);
        }
      );
      // The delay grows with the attempt, so a busy read lane is not asked five times
      // in as many seconds: 5 s, 10 s, 20 s, 40 s.
    }, INFO_RETRY_MS * 2 ** attempt);
    return () => {
      dead = true;
      clearTimeout(timer);
    };
  }, [token, known, attempt]);
  return state;
}

/** Re-render every `everyMs` (the age line), whatever the stream does. */
function useTicker(everyMs) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
}

function Identicon({ address }) {
  const cells = useMemo(() => identicon(address), [address]);
  return (
    <svg className="th-logo th-ident" viewBox="0 0 5 5" shapeRendering="crispEdges" role="img" aria-label="No logo">
      {cells.map((on, i) => (on ? <rect key={i} x={i % 5} y={Math.floor(i / 5)} width="1" height="1" /> : null))}
    </svg>
  );
}

function Logo({ token, hasLogo }) {
  const [failed, setFailed] = useState(false);
  const src = api.logoPath(token);
  if (!hasLogo || failed || !src) return <Identicon address={token} />;
  return <img className="th-logo" src={src} alt="" width="48" height="48" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

function CopyCa({ ca }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return undefined;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  const copy = () => {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (!clip) return; // no clipboard (an insecure context): the address is in the link's title
    clip.writeText(ca).then(
      () => setDone(true),
      () => {}
    );
  };
  return (
    <button type="button" className="icon quiet th-copy" onClick={copy} aria-label="Copy the contract address" title={done ? 'Copied' : 'Copy the contract address'} data-testid="copy-ca">
      {done ? <LuCheck aria-hidden="true" /> : <LuCopy aria-hidden="true" />}
    </button>
  );
}

function Description({ text }) {
  const [open, setOpen] = useState(false);
  const long = text.length > LONG_DESCRIPTION || text.includes(LF);
  return (
    <div className="th-desc-wrap">
      <p className={`th-desc${open || !long ? ' is-open' : ''}`}>{text}</p>
      {long && (
        <button type="button" className="quiet th-more" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'less' : 'more'}
        </button>
      )}
    </div>
  );
}

function Fig({ label, title, className = '', children }) {
  return (
    <div className={`th-fig${className ? ` ${className}` : ''}`} title={title || undefined}>
      <dt>{label}</dt>
      <dd className="num">{children}</dd>
    </div>
  );
}

function Change({ label, value, partial, waiting }) {
  const title = value === null ? waiting : partial ? `${partial} — the history is still filling` : '';
  return (
    <Fig label={label} className={`chg-${changeDir(value)}${partial && value !== null ? ' th-partial' : ''}`} title={title}>
      {fmtChange(value)}
    </Fig>
  );
}

/** "since 14:05" for a window the indexed history does not cover yet, else null. */
function sinceText(stats, k) {
  if (!stats || stats.complete[k] || !stats.since) return null;
  return `since ${new Date(stats.since * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function TokenHeader({ venue, info: info0, figures: figures0, hub, getMark, quoteUsd, ethUsd, onClose }) {
  const mark = useLiveMark(hub, getMark);
  const rawStats = useLiveStats(hub);
  const stats = useMemo(() => normalizeStats(rawStats), [rawStats]);
  const { info, error } = useTokenInfo(venue.token, info0);
  const figures = (stats && stats.figures) || normalizeFigures(figures0);
  useTicker(AGE_EVERY_MS);
  const nowSec = Math.floor(Date.now() / 1000);

  const price = mark && Number.isFinite(mark.price) ? mark.price : null;
  const usdPerQuote = quoteUsd && Number.isFinite(quoteUsd.usd) ? quoteUsd.usd : null;
  const ethPerQuote = ethPerQuoteOf(venue, quoteUsd, ethUsd);
  const qSym = quoteSymbol(venue);
  const qDec = quoteDecimals(venue);
  const supply = toNumber(venue.totalSupply, venue.decimals);
  const noUsd = (quoteUsd && quoteUsd.reason) || 'no USD price';

  const priceEth = price !== null && ethPerQuote !== null ? price * ethPerQuote : null;
  const priceUsd = price !== null && usdPerQuote !== null ? price * usdPerQuote : null;
  const mcUsd = priceUsd !== null && Number.isFinite(supply) ? priceUsd * supply : null;
  const mcEth = priceEth !== null && Number.isFinite(supply) ? priceEth * supply : null;

  const isCurve = venue.kind === 'curve';
  const progress = isCurve ? curveProgress(mark, info) ?? (figures ? figures.progress : null) : null;
  const liq = isCurve ? null : poolQuoteReserve(venue, mark) ?? (figures ? figures.liquidityQuote : null);
  const liqUsd = liq !== null && usdPerQuote !== null ? toNumber(liq, qDec) * usdPerQuote : null;

  const waiting = 'waiting for the trade history';
  // Human quote units (Part 02): pair units for a token-quoted launch, converted with quoteUsd.
  const vol = stats ? stats.volume.h24 : null;
  const volUsd = vol !== null && usdPerQuote !== null ? vol * usdPerQuote : null;
  const since = sinceText(stats, 'h24');
  const launched = info && info.launchedAt ? info.launchedAt : null;
  const before = !launched && info && info.launchedBefore ? info.launchedBefore : null;

  let priceText = '—';
  if (priceEth !== null) priceText = `${fmtPrice(priceEth)} ETH`;
  else if (price !== null) priceText = `${fmtPrice(price)} ${qSym}`;

  let volText = '—';
  if (volUsd !== null) volText = fmtUsd(volUsd);
  else if (vol !== null) volText = `${fmtPrice(vol)} ${qSym}`;

  return (
    <div className="facts th" data-testid="token-header">
      <div className="th-id">
        {/* Asked for only once the info says there is one: a token without a logo costs no request. */}
        <Logo token={venue.token} hasLogo={info ? info.hasLogo : false} />
        <div className="th-names">
          <div className="th-line">
            <span className="tok-name">{venue.name}</span>
            <span className="tok-sym">{venue.symbol}</span>
            <span className="badge" data-testid="venue-badge">
              {venueLabel(venue)}
            </span>
            {!venue.nativeQuote && <span className="badge">{venue.pairSymbol}-paired</span>}
          </div>
          <div className="th-line th-sub">
            <a className="tok-ca" href={addressUrl(venue.token)} target="_blank" rel="noopener noreferrer" title={venue.token}>
              {shortAddr(venue.token)}
            </a>
            <CopyCa ca={venue.token} />
            {info && info.creator && (
              <span className="th-by">
                by{' '}
                <a href={addressUrl(info.creator)} target="_blank" rel="noopener noreferrer" title={info.creator}>
                  {shortAddr(info.creator, 6, 4)}
                </a>
              </span>
            )}
            {launched && (
              <span className="th-age" title={new Date(launched * 1000).toLocaleString()}>
                {fmtAge(nowSec - launched)} old
              </span>
            )}
            {before && (
              <span className="th-age" title={`launched on or before ${new Date(before * 1000).toLocaleDateString()}`}>
                &gt; {fmtAge(nowSec - before)} old
              </span>
            )}
            {error && <span className="why">token info unavailable ({error})</span>}
          </div>
        </div>
        <button type="button" className="icon quiet th-close" onClick={onClose} aria-label="Close this token" title="Close this token">
          <LuX aria-hidden="true" />
        </button>
      </div>
      <dl className="th-figs">
        <Fig label="Price" title={priceUsd === null ? noUsd : ''}>
          {priceText}
          {priceUsd !== null && <small className="th-usd">${fmtPrice(priceUsd)}</small>}
        </Fig>
        <Fig label="Market cap" title={mcUsd === null ? noUsd : ''}>
          {mcUsd !== null ? fmtUsd(mcUsd) : mcEth !== null ? `${fmtPrice(mcEth)} ETH` : '—'}
        </Fig>
        <Change label="5m" value={stats ? stats.change.m5 : null} partial={sinceText(stats, 'm5')} waiting={waiting} />
        <Change label="1h" value={stats ? stats.change.h1 : null} partial={sinceText(stats, 'h1')} waiting={waiting} />
        <Change label="24h" value={stats ? stats.change.h24 : null} partial={since} waiting={waiting} />
        <Fig label="Vol 24h" title={vol === null ? waiting : since ? 'the history is still filling' : ''}>
          {volText}
          {since && <small className="why"> {since}</small>}
        </Fig>
        {isCurve ? (
          <Fig label="Bonding curve" title={progress === null ? 'waiting for the token info' : 'real quote reserve / graduation threshold'}>
            {progress === null ? (
              '—'
            ) : (
              <span className="th-prog">
                <span className="th-prog-track" aria-hidden="true">
                  <span className="th-prog-fill" style={{ width: `${progress * 100}%` }} />
                </span>
                {progress >= 1 ? '100% · graduating' : fmtPct(progress * 100, 1)}
              </span>
            )}
          </Fig>
        ) : (
          <Fig label="Liquidity" title={liq === null ? 'the pool reserve is not reported yet' : `${qSym} held by the pool (its token side not counted)`}>
            {liq === null ? '—' : `${fmtUnits(liq, qDec, 2)} ${qSym}`}
            {liqUsd !== null && <small className="th-usd">{fmtUsd(liqUsd)}</small>}
          </Fig>
        )}
      </dl>
      {info && info.description && <Description text={info.description} />}
      {info && info.socials.length > 0 && (
        <ul className="th-socials" aria-label="Links the token's creator gave">
          {info.socials.map(({ kind, url }) => {
            const entry = SOCIAL[kind];
            if (!entry) return null; // a kind this header has no icon for is not drawn
            const { Icon, label } = entry;
            return (
              <li key={kind}>
                <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" title={url} aria-label={`${label}: ${url}`}>
                  <Icon aria-hidden="true" />
                  <span className="th-social-name">{label}</span>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default memo(TokenHeader);
