/**
 * The two things this page ever asks a connected wallet (EIP-1193): which
 * account it is on, and a personal_sign. Never a chain switch or an added
 * chain (personal_sign is not chain-bound), never a transaction: selling signs
 * with the imported keys, not with this wallet.
 *
 * The message always goes as hex-encoded UTF-8 (what MetaMask and Rabby expect).
 * Wallet errors are mapped to fixed, readable text by their EIP-1193 code; a
 * wallet's own message is only ever shown as React text.
 */
import { getAddress, hexlify, toUtf8Bytes } from 'ethers';

function fail(message, code) {
  return new Error(message, { cause: { code } });
}

/** An EIP-1193 rejection -> Error with cause.code 'cancelled' | 'pending' | 'unauthorized' | 'unsupported' | 'disconnected' | 'wallet_error'. */
export function walletError(e) {
  const code = e && typeof e === 'object' ? (e.code ?? (e.cause && e.cause.code) ?? (e.error && e.error.code)) : undefined;
  if (code === 4001 || code === 'ACTION_REJECTED') return fail('You cancelled the request in your wallet.', 'cancelled');
  if (code === -32002) return fail('Open your wallet: a request from this page is already waiting there.', 'pending');
  if (code === 4100) return fail('The wallet has not authorised this page. Connect again.', 'unauthorized');
  if (code === 4200) return fail('This wallet does not support signing messages.', 'unsupported');
  if (code === 4900 || code === 4901) return fail('The wallet is disconnected.', 'disconnected');
  const raw = e && typeof e === 'object' && typeof e.message === 'string' ? e.message : '';
  const line = raw.split(String.fromCharCode(10))[0].slice(0, 120);
  return fail(line ? `The wallet refused: ${line}` : 'The wallet refused the request.', 'wallet_error');
}

/**
 * eth_requestAccounts: opens the wallet's connect prompt when needed.
 * @returns {Promise<string>} the checksummed first account
 */
export async function requestAccount(provider) {
  let accounts;
  try {
    accounts = await provider.request({ method: 'eth_requestAccounts' });
  } catch (e) {
    throw walletError(e);
  }
  if (!Array.isArray(accounts) || !accounts.length) throw fail('The wallet shared no account.', 'no_account');
  try {
    return getAddress(String(accounts[0]));
  } catch {
    throw fail('The wallet answered with an account that is not an address.', 'no_account');
  }
}

/**
 * personal_sign(hex(utf8(message)), address).
 * @returns {Promise<string>} the signature as the wallet returned it
 */
export async function personalSign(provider, message, address) {
  let sig;
  try {
    sig = await provider.request({ method: 'personal_sign', params: [hexlify(toUtf8Bytes(message)), address] });
  } catch (e) {
    throw walletError(e);
  }
  if (typeof sig !== 'string') throw fail('The wallet returned something that is not a signature.', 'bad_signature');
  return sig;
}
