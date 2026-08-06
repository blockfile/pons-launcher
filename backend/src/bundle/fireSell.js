'use strict';

// Broadcasting the exit.
//
//   warm the pool → read every wallet's ETH balance → blast approve+sell from
//   every wallet at once → collect receipts → work out what each one got
//
// Nothing is signed here. prepareSell already signed both transactions for
// every wallet, at consecutive nonces, so this file only puts them on the wire.
//
// ORDER: all at once, by decision. Every wallet broadcasts concurrently and the
// sequencer decides who lands first. The tail fills worse — that spread is
// accepted in exchange for the fastest possible exit, and it is measured and
// reported below rather than left to be inferred.
//
// Within a wallet the approval goes first and is awaited only as far as the
// broadcast, not the receipt: the sell sits at nonce n+1 and the sequencer runs
// a wallet's transactions in nonce order regardless. But if the approval will
// not even broadcast, its sell is NOT sent — a transaction at n+1 with nothing
// at n is queued behind a gap that will never fill, and it would sit in the
// mempool looking pending forever.
//
// ONE WALLET'S FAILURE NEVER ABORTS THE RUN. A wallet that fails keeps its
// tokens and the others are untouched. The per-wallet failures are the whole
// reason anyone opens the activity log afterwards.

const { formatEther, formatUnits } = require('ethers');
const config = require('../config');
const { provider, warmPool } = require('../evm/provider');
const { rpcMessage } = require('../evm/errors');
const { waitForReceipt } = require('../evm/receipt');

/** What a receipt cost its sender, so it can be added back to a balance delta. */
function spentOn(receipt) {
  if (!receipt) return 0n;
  const price = receipt.effectiveGasPrice ?? receipt.gasPrice ?? 0n;
  return BigInt(receipt.gasUsed ?? 0n) * BigInt(price);
}

function statusOf(receipt) {
  if (!receipt) return 'pending';
  return Number(receipt.status) === 1 ? 'confirmed' : 'reverted';
}

/**
 * @param {object} plan from prepareSell()
 * @param {object} [deps] injectable for tests
 */
async function fireSell(plan, deps = {}) {
  const rpc = deps.provider || provider;
  const dryRun = deps.dryRun ?? config.dryRun;
  // NOT tx.wait(): that polls at ethers' 4s default, which on a chain making
  // ten blocks a second reports a landed sell up to forty blocks late.
  const awaitReceipt = deps.waitForReceipt || waitForReceipt;
  const warm = deps.warmPool || warmPool;

  const decimals = Number(plan.decimals ?? 18);
  const zero = formatUnits(0n, decimals);

  if (dryRun) {
    return {
      simulated: true,
      action: 'sell',
      route: plan.route,
      token: plan.token,
      symbol: plan.symbol,
      curve: plan.curve,
      results: plan.wallets.map((w) => ({
        walletId: w.walletId,
        address: w.address,
        tokens: w.tokens,
        tokensSold: w.tokens,
        ethReceived: null,
        status: 'simulated',
        hashes: [],
        approve: { hash: null, status: 'simulated' },
        sell: { hash: null, status: 'simulated' },
      })),
      totals: {
        wallets: plan.wallets.length,
        sold: 0,
        failed: 0,
        tokensSold: zero,
        ethReceived: null,
      },
      totalEth: null,
      bestPrice: null,
      worstPrice: null,
      fill: null,
    };
  }

  const unsigned = plan.wallets.filter((w) => !w.approve?.raw || !w.sell?.raw);
  if (unsigned.length) {
    // Signing here would put key derivation back in the critical path, and a
    // half-signed plan is far more likely to be stale than to be worth rescuing.
    throw new Error(`${unsigned.length} wallet(s) are unsigned — re-run preflight`);
  }

  // Open the sockets before the clock matters. A cold TLS handshake in the
  // middle of the burst costs more than everything else here put together.
  await warm(plan.wallets.length * 2);

  // Native balances before anything moves. This is what makes "ETH received"
  // reportable at all: the curve's sell returns its output as a return value,
  // and a return value is not in a receipt. A balance delta with the gas added
  // back recovers it. Affordable here — unlike a launch bundle, a sell burst is
  // racing nobody, so one concurrent round trip before it costs nothing that
  // matters.
  //
  // Only meaningful for a native-quote launch. An ERC-20 pair pays out in that
  // token, and reporting an ETH number for it would be a lie, so it reports
  // null instead.
  const native = Boolean(plan.isNativeQuote);
  const before = new Map();
  if (native) {
    await Promise.all(
      plan.wallets.map(async (w) => {
        try {
          before.set(w.address, BigInt(await rpc.getBalance(w.address)));
        } catch (_err) {
          // A failed read costs this wallet its proceeds figure, nothing else.
        }
      })
    );
  }

  const t0 = Date.now();
  const results = await Promise.all(
    plan.wallets.map(async (w) => {
      const entry = {
        walletId: w.walletId,
        address: w.address,
        tokens: w.tokens,
        tokensRaw: w.tokensRaw,
        estEthOut: w.estEthOut ?? null,
        approve: { nonce: w.approve.nonce, hash: null, status: 'pending' },
        sell: { nonce: w.sell.nonce, hash: null, status: 'pending', minQuoteOut: '0' },
      };

      try {
        const resp = await rpc.broadcastTransaction(w.approve.raw);
        entry.approve.hash = resp.hash;
        entry.approve.status = 'sent';
      } catch (err) {
        entry.approve.status = 'failed';
        // Not sent: the sell is at n+1 and would queue behind a gap forever.
        entry.sell.status = 'skipped';
        entry.error = rpcMessage(err);
        return entry;
      }

      try {
        const resp = await rpc.broadcastTransaction(w.sell.raw);
        entry.sell.hash = resp.hash;
        entry.sell.status = 'sent';
      } catch (err) {
        entry.sell.status = 'failed';
        entry.error = rpcMessage(err);
      }
      return entry;
    })
  );
  const burstMs = Date.now() - t0;

  // Only now, with everything on the wire, do we wait for anything.
  await Promise.all(
    results.map(async (r) => {
      let spent = 0n;
      if (r.approve.hash) {
        const receipt = await awaitReceipt(rpc, r.approve.hash);
        r.approve.status = statusOf(receipt);
        spent += spentOn(receipt);
      }
      if (r.sell.hash) {
        const receipt = await awaitReceipt(rpc, r.sell.hash);
        r.sell.status = statusOf(receipt);
        r.sell.blockNumber = receipt?.blockNumber ?? null;
        spent += spentOn(receipt);
      }
      r._spent = spent;
    })
  );

  let totalTokens = 0n;
  let totalEth = 0n;
  let anyProceeds = false;

  for (const r of results) {
    const confirmed = r.sell.status === 'confirmed';
    // A wallet whose sell did not confirm still holds its tokens. Reporting
    // them as sold is exactly the kind of thing someone would only discover
    // later, from a balance that never went away.
    const soldRaw = confirmed ? BigInt(r.tokensRaw) : 0n;
    r.tokensSold = formatUnits(soldRaw, decimals);
    r.tokensSoldRaw = soldRaw.toString();
    totalTokens += soldRaw;

    let proceeds = null;
    if (native && confirmed && before.has(r.address)) {
      try {
        const after = BigInt(await rpc.getBalance(r.address));
        const delta = after - before.get(r.address) + r._spent;
        proceeds = delta > 0n ? delta : 0n;
      } catch (_err) {
        proceeds = null;
      }
    }

    if (proceeds === null) {
      r.ethReceived = null;
      r.ethReceivedRaw = null;
      r.priceEth = null;
    } else {
      anyProceeds = true;
      totalEth += proceeds;
      r.ethReceived = formatEther(proceeds);
      r.ethReceivedRaw = proceeds.toString();
      // Wei of quote per WHOLE token, so twenty wallets holding different
      // amounts are comparable. Integer arithmetic throughout — a float here
      // would make two near-identical fills sort at random.
      r.priceRaw = soldRaw > 0n ? ((proceeds * 10n ** BigInt(decimals)) / soldRaw).toString() : null;
      r.priceEth = r.priceRaw === null ? null : formatEther(r.priceRaw);
    }

    // One field the console can colour on, and one list of hashes to link.
    // Rolling these up here rather than in the route keeps the shape the
    // operator sees identical to the shape the activity log keeps.
    r.status = r.approve.status === 'failed' ? 'failed' : r.sell.status;
    r.hashes = [r.approve.hash, r.sell.hash].filter(Boolean);

    delete r._spent;
  }

  // Best and worst fill, because the spread is the expected cost of firing them
  // all at once and it should be visible rather than inferred.
  const priced = results.filter((r) => r.priceRaw != null);
  priced.sort((a, b) => (BigInt(b.priceRaw) > BigInt(a.priceRaw) ? 1 : -1));
  const summarise = (r) =>
    r && {
      walletId: r.walletId,
      address: r.address,
      priceEth: r.priceEth,
      ethReceived: r.ethReceived,
      tokensSold: r.tokensSold,
    };

  const sold = results.filter((r) => r.sell.status === 'confirmed').length;

  return {
    action: 'sell',
    route: plan.route,
    // Echoed so the result still makes sense after the sellable list refreshes
    // underneath it and this token is gone from it.
    token: plan.token,
    symbol: plan.symbol,
    curve: plan.curve,
    minQuoteOut: '0',
    results,
    skipped: plan.skipped || [],
    totals: {
      wallets: results.length,
      sold,
      failed: results.length - sold,
      tokensSold: formatUnits(totalTokens, decimals),
      tokensSoldRaw: totalTokens.toString(),
      ethReceived: anyProceeds ? formatEther(totalEth) : null,
      ethReceivedRaw: anyProceeds ? totalEth.toString() : null,
    },
    // Flat aliases for the console, which reads a result straight off the
    // response. Same numbers as `totals` and `fill`, one level up.
    totalEth: anyProceeds ? formatEther(totalEth) : null,
    bestPrice: priced.length ? priced[0].priceEth : null,
    worstPrice: priced.length ? priced[priced.length - 1].priceEth : null,
    fill: priced.length
      ? { best: summarise(priced[0]), worst: summarise(priced[priced.length - 1]) }
      : null,
    burstMs,
  };
}

module.exports = { fireSell };
