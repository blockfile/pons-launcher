'use strict';

// The EVM's block.number is NOT the RPC block number on this chain.
//
// Robinhood Chain produces a block roughly every 100ms, but `block.number` as
// seen from inside a contract advances about every 16 seconds — it is derived
// from the parent chain. Every launch restriction is written against that
// number, so anything that reasons about the restriction window has to read it
// rather than the RPC's own height:
//
//   restrictionBlocks = 2   →  ~32 seconds, not ~200 milliseconds
//
// Multicall3 is deployed at the standard address on this chain and exposes
// getBlockNumber(), which is the cheapest way to ask a contract what block it
// thinks it is in.

const config = require('../config');
const { provider } = require('./provider');

// getBlockNumber() on Multicall3.
const GET_BLOCK_NUMBER = '0x42cbb15c';

/**
 * The block number a contract executing right now would see.
 * @returns {Promise<bigint>}
 */
async function evmBlockNumber(rpc = provider) {
  const hex = await rpc.call({ to: config.multicallAddress, data: GET_BLOCK_NUMBER });
  if (!hex || hex === '0x') {
    throw new Error(`multicall at ${config.multicallAddress} returned nothing — wrong address?`);
  }
  return BigInt(hex);
}

module.exports = { evmBlockNumber, GET_BLOCK_NUMBER };
