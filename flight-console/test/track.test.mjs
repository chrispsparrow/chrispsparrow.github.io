// Checks js/track.js, the breadcrumb trail: the quality gate, outlier
// rejection, the smoothed line (dots stay raw), gaps, speeds and the
// speed colors.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/track.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrumbTrail, speedColor, rampColor, TRACK_RAMP, distance3dM } from '../js/track.js';
import { createStore } from '../js/store.js';
import { createFleet } from '../js/fleet.js';
import { makeSample, SITE, metersPerDegLon, benchSamples } from './synthetic.mjs';
import { distanceM } from '../js/geo.js';
import * as config from '../js/config.js';

// A good fix east and north of the site (m), at altitude up (m above it).
function fix(t, { east = 0, north = 0, up = 0, seq = null, sats = 9, hdop = 1.2, stale = 0, fix: f = 1, speed = null } = {}) {
  return makeSample({
    t, seq, fix: f, sats, hdop, stale, speed,
    lat: SITE.lat + north / 110574,
    lon: SITE.lon + east / metersPerDegLon(SITE.lat),
    altMsl: SITE.altMsl + up,
  });
}
const noFix = (t, seq = null) => makeSample({ t, seq, fix: 0, sats: 3 });

function trail(samples, overrides) {
  const tr = createCrumbTrail(overrides);
  for (const s of samples) tr.push(s);
  return tr.crumbs;
}

test('the quality gate: a 3D fix, enough satellites and a low enough HDOP', () => {
  const crumbs = trail([
    fix(1),
    fix(2, { sats: config.MIN_SATS }),                 // exactly enough
    fix(3, { sats: config.MIN_SATS - 1 }),             // too few
    fix(4, { hdop: config.MAX_HDOP }),                 // exactly the limit
    fix(5, { hdop: config.MAX_HDOP + 0.01 }),          // too high
    fix(6, { hdop: null }),                            // HDOP unknown
    fix(7, { stale: 1 }),                              // the altitude isn't fresh: not a 3D fix
    makeSample({ t: 8, fix: 1, lat: SITE.lat, lon: SITE.lon, altMsl: null, sats: 9, hdop: 1 }),  // no altitude
  ]);
  assert.deepEqual(crumbs.map((c) => c.quality), ['good', 'good', 'weak', 'good', 'weak', 'weak', 'weak', 'weak']);
  for (const c of crumbs) {
    if (c.quality === 'weak') {
      assert.equal(c.line, null, 'weak fixes never join the line');
      assert.equal(c.speedMps, null);
    } else {
      assert.ok(c.line);
    }
  }
  // A source that sends neither a satellite count nor an HDOP (a plain
  // CSV) is judged on the 3D fix alone.
  const plain = trail([fix(1, { sats: null, hdop: null }), fix(2, { sats: null, hdop: null, stale: 1 })]);
  assert.deepEqual(plain.map((c) => c.quality), ['good', 'weak']);
  // A sample with GPS but no position makes no crumb.
  assert.equal(trail([noFix(1)]).length, 0);
});

test('outliers: an impossible jump is skipped, normal wander is not', () => {
  const crumbs = trail([
    fix(1, { seq: 0 }),
    fix(2, { seq: 1, east: 25 }),         // 25 m in a second: wander
    fix(3, { seq: 2, east: 2000 }),       // 2 km in a second: impossible
    fix(4, { seq: 3, east: 10 }),
  ]);
  assert.deepEqual(crumbs.map((c) => c.quality), ['good', 'good', 'outlier', 'good']);
  assert.equal(crumbs[2].line, null);
  assert.equal(crumbs[2].speedMps, null);
  // The next good fix is measured from the last GOOD one, 2 s before it.
  assert.ok(Math.abs(crumbs[3].speedMps - 15 / 2) < 0.05, `speed ${crumbs[3].speedMps}`);
  assert.equal(crumbs[3].gapBefore, false, 'an outlier is not a gap');

  // A fast but possible climb (300 m/s) is no outlier.
  const fast = trail([fix(1), fix(2, { up: 300 }), fix(3, { up: 600 })]);
  assert.deepEqual(fast.map((c) => c.quality), ['good', 'good', 'good']);
  // Faster than the limit is, even straight up.
  const tooFast = trail([fix(1), fix(2, { up: config.OUTLIER_MAX_SPEED_MPS + 50 })]);
  assert.equal(tooFast[1].quality, 'outlier');
});

test('outliers that agree with each other mean the last good fix was the wrong one', () => {
  // The first fix is 5 km off. The real ones after it agree with each other.
  const crumbs = trail([
    fix(1, { east: 5000 }),
    fix(2), fix(3, { east: 1 }), fix(4, { east: 2 }), fix(5, { east: 3 }),
  ]);
  assert.deepEqual(crumbs.map((c) => c.quality), ['good', 'outlier', 'outlier', 'good', 'good']);
  assert.equal(crumbs[3].gapBefore, true, 'the line starts again there');
  assert.equal(crumbs[3].speedMps, null, 'no speed from the wrong fix');
  assert.ok(crumbs[4].speedMps < 2);
});

test('the line is smoothed, the dots stay raw, and the smoothing never crosses a gap', () => {
  const raw = [
    fix(1, { seq: 0, east: 0 }), fix(2, { seq: 1, east: 6 }), fix(3, { seq: 2, east: 0 }), fix(4, { seq: 3, east: 6 }),
    // seq 4 never arrives
    fix(6, { seq: 5, east: 0 }), fix(7, { seq: 6, east: 6 }),
  ];
  const crumbs = trail(raw);
  // Dots: exactly the board's numbers.
  crumbs.forEach((c, i) => {
    assert.equal(c.lat, raw[i].gps.lat);
    assert.equal(c.lon, raw[i].gps.lon);
    assert.equal(c.altMsl, raw[i].gps.altMsl);
  });
  const eastOf = (p) => (p.lon - SITE.lon) * metersPerDegLon(SITE.lat);
  // The line: the moving average of the last three good fixes of the run.
  assert.ok(Math.abs(eastOf(crumbs[0].line) - 0) < 1e-6);
  assert.ok(Math.abs(eastOf(crumbs[1].line) - 3) < 1e-6);
  assert.ok(Math.abs(eastOf(crumbs[2].line) - 2) < 1e-6);
  assert.ok(Math.abs(eastOf(crumbs[3].line) - 4) < 1e-6);
  // After the gap the run starts over: no averaging across it.
  assert.equal(crumbs[4].gapBefore, true);
  assert.ok(Math.abs(eastOf(crumbs[4].line) - 0) < 1e-6);
  assert.ok(Math.abs(eastOf(crumbs[5].line) - 3) < 1e-6);

  // On a still board the line wanders less than the dots.
  const bench = trail(benchSamples(3, { minutes: 10 }));
  const good = bench.filter((c) => c.quality === 'good' && !c.gapBefore);
  const step = (a, b) => distanceM(a.lat, a.lon, b.lat, b.lon);
  let dots = 0;
  let line = 0;
  for (let i = 1; i < good.length; i++) {
    dots += step(good[i - 1], good[i]);
    line += step(good[i - 1].line, good[i].line);
  }
  assert.ok(line < dots * 0.8, `line ${line.toFixed(0)} m, dots ${dots.toFixed(0)} m`);
});

test('the line keeps up with a fast rocket: never more than LINE_SMOOTH_MAX_M from its fix', () => {
  const crumbs = trail([0, 1, 2, 3, 4, 5].map((i) => fix(1 + i, { up: i * i * 40 })));
  for (const c of crumbs) {
    const d = distance3dM(c, c.line);
    assert.ok(d <= config.LINE_SMOOTH_MAX_M + 1e-6, `line ${d.toFixed(1)} m from its fix`);
  }
  // Under parachute (6 m/s) the line is the plain average.
  const slow = trail([0, 1, 2].map((i) => fix(1 + i, { up: -6 * i })));
  assert.ok(Math.abs(slow[2].line.altMsl - (SITE.altMsl - 6)) < 1e-9);
});

test('gaps: a skipped sequence number, a long silence, a lost fix, or weak fixes too long', () => {
  // Sequence numbers: 65535 is followed by 0 (no gap), a skipped number is a gap.
  const seq = trail([fix(1, { seq: 65534 }), fix(2, { seq: 65535 }), fix(3, { seq: 0 }), fix(4, { seq: 2 })]);
  assert.deepEqual(seq.map((c) => c.gapBefore), [false, false, false, true]);
  // With sequence numbers, a slow packet with the next number is no gap.
  const late = trail([fix(1, { seq: 7 }), fix(2.4, { seq: 8 })]);
  assert.equal(late[1].gapBefore, false);
  // Without them, more than TRACK_GAP_S between GPS samples is a gap.
  const time = trail([fix(1), fix(2), fix(2 + config.TRACK_GAP_S + 0.1), fix(3 + config.TRACK_GAP_S + 0.1)]);
  assert.deepEqual(time.map((c) => c.gapBefore), [false, false, true, false]);
  // A sample with GPS but no position: the fix was lost.
  const lost = trail([fix(1, { seq: 0 }), noFix(2, 1), fix(3, { seq: 2 })]);
  assert.deepEqual(lost.map((c) => c.gapBefore), [false, true]);
  // One weak fix between two good ones is bridged (2 s). Three are not.
  const oneWeak = trail([fix(1, { seq: 0 }), fix(2, { seq: 1, sats: 3 }), fix(3, { seq: 2 })]);
  assert.deepEqual(oneWeak.map((c) => [c.quality, c.gapBefore]), [['good', false], ['weak', false], ['good', false]]);
  const threeWeak = trail([fix(1, { seq: 0 }), fix(2, { seq: 1, sats: 3 }), fix(3, { seq: 2, sats: 3 }), fix(4, { seq: 3, sats: 3 }), fix(5, { seq: 4 })]);
  assert.equal(threeWeak[4].gapBefore, true);
  // A gap before a weak fix also breaks the line at the next good one.
  const gapThenWeak = trail([fix(1, { seq: 0 }), fix(3, { seq: 2, sats: 3 }), fix(4, { seq: 3 })]);
  assert.deepEqual(gapThenWeak.map((c) => c.gapBefore), [false, true, true]);
  // The same packet twice makes one crumb.
  assert.equal(trail([fix(1, { seq: 5 }), fix(1, { seq: 5 })]).length, 1);
});

test('speeds: from the last good fix, across a short gap, unknown after a long one', () => {
  const crumbs = trail([
    fix(1, { seq: 0 }),
    fix(2, { seq: 1, east: 30, up: 40 }),       // 50 m in 1 s
    fix(5, { seq: 4, east: 30, up: 340 }),      // 300 m in 3 s, across a gap
    fix(30, { seq: 29, east: 30, up: 400 }),    // after a 25 s gap
    fix(31, { seq: 30, east: 30, up: 395, speed: 0.2 }),
  ]);
  assert.equal(crumbs[0].speedMps, null, 'the first fix has no speed');
  assert.ok(Math.abs(crumbs[1].speedMps - 50) < 0.1);
  assert.equal(crumbs[2].gapBefore, true);
  assert.ok(Math.abs(crumbs[2].speedMps - 100) < 0.1, 'the average speed across a short gap');
  assert.equal(crumbs[3].gapBefore, true);
  assert.equal(crumbs[3].speedMps, null, `unknown after more than ${config.TRACK_SPEED_GAP_MAX_S} s`);
  assert.ok(Math.abs(crumbs[4].speedMps - 5) < 0.1, 'speed through the air, falling counts too');
  assert.equal(crumbs[4].groundSpeedMps, 0.2, 'the receiver\'s own ground speed is kept as sent');
});

test('speed colors run along the thermal ramp, slow purple to fast pale yellow', () => {
  assert.equal(TRACK_RAMP.length, config.THERMAL_RAMP.length - 2);
  assert.equal(speedColor(0).toLowerCase(), TRACK_RAMP[0].toLowerCase());
  assert.equal(speedColor(null).toLowerCase(), TRACK_RAMP[0].toLowerCase(), 'unknown speed is the slow end');
  assert.equal(speedColor(config.TRACK_SPEED_MAX_MPS).toLowerCase(), TRACK_RAMP[TRACK_RAMP.length - 1].toLowerCase());
  assert.equal(speedColor(10 * config.TRACK_SPEED_MAX_MPS), speedColor(config.TRACK_SPEED_MAX_MPS), 'faster stays at the top');
  assert.match(speedColor(42), /^#[0-9a-f]{6}$/);
  // Faster is always brighter.
  const brightness = (hex) => [1, 3, 5].reduce((sum, i) => sum + parseInt(hex.slice(i, i + 2), 16), 0);
  let prev = -1;
  for (let v = 0; v <= config.TRACK_SPEED_MAX_MPS; v += 5) {
    const b = brightness(speedColor(v));
    assert.ok(b >= prev, `brighter at ${v} m/s`);
    prev = b;
  }
  assert.equal(rampColor(0.5, ['#000000', '#ffffff']), '#808080');
});

test('the store keeps one trail per rocket and leaves the samples (and so the CSV) raw', () => {
  const store = createStore({ fleet: createFleet() });
  const samples = benchSamples(9, { minutes: 3 });
  const copies = samples.map((s) => JSON.stringify(s));
  store.addSamples(samples);
  const rocket = store.getRocket('1');
  assert.equal(rocket.crumbs, rocket.trail.crumbs);
  assert.equal(rocket.crumbs.length, samples.filter((s) => s.gps.fix === 1).length);
  samples.forEach((s, i) => assert.equal(JSON.stringify(s), copies[i], 'samples are never changed'));
  // After reset() (a replay seeking), the rocket starts a new, empty trail.
  store.reset();
  assert.equal(store.getRocket('1').crumbs.length, 0);
});
