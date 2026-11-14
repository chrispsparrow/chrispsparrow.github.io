// bench-feed.js: turns the Dogtooth board's USB status blocks into
// normalized samples for the Flight Console store, so the 3D view, the map
// and the readings show the board's live position.
//
// One block becomes one sample (see js/schema.js and parseSerialLine() in
// js/parser.js for the shape):
//   { rocketId, t, type: 'tlm', gps, baro: null, imu: null, radio: null,
//     power: null, status: null, extra: null }
// t is the board's TIME RUNNING in seconds. gps holds every GPS channel,
// null where the block has no value:
//   fix     1 when the block says LOCKED and readPosition() accepts the
//           position, 0 for SEARCHING or a bad position (like 0, 0)
//   lat, lon, altMsl   only with a fix, so no made-up position is ever
//           drawn. The board keeps printing 0.0000000 while it searches.
//   sats, hdop         as the board printed them
//   stale   null: the block's LOCKED is the packet's "location fresh" flag,
//           and it doesn't say whether the altitude is fresh (the same as
//           bench_rx lines, see the stale channel in js/schema.js)
// A block cut off before its position lines (the port closed partway) has
// gps: null, so half a block never looks like a lost fix.
// The other readings in the block (data rate, motion model, radio counts)
// are left out. The bench panel shows them.
//
// Usage:
//   const store = createStore({ fleet, ...LIVE_STORE_OPTIONS.bench });
//   const feed = createLiveFeed({ store });          // registers the board
//   panel onBlock:   feed.push(block)
//   panel onRestart: feed.restart()                  // optional, push() also spots it
//   leaving:         feed.stop()
//
// No DOM here, so Node can run it too.

import { readLock, readPosition } from '../bench/parse.js?v=4';
import { GROUPS, channelsInGroup } from '../schema.js';
import { KNOWN_ROCKETS } from '../fleet.js';
import { DETECTOR_DEFAULTS } from '../config.js';

// A board on USB sits on a desk, not on a launch rail. One GPS altitude
// jump of 30 m or more would read as "Liftoff detected", so the live bench
// store never detects liftoff. (The same two numbers also decide when data
// "started in flight", which a board on a desk never did either.) The pad
// is still found, and the 3D view needs it. config.js keeps the real
// thresholds for flights and replays.
export const BENCH_DETECTOR = Object.freeze({
  ...DETECTOR_DEFAULTS,
  LIFTOFF_AGL_M: Infinity,
  LIFTOFF_VSPEED_MPS: Infinity,
});

// createStore() options for the live stores, one per mode (main.js makes
// each the first time that mode is used). Neither has a ground station: a
// board on the bench has none, and a real ground station sends its own
// position ("gs" packets), so the demo position in config.js is never used
// for live data. Kept here, away from the page, so the tests use the same
// options the page does.
export const LIVE_STORE_OPTIONS = Object.freeze({
  bench: Object.freeze({ detectorConfig: BENCH_DETECTOR, groundStation: null }),
  flight: Object.freeze({ groundStation: null }),
});

// The board on the USB cable: my GPS and radio board, node ID 1 (every
// board sends 1 until it gets its own number). fleet.js fills in its name
// ("GPS and radio board"), its map label (DOGTOOTH GPS RADIO) and its parts.
export const DEFAULT_ROCKET = Object.freeze({ id: KNOWN_ROCKETS[0].id });

// How often (ms) the store's clock moves on between blocks, so ages keep
// counting and the views can tell when the data gets old.
export const TICK_MS = 250;

function emptyGroup(group) {
  const out = {};
  for (const c of channelsInGroup(group)) out[c.key] = null;
  return out;
}

// A number the board printed, or null.
function numberOf(value, units = ['']) {
  return value && Number.isFinite(value.num) && units.includes(value.unit) ? value.num : null;
}

// One finished block -> one normalized sample, or null when the block has
// no TIME RUNNING (there's no time to put it at).
export function blockToSample(block, rocketId) {
  if (!block || !Number.isFinite(block.timeRunning)) return null;
  const f = block.fields ?? {};
  const pos = readPosition(f);
  const fix = readLock(f.lock) === true && pos !== null;

  const sample = { rocketId: String(rocketId), t: block.timeRunning, type: 'tlm' };
  for (const g of GROUPS) sample[g] = null;
  sample.extra = null;
  // A block cut off before its position lines (the port closed partway)
  // can't say whether there's a fix, so it gets no GPS group at all.
  // Otherwise half a block would look like a lost fix.
  if (!(f.lock && f.lat && f.lon && f.alt)) return sample;

  const gps = emptyGroup('gps');
  gps.fix = fix ? 1 : 0;
  gps.sats = numberOf(f.sats);
  gps.hdop = Number.isFinite(f.quality?.hdop) ? f.quality.hdop : null;
  if (fix) {
    gps.lat = pos.lat;
    gps.lon = pos.lon;
    gps.altMsl = numberOf(f.alt, ['', 'm']);
  }
  sample.gps = gps;
  return sample;
}

// Runs fn every ms milliseconds. Returns a function that stops it.
function everyMs(fn, ms) {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
}

// Feeds a store from the board's blocks.
//   store    from createStore()
//   rocket   { id, name, board } for store.registerRocket(). Name and board
//            can be left out for a board fleet.js knows.
//   clock    the computer's clock in ms (for tests)
//   every    (fn, ms) -> stop function, or null to move the clock only
//            through tick() (for tests)
export function createLiveFeed({ store, rocket = DEFAULT_ROCKET, clock = () => Date.now(), every = everyMs, tickMs = TICK_MS } = {}) {
  const id = String(rocket.id);
  store.registerRocket({ id, name: rocket.name, board: rocket.board });

  let anchor = null;      // { boardT, realMs }: the newest block's TIME RUNNING (s) and when its banner arrived
  let last = null;        // { timeRunning, heartbeat } of the newest block
  let stopTimer = null;
  let restarts = 0;

  // The board's time now: the newest block's TIME RUNNING plus the real
  // time since its banner arrived, the same way the bench graphs slide.
  // It keeps moving after the board goes quiet or is unplugged, so the
  // views say the data is old.
  function boardNow() {
    return anchor.boardT + Math.max(0, clock() - anchor.realMs) / 1000;
  }

  // TIME RUNNING or the heartbeat number went back: the board restarted.
  function wentBack(block) {
    if (!last) return false;
    if (block.timeRunning < last.timeRunning) return true;
    return block.heartbeat !== null && last.heartbeat !== null && block.heartbeat < last.heartbeat;
  }

  // Adds one finished block. Returns true if it went into the store.
  function push(block) {
    const sample = blockToSample(block, id);
    if (!sample) return false;
    if (wentBack(block)) restart();
    last = { timeRunning: block.timeRunning, heartbeat: block.heartbeat ?? null };
    anchor = { boardT: sample.t, realMs: Number.isFinite(block.t) ? block.t : clock() };
    store.addSamples([sample], { time: boardNow() });
    if (!stopTimer && every) stopTimer = every(tick, tickMs);
    return true;
  }

  // After a board restart its TIME RUNNING starts over, so the store would
  // turn the new samples away as late. Like the graphs, it starts over:
  // every sample, event and track is cleared, and the rocket stays.
  function restart() {
    if (!last) return;
    restarts += 1;
    last = null;
    anchor = null;
    store.reset();
  }

  // Moves the store's clock to the board's time now.
  function tick() {
    if (anchor) store.setTime(boardNow());
  }

  function stop() {
    stopTimer?.();
    stopTimer = null;
  }

  return {
    push,
    restart,
    tick,
    stop,
    rocketId: id,
    get restarts() { return restarts; },
  };
}
