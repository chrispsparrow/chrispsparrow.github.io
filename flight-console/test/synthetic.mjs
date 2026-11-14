// synthetic.mjs
// Made-up but realistic GPS data for the tests, from a seeded random
// number generator, so every run makes exactly the same numbers. Not a
// test file itself (its name doesn't end in .test.mjs), the tests import it.
//
//   makeRandom(seed)                  random numbers 0 to 1, the same for the same seed
//   createWander(rand)                where a still GPS thinks it is, over time
//   benchSamples(seed, options)       a still board on a desk, one sample a second
//   flightSamples(seed, options)      a whole flight that lands into the same wander
//   statusBlockLines(sample, beat)    one sample as the board's USB status block text
//
// The wander is what my bench board did: sitting still, its position moved
// around inside about 15 m east-west by 30 m north-south, and GPS altitude
// is worse than that. Here it is a sum of slow waves (a few tens of
// seconds to many minutes long) with random phases, plus jitter on every
// fix, plus the things a real receiver does now and then:
//   - one fix with its altitude 25 m to 60 m off (and, more rarely, its
//     position 30 m to 80 m off)
//   - a step of 3 m to 10 m in altitude when the satellites change, fading
//     over a couple of minutes
//   - the fix lost for 2 s to 40 s, coming back up to 30 m higher or lower,
//     fading over about 20 s
//   - a cold start: the first fixes 20 m to 60 m off in altitude (either
//     way) and up to 20 m off sideways, settling over about a minute
//   - the satellite count wandering between 4 and 14, with the HDOP to match
//
// Used by: bench-wander.test.mjs, landing.test.mjs and flight-state.test.mjs.

// Where the tests put the board: the simulator's placeholder launch site.
export const SITE = Object.freeze({ lat: 35.1234567, lon: -117.1234567, altMsl: 700 });

const M_PER_DEG_LAT = 110574;
export const metersPerDegLon = (lat) => 111320 * Math.cos((lat * Math.PI) / 180);

// A small, fast, seeded generator (mulberry32). Returns a function that
// gives numbers from 0 (included) to 1 (not included).
export function makeRandom(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (rand, a, b) => a + rand() * (b - a);
// A normal (bell curve) random number, from two uniform ones.
function gauss(rand) {
  const u = Math.max(1e-12, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// Slow waves for one axis: [period s, amplitude m]. The amplitudes add up
// to half the axis's full size, so the wave stays inside it.
const WAVES = {
  east: [[45, 2], [140, 2.5], [420, 3]],      // 15 m across
  north: [[55, 4], [170, 5], [480, 6]],       // 30 m across
  up: [[180, 5], [600, 12], [1500, 20]],      // 74 m across, a few times worse
};
// Jitter on every fix (m, one standard deviation).
const JITTER = { east: 1, north: 1, up: 2 };

// Where a still GPS thinks it is, as an offset in meters from the truth.
// wander.at(t, { fresh }) gives { dE, dN, dU } for a fix at time t. Call it
// once per fix, in time order: the jitter, spikes, steps and the cold start
// are worked out as it goes. wander.fixReturned(t) tells it the fix just
// came back after being lost.
export function createWander(rand, { coldStart = true } = {}) {
  const phase = {};
  for (const axis of Object.keys(WAVES)) phase[axis] = WAVES[axis].map(() => rand() * 2 * Math.PI);
  const steps = [];           // { t, dU } altitude steps that fade
  const returns = [];         // { t, dU } offsets after a lost fix, that fade
  const cold = coldStart
    ? { dU: between(rand, 20, 60) * (rand() < 0.5 ? -1 : 1), dE: between(rand, -20, 20), dN: between(rand, -20, 20) }
    : null;
  let t0 = null;

  function wave(axis, t) {
    return WAVES[axis].reduce((sum, [period, amp], i) => sum + amp * Math.sin((2 * Math.PI * t) / period + phase[axis][i]), 0);
  }

  function at(t) {
    if (t0 === null) t0 = t;
    // Now and then the satellites change and the altitude steps.
    if (rand() < 1 / 200) steps.push({ t, dU: between(rand, 3, 10) * (rand() < 0.5 ? -1 : 1) });
    let dE = wave('east', t) + JITTER.east * gauss(rand);
    let dN = wave('north', t) + JITTER.north * gauss(rand);
    let dU = wave('up', t) + JITTER.up * gauss(rand);
    for (const s of steps) dU += s.dU * Math.exp(-(t - s.t) / 120);
    for (const r of returns) dU += r.dU * Math.exp(-(t - r.t) / 20);
    if (cold) {
      const k = Math.exp(-(t - t0) / 40);
      dE += cold.dE * k;
      dN += cold.dN * k;
      dU += cold.dU * k;
    }
    // One wild fix.
    if (rand() < 1 / 300) dU += between(rand, 25, 60) * (rand() < 0.5 ? -1 : 1);
    if (rand() < 1 / 600) { dE += between(rand, 30, 80) * (rand() < 0.5 ? -1 : 1); dN += between(rand, -30, 30); }
    return { dE, dN, dU };
  }

  function fixReturned(t) {
    returns.push({ t, dU: between(rand, -30, 30) });
  }

  return { at, fixReturned };
}

// The satellite count and HDOP, wandering together.
function createSky(rand) {
  let sats = Math.round(between(rand, 7, 11));
  return function next() {
    if (rand() < 0.08) sats += rand() < 0.5 ? -1 : 1;
    sats = Math.max(4, Math.min(14, sats));
    const hdop = Math.max(0.6, 0.4 + 7 / sats + 0.15 * gauss(rand));
    return { sats, hdop: Math.round(hdop * 100) / 100 };
  };
}

// One normalized sample, shaped like parser.js makes them.
export function makeSample({ t, seq = null, fix, lat = null, lon = null, altMsl = null, sats = null, hdop = null, speed = null, course = null, stale = null, rocketId = '1' }) {
  return {
    rocketId,
    t,
    type: 'tlm',
    gps: { fix, sats, hdop, lat, lon, altMsl, speed, course, stale },
    baro: null,
    imu: null,
    radio: null,
    power: null,
    status: null,
    extra: seq === null ? null : { seq },
  };
}

// Turns true position plus wander into lat, lon and altitude.
function offsetPosition(site, eastM, northM, upM) {
  return {
    lat: site.lat + northM / M_PER_DEG_LAT,
    lon: site.lon + eastM / metersPerDegLon(site.lat),
    altMsl: site.altMsl + upM,
  };
}

// A board sitting still for `minutes` at one fix a second, with every
// kind of wander above, and the fix lost now and then.
//   groundSpeed  true: each fix carries the receiver's ground speed (near
//                0 for a still board, the radio packet's case). false: none
//                (the USB status block's case).
//   seq          true: each sample carries a packet sequence number
export function benchSamples(seed, { minutes = 30, groundSpeed = false, seq = true, site = SITE, startT = 0.3 } = {}) {
  const rand = makeRandom(seed);
  const wander = createWander(rand);
  const sky = createSky(rand);
  const out = [];
  let outageUntil = -Infinity;
  const count = Math.round(minutes * 60);
  for (let i = 0; i < count; i++) {
    const t = startT + i + between(rand, -0.02, 0.02);
    const { sats, hdop } = sky();
    // Now and then the fix drops for 2 s to 40 s.
    if (t >= outageUntil && rand() < 1 / 400) outageUntil = t + between(rand, 2, 40);
    const lost = t < outageUntil;
    if (lost) {
      out.push(makeSample({ t, seq: seq ? i % 65536 : null, fix: 0, sats: Math.min(sats, 3), hdop: null }));
      if (t + 1 >= outageUntil) wander.fixReturned(t + 1);
      continue;
    }
    const w = wander.at(t);
    const pos = offsetPosition(site, w.dE, w.dN, w.dU);
    out.push(makeSample({
      t, seq: seq ? i % 65536 : null, fix: 1, ...pos, sats, hdop, stale: 0,
      speed: groundSpeed ? Math.abs(0.15 * gauss(rand)) : null,
      course: groundSpeed ? Math.round(rand() * 360) : null,
    }));
  }
  return out;
}

// The true path of a rocket flight, worked out second by second.
//   padS        seconds on the pad before liftoff
//   boostAccel  m/s² during the boost, for boostS seconds
//   drogueMps, mainMps   descent rates under each parachute
//   mainAglM    height the main opens at
//   windMps, windDeg     drift under the parachutes
//   afterS      seconds sitting still after touchdown
// Returns { points: [{ t, east, north, up, hSpeed, vSpeed }], liftoffT,
// apogeeT, apogeeM, touchdownT, landing: { east, north } }, with t from 0.
export function flightPath(rand, {
  padS = between(rand, 120, 240),
  boostAccel = between(rand, 60, 100),
  boostS = between(rand, 2, 3.5),
  coastDecel = between(rand, 11, 14),
  drogueMps = between(rand, 20, 30),
  mainMps = between(rand, 5, 7),
  mainAglM = between(rand, 200, 400),
  windMps = between(rand, 2, 8),
  windDeg = rand() * 360,
  afterS = between(rand, 90, 180),
} = {}) {
  const dt = 0.05;   // fine steps for the physics, sampled at 1 Hz below
  const windE = windMps * Math.sin((windDeg * Math.PI) / 180);
  const windN = windMps * Math.cos((windDeg * Math.PI) / 180);
  let t = 0;
  let up = 0;
  let v = 0;
  let east = 0;
  let north = 0;
  let stage = 'pad';
  let apogeeT = null;
  let apogeeM = 0;
  let touchdownT = null;
  let landing = null;
  const liftoffT = padS;
  const points = [];
  let nextSample = 0;
  for (;;) {
    let hE = 0;
    let hN = 0;
    if (stage === 'pad' && t >= liftoffT) stage = 'boost';
    if (stage === 'boost') {
      v += boostAccel * dt;
      if (t >= liftoffT + boostS) stage = 'coast';
      // A little weathercocking into the wind on the way up.
      hE = -windE * 0.5;
      hN = -windN * 0.5;
    } else if (stage === 'coast') {
      v -= coastDecel * dt;
      hE = -windE * 0.5;
      hN = -windN * 0.5;
      if (v <= 0) { v = 0; stage = 'drogue'; apogeeT = t; apogeeM = up; }
    } else if (stage === 'drogue') {
      v = Math.max(-drogueMps, v - 9.8 * dt);
      hE = windE;
      hN = windN;
      if (up <= mainAglM) stage = 'main';
    } else if (stage === 'main') {
      v = Math.min(-mainMps, v + 8 * dt);
      hE = windE;
      hN = windN;
    }
    up += v * dt;
    east += hE * dt;
    north += hN * dt;
    if (stage === 'main' && up <= 0) {
      up = 0;
      v = 0;
      stage = 'landed';
      touchdownT = t;
      landing = { east, north };
    }
    if (stage === 'landed') { hE = 0; hN = 0; }
    if (t >= nextSample - 1e-9) {
      points.push({ t: nextSample, east, north, up, hSpeed: Math.hypot(hE, hN), vSpeed: v, stage });
      nextSample += 1;
    }
    if (touchdownT !== null && t > touchdownT + afterS) break;
    t += dt;
  }
  return { points, liftoffT, apogeeT, apogeeM, touchdownT, landing };
}

// A whole flight: pad, boost (optionally with the fix lost right at
// liftoff for 2 s to 4 s), coast, apogee, drogue, main, touchdown, and then
// the board sitting still in the same kind of wander as on the bench.
//   groundSpeed   each fix carries the receiver's ground speed
//   boostFixLoss  the GPS loses its fix from liftoff for 2 s to 4 s
// Returns { samples, truth } where truth is flightPath's result with the
// site and the true landing point as { lat, lon }.
export function flightSamples(seed, { groundSpeed = false, boostFixLoss = true, site = SITE, path = {} } = {}) {
  const rand = makeRandom(seed);
  const truth = flightPath(rand, path);
  const wander = createWander(rand);
  const sky = createSky(rand);
  const lossUntil = boostFixLoss ? truth.liftoffT + between(rand, 2, 4) : -Infinity;
  const samples = [];
  const t0 = 1.0;   // the board's clock when the log starts
  truth.points.forEach((p, i) => {
    const t = t0 + p.t;
    const { sats, hdop } = sky();
    const seq = i % 65536;
    if (p.t >= truth.liftoffT && p.t < lossUntil) {
      samples.push(makeSample({ t, seq, fix: 0, sats: 3, hdop: null }));
      if (p.t + 1 >= lossUntil) wander.fixReturned(t + 1);
      return;
    }
    const w = wander.at(t);
    const pos = offsetPosition(site, p.east + w.dE, p.north + w.dN, p.up + w.dU);
    samples.push(makeSample({
      t, seq, fix: 1, ...pos, sats, hdop, stale: 0,
      speed: groundSpeed ? p.hSpeed + Math.abs(0.15 * gauss(rand)) : null,
      course: null,
    }));
  });
  const landing = offsetPosition(site, truth.landing.east, truth.landing.north, 0);
  return {
    samples,
    truth: {
      ...truth,
      liftoffT: t0 + truth.liftoffT,
      apogeeT: t0 + truth.apogeeT,
      touchdownT: t0 + truth.touchdownT,
      landing: { lat: landing.lat, lon: landing.lon },
      site,
    },
  };
}

// "5.3 s", "1 min 5.3 s" or "1 h 2 min 5 s", the way the board writes it.
function timeText(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s - h * 3600 - m * 60;
  if (h) return `${h} h ${m} min ${sec.toFixed(1)} s`;
  return m ? `${m} min ${sec.toFixed(1)} s` : `${sec.toFixed(1)} s`;
}

// One sample as the board's USB status block (the lines BlockParser reads).
// The block prints no ground speed, so a sample's speed is left out.
export function statusBlockLines(sample, beat) {
  const g = sample.gps;
  const locked = g.fix === 1;
  const pct = g.hdop === null ? null : Math.max(0, Math.min(100, Math.round(((5 - g.hdop) / 4) * 100)));
  const values = {
    'TARGET LOCK [GPS]': locked ? 'LOCKED' : 'SEARCHING',
    'CONNECTED SATELLITES': String(g.sats ?? 0),
    'LOCK QUALITY': g.hdop === null ? 'UNKNOWN' : `${pct} % (HDOP ${g.hdop.toFixed(2)})`,
    LATITUDE: locked ? g.lat.toFixed(7) : '0.0000000',
    LONGITUDE: locked ? g.lon.toFixed(7) : '0.0000000',
    ALTITUDE: `${locked ? g.altMsl.toFixed(1) : '0.0'} m`,
    'GPS DATA RATE': 'GOOD 723 char/s',
    'CORRUPTED DATA OCCURRENCES (GPS)': '0',
    PORTABLE: 'OFF',
    AUTOMOTIVE: 'OFF',
    'AIRBORNE 4G': 'ON',
    OTHER: 'OFF',
    'RADIO PACKETS SENT': String(beat),
    'RADIO PACKETS SKIPPED': '0',
    'RADIO PACKET ERROR OCCURRENCES': '0',
  };
  const line = (label) => `  ${(label + ': ').padEnd(38, '-')} ${values[label]}`;
  return [
    `==================== HEARTBEAT #${beat} | TIME RUNNING: ${timeText(sample.t)} ====================`,
    '',
    'GPS',
    ...['TARGET LOCK [GPS]', 'CONNECTED SATELLITES', 'LOCK QUALITY', 'LATITUDE', 'LONGITUDE', 'ALTITUDE', 'GPS DATA RATE', 'CORRUPTED DATA OCCURRENCES (GPS)'].map(line),
    '',
    'GPS MOTION MODEL',
    ...['PORTABLE', 'AUTOMOTIVE', 'AIRBORNE 4G', 'OTHER'].map(line),
    '',
    'RADIO',
    ...['RADIO PACKETS SENT', 'RADIO PACKETS SKIPPED', 'RADIO PACKET ERROR OCCURRENCES'].map(line),
    '',
  ];
}
