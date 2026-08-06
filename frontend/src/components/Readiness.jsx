// The one element that reads real state rather than describing it: what is
// actually true right now, and what to do about whatever is not. It replaces
// four separate "why is this button disabled?" moments.
export default function Readiness({ wallets, funded, logo, health, apiKey }) {
  const dev = wallets.find((w) => w.role === 'dev');
  const bundle = wallets.filter((w) => w.role === 'bundle');

  // "Entered" is only the question when there is something to enter. A
  // deployment that injects the key at nginx signs you in without one, and a
  // deployment with no key configured never wanted one — in both cases this
  // row is already satisfied, and telling the operator to paste something
  // would send them looking for a key that does not exist.
  const signedIn = Boolean(health?.user);
  const needsKey = Boolean(health?.apiKeyRequired);

  const items = [
    {
      // Nothing is known before health answers, and "satisfied" is the one
      // thing this row must not claim on no evidence.
      ok: Boolean(health) && (signedIn || !needsKey || Boolean(apiKey)),
      label: 'API key',
      done: signedIn
        ? `supplied by your login — ${health.user}`
        : needsKey
          ? 'the console can spend'
          : 'not required by this deployment',
      todo: health ? 'paste it in the top bar' : 'connecting…',
    },
    {
      ok: Boolean(dev),
      label: 'Dev wallet',
      done: dev ? `${dev.address.slice(0, 10)}… · ${Number(dev.balanceEth).toFixed(4)} ETH` : '',
      todo: 'generate one in step 1',
    },
    {
      ok: bundle.length > 0,
      label: `Bundle wallets — ${bundle.length}`,
      done: `${funded} funded`,
      todo: 'generate them in step 1',
    },
    {
      ok: Boolean(logo),
      label: 'Token logo',
      done: 'pinned to IPFS',
      todo: 'upload one in step 3',
    },
  ];

  return (
    <div className="checklist">
      {items.map((it) => (
        <div key={it.label} className={`check ${it.ok ? 'ok' : ''}`}>
          <i>{it.ok ? '✓' : '—'}</i>
          <div>
            <strong>{it.label}</strong>
            <span>{it.ok ? it.done : it.todo}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
