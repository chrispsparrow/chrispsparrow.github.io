// Checks js/flight-state.js: the four Track a Rocket states, the pad
// checklist, the recovery block (distance and bearing from Manta or the
// launch point), ground speed, and the hard cases: no data, a connected
// board that is silent, the fix lost on the pad, the link going quiet in
// flight, a replay seeking backward, a board restart, and data that starts
// in flight.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/flight-state.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  flightState, padChecklist, recoveryInfo, rangeReading, groundSpeed, eventCrumb, packetRate,
  formatDistanceCaps, STATE,
} from '../js/flight-state.js';
import { gpsLineWarn } from '../js/views/hud-text.js';
import { createStore } from '../js/store.js';
import { createFleet } from '../js/fleet.js';
import { createPlayer } from '../js/player.js';
import { createCrumbTrail } from '../js/track.js';
import { createLiveFeed, LIVE_STORE_OPTIONS } from '../js/live/bench-feed.js';
import { BlockParser } from '../js/bench/parse.js?v=4';
import { destinationPoint, distanceM, formatBearing, formatRangeBearing } from '../js/geo.js';
import { makeSample, flightSamples, statusBlockLines, SITE } from './synthetic.mjs';
import * as config from '../js/config.js';

const newStore = (options = {}) => createStore({ fleet: createFleet(), ...options });

// A pad sample at the site.
const padSample = (t, { sats = 12, hdop = 1.45, fix = 1, seq = null } = {}) => makeSample({
  t, seq, fix, sats, hdop: fix ? hdop : null, stale: 0,
  lat: fix ? SITE.lat : null, lon: fix ? SITE.lon : null, altMsl: fix ? SITE.altMsl : null,
});

test('no data is IDLE, a connected board with nothing yet is PAD', () => {
  const store = newStore();
  assert.deepEqual(flightState(store), { state: STATE.IDLE, phase: null, sinceT: null, silent: false, startedInFlight: false });
  assert.equal(flightState(store, null, { connected: true }).state, STATE.PAD);
  // A registered board that hasn't sent anything (connected and silent).
  store.registerRocket({ id: '1' });
  assert.equal(flightState(store).state, STATE.IDLE);
  assert.equal(flightState(store, store.getFocused(), { connected: true }).state, STATE.PAD);
  const list = padChecklist(store);
  assert.deepEqual(list, {
    gps: { ok: false, text: 'NO FIX' },
    hdop: { ok: false, text: '--' },
    link: { ok: false, text: '--' },
    status: { ok: false, text: 'HOLD' },
  });
  assert.equal(padChecklist(newStore()).status.text, 'HOLD', 'no rocket at all');
});

test('the pad checklist: every line good is READY', () => {
  const store = newStore();
  for (let t = 1; t <= 15; t++) store.addSample(padSample(t));
  assert.equal(flightState(store).state, STATE.PAD);
  assert.deepEqual(padChecklist(store), {
    gps: { ok: true, text: '12 SAT' },
    hdop: { ok: true, text: '1.45' },
    link: { ok: true, text: '1 PKT/S' },
    status: { ok: true, text: 'READY' },
  });
});

test('the pad checklist thresholds come from config.js, edges included', () => {
  const at = (opts) => {
    const store = newStore();
    for (let t = 1; t <= 15; t++) store.addSample(padSample(t, opts));
    return padChecklist(store);
  };
  assert.equal(at({ sats: config.PAD_READY_MIN_SATS }).gps.ok, true);
  const few = at({ sats: config.PAD_READY_MIN_SATS - 1 });
  assert.deepEqual(few.gps, { ok: false, text: `${config.PAD_READY_MIN_SATS - 1} SAT` });
  assert.equal(few.status.text, 'HOLD');
  assert.equal(at({ hdop: config.PAD_READY_MAX_HDOP }).hdop.ok, true);
  const poor = at({ hdop: config.PAD_READY_MAX_HDOP + 0.2 });
  assert.deepEqual(poor.hdop, { ok: false, text: (config.PAD_READY_MAX_HDOP + 0.2).toFixed(2) });
  assert.equal(poor.status.text, 'HOLD');

  // One packet every 2 s is exactly the 0.5 a second LINK needs. One every
  // 4 s is not.
  const rate = (every) => {
    const store = newStore();
    for (let t = 1; t <= 41; t += every) store.addSample(padSample(t));
    return padChecklist(store).link;
  };
  assert.deepEqual(rate(2), { ok: true, text: '0.5 PKT/S' });
  assert.deepEqual(rate(4), { ok: false, text: '0.3 PKT/S' });
});

test('the fix lost on the pad, and a board gone quiet, turn their lines amber', () => {
  const store = newStore();
  for (let t = 1; t <= 15; t++) store.addSample(padSample(t));
  store.addSample(padSample(16, { fix: 0, sats: 3 }));
  let list = padChecklist(store);
  assert.deepEqual(list.gps, { ok: false, text: 'NO FIX, 3 SAT' });
  assert.deepEqual(list.hdop, { ok: false, text: '--' });
  assert.equal(list.link.ok, true, 'packets still arrive');
  assert.equal(list.status.text, 'HOLD');
  assert.equal(flightState(store).state, STATE.PAD, 'still on the pad');

  // Then nothing for 12 s.
  store.setTime(28);
  list = padChecklist(store);
  assert.deepEqual(list.link, { ok: false, text: 'NO PACKETS, 12 S' });
  assert.deepEqual(list.gps, { ok: false, text: 'NO FIX' });
  assert.equal(flightState(store).silent, true);
  assert.equal(flightState(store).state, STATE.PAD);
});

// A simple flight with no wander: on the pad at P for 60 s, straight up at
// 100 m/s to 1000 m, then down at 25 m/s while drifting to Q, then 60 s
// sitting at Q. Q is 840 m from gs at a bearing of 62 degrees, and P is
// 500 m west of Q.
function simpleFlight(gs, { speed = false } = {}) {
  const Q = destinationPoint(gs.lat, gs.lon, 62, 840);
  const P = destinationPoint(Q.lat, Q.lon, 270, 500);
  const samples = [];
  let i = 0;
  const push = (t, lat, lon, up, v = null) => samples.push(makeSample({
    t, seq: i++, fix: 1, lat, lon, altMsl: SITE.altMsl + up, sats: 10, hdop: 1, stale: 0, speed: speed ? v : null,
  }));
  for (let t = 1; t <= 60; t++) push(t, P.lat, P.lon, 0, 0);
  for (let k = 1; k <= 10; k++) push(60 + k, P.lat, P.lon, 100 * k, 1);
  for (let k = 1; k <= 40; k++) {
    const f = k / 40;
    push(70 + k, P.lat + (Q.lat - P.lat) * f, P.lon + (Q.lon - P.lon) * f, 1000 - 25 * k, 12.5);
  }
  for (let k = 1; k <= 60; k++) push(110 + k, Q.lat, Q.lon, 0, 0);
  return { samples, P, Q, touchdownT: 110 };
}

test('recovery: distance and bearing from Manta, the HUD words, and the links', () => {
  const gs = { lat: -8.5374, lon: 119.5724, altMsl: 2 };
  const { samples, Q, touchdownT } = simpleFlight(gs);
  const store = newStore({ groundStation: gs });
  let before = null;
  for (const s of samples) {
    store.addSample(s);
    if (s.t === touchdownT) before = recoveryInfo(store);
  }
  assert.equal(before, null, 'nothing before the landing');
  assert.equal(flightState(store).state, STATE.RECOVERY);
  const info = recoveryInfo(store);
  assert.equal(info.from, 'manta');
  assert.ok(distanceM(info.position.lat, info.position.lon, Q.lat, Q.lon) < 0.01);
  assert.ok(info.fixCount >= 15);
  assert.equal(info.text.distance, '840 M FROM MANTA');
  assert.equal(info.text.bearing, '062° (ENE)');
  assert.equal(info.coordsText, `${Q.lat.toFixed(6)}, ${Q.lon.toFixed(6)}`);
  assert.equal(info.mapsUrl, `https://www.google.com/maps/search/?api=1&query=${Q.lat.toFixed(6)},${Q.lon.toFixed(6)}`);
  // LAST FIX counts on the store's clock.
  store.setTime(samples[samples.length - 1].t + 12);
  assert.equal(recoveryInfo(store).text.lastFix, '0:12 AGO');
  assert.equal(recoveryInfo(store).lastFixAgeS, 12);
});

test('recovery: from the launch point when there is no Manta position', () => {
  const { samples, P } = simpleFlight({ lat: SITE.lat, lon: SITE.lon });
  const store = newStore({ groundStation: null });
  store.addSamples(samples);
  const info = recoveryInfo(store);
  assert.equal(info.from, 'launch');
  const pad = store.getFocused().padPosition;
  assert.ok(distanceM(pad.lat, pad.lon, P.lat, P.lon) < 0.01, 'the launch point is the pad');
  assert.equal(info.text.distance, '500 M FROM LAUNCH POINT');
  assert.equal(info.text.bearing, '090° (E)');
});

test('three-digit bearings with 16-point compass names, and distances in caps', () => {
  const cases = [
    [0, '000° (N)'], [11, '011° (N)'], [12, '012° (NNE)'], [45, '045° (NE)'], [62, '062° (ENE)'],
    [90, '090° (E)'], [135, '135° (SE)'], [180, '180° (S)'], [202.5, '203° (SSW)'], [247, '247° (WSW)'],
    [270, '270° (W)'], [315, '315° (NW)'], [337, '337° (NNW)'], [359.6, '000° (N)'], [-90, '270° (W)'], [720, '000° (N)'],
  ];
  for (const [deg, text] of cases) assert.equal(formatBearing(deg), text, `${deg} degrees`);
  assert.equal(formatBearing(null), '--');
  // The readings lists and the NO MAP panel write bearings the same way.
  assert.equal(formatRangeBearing({ distanceM: 398.4, bearingDeg: 102.9 }), '398 m, bearing 103° (ESE)');
  assert.equal(formatRangeBearing(null), '--');
  assert.equal(formatDistanceCaps(840), '840 M');
  assert.equal(formatDistanceCaps(0), '0 M');
  assert.equal(formatDistanceCaps(999.4), '999 M');
  assert.equal(formatDistanceCaps(999.6), '1.00 KM');
  assert.equal(formatDistanceCaps(1240), '1.24 KM');
  assert.equal(formatDistanceCaps(NaN), '--');
});

test('the readings lists\' range row: the newest fix before recovery, the HUD\'s answer in recovery', () => {
  const gs = { lat: -8.5374, lon: 119.5724, altMsl: 2 };
  const { samples, touchdownT } = simpleFlight(gs);
  const store = newStore({ groundStation: gs });
  for (const s of samples) {
    store.addSample(s);
    if (s.t === touchdownT - 20) {
      // In flight: from Manta to the newest good fix.
      const fix = store.getFocused().lastGoodFix;
      const r = rangeReading(store);
      assert.equal(r.from, 'manta');
      assert.equal(r.recovery, false);
      assert.ok(Math.abs(r.distanceM - distanceM(gs.lat, gs.lon, fix.lat, fix.lon)) < 1e-6);
    }
  }
  assert.equal(flightState(store).state, STATE.RECOVERY);
  // A fix that wanders off after the landing window moves the newest fix,
  // but not the row: it keeps the HUD's distance and bearing.
  const last = samples[samples.length - 1];
  const off = destinationPoint(last.gps.lat, last.gps.lon, 0, 6);
  store.addSample(makeSample({ ...last.gps, t: last.t + 1, seq: (last.extra?.seq ?? 0) + 1, lat: off.lat, lon: off.lon }));
  const info = recoveryInfo(store);
  const r = rangeReading(store);
  assert.deepEqual(r, { from: 'manta', demo: false, recovery: true, distanceM: info.distanceM, bearingDeg: info.bearingDeg });
  assert.equal(formatBearing(r.bearingDeg), info.text.bearing);
});

test('the range row without a Manta position: hidden before recovery, from the launch point in it', () => {
  const { samples } = simpleFlight({ lat: SITE.lat, lon: SITE.lon });
  const store = newStore({ groundStation: null });
  store.addSamples(samples.filter((s) => s.t <= 100));
  assert.equal(rangeReading(store), null, 'no Manta, no row');
  store.addSamples(samples.filter((s) => s.t > 100));
  const info = recoveryInfo(store);
  const r = rangeReading(store);
  assert.equal(info.from, 'launch');
  assert.equal(r.from, 'launch');
  assert.equal(r.distanceM, info.distanceM);
  assert.equal(r.bearingDeg, info.bearingDeg);
  assert.equal(rangeReading(newStore()), null, 'no rocket at all');
});

test('the HUD\'s GPS line is amber with no fix or too few satellites for the quality gate', () => {
  assert.equal(gpsLineWarn(true, config.MIN_SATS, config.MIN_SATS), false);
  assert.equal(gpsLineWarn(true, 12, config.MIN_SATS), false);
  assert.equal(gpsLineWarn(true, config.MIN_SATS - 1, config.MIN_SATS), true);
  assert.equal(gpsLineWarn(true, 4, config.MIN_SATS), true);
  assert.equal(gpsLineWarn(false, 12, config.MIN_SATS), true);
  assert.equal(gpsLineWarn(true, null, config.MIN_SATS), false, 'a count that isn\'t known only leaves the fix');
  assert.equal(gpsLineWarn(false, null, config.MIN_SATS), true);
});

test('the link going quiet in flight stays FLIGHT, marked silent', () => {
  const { samples, truth } = flightSamples(3);
  const store = newStore();
  store.addSamples(samples.filter((s) => s.t <= truth.apogeeT + 10));
  assert.equal(flightState(store).state, STATE.FLIGHT);
  assert.equal(flightState(store).silent, false);
  store.setTime(truth.apogeeT + 40);
  const st = flightState(store);
  assert.equal(st.state, STATE.FLIGHT);
  assert.equal(st.silent, true);
  assert.equal(st.sinceT, store.getFocused().derived.liftoffT);
});

test('a replay seeking backward follows the data to the new time', () => {
  const { samples, truth } = flightSamples(4);
  const store = newStore();
  const player = createPlayer({ store, requestFrame: null, cancelFrame: null, clock: () => 0 });
  player.load(samples);
  const end = samples[samples.length - 1].t;
  const check = (t, state) => {
    player.seek(t);
    const rocket = store.getFocused();
    assert.equal(flightState(store).state, state, `at t = ${t.toFixed(1)}`);
    // Everything was fed again from the start, once.
    assert.equal(rocket.samples.length, samples.filter((s) => s.t <= t).length);
    assert.equal(rocket.crumbs.length, samples.filter((s) => s.t <= t && s.gps.fix === 1).length);
  };
  check(end, STATE.RECOVERY);
  check(truth.liftoffT - 10, STATE.PAD);
  check(truth.apogeeT, STATE.FLIGHT);
  check(truth.touchdownT + 5, STATE.FLIGHT);
  check(end, STATE.RECOVERY);
  check(samples[0].t, STATE.PAD);
  assert.equal(recoveryInfo(store), null);
});

test('a board restart starts over on the pad', () => {
  const store = newStore(LIVE_STORE_OPTIONS.bench);
  const clock = { ms: 0 };
  const feed = createLiveFeed({ store, clock: () => clock.ms, every: null });
  const parser = new BlockParser();
  const send = (sample, beat) => {
    clock.ms = Math.round(sample.t * 1000);
    for (const line of statusBlockLines(sample, beat)) {
      const r = parser.push(line, clock.ms);
      if (r.done) feed.push(r.done);
    }
  };
  // A whole flight over USB, up to well after liftoff.
  const { samples, truth } = flightSamples(6, { boostFixLoss: false });
  let beat = 1;
  for (const s of samples.filter((x) => x.t <= truth.liftoffT + 20)) send(s, beat++);
  assert.equal(flightState(store).state, STATE.FLIGHT);
  // The board restarts: TIME RUNNING and the heartbeat count go back.
  send(padSample(1.3), 1);
  assert.equal(feed.restarts, 1);
  assert.equal(store.getFocused().samples.length, 1);
  assert.equal(flightState(store, store.getFocused(), { connected: true }).state, STATE.PAD);
  assert.deepEqual(store.getEvents(), []);
});

test('data that starts in flight is FLIGHT, and lands to RECOVERY', () => {
  const { samples, truth } = flightSamples(8, { boostFixLoss: false });
  // Starting under the drogue, 20 s after apogee.
  const falling = newStore();
  const states = new Set();
  for (const s of samples.filter((x) => x.t >= truth.apogeeT + 20)) {
    falling.addSample(s);
    states.add(flightState(falling).state);
  }
  assert.deepEqual([...states], [STATE.PAD, STATE.FLIGHT, STATE.RECOVERY]);
  const st = flightState(falling);
  assert.equal(st.startedInFlight, true);
  assert.equal(falling.getFocused().padPosition, null, 'no launch point was ever seen');
  assert.equal(recoveryInfo(falling).from, 'manta');
  // Starting in the coast, still climbing fast.
  const climbing = newStore();
  climbing.addSamples(samples.filter((x) => x.t >= truth.liftoffT + 6 && x.t <= truth.apogeeT - 5));
  assert.equal(flightState(climbing).state, STATE.FLIGHT);
  assert.equal(flightState(climbing).startedInFlight, true);
});

test('ground speed: the receiver\'s own when the packet has it, else from the fixes', () => {
  const withSpeed = newStore();
  for (let t = 1; t <= 10; t++) withSpeed.addSample(makeSample({ t, fix: 1, lat: SITE.lat, lon: SITE.lon + t * 1e-4, altMsl: 700, sats: 9, hdop: 1, speed: 0.12 }));
  assert.deepEqual(groundSpeed(withSpeed), { mps: 0.12, source: 'board' });
  const noSpeed = newStore();
  for (let t = 1; t <= 10; t++) noSpeed.addSample(makeSample({ t, fix: 1, lat: SITE.lat, lon: SITE.lon + t * 1e-4, altMsl: 700, sats: 9, hdop: 1 }));
  const gsp = groundSpeed(noSpeed);
  assert.equal(gsp.source, 'fixes');
  assert.ok(Math.abs(gsp.mps - distanceM(SITE.lat, SITE.lon, SITE.lat, SITE.lon + 1e-4)) < 0.01);
  noSpeed.addSample(makeSample({ t: 11, fix: 0, sats: 3 }));
  assert.deepEqual(groundSpeed(noSpeed), { mps: null, source: null }, 'no fix, no speed');
});

test('eventCrumb finds the good crumb at an event, or none in a gap', () => {
  const tr = createCrumbTrail();
  const rocket = { crumbs: tr.crumbs };
  for (let t = 1; t <= 10; t++) tr.push(makeSample({ t, fix: 1, lat: SITE.lat, lon: SITE.lon, altMsl: 700 + t, sats: 9, hdop: 1 }));
  for (let t = 40; t <= 50; t++) tr.push(makeSample({ t, fix: 1, lat: SITE.lat, lon: SITE.lon, altMsl: 700 + t, sats: 9, hdop: 1 }));
  assert.equal(eventCrumb(rocket, { t: 5 }).t, 5);
  assert.equal(eventCrumb(rocket, { t: 5.4 }).t, 5);
  assert.equal(eventCrumb(rocket, { t: 11.5 }).t, 10);
  assert.equal(eventCrumb(rocket, { t: 25 }), null, 'in the gap');
  assert.equal(eventCrumb(rocket, { t: 60 }), null, 'after the data');
  assert.equal(eventCrumb(rocket, null), null);
});

test('packetRate counts packets over the window on the store\'s clock', () => {
  const store = newStore();
  assert.equal(packetRate(store, null), null);
  store.addSample(padSample(1));
  assert.equal(packetRate(store, store.getFocused()), 1, 'one packet at the start is 1 a second, not 0.1');
  for (let t = 2; t <= 30; t++) store.addSample(padSample(t));
  assert.equal(packetRate(store, store.getFocused()), 1);
  store.setTime(35);
  assert.equal(packetRate(store, store.getFocused()), 0.5);
});
