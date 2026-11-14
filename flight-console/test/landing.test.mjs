// Checks liftoff and landing detection on whole flights: synthetic ones
// that land into the same GPS wander a still board shows on my bench
// (synthetic.mjs), and the saved simulated flight in the library.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/landing.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { flightSamples, makeSample, SITE } from './synthetic.mjs';
import { createStore } from '../js/store.js';
import { createFleet } from '../js/fleet.js';
import { detectAll } from '../js/detector.js';
import { flightState, recoveryInfo, STATE } from '../js/flight-state.js';
import { LIVE_STORE_OPTIONS } from '../js/live/bench-feed.js';
import { hasGoodPosition } from '../js/schema.js';
import { distanceM, rangeAndBearing } from '../js/geo.js';
import { validateManifest, buildFlight } from '../js/library.js';
import { compareWithTruth } from '../js/truth-check.js';
import * as config from '../js/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FLIGHTS_DIR = path.resolve(HERE, '..', 'data', 'flights');

// Feeds a flight one sample at a time and notes when each state began.
function fly(samples, storeOptions = {}) {
  const store = createStore({ fleet: createFleet(), ...storeOptions });
  const firstAt = {};
  const order = [];
  for (const s of samples) {
    store.addSample(s);
    const { state } = flightState(store, store.getFocused(), { connected: true });
    if (!(state in firstAt)) { firstAt[state] = s.t; order.push(state); }
    else if (order[order.length - 1] !== state) order.push(state);
  }
  return { store, rocket: store.getFocused(), firstAt, order };
}

// The fixes the detector averages for the recovery position, worked out
// again here from the raw samples: every good fix from the touchdown to
// the confirmation, with the one farthest from the window's average set
// aside when the window holds 10 or more.
function expectedRecovery(samples, landed) {
  const windowStart = landed.confirmedT - config.LANDED_WINDOW_S;
  const inWindow = samples.filter((s) => hasGoodPosition(s) && s.t >= windowStart - 1.5 && s.t <= landed.confirmedT + 1e-6);
  // The detector's window keeps one reading at or before its start.
  const firstIndex = inWindow.findIndex((s) => s.t > windowStart + 1e-6);
  let fixes = inWindow.slice(Math.max(0, firstIndex - 1)).map((s) => ({ t: s.t, lat: s.gps.lat, lon: s.gps.lon }));
  if (fixes.length >= 10) {
    const lat = fixes.reduce((a, f) => a + f.lat, 0) / fixes.length;
    const lon = fixes.reduce((a, f) => a + f.lon, 0) / fixes.length;
    let worst = 0;
    fixes.forEach((f, i) => { if (distanceM(lat, lon, f.lat, f.lon) > distanceM(lat, lon, fixes[worst].lat, fixes[worst].lon)) worst = i; });
    fixes = fixes.filter((_, i) => i !== worst);
  }
  const pos = fixes.filter((f) => f.t >= landed.t - 1e-6);
  return {
    lat: pos.reduce((a, f) => a + f.lat, 0) / pos.length,
    lon: pos.reduce((a, f) => a + f.lon, 0) / pos.length,
    count: pos.length,
  };
}

test('whole flights that land into bench wander: FLIGHT at liftoff, RECOVERY within 30 s of touchdown', () => {
  const lags = [];
  const errors = [];
  for (let seed = 1; seed <= 40; seed++) {
    for (const groundSpeed of [false, true]) {
      for (const boostFixLoss of [true, false]) {
        const { samples, truth } = flightSamples(seed, { groundSpeed, boostFixLoss });
        const why = `seed ${seed}, ${groundSpeed ? 'with' : 'without'} ground speed, ${boostFixLoss ? 'fix lost in boost' : 'fix kept'}`;
        const { rocket, firstAt, order } = fly(samples);
        const d = rocket.derived;

        // The states come in order, once each, driven by the data.
        assert.deepEqual(order, [STATE.PAD, STATE.FLIGHT, STATE.RECOVERY], why);
        // FLIGHT within 6 s of the real liftoff, never before it.
        assert.ok(firstAt.flight > truth.liftoffT, why);
        assert.ok(firstAt.flight - truth.liftoffT <= 6, `${why}: FLIGHT ${(firstAt.flight - truth.liftoffT).toFixed(1)} s after liftoff`);
        assert.ok(Math.abs(d.liftoffT - truth.liftoffT) <= 2, `${why}: T+0 ${(d.liftoffT - truth.liftoffT).toFixed(1)} s off`);
        if (boostFixLoss) assert.equal(d.liftoffEstimated, true, `${why}: T+0 comes from the fix drop`);
        // RECOVERY within 30 s of touchdown, never before it.
        assert.ok(firstAt.recovery > truth.touchdownT, why);
        const lag = firstAt.recovery - truth.touchdownT;
        assert.ok(lag <= 30, `${why}: RECOVERY ${lag.toFixed(1)} s after touchdown`);
        lags.push(lag);
        // Every flight event exactly once.
        const types = rocket.events.filter((e) => !e.type.startsWith('gps_')).map((e) => e.type);
        assert.deepEqual(types, ['liftoff', 'apogee', 'drogue', 'main', 'landed'], why);
        assert.ok(Math.abs(d.events.apogee.t - truth.apogeeT) <= 3, `${why}: apogee`);

        // The recovery position is the average of the window's fixes, not
        // the last fix, and lands near the true landing point.
        const landing = d.landing;
        const expected = expectedRecovery(samples, d.events.landed);
        assert.equal(landing.fixCount, expected.count, why);
        assert.ok(Math.abs(landing.lat - expected.lat) < 1e-9 && Math.abs(landing.lon - expected.lon) < 1e-9, `${why}: the average of the window`);
        assert.equal(landing.fromT, d.events.landed.t, why);
        assert.equal(landing.toT, d.events.landed.confirmedT, why);
        assert.ok(landing.fixCount >= 15, `${why}: ${landing.fixCount} fixes`);
        const err = distanceM(landing.lat, landing.lon, truth.landing.lat, truth.landing.lon);
        errors.push(err);
        assert.ok(err <= 15, `${why}: ${err.toFixed(1)} m from the true landing point`);
      }
    }
  }
  const mean = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  // Printed for the record: how long the landing took to confirm, and how
  // far the recovery position was from the truth.
  console.log(`landing confirmed ${mean(lags).toFixed(1)} s after touchdown on average (max ${Math.max(...lags).toFixed(1)} s); ` +
    `recovery position ${mean(errors).toFixed(1)} m from the truth on average (max ${Math.max(...errors).toFixed(1)} m), over ${lags.length} flights`);
});

test('the live bench store sees the same flights the same way', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const { samples, truth } = flightSamples(seed, { groundSpeed: seed % 2 === 0 });
    const { rocket, order, firstAt } = fly(samples, LIVE_STORE_OPTIONS.bench);
    assert.deepEqual(order, [STATE.PAD, STATE.FLIGHT, STATE.RECOVERY], `seed ${seed}`);
    assert.ok(firstAt.recovery - truth.touchdownT <= 30, `seed ${seed}`);
    assert.ok(rocket.derived.landing.fixCount > 0);
  }
});

test('recovery distance and bearing come from Manta, or from the launch point without one', () => {
  const { samples } = flightSamples(5, { groundSpeed: true });
  // A replay store has a ground station (the demo position).
  const withGs = fly(samples).store;
  const info = recoveryInfo(withGs);
  const gs = withGs.getGroundStation();
  const rb = rangeAndBearing(gs, info.position);
  assert.equal(info.from, 'manta');
  assert.ok(Math.abs(info.distanceM - rb.distanceM) < 1e-6);
  assert.ok(Math.abs(info.bearingDeg - rb.bearingDeg) < 1e-6);
  assert.match(info.text.distance, /^\d[\d,.]* (M|KM) FROM MANTA$/);
  assert.match(info.text.bearing, /^\d{3}° \([NESW]{1,3}\)$/);
  // The live bench store has none, so it measures from the launch point.
  const live = fly(samples, LIVE_STORE_OPTIONS.bench).store;
  const info2 = recoveryInfo(live);
  const pad = live.getFocused().padPosition;
  assert.equal(info2.from, 'launch');
  assert.ok(Math.abs(info2.distanceM - rangeAndBearing(pad, info2.position).distanceM) < 1e-6);
  assert.match(info2.text.distance, / FROM LAUNCH POINT$/);
});

test('a low flight that never arms apogee still lands, once well below its peak', () => {
  // Up to about 95 m (under APOGEE_ARM_AGL_M), then down at 6 m/s.
  const samples = [];
  let alt = 0;
  for (let i = 0; i < 160; i++) {
    const t = 1 + i;
    if (i > 60 && i <= 62) alt += 45;
    else if (i === 63) alt += 5;
    else if (i > 66) alt = Math.max(0, alt - 6);
    samples.push(makeSample({ t, seq: i, fix: 1, lat: SITE.lat, lon: SITE.lon + i * 1e-6, altMsl: SITE.altMsl + alt, sats: 9, hdop: 1, stale: 0 }));
  }
  const { events, state } = detectAll(samples);
  const types = events.map((e) => e.type);
  assert.ok(state.maxAgl < config.APOGEE_ARM_AGL_M, `peak ${state.maxAgl} m`);
  assert.ok(types.includes('liftoff'));
  assert.ok(!types.includes('apogee'), 'apogee never armed');
  const landed = events.find((e) => e.type === 'landed');
  assert.ok(landed, 'landed once the altitude was far enough below the peak');
  // The ground is reached at t = 83. The reading before it, 5 m up, is
  // within LANDED_TOUCHDOWN_M of the settled altitude, so it counts too.
  assert.ok(Math.abs(landed.t - 83) <= 1, `touchdown at t = ${landed.t}`);
});

test('a board still moving along the ground (the receiver says so) is not landed yet', () => {
  // Down at 6 m/s, then dragged by its parachute at 3 m/s for a minute.
  // The position barely moves in the data (as if the GPS lagged), so only
  // the receiver's own ground speed shows it. Then it stops.
  const samples = [];
  let alt = 0;
  for (let i = 0; i < 300; i++) {
    const t = 1 + i;
    if (i > 60 && i <= 64) alt += 100;
    else if (i > 70) alt = Math.max(0, alt - 6);
    const onGround = i > 70 && alt === 0;
    const dragged = onGround && t < 200;
    samples.push(makeSample({
      t, seq: i, fix: 1, lat: SITE.lat, lon: SITE.lon, altMsl: SITE.altMsl + alt, sats: 9, hdop: 1, stale: 0,
      speed: dragged ? 3 : onGround ? 0.1 : i > 70 ? 4 : 0,
    }));
  }
  const landed = detectAll(samples).events.find((e) => e.type === 'landed');
  assert.ok(landed);
  assert.ok(landed.t >= 200, `the landing starts once the speed drops (t = ${landed.t})`);
  assert.ok(landed.confirmedT <= 200 + config.LANDED_WINDOW_S + 1);
  // Without the speed, the same data lands as soon as the altitude settles
  // (400 m at 6 m/s from t = 72 reaches the ground at about t = 138).
  const noSpeed = samples.map((s) => ({ ...s, gps: { ...s.gps, speed: null } }));
  const early = detectAll(noSpeed).events.find((e) => e.type === 'landed');
  assert.ok(early.t >= 135 && early.t <= 140, `t = ${early.t}`);
});

test('the saved simulated flight still detects every event near the truth', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(FLIGHTS_DIR, 'index.json'), 'utf8'));
  const entry = validateManifest(manifest).flights.find((f) => f.id === 'gps-board-sim-01');
  const texts = new Map(entry.rockets.map((r) => [r.file, fs.readFileSync(path.join(FLIGHTS_DIR, entry.id, r.file), 'utf8')]));
  const flight = buildFlight(entry, texts);
  const samples = flight.samples.filter((s) => s.rocketId === '1');
  const { events, state } = detectAll(samples);
  for (const row of compareWithTruth(events, flight.truth)) {
    assert.equal(row.count, 1, `${row.type} fires once`);
    assert.ok(Math.abs(row.diffS) <= 5, `${row.type} within 5 s of the truth (${row.diffS} s)`);
  }
  assert.equal(state.liftoffT, 32, 'T+0 from the fix drop in boost');
  assert.equal(state.liftoffEstimated, true);
  assert.equal(state.events.landed.t, 216);
  assert.ok(state.events.landed.confirmedT <= 216 + 21);
  // The simulator's board sits exactly still after landing, so every
  // window fix is the same point.
  assert.ok(state.landing.fixCount >= 15);
  const last = [...samples].reverse().find(hasGoodPosition);
  assert.ok(distanceM(state.landing.lat, state.landing.lon, last.gps.lat, last.gps.lon) < 0.01);
});
