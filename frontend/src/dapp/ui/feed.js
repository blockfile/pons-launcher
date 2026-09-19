/**
 * The open token's live feed, kept out of React so it can be tested with fakes:
 * one stream per (token, timeframe), the offline poll of the mark and the venue,
 * and the stream's liveness — routed to the session of THIS token only.
 *
 *   streams   make-before-break: the live stream keeps feeding the page until the
 *             new timeframe's snapshot arrives, so a switch opens no gap in which a
 *             receipt could be missed. Only the live stream and the NEWEST pending
 *             one exist: a pending stream for a timeframe already left is closed,
 *             never promoted.
 *   liveness  a session learns it is live from this token's stream only. A token
 *             switch never inherits the old token's liveness (isLive checks the
 *             token): a new session whose stream is refused stays offline, so its
 *             curve floors are priced from a fresh mark read, never a frozen one.
 *   routing   an event of a stream whose token is not the open session's — the
 *             old token's stream in the moment between a switch and its cleanup —
 *             is dropped: its mark would price the new token's floors.
 *   poll      while no stream is live, the mark and the venue are read every
 *             MARK_POLL_MS: a curve floor is never priced from a mark frozen at
 *             page load, and a graduation is still followed.
 */
export const MARK_POLL_MS = 3_000;
export const OFFLINE_STATUS = { state: 'reconnecting', detail: 'live data paused — the price refreshes every 3 s' };

const lower = (a) => String(a || '').toLowerCase();

/**
 * @param {{
 *   api: {openStream: Function, getToken: Function},
 *   hub: {emit: Function},
 *   getSession: () => object|null,       the open session (it has venue.token)
 *   setMark?: (mark) => void,            the page's copy of the mark (TokenBar, WalletTable)
 *   followVenue?: (venue) => void,       a venue the server reports (graduation)
 *   timers?: {setInterval, clearInterval},
 *   pollMs?: number,
 * }} deps
 */
export function createFeed({ api, hub, getSession, setMark = () => {}, followVenue = () => {}, timers = globalThis, pollMs = MARK_POLL_MS }) {
  let token = null;
  let tf = null;
  let streams = [];
  let live = false;
  let poll = null;

  /** The open session when it is this token's; null otherwise. */
  function sessionFor(tok) {
    const s = getSession();
    return s && tok && s.venue && lower(s.venue.token) === lower(tok) ? s : null;
  }

  function setLive(on) {
    if (live === on) return;
    live = on;
    const s = sessionFor(token);
    if (s) s.setLive(on);
    if (!on) hub.emit('status', OFFLINE_STATUS);
  }

  function handler(entry) {
    return (name, data) => {
      if (entry.closed || lower(entry.token) !== lower(token)) return;
      const session = sessionFor(entry.token);
      if (!session) return; // the page moved to another token (or closed it): nothing here is for it
      if (name === 'receipt') {
        session.onReceipt(data); // any stream of the token; the session drops duplicates
        return;
      }
      if (name === 'snapshot') {
        if (!entry.live) {
          if (tf !== entry.interval) return; // a timeframe already left
          entry.live = true;
          for (const other of streams) if (other !== entry) other.close();
          streams = [entry];
        } else {
          session.onReconnect(); // an auto-reconnect: settle what the gap swallowed
        }
        setLive(true);
      }
      if (!entry.live) {
        // The first stream of the token is refused or retrying: say so on the chart.
        const down = name === 'stream:retry' || name === 'stream:error';
        if (down && !live && tf === entry.interval) hub.emit('status', OFFLINE_STATUS);
        return;
      }
      switch (name) {
        case 'snapshot':
          if (data && data.mark) {
            setMark(data.mark);
            session.onMark(data.mark);
          }
          if (data && data.venue) followVenue(data.venue); // a graduation while the stream was away
          hub.emit('snapshot', data);
          break;
        case 'mark':
          setMark(data);
          session.onMark(data);
          hub.emit('mark', data);
          break;
        case 'phase':
          if (data) followVenue(data);
          hub.emit('phase', data);
          break;
        case 'stream:retry':
        case 'stream:error':
          setLive(false);
          break;
        case 'trades':
          session.onTrades(data); // a mark older than these trades is behind the curve
          hub.emit('trades', data);
          break;
        case 'bar':
          hub.emit('bar', data);
          break;
        case 'status':
          hub.emit('status', data);
          break;
        case 'stats':
          hub.emit('stats', data); // the token header's changes, volume and figures (Task 35)
          break;
        default:
          break;
      }
    };
  }

  async function pollOnce() {
    const tok = token;
    if (!tok || live) return;
    let res;
    try {
      res = await api.getToken(tok);
    } catch {
      return; // the next poll (or the stream coming back) catches up
    }
    if (tok !== token || live) return;
    const session = sessionFor(tok);
    if (!session || !res) return;
    if (res.mark) {
      setMark(res.mark);
      session.onMark(res.mark);
      hub.emit('mark', res.mark);
    }
    if (res.venue) followVenue(res.venue);
  }

  /** Start feeding `tok` (no stream yet: setTimeframe opens it). */
  function open(tok) {
    if (token !== null) close();
    token = tok;
    poll = timers.setInterval(pollOnce, pollMs);
  }

  /** Stop: every stream closed, the poll stopped, and the open session told it is not live. */
  function close() {
    for (const s of streams) s.close();
    streams = [];
    if (poll !== null) timers.clearInterval(poll);
    poll = null;
    live = false;
    const s = getSession();
    if (s) s.setLive(false);
    token = null;
    tf = null;
  }

  /** Show `interval`: a new stream, make-before-break. */
  function setTimeframe(interval) {
    if (!token) return;
    tf = interval;
    for (const other of streams) if (!other.live) other.close();
    streams = streams.filter((e) => e.live);
    const entry = { token, interval, live: false, closed: false, stop: () => {} };
    entry.close = () => {
      entry.closed = true;
      entry.stop();
    };
    entry.stop = api.openStream(token, interval, handler(entry)) || (() => {});
    if (entry.closed) entry.stop(); // closed while opening
    streams.push(entry);
  }

  return {
    open,
    close,
    setTimeframe,
    /** Whether a live stream of `tok` is feeding the page (what a new session of that token starts with). */
    isLive: (tok) => live && !!token && lower(tok) === lower(token),
  };
}
