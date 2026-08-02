'use strict';

// Buying from a v2 bonding curve.
//
// Unlike v1 there is no router and no pool at launch: each launch owns a curve
// that holds the entire supply and always quotes both sides. Price rises as
// the curve sells, so the first buyer after a launch gets the bottom — which is
// the whole reason a bundle still matters in v2 even though the dev buy is gone.

const { Contract, getAddress } = require('ethers');
const { provider } = require('../provider');
const { CURVE_V2_ABI } = require('./abi');

function curve(address, runner = provider) {
  return new Contract(getAddress(address), CURVE_V2_ABI, runner);
}

/**
 * An unsigned buy against a launch's curve.
 *
 * minTokensOut is 0 by default for the same reason v1's amountOutMinimum was:
 * these fire immediately behind a launch, and the curve's opening price is
 * fixed by the config rather than discovered, so there is no market to be
 * slipped against. Pass a real value once you are quoting a live curve.
 *
 * @param {boolean} nativeQuote true when the launch is priced in the chain's
 *   native coin — then quoteIn is also sent as value. ERC-20 pairs must have
 *   approved the curve first.
 */
async function buildBuyTx({ curveAddress, amountIn, recipient, minTokensOut = 0n, nativeQuote = true }) {
  const c = curve(curveAddress);
  return c.buy.populateTransaction(amountIn, minTokensOut, getAddress(recipient), {
    value: nativeQuote ? amountIn : 0n,
  });
}

/**
 * What a curve looks like right now. Everything needed to size a buy and to
 * know whether it is still worth making.
 */
async function readCurve(curveAddress) {
  const c = curve(curveAddress);
  const [native, token, pair, reserves, sellable, threshold, ready, graduated, feeBps, taxBps] =
    await Promise.all([
      c.isNativeQuote(),
      c.token(),
      c.pairToken(),
      c.getReserves(),
      c.sellableTokens(),
      c.graduationThreshold(),
      c.readyToGraduate(),
      c.graduated(),
      c.feeBps(),
      c.creatorTaxBps(),
    ]);

  return {
    address: getAddress(curveAddress),
    isNativeQuote: native,
    token: getAddress(token),
    pairToken: getAddress(pair),
    quoteReserve: reserves[0].toString(),
    tokenReserve: reserves[1].toString(),
    sellableTokens: sellable.toString(),
    graduationThreshold: threshold.toString(),
    readyToGraduate: ready,
    graduated,
    feeBps: Number(feeBps),
    creatorTaxBps: Number(taxBps),
  };
}

/**
 * Tokens a buy would receive, quoted against the live curve by simulating the
 * call. Unlike v1's tick arithmetic this is the curve's own maths, so it
 * accounts for fees and price impact exactly — no estimate, no drift.
 *
 * Returns null when the call reverts (curve graduated, amount too large for a
 * non-native pair without approval, etc.) rather than throwing, so a quote can
 * never break a preflight.
 */
async function quoteBuy({ curveAddress, amountIn, from, nativeQuote = true }) {
  try {
    const out = await curve(curveAddress).buy.staticCall(amountIn, 0n, from, {
      from,
      value: nativeQuote ? amountIn : 0n,
    });
    return out;
  } catch (_err) {
    return null;
  }
}

module.exports = { curve, buildBuyTx, readCurve, quoteBuy };
