import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import bundleShareModule from '../../../shared/bundleShare.js';
import Sequence from './Sequence.jsx';
import Step from './Step.jsx';
import LogoField from './LogoField.jsx';
import { Busy } from './Section.jsx';

const { openingPool, constantProductBuy, parseEthToWei } = bundleShareModule;

const short = (a) => (a ? `${a.slice(0, 8)}…${a.slice(-4)}` : '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The v2 bundler — take the supply in the launch transaction itself.
 *
 * WHY THIS AND NOT V1'S BUNDLE. The factory's initial buy is the only trade
 * that executes in the launch block, where every other pool buy reverts, and
 * it is exempt from the wallet cap. Nothing can precede it: the token does not
 * exist until the call runs. Measured across 242,815 launches, taking 60-90%
 * of supply that way loses 0.08% of float to snipers; taking the same share
 * through a bundle afterwards loses 3.06%.
 *
 * WHY IT IS NOT SIMPLY "USE A BIGGER DEV BUY". A 3.5 ETH buy takes ~72% of
 * supply, and in one wallet that is a position no operator wants to show. The
 * distributor fans it out inside the same transaction, so the launch block
 * ends with the supply already across every bundle wallet and nothing
 * concentrated anywhere. That is the whole reason for the contract.
 *
 * THE SEQUENCE IS THE POINT, as in v1 — but it is a different sequence, which
 * is why it lives here rather than sharing App's. Two of v1's steps invert:
 * the bundle wallets must NOT be funded, because they never buy, and there is
 * no waiting at all, because there is no race to be late for.
 */
export default function BundlerV2Panel({
  explorer,
  credential,
  report,
  wallets = [],
  configs = null,
}) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [launched, setLaunched] = useState(null);
  const [triggered, setTriggered] = useState(null);
  const [topUp, setTopUp] = useState('0.5');
  const [quote, setQuote] = useState(null);

  const [form, setForm] = useState({
    name: '',
    symbol: '',
    logo: '',
    description: '',
    twitter: '',
    telegram: '',
    website: '',
  });
  const [devBuy, setDevBuy] = useState('3.5');
  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: typeof e === 'string' ? e : e.target.value }));

  async function load() {
    try {
      setState(await api('/distributor'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }

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
  const staged = state?.stagedEth || '0';
  const dev = wallets.find((w) => w.role === 'dev');
  const bundle = wallets.filter((w) => w.role === 'bundle');

  // What the dev buy actually takes, on the pool the config opens. Same
  // arithmetic the backend preflight runs — see shared/bundleShare.js for why
  // it lives outside both.
  const projection = useMemo(() => {
    const cfg = configs?.launchConfigs?.find((c) => c.enabled) || configs?.launchConfigs?.[0];
    const spend = Number(staged) + Number(devBuy || 0);
    if (!cfg || !(spend > 0)) return null;
    const pool = openingPool(cfg);
    if (!pool.quoteReserve) return null;
    const r = constantProductBuy({
      quoteInWei: parseEthToWei(String(spend)),
      ...pool,
      feeBps: 100,
    });
    const share = (Number(r.tokensOut) / Number(BigInt(cfg.supply))) * 100;
    return { share, each: bundle.length ? share / bundle.length : 0 };
  }, [configs, devBuy, staged, bundle.length]);

  const ready = form.name && form.symbol && bundle.length > 0 && distributor;

  const steps = useMemo(() => {
    const plan = [
      {
        n: 1,
        title: 'Create dev wallet',
        done: Boolean(dev),
        detail: dev
          ? `${short(dev.address)} · ${Number(dev.balanceEth).toFixed(4)} ETH`
          : 'it deploys the contract and signs the launch — it never carries the buy',
      },
      {
        n: 2,
        title: 'Deploy the distributor',
        done: Boolean(distributor),
        detail: distributor ? short(distributor.address) : 'one contract, reused for every launch after',
      },
      {
        n: 3,
        title: 'Generate bundle wallets',
        done: bundle.length > 0,
        detail: bundle.length
          ? `${plural(bundle.length, 'wallet')} · no funding needed`
          : 'they receive the supply — none of them ever buys',
      },
      {
        n: 4,
        title: 'Stage the buy',
        done: Number(staged) > 0,
        detail:
          Number(staged) > 0
            ? `${Number(staged).toFixed(4)} ETH held by the contract`
            : 'send ETH to the contract from your funding wallet',
      },
      {
        n: 5,
        title: 'Launch and distribute',
        done: Boolean(launched),
        detail: launched
          ? `${form.symbol || short(launched.token)} · split ${launched.wallets.length} ways`
          : projection
            ? `${devBuy} ETH takes about ${projection.share.toFixed(1)}% of supply`
            : 'one transaction: launch, buy, split',
      },
      {
        n: 6,
        title: 'Buy more, on your timing',
        optional: true,
        done: Boolean(triggered),
        detail: triggered
          ? `${(Number(triggered.amountOut) / 1e18).toLocaleString()} tokens added`
          : 'a second buy through the contract, whenever you choose',
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
  }, [dev, distributor, bundle.length, staged, launched, triggered, projection, devBuy, form.symbol]);

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
          Shared with the V1 tab — create or import it there. On this path its whole job is to
          deploy the distributor and sign the launch. It never holds the buy and never holds the
          supply: the ETH is staged in the contract by a separate funding wallet, and the tokens go
          straight to the bundle wallets inside the same transaction.
        </p>
      </Step>

      <Step {...step(2)}>
        <p className="lede">
          One contract, deployed once and reused. It exists because the factory&apos;s initial buy
          is the only trade that runs in the launch block — nothing can precede it, since the token
          does not exist until the call does — and because a 72% position left in one wallet is not
          something you want on a chart. The contract takes the buy and hands it out before the
          transaction ends.
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
          Generate them on the V1 tab as usual — but <strong>do not fund them</strong>. On this path
          they never buy, so none of them needs ETH. That also means no disperser run, which is what
          currently announces a launch eight to twenty-two minutes before it happens.
        </p>
        <p className="hint">
          {bundle.length
            ? `${plural(bundle.length, 'wallet')} will share the supply equally. They need gas only later, when you sell.`
            : 'no bundle wallets yet'}
        </p>
      </Step>


      <Step {...step(4)}>
        <p className="lede">
          The contract spends its <strong>whole balance</strong> when it launches, so the buy is
          staged here beforehand — from your funding wallet, from several wallets, or from an
          exchange. The dev wallet never has to hold it, and whoever funds is not whoever launches.
        </p>

        {distributor && (
          <div className="notice">
            <h3>send the buy to this address</h3>
            <ul>
              <li>
                <a href={`${explorer}/address/${distributor.address}`} target="_blank" rel="noreferrer">
                  {distributor.address}
                </a>
              </li>
              <li>
                currently holding <strong>{Number(staged).toFixed(4)} ETH</strong>
                {Number(staged) > 0 ? ' — all of it goes into the launch buy' : ''}
              </li>
              <li>
                anything you add on the launch itself is added to this, so either route works
              </li>
            </ul>
          </div>
        )}

        <div className="row">
          <span className="hint">balances refresh when this panel reloads</span>
          <span className="spacer" />
          <Busy busy={busy === 'refresh'} className="ghost" onClick={() => act('refresh', async () => {
            const s2 = await api('/distributor');
            return `distributor holds ${Number(s2.stagedEth || 0).toFixed(4)} ETH`;
          })}>
            Refresh balance
          </Busy>
        </div>
      </Step>

      <Step {...step(5)}>
        <p className="lede">
          Everything below happens in one transaction. The dev buy is not a separate step and it is
          not optional — it is the mechanism. It executes inside the launch, exempt from the 5% cap,
          before the pool is reachable by anyone else.
        </p>

        <div className="row">
          <label className="hint">
            name
            <input value={form.name} onChange={set('name')} style={{ width: 200, marginLeft: 6 }} />
          </label>
          <label className="hint">
            symbol
            <input value={form.symbol} onChange={set('symbol')} style={{ width: 110, marginLeft: 6 }} />
          </label>
        </div>

        <LogoField value={form.logo} onChange={(v) => setForm((f) => ({ ...f, logo: v }))} />

        <div className="row">
          <label className="hint" style={{ flex: 1 }}>
            description
            <input
              value={form.description}
              onChange={set('description')}
              style={{ width: '100%', marginLeft: 6 }}
            />
          </label>
        </div>

        <div className="row">
          <label className="hint">
            twitter
            <input value={form.twitter} onChange={set('twitter')} style={{ width: 180, marginLeft: 6 }} />
          </label>
          <label className="hint">
            telegram
            <input value={form.telegram} onChange={set('telegram')} style={{ width: 180, marginLeft: 6 }} />
          </label>
          <label className="hint">
            website
            <input value={form.website} onChange={set('website')} style={{ width: 180, marginLeft: 6 }} />
          </label>
        </div>

        <div className="row">
          <label className="hint">
            dev buy
            <input
              type="number"
              step="0.1"
              min="0"
              value={devBuy}
              onChange={(e) => setDevBuy(e.target.value)}
              style={{ width: 90, marginLeft: 6 }}
            />
            {' ETH'}
          </label>
          <span className="spacer" />
          {projection && (
            <span className="hint">
              ≈ {projection.share.toFixed(1)}% of supply
              {bundle.length ? `, about ${projection.each.toFixed(2)}% per wallet` : ''}
            </span>
          )}
        </div>

        {/* The one number worth guidance on. 3.5 ETH is the knee of the supply
            curve and 6,441 launches chain-wide use exactly it — but the effect
            is continuous, so a smaller buy is a smaller version of the same
            thing rather than a different strategy. */}
        <div className="notice">
          <h3>sizing the dev buy</h3>
          <ul>
            <li>3.5 ETH takes ~72% of supply — the knee of the curve, and what most operators use</li>
            <li>1.0 ETH takes ~42%; 0.5 ETH ~27%. Smaller works, proportionally</li>
            <li>
              Below ~6% of supply you are in the band the bots trade hardest — 0.12 ETH is the
              floor worth launching at
            </li>
          </ul>
        </div>

        <div className="row">
          <span className="hint">
            {ready
              ? 'simulated before it sends — a launch that would revert never spends the fee'
              : 'needs a name, a symbol, bundle wallets and the distributor'}
          </span>
          <span className="spacer" />
          <Busy
            busy={busy === 'launch'}
            disabled={!ready || !(Number(devBuy) > 0)}
            onClick={() =>
              act('launch', async () => {
                const out = await api('/distributor/launch', 'POST', {
                  confirm: true,
                  devBuyEth: Number(devBuy),
                  params: {
                    name: form.name,
                    symbol: form.symbol,
                    logo: form.logo,
                    description: form.description,
                    socials: {
                      twitter: form.twitter,
                      telegram: form.telegram,
                      website: form.website,
                    },
                  },
                });
                setLaunched(out.status === 1 ? out : null);
                return out.status === 1
                  ? `LAUNCHED ${out.token} — ${devBuy} ETH split across ${out.wallets.length} wallets in block ${out.blockNumber}`
                  : `reverted — ${out.hash}`;
              })
            }
          >
            {projection
              ? `Launch and take ${projection.share.toFixed(0)}% of supply`
              : 'Launch and distribute'}
          </Busy>
        </div>

        {launched && (
          <div className="notice">
            <h3>launched</h3>
            <ul>
              <li>
                <a href={`${explorer}/address/${launched.token}`} target="_blank" rel="noreferrer">
                  {launched.token}
                </a>
              </li>
              <li>
                {launched.devBuyEth} ETH taken atomically, split across {launched.wallets.length}{' '}
                wallets in the launch block
              </li>
            </ul>
          </div>
        )}
      </Step>

      <Step {...step(6)} last>
        <p className="lede">
          A second buy through the same contract, on your timing. This one is an ordinary pool buy,
          so it is <em>not</em> protected the way the launch buy is — anyone can trade ahead of it.
          Use it to add to a position, not to establish one.
        </p>

        <div className="row">
          <label className="hint">
            spend
            <input
              type="number"
              step="0.01"
              min="0"
              value={topUp}
              onChange={(e) => { setTopUp(e.target.value); setQuote(null); }}
              style={{ width: 90, marginLeft: 6 }}
            />
            {' ETH'}
          </label>
          <span className="spacer" />
          <Busy
            busy={busy === 'quote'}
            className="ghost"
            disabled={!launched?.token || !(Number(topUp) > 0)}
            onClick={() => act('quote', async () => {
              const q = await api('/distributor/quote', 'POST', { token: launched.token, amountEth: Number(topUp) });
              setQuote(q);
              return q.ok
                ? `quote: ${(Number(q.amountOut) / 1e18).toLocaleString()} tokens`
                : `NOT READY — ${q.reason}`;
            })}
          >
            Quote it
          </Busy>
          <Busy
            busy={busy === 'trigger'}
            disabled={!quote?.ok}
            onClick={() => act('trigger', async () => {
              const out = await api('/distributor/trigger', 'POST', {
                token: launched.token, amountEth: Number(topUp), confirm: true,
              });
              setTriggered(out.status === 1 ? out : null);
              setQuote(null);
              return out.status === 1
                ? `added ${(Number(out.amountOut) / 1e18).toLocaleString()} tokens in block ${out.blockNumber}`
                : `reverted — ${out.hash}`;
            })}
          >
            Buy more
          </Busy>
        </div>

        {!launched?.token && <p className="hint">launch first — this buys the token from step 5</p>}
      </Step>
    </>
  );
}
