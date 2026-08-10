import { useState } from 'react';

// What a first-time operator has to know before spending anything, and what a
// returning one keeps getting wrong. Collapsed once read — the state lives in
// localStorage because it is a preference, not data.
const KEY = 'pons-guide-open';

export default function Guide() {
  const [open, setOpen] = useState(() => localStorage.getItem(KEY) !== 'no');

  function toggle() {
    setOpen((v) => {
      localStorage.setItem(KEY, v ? 'no' : 'yes');
      return !v;
    });
  }

  return (
    <section className="guide">
      <h2>
        How this works
        <button className="link" onClick={toggle}>
          {open ? 'hide' : 'show'}
        </button>
      </h2>

      {open && (
        <dl>
          <div>
            <dt>What it does</dt>
            <dd>
              Launches a token on ponsfamily.com and buys it from several wallets in the same
              instant. The launch transaction creates the pool and makes your dev buy inside one
              call, then every bundle wallet's buy — signed in advance — is broadcast immediately
              behind it.
            </dd>
          </div>
          <div>
            <dt>The order of work</dt>
            <dd>
              Generate a dev wallet and bundle wallets, send ETH from the dev wallet to the bundle
              wallets, fill in the token details, then run <b>Preflight</b>. Preflight signs
              everything and sends nothing, so it is safe to run as often as you like.
            </dd>
          </div>
          <div>
            <dt>The dev buy is the only uncapped buy</dt>
            <dd>
              It happens inside the launch transaction, so nothing can get in front of it and no
              limit applies to it. This is where size comes from — put the amount you actually want
              to hold here.
            </dd>
          </div>
          <div>
            <dt>Bundle wallets are capped at 5%</dt>
            <dd>
              For roughly 32 seconds after launch, no address other than the dev wallet may take
              more than <code>max wallet</code> of supply. A buy over that does not get trimmed — it{' '}
              <b>reverts</b>, spending gas and buying nothing. The wallet table prices each amount
              as you type it — <code>supply share</code> — and preflight checks the same figure
              again before you commit. Keep them under 5% and use more wallets.
            </dd>
          </div>
          <div>
            <dt>Why 2 blocks is 32 seconds</dt>
            <dd>
              The chain makes a block every ~100ms, but the restriction is counted in the EVM's own
              block number, which advances about every 16 seconds. Your bundle lands inside that
              window no matter how fast it is — speed decides the price you pay, not whether the cap
              applies.
            </dd>
          </div>
          <div>
            <dt>Dry run</dt>
            <dd>
              While the strip at the top reads <code>DRY RUN</code>, nothing is ever broadcast:
              launches are simulated end to end and return a full plan. Set{' '}
              <code>DRY_RUN=false</code> on the server to go live. Rehearse a whole launch first.
            </dd>
          </div>
          <div>
            <dt>Back up your keys</dt>
            <dd>
              Wallets are generated on the server and encrypted at rest. Download a backup from the
              wallets panel and store it offline — if the server is lost, unbacked-up keys are gone
              and so are the funds in them.
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
