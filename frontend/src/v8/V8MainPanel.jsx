import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import V8BackupControls from './V8BackupControls.jsx';
import { ROLES, eth } from './roles.js';

/**
 * Step 1 — the source wallet.
 *
 * ONE WALLET, and everything this tab sends comes out of it. There is no
 * treasury behind it and no launcher beside it: V8 does not launch, buy or
 * sell, so the source is simply the wallet holding the ETH that is about to be
 * spread around.
 *
 * NOTHING IN THIS CONSOLE CAN FUND IT. The ETH arrives from outside — an
 * exchange, another tab, a wallet the operator holds — which is why the address
 * is drawn in FULL here rather than shortened. This is an address that gets
 * read off the screen and pasted into a withdrawal form, and a shortened
 * address is exactly the check a poisoned lookalike is mined to pass (see
 * Address.jsx). The copy button beside it puts the whole string on the
 * clipboard.
 *
 * NO SPENDING CONTROL LIVES HERE, so no control here is amber. The money moves
 * in step 3, and the only amber object in this panel is the warning that says
 * the wallet is empty — which is the one thing an operator standing on step 1
 * has to act on.
 */
export default function V8MainPanel({ step, wallet, explorer, reload, report, locked, backupCount }) {
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

  const empty = Boolean(wallet) && Number(wallet.balanceEth || 0) === 0;

  return (
    <Step {...step}>
      <p className="lede">
        The one wallet the ETH leaves from. Fund it from outside this console — an exchange
        withdrawal, or a wallet you already hold — then step 3 pays every destination out of it
        through Relay. Nothing here launches, buys or sells.
      </p>

      {wallet ? (
        <>
          <div className="notice">
            <h3>Send ETH to this address</h3>
            <div className="row">
              {/* FULL, not shortened: this is an address that gets pasted into a
                  withdrawal, and the copy button is the point of it. */}
              <Address
                value={wallet.address}
                full
                href={explorer ? `${explorer}/address/${wallet.address}` : ''}
              />
              <span className="spacer" />
              <b>{eth(wallet.balanceEth)} ETH</b>
            </div>
          </div>

          <div className="row">
            <V8BackupControls count={backupCount} report={report} />
            <V8BackupControls
              count={1}
              report={report}
              role={ROLES.main}
              roleLabel="source"
              label="Export source key"
            />
            <span className="spacer" />
            <button className="ghost danger" onClick={() => setDeleting(true)} disabled={locked}>
              delete
            </button>
            {locked && <span className="hint">A timed run is going — stop it first.</span>}
          </div>

          {empty && (
            <div className="notice warn">
              <h3>The source wallet is empty</h3>
              <p>
                <span className="crux">
                  Nothing in this console can fund it — the ETH has to arrive from outside.
                </span>{' '}
                Send to the address above, then set the per-wallet amounts in step 3. It pays every
                Relay deposit, the Relay fee on each one, and the gas.
              </p>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="row">
            <Busy
              className="btn-primary"
              busy={busy === 'generate'}
              disabled={locked}
              onClick={() =>
                act('generate', () =>
                  api('/v8/wallets/generate', 'POST', {
                    count: 1,
                    role: ROLES.main,
                    label: 'v8 source',
                  })
                )
              }
            >
              Generate source wallet
            </Busy>
            <button className="ghost" onClick={() => setShowImport(true)} disabled={locked}>
              import a key
            </button>
          </div>
          <p className="hint" style={{ margin: '8px 0 0' }}>
            Generating makes a fresh key on the server; importing takes one you already hold — a
            wallet that already has ETH in it, say. Either way, back it up before you send anything
            to it.
          </p>
        </>
      )}

      <Modal
        open={showImport}
        title="Import the source key"
        onCancel={() => setShowImport(false)}
        confirmLabel="Import"
        onConfirm={async () => {
          await act('import', () =>
            api('/v8/wallets/import', 'POST', {
              privateKeys: [key.trim()],
              role: ROLES.main,
              label: 'v8 source',
            })
          );
          setKey('');
          setShowImport(false);
        }}
      >
        <p>
          There can be only one source wallet: every transfer and every sweep on this tab is defined
          against it, and a second would leave ETH somewhere the run never looks. The key is
          encrypted into this account's keystore and never leaves the server.
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
        title="Delete the source wallet?"
        danger
        onCancel={() => setDeleting(false)}
        confirmLabel="Delete it"
        onConfirm={async () => {
          await act('delete', () => api(`/v8/wallets/${wallet.id}`, 'DELETE'));
          setDeleting(false);
        }}
      >
        <p>
          Its key is archived on the server, not destroyed — but nothing in this console will send
          from it again, and the sweep in step 4 has nowhere to send to without it. If it still
          holds ETH, move that out first: deleting does not.
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
