// Checks that a board sitting still on a desk stays on its pad, however
// much its GPS wanders: never liftoff, never FLIGHT or RECOVERY. On my
// bench a still board wandered 15 m by 30 m sideways, and GPS altitude
// wanders a few times more than that, with jumps (see synthetic.mjs).
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/bench-wander.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { benchSamples, statusBlockLines, makeSample, SITE, metersPerDegLon } from './synthetic.mjs';
import { createStore } from '../js/store.js';
import { createFleet } from '../js/fleet.js';
import { createDetector } from '../js/detector.js';
import { flightState, STATE } from '../js/flight-state.js';
import { createLiveFeed, LIVE_STORE_OPTIONS } from '../js/live/bench-feed.js';
import { BlockParser } from '../js/bench/parse.js?v=4';
import { distanceM } from '../js/geo.js';

// The two stores the page makes: a replay's (the default) and the live
// board's on USB.
const STORES = {
  default: () => createStore({ fleet: createFleet() }),
  'live bench': () => createStore({ fleet: createFleet(), ...LIVE_STORE_OPTIONS.bench }),
};

// Feeds samples one at a time and keeps every state seen.
function run(store, samples) {
  const states = new Set();
  for (const s of samples) {
    store.addSample(s);
    states.add(flightState(store, store.getFocused(), { connected: true }).state);
  }
  return states;
}

const flightEvents = (store) => store.getEvents().filter((e) => !e.type.startsWith('gps_'));

test('the synthetic bench data wanders as much as my board did', () => {
  // So the tests below mean something: the wander really is about 15 m by
  // 30 m sideways and a few times that in altitude, with jumps.
  const samples = benchSamples(7, { minutes: 30 }).filter((s) => s.gps.fix === 1);
  const east = samples.map((s) => (s.gps.lon - SITE.lon) * metersPerDegLon(SITE.lat));
  const north = samples.map((s) => (s.gps.lat - SITE.lat) * 110574);
  const up = samples.map((s) => s.gps.altMsl - SITE.altMsl);
  const spread = (v) => {
    const sorted = [...v].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.99)] - sorted[Math.floor(sorted.length * 0.01)];
  };
  assert.ok(spread(east) >= 12 && spread(east) <= 25, `east-west spread ${spread(east).toFixed(1)} m`);
  assert.ok(spread(north) >= 24 && spread(north) <= 40, `north-south spread ${spread(north).toFixed(1)} m`);
  assert.ok(spread(up) >= 2.5 * spread(north), `altitude spread ${spread(up).toFixed(1)} m`);
  let biggestJump = 0;
  for (let i = 1; i < up.length; i++) biggestJump = Math.max(biggestJump, Math.abs(up[i] - up[i - 1]));
  assert.ok(biggestJump >= 25, `single altitude jumps of 25 m or more (biggest ${biggestJump.toFixed(1)} m)`);
  assert.ok(samples.length < 1800, 'the fix drops now and then');
});

test('a still board wandering for 30 minutes stays PAD, through both stores, over many seeds', () => {
  let runs = 0;
  for (let seed = 1; seed <= 24; seed++) {
    for (const groundSpeed of [false, true]) {
      const samples = benchSamples(seed, { minutes: 30, groundSpeed });
      for (const [name, make] of Object.entries(STORES)) {
        const store = make();
        const states = run(store, samples);
        const why = `seed ${seed}, ${groundSpeed ? 'with' : 'without'} ground speed, ${name} store`;
        assert.deepEqual([...states], [STATE.PAD], why);
        assert.deepEqual(flightEvents(store), [], `no flight events, ${why}`);
        const rocket = store.getFocused();
        assert.equal(rocket.derived.liftoffT, null, why);
        assert.equal(rocket.derived.phase, 'pad', why);
        // The launch point is the average of the pad fixes, so it sits
        // well inside the wander.
        assert.ok(rocket.padPosition, why);
        assert.ok(distanceM(SITE.lat, SITE.lon, rocket.padPosition.lat, rocket.padPosition.lon) < 25, why);
        runs++;
      }
    }
  }
  assert.equal(runs, 96);
});

test('the same wander through the USB status block text stays PAD', () => {
  // Line by line, the way the page gets it: BlockParser reads each line,
  // and createLiveFeed() puts each finished block in the live store.
  for (const seed of [101, 202]) {
    const samples = benchSamples(seed, { minutes: 30, seq: false });
    const store = createStore({ fleet: createFleet(), ...LIVE_STORE_OPTIONS.bench });
    const clock = { ms: 1_763_000_000_000 };
    const feed = createLiveFeed({ store, clock: () => clock.ms, every: null });
    const parser = new BlockParser();
    const states = new Set();
    samples.forEach((sample, i) => {
      clock.ms = 1_763_000_000_000 + Math.round(sample.t * 1000);
      for (const line of statusBlockLines(sample, i + 1)) {
        const r = parser.push(line, clock.ms);
        if (r.done) feed.push(r.done);
      }
      states.add(flightState(store, store.getFocused(), { connected: true }).state);
    });
    assert.equal(store.getTotals().samples, samples.length, `every block arrived, seed ${seed}`);
    assert.deepEqual([...states], [STATE.PAD], `seed ${seed}`);
    assert.deepEqual(flightEvents(store), [], `seed ${seed}`);
  }
});

// A desk board's GPS altitude with something odd in it, one reading a
// second for 10 minutes. alt(i) gives the altitude above the site.
function oddDesk(alt, { fixLost = () => false } = {}) {
  const out = [];
  for (let i = 0; i < 600; i++) {
    const t = 1 + i;
    if (fixLost(i)) {
      out.push(makeSample({ t, seq: i, fix: 0, sats: 3 }));
      continue;
    }
    out.push(makeSample({
      t, seq: i, fix: 1, lat: SITE.lat, lon: SITE.lon, altMsl: SITE.altMsl + alt(i), sats: 9, hdop: 1.1, stale: 0,
    }));
  }
  return out;
}

test('jumps, steps, slow climbs and a settling GPS are never a liftoff', () => {
  const cases = {
    'a 100 m jump for one reading': (i) => (i === 200 ? 100 : 0),
    'a 60 m step that stays': (i) => (i >= 200 ? 60 : 0),
    'a 150 m step that stays': (i) => (i >= 200 ? 150 : 0),
    'two jumps up in a row, then back': (i) => (i === 200 ? 50 : i === 201 ? 90 : 0),
    'carried up a building at 2 m/s for a minute': (i) => (i >= 200 ? Math.min(120, (i - 200) * 2) : 0),
    'an elevator at 5 m/s for 30 m': (i) => (i >= 200 ? Math.min(30, (i - 200) * 5) : 0),
    'first fixes 120 m too low, climbing back in 4 s': (i) => (i < 4 ? -120 + i * 30 : 0),
    'first fixes 120 m too high, settling down at 2 m/s': (i) => Math.max(0, 120 - i * 2),
    'a step 40 m down that stays': (i) => (i >= 200 ? -40 : 0),
    'sinking 2 m/s for a minute': (i) => (i >= 200 ? -Math.min(120, (i - 200) * 2) : 0),
  };
  for (const [name, alt] of Object.entries(cases)) {
    for (const [storeName, make] of Object.entries(STORES)) {
      const store = make();
      const states = run(store, oddDesk(alt));
      assert.deepEqual([...states], [STATE.PAD], `${name}, ${storeName} store`);
      assert.deepEqual(flightEvents(store), [], `${name}, ${storeName} store`);
    }
  }
});

test('the fix coming back higher after a loss is only a liftoff when it is far higher, fast', () => {
  const lost = (i) => i >= 200 && i < 203;
  // Back 120 m higher after 3 s: fast, but not far enough above the pad.
  const d1 = createDetector();
  for (const s of oddDesk((i) => (i >= 203 ? 120 : 0), { fixLost: lost })) d1.push(s);
  assert.equal(d1.getState().liftoffT, null);
  // Back 300 m higher after 30 s: far, but only 10 m/s.
  const d2 = createDetector();
  for (const s of oddDesk((i) => (i >= 230 ? 300 : 0), { fixLost: (i) => i >= 200 && i < 230 })) d2.push(s);
  assert.equal(d2.getState().liftoffT, null);
  // Back 300 m higher after 3 s, and the next reading is up there too: a
  // rocket that lost its fix in boost. T+0 is when the fix dropped.
  const d3 = createDetector();
  const events = [];
  for (const s of oddDesk((i) => (i >= 203 ? 300 + (i - 203) * 80 : 0), { fixLost: lost })) events.push(...d3.push(s));
  const liftoff = events.find((e) => e.type === 'liftoff');
  assert.ok(liftoff);
  assert.equal(liftoff.t, 201, 'the fix dropped at t = 201');
  assert.equal(liftoff.confirmedT, 205, 'confirmed by the second reading back');
  assert.equal(d3.getState().liftoffEstimated, true);
  // Back 300 m higher for one reading only, then at the pad again: a
  // glitch, not a liftoff.
  const d4 = createDetector();
  for (const s of oddDesk((i) => (i === 203 ? 300 : 0), { fixLost: lost })) d4.push(s);
  assert.equal(d4.getState().liftoffT, null);
});
