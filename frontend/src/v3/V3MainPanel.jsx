import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';
import Address from '../components/Address.jsx';
import { ROLES, eth } from './roles.js';

/**
 * Step 3 — the main wallet.
 *
 * This is the wallet the strategy is about. It makes the one big buy, holds the
 * position, and sells a slice at the top of every cycle to pay for the next
 * wallet's buy. It is deliberately not the treasury and deliberately not the
 * deployer: on chain it should read as a whale who bought early and is taking
 * profit, and neither of those two could.
 *
 * It is funded THROUGH RELAY, not by a direct send. A plain transfer from the
 * treasury would draw exactly the edge this whole strategy exists to avoid —
 * the first person to look would find the funder, and the funder funds
 * everything else too.
 */
export default function V3MainPanel({ step, wallet, treasury, explorer, reload, report, locked }) {
  const [busy, setBusy] = useState('');
  const [amount, setAmount] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [key, setKey] = useState('');
  const [funding, setFunding] = useState(false);
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

  const canFund = Boolean(treasury && wallet && Number(amount) > 0);

  return (
    <Step {...step}>
      <p className="lede">
        Buys big, holds the position, and sells a slice each cycle to pay for the next wallet. Funded
        from the treasury through Relay, so no transfer connects the two.
      </p>

      {wallet ? (
        <>
          <div className="notice">
            <div className="row">
              <Address
                value={wallet.address}
                href={explorer ? `${explorer}/address/${wallet.address}` : ''}
              />
              <span className="spacer" />
              <b>{eth(wallet.balanceEth)} ETH</b>
              <button className="ghost danger" onClick={() => setDeleting(true)} disabled={locked}>
                delete
              </button>
            </div>
          </div>

          <div className="row">
            <input
              type="text"
              inputMode="decimal"
              placeholder="amount in ETH"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{ width: 170 }}
            />
            <Busy busy={busy === 'fund'} disabled={!canFund || locked} onClick={() => setFunding(true)}>
              Fund through Relay
            </Busy>
            {!treasury && <span className="hint">No treasury wallet yet — step 1 creates it.</span>}
          </div>
        </>
      ) : (
        <div className="row">
          <Busy
            className="btn-primary"
            busy={busy === 'generate'}
            onClick={() =>
              act('generate', () =>
                api('/v3/wallets/generate', 'POST', { count: 1, role: ROLES.main, label: 'v3 main' })
              )
            }
          >
            Generate main wallet
          </Busy>
          <button className="ghost" onClick={() => setShowImport(true)}>
            import a key
          </button>
        </div>
      )}

      <Modal
        open={funding}
        title="Fund the main wallet through Relay"
        onCancel={() => setFunding(false)}
        confirmLabel="Send it"
        onConfirm={async () => {
          await act('fund', () => api('/v3/fund', 'POST', { amountEth: amount.trim() }));
          setAmount('');
          setFunding(false);
        }}
      >
        <p>
          The treasury pays a Relay deposit address; a solver — not the treasury — pays the main
          wallet. The two transactions share no counterparty, which is the point. The fill takes a
          few seconds and the amount below is what ARRIVES; the treasury pays slightly more.
        </p>
        <Fact label="Amount arriving">{amount || '0'} ETH</Fact>
        {treasury && (
          <Fact label="From" mono>
            {treasury.address}
          </Fact>
        )}
        {wallet && (
          <Fact label="To" mono>
            {wallet.address}
          </Fact>
        )}
      </Modal>

      <Modal
        open={showImport}
        title="Import a main key"
        onCancel={() => setShowImport(false)}
        confirmLabel="Import"
        onConfirm={async () => {
          await act('import', () =>
            api('/v3/wallets/import', 'POST', {
              privateKeys: [key.trim()],
              role: ROLES.main,
              label: 'v3 main',
            })
          );
          setKey('');
          setShowImport(false);
        }}
      >
        <p>
          There can be only one main wallet: the chain sells from one position, and a second would
          leave half the supply somewhere the run never looks.
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
        title="Delete the main wallet?"
        danger
        onCancel={() => setDeleting(false)}
        confirmLabel="Delete it"
        onConfirm={async () => {
          await act('delete', () => api(`/v3/wallets/${wallet.id}`, 'DELETE'));
          setDeleting(false);
        }}
      >
        <p>
          This wallet holds the position. If a run has happened, sell it out in step 5 before
          deleting — the key is archived rather than destroyed, but nothing here will trade from it
          again.
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
