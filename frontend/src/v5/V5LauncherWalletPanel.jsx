import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { LuTrash2 } from 'react-icons/lu';
import IconButton from '../v4/IconButton.jsx';
import { ROLES, eth } from './roles.js';

/**
 * Step 1 — the launcher wallet, its own step to mirror the pons v1 Launcher tab's
 * "Create dev wallet". The launcher (v5dev) is the SINGLETON that signs the
 * letscash launch and its atomic first buy, and it is the source the Fund step
 * spends when it Relay-funds the bundle wallets. So it comes first, on its own.
 *
 * Create a fresh one OR import a key you already hold (your funded dev wallet).
 * The key is encrypted straight into the keystore and never logged or shown again;
 * the field clears only on a successful import.
 */
export default function V5LauncherWalletPanel({ step, dev, explorer, reload, report }) {
  const [busy, setBusy] = useState('');
  const [devKey, setDevKey] = useState('');
  const [deleting, setDeleting] = useState(false);

  const explorerFor = (address) => (explorer ? `${explorer}/address/${address}` : '');

  async function importLauncher() {
    if (!devKey.trim()) return;
    setBusy('import-dev');
    try {
      const made = await api('/v5/wallets/import', 'POST', { privateKeys: devKey, role: ROLES.dev });
      report(`imported ${made.length === 1 ? 'the launcher' : `${made.length} wallet(s)`} `);
      setDevKey('');
      await reload();
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

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
        The launcher signs the letscash launch and takes the guaranteed first buy — and it is the
        wallet the Fund step spends to Relay-fund the bundle. It is a singleton: the backend keeps
        exactly one, so the whole run has a single payer. Create a fresh one, or import a key you
        already hold. Fund it from outside (nothing here can send ETH into it).
      </p>

      {!dev ? (
        <div className="notice">
          <h3>No launcher wallet yet</h3>
          <div className="row">
            <Busy
              busy={busy === 'gen-dev'}
              className="btn-primary"
              onClick={() =>
                act('gen-dev', () =>
                  api('/v5/wallets/generate', 'POST', { count: 1, role: ROLES.dev, label: 'v5 launcher' })
                )
              }
            >
              Create launcher wallet
            </Busy>
            <span className="hint">or import your own key →</span>
          </div>
          <div className="row" style={{ alignItems: 'flex-start', marginTop: 4 }}>
            <input
              value={devKey}
              onChange={(e) => setDevKey(e.target.value)}
              placeholder="0x… private key of an existing dev wallet"
              spellCheck={false}
              autoComplete="off"
              style={{ flex: 1 }}
            />
            <Busy busy={busy === 'import-dev'} disabled={!devKey.trim()} onClick={importLauncher}>
              Import launcher
            </Busy>
          </div>
          <p className="hint" style={{ margin: '6px 0 0' }}>
            The key is encrypted straight into the keystore and never logged or shown again — the field
            clears once the import succeeds.
          </p>
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Launcher address</th>
                <th className="num">Balance</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <Address value={dev.address} plain href={explorerFor(dev.address)} />
                </td>
                <td className="num">
                  {dev.balanceEth == null ? <span className="hint">unreadable</span> : eth(dev.balanceEth)}
                </td>
                <td className="num">
                  <IconButton icon={LuTrash2} danger label={`Delete launcher wallet ${dev.address}`} onClick={() => setDeleting(true)} />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {dev && Number(dev.balanceEth) === 0 && (
        <div className="notice warn" style={{ marginTop: 12 }}>
          <h3>The launcher is empty</h3>
          <p>
            Send ETH to the address above from wherever you hold funds — nothing in this console can put
            ETH into it. It needs enough for the launch fee, the first buy, gas, and the Relay deposits
            that fund the bundle wallets in step 3.
          </p>
        </div>
      )}

      <Modal
        open={deleting}
        danger
        title={`Delete the launcher wallet ${dev ? dev.address.slice(0, 10) : ''}…?`}
        question={
          dev && dev.balanceEth != null && Number(dev.balanceEth) > 0
            ? 'It still holds ETH. Deleting does not move it — the balance stays at the address, reachable only by restoring the key.'
            : 'Its key is archived on the server, not destroyed. Nothing in this console will sign with it again.'
        }
        confirmLabel="Delete it"
        onConfirm={() => {
          setDeleting(false);
          act('delete', () => api(`/wallets/${dev.walletId}`, 'DELETE'));
        }}
        onCancel={() => setDeleting(false)}
      >
        {dev && (
          <>
            <Fact label="Address" mono>
              {dev.address}
            </Fact>
            <Fact label="Balance">{dev.balanceEth == null ? 'unreadable' : `${eth(dev.balanceEth)} ETH`}</Fact>
          </>
        )}
      </Modal>
    </Step>
  );
}
