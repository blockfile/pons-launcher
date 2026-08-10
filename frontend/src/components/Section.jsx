// A panel that is not one of the six steps: the launch history, and anything
// else that records rather than acts. Numbered stations of the sequence use
// Step.jsx instead, which draws the spine and the state with them.
export default function Section({ title, children }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** A button that disables itself and shows it is working. */
export function Busy({ busy, children, ...rest }) {
  return (
    <button {...rest} disabled={busy || rest.disabled}>
      {busy ? 'working…' : children}
    </button>
  );
}
