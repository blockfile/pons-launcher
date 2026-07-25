import { useState } from 'react';
import { api } from '../api.js';
import Section, { Busy } from './Section.jsx';
import LogoField from './LogoField.jsx';

// The chain makes a block every ~100ms, but the restriction window is counted
// in the EVM's own block number, which advances roughly every 16 seconds. So
// "2 blocks" is about half a minute, and every bundle wallet is inside it.
const EVM_BLOCK_SECONDS = 16;

const BLANK = {
  name: '',
  symbol: '',
  logo: '',
  description: '',
  feeWallet: '',
  twitter: '',
  telegram: '',
  discord: '',
  website: '',
  farcaster: '',
  devBuyEth: '0.05',
};

export default function LaunchForm({
  configs,
  wallets,
  rows,
  live,
  reload,
  reloadHistory,
  report,
  onLogo,
}) {
  const [f, setF] = useState(BLANK);
  const [launchConfigId, setLaunchConfigId] = useState(0);
  const [dexId, setDexId] = useState(0);
  const [busy, setBusy] = useState('');
  const [uploading, setUploading] = useState(false);
  const [armed, setArmed] = useState(false);

  const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.value }));
  const setLogo = (logo) => {
    setF((prev) => ({ ...prev, logo }));
    onLogo?.(logo);
  };

  const lc = configs?.launchConfigs.find((c) => c.id === Number(launchConfigId));

  function body() {
    return {
      params: {
        name: f.name.trim(),
        symbol: f.symbol.trim(),
        logo: f.logo.trim(),
        description: f.description.trim(),
        socials: {
          twitter: f.twitter.trim(),
          telegram: f.telegram.trim(),
          discord: f.discord.trim(),
          website: f.website.trim(),
          farcaster: f.farcaster.trim(),
        },
        feeWallet: f.feeWallet.trim(),
      },
      launchConfigId: Number(launchConfigId),
      dexId: Number(dexId),
      devBuyEth: f.devBuyEth || 0,
      wallets: wallets
        .filter((w) => w.role !== 'dev')
        .map((w) => ({
          walletId: w.id,
          mode: rows[w.id]?.mode ?? 'fixed',
          amountEth: rows[w.id]?.buy,
        }))
        .filter((w) => w.mode === 'all' || Number(w.amountEth) > 0),
    };
  }

  async function act(name, fn) {
    setBusy(name);
    try {
      report(await fn());
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  function launch() {
    const b = body();
    // The wording changes with DRY_RUN so a live bundle can never be fired in
    // the belief that it was a rehearsal.
    const msg = live
      ? `LIVE LAUNCH — this spends real funds.\n\n${b.params.symbol}\ndev buy ${b.devBuyEth} ETH\n${b.wallets.length} bundle wallets\n\nProceed?`
      : `Dry run launch of ${b.params.symbol}. Nothing will be broadcast. Proceed?`;
    if (!confirm(msg)) return;

    act('launch', async () => {
      const res = await api('/launch', 'POST', b);
      reloadHistory();
      // Re-lock the guard: one arming, one launch.
      setArmed(false);
      setTimeout(reload, 3000);
      return res;
    });
  }

  const buying = wallets.filter(
    (w) => w.role !== 'dev' && (rows[w.id]?.mode === 'all' || Number(rows[w.id]?.buy) > 0)
  ).length;
  const ready = Boolean(f.name.trim() && f.symbol.trim() && f.logo) && !uploading;
  const blocked = live && !armed;

  return (
    <Section step="3" title="Launch" done={ready}>
      <p className="lede">
        The launch transaction deploys the token, opens the pool and makes your dev buy in one call.
        Every bundle buy is signed in advance and broadcast the instant it lands.
      </p>

      <div className="grid">
        <label>
          Name
          <input value={f.name} onChange={set('name')} placeholder="Token name" />
        </label>
        <label>
          Symbol
          <input value={f.symbol} onChange={set('symbol')} placeholder="Symbol" />
        </label>
        <label className="half">
          Website
          <input value={f.website} onChange={set('website')} placeholder="https://…" />
        </label>

        <LogoField value={f.logo} onChange={setLogo} onUploading={setUploading} />

        <label>
          Twitter
          <input value={f.twitter} onChange={set('twitter')} placeholder="https://x.com/…" />
        </label>
        <label>
          Telegram
          <input value={f.telegram} onChange={set('telegram')} placeholder="https://t.me/…" />
        </label>
        <label>
          Discord
          <input value={f.discord} onChange={set('discord')} />
        </label>
        <label>
          Farcaster
          <input value={f.farcaster} onChange={set('farcaster')} />
        </label>

        <label className="wide">
          Description
          <textarea rows="2" value={f.description} onChange={set('description')} />
        </label>

        <label className="wide">
          Fee wallet
          <input value={f.feeWallet} onChange={set('feeWallet')} placeholder="0x… (optional)" />
          <span className="hint">
            Receives the creator share of trading fees. Blank uses the dev wallet, which also
            receives the dev buy.
          </span>
        </label>

        <label>
          Launch config
          <select value={launchConfigId} onChange={(e) => setLaunchConfigId(e.target.value)}>
            {configs?.launchConfigs.map((c) => (
              <option key={c.id} value={c.id} disabled={!c.enabled}>
                #{c.id} — {c.maxWalletBps / 100}% wallet / {c.restrictionBlocks} blk
                {c.enabled ? '' : ' (disabled)'}
              </option>
            ))}
          </select>
        </label>
        <label>
          DEX
          <select value={dexId} onChange={(e) => setDexId(e.target.value)}>
            {configs?.dexConfigs.map((d) => (
              <option key={d.id} value={d.id} disabled={!d.enabled}>
                #{d.id} — {d.name} ({d.poolFee / 10000}%)
              </option>
            ))}
          </select>
        </label>
        <label className="half">
          Dev buy (ETH)
          <input type="number" step="0.0001" value={f.devBuyEth} onChange={set('devBuyEth')} />
          <span className="hint">
            Bought inside the launch itself — nothing can get ahead of it, and no cap applies.
          </span>
        </label>
      </div>

      {lc && configs && (
        <div className="notice">
          <h3>What config #{launchConfigId} enforces</h3>
          <ul>
            <li>
              launch fee {Number(configs.launchFee) / 1e18} ETH · router{' '}
              {lc.routerRequiresDeadline ? 'V3 (deadline)' : 'Router02'}
            </li>
            <li>
              restriction {lc.restrictionBlocks} blocks ≈ {lc.restrictionBlocks * EVM_BLOCK_SECONDS}s
              — every bundle wallet lands inside it
            </li>
            <li>
              during that window: max wallet {lc.maxWalletBps / 100}% · max buy {lc.maxTxBps / 100}%
              — a bundle buy above this reverts
            </li>
          </ul>
        </div>
      )}

      <div className={`arm ${live ? 'is-live' : ''}`}>
        <Busy
          busy={busy === 'preflight'}
          className="ghost"
          disabled={!ready}
          title={ready ? 'signs everything, broadcasts nothing' : 'fill in name, symbol and a logo'}
          onClick={() => act('preflight', () => api('/preflight', 'POST', body()))}
        >
          Preflight — signs, sends nothing
        </Busy>

        {live && (
          <label className={`switch ${armed ? 'armed' : ''}`}>
            <input type="checkbox" checked={armed} onChange={(e) => setArmed(e.target.checked)} />
            Arm
          </label>
        )}

        <Busy
          busy={busy === 'launch'}
          // Vermilion means irreversible. A dry run is not, and colouring it
          // the same would teach the operator to ignore the colour that matters.
          className={live ? 'danger' : ''}
          disabled={!ready || blocked}
          title={
            !ready
              ? 'fill in name, symbol and a logo'
              : blocked
                ? 'flip Arm first — this spends real funds'
                : ''
          }
          onClick={launch}
        >
          {live ? 'Launch + bundle' : 'Launch + bundle (dry run)'}
        </Busy>

        <div className="cost">
          <b>
            {buying} wallet{buying === 1 ? '' : 's'} buying
          </b>
          dev buy {f.devBuyEth || 0} ETH
        </div>
      </div>
    </Section>
  );
}
