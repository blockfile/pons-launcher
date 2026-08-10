import { useState } from 'react';
import { api } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';

/**
 * Step 1 — the dev wallet.
 *
 * Its own step because everything else in this console is paid for out of it:
 * the disperser deploy, the funding run, the launch fee and the dev buy. It used
 * to be one button among six in the wallets panel, which is why a first-time
 * operator would generate twenty bundle wallets and then find nothing could pay
 * for them.
 *
 * Generating is the whole of the step. The dev wallet's row, its balance and its
 * share of the launch stay in the wallet table under step 3, where they can be
 * read against the bundle rows they are compared with — including its delete,
 * which keeps the one dialog that knows sweeping cannot rescue this wallet.
 */
export default function DevWalletPanel({ step, wallets, explorer, reload, report }) {
  const [busy, setBusy] = useState('');
  const dev = wallets.find((w) => w.role === 'dev');

  async function generate() {
    setBusy('dev');
    try {
      report(await api('/wallets/generate', 'POST', { count: 1, role: 'dev', label: 'dev' }));
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <Step {...step}>
      <p className="lede">
        The dev wallet signs the launch and makes the one buy no cap applies to. It also pays for
        everything else here — the disperser deploy, the funding run and the launch fee — so it is
        generated first and funded first.
      </p>

      <div className="row">
        <Busy
          busy={busy === 'dev'}
          className="ghost"
          disabled={Boolean(dev)}
          title={dev ? 'a dev wallet already exists' : ''}
          onClick={generate}
        >
          Generate dev wallet
        </Busy>

        {dev ? (
          <span className="hint">
            {explorer ? (
              <a href={`${explorer}/address/${dev.address}`} target="_blank" rel="noreferrer">
                {dev.address}
              </a>
            ) : (
              dev.address
            )}{' '}
            · {Number(dev.balanceEth).toFixed(6)} ETH
          </span>
        ) : (
          <span className="hint">one wallet, generated on the server and encrypted at rest</span>
        )}
      </div>

      {/* Nothing in this console can put ETH into the dev wallet — every other
          transfer here moves money out of it or back to it. An operator who
          does not know that reaches step 4 with an empty wallet and a failure
          that reads like a bug. */}
      {dev && Number(dev.balanceEth) === 0 && (
        <div className="notice warn">
          <h3>The dev wallet is empty</h3>
          <ul>
            <li>
              Send ETH to the address above from wherever you hold funds. Nothing in this console can
              fund it — every transfer here spends out of it.
            </li>
            <li>
              It needs enough for the launch fee, the dev buy, whatever the bundle wallets are funded
              with, and gas on top of all of it.
            </li>
          </ul>
        </div>
      )}
    </Step>
  );
}
