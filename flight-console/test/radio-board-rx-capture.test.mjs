// Checks the radio board receiver with a REAL session: 253 lines the
// receiver (DEKEL_RX_FIRMWARE on its board) printed on 2026-11-17 while a
// Dogtooth board sat still on a desk nearby, saved in
// test/radio-board-rx-capture.log. They go through the source detector, the
// receiver's parse() and the flight feed into a store, the way the page does.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/radio-board-rx-capture.test.mjs
//
// The capture is exactly as printed, except one change: every lat= and lon=
// is moved by the same fixed amount, so the first fix lands on the sim's
// placeholder launch site (35.1234567, -117.1234567) instead of where the
// board really was. The movement between fixes is unchanged to the last
// digit. test/radio-board-rx.test.mjs checks the cases a short bench session
// can't show (bad packets, a restart, a second board, the radio failing).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCES, createSourceDetector } from '../js/live/sources.js';
import { createFlightFeed, readReceiverStatus, waitingNote } from '../js/live/flight-feed.js';
import { LIVE_STORE_OPTIONS } from '../js/live/bench-feed.js';
import { createStore } from '../js/store.js';
import { createFleet } from '../js/fleet.js';
import { flightState, padChecklist, STATE } from '../js/flight-state.js';
import * as config from '../js/config.js';

const LINES = readFileSync(new URL('./radio-board-rx-capture.log', import.meta.url), 'utf8')
  .split(/\r?\n/)
  .filter((l) => l !== '');
const PKT_LINES = LINES.filter((l) => l.startsWith('PKT '));
const STATUS_LINES = LINES.filter((l) => l.startsWith('# DEKEL_RX'));

// Feeds the whole capture the way the page does: every line to the
// detector, then to the receiver's parse() and the flight feed. The
// receiver sends one packet a second, so the computer's clock moves 1 s per
// PKT line. Returns everything a test might look at.
function replay() {
  const detector = createSourceDetector();
  const store = createStore({ fleet: createFleet(), ...LIVE_STORE_OPTIONS.flight });
  let realMs = 0;
  const feed = createFlightFeed({ store, clock: () => realMs, every: null });
  const results = [];
  let foundAt = null;
  LINES.forEach((line, i) => {
    const source = detector.push(line);
    if (source && foundAt === null) foundAt = i + 1;
    if (!source) return;
    if (line.startsWith('PKT ')) realMs += 1000;
    feed.noteLine(line);
    const out = source.parse(line);
    results.push(out);
    feed.push(out, realMs);
  });
  return {
    detector, store, feed, results, foundAt,
    rocket: store.getRocket('1'),
    wait(seconds) { realMs += seconds * 1000; feed.tick(); },
  };
}

test('the capture is what the receiver prints: a status line, then a packet, each second', () => {
  assert.equal(LINES.length, 253);
  assert.equal(PKT_LINES.length, 126);
  assert.equal(STATUS_LINES.length, 127);
  assert.equal(LINES.length, PKT_LINES.length + STATUS_LINES.length, 'no other kind of line');
  LINES.forEach((line, i) => {
    assert.ok(line.startsWith(i % 2 === 0 ? '# DEKEL_RX listening ' : 'PKT node=1 '), `line ${i + 1}`);
  });
});

test('a page whose only source is the Dogtooth board calls these lines not recognized', () => {
  // This is what the live site did before the receiver entry went into
  // sources.js: no line matches, and after UNKNOWN_AFTER_LINES (60) lines
  // the console says NOT RECOGNIZED.
  const d = createSourceDetector({ sources: SOURCES.filter((s) => s.id === 'dogtooth-usb') });
  let unknownAt = null;
  LINES.forEach((line, i) => { d.push(line); if (unknownAt === null && d.unknown) unknownAt = i + 1; });
  assert.equal(d.source, null);
  assert.equal(unknownAt, 60);
});

test('with the receiver entry, the very first line names the source', () => {
  const { detector, foundAt } = replay();
  assert.equal(detector.source?.id, 'radio-board-rx');
  assert.equal(foundAt, 1);
  assert.equal(detector.unknown, false);
});

test('every PKT line becomes a sample and every status line is ignored', () => {
  const { results, feed } = replay();
  assert.equal(results.filter((r) => r.kind === 'sample').length, 126);
  assert.equal(results.filter((r) => r.kind === 'ignored').length, 127);
  assert.equal(results.filter((r) => r.kind === 'bad').length, 0);
  assert.deepEqual(feed.counts, { samples: 126, bad: 0, restarts: 0 });
});

test('each sample carries position, fix, satellites, HDOP, speed, course, RSSI and SNR', () => {
  const { results } = replay();
  const samples = results.filter((r) => r.kind === 'sample').map((r) => r.sample);
  const first = samples[0];
  assert.equal(first.rocketId, '1');
  assert.equal(first.t, 807);
  assert.equal(first.type, 'tlm');
  assert.deepEqual(first.gps, {
    fix: 1, sats: 12, hdop: 0.84, lat: 35.1234567, lon: -117.1234567, altMsl: 59.7,
    speed: 0.13, course: 140.74, stale: null,
  });
  assert.deepEqual(first.radio, { rssi: -79, snr: 10.75 });
  assert.deepEqual(first.extra, { seq: 806, utc: '05:57:22.000', airborne_model: 'yes', missed: 0 });

  for (const s of samples) {
    assert.equal(s.gps.fix, 1);
    assert.equal(s.gps.sats, 12);
    for (const key of ['lat', 'lon', 'altMsl', 'hdop', 'speed', 'course']) assert.ok(Number.isFinite(s.gps[key]), key);
    assert.ok(s.radio.rssi <= -79 && s.radio.rssi >= -82, `rssi ${s.radio.rssi}`);
    assert.ok(s.radio.snr >= 10 && s.radio.snr <= 12, `snr ${s.radio.snr}`);
  }
});

test('one packet a second, none missed: sequence and board time go up by one each time', () => {
  const { rocket } = replay();
  const samples = rocket.samples;
  assert.equal(samples.length, 126);
  for (let i = 1; i < samples.length; i++) {
    assert.equal(samples[i].extra.seq, samples[i - 1].extra.seq + 1);
    assert.equal(samples[i].t, samples[i - 1].t + 1);
    assert.equal(samples[i].extra.missed, 0);
  }
  assert.equal(samples.at(-1).t, 932);
});

test('the store has the board, its track and its signal, and the clock follows the board', () => {
  const { store, rocket } = replay();
  assert.equal(store.getRockets().length, 1);
  assert.equal(rocket.profile.name, 'GPS and radio board');
  assert.equal(store.getTotals().late, 0);
  assert.equal(store.getNow(), 932);
  assert.equal(store.hasFixNow(rocket), true);
  assert.equal(rocket.lastGoodFix.lat, 35.1232697);
  assert.equal(rocket.lastGoodFix.lon, -117.1233786);
  assert.deepEqual(rocket.latestByGroup.radio.values, { rssi: -82, snr: 10.75 });
});

test('a board sitting still stays on the pad, and the checklist says READY', () => {
  // Its GPS altitude wandered from 39.2 m to 73.2 m over the two minutes,
  // which must not look like a liftoff.
  const { store, rocket } = replay();
  const alts = rocket.samples.map((s) => s.gps.altMsl);
  assert.equal(Math.min(...alts), 39.2);
  assert.equal(Math.max(...alts), 73.2);
  const st = flightState(store, rocket, { connected: true });
  assert.equal(st.state, STATE.PAD);
  assert.equal(rocket.derived.liftoffT, null);
  const pad = padChecklist(store, rocket);
  assert.equal(pad.gps.text, '12 SAT');
  assert.equal(pad.link.text, '1 PKT/S');
  assert.equal(pad.status.text, 'READY');
});

test('the status line is read, and the note under the bar goes away once packets arrive', () => {
  assert.deepEqual(readReceiverStatus(STATUS_LINES[0]),
    { state: 'listening', good: 728, bad: 0, error: null, lastGoodAgoS: 0.9, rxUpS: 729 });
  const { feed } = replay();
  assert.deepEqual(feed.receiver, { state: 'listening', good: 854, bad: 0, error: null, lastGoodAgoS: 0.9, rxUpS: 855 });
  assert.deepEqual(waitingNote(feed, 'Radio board receiver'), { text: '', kind: 'info' });
});

test('when the packets stop, the data goes old after LINK_STALE_S', () => {
  const { store, rocket, wait } = replay();
  wait(config.LINK_STALE_S - 1);
  assert.equal(store.isSilent(rocket), false);
  wait(2);
  assert.equal(store.isSilent(rocket), true);
  assert.equal(store.hasFixNow(rocket), false);
  assert.equal(padChecklist(store, rocket).link.text, `NO PACKETS, ${config.LINK_STALE_S + 1} S`);
});
