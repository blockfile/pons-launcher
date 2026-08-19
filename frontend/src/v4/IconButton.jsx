/**
 * A small square control carrying an icon.
 *
 * WHY THIS EXISTS RATHER THAN THE `link` BUTTONS IT REPLACES. A button styled
 * as a text link is a control disguised as prose: it sits in the reading flow,
 * it is easy to miss when scanning, and — worse in a table — a row of them
 * makes a paragraph out of what is meant to be a set of actions. This console
 * is an instrument panel, and its controls should look like controls.
 *
 * THE LABEL IS NOT OPTIONAL. An icon on its own is a rebus: `title` gives it a
 * name on hover for a pointer, and `aria-label` gives it one for a screen
 * reader and for keyboard focus. Both take the same string, because a control
 * whose two names disagree is worse than one with no name at all.
 *
 * `danger` is for the destructive ones, and only for those. It stays grey until
 * hovered — the row's data is what an operator is reading, and a permanently
 * red control in every row would make a table of ordinary wallets look like a
 * page of warnings. See the stylesheet header: vermilion means irreversible,
 * and it is never spent on decoration.
 */
export default function IconButton({
  icon: Icon,
  label,
  onClick,
  danger = false,
  disabled = false,
  size = 15,
  className = '',
}) {
  return (
    <button
      type="button"
      className={`icon-btn ${danger ? 'is-danger' : ''} ${className}`.trim()}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon aria-hidden="true" size={size} />
    </button>
  );
}

/**
 * The same control with its name beside it, for the places an icon alone would
 * be a guess — "import a wallet" has no glyph anyone reads reliably, and a
 * toolbar of unlabelled squares is a worse rebus than one link ever was.
 */
export function IconAction({
  icon: Icon,
  children,
  onClick,
  danger = false,
  disabled = false,
  className = '',
}) {
  return (
    <button
      type="button"
      className={`icon-action ${danger ? 'is-danger' : ''} ${className}`.trim()}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon aria-hidden="true" size={14} />
      <span>{children}</span>
    </button>
  );
}
