import { useEffect, useRef } from 'react';
// `m`, not `motion`. The full motion component bundles every feature whether or
// not the page uses it; `m` carries none and takes them from the LazyMotion
// provider in App, which declares exactly the one set this console needs. It is
// the difference between about 130 kB of animation library and about 60.
import { m, useAnimationControls } from 'framer-motion';
import { LuCheck } from 'react-icons/lu';

/**
 * One station of the launch sequence.
 *
 * The console is a procedure, not a dashboard: six things, in one order, each of
 * which spends money or destroys keys if taken out of turn. So the page is drawn
 * as the procedure — a hairline running down the left edge, threading a numbered
 * node per step, with the stretch behind you filled in. The order on screen IS
 * the order of work, and the line is what says so.
 *
 * Colour is the palette's existing vocabulary and nothing new:
 *
 *   jade   done — already true, past tense, the same colour the checklist used
 *   amber  now  — the step that wants attention, the same colour as a primary
 *   grey   later — neither ready, dangerous, nor confirmed
 *
 * Vermilion is deliberately absent. Being early in a sequence is not dangerous,
 * and spending the irreversible colour here would blunt it where it means
 * something — the arm switch, the launch button, the delete dialog.
 *
 * A "later" step is drawn grey and says what it waits on. It is NOT disabled:
 * every control inside stays live, because an operator who knows better than the
 * sequence must not be locked out of their own wallets by a presentation layer.
 */
export function Node({ n, state, small = false }) {
  const controls = useAnimationControls();
  const was = useRef(state);

  // Fires on the transition INTO done and at no other time. Not on mount: an
  // animation that replays every page load is decoration, and this one is meant
  // to be the acknowledgement of something that just landed.
  //
  // ONE INVERSE FLASH, not a bounce. It was `scale: [1, 1.18, 1]` over 0.4s on
  // easeOut — a flat, square, radius-0 node springing 18% larger, which is an
  // app gesture rather than an instrument's, and the most visible motion in the
  // console. A terminal acknowledges by inverting a cell for a frame. The values
  // are --dur-fast and the linear ramp of the motion budget in styles.css.
  useEffect(() => {
    if (was.current !== state && state === 'done') {
      controls.start({
        opacity: [1, 0.2, 1],
        transition: { duration: 0.16, ease: 'linear', times: [0, 0.5, 1] },
      });
    }
    was.current = state;
  }, [state, controls]);

  return (
    <m.span className={`node is-${state}${small ? ' is-small' : ''}`} animate={controls}>
      {/* The readout is part of the run but is not one of the six, so it is
          given a node without a number rather than a number nobody asked for. */}
      {n == null ? <span className="node-dot" /> : n}
    </m.span>
  );
}

export default function Step({
  n,
  id,
  title,
  state = 'later',
  chip,
  wait,
  last = false,
  // Which step the connector BELOW this one belongs to. It is the node's own
  // state everywhere except the readout, which is threaded onto the launch's
  // spine without ever claiming to have succeeded itself.
  railDone,
  // The eyebrow shown beside an unnumbered (n == null) panel's title, in place
  // of "Step N". Defaults to "Readout" — ResultPanel's own word for itself —
  // so every existing unnumbered panel is unaffected; a panel that is not a
  // readout (a utility section, say) passes its own word instead.
  label,
  className = '',
  children,
}) {
  const filled = railDone ?? state === 'done';

  return (
    <section id={id} className={`stage is-${state} ${className}`.trim()}>
      <span className="stage-mark" aria-hidden="true">
        <Node n={n} state={state} />
        {/* The connector below this node, filled once the step is behind you.
            Drawn as a separate scaling element rather than a colour change so
            the progress reads as travel down the page. */}
        {!last && (
          <span className="stage-rail">
            {/* --dur-slow and the console's one ease. It ran 0.45s on an
                overshooting expo-out, which is a curve that arrives, passes its
                target and comes back — the spine is a machine drawing a line,
                and a machine draws it once, in one direction. */}
            <m.span
              className="stage-rail-fill"
              initial={false}
              animate={{ scaleY: filled ? 1 : 0 }}
              transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
            />
          </span>
        )}
      </span>

      {/* The node is decoration to a screen reader, so the number is carried in
          the heading text as well — and it is what a narrow screen keeps when
          the gutter tightens. Set dimmer than the title so the two do not
          compete for the same glance. */}
      <h2>
        <span className="stage-n">{n == null ? (label ?? 'Readout') : `Step ${n}`}</span>
        <span className="stage-t">{title}</span>
        {chip && (
          <span className={`chip is-${state}`}>
            {state === 'done' && <LuCheck aria-hidden="true" />}
            {chip}
          </span>
        )}
      </h2>

      {wait && <p className="stage-wait">{wait}</p>}

      {children}
    </section>
  );
}
