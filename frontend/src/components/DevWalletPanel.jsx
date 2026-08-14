import { useState } from 'react';
import { api } from '../api.js';
import Step from './Step.jsx';
import { Busy } from './Section.jsx';
import Modal, { Fact } from './Modal.jsx';
import BackupControls from './BackupControls.jsx';
import Address from './Address.jsx';

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
 * IMPORTING a dev key is the other half of the same rotation, and for the same
 * reason it is here rather than in step 3. An operator replacing an exposed key
 * deletes it in this step; the replacement used to be imported from a panel
 * titled "Generate bundle wallets", through a role dropdown, which is a long
 * way to walk to finish one sentence. Step 3's import is for bundle keys and
 * takes no role at all now.
 *
 * The dialog is dev-specific on purpose. "Sweep back to dev" is the answer for
 * every other wallet in this console and is no answer at all for this one —
 * sweep moves funds INTO it — so this dialog says the true thing instead, and
 * says it about the wallet that usually holds the most ETH of any.
 */
export default function DevWalletPanel({ step, wallets, explorer, reload, report }) {
  const [busy, setBusy] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [key, setKey] = useState('');
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

  async function importKey() {
    setBusy('import');
    try {
      report(
        await api('/wallets/import', 'POST', {
          privateKeys: [key.trim()],
          role: 'dev',
          label: 'dev',
        })
      );
      setKey('');
      setShowImport(false);
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
      // The wallet is already out of the keystore and the answer is already on
      // screen; a refresh that fails must not replace it with an error about
      // the refresh.
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

        {/* The other way to end up with a dev wallet, and the one a rotation
            uses: the replacement for a key that has been exposed comes from
            outside this console. Disabled on the same condition as generating,
            for the same reason — the keystore permits exactly one, and either
            button would be answered with "delete it first". */}
        <button
          className="ghost"
          disabled={Boolean(dev) || busy === 'delete'}
          title={dev ? 'a dev wallet already exists' : 'import an existing dev key'}
          onClick={() => setShowImport((v) => !v)}
        >
          Import dev key
        </button>

        {dev ? (
          <span className="hint">
            {/* Full length, and with a copy button: this is the one address in
                the console that has to leave it. Nothing here can fund the dev
                wallet — every transfer spends OUT of it — so the operator reads
                this address and pastes it into an exchange, and a 42-character
                hex string retyped by hand is how funds go to a stranger. */}
            <Address
              value={dev.address}
              full
              href={explorer ? `${explorer}/address/${dev.address}` : undefined}
            />{' '}
            · {eth(dev.balanceEth)} ETH
          </span>
        ) : (
          <span className="hint">one wallet, generated on the server and encrypted at rest</span>
        )}

      </div>

      {/* One key, not a list. The keystore permits exactly one dev wallet, and
          a textarea inviting several would be offering something that throws on
          the second line. Masked like the API key field above it: a private key
          is the more dangerous of the two to leave legible on a shared screen. */}
      {showImport && !dev && (
        <div className="row">
          <input
            type="password"
            className="key-field"
            placeholder="dev wallet private key"
            autoComplete="off"
            spellCheck="false"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <Busy busy={busy === 'import'} disabled={!key.trim()} onClick={importKey}>
            Import
          </Busy>
          <span className="hint">it becomes the launch signer and the funding source</span>
        </div>
      )}

      {/* Backing up and deleting, on one row and in that order. Both delete
          dialogs in this console name a backup as the thing that makes the
          delete survivable, and until now the control that takes one lived two
          steps away, beside the bundle wallets. The file is the whole keystore
          either way — the dialog counts what is in it.

          Delete is pushed to the far edge and left as a ghost: making the dev
          wallet is what this step is for, and removing it is the thing you do
          once, to replace a key. The vermilion is spent in the dialog, where the
          consequence is, and not on the trigger — the same way every other
          delete in this console is drawn. There is no checkbox here and no bulk
          path: this wallet is deleted one at a time, deliberately. */}
      {dev && (
        <div className="row">
          <BackupControls wallets={wallets} report={report} />
          <span className="spacer" />
          <Busy
            busy={busy === 'delete'}
            className="ghost"
            disabled={busy === 'dev' || busy === 'import'}
            title="delete the dev wallet — moves its key to the archive"
            onClick={() => setDeleting(dev)}
          >
            Delete dev wallet
          </Busy>
        </div>
      )}

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

      {/* Still vermilion, though the key survives in the archive. What this
          dialog warns about has not changed: the wallet every other step spends
          out of leaves the console, and whatever ETH is in it is beyond reach
          until somebody deliberately puts it back. "A second click could undo
          it" is the test for dropping the colour, and the way back is now a
          shell command on the server — the opposite of a second click. */}
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

        {/* Said plainly, because the alternative is a surprise in the wrong
            direction: an operator deleting an exposed key expects it gone, and
            it is not. It is archived — encrypted exactly as the keystore is,
            under the same passphrase.

            The archive is not on this console and not on the API at all, so
            this dialog cannot offer the way back; it names it instead. Pointing
            at an affordance that is not there would be worse than saying
            nothing. The cap is stated for the same reason the archiving is: the
            operator is owed the true version of what a delete does, and at 100
            deletions the oldest key is destroyed to make room for this one. */}
        <p>
          The key is <b>archived, not destroyed</b>. This wallet leaves the keystore and its key
          moves to an archive beside it, encrypted the same way under the same passphrase. Nothing
          in this console can reach it: restoring is{' '}
          <code>npm run archive:restore</code> on the server, and{' '}
          <code>npm run archive:purge</code> there is what erases a key for good.
        </p>
        <p className="hint">
          The archive keeps the last 100 deletions per user. Past that, each delete destroys the
          oldest archived key — the activity log records it by address.
        </p>

        {/* The balance is the part that is not merely inconvenient, and on this
            wallet it is usually the largest in the console. It is no longer
            burned by the delete itself — the key survives — but nothing in this
            console can sign for an archived wallet, so it is out of reach until
            somebody puts it back. Sweep is what the dialog would name for any
            other wallet and it is the one thing that cannot help here — it pulls
            funds INTO the dev wallet — so this says where the ETH has to go. */}
        {bal > 0 && (
          <div className="notice danger">
            <h3>This wallet holds ETH</h3>
            <ul>
              <li>
                <b className="crux">{eth(deleting?.balanceEth)} ETH</b> becomes{' '}
                <b className="crux">unspendable</b> the moment this wallet is archived, and stays
                that way until it is restored from the server. Purging the archived key there
                burns it permanently.
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
