import { ROLES } from './roles.js';

/**
 * The spreadsheet form of a V4 key export.
 *
 * It leads with PUBLIC ADDRESS and PRIVATE KEY, the two columns V2's XLSX export has, so
 * the files read the same across tabs. V4 then adds what its JSON file exists to carry: the
 * wallet's type and when it was funded. A seed's value is its age, counted from its own
 * funding transfer, and a sheet of keys without it is how an operator reaches for a wallet
 * funded yesterday believing it is a week old.
 *
 * Every cell is a string. The XLSX writer stores strings as text, so a key or an address
 * can never be reinterpreted as a number; a missing funding date is blank, never "null".
 * Pure — no DOM, no fetch — so `node --test` can check the column order.
 */
export const V4_XLSX_HEADER = ['Public address', 'Private key', 'Type', 'Funded at', 'Days since funded'];

const TYPE = { [ROLES.master]: 'funding', [ROLES.seed]: 'seed' };

export function v4XlsxRows(wallets) {
  return [
    V4_XLSX_HEADER,
    ...wallets.map((w) => [
      String(w.address ?? ''),
      String(w.privateKey ?? ''),
      TYPE[w.role] || String(w.role ?? ''),
      w.fundedAt ? String(w.fundedAt) : '',
      w.daysSinceFunded == null ? '' : String(w.daysSinceFunded),
    ]),
  ];
}
