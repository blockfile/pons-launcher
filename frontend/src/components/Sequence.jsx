import { m } from 'framer-motion';
import { Node } from './Step.jsx';

/**
 * The whole job, before any of it: six stations, in order, each reading its own
 * live state.
 *
 * This is the one thing a first-time operator sees before anything else, and it
 * answers the only question they have — what do I do first, and what have I
 * already done. It replaced a four-row readiness checklist that stated facts in
 * no particular order: a key, a dev wallet, a wallet count, a logo. Those facts
 * are all still here, but attached to the step that needs them, which is where
 * they are actually useful.
 *
 * Each station links to its step. The marker that says which one you are on is a
 * single element that MOVES between stations rather than one drawn six times and
 * hidden five: progress down a procedure is travel, and a marker that jumps is
 * read as a different marker.
 */
export default function Sequence({ steps, notice }) {
  return (
    <nav className="plan" aria-label="The order of work">
      <ol>
        {steps.map((s) => (
          <li key={s.n}>
            <a className={`station is-${s.state}`} href={`#${s.id}`}>
              <Node n={s.n} state={s.state} small />
              <span className="station-text">
                <strong>{s.title}</strong>
                <span>{s.detail}</span>
              </span>
              {s.state === 'now' && (
                // A machine cursor jumps decisively and does not overshoot, so
                // the caret travels on a tween at --dur with the console's one
                // one-directional ease, not on the spring(420, 38) it used to
                // ride. See the motion budget in styles.css.
                <m.span
                  className="station-here"
                  layoutId="pons-here"
                  transition={{ type: 'tween', duration: 0.18, ease: [0.2, 0, 0, 1] }}
                />
              )}
            </a>
          </li>
        ))}
      </ol>

      {/* Said only when there is something to do about it. A permanently green
          row reporting a key nobody needs is furniture; a line that appears
          exactly when the console cannot read is an instruction. */}
      {notice && <p className="plan-notice">{notice}</p>}
    </nav>
  );
}
