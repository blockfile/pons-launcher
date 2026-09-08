import { useState } from 'react';

// What a first-time operator has to know before spending anything, and what a
// returning one keeps getting wrong. The state lives in localStorage because it
// is a preference, not data.
//
// Closed by default. Open, it puts most of a screen of prose between the plan
// and step 1, so the first thing the console showed a first-timer was reading
// rather than the first thing to do — and the sequence above it already answers
// "what now". It stays open only for someone who has opened it and not closed
// it again, which is the one person the prose is for.
const KEY = 'pons-guide-open';

// `steps` is the live plan, not a copy of it. The order of work used to be a
// hardcoded list of six — which was wrong on v2 the moment it stopped having a
// disperser step, and wrong again the moment the quote asset became a station of
// its own. A guide that disagrees with the page it is explaining is worse than
// no guide, so it reads the same array the strip above it draws.
export default function Guide({ steps = [] }) {
  const [open, setOpen] = useState(() => localStorage.getItem(KEY) === 'yes');

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
              {steps.length} steps, in the order they are laid out down this page:{' '}
              {steps.map((s, i) => (
                <span key={s.key}>
                  {i > 0 ? (i === steps.length - 1 ? ' and ' : ', ') : ''}
                  <b>
                    {s.n}. {s.title.toLowerCase()}
                  </b>
                </span>
              ))}
              . The strip at the top says which one you are on, and each step states in one line
              what it is for and what has to be true before it can run. Before the launch, run{' '}
              <b>Preflight</b> — it signs everything and sends nothing, so it is safe to run as
              often as you like.
            </dd>
          </div>
          <div>
            <dt>What the launch is priced in</dt>
            <dd>
              A v2 launch can be priced in native <b>ETH</b> or in one of the factory's approved
              quote assets (NVDA, SPCX, AMD …). That is the <b>first</b> decision, and it is the
              first station on this page, because everything below it is denominated in it: the Buy
              column, the dev buy, the market cap and the graduation threshold. On a paired launch
              every bundle wallet has to be holding that asset before the launch is armed —
              <b> fund them with ETH</b>, then <b>buy the asset with it</b>, then launch. Changing
              it later is allowed and says what it costs first: whatever the wallets already bought
              stays with them, and the way back is <b>Recover ETH · sell it back</b> beside the
              wallet table.
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
              Wallets are generated on the server and encrypted at rest. Download a backup from step
              3 and store it offline — if the server is lost, unbacked-up keys are gone and so are
              the funds in them.
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
