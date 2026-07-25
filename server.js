'use strict';

const path = require('path');
const express = require('express');

const config = require('./src/config');
const factory = require('./src/evm/factory');
const walletRoutes = require('./src/routes/wallets');
const launchRoutes = require('./src/routes/launch');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({
    name: 'pons-launcher',
    dryRun: config.dryRun,
    chainId: config.chainId,
    factory: config.factoryAddress,
    explorer: config.explorerUrl,
    apiKeyRequired: Boolean(config.apiKey),
  });
});

app.use('/api', walletRoutes);
app.use('/api', launchRoutes);

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[pons-launcher] request error:', err.message);
  res.status(400).json({ error: err.shortMessage || err.message });
});

let server;

async function main() {
  if (!config.dryRun) config.assertLiveReady();

  // Factory deployments rotate — five are verified on this chain. Refuse to
  // start against a dead one rather than failing confusingly mid-launch.
  try {
    const info = await factory.validate();
    console.log(
      `[pons-launcher] factory ${config.factoryAddress} ok — launchFee ${info.launchFee} wei, ` +
        `${info.launchConfigs} launch configs, ${info.dexConfigs} dex configs`
    );
  } catch (err) {
    console.error(`[pons-launcher] FACTORY CHECK FAILED: ${err.message}`);
    if (!config.dryRun) throw err;
    console.error('[pons-launcher] continuing anyway because DRY_RUN=true');
  }

  server = app.listen(config.port, config.host, () => {
    console.log(`[pons-launcher] listening on http://${config.host}:${config.port}`);
    console.log(`[pons-launcher] dryRun=${config.dryRun} chainId=${config.chainId}`);
    if (config.dryRun) console.log('[pons-launcher] DRY_RUN — nothing will be broadcast');
    if (!config.apiKey) console.warn('[pons-launcher] WARNING: API_KEY is not set — mutating routes are open');
  });
}

function shutdown(signal) {
  console.log(`\n[pons-launcher] ${signal} received, shutting down`);
  if (server) server.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
  main().catch((err) => {
    console.error('[pons-launcher] failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = app;
