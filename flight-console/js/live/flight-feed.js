// flight-feed.js: takes the results a flight source's parse() gives for
// each line (see js/live/sources.js) and feeds the Flight Console store, so
// the 3D view, the map and the HUD show the rocket live.
//
// Today the one flight source is the radio board receiver. It prints a
// "PKT node=1 seq=.. up_s=.. ..." line for each radio packet from a
// Dogtooth board, and parseSerialLine() in js/parser.js turns each into a
// normalized sample. The Manta ground station can use this feed too.
//
// THE CLOCK. A sample's time is the flight board's own clock (up_s, the
// seconds since it powered up). The store has one clock for everything,
// and the feed is what moves it:
//   - The first board heard sets the feed clock to its own time, so its
//     times go in unchanged.
//   - Between packets the clock keeps moving with the computer's clock
//     (every TICK_MS), so ages keep counting. Without that, a rocket that
//     flew out of range would look as if it had just sent its last packet.
//   - A second board has a different power-up time, so its times are
//     shifted onto the feed clock the moment it is first heard.
//   - A board that restarts in flight (the receiver marks the line
//     REBOOTED, usually a brownout) starts counting from 0 again. The
//     store would turn those packets away as older than the last one. So
//     the feed shifts the new times to follow on, and the track carries on.
//     Nothing is cleared. A flight's track is too valuable to wipe
//     because of a brownout. The shift is kept in extra.time_shift_s, the
//     same way parseSerialLog() does it for a saved log.
//
// THE RECEIVER'S STATUS LINE. The receiver prints one every second, like
//   # DEKEL_RX listening good=12 bad=3 last_good_s_ago=0.4 rx_up_s=73.0
//   # DEKEL_RX radio-failed error=-2 good=0 bad=0 rx_up_s=5.0
// readReceiverStatus() reads it, and waitingNote() turns the feed's state
// into the line the page shows before the first packet arrives.
//
// Usage:
//   const store = createStore({ fleet, ...LIVE_STORE_OPTIONS.flight });
//   const feed = createFlightFeed({ store });
//   port opens: feed.newConnection()
//   each line:  feed.noteLine(line);
//               feed.push(source.parse(line), t);    // t: when it arrived, ms
//   leaving:    feed.stop()
//
// No DOM here, so Node can run it too.

import { RECEIVER_MARKER } from './sources.js?v=3';

// How often (ms) the store's clock moves on between packets.
export const TICK_MS = 250;

// A board's clock that goes back by more than this (s) restarted.
export const CLOCK_BACK_S = 0.5;

// A board's clock that runs ahead of the computer's clock by more than this
// (s) between two packets isn't the same clock any more (another board with
// the same ID, most likely). Its times are put back on the feed clock.
export const CLOCK_JUMP_S = 30;

// Reads the receiver's status line. Returns null for any other line, or
//   { state: 'listening' | 'radio-failed', good, bad, error, lastGoodAgoS, rxUpS }
// with null for a number the line doesn't have.
export function readReceiverStatus(line) {
  const text = String(line ?? '').trim();
  if (!text.startsWith(`${RECEIVER_MARKER} `)) return null;
  const words = text.slice(RECEIVER_MARKER.length).trim().split(/\s+/);
  const state = words[0];
  if (state !== 'listening' && state !== 'radio-failed') return null;
  const values = new Map();
  for (const word of words.slice(1)) {
    const eq = word.indexOf('=');
    if (eq > 0) values.set(word.slice(0, eq), Number(word.slice(eq + 1)));
  }
  const number = (key) => (Number.isFinite(values.get(key)) ? values.get(key) : null);
  return {
    state,
    good: number('good'),
    bad: number('bad'),
    error: number('error'),
    lastGoodAgoS: number('last_good_s_ago'),
    rxUpS: number('rx_up_s'),
  };
}

// What the page says under the bar while a flight source is connected:
//   { text, kind }   kind is 'info' or 'warn'
// The text is '' once packets are on screen and nothing is wrong, since the
// HUD says the rest.
export function waitingNote(feed, sourceName = 'The receiver') {
  const rx = feed?.receiver ?? null;
  if (rx?.state === 'radio-failed') {
    const code = rx.error === null ? '' : ` (error ${rx.error})`;
    return { text: `${sourceName} is connected, but its radio didn't start${code}. It can't hear the rocket until that is fixed.`, kind: 'warn' };
  }
  if (feed?.counts.samples > 0) return { text: '', kind: 'info' };
  const heard = feed?.counts.bad ?? 0;
  const other = heard === 0 ? ''
    : heard === 1 ? ' It heard 1 packet that was damaged or from another radio.'
      : ` It heard ${heard} packets that were damaged or from other radios.`;
  return { text: `${sourceName} found. It is listening, and no packets from the rocket have come in yet.${other}`, kind: 'info' };
}

// Runs fn every ms milliseconds. Returns a function that stops it.
function everyMs(fn, ms) {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}

// Feeds a store from a flight source.
//   store    from createStore()
//   clock    the computer's clock in ms (for tests)
//   every    (fn, ms) -> stop function, or null to move the clock only
//            through tick() (for tests)
export function createFlightFeed({ store, clock = () => Date.now(), every = everyMs, tickMs = TICK_MS } = {}) {
  let anchor = null;            // { feedT, realMs }: the newest packet's time on the feed clock, and when it arrived
  const boards = new Map();     // rocketId -> { offset, lastRaw, lastT, lastRealMs }
  let stopTimer = null;
  let receiver = null;          // the newest status line, from readReceiverStatus()
  const counts = { samples: 0, bad: 0, restarts: 0 };

  // The feed clock at a moment of the computer's clock.
  function feedAt(realMs) {
    return anchor.feedT + Math.max(0, realMs - anchor.realMs) / 1000;
  }

  // True when this packet's time can't follow on from the board's last one.
  function clockBroke(board, sample, raw, realMs) {
    if (sample.extra?.rebooted === 'yes') return true;
    if (raw < board.lastRaw - CLOCK_BACK_S) return true;
    const realS = Math.max(0, realMs - board.lastRealMs) / 1000;
    return (raw - board.lastRaw) - realS > CLOCK_JUMP_S;
  }

  // One rocket sample. Returns true if it went to the store.
  function pushSample(sample, realMs) {
    // A ground station's own packet has no rocket clock to follow.
    if (sample.type === 'gs') {
      store.addSample(sample);
      return true;
    }
    const raw = sample.t;
    if (!Number.isFinite(raw) || sample.rocketId === null || sample.rocketId === undefined) return false;
    const id = String(sample.rocketId);

    let board = boards.get(id);
    if (!board) {
      // The first board heard keeps its own times. A later one joins the
      // feed clock where it stands now.
      board = { offset: anchor ? feedAt(realMs) - raw : 0, lastRaw: raw, lastT: null, lastRealMs: realMs };
      boards.set(id, board);
    } else if (clockBroke(board, sample, raw, realMs)) {
      // Follow on from now, and never from before this board's last packet.
      board.offset = Math.max(feedAt(realMs), board.lastT) - raw;
      counts.restarts += 1;
    }

    const t = raw + board.offset;
    board.lastRaw = raw;
    board.lastT = t;
    board.lastRealMs = realMs;

    const shifted = board.offset === 0 ? sample : {
      ...sample,
      t,
      extra: { ...(sample.extra ?? {}), time_shift_s: Math.round(board.offset * 1000) / 1000 },
    };
    anchor = { feedT: t, realMs };
    store.addSamples([shifted], { time: t });
    counts.samples += 1;
    if (!stopTimer && every) stopTimer = every(tick, tickMs);
    return true;
  }

  // Takes one result from the source's parse(). realMs is when the line
  // arrived. Returns true if a sample went to the store.
  function push(result, realMs = clock()) {
    if (!result) return false;
    if (result.kind === 'bad') {
      counts.bad += 1;
      return false;
    }
    if (result.kind !== 'sample' || !result.sample) return false;
    return pushSample(result.sample, Number.isFinite(realMs) ? realMs : clock());
  }

  // Looks at a raw line for the receiver's status. Returns true if it was one.
  function noteLine(line) {
    const status = readReceiverStatus(line);
    if (!status) return false;
    receiver = status;
    return true;
  }

  // A new connection may be a different receiver, so what the last one
  // said about itself is forgotten. The rockets, their tracks and the
  // clock stay: the same flight carries on after a cable is plugged back in.
  function newConnection() {
    receiver = null;
  }

  // Moves the store's clock to the feed's time now.
  function tick() {
    if (anchor) store.setTime(feedAt(clock()));
  }

  function stop() {
    stopTimer?.();
    stopTimer = null;
  }

  return {
    push,
    noteLine,
    newConnection,
    tick,
    stop,
    counts,
    get receiver() { return receiver; },
  };
}
