export default function Section({ step, title, children }) {
  return (
    <section>
      <h2>
        {step != null && <span className="step">{step}</span>}
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A button that disables itself and shows a spinner glyph while `busy`. */
export function Busy({ busy, children, ...rest }) {
  return (
    <button {...rest} disabled={busy || rest.disabled}>
      {busy ? '…' : children}
    </button>
  );
}
