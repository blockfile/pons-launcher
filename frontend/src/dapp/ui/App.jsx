import { useState } from 'react';

// A contract address: 0x and 40 hex digits. Validated here only to enable the
// button; the backend's resolveVenue is the authority on what the CA is.
const CA_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * The dApp shell — PLACEHOLDER. It renders the empty "paste a CA" state only.
 * The later UI task replaces this file with the real state machine
 * (empty -> token -> wallets -> armed). Nothing here touches a key, the network
 * or storage.
 */
export default function App() {
  const [ca, setCa] = useState('');
  const [note, setNote] = useState('');
  const value = ca.trim();
  const valid = CA_RE.test(value);

  function onSubmit(event) {
    event.preventDefault();
    if (!valid) return;
    setNote(`Token loading is not wired yet (${value.slice(0, 6)}...${value.slice(-4)}).`);
  }

  return (
    <div className="tp-app">
      <header className="tp-top">
        <span className="tp-brand">
          rhbond <b>take-profit</b>
        </span>
        <span className="tp-chain">Robinhood Chain 4663</span>
      </header>
      <main className="tp-empty">
        <h1 className="tp-empty-title">Sell a pons token from all your wallets at once</h1>
        <form className="tp-ca" onSubmit={onSubmit}>
          <label className="tp-ca-label" htmlFor="tp-ca">
            Token contract address
          </label>
          <div className="tp-ca-row">
            <input
              id="tp-ca"
              value={ca}
              onChange={(e) => {
                setCa(e.target.value);
                setNote('');
              }}
              placeholder="0x..."
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              inputMode="text"
            />
            <button type="submit" className="go" disabled={!valid}>
              Open
            </button>
          </div>
          <div className="tp-ca-hint" role="status">
            {note || (value && !valid ? 'A contract address is 0x followed by 40 hex characters.' : '')}
          </div>
        </form>
        <p className="tp-warning">
          <b>This page signs with your private keys, inside this browser tab.</b> Keys are never sent to
          the server. Any browser extension can read this page: use trading wallets only, in a clean
          browser profile.
        </p>
      </main>
    </div>
  );
}
