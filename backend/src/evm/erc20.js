'use strict';

const { Contract, Interface } = require('ethers');
const config = require('../config');
const { provider } = require('./provider');

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];

function erc20(address, signerOrProvider) {
  return new Contract(address, ERC20_ABI, signerOrProvider || provider);
}

const decimalsCache = new Map();

async function getDecimals(address) {
  const key = String(address).toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  const d = Number(await erc20(address).decimals());
  decimalsCache.set(key, d);
  return d;
}

function readTokenBalance(token, owner) {
  return erc20(token).balanceOf(owner);
}

// ── ONE TOKEN, MANY OWNERS, ONE REQUEST ────────────────────────────────────
//
// The wallet table's pair column asks the same question of up to 31 bundle
// wallets (plus the dev wallet, plus whatever else the keystore holds) every
// time the listing is read. One balanceOf per wallet is 31 sequential
// round-trips against a public RPC on a screen the operator refreshes between
// every funding step.
//
// Multicall3 is at its standard address on this chain — the same one
// evm/blocknumber.js, evm/v2/holdings.js and evm/v2/pairTokens.js already use.
// This lives HERE rather than as a fourth private copy of the pattern because
// it is the plain ERC-20 read that erc20.js already owns the single-owner
// version of; holdings.js and pairTokens.js batch heterogeneous calls of their
// own and keep their own assemblers.
//
// allowFailure is always true, so a token that reverts on balanceOf costs
// itself a field and never the whole listing.
const MULTICALL3_ABI = [
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
];
// Keeps one request from growing unbounded with the keystore. Same figure
// holdings.js chunks at.
const MULTICALL_CHUNK = 250;

const erc20Iface = new Interface(ERC20_ABI);

/**
 * `token.balanceOf(owner)` for every owner, batched.
 *
 * @param {string} token
 * @param {string[]} owners
 * @returns {Promise<Array<bigint|null>>} positional, one per owner. NULL — never
 *   0n — for a call that failed: an unread balance and an empty wallet are
 *   different facts, and a caller that renders "0" for the first would tell an
 *   operator a funded wallet is empty. A failure of the whole batch (no
 *   Multicall3, RPC down) returns all-null rather than throwing, so a listing
 *   that carries this as an extra column still answers.
 */
async function readTokenBalances(token, owners, deps = {}) {
  const list = Array.isArray(owners) ? owners : [];
  if (!list.length) return [];
  const rpc = deps.provider || provider;
  const mc = new Contract(deps.multicallAddress || config.multicallAddress, MULTICALL3_ABI, rpc);

  const out = new Array(list.length).fill(null);
  for (let i = 0; i < list.length; i += MULTICALL_CHUNK) {
    const slice = list.slice(i, i + MULTICALL_CHUNK);
    let res;
    try {
      res = await mc.aggregate3.staticCall(
        slice.map((owner) => ({
          target: token,
          allowFailure: true,
          callData: erc20Iface.encodeFunctionData('balanceOf', [owner]),
        }))
      );
    } catch (_err) {
      continue; // this chunk stays null; the rest may still answer
    }
    res.forEach((r, j) => {
      const success = r[0];
      const data = r[1];
      if (!success || !data || data === '0x') return;
      try {
        out[i + j] = BigInt(erc20Iface.decodeFunctionResult('balanceOf', data)[0]);
      } catch (_err) {
        // stays null
      }
    });
  }
  return out;
}

const symbolCache = new Map();

// Symbol is display-only, so a token that will not answer must never break a
// caller — it falls back to a short form of its own address rather than throwing.
async function getSymbol(address) {
  const key = String(address).toLowerCase();
  if (symbolCache.has(key)) return symbolCache.get(key);
  let sym;
  try {
    sym = String(await erc20(address).symbol());
  } catch (_err) {
    sym = `${key.slice(0, 6)}…${key.slice(-4)}`;
  }
  symbolCache.set(key, sym);
  return sym;
}

module.exports = { ERC20_ABI, erc20, getDecimals, getSymbol, readTokenBalance, readTokenBalances };
