// The V1 paced funding loop — one disperser transaction per bundle wallet,
// 8–9 seconds apart, driven from the browser.
//
// Why the browser and not the server: each POST /fund is short, so nothing
// hits nginx's 180 s proxy_read_timeout (30 wallets × 9 s would); progress
// shows per wallet as it happens; and stopping is just not sending the next
// one. Nothing here can double-send: a wallet is posted exactly once or not
// at all.
//
// Pure: every side effect (the request, the wait, the report box, the Stop
// flag) is injected, so the loop is unit-tested without React or a network.

export const PACE_MIN_MS = 8000;
export const PACE_MAX_MS = 9000;

/** A uniform random integer in [min, max] milliseconds. */
export function pacedDelayMs(min = PACE_MIN_MS, max = PACE_MAX_MS, random = Math.random) {
  return min + Math.floor(random() * (max - min + 1));
}

function short(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : '?';
}

/**
 * @param {object} io
 * @param {Array<{walletId:string, amountEth:string|number}>} io.targets  in send order
 * @param {string[]} io.dispersers  the operator's configured disperser contracts
 * @param {(body:object) => Promise<Array>} io.post  performs POST /fund, resolves with the result rows
 * @param {(ms:number) => Promise<void>} io.wait  the pacing gap; may resolve early when stopped
 * @param {(text:string) => void} io.report  replaces the report box
 * @param {() => boolean} io.stopped  true once the operator pressed Stop
 * @returns {Promise<{funded:number, total:number, stopped:boolean, error:string|null}>}
 */
export async function runPacedFunding({ targets, dispersers, post, wait, report, stopped }) {
  const total = targets.length;
  const lines = [];
  const say = (line) => {
    lines.push(line);
    report(lines.join('\n'));
  };

  if (!dispersers || !dispersers.length) {
    const error = 'no disperser deployed — deploy one in step 2 first';
    say(`ERROR: ${error}`);
    return { funded: 0, total, stopped: false, error };
  }

  say(`sending ${total} wallet(s) 1 by 1 via disperser, ${PACE_MIN_MS / 1000}–${PACE_MAX_MS / 1000} s apart…`);

  let funded = 0;
  for (let i = 0; i < total; i++) {
    const target = targets[i];
    const disperser = dispersers[i % dispersers.length];
    let row;
    try {
      const rows = await post({ targets: [target], variant: 'v1', viaDisperser: true, disperser });
      row = Array.isArray(rows) ? rows[0] : null;
      if (!row) throw new Error('empty response from /fund');
      if (row.error) throw new Error(row.error);
    } catch (err) {
      const error = err?.message || String(err);
      say(`stopped at wallet ${i + 1}/${total}: ${error}`);
      say(
        `funded: ${funded} wallet(s); remaining: ${total - funded} — clear the funded rows' Fund amounts before re-sending`
      );
      return { funded, total, stopped: false, error };
    }

    funded++;
    say(
      row.simulated
        ? `simulated ${row.address} ${row.amountEth} ETH (dry run)`
        : `funded ${row.address} ${row.amountEth} ETH via ${short(row.disperser)} — ${row.hash}`
    );

    if (i < total - 1) {
      await wait(pacedDelayMs());
      if (stopped()) {
        say(`stopped by operator after ${funded}/${total} wallets`);
        return { funded, total, stopped: true, error: null };
      }
    }
  }

  say(`funded ${funded}/${total} wallets via disperser`);
  return { funded, total, stopped: false, error: null };
}
