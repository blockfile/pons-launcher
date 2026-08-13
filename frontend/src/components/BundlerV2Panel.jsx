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
  reload,
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
  const [devBuy, setDevBuy] = useState('0');
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
    setNote(null);
    try {
      const out = await fn();
      // Both, deliberately: report() feeds the shared readout and the activity
      // log, but that panel lives inside the V1-only block and is hidden here,
      // so this tab needs its own line or an error has nowhere to appear.
      report(out);
      if (typeof out === 'string') setNote({ ok: true, text: out });
      await load();
      return out;
    } catch (err) {
      report(`ERROR: ${err.message}`);
      setNote({ ok: false, text: err.message });
      return null;
    } finally {
      setBusy('');
    }
  }

  const distributor = state?.distributor || null;
  const deployQuote = state?.quote || null;
  const staged = state?.stagedEth || '0';
  // v2's OWN wallets. Nothing here reads v1's dev or bundle roles: the two
  // strategies fund and spend differently, and a screen that cannot say which
  // set a button is about to move is one click from mixing them.
  const dev = wallets.find((w) => w.role === 'v2dev');
  const funder = wallets.find((w) => w.role === 'v2funding');
  const bundle = wallets.filter((w) => w.role === 'v2bundle');
  const [count, setCount] = useState(30);
  // Import is offered everywhere create is. A wallet that already exists —
  // funded, aged, or carried over from another tool — is often the one an
  // operator actually wants here, and a console that can only generate forces
  // a needless transfer to get funds where they were already going.
  const [note, setNote] = useState(null);
  const [importing, setImporting] = useState('');
  const [picking, setPicking] = useState('');
  // Two-click arm on the bulk delete. Thirty archived wallets is thirty keys
  // moved out of the live keystore, and the count next to the second click is
  // the last chance to notice it says thirty and not three.
  const [armed, setArmed] = useState(false);
  const [stageAmt, setStageAmt] = useState('3.5');
  const [keys, setKeys] = useState('');

  const gen = (role, n = 1) =>
    act(role, async () => {
      const made = await api('/wallets/generate', 'POST', { count: n, role });
      await reload?.();
      return `generated ${made.length} ${role} wallet(s)`;
    });

  const imp = (role) =>
    act(`import-${role}`, async () => {
      const added = await api('/wallets/import', 'POST', { privateKeys: keys, role });
      setKeys('');
      setImporting('');
      await reload?.();
      return `imported ${added.length} ${role} wallet(s)`;
    });

  /**
   * One key field, shared by whichever role is mid-import.
   *
   * The shape is checked here before the round trip. A private key is 64 hex
   * characters with an optional 0x — an address is 40, and pasting one of those
   * by mistake is the commonest way to get a bare 400 back from the server with
   * nothing useful in it.
   */
  /**
   * Move a wallet already in the keystore into a v2 role.
   *
   * A key cannot be imported twice — one key, one role, or the two tabs would
   * be spending the same address while claiming to be separate. So the answer
   * to "that wallet already exists" is to move it, not to make the operator
   * generate a fresh one and transfer a balance across for bookkeeping.
   */
  const move = (id, role) =>
    act(`move-${role}`, async () => {
      const out = await api(`/wallets/${id}/role`, 'POST', { role });
      setPicking('');
      await reload?.();
      return `moved ${out.address} to ${role}`;
    });

  const picker = (role, label) => {
    if (picking !== role) return null;
    // Anything not already spoken for by this tab. A v1 bundle wallet is the
    // usual candidate — it is where an operator's spare funded wallets live.
    const candidates = wallets.filter((w) => !['v2dev', 'v2funding'].includes(w.role));
    return (
      <div style={{ padding: '4px 0' }}>
        <div className="hint" style={{ marginBottom: 4 }}>{label}</div>
        {candidates.length ? (
          <div className="row" style={{ alignItems: 'center', gap: 8 }}>
            <select id={`pick-${role}`} style={{ flex: 1, minWidth: 0 }} defaultValue="">
              <option value="" disabled>
                choose a wallet…
              </option>
              {candidates.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.address} — {w.role} — {Number(w.balanceEth || 0).toFixed(4)} ETH
                </option>
              ))}
            </select>
            <Busy
              busy={busy === `move-${role}`}
              className="ghost"
              onClick={() => {
                const el = document.getElementById(`pick-${role}`);
                if (el?.value) move(el.value, role);
              }}
            >
              Move it
            </Busy>
            <button type="button" className="ghost" onClick={() => setPicking('')}>
              cancel
            </button>
          </div>
        ) : (
          <p className="hint">no other wallets in the keystore to move</p>
        )}
        <p className="hint" style={{ marginTop: 4 }}>
          It leaves whatever role it holds now — a V1 bundle wallet moved here stops being one.
        </p>
      </div>
    );
  };

  const keyShapeError = (raw) => {
    const parts = String(raw).trim().split(/[s,]+/).filter(Boolean);
    if (!parts.length) return 'paste a key first';
    for (const k of parts) {
      const hex = k.startsWith('0x') || k.startsWith('0X') ? k.slice(2) : k;
      if (hex.length === 40) return 'that looks like an ADDRESS, not a private key';
      if (hex.length !== 64) return `a private key is 64 hex characters — this one has ${hex.length}`;
      if (!/^[0-9a-fA-F]+$/.test(hex)) return 'that contains characters that are not hex';
    }
    return null;
  };

  const importBox = (role, label) => {
    if (importing !== role) return null;
    const shape = keys.trim() ? keyShapeError(keys) : null;
    return (
      <div style={{ padding: '4px 0' }}>
        <div className="hint" style={{ marginBottom: 4 }}>{label}</div>
        <div className="row" style={{ alignItems: 'center', gap: 8 }}>
          <input
            type="password"
            value={keys}
            onChange={(e) => setKeys(e.target.value)}
            placeholder="0x… private key"
            style={{ flex: 1, minWidth: 0 }}
          />
          <Busy
            busy={busy === `import-${role}`}
            className="ghost"
            disabled={!keys.trim() || Boolean(shape)}
            onClick={() => imp(role)}
          >
            Import
          </Busy>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setImporting('');
              setKeys('');
            }}
          >
            cancel
          </button>
        </div>
        {shape && <p className="hint" style={{ marginTop: 4 }}>{shape}</p>}
      </div>
    );
  };

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

  // What will actually be spent: whatever is staged in the contract PLUS
  // anything typed on the launch itself. The button used to gate on the typed
  // figure alone, so a fully staged launch with 0 typed — the normal case once
  // step 4 has been used — sat there disabled with nothing saying why.
  const spend = Number(staged) + Number(devBuy || 0);
  const ready = form.name && form.symbol && bundle.length > 0 && distributor && spend > 0;

  const steps = useMemo(() => {
    const plan = [
      {
        n: 1,
        title: 'Create the V2 wallets',
        done: Boolean(dev) && Boolean(funder),
        detail:
          dev && funder
            ? `signer ${short(dev.address)} · funder ${short(funder.address)}`
            : dev
              ? 'signer ready — still needs a funding wallet'
              : 'a signer and a funder, both V2-only',
      },
      {
        n: 2,
        title: 'Deploy the distributor',
        done: Boolean(distributor),
        detail: distributor ? short(distributor.address) : 'one contract, reused for every launch after',
      },
      {
        n: 3,
        title: 'Generate V2 bundle wallets',
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
  }, [dev, funder, distributor, bundle.length, staged, launched, triggered, projection, devBuy, form.symbol]);

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

      {note && (
        <div className={`notice ${note.ok ? '' : 'warn'}`}>
          <h3>{note.ok ? 'done' : 'that did not work'}</h3>
          <ul>
            <li>{note.text}</li>
          </ul>
        </div>
      )}

      <Step {...step(1)}>
        <p className="lede">
          V2 uses its own wallets — none of these are the V1 dev or bundle wallets, and no button
          on this tab can move them. Three roles, kept apart on purpose: a <strong>signer</strong>
          that only pays gas and the launch fee, a <strong>funder</strong> that holds the buy, and
          the bundle wallets that receive the supply.
        </p>

        <table className="disperser-list">
          <tbody>
            <tr>
              <td className="hint">signer</td>
              <td>
                {dev ? (
                  <a href={`${explorer}/address/${dev.address}`} target="_blank" rel="noreferrer">
                    {dev.address}
                  </a>
                ) : (
                  <span className="hint">not created</span>
                )}
              </td>
              <td className="hint">
                {dev ? `${Number(dev.balanceEth || 0).toFixed(4)} ETH — gas only` : ''}
              </td>
              <td>
                {!dev && (
                  <>
                    <Busy busy={busy === 'v2dev'} className="ghost" onClick={() => gen('v2dev')}>
                      Create
                    </Busy>
                    <button type="button" className="ghost" onClick={() => { setImporting('v2dev'); setKeys(''); }}>
                      import
                    </button>
                    <button type="button" className="ghost" onClick={() => { setPicking('v2dev'); setImporting(''); }}>
                      use existing
                    </button>
                  </>
                )}
              </td>
            </tr>
            {importing === 'v2dev' && (
              <tr>
                <td colSpan={4}>{importBox('v2dev', 'signer private key')}</td>
              </tr>
            )}
            {picking === 'v2dev' && (
              <tr>
                <td colSpan={4}>{picker('v2dev', 'move an existing wallet into the signer role')}</td>
              </tr>
            )}
            <tr>
              <td className="hint">funder</td>
              <td>
                {funder ? (
                  <a href={`${explorer}/address/${funder.address}`} target="_blank" rel="noreferrer">
                    {funder.address}
                  </a>
                ) : (
                  <span className="hint">not created</span>
                )}
              </td>
              <td className="hint">
                {funder ? `${Number(funder.balanceEth || 0).toFixed(4)} ETH — stages the buy` : ''}
              </td>
              <td>
                {!funder && (
                  <>
                    <Busy busy={busy === 'v2funding'} className="ghost" onClick={() => gen('v2funding')}>
                      Create
                    </Busy>
                    <button type="button" className="ghost" onClick={() => { setImporting('v2funding'); setKeys(''); }}>
                      import
                    </button>
                    <button type="button" className="ghost" onClick={() => { setPicking('v2funding'); setImporting(''); }}>
                      use existing
                    </button>
                  </>
                )}
              </td>
            </tr>
            {importing === 'v2funding' && (
              <tr>
                <td colSpan={4}>{importBox('v2funding', 'funder private key')}</td>
              </tr>
            )}
            {picking === 'v2funding' && (
              <tr>
                <td colSpan={4}>{picker('v2funding', 'move an existing wallet into the funder role')}</td>
              </tr>
            )}
          </tbody>
        </table>

        <p className="hint">
          Fund the signer with a little ETH for gas, and the funder with whatever the launch will
          spend. Both are ordinary keystore wallets — they back up and archive like every other,
          and an imported key is treated exactly like a generated one.
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
          These receive the supply and never buy it, so <strong>they need no ETH at all</strong>
          {' '}before a launch. That is what removes the disperser run — the thing that currently
          announces a launch eight to twenty-two minutes before it happens.
        </p>

        <div className="row">
          <label className="hint">
            generate
            <input
              type="number"
              min="1"
              max="100"
              value={count}
              onChange={(e) => setCount(e.target.value)}
              style={{ width: 70, marginLeft: 6 }}
            />
          </label>
          <span className="spacer" />
          <span className="hint">
            {bundle.length ? `${plural(bundle.length, 'V2 bundle wallet')} so far` : 'none yet'}
          </span>
          <Busy
            busy={busy === 'v2bundle'}
            className="ghost"
            disabled={!(Number(count) >= 1)}
            onClick={() => gen('v2bundle', Number(count))}
          >
            Create {count}
          </Busy>
          <button type="button" className="ghost" onClick={() => { setImporting('v2bundle'); setKeys(''); }}>
            import
          </button>
        </div>

        {importBox('v2bundle', 'private keys — several separated by spaces, commas or newlines')}

        {bundle.length > 0 && (
          <table className="disperser-list">
            <tbody>
              {bundle.map((w) => (
                <tr key={w.id}>
                  <td>
                    <a href={`${explorer}/address/${w.address}`} target="_blank" rel="noreferrer">
                      {w.address}
                    </a>
                  </td>
                  <td className="hint">{Number(w.balanceEth || 0).toFixed(4)} ETH</td>
                  <td>
                    <Busy
                      busy={busy === `del-${w.id}`}
                      className="ghost"
                      title="archive this wallet — the key is recoverable on the server until purged"
                      onClick={() =>
                        act(`del-${w.id}`, async () => {
                          await api(`/wallets/${w.id}`, 'DELETE');
                          await reload?.();
                          return `archived ${w.address}`;
                        })
                      }
                    >
                      ✕
                    </Busy>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {bundle.length > 0 && (
          <div className="row">
            <span className="hint">
              deleting archives the key — recoverable on the server with{' '}
              <code>npm run archive:restore</code> until it is purged
            </span>
            <span className="spacer" />
            <Busy
              busy={busy === 'del-all'}
              className="ghost"
              onClick={() => {
                if (!armed) {
                  setArmed(true);
                  return;
                }
                setArmed(false);
                act('del-all', async () => {
                  let gone = 0;
                  for (const w of bundle) {
                    await api(`/wallets/${w.id}`, 'DELETE');
                    gone += 1;
                  }
                  await reload?.();
                  return `archived ${gone} V2 bundle wallet(s)`;
                });
              }}
            >
              {armed ? `Really delete all ${bundle.length}?` : 'Delete all'}
            </Busy>
            {armed && (
              <button type="button" className="ghost" onClick={() => setArmed(false)}>
                cancel
              </button>
            )}
          </div>
        )}

        <p className="hint">
          They need gas only later, when you sell — funding them then leaks nothing, because the
          launch is already over.
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
          <label className="hint">
            send
            <input
              type="number"
              step="0.1"
              min="0"
              value={stageAmt}
              onChange={(e) => setStageAmt(e.target.value)}
              style={{ width: 90, marginLeft: 6 }}
            />
            {' ETH from the funder'}
          </label>
          <span className="spacer" />
          <Busy
            busy={busy === 'stage'}
            className="ghost"
            disabled={!funder || !distributor || !(Number(stageAmt) > 0)}
            onClick={() =>
              act('stage', async () => {
                const out = await api('/distributor/stage', 'POST', {
                  amountEth: Number(stageAmt),
                  confirm: true,
                });
                return `staged — the contract now holds ${Number(out.stagedEth).toFixed(4)} ETH`;
              })
            }
          >
            Stage it
          </Busy>
          <Busy
            busy={busy === 'withdraw'}
            className="ghost"
            disabled={!distributor || !(Number(staged) > 0)}
            title="send the staged ETH back to the funding wallet"
            onClick={() =>
              act('withdraw', async () => {
                const out = await api('/distributor/withdraw', 'POST', { confirm: true });
                return `withdrew ${Number(out.withdrewEth).toFixed(4)} ETH to ${out.to}`;
              })
            }
          >
            Withdraw
          </Busy>
          <Busy
            busy={busy === 'refresh'}
            className="ghost"
            onClick={() =>
              act('refresh', async () => {
                const s2 = await api('/distributor');
                return `distributor holds ${Number(s2.stagedEth || 0).toFixed(4)} ETH`;
              })
            }
          >
            Refresh
          </Busy>
        </div>

        {!funder && (
          <p className="hint">
            no funding wallet yet — create one in step 1, or send ETH to the address above from
            anywhere.
          </p>
        )}
        {funder && (
          <p className="hint">
            funder {funder.address} holds {Number(funder.balanceEth || 0).toFixed(4)} ETH. Sending
            from elsewhere works too — the contract accepts a plain transfer from any address.
          </p>
        )}
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
            add
            <input
              type="number"
              step="0.1"
              min="0"
              value={devBuy}
              onChange={(e) => setDevBuy(e.target.value)}
              style={{ width: 90, marginLeft: 6 }}
            />
            {` ETH to the ${Number(staged).toFixed(4)} already staged`}
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
              ? `spends ${spend.toFixed(4)} ETH — ${Number(staged).toFixed(4)} staged${
                  Number(devBuy) > 0 ? ` + ${Number(devBuy).toFixed(4)} sent with the launch` : ''
                }. Simulated first, so a launch that would revert never spends the fee.`
              : !distributor
                ? 'needs the distributor from step 2'
                : bundle.length === 0
                  ? 'needs bundle wallets from step 3'
                  : spend <= 0
                    ? 'nothing to spend — stage ETH in step 4, or type an amount here'
                    : 'needs a name and a symbol'}
          </span>
          <span className="spacer" />
          <Busy
            busy={busy === 'launch'}
            disabled={!ready}
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
