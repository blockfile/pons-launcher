import { useState } from 'react';
import { api } from '../api.js';
import Section, { Busy } from './Section.jsx';
import LogoField from './LogoField.jsx';

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

export default function LaunchForm({ configs, wallets, rows, live, reload, reloadHistory, report }) {
  const [f, setF] = useState(BLANK);
  const [launchConfigId, setLaunchConfigId] = useState(0);
  const [dexId, setDexId] = useState(0);
  const [busy, setBusy] = useState('');
  const [uploading, setUploading] = useState(false);

  const set = (k) => (e) => setF((prev) => ({ ...prev, [k]: e.target.value }));

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
      setTimeout(reload, 3000);
      return res;
    });
  }

  return (
    <Section step="3" title="Launch">
      <div className="grid">
        <label>
          Name
          <input value={f.name} onChange={set('name')} placeholder="Pons Cat" />
        </label>
        <label>
          Symbol
          <input value={f.symbol} onChange={set('symbol')} placeholder="PONSCAT" />
        </label>
        <LogoField
          value={f.logo}
          onChange={(logo) => setF((prev) => ({ ...prev, logo }))}
          onUploading={setUploading}
        />
        <label>
          Website
          <input value={f.website} onChange={set('website')} placeholder="https://…" />
        </label>
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
          Fee wallet <span className="hint">— blank = the dev wallet, which also receives the atomic buy</span>
          <input value={f.feeWallet} onChange={set('feeWallet')} placeholder="0x… (optional)" />
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
        <label>
          Dev buy (ETH) <span className="hint">— atomic, uncapped</span>
          <input type="number" step="0.0001" value={f.devBuyEth} onChange={set('devBuyEth')} />
        </label>
      </div>

      {lc && configs && (
        <div className="note">
          launch fee {Number(configs.launchFee) / 1e18} ETH · restriction {lc.restrictionBlocks} blocks ·
          max wallet {lc.maxWalletBps / 100}% · max buy {lc.maxTxBps / 100}% · router{' '}
          {lc.routerRequiresDeadline ? 'V3 (deadline)' : 'Router02'}
        </div>
      )}

      <div className="row">
        <Busy
          busy={busy === 'preflight'}
          disabled={uploading}
          className="ghost"
          onClick={() => act('preflight', () => api('/preflight', 'POST', body()))}
        >
          Preflight (signs, sends nothing)
        </Busy>
        <Busy busy={busy === 'launch'} disabled={uploading} className="danger" onClick={launch}>
          LAUNCH + BUNDLE
        </Busy>
      </div>
    </Section>
  );
}
