import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { ROLES, eth } from './roles.js';

/**
 * Step 1 — the treasury.
 *
 * It does one thing: fund the main wallet, through Relay, in step 3. It never
 * buys, never sells, and never holds supply, so its address appears nowhere in
 * the trading history of the token — which is the reason it is a separate
 * wallet at all rather than the main wallet topping itself up.
 *
 * The keystore permits exactly one v3dev, so replacing this key after an
 * exposure means deleting the one that is there. That control lives beside the
 * wallet it deletes.
 */
export default function V3TreasuryPanel({ step, wallet, explorer, reload, report, locked }) {
  const [busy, setBusy] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [key, setKey] = useState('');
  const [deleting, setDeleting] = useState(false);

  async function act(what, fn) {
    setBusy(what);
    try {
      report(await fn());
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
        Funds the main wallet and nothing else. It never trades, so it never appears in the token's
        history.
      </p>

      {wallet ? (
        <div className="notice">
          <div className="row">
            <Address value={wallet.address} href={explorer ? `${explorer}/address/${wallet.address}` : ''} />
            <span className="spacer" />
            <b>{eth(wallet.balanceEth)} ETH</b>
            <button className="ghost danger" onClick={() => setDeleting(true)} disabled={locked}>
              delete
            </button>
          </div>
          {locked && <p className="hint">A run is in progress — wallets cannot be changed until it stops.</p>}
        </div>
      ) : (
        <div className="row">
          <Busy
            busy={busy === 'generate'}
            onClick={() =>
              act('generate', () =>
                api('/v3/wallets/generate', 'POST', { count: 1, role: ROLES.treasury, label: 'v3 treasury' })
              )
            }
          >
            Generate treasury wallet
          </Busy>
          <button className="ghost" onClick={() => setShowImport(true)}>
            import a key
          </button>
        </div>
      )}

      <Modal
        open={showImport}
        title="Import a treasury key"
        onCancel={() => setShowImport(false)}
        confirmLabel="Import"
        onConfirm={async () => {
          await act('import', () =>
            api('/v3/wallets/import', 'POST', {
              privateKeys: [key.trim()],
              role: ROLES.treasury,
              label: 'v3 treasury',
            })
          );
          setKey('');
          setShowImport(false);
        }}
      >
        <p>
          The key is encrypted into this account's keystore and never leaves the server. There can be
          only one treasury wallet — delete the existing one first if there is one.
        </p>
        <input
          type="password"
          placeholder="0x…"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </Modal>

      <Modal
        open={deleting}
        title="Delete the treasury wallet?"
        danger
        onCancel={() => setDeleting(false)}
        confirmLabel="Delete it"
        onConfirm={async () => {
          await act('delete', () => api(`/v3/wallets/${wallet.id}`, 'DELETE'));
          setDeleting(false);
        }}
      >
        <p>
          Its key is archived, not destroyed, so a balance left behind is recoverable — but move the
          ETH out first if there is any. Nothing in this console will send from it again.
        </p>
        {wallet && (
          <>
            <Fact label="Address" mono>
              {wallet.address}
            </Fact>
            <Fact label="Balance">{eth(wallet.balanceEth)} ETH</Fact>
          </>
        )}
      </Modal>
    </Step>
  );
}
