import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import Sequence from './Sequence.jsx';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';

const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-4)}` : '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The v2 bundler — launch quiet, wait, then buy once through a contract.
 *
 * WHY IT IS A SEPARATE TAB AND NOT A TOGGLE ON THE V1 SEQUENCE. The two are
 * different strategies, not two settings of one. V1 arms a bundle before the
 * launch and fires it at the moment trading opens; this one launches with no
 * dev buy at all, waits for the snipers to take a position and give it back,
 * and then buys once. Their steps do not line up, their timings are opposite,
 * and the mistake that ruins each is different. A control that is right in one
 * mode and dangerous in the other is worse than two screens.
 *
 * IT HAS ITS OWN SEQUENCE FOR THE SAME REASON. The order of work here is the
 * thing an operator gets wrong — not the amounts — so the order is drawn, the
 * same way v1 draws its own. Two steps in the middle are WAITING, which no
 * button can do for you and which the sequence therefore has to say out loud.
 */
export default function BundlerV2Panel({ explorer, credential, report, wallets = [], history = [] }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [token, setToken] = useState('');
  const [amount, setAmount] = useState('1.0');
  const [quote, setQuote] = useState(null);
  const [triggered, setTriggered] = useState(null);

  async function load() {
    try {
      setState(await api('/distributor'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

  // Re-read when the credential arrives, not only on mount — the panel mounts
  // before a key is pasted, and one restored from sessionStorage is already
  // present on the first render.
  useEffect(() => {
    const t = setTimeout(load, credential ? 400 : 0);
    return () => clearTimeout(t);
  }, [credential]);

  async function act(name, fn) {
    setBusy(name);
    try {
      const out = await fn();
      report(out);
      await load();
      return out;
    } catch (err) {
      report(`ERROR: ${err.message}`);
      return null;
    } finally {
      setBusy('');
    }
  }

  const distributor = state?.distributor || null;
  const deployQuote = state?.quote || null;
  const dev = wallets.find((w) => w.role === 'dev');
  const bundle = wallets.filter((w) => w.role === 'bundle');

  // Same shape and same state rules as the v1 sequence, computed here because
  // the plan is different — see App.jsx for the original. `done` outranks
  // everything, exactly one unblocked step is `now`, the rest are `later`.
  const steps = useMemo(() => {
    const plan = [
      {
        n: 1,
        title: 'Create dev wallet',
        done: Boolean(dev),
        detail: dev
          ? `${short(dev.address)} · ${Number(dev.balanceEth).toFixed(4)} ETH`
          : 'it deploys the contract and pays for the buy',
      },
      {
        n: 2,
        title: 'Deploy the distributor',
        done: Boolean(distributor),
        detail: distributor
          ? short(distributor.address)
          : 'one contract, reused for every launch after this',
      },
      {
        n: 3,
        title: 'Generate bundle wallets',
        done: bundle.length > 0,
        detail: bundle.length
          ? `${plural(bundle.length, 'wallet')} · no funding needed`
          : 'they only receive — none of them needs ETH to buy',
      },
      {
        n: 4,
        title: 'Launch with NO dev buy',
        done: Boolean(token),
        detail: token
          ? short(token)
          : 'on the V1 tab, dev buy 0 — then paste the token here',
      },
      {
        n: 5,
        title: 'Wait ~90 seconds',
        done: Boolean(quote?.ok),
        detail: quote?.ok
          ? 'the pool answered — the window has lifted'
          : 'restrictions lift at ~30s; the snipers sell back by ~68s',
      },
      {
        n: 6,
        title: 'Trigger the buy',
        done: Boolean(triggered),
        detail: triggered
          ? `${(Number(triggered.amountOut) / 1e18).toLocaleString()} tokens split ${triggered.wallets.length} ways`
          : 'one transaction: buy, then split, or the whole thing reverts',
      },
    ];

    let previousRequired = null;
    let claimed = false;
    return plan.map((s) => {
      const waitsOn = previousRequired;
      const blocked = waitsOn != null && !plan[waitsOn - 1].done;
      if (!s.done) previousRequired = previousRequired ?? s.n;

      let st = 'later';
      if (s.done) st = 'done';
      else if (!blocked && !claimed) {
        st = 'now';
        claimed = true;
      }
      return {
        ...s,
        id: `v2-step-${s.n}`,
        state: st,
        chip: st === 'done' ? 'done' : st === 'now' ? 'now' : 'later',
        wait:
          st === 'later' && blocked
            ? `Waits on step ${waitsOn} — ${plan[waitsOn - 1].title.toLowerCase()} first.`
            : null,
      };
    });
  }, [dev, distributor, bundle.length, token, quote, triggered]);

  const step = (n) => steps[n - 1];

  if (error) return credential ? <p className="hint">v2 bundler unavailable — {error}</p> : null;
  if (!state) return null;

  return (
    <>
      <Sequence
        steps={steps}
        notice={
          !credential
            ? 'Paste the API key in the top bar — without it this tab can neither read nor spend.'
            : null
        }
      />

      <Step {...step(1)}>
        <p className="lede">
          The dev wallet is shared with the V1 tab — create or import it there. Here it only
          deploys the distributor and pays for the buy; it never holds the supply, because the
          tokens go straight to the bundle wallets inside the same transaction.
        </p>
      </Step>

      <Step {...step(2)}>
        <p className="lede">
          One contract, deployed once and reused. It exists because the token&apos;s transfer hook
          only checks transfers <em>from the pool</em> — so a single large buy landing here and
          fanning out from here is never cap-checked on the receiving side, while thirty wallets
          buying separately would each be capped and each be a separate race.
        </p>

        {distributor ? (
          <table className="disperser-list">
            <tbody>
              <tr>
                <td>
                  <a href={`${explorer}/address/${distributor.address}`} target="_blank" rel="noreferrer">
                    {distributor.address}
                  </a>
                </td>
                <td className="hint">
                  {distributor.deployedAt ? new Date(distributor.deployedAt).toLocaleDateString() : ''}
                </td>
                <td>
                  <Busy
                    busy={busy === 'forget'}
                    className="ghost"
                    title="stop using this contract — it stays on chain"
                    onClick={() => act('forget', () => api('/distributor', 'DELETE'))}
                  >
                    forget
                  </Busy>
                </td>
              </tr>
            </tbody>
          </table>
        ) : (
          <div className="row">
            <span className="hint">
              {deployQuote?.error
                ? `cannot price a deploy — ${deployQuote.error}`
                : `paid by the dev wallet, balance ${Number(deployQuote?.balanceEth || 0).toFixed(6)} ETH`}
            </span>
            <span className="spacer" />
            <Busy
              busy={busy === 'deploy'}
              className="ghost"
              onClick={() => act('deploy', () => api('/distributor/deploy', 'POST', { confirm: true }))}
            >
              {deployQuote?.costEth
                ? `Deploy for ~${Number(deployQuote.costEth).toFixed(6)} ETH`
                : 'Deploy the distributor'}
            </Busy>
          </div>
        )}
      </Step>

      <Step {...step(3)}>
        <p className="lede">
          Generate them on the V1 tab as usual — but <strong>do not fund them</strong>. On this
          path they never buy, they only receive, so none of them needs ETH before the launch.
          That also means no disperser run, which is what currently announces a launch eight to
          twenty-two minutes before it happens.
        </p>
        <p className="hint">
          {bundle.length
            ? `${plural(bundle.length, 'wallet')} will share the buy equally. They need gas only later, when you sell.`
            : 'no bundle wallets yet'}
        </p>
      </Step>

      <Step {...step(4)}>
        <div className="notice warn">
          <h3>the dev buy must be zero</h3>
          <ul>
            <li>
              Launch from the V1 tab with the dev buy set to <strong>0</strong> — the launch fee
              only, and no bundle armed.
            </li>
            <li>
              A dev buy here would defeat the whole strategy: it is the signal the size-bots read,
              and 3–6% of supply is the band they trade hardest.
            </li>
            <li>Then paste the token address below.</li>
          </ul>
        </div>
        <div className="row">
          <label className="hint">
            token
            <input
              value={token}
              onChange={(e) => {
                setToken(e.target.value.trim());
                setQuote(null);
                setTriggered(null);
              }}
              placeholder="0x… the token you just launched"
              style={{ width: 380, marginLeft: 6 }}
            />
          </label>
        </div>
      </Step>

      <Step {...step(5)}>
        <p className="lede">
          Two clocks have to run out, and no button can do it for you. The restriction window
          lifts about 30 seconds after launch — before that this buy is capped at roughly 5% of
          supply and reverts over it. The snipers then hold their position for up to 68 seconds
          before selling it back into the pool. Ninety seconds clears both.
        </p>
        <p className="hint">
          Quoting early is free and tells you which clock you are still waiting on.
        </p>
      </Step>

      <Step {...step(6)} last>
        <div className="row">
          <label className="hint">
            spend
            <input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                setQuote(null);
              }}
              style={{ width: 90, marginLeft: 6 }}
            />
            {' ETH'}
          </label>
          <span className="spacer" />
          {/* The quote is not a convenience. It is a real eth_call against the
              live pool, and it is what catches a trigger sent inside the
              restriction window — where the pool answers "TF" and explains
              nothing. The trigger stays disabled until it comes back clean. */}
          <Busy
            busy={busy === 'quote'}
            className="ghost"
            disabled={!token || !(Number(amount) > 0)}
            onClick={() =>
              act('quote', async () => {
                const q = await api('/distributor/quote', 'POST', {
                  token,
                  amountEth: Number(amount),
                });
                setQuote(q);
                return q.ok
                  ? `quote: ${(Number(q.amountOut) / 1e18).toLocaleString()} tokens across ${q.wallets.length} wallets`
                  : `NOT READY — ${q.reason}`;
              })
            }
          >
            Quote it
          </Busy>
        </div>

        {quote && (
          <div className={`notice ${quote.ok ? '' : 'warn'}`}>
            {quote.ok ? (
              <>
                <h3>
                  {(Number(quote.amountOut) / 1e18).toLocaleString()} tokens across{' '}
                  {quote.wallets.length} wallets
                </h3>
                <ul>
                  <li>
                    about {((Number(quote.amountOut) / 1e18 / 1e9) * 100).toFixed(2)}% of a 1e9
                    supply, roughly{' '}
                    {(((Number(quote.amountOut) / 1e18 / 1e9) * 100) / quote.wallets.length).toFixed(2)}%
                    each
                  </li>
                  <li>
                    the floor sent with the buy is 15% under this — it reverts rather than fill
                    worse
                  </li>
                </ul>
              </>
            ) : (
              <>
                <h3>not ready</h3>
                <ul>
                  <li>{quote.reason}</li>
                </ul>
              </>
            )}
          </div>
        )}

        <div className="row">
          <span className="hint">
            {quote?.ok
              ? 'one transaction: buy, then split, or the whole thing reverts'
              : 'quote first — the trigger will not send without one'}
          </span>
          <span className="spacer" />
          <Busy
            busy={busy === 'trigger'}
            disabled={!quote?.ok}
            onClick={() =>
              act('trigger', async () => {
                const out = await api('/distributor/trigger', 'POST', {
                  token,
                  amountEth: Number(amount),
                  confirm: true,
                });
                setTriggered(out.status === 1 ? out : null);
                setQuote(null);
                return out.status === 1
                  ? `FILLED ${(Number(out.amountOut) / 1e18).toLocaleString()} tokens in block ${out.blockNumber} — ${out.hash}`
                  : `reverted — ${out.hash}`;
              })
            }
          >
            Trigger the buy
          </Busy>
        </div>
      </Step>
    </>
  );
}
