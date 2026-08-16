import { useEffect, useRef, useState } from 'react';
import { LuCircleCheck, LuClock, LuTriangleAlert } from 'react-icons/lu';
import { notify } from '../api.js';
import Section from './Section.jsx';
import Address, { copyToClipboard } from './Address.jsx';
import { rolesFor } from '../variant.js';

const eth = (v) => Number(v || 0).toFixed(6);

/**
 * V2 — funding that arrives from somewhere this console cannot see.
 *
 * Step 4 sends ETH out of the dev wallet and gets a receipt back for every
 * transfer it signed. Nothing here signs anything. The ETH comes from an
 * exchange withdrawal, a bridge, another operator's wallet — somewhere with no
 * transaction this console can watch and no confirmation it will ever receive.
 * So the only truth available is the BALANCE, and this panel is built around
 * that one fact: it polls, it compares against what each wallet is owed, and it
 * says which wallets are still short.
 *
 * Being short is the failure worth building a screen for. Preflight skips an
 * underfunded wallet rather than failing the run, so a funding shortfall does
 * not announce itself — the launch simply comes out smaller than it was sized
 * for, and the reason is only visible afterwards in a receipt nobody reads
 * until the money is gone. That is the shape of the bug this panel exists to
 * make impossible to miss.
 *
 * It moves NOTHING. There is no send, no sweep, no signer and no POST in this
 * file. The only network call is the same wallet refresh the console already
 * makes on a timer, so the worst this panel can do is be out of date by five
 * seconds.
 */
export default function ExternalFundPanel({ wallets, rows, reload, variant = 'v1' }) {
  const roles = rolesFor(variant);
  const [watching, setWatching] = useState(false);
  const [lastCheck, setLastCheck] = useState('');

  // What each bundle wallet is owed, and what has actually landed. The target
  // is the same Fund column typed in step 3 — deliberately not a second set of
  // amounts, because two places to type the same number is how they diverge.
  const owed = wallets
    .filter((w) => w.role === roles.bundle)
    .map((w) => {
      const need = Number(rows[w.id]?.fund) || 0;
      const have = Number(w.balanceEth) || 0;
      return { w, need, have, short: need > 0 ? Math.max(0, need - have) : 0 };
    })
    .filter((r) => r.need > 0);

  const arrived = owed.filter((r) => r.short === 0).length;
  const stillNeeded = owed.reduce((s, r) => s + r.short, 0);
  const totalNeed = owed.reduce((s, r) => s + r.need, 0);
  const totalHave = owed.reduce((s, r) => s + r.have, 0);
  const allIn = owed.length > 0 && arrived === owed.length;

  // Poll while watching. reload() is the wallet GET the console already makes;
  // a failed tick is not an error worth interrupting a watch for, because the
  // next one is five seconds away.
  useEffect(() => {
    if (!watching) return undefined;
    let alive = true;
    const tick = async () => {
      try {
        await reload();
      } catch {
        /* transient — the next tick re-reads anyway */
      }
      if (alive) setLastCheck(new Date().toLocaleTimeString());
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [watching, reload]);

  // Stop on completion and say so once. An operator waiting on an exchange
  // withdrawal is not watching the screen, which is the whole reason this
  // panel polls instead of offering a Refresh button.
  const announced = useRef(false);
  useEffect(() => {
    if (!watching) {
      announced.current = false;
      return;
    }
    if (allIn && !announced.current) {
      announced.current = true;
      setWatching(false);
      notify(`All ${owed.length} wallets funded — nothing is short.`, 'ok');
    }
  }, [allIn, watching, owed.length]);

  // The addresses to pay, in a form that pastes into whatever is doing the
  // sending. CSV carries the amount as well, because "which wallet needed how
  // much" is precisely what gets mistyped when it is copied by hand.
  async function copyList(withAmounts) {
    if (!owed.length) {
      return notify('No wallet has a Fund amount yet — set them in step 3 first.', 'error');
    }
    const text = owed.map((r) => (withAmounts ? `${r.w.address},${r.need}` : r.w.address)).join('\n');
    const ok = await copyToClipboard(text);
    return notify(
      ok
        ? `Copied ${owed.length} ${withAmounts ? 'rows — address,amount' : 'addresses'}.`
        : 'Could not copy — select the list and press Ctrl+C.',
      ok ? 'ok' : 'error'
    );
  }

  return (
    <Section title="Funding from outside">
      <p className="lede">
        For ETH that arrives from somewhere this console did not send it — an exchange withdrawal, a
        bridge, another wallet. There is no transaction here to watch and no receipt to read, so this
        watches the <b>balances</b> instead and tells you which wallets are still short of what step 3
        says they need. It sends nothing.
      </p>

      <div className="stats">
        <div className="stat">
          <span>Wallets funded</span>
          <b>
            {arrived} <span className="stat-of">of {owed.length}</span>
          </b>
        </div>
        <div className="stat">
          <span>Target total</span>
          <b>{totalNeed > 0 ? `${totalNeed.toFixed(4)} ETH` : '—'}</b>
        </div>
        <div className={`stat ${totalHave > 0 ? 'ok' : ''}`}>
          <span>Landed</span>
          <b>{totalHave > 0 ? `${totalHave.toFixed(4)} ETH` : '—'}</b>
        </div>
        <div className={`stat ${stillNeeded > 0 ? 'bad' : ''}`}>
          <span>Still needed</span>
          <b>{stillNeeded > 0 ? `${stillNeeded.toFixed(4)} ETH` : '0'}</b>
        </div>
      </div>

      <div className="row">
        <button
          className={watching ? 'spend' : ''}
          disabled={!owed.length}
          title={owed.length ? '' : 'set Fund amounts in step 3 first'}
          onClick={() => setWatching((v) => !v)}
        >
          {watching ? 'Stop watching' : 'Watch for arrivals'}
        </button>
        <button className="quiet" disabled={!owed.length} onClick={() => copyList(false)}>
          Copy addresses
        </button>
        <button className="quiet" disabled={!owed.length} onClick={() => copyList(true)}>
          Copy address,amount
        </button>
        <span className="hint">
          {watching
            ? `checking every 5s${lastCheck ? ` · last ${lastCheck}` : ''}`
            : lastCheck
              ? `stopped · last checked ${lastCheck}`
              : 'balances refresh only while watching'}
        </span>
      </div>

      {/* The shortfall warning is the point of the panel, so it is stated
          before the table rather than left to be totalled by eye. Vermilion:
          an underfunded wallet is not a delay, it is a wallet that will be
          dropped from the run without stopping it. */}
      {owed.length > 0 && stillNeeded > 0 && (
        <div className="notice danger">
          <h3>
            <LuTriangleAlert aria-hidden="true" />
            <span>
              {owed.length - arrived} of {owed.length} wallets still short —{' '}
              <b className="crux">{stillNeeded.toFixed(6)} ETH</b> outstanding
            </span>
          </h3>
          <ul>
            <li>
              An underfunded wallet does not fail the launch. Preflight{' '}
              <b className="crux">skips it</b> and the run goes ahead smaller than it was sized for,
              so this shortfall is only visible here and in the receipt afterwards.
            </li>
            <li>
              Each wallet also pays its own gas, so the Fund column is a floor and not a target —
              landing exactly the amount owed leaves nothing for the buy&apos;s gas.
            </li>
          </ul>
        </div>
      )}

      {owed.length === 0 && (
        <div className="notice warn">
          <h3>Nothing to watch yet</h3>
          <ul>
            <li>
              Generate bundle wallets in step 3 and enter a <b>Fund</b> amount for each one. This
              panel reads those amounts as the target and has nothing to compare against until they
              exist.
            </li>
          </ul>
        </div>
      )}

      {owed.length > 0 && (
        <div className="table-scroll">
          <table className="wallet-list">
            <thead>
              <tr>
                <th>Address</th>
                <th>Needs</th>
                <th>Has</th>
                <th>Short by</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {owed.map(({ w, need, have, short }) => (
                <tr key={w.id}>
                  <td className="addr">
                    <Address value={w.address} />
                  </td>
                  <td className="bal">{eth(need)}</td>
                  <td className={`bal ${have === 0 ? 'zero' : ''}`}>{eth(have)}</td>
                  <td className={`bal ${short > 0 ? 'short' : ''}`}>{short > 0 ? eth(short) : '—'}</td>
                  <td>
                    {short === 0 ? (
                      <span className="fund-state is-in">
                        <LuCircleCheck aria-hidden="true" />
                        funded
                      </span>
                    ) : have > 0 ? (
                      <span className="fund-state is-part">
                        <LuTriangleAlert aria-hidden="true" />
                        partial
                      </span>
                    ) : (
                      <span className="fund-state is-wait">
                        <LuClock aria-hidden="true" />
                        waiting
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
