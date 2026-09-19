import { memo, useState } from 'react';
import { LuCircleX, LuKeyRound, LuLoaderCircle, LuSearch } from 'react-icons/lu';
import { looksLikeKey } from './keyGuard.js';
import TokenHeader from './TokenHeader.jsx';

const CA = /^0x[0-9a-fA-F]{40}$/;

/**
 * The CA form, the open token's header (TokenHeader: logo, figures, socials —
 * attacker-controlled text rendered as React text only; tokenFacts = GET
 * /token/:ca's {info, figures}) and the wallet count.
 */
function TokenBar({ venue, tokenFacts, opening, error, onOpen, onClose, hub, getMark, quoteUsd, ethUsd, walletCount, onImport }) {
  const [ca, setCa] = useState('');
  const [keyPasted, setKeyPasted] = useState(false);
  const trimmed = ca.trim();
  const valid = CA.test(trimmed);
  // A private key pasted here by mistake is never kept in state or shown.
  function onCa(e) {
    const value = e.target.value;
    if (looksLikeKey(value)) {
      e.target.value = '';
      setCa('');
      setKeyPasted(true);
      return;
    }
    setKeyPasted(false);
    setCa(value);
  }
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
            onChange={onCa}
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
        {keyPasted && (
          <p className="refusal" role="alert">
            That looked like a private key. It was cleared and never sent — keys go in Import wallets.
          </p>
        )}
      </form>
      {error && (
        <p className="refusal" role="alert" data-testid="ca-refusal">
          <LuCircleX aria-hidden="true" /> {error}
        </p>
      )}
      {venue && (
        <TokenHeader
          key={venue.token}
          venue={venue}
          info={tokenFacts ? tokenFacts.info : null}
          figures={tokenFacts ? tokenFacts.figures : null}
          hub={hub}
          getMark={getMark}
          quoteUsd={quoteUsd}
          ethUsd={ethUsd}
          onClose={onClose}
        />
      )}
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
