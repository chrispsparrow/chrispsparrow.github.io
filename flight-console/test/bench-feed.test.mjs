// Checks js/live/bench-feed.js: the board's USB status blocks turned into
// samples for the Flight Console store.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/bench-feed.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockParser } from '../js/bench/parse.js?v=3';
import { blockToSample, createLiveFeed, DEFAULT_ROCKET, LIVE_STORE_OPTIONS } from '../js/live/bench-feed.js';
import { createSourceDetector } from '../js/live/sources.js';
import { createStore } from '../js/store.js';
import { createFleet } from '../js/fleet.js';
import { GROUPS, channelsInGroup, hasGoodPosition } from '../js/schema.js';
import * as config from '../js/config.js';
import { hudAge } from '../js/views/hud-text.js';
import { formatNumber } from '../js/geo.js';

// What the HUD (js/views/hud.js) shows about a rocket's position and
// altitude, worked out the same way: whether it has a fix now, whether the
// packets or the GPS data went quiet, how old the last packet and the last
// good fix are (as the HUD writes the ages), whether the altitude is old,
// and the height above the pad.
function hudFacts(store, rocket) {
  return {
    fixNow: store.hasFixNow(rocket),
    silent: store.isSilent(rocket),
    gpsQuiet: store.gpsIsQuiet(rocket),
    packetAge: hudAge(store.ageOf(rocket.lastPacketT)),
    fixAge: hudAge(store.ageOf(rocket.lastGoodFix?.t)),
    altOld: store.altitudeIsOld(rocket),
    agl: rocket.derived?.agl ?? null,
  };
}

// "5.3 s", "1 min 5.3 s" or "1 h 2 min 5 s", the way the board writes it.
function timeText(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s - h * 3600 - m * 60;
  if (h) return `${h} h ${m} min ${Math.floor(sec)} s`;
  return m ? `${m} min ${sec.toFixed(1)} s` : `${sec.toFixed(1)} s`;
}

// The lines of one block like the board's, with values swapped in. `over`
// is { label: value }, and a label set to null leaves its line out.
function blockLines(beat, seconds, over = {}) {
  const values = {
    'TARGET LOCK [GPS]': 'LOCKED',
    'CONNECTED SATELLITES': '11',
    'LOCK QUALITY': '100 % (HDOP 0.99)',
    LATITUDE: '42.3386255',
    LONGITUDE: '-71.0896268',
    ALTITUDE: '17.3 m',
    'GPS DATA RATE': 'GOOD 723 char/s',
    'CORRUPTED DATA OCCURRENCES (GPS)': '1',
    PORTABLE: 'OFF',
    AUTOMOTIVE: 'OFF',
    'AIRBORNE 4G': 'ON',
    OTHER: 'OFF',
    'RADIO PACKETS SENT': String(beat),
    'RADIO PACKETS SKIPPED': '0',
    'RADIO PACKET ERROR OCCURRENCES': '0',
    ...over,
  };
  const line = (label) => (values[label] === null ? null : `  ${(label + ': ').padEnd(38, '-')} ${values[label]}`);
  return [
    `==================== HEARTBEAT #${beat} | TIME RUNNING: ${timeText(seconds)} ====================`,
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
  ].filter((l) => l !== null);
}

// One finished block, read by the Bench Console's own parser.
function block(beat, seconds, over = {}, t = 1_763_000_000_000) {
  const parser = new BlockParser();
  let done = null;
  for (const l of blockLines(beat, seconds, over)) done = parser.push(l, t).done ?? done;
  return done ?? parser.finish();
}

// The live bench store, made the way main.js makes it: liftoff switched
// off and no ground station. `options` replaces those for a comparison.
function newStore(options = LIVE_STORE_OPTIONS.bench) {
  return createStore({ fleet: createFleet(), ...options });
}

// A feed with a clock the test moves by hand.
function newFeed(store, startMs = 1_763_000_000_000) {
  const clock = { ms: startMs };
  const feed = createLiveFeed({ store, clock: () => clock.ms, every: null });
  return { feed, clock };
}

test('a LOCKED block becomes a sample with a good fix', () => {
  const b = block(65, 65.3);
  const s = blockToSample(b, '1');
  assert.equal(s.rocketId, '1');
  assert.equal(s.t, 65.3, 't is the board\'s TIME RUNNING in seconds');
  assert.equal(s.type, 'tlm');
  for (const g of GROUPS) if (g !== 'gps') assert.equal(s[g], null, `no ${g} group`);
  assert.equal(s.extra, null);
  // Every GPS channel in the schema is there, like parser.js makes them.
  assert.deepEqual(Object.keys(s.gps).sort(), channelsInGroup('gps').map((c) => c.key).sort());
  assert.deepEqual(s.gps, {
    fix: 1, sats: 11, hdop: 0.99, lat: 42.3386255, lon: -71.0896268, altMsl: 17.3,
    speed: null, course: null, stale: null,
  });
  assert.equal(hasGoodPosition(s), true);
});

test('a SEARCHING block has no fix and no position', () => {
  const s = blockToSample(block(3, 3.3, {
    'TARGET LOCK [GPS]': 'SEARCHING',
    'CONNECTED SATELLITES': '2',
    'LOCK QUALITY': 'UNKNOWN',
    LATITUDE: '0.0000000',
    LONGITUDE: '0.0000000',
    ALTITUDE: '0.0 m',
  }), '1');
  assert.equal(s.gps.fix, 0);
  assert.equal(s.gps.sats, 2, 'the satellite count still shows');
  assert.equal(s.gps.hdop, null, 'UNKNOWN lock quality has no HDOP');
  assert.equal(s.gps.lat, null);
  assert.equal(s.gps.lon, null);
  assert.equal(s.gps.altMsl, null, 'the 0.0 m the board prints while searching is not an altitude');
  assert.equal(hasGoodPosition(s), false);

  // A real-looking position doesn't count while SEARCHING either.
  const s2 = blockToSample(block(4, 4.3, { 'TARGET LOCK [GPS]': 'SEARCHING', 'LOCK QUALITY': '0 % (HDOP 99.99)' }), '1');
  assert.equal(s2.gps.fix, 0);
  assert.equal(s2.gps.lat, null);
  assert.equal(s2.gps.hdop, 99.99);
  assert.equal(hasGoodPosition(s2), false);
});

test('a bad position means no fix, even when the block says LOCKED', () => {
  for (const [why, over] of [
    ['0, 0', { LATITUDE: '0.0000000', LONGITUDE: '0.0000000' }],
    ['off the globe', { LATITUDE: '95.0000000' }],
    ['not a number', { LONGITUDE: '--' }],
    ['a word the page doesn\'t know', { 'TARGET LOCK [GPS]': '2D' }],
  ]) {
    const s = blockToSample(block(10, 10.3, over), '1');
    assert.equal(s.gps.fix, 0, why);
    assert.equal(s.gps.lat, null, why);
    assert.equal(s.gps.lon, null, why);
    assert.equal(hasGoodPosition(s), false, why);
  }
  // A good position with an altitude that can't be read: the board's fix
  // is kept, but with no altitude it isn't a good position.
  const noAlt = blockToSample(block(11, 11.3, { ALTITUDE: '-- m' }), '1');
  assert.equal(noAlt.gps.fix, 1);
  assert.equal(noAlt.gps.altMsl, null);
  assert.equal(hasGoodPosition(noAlt), false);
});

test('a block cut off before its position, or with no time, can\'t pass for a lost fix', () => {
  // The port closed after the first two GPS lines.
  const parser = new BlockParser();
  for (const l of blockLines(20, 20.3).slice(0, 5)) parser.push(l, 0);
  const cut = parser.finish();
  assert.ok(cut.fields.lock && !cut.fields.lat);
  const s = blockToSample(cut, '1');
  assert.equal(s.t, 20.3);
  assert.equal(s.gps, null, 'no GPS group, so the views keep the last fix state');

  const noTime = block(21, 21.3);
  noTime.timeRunning = null;
  assert.equal(blockToSample(noTime, '1'), null);
});

test('the feed names the board like the fleet does', () => {
  const store = newStore();
  const { feed } = newFeed(store);
  assert.equal(feed.rocketId, DEFAULT_ROCKET.id);
  const rocket = store.getRocket('1');
  assert.ok(rocket);
  assert.equal(rocket.profile.name, 'GPS and radio board');
  assert.equal(rocket.profile.callsign, 'DOGTOOTH GPS RADIO');
  assert.equal(store.getFocusedId(), '1');
  assert.equal(store.getNow(), null, 'no time until the first block');
});

test('the store\'s clock keeps moving between blocks, so quiet data turns old', () => {
  const store = newStore();
  const { feed, clock } = newFeed(store);
  const b = block(65, 65.3, {}, clock.ms);
  clock.ms += 20;   // the blank line at the end of the block arrives a moment later
  assert.equal(feed.push(b), true);
  const rocket = store.getRocket('1');
  assert.ok(Math.abs(store.getNow() - 65.32) < 1e-9, 'now is the block time plus the time since its banner');
  assert.equal(rocket.lastPacketT, 65.3);

  clock.ms += 980;
  feed.tick();
  assert.ok(Math.abs(store.getNow() - 66.3) < 1e-9);
  assert.equal(store.isSilent(rocket), false);

  clock.ms += 9000;
  feed.tick();
  assert.ok(Math.abs(store.getNow() - 75.3) < 1e-9);
  assert.equal(store.isSilent(rocket), true);
  // The HUD says the position is old because no packets came for 10 s.
  const hud = hudFacts(store, rocket);
  assert.equal(hud.fixNow, false);
  assert.equal(hud.silent, true);
  assert.equal(hud.packetAge, '10 S');
});

test('the feed starts its clock timer once, at the first block, and stops it', () => {
  const store = newStore();
  const calls = [];
  let stopped = 0;
  const feed = createLiveFeed({ store, clock: () => 0, every: (fn, ms) => { calls.push(ms); return () => { stopped++; }; } });
  assert.equal(calls.length, 0);
  feed.push(block(1, 1.3, {}, 0));
  feed.push(block(2, 2.3, {}, 0));
  assert.deepEqual(calls, [250]);
  feed.stop();
  feed.stop();
  assert.equal(stopped, 1);
});

test('a board restart clears the store and starts over', () => {
  const store = newStore();
  const { feed, clock } = newFeed(store);
  for (let i = 0; i < 12; i++) {
    feed.push(block(100 + i, 100.3 + i, {}, clock.ms));
    clock.ms += 1000;
  }
  const rocket = () => store.getRocket('1');
  assert.equal(rocket().samples.length, 12);

  // TIME RUNNING goes back: the board restarted.
  assert.equal(feed.push(block(1, 1.3, {}, clock.ms)), true);
  assert.equal(feed.restarts, 1);
  assert.equal(rocket().samples.length, 1, 'only the new block is left');
  assert.equal(rocket().samples[0].t, 1.3);
  assert.equal(store.getTotals().late, 0, 'nothing was turned away as late');
  assert.equal(rocket().profile.callsign, 'DOGTOOTH GPS RADIO', 'the rocket stays');
  assert.ok(store.getNow() < 2);

  // The heartbeat number going back is a restart too.
  clock.ms += 1000;
  feed.push(block(50, 2.3, {}, clock.ms));
  clock.ms += 1000;
  feed.push(block(3, 3.3, {}, clock.ms));
  assert.equal(feed.restarts, 2);
  assert.equal(rocket().samples.length, 1);

  // The panel's onRestart() comes before the restarted block arrives. The
  // block then doesn't clear the store a second time.
  clock.ms += 1000;
  feed.push(block(4, 4.3, {}, clock.ms));
  feed.restart();
  assert.equal(feed.restarts, 3);
  feed.push(block(1, 0.9, {}, clock.ms));
  assert.equal(feed.restarts, 3);
  assert.equal(rocket().samples.length, 1);

  // A restart with nothing in the store does nothing.
  const empty = newFeed(newStore()).feed;
  empty.restart();
  assert.equal(empty.restarts, 0);
});

// ------------------------------------------------------------------
// A board sitting on a desk, from power-up: SEARCHING for 10 s, then
// LOCKED with a few meters of GPS jitter, like the Bench Console's test
// tool. Fed line by line the way the page does it: every line goes through
// the source detector and BlockParser, and finished blocks reach the feed
// once the detector has found the board (main.js makes the feed then).
//   storeOptions   createStore() options (default: the page's bench store)
//   climb(i)       meters added to block i's altitude (default: none)
// ------------------------------------------------------------------

function deskRun(blocks = 180, { storeOptions, climb = () => 0 } = {}) {
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const rnd = (a, b) => a + rand() * (b - a);
  const LAT0 = 42.3386255;
  const LON0 = -71.0896268;
  const perMeterLat = 1 / 110574;
  const perMeterLon = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));

  const t0 = 1_763_000_000_000;
  const store = newStore(storeOptions);
  const { feed, clock } = newFeed(store, t0);
  const detector = createSourceDetector();
  const parser = new BlockParser();
  const run = { store, feed, clock, detector, padFromBlock: null, maxAbsV: 0, aglMin: Infinity, aglMax: -Infinity, oldTicks: 0, hud: [] };

  const startup = ['', 'DOGTOOTH_V1_FIRMWARE flight computer, Avionics GPS Radio v2', 'Built Nov 13 2026 14:22:01', 'GPS airborne model: accepted'];
  for (let i = 0; i < blocks; i++) {
    const lock = i >= 10;
    const over = lock
      ? {
        LATITUDE: (LAT0 + rnd(-3, 3) * perMeterLat).toFixed(7),
        LONGITUDE: (LON0 + rnd(-3, 3) * perMeterLon).toFixed(7),
        ALTITUDE: `${(17.3 + climb(i) + rnd(-2.5, 2.5)).toFixed(1)} m`,
        'CONNECTED SATELLITES': String(Math.round(rnd(8, 11))),
        'LOCK QUALITY': `${Math.round(rnd(85, 100))} % (HDOP ${rnd(0.8, 1.6).toFixed(2)})`,
      }
      : { 'TARGET LOCK [GPS]': 'SEARCHING', 'CONNECTED SATELLITES': String(Math.min(3, Math.floor(i / 3))), 'LOCK QUALITY': 'UNKNOWN', LATITUDE: '0.0000000', LONGITUDE: '0.0000000', ALTITUDE: '0.0 m' };
    const arrive = t0 + i * 1000 + Math.round(rnd(0, 40));   // a little USB delay
    clock.ms = arrive;
    for (const line of [...(i === 0 ? startup : []), ...blockLines(i + 1, 0.3 + i, over)]) {
      const found = detector.push(line);
      const r = parser.push(line, arrive);
      if (r.done && found) feed.push(r.done);
    }
    const rocket = store.getRocket('1');
    const d = rocket.derived;
    if (Number.isFinite(d?.vSpeed)) run.maxAbsV = Math.max(run.maxAbsV, Math.abs(d.vSpeed));
    if (Number.isFinite(d?.agl)) { run.aglMin = Math.min(run.aglMin, d.agl); run.aglMax = Math.max(run.aglMax, d.agl); }
    if (rocket.padPosition && run.padFromBlock === null) run.padFromBlock = i;
    run.hud.push(hudFacts(store, rocket));
    // The clock ticks four times a second until the next block.
    for (let k = 1; k <= 3; k++) {
      clock.ms = arrive + k * 250;
      feed.tick();
      if (lock && store.altitudeIsOld(rocket)) run.oldTicks++;
    }
  }
  run.lastArrive = t0 + (blocks - 1) * 1000;
  return run;
}

test('a board on a desk shows a pad and fires no flight events', () => {
  const run = deskRun(180);
  const { store, feed, clock, detector } = run;
  const rocket = store.getRocket('1');
  const d = rocket.derived;

  assert.equal(detector.source?.id, 'dogtooth-usb');
  assert.equal(store.getTotals().samples, 180);
  assert.equal(store.getTotals().late, 0);

  // The 3D view needs a pad position, and gets one about 6 s after the
  // first lock (3 s for the vertical speed, then 3 s sitting still).
  assert.ok(rocket.padPosition, 'the store has a pad position');
  assert.equal(run.padFromBlock, 16);
  assert.equal(d.phase, 'pad');
  assert.ok(Math.abs(rocket.padPosition.lat - 42.3386255) < 0.0001);
  assert.ok(Math.abs(rocket.padPosition.lon - -71.0896268) < 0.0001);

  // No liftoff, apogee or anything else from the jitter, and no fix lost.
  assert.deepEqual(store.getEvents(), []);
  assert.ok(run.maxAbsV < config.PAD_STILL_MAX_MPS, `vertical speed stays under ${config.PAD_STILL_MAX_MPS} m/s (max ${run.maxAbsV.toFixed(2)})`);
  assert.ok(run.aglMax < 5 && run.aglMin > -5, `height above the pad stays within 5 m (${run.aglMin.toFixed(1)} to ${run.aglMax.toFixed(1)})`);

  // What the HUD shows. While searching: no fix (and none yet, so no age),
  // with the packets and the GPS data still coming.
  assert.deepEqual(
    [run.hud[0].fixNow, run.hud[0].silent, run.hud[0].gpsQuiet, run.hud[0].fixAge],
    [false, false, false, '--'],
    'while searching');
  // Locked: a current fix and a current height in whole meters.
  const live = hudFacts(store, rocket);
  assert.equal(live.fixNow, true);
  assert.equal(live.altOld, false);
  assert.match(formatNumber(live.agl, 0), /^-?\d+$/);
  assert.equal(run.oldTicks, 0, 'the altitude never shows as old between blocks');

  // Unplugged: no more blocks, and the clock keeps running.
  clock.ms = run.lastArrive + 2000;
  feed.tick();
  const after2 = hudFacts(store, rocket);
  assert.equal(after2.fixNow, true, 'after 2 s the fix still counts');
  assert.equal(after2.altOld, true, 'after 2 s the altitude is old');
  clock.ms = run.lastArrive + 10000;
  feed.tick();
  assert.equal(store.isSilent(rocket), true);
  assert.equal(store.hasFixNow(rocket), false);
  // The HUD says the position is old because no packets came for 10 s.
  const after10 = hudFacts(store, rocket);
  assert.equal(after10.silent, true);
  assert.equal(after10.packetAge, '10 S');
  assert.deepEqual(store.getEvents(), [], 'going quiet isn\'t an event');
  assert.equal(store.getGroundStation(), null, 'no ground station on the bench');
});

// This used to say the bench store (liftoff switched off) ignores these
// while a flight store fires liftoff on them. Since the detector needs a
// fast climb of several readings in a row, both stores ignore them, and
// the bench store has liftoff switched back on.
test('on the bench, a 35 m GPS jump or a steady 40 m climb isn\'t liftoff', () => {
  // One block 35 m high at 60 s, then a climb of 4 m/s from 100 s to 110 s
  // that stays up there, like carrying the board upstairs.
  const climb = (i) => (i === 60 ? 35 : i >= 100 ? Math.min(40, (i - 100) * 4) : 0);
  for (const storeOptions of [LIVE_STORE_OPTIONS.bench, {}]) {
    const bench = deskRun(180, { climb, storeOptions });
    const rocket = bench.store.getRocket('1');
    assert.deepEqual(bench.store.getEvents(), []);
    assert.ok(rocket.padPosition, 'the pad is still found');
    assert.equal(bench.padFromBlock, 16);
  }
});

test('the live bench store does see a real liftoff climb', () => {
  // The same desk, then a climb like my rockets: 100 m/s from block 120.
  const climb = (i) => (i >= 120 ? (i - 119) * 100 : 0);
  const run = deskRun(126, { climb });
  const liftoff = run.store.getEvents().find((e) => e.type === 'liftoff');
  assert.ok(liftoff, 'liftoff fires on the live bench store');
  // Block i has TIME RUNNING 0.3 + i, so the climb starts at 120.3 s.
  assert.ok(Math.abs(liftoff.t - 120.3) < 1e-6, `liftoff at ${liftoff.t}`);
  assert.ok(liftoff.confirmedT <= 122.3 + 1e-6, 'confirmed within two readings');
});

test('a store with no ground station keeps none until a "gs" packet sets one', () => {
  const store = newStore();
  assert.equal(store.getGroundStation(), null);
  store.reset();
  assert.equal(store.getGroundStation(), null, 'after reset()');
  store.clearAll();
  assert.equal(store.getGroundStation(), null, 'after clearAll()');

  // A packet without a fix doesn't set it.
  store.addSample({ type: 'gs', t: 1, gps: { fix: 0, lat: null, lon: null } });
  assert.equal(store.getGroundStation(), null);
  store.addSample({ type: 'gs', t: 2, gps: { fix: 1, lat: 42.34, lon: -71.09, altMsl: 12 } });
  assert.deepEqual(store.getGroundStation(), { lat: 42.34, lon: -71.09, altMsl: 12, source: 'ground station GPS', t: 2 });

  // The flight store's demo ground station is still there for replays.
  assert.equal(newStore({}).getGroundStation()?.source, 'config');
});
