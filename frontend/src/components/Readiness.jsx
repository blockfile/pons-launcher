// The one element that reads real state rather than describing it: what is
// actually true right now, and what to do about whatever is not. It replaces
// four separate "why is this button disabled?" moments.
export default function Readiness({ wallets, funded, logo, apiKey }) {
  const dev = wallets.find((w) => w.role === 'dev');
  const bundle = wallets.filter((w) => w.role === 'bundle');

  const items = [
    {
      ok: Boolean(apiKey),
      label: 'API key entered',
      done: 'the console can spend',
      todo: 'paste it in the top bar',
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
