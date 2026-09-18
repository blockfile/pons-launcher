import { memo, useState } from 'react';
import { LuCircleX, LuKeyRound, LuLoaderCircle, LuSearch, LuX } from 'react-icons/lu';
import { useLiveMark } from './useLiveMark.js';
import { addressUrl, fmtPrice, fmtUsd, quoteSymbol, shortAddr, toNumber, venueLabel } from './format.js';

const CA = /^0x[0-9a-fA-F]{40}$/;

/**
 * Name, symbol and figures of the open token. Name and symbol come from a CA
 * anyone can paste, so they are attacker-controlled: React text only, never
 * HTML, never a remote logo. Price and MC re-render here only (useLiveMark).
 */
function TokenFacts({ venue, hub, getMark, quoteUsd, onClose }) {
  const mark = useLiveMark(hub, getMark);
  const price = mark && Number.isFinite(mark.price) ? mark.price : null;
  const supply = toNumber(venue.totalSupply, venue.decimals);
  const mc = price !== null && quoteUsd.usd ? price * supply * quoteUsd.usd : null;
  return (
    <div className="facts">
      <div className="facts-name">
        <span className="tok-name">{venue.name}</span>
        <span className="tok-sym">{venue.symbol}</span>
        <a className="tok-ca" href={addressUrl(venue.token)} target="_blank" rel="noopener noreferrer" title={venue.token}>
          {shortAddr(venue.token)}
        </a>
      </div>
      <div className="badges">
        <span className="badge" data-testid="venue-badge">
          {venueLabel(venue)}
        </span>
        {!venue.nativeQuote && <span className="badge">{venue.pairSymbol}-paired</span>}
      </div>
      <dl className="facts-figs">
        <div>
          <dt>Price</dt>
          <dd className="num">
            {fmtPrice(price)} {quoteSymbol(venue)}
          </dd>
        </div>
        <div>
          <dt>Market cap</dt>
          <dd className="num">
            {mc === null ? (
              <>
                — <small className="why">{quoteUsd.reason || 'no USD price'}</small>
              </>
            ) : (
              fmtUsd(mc)
            )}
          </dd>
        </div>
      </dl>
      <button type="button" className="icon quiet" onClick={onClose} aria-label="Close this token" title="Close this token">
        <LuX aria-hidden="true" />
      </button>
    </div>
  );
}

function TokenBar({ venue, opening, error, onOpen, onClose, hub, getMark, quoteUsd, walletCount, onImport }) {
  const [ca, setCa] = useState('');
  const trimmed = ca.trim();
  const valid = CA.test(trimmed);
  function submit(e) {
    e.preventDefault();
    if (valid && !opening) onOpen(trimmed);
  }
  return (
    <header className="tokenbar pane">
      <form className="ca-form" onSubmit={submit}>
        <label htmlFor="tp-ca" className="eyebrow">
          Token contract address
        </label>
        <div className="ca-row">
          <input
            id="tp-ca"
            data-testid="ca-input"
            className="ca-input"
            value={ca}
            onChange={(e) => setCa(e.target.value)}
            placeholder="0x… paste a pons token CA"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
          />
          <button type="submit" className="go" disabled={!valid || opening} data-testid="ca-open">
            {opening ? <LuLoaderCircle className="spin" aria-hidden="true" /> : <LuSearch aria-hidden="true" />} Open
          </button>
        </div>
        {trimmed && !valid && <p className="hint">A contract address is 0x followed by 40 hex characters.</p>}
      </form>
      {error && (
        <p className="refusal" role="alert" data-testid="ca-refusal">
          <LuCircleX aria-hidden="true" /> {error}
        </p>
      )}
      {venue && <TokenFacts venue={venue} hub={hub} getMark={getMark} quoteUsd={quoteUsd} onClose={onClose} />}
      <div className="keys-count">
        <span>
          {walletCount} {walletCount === 1 ? 'wallet' : 'wallets'} in this tab
        </span>
        <button type="button" className="go" onClick={onImport} data-testid="import-open">
          <LuKeyRound aria-hidden="true" /> Import wallets
        </button>
      </div>
    </header>
  );
}

export default memo(TokenBar);
