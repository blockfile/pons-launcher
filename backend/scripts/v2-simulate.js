'use strict';

// Dry-run a pons v2 launch WITHOUT broadcasting anything.
//
// This is the "will it work?" check. It runs the real prepareV2 — the exact code
// the launch button runs — against your wallets and a config file, and reports
// GO or NO-GO. Because prepareV2 now estimates the launch on-chain and refuses a
// launch that would revert, a GO here means the launch actually simulates on the
// live chain. It signs the transactions locally and then stops: nothing is ever
// sent, so this costs only gas-free RPC reads.
//
// It is the guard against the two failures that stranded 1.798 ETH on
// 2026-08-13: a launch that reverts (here it prints the contract's own reason
// and exits non-zero), and an exemption list one over the limit (reported as a
// hard NO-GO with the count, not a "harmless" aside).
//
// Usage:
//   KEYSTORE_PASSPHRASE=... node scripts/v2-simulate.js [config.json]
//   npm run v2:simulate            (uses backend/data/v2-launch.sim.json)
//
// The first run writes a template config and exits so you can fill it in.

const fs = require('fs');
const path = require('path');
const { formatEther, parseEther } = require('ethers');
const { prepareV2 } = require('../src/bundle/prepareV2');
const { keystoreFor } = require('../src/wallets/keystore');

const CONFIG_PATH =
  process.argv[2] || path.join(__dirname, '..', 'data', 'v2-launch.sim.json');

const TEMPLATE = {
  name: 'My Token',
  symbol: 'MTK',
  logo: 'ipfs://<your-logo-cid>',
  description: '',
  launchConfigId: 0,
  devBuyEth: '0.05',
  // Uniform per-wallet buy, used for every v2bundle wallet when `walletIds` is
  // empty. Give each wallet its own amount by filling `walletIds` instead.
  buyEth: '0.04',
  // Leave empty to simulate EVERY v2bundle wallet in the keystore. Or list
  // specific ones: [{ "walletId": "...", "amountEth": "0.04" }].
  walletIds: [],
  creatorTaxBps: '50',
};

function loadOrTemplate() {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(TEMPLATE, null, 2));
    console.log(`No config found. Wrote a template to:\n  ${CONFIG_PATH}\n`);
    console.log('Fill in name / symbol / logo / devBuyEth / buyEth and run again.');
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function buildWallets(cfg, ks) {
  // Explicit list wins. Otherwise every v2bundle wallet buys the uniform amount.
  if (Array.isArray(cfg.walletIds) && cfg.walletIds.length) {
    return cfg.walletIds.map((w) =>
      typeof w === 'string'
        ? { walletId: w, amountEth: cfg.buyEth }
        : { walletId: w.walletId, amountEth: w.amountEth ?? cfg.buyEth }
    );
  }
  const bundle = ks.walletsWithRole('v2bundle');
  if (!bundle.length) {
    throw new Error('no v2bundle wallets in the keystore — generate some, or set walletIds');
  }
  return bundle.map((w) => ({ walletId: w.id, amountEth: cfg.buyEth }));
}

async function main() {
  const cfg = loadOrTemplate();
  const ks = keystoreFor();
  const wallets = buildWallets(cfg, ks);

  const input = {
    params: {
      name: cfg.name,
      symbol: cfg.symbol,
      logo: cfg.logo,
      description: cfg.description || '',
      creatorTaxBps: cfg.creatorTaxBps || '0',
    },
    launchConfigId: cfg.launchConfigId || 0,
    devBuyEth: cfg.devBuyEth || '0',
    wallets,
  };

  const devBuy = parseEther(String(cfg.devBuyEth || '0'));
  const limit = devBuy > 0n ? 31 : 32; // forwarder appends its own recipient
  console.log('pons v2 launch simulation — nothing is broadcast\n');
  console.log(`  token          ${cfg.name} (${cfg.symbol})`);
  console.log(`  dev buy        ${formatEther(devBuy)} ETH`);
  console.log(`  bundle wallets ${wallets.length}`);
  console.log(`  exempt limit   ${limit} (${devBuy > 0n ? 'with' : 'no'} dev buy)`);

  // Catch the over-limit case before the chain does, with the real number.
  if (wallets.length > limit) {
    console.log(
      `\nNO-GO: ${wallets.length} bundle wallets exceeds the ${limit}-wallet exemption limit ` +
        `for this path. Remove ${wallets.length - limit}. This is the exact revert (ExemptionListTooLong) ` +
        'that stranded 1.798 ETH.'
    );
    process.exit(1);
  }

  let plan;
  try {
    plan = await prepareV2(input, { keystore: ks });
  } catch (err) {
    console.log(`\nNO-GO: ${err.message}`);
    process.exit(1);
  }

  const totalBuy = plan.buys.reduce((s, b) => s + parseEther(String(b.amountEth || 0)), 0n);
  console.log(`\nGO — the launch simulates on-chain and nothing was broadcast.\n`);
  console.log(`  predicted curve  ${plan.curve}`);
  console.log(`  predicted token  ${plan.token}`);
  console.log(`  buys placed      ${plan.buys.length}`);
  console.log(`  total bundle buy ${formatEther(totalBuy)} ETH`);
  console.log(`  + dev buy        ${formatEther(devBuy)} ETH`);
  console.log(`  = total in       ${formatEther(totalBuy + devBuy)} ETH`);

  if (plan.warnings && plan.warnings.length) {
    console.log('\n  warnings:');
    for (const w of plan.warnings) console.log(`   - ${w}`);
  }

  // Surface the exact trap from before: wallets declared exempt with no buy.
  // prepareV2 calls these "harmless", but they still consume an exemption slot.
  const noBuy = plan.buys.filter((b) => Number(b.amountEth) === 0).length;
  if (noBuy) {
    console.log(
      `\n  note: ${noBuy} wallet(s) are exempt but buy nothing — each still uses one of the ${limit} ` +
        'slots. Drop them unless you mean to keep them.'
    );
  }

  console.log('\nThis was a simulation. To launch for real, use the console and arm it.');
}

main().catch((err) => {
  console.error('SIMULATION ERROR:', err.message);
  process.exit(1);
});
