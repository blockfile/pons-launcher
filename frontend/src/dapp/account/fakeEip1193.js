/**
 * TEST HELPER — nothing in the page imports it, so it never reaches the bundle.
 *
 * An EIP-1193 provider backed by a THROWAWAY wallet the test creates with
 * ethers Wallet.createRandom() (never a real key). It answers
 * eth_requestAccounts / eth_accounts, eth_chainId and personal_sign (hex UTF-8
 * message, address), and supports on/removeListener plus emit() for tests.
 *
 * hedged: true signs with fresh randomness every time (noble secp256k1 with
 * extraEntropy — the library ethers itself pins), so every signature is valid
 * but no two are equal: the wallet the first-unlock double signature must catch.
 * highS / v01: the same signature re-spelled the way some wallets answer.
 * rejectNext(method, error): the next call of that method throws `error`.
 */
import { getBytes, hashMessage, hexlify } from 'ethers';
import { secp256k1 } from '@noble/curves/secp256k1';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const hex32 = (n) => n.toString(16).padStart(64, '0');

export function rpcError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * @param {{address: string, privateKey: string, signMessage(bytes: Uint8Array): Promise<string>}} wallet
 * @param {{hedged?: boolean, highS?: boolean, v01?: boolean, chainId?: number}} [opts]
 */
export function fakeEip1193(wallet, { hedged = false, highS = false, v01 = false, chainId = 1 } = {}) {
  let current = wallet;
  let accounts = [wallet.address];
  const listeners = new Map();
  const calls = [];
  const rejects = new Map();

  function respell(sigHex) {
    const b = getBytes(sigHex);
    let s = BigInt(hexlify(b.slice(32, 64)));
    let v = b[64] >= 27 ? b[64] - 27 : b[64];
    if (highS) {
      s = N - s;
      v ^= 1;
    }
    const vByte = v01 ? v : 27 + v;
    return `${hexlify(b.slice(0, 32))}${hex32(s)}${vByte.toString(16).padStart(2, '0')}`;
  }

  async function sign(bytes) {
    if (!hedged) return current.signMessage(bytes);
    const sig = secp256k1.sign(getBytes(hashMessage(bytes)), getBytes(current.privateKey), { lowS: true, extraEntropy: true });
    return `0x${hex32(sig.r)}${hex32(sig.s)}${(27 + sig.recovery).toString(16)}`;
  }

  const provider = {
    calls,
    async request({ method, params }) {
      calls.push({ method, params });
      if (rejects.has(method)) {
        const e = rejects.get(method);
        rejects.delete(method);
        throw e;
      }
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [...accounts];
      if (method === 'eth_chainId') return `0x${chainId.toString(16)}`;
      if (method === 'personal_sign') {
        const [data, from] = params;
        if (!accounts.length || String(from).toLowerCase() !== accounts[0].toLowerCase()) throw rpcError(4100, 'unauthorized');
        return respell(await sign(getBytes(data)));
      }
      throw rpcError(4200, `unsupported method ${method}`);
    },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeListener(name, fn) {
      if (listeners.has(name)) listeners.get(name).delete(fn);
    },
    emit(name, ...args) {
      for (const fn of [...(listeners.get(name) || [])]) fn(...args);
    },
    listenerCount(name) {
      return listeners.has(name) ? listeners.get(name).size : 0;
    },
    /** The wallet moves to another throwaway account and says so. */
    switchTo(other) {
      current = other;
      accounts = [other.address];
      provider.emit('accountsChanged', [other.address.toLowerCase()]);
    },
    rejectNext(method, error) {
      rejects.set(method, error);
    },
    signCount: () => calls.filter((c) => c.method === 'personal_sign').length,
  };
  return provider;
}
