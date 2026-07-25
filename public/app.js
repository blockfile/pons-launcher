'use strict';

const $ = (id) => document.getElementById(id);
const out = (v) => ($('out').textContent = typeof v === 'string' ? v : JSON.stringify(v, null, 2));

let WALLETS = [];
let CONFIGS = null;
let EXPLORER = '';

// The API key stays in this tab only — it is never persisted to localStorage,
// where any other script on the origin could read it.
const apiKey = () => $('apiKey').value.trim();

async function api(path, method = 'GET', body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (!res.ok) throw new Error(json.error || `${res.status}`);
  return json;
}

function busy(el, on) {
  el.disabled = on;
  el.dataset.label = el.dataset.label || el.textContent;
  el.textContent = on ? '…' : el.dataset.label;
}

async function run(el, fn) {
  busy(el, true);
  try {
    out(await fn());
  } catch (err) {
    out(`ERROR: ${err.message}`);
  } finally {
    busy(el, false);
  }
}

// ── wallets ─────────────────────────────────────────────────────────────────

function walletRow(w) {
  const tr = document.createElement('tr');
  tr.dataset.id = w.id;
  tr.innerHTML = `
    <td><span class="role ${w.role}">${w.role}</span></td>
    <td class="addr">${w.address}</td>
    <td class="addr">${Number(w.balanceEth).toFixed(6)}</td>
    <td>${w.role === 'dev' ? '' : '<input class="fund" type="number" step="0.0001" placeholder="0.0" />'}</td>
    <td>${
      w.role === 'dev'
        ? ''
        : '<select class="mode"><option value="fixed">fixed</option><option value="all">all − gas</option></select>'
    }</td>
    <td>${w.role === 'dev' ? '' : '<input class="buy" type="number" step="0.0001" placeholder="0.0" />'}</td>
    <td><button class="ghost del">×</button></td>`;

  tr.querySelector('.del').onclick = async () => {
    if (!confirm(`Delete ${w.address}? Its key is erased from the keystore.`)) return;
    await api(`/wallets/${w.id}`, 'DELETE').catch((e) => out(`ERROR: ${e.message}`));
    loadWallets();
  };

  const mode = tr.querySelector('.mode');
  if (mode) {
    // "all − gas" computes the amount server-side, so the field is meaningless.
    mode.onchange = () => {
      const buy = tr.querySelector('.buy');
      buy.disabled = mode.value === 'all';
      buy.value = mode.value === 'all' ? '' : buy.value;
    };
  }
  return tr;
}

async function loadWallets() {
  WALLETS = await api('/wallets');
  const tbody = $('wallets').querySelector('tbody');
  tbody.replaceChildren(...WALLETS.map(walletRow));
}

function bundleRows() {
  return [...$('wallets').querySelectorAll('tbody tr')].filter((tr) => tr.querySelector('.mode'));
}

// ── configs ─────────────────────────────────────────────────────────────────

async function loadConfigs() {
  CONFIGS = await api('/configs');
  $('launchConfigId').replaceChildren(
    ...CONFIGS.launchConfigs.map((c) => {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `#${c.id} — ${c.maxWalletBps / 100}% wallet / ${c.restrictionBlocks} blk${
        c.enabled ? '' : ' (disabled)'
      }`;
      o.disabled = !c.enabled;
      return o;
    })
  );
  $('dexId').replaceChildren(
    ...CONFIGS.dexConfigs.map((d) => {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = `#${d.id} — ${d.name} (${d.poolFee / 10000}%)`;
      o.disabled = !d.enabled;
      return o;
    })
  );
  describeConfig();
}

function describeConfig() {
  if (!CONFIGS) return;
  const c = CONFIGS.launchConfigs.find((x) => x.id === Number($('launchConfigId').value));
  if (!c) return;
  const fee = Number(CONFIGS.launchFee) / 1e18;
  $('configNote').textContent =
    `launch fee ${fee} ETH · restriction ${c.restrictionBlocks} blocks · ` +
    `max wallet ${c.maxWalletBps / 100}% · max buy ${c.maxTxBps / 100}% · ` +
    `router ${c.routerRequiresDeadline ? 'V3 (deadline)' : 'Router02'}`;
}

// ── launch payload ──────────────────────────────────────────────────────────

function launchBody() {
  return {
    params: {
      name: $('name').value.trim(),
      symbol: $('symbol').value.trim(),
      logo: $('logo').value.trim(),
      description: $('description').value.trim(),
      socials: {
        twitter: $('twitter').value.trim(),
        telegram: $('telegram').value.trim(),
        discord: $('discord').value.trim(),
        website: $('website').value.trim(),
        farcaster: $('farcaster').value.trim(),
      },
      feeWallet: $('feeWallet').value.trim(),
    },
    launchConfigId: Number($('launchConfigId').value),
    dexId: Number($('dexId').value),
    devBuyEth: $('devBuyEth').value || 0,
    wallets: bundleRows()
      .map((tr) => ({
        walletId: tr.dataset.id,
        mode: tr.querySelector('.mode').value,
        amountEth: tr.querySelector('.buy').value,
      }))
      .filter((w) => w.mode === 'all' || Number(w.amountEth) > 0),
  };
}

// ── history ─────────────────────────────────────────────────────────────────

async function loadHistory() {
  const entries = await api('/launches?limit=15');
  if (!entries.length) return ($('history').textContent = 'no launches yet');
  $('history').replaceChildren(
    ...entries.map((e) => {
      const div = document.createElement('div');
      const link = `${EXPLORER}/address/${e.token}`;
      div.innerHTML =
        `${e.at.replace('T', ' ').slice(0, 19)} · ` +
        `<a href="${link}" target="_blank" rel="noopener">${e.params?.symbol || e.token}</a> · ` +
        `dev ${e.devBuyEth} + bundle ${e.totalBuyEth} ETH · ` +
        `${e.buys.filter((b) => b.status === 'confirmed').length}/${e.buys.length} filled` +
        (e.sameBlock ? ` · ${e.sameBlock} same-block` : '') +
        (e.dryRun ? ' · DRY RUN' : '');
      return div;
    })
  );
}

// ── wiring ──────────────────────────────────────────────────────────────────

$('genDev').onclick = (e) =>
  run(e.target, async () => {
    const made = await api('/wallets/generate', 'POST', { count: 1, role: 'dev', label: 'dev' });
    await loadWallets();
    return made;
  });

$('genBundle').onclick = (e) =>
  run(e.target, async () => {
    const made = await api('/wallets/generate', 'POST', {
      count: Number($('genCount').value) || 1,
      role: 'bundle',
      label: 'bundle',
    });
    await loadWallets();
    return made;
  });

$('showImport').onclick = () => $('importBox').classList.toggle('hidden');

$('doImport').onclick = (e) =>
  run(e.target, async () => {
    const made = await api('/wallets/import', 'POST', {
      privateKeys: $('importKeys').value.split('\n'),
      role: $('importRole').value,
    });
    $('importKeys').value = '';
    await loadWallets();
    return made;
  });

$('refreshWallets').onclick = (e) => run(e.target, async () => (await loadWallets()) || WALLETS);

$('fund').onclick = (e) =>
  run(e.target, async () => {
    const targets = bundleRows()
      .map((tr) => ({ walletId: tr.dataset.id, amountEth: tr.querySelector('.fund').value }))
      .filter((t) => Number(t.amountEth) > 0);
    if (!targets.length) throw new Error('no fund amounts entered');
    const res = await api('/fund', 'POST', { targets });
    setTimeout(loadWallets, 3000);
    return res;
  });

$('sweep').onclick = (e) =>
  run(e.target, async () => {
    const res = await api('/sweep', 'POST', {
      includeTokens: $('sweepTokens').checked,
      tokenAddress: $('sweepToken').value.trim() || null,
    });
    setTimeout(loadWallets, 3000);
    return res;
  });

$('preflight').onclick = (e) => run(e.target, () => api('/preflight', 'POST', launchBody()));

$('launch').onclick = (e) =>
  run(e.target, async () => {
    const body = launchBody();
    const live = $('status').classList.contains('live');
    const msg = live
      ? `LIVE LAUNCH — this spends real funds.\n\n${body.params.symbol}\ndev buy ${body.devBuyEth} ETH\n${body.wallets.length} bundle wallets\n\nProceed?`
      : `Dry run launch of ${body.params.symbol}. Nothing will be broadcast. Proceed?`;
    if (!confirm(msg)) return 'cancelled';
    const res = await api('/launch', 'POST', body);
    loadHistory();
    setTimeout(loadWallets, 3000);
    return res;
  });

$('launchConfigId').onchange = describeConfig;

// ── boot ────────────────────────────────────────────────────────────────────

(async function boot() {
  try {
    const h = await api('/health');
    EXPLORER = h.explorer;
    const s = $('status');
    s.textContent = h.dryRun ? 'DRY RUN · nothing is broadcast' : `LIVE · chain ${h.chainId}`;
    s.className = `status ${h.dryRun ? 'dry' : 'live'}`;
    await loadWallets();
    await loadConfigs();
    await loadHistory();
    out('ready');
  } catch (err) {
    out(`ERROR: ${err.message}`);
    $('status').textContent = 'error';
  }
})();
