// sources.js: works out what is talking on the serial port from the lines
// that arrive, so the page can pick the right panel for it.
//
// Today there are two sources.
//
// A Dogtooth board's USB status block, one block per second. It's
// recognized by the block's banner line
// ("==================== HEARTBEAT #65 | TIME RUNNING: 1 min 5.3 s ===="),
// read by parseLine() in bench/parse.js, so the format is only described
// in one place.
//
// The radio board receiver: a club radio board running my DEKEL_RX_FIRMWARE,
// which listens for a Dogtooth board's radio packets and prints each one
// as a "PKT node=1 seq=.. ..." line. It's recognized by RECEIVER_MARKER,
// which starts its status line (one every second) and the first line of
// its start-up header, or by a PKT line.
//
// Each source is { id, name, mode, test(line), parse(line) }:
//   id     a short fixed name for code
//   name   what the page calls it, in plain words
//   mode   'bench' shows the bench panel (readings, graphs, raw output),
//          'flight' lets the 3D view and map take over
//   test   true for a line only this source prints
//   parse  flight sources only: one line in, one of parseSerialLine()'s
//          results out ({ kind: 'sample', sample }, { kind: 'bad', ... } or
//          { kind: 'ignored' }). js/live/flight-feed.js takes it from there.
//
// Usage:
//   const detector = createSourceDetector();
//   link onOpen:  detector.reset();
//   link onLine:  const source = detector.push(line);
//                 if (source) ... (the same source for every later line)
//                 else if (detector.unknown) ... (lines arrive, none match)
//
// No DOM here, so Node can run it too.

import { parseLine } from '../bench/parse.js?v=5';
import { parseSerialLine } from '../parser.js?v=3';

// What the radio board receiver starts its lines with. Its status line is
// "# DEKEL_RX listening good=12 bad=3 last_good_s_ago=0.4 rx_up_s=73.0"
// and its header begins "# DEKEL_RX_FIRMWARE receiver for Dogtooth
// telemetry (receive only)". The firmware's copy of this text is
// Config::kStatusMarker in DEKEL_RX_FIRMWARE's include/Config.h. Change
// both or neither.
export const RECEIVER_MARKER = '# DEKEL_RX';

// True for a line only a receiver prints: one that starts with the marker,
// or a packet line. A Dogtooth board on USB never prints either. Its
// flight_sim build prints "SIM PKT ..." lines, which start with SIM, so
// they don't match.
function isReceiverLine(line) {
  const text = line.trimStart();
  return text.startsWith(RECEIVER_MARKER) || text.startsWith('PKT ');
}

// One receiver line -> what parseSerialLine() makes of it. A PKT line is a
// sample (the rocket ID comes from node=), a BAD line is { kind: 'bad' },
// and "#" lines are ignored. A receiver never prints "SIM PKT", so a line
// like that is turned away here instead of being read as a packet.
function parseReceiverLine(line) {
  if (String(line ?? '').trimStart().startsWith('SIM PKT')) return { kind: 'ignored' };
  return parseSerialLine(line);
}

export const SOURCES = Object.freeze([
  Object.freeze({
    id: 'dogtooth-usb',
    name: 'Dogtooth board over USB',
    mode: 'bench',
    test: (line) => parseLine(line).type === 'banner',
  }),

  // The radio board receiver. It comes after the Dogtooth board, so a
  // Dogtooth board's own output is always matched first. A Dogtooth board
  // running the bench_rx build prints the same PKT lines, so it is picked
  // up as a receiver too, at its first packet.
  Object.freeze({
    id: 'radio-board-rx',
    name: 'Radio board receiver',
    mode: 'flight',
    test: isReceiverLine,
    parse: parseReceiverLine,
  }),

  /* ------------------------------------------------------------------
   * Hook for the Manta ground station (not built yet).
   *
   * To add it, uncomment the entry below and fill in three things:
   *
   * 1. test(line): true only for a line the ground station prints and no
   *    other source does, so a Dogtooth board on USB is never mistaken
   *    for it. Test it against real output, startup lines included. The
   *    first source whose test matches wins. A Dogtooth board running the
   *    flight_sim build prints "SIM PKT" lines next to its status blocks,
   *    so a test that matches "SIM PKT" would take that board for a
   *    ground station.
   *
   * 2. The parser that turns its lines into normalized samples
   *    ({ rocketId, t, type, gps, baro, ... }, see js/schema.js). Name it
   *    in `parse`, so the page can hand each sample to the store with
   *    store.addSample(). parseSerialLine() in js/parser.js already reads
   *    the "PKT node=1 seq=.. ..." lines from the bench_rx receiver (and
   *    "SIM PKT" lines) and returns { kind: 'sample', sample }, so it may
   *    be the starting point if the ground station prints something close.
   *    The radio board receiver above works this way. Its samples go
   *    through createFlightFeed() in flight-feed.js, which also keeps the
   *    store's clock moving between packets, so the views say when the
   *    data is old. Manta can use the same feed.
   *
   * 3. mode 'flight': the page then lets the 3D view and the map take
   *    over, instead of showing the bench panel. Rocket IDs come from the
   *    packets, so each rocket in the air gets its own track.
   * ------------------------------------------------------------------ */
  // Object.freeze({
  //   id: 'manta-ground-station',
  //   name: 'Manta ground station',
  //   mode: 'flight',
  //   test: (line) => false,   // fill in: true for a line only the ground station prints
  //   parse: null,             // fill in: line -> { kind: 'sample', sample } (see parseSerialLine in js/parser.js)
  // }),
]);

// Lines (not counting blank ones) with no match before the page says it
// doesn't know the data. A status block is about 20 lines and comes every
// second, and the startup text is about 10 lines, so 60 is about three
// seconds of a board with no banner in it. (The receiver prints its marker
// every second, so it is found within a line or two.)
export const UNKNOWN_AFTER_LINES = 60;

export function createSourceDetector({ sources = SOURCES, unknownAfter = UNKNOWN_AFTER_LINES } = {}) {
  let source = null;
  let unmatched = 0;   // lines with text in them since the last reset, while nothing matched

  // Looks at one line. Returns the source once one is found (and the same
  // one for every line after that, until reset()), or null.
  function push(line) {
    if (source) return source;
    if (typeof line !== 'string' || !line.trim()) return null;
    source = sources.find((s) => s.test(line)) ?? null;
    if (!source) unmatched += 1;
    return source;
  }

  // Forgets what was found. Call it on every new connection, since a
  // different board (or one running other firmware) may be plugged in.
  function reset() {
    source = null;
    unmatched = 0;
  }

  return {
    push,
    reset,
    get source() { return source; },
    // True when enough lines arrived and none matched a source: the page
    // can say it doesn't recognize the data. A match later still counts.
    get unknown() { return !source && unmatched >= unknownAfter; },
    get unmatchedLines() { return unmatched; },
  };
}
