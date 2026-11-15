// Checks the Komodo simulated flight (data/flights/komodo-sim-01), loaded
// through the page's own library and store code. It is the realistic
// flight: every fix jumps a little and wanders, the fix drops at liftoff,
// the satellite count changes and the board lies in the shallows at the end.
// These are the things that must stay true however the console changes.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/komodo-flight.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, buildFlight } from '../js/library.js';
import { createStore } from '../js/store.js';
import { createFleet } from '../js/fleet.js';
import { flightState, recoveryInfo, rangeReading, STATE } from '../js/flight-state.js';
import { compareWithTruth } from '../js/truth-check.js';
import { distanceM, formatBearing, formatNumber } from '../js/geo.js';
import { apogeeLabel } from '../js/views/map-labels.js';
import { gpsLineWarn } from '../js/views/hud-text.js';
import { MIN_SATS } from '../js/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLIGHTS_DIR = path.resolve(HERE, '..', 'data', 'flights');
const ID = 'komodo-sim-01';

// Where the simulator really put the rocket down (its true state for the
// last second of the log, before any GPS error), and where Manta stood.
const TRUE_LANDING = { lat: -8.5405694, lon: 119.5784925 };
const MANTA = { lat: -8.539775, lon: 119.574933 };
// The recovery position averages about 20 noisy fixes, so it lands within
// a few meters of the truth. This leaves room for that and no more.
const RECOVERY_MAX_ERROR_M = 15;

function loadManifest() {
  return validateManifest(JSON.parse(fs.readFileSync(path.join(FLIGHTS_DIR, 'index.json'), 'utf8')));
}

function loadFlight() {
  const entry = loadManifest().flights.find((f) => f.id === ID);
  assert.ok(entry, `${ID} is in the library`);
  const texts = new Map(entry.rockets.map((r) => [r.file, fs.readFileSync(path.join(FLIGHTS_DIR, entry.id, r.file), 'utf8')]));
  return { entry, flight: buildFlight(entry, texts) };
}

// Plays the flight into a store the way the replay does, one sample at a
// time, noting each state change.
function play(entry, flight) {
  const store = createStore({ fleet: createFleet(), groundStation: entry.groundStation });
  const order = [];
  const firstAt = {};
  for (const s of flight.samples) {
    store.addSample(s);
    const { state } = flightState(store, store.getFocused());
    if (order[order.length - 1] !== state) order.push(state);
    if (!(state in firstAt)) firstAt[state] = s.t;
  }
  return { store, rocket: store.getFocused(), order, firstAt };
}

test('the library lists the Komodo flight first, with the old flight below it', () => {
  const { flights, problems } = loadManifest();
  assert.equal(problems.length, 0);
  assert.equal(flights[0].id, ID);
  assert.equal(flights[0].title, 'Simulated flight, Komodo, Indonesia');
  assert.equal(flights[0].kind, 'simulated');
  assert.equal(flights[0].date, '2026-11-14');
  assert.deepEqual({ ...flights[0].groundStation }, { lat: MANTA.lat, lon: MANTA.lon, altMsl: 2 });
  assert.ok(flights.some((f, i) => i > 0 && f.id === 'gps-board-sim-01'), 'the old flight is still listed, below it');
});

test('the log parses with no bad rows and the simulator\'s launch site', () => {
  const { flight } = loadFlight();
  assert.equal(flight.badRows, 0);
  assert.equal(flight.samples.length, 356);
  assert.deepEqual(flight.launchSite, { lat: -8.5366, lon: 119.5742, altMsl: 105.7 });
  // Realistic, not clean: the satellite count and HDOP move.
  const sats = new Set(flight.samples.map((s) => s.gps?.sats).filter((n) => Number.isFinite(n) && n > 0));
  const hdops = new Set(flight.samples.map((s) => s.gps?.hdop).filter((n) => Number.isFinite(n) && n < 99));
  assert.ok(sats.size >= 5, `satellite counts seen: ${[...sats].join(', ')}`);
  assert.ok(hdops.size >= 30, `${hdops.size} different HDOP values`);
});

test('every event fires once, in order, close to the simulator\'s truth', () => {
  const { entry, flight } = loadFlight();
  const { rocket } = play(entry, flight);
  const events = rocket.derived.events;
  const rows = compareWithTruth(Object.values(events).filter(Boolean), flight.truth);
  for (const row of rows) {
    assert.equal(row.count, 1, `${row.type} fires once`);
    assert.ok(Math.abs(row.diffS) <= 5, `${row.type} within 5 s of the truth (${row.diffS} s)`);
  }
  const order = ['liftoff', 'apogee', 'drogue', 'main', 'landed'].map((type) => events[type].t);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'liftoff, apogee, drogue, main, landed in that order');
  // The board lands 105 m below the pad, in the sea, and the height above
  // the pad shows it.
  assert.ok(rocket.derived.maxAgl > 2950 && rocket.derived.maxAgl < 3100, `apogee ${rocket.derived.maxAgl} m`);
});

test('the states go pad, flight, recovery', () => {
  const { entry, flight } = loadFlight();
  const { order, firstAt, rocket } = play(entry, flight);
  assert.deepEqual(order, [STATE.PAD, STATE.FLIGHT, STATE.RECOVERY]);
  // Liftoff is estimated from the fix drop right at liftoff (sim second 35,
  // the board's clock 36 s), and the landing is confirmed about 20 s after
  // touchdown.
  assert.equal(rocket.derived.liftoffT, 37);
  assert.ok(firstAt[STATE.RECOVERY] >= rocket.derived.events.landed.t + 15);
  assert.ok(firstAt[STATE.RECOVERY] <= rocket.derived.events.landed.t + 21);
});

test('the trail has a gap at liftoff and weak fixes under the parachutes', () => {
  const { entry, flight } = loadFlight();
  const { rocket } = play(entry, flight);
  const liftoffT = rocket.derived.liftoffT;
  const crumbs = rocket.crumbs;
  // The first good fix after the fix came back starts a new piece of line.
  const firstGoodInFlight = crumbs.find((c) => c.quality === 'good' && c.t > liftoffT);
  assert.equal(firstGoodInFlight.gapBefore, true, 'the line breaks across the liftoff fix loss');
  assert.ok(firstGoodInFlight.t - liftoffT <= 8, 'the fix is back within a few seconds');
  // Weak fixes (hollow grey dots): some, but few.
  const weak = crumbs.filter((c) => c.quality === 'weak');
  assert.ok(weak.length >= 5 && weak.length <= 20, `${weak.length} weak fixes`);
  assert.ok(weak.some((c) => c.t > rocket.derived.events.drogue.t && c.t < rocket.derived.events.main.t), 'a weak stretch under the drogue');
  assert.ok(weak.some((c) => c.t >= rocket.derived.events.main.t - 5 && c.t < rocket.derived.events.landed.t), 'a weak stretch around the main');
  assert.equal(crumbs.filter((c) => c.quality === 'outlier').length, 0, 'no fix is thrown away as an outlier');
});

test('the board lies still in a cloud after landing, and the recovery position is close to the truth', () => {
  const { entry, flight } = loadFlight();
  const { store, rocket } = play(entry, flight);
  const landedT = rocket.derived.events.landed.t;
  // The landed cloud: the fixes wander a few meters, like a real board
  // sitting still, but stay well inside the landing circle.
  const landed = rocket.crumbs.filter((c) => c.t > landedT + 1 && c.quality === 'good');
  assert.ok(landed.length >= 90, `${landed.length} fixes after landing`);
  const spread = Math.max(...landed.map((a) => Math.max(...landed.map((b) => distanceM(a.lat, a.lon, b.lat, b.lon)))));
  assert.ok(spread > 3 && spread < 40, `landed fixes spread ${spread.toFixed(1)} m`);
  // The receiver's own ground speed stays low, but not always 0.
  const speeds = landed.map((c) => c.groundSpeedMps);
  assert.ok(Math.max(...speeds) < 1 && Math.max(...speeds) > 0);

  const info = recoveryInfo(store, rocket);
  assert.equal(info.from, 'manta');
  const error = distanceM(info.position.lat, info.position.lon, TRUE_LANDING.lat, TRUE_LANDING.lon);
  assert.ok(error <= RECOVERY_MAX_ERROR_M, `recovery position ${error.toFixed(1)} m from the true landing point`);
  // About 400 m from Manta on the beach.
  assert.ok(info.distanceM > 360 && info.distanceM < 450, `${info.distanceM} m from Manta`);
  assert.match(info.mapsUrl, new RegExp(info.position.lat.toFixed(4).replace('.', '\\.')));
});

test('the apogee message gives the highest reading in whole meters, like the map label', () => {
  const { entry, flight } = loadFlight();
  const { rocket } = play(entry, flight);
  const { apogee, drogue, main, landed } = rocket.derived.events;
  const meters = formatNumber(rocket.derived.maxAgl, 0);
  assert.equal(apogeeLabel(apogee.aglM), `APOGEE ${meters} M`);
  assert.match(apogee.message, new RegExp(`^Apogee detected: ${meters} m AGL at T\\+`));
  assert.doesNotMatch(apogee.message, /about/);
  // The other heights are estimates, so they stay "about" and rounded.
  for (const e of [drogue, main, landed]) assert.match(e.message, /about -?[\d,]+0 m AGL/, e.type);
});

test('in recovery the readings row and the HUD give the same distance and bearing', () => {
  const { entry, flight } = loadFlight();
  const { store, rocket } = play(entry, flight);
  const info = recoveryInfo(store, rocket);
  const range = rangeReading(store, rocket);
  assert.equal(range.recovery, true);
  assert.equal(range.distanceM, info.distanceM);
  assert.equal(range.bearingDeg, info.bearingDeg);
  assert.equal(formatBearing(range.bearingDeg), info.text.bearing);
  assert.match(info.text.bearing, /^\d{3}° \([NESW]{1,3}\)$/);
  // The newest fix has wandered a few meters from the average, so it would
  // give a slightly different answer. That is why the row uses the HUD's.
  const fromNewest = distanceM(MANTA.lat, MANTA.lon, rocket.lastGoodFix.lat, rocket.lastGoodFix.lon);
  assert.ok(Math.abs(fromNewest - info.distanceM) > 0.5, `newest fix ${fromNewest.toFixed(1)} m, recovery ${info.distanceM.toFixed(1)} m`);
});

test('the HUD marks every fix with too few satellites, as the map does with a hollow dot', () => {
  const { entry, flight } = loadFlight();
  const store = createStore({ fleet: createFleet(), groundStation: entry.groundStation });
  const lowSatTimes = [];
  for (const s of flight.samples) {
    store.addSample(s);
    const rocket = store.getFocused();
    const sats = rocket.latestByGroup.gps?.values?.sats;
    const fixNow = store.hasFixNow(rocket);
    if (fixNow && sats < MIN_SATS) {
      lowSatTimes.push(s.t);
      assert.equal(gpsLineWarn(fixNow, sats, MIN_SATS), true, `t=${s.t} with ${sats} satellites`);
      assert.equal(rocket.crumbs[rocket.crumbs.length - 1].quality, 'weak', `the map's dot at t=${s.t} is hollow`);
    }
  }
  // The flight has such moments: right after the fix comes back, under the
  // drogue and at the main.
  assert.ok(lowSatTimes.length >= 5, `${lowSatTimes.length} fixes under ${MIN_SATS} satellites`);
});
