// The dApp's first load has a 250 KB gzipped budget (spec, Testing;
// scripts/dapp-size.mjs). ethers' Wallet class alone costs ~35 KB of it: it carries
// the JSON keystore (scrypt, AES), the HD wallet and the mnemonic wordlist, none of
// which this page uses. The key modules sign and derive with SigningKey instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.js$/.test(e.name)) out.push(p);
  }
  return out;
}

test('no dApp source imports ethers Wallet, HDNodeWallet, Mnemonic or the JSON keystore', () => {
  const heavy = /\b(Wallet|HDNodeWallet|Mnemonic|encryptKeystoreJson|decryptKeystoreJson|wordlists)\b/;
  const importRe = /import\s*\{([^}]*)\}\s*from\s*['"]ethers['"]/g;
  const offenders = [];
  for (const file of sources(DAPP)) {
    const code = fs.readFileSync(file, 'utf8');
    for (const m of code.matchAll(importRe)) {
      if (heavy.test(m[1])) offenders.push(`${path.relative(DAPP, file)}: ${m[1].trim()}`);
    }
    if (/from\s*['"]ethers\/wallet['"]/.test(code)) offenders.push(`${path.relative(DAPP, file)}: ethers/wallet`);
  }
  assert.deepEqual(offenders, []);
});
