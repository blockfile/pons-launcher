export default function Section({ step, title, done, children }) {
  return (
    <section>
      <h2 className={done ? 'done' : ''}>
        {step != null && <span className="step">{step}</span>}
        {title}
      </h2>
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
