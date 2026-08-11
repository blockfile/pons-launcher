import { useState } from 'react';
import { api } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';
import Modal, { Fact } from './Modal.jsx';

// Balances arrive as decimal strings. Six places everywhere, so the line under
// the button and the figure in the dialog are the same number.
const eth = (v) => Number(v || 0).toFixed(6);

/**
 * Step 1 — the dev wallet.
 *
 * Its own step because everything else in this console is paid for out of it:
 * the disperser deploy, the funding run, the launch fee and the dev buy. It used
 * to be one button among six in the wallets panel, which is why a first-time
 * operator would generate twenty bundle wallets and then find nothing could pay
 * for them.
 *
 * Generating is the whole of the step, and deleting is the other half of that
 * one sentence: the keystore permits exactly ONE dev wallet — importing or
 * generating a second throws "a dev wallet already exists — delete it first" —
 * so replacing the dev key, after an exposure or a handover, is only possible by
 * deleting the one that is there. That control belongs where the wallet is, and
 * the wallet is here. It was reachable only from the row in step 3's table,
 * which is where an operator looks to SIZE a bundle, not to manage the wallet
 * this step created; the row's × is still there, and either opens a dialog that
 * says the same things.
 *
 * The dialog is dev-specific on purpose. "Sweep back to dev" is the answer for
 * every other wallet in this console and is no answer at all for this one —
 * sweep moves funds INTO it — so this dialog says the true thing instead, and
 * says it about the wallet that usually holds the most ETH of any.
 */
export default function DevWalletPanel({ step, wallets, explorer, reload, report }) {
  const [busy, setBusy] = useState('');
  // The wallet the confirmation is asking about, frozen at the moment it opened
  // so the figures on screen are the ones the delete runs on. Null means no
  // dialog is open, and no dialog open means nothing is deleted.
  const [deleting, setDeleting] = useState(null);
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

  async function remove(target) {
    setBusy('delete');
    try {
      report(await api(`/wallets/${target.id}`, 'DELETE'));
      // The key is already gone and the answer is already on screen; a refresh
      // that fails must not replace it with an error about the refresh.
      await reload().catch(() => {});
    } catch (err) {
      report(`ERROR: ${err.message}`);
    } finally {
      setBusy('');
    }
  }

  const bal = Number(deleting?.balanceEth || 0);

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
          disabled={Boolean(dev) || busy === 'delete'}
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
            · {eth(dev.balanceEth)} ETH
          </span>
        ) : (
          <span className="hint">one wallet, generated on the server and encrypted at rest</span>
        )}

        {/* Pushed to the far edge and left as a ghost: making the dev wallet is
            what this step is for, and removing it is the thing you do once, to
            replace a key. The vermilion is spent in the dialog, where the
            consequence is, and not on the trigger — the same way every other
            delete in this console is drawn. There is no checkbox here and no
            bulk path: this wallet is deleted one at a time, deliberately. */}
        {dev && (
          <>
            <span className="spacer" />
            <Busy
              busy={busy === 'delete'}
              className="ghost"
              disabled={busy === 'dev'}
              title="delete the dev wallet — erases its key"
              onClick={() => setDeleting(dev)}
            >
              Delete dev wallet
            </Busy>
          </>
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

      {/* Deleting erases the key, so it carries the vermilion: there is no undo
          and no second copy unless a backup was taken. */}
      <Modal
        open={Boolean(deleting)}
        danger
        title="Delete the dev wallet?"
        question={null}
        confirmLabel="Delete dev wallet"
        onConfirm={() => {
          const target = deleting;
          setDeleting(null);
          if (target) remove(target);
        }}
        onCancel={() => setDeleting(null)}
      >
        <div className="modal-facts">
          <Fact label="Address" mono>
            {deleting?.address}
          </Fact>
          <Fact label="Role">dev</Fact>
          <Fact label="Balance">{eth(deleting?.balanceEth)} ETH</Fact>
        </div>

        <p>
          Its private key is destroyed — erased from the keystore, which holds raw keys and no
          mnemonic, so nothing here can regenerate it. Afterwards this wallet is recoverable only
          from a backup already downloaded.
        </p>

        {/* The balance is the part that is not merely inconvenient, and on this
            wallet it is usually the largest in the console: a key that no longer
            exists is a wallet nobody can ever spend from, so whatever sits in it
            is burned. Sweep is what the dialog would name for any other wallet
            and it is the one thing that cannot help here — it pulls funds INTO
            the dev wallet — so this says where the ETH actually has to go. */}
        {bal > 0 && (
          <div className="notice danger">
            <h3>This wallet holds ETH</h3>
            <ul>
              <li>
                <b className="crux">{eth(deleting?.balanceEth)} ETH</b> goes with the key and is{' '}
                <b className="crux">burned permanently</b>.
              </li>
              <li>
                Sweep does not rescue it: it moves funds INTO this wallet, not out. Cancel, send the
                balance to an address you control, then delete.
              </li>
            </ul>
          </div>
        )}

        {/* The wallet list carries a native balance and nothing else, so this
            dialog can only ever speak for ETH — and step 6 is no fallback here
            the way it is for a bundle wallet: it sells what the BUNDLE wallets
            hold and never touches this one. */}
        <p className="hint">
          The console tracks the native balance only, so no token is counted above. Step 6 sells what
          the bundle wallets hold and never touches this one — a launched token sitting here has to
          be moved out the same way as the ETH.
        </p>
      </Modal>
    </Step>
  );
}
