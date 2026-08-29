import { useState } from 'react';
import { api } from '../api.js';
import Step from '../components/Step.jsx';
import { Busy } from '../components/Section.jsx';
import Modal, { Fact } from '../components/Modal.jsx';

/**
 * Two end-of-run utilities that sit after the sweep, unnumbered — they are not
 * part of the six-step flow, they are things an operator sometimes reaches for
 * once a run is done.
 *
 * RETURN TOKEN TO MAIN is a DIRECT ERC-20 transfer from every bundle wallet to
 * the main wallet, and it links those wallets to main on-chain — the exact link
 * the Relay sweep is used to avoid. That is accepted by design (sometimes the
 * operator wants the whole position consolidated), but it is the one thing here
 * that cannot be undone once it is on the chain, so it takes a TYPED confirm
 * whose only job is to make the linkage impossible to click through by reflex.
 *
 * SELL MAIN'S TOKEN is the exit for a single wallet: it approves and sells the
 * main wallet's whole balance into the curve, floor-free — so it takes a
 * confirm, exactly as the exit does. The backend keeps the same ownership gate,
 * so a token a wallet of ours did not launch is refused there.
 */
export default function V3ReturnPanel({ step, token, setToken, report, reload, locked }) {
  const [busy, setBusy] = useState('');
  const [arming, setArming] = useState(null); // 'return' | 'sell' | null
  const [typed, setTyped] = useState('');

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

  const trimmed = token?.trim();

  return (
    <Step {...step}>
      <p className="lede">
        After a run: pull one token out of every bundle wallet into the main wallet, or sell the
        main wallet's own balance of a token back to ETH.
      </p>

      <div className="row">
        <input
          type="text"
          placeholder="token address"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ flex: 1, minWidth: 260 }}
        />
      </div>

      <div className="notice warn">
        <h3>Returning a token links your wallets on-chain</h3>
        <p>
          "Return token to main" is a direct transfer from every bundle wallet to the main wallet —
          not a Relay hop. Anyone reading the chain then sees those wallets funnelling into one
          address, the same link the sweep exists to avoid. It cannot be undone once it is on the
          chain. Use it only when you mean to consolidate the position in the main wallet.
        </p>
      </div>

      <div className="row">
        <Busy
          busy={busy === 'return'}
          disabled={locked || !trimmed}
          onClick={() => {
            setTyped('');
            setArming('return');
          }}
        >
          Return token to main
        </Busy>
        <Busy
          busy={busy === 'sell'}
          className="danger"
          disabled={locked || !trimmed}
          onClick={() => setArming('sell')}
        >
          Sell main's token
        </Busy>
        {locked && <span className="hint">A run is in progress — stop it first.</span>}
      </div>

      <Modal
        open={arming === 'return'}
        title="Return this token to main?"
        question={null}
        confirmLabel="Return it"
        confirmDisabled={typed !== 'LINK'}
        onCancel={() => setArming(null)}
        onConfirm={async () => {
          await act('return', () => api('/v3/tokens/return-to-main', 'POST', { token: trimmed }));
          setArming(null);
        }}
      >
        <p>
          Every bundle wallet transfers its whole balance of this token straight to the main wallet.
          This is a direct transfer, so it links those wallets to main on-chain, permanently. A
          wallet holding none, or too short of gas for the transfer, is skipped and named rather
          than left half-done.
        </p>
        <Fact label="Token" mono>
          {trimmed}
        </Fact>
        <label className="modal-type">
          Type LINK to accept the on-chain link.
          <input
            data-autofocus
            value={typed}
            autoComplete="off"
            spellCheck="false"
            onChange={(e) => setTyped(e.target.value)}
          />
        </label>
      </Modal>

      <Modal
        open={arming === 'sell'}
        danger
        title="Sell the main wallet's token?"
        question="Irreversible, and there is no slippage floor."
        confirmLabel="Sell it"
        onCancel={() => setArming(null)}
        onConfirm={async () => {
          await act('sell', () =>
            api('/v3/tokens/sell-main', 'POST', { token: trimmed, confirm: true })
          );
          setArming(null);
        }}
      >
        <p>
          The main wallet approves exactly its balance of this token and sells it into the curve at
          whatever price it gets. Same terms as the exit — no minimum out. A token a wallet of yours
          did not launch is refused.
        </p>
        <Fact label="Token" mono>
          {trimmed}
        </Fact>
        <Fact label="Minimum out">none — 0</Fact>
      </Modal>
    </Step>
  );
}
