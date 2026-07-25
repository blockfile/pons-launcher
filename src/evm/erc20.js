'use strict';

const { Contract } = require('ethers');
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

module.exports = { ERC20_ABI, erc20, getDecimals, readTokenBalance };
