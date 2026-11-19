// Checks js/live/sources.js: which source is talking on the serial port.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/live-sources.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SOURCES, UNKNOWN_AFTER_LINES, createSourceDetector } from '../js/live/sources.js';

const BANNER = '==================== HEARTBEAT #65 | TIME RUNNING: 1 min 5.3 s ====================';

// What the flight firmware prints before its first block, plus a few lines
// from the middle of a block (the page can connect partway through one).
const STARTUP = [
  '',
  'DOGTOOTH_V1_FIRMWARE flight computer, Avionics GPS Radio v2',
  'Built Nov 13 2026 14:22:01',
  'GPS airborne model: accepted',
  'Error: The radio did not start (RadioLib error -2).',
  '  LATITUDE: --------------------------- 42.3386255',
  'GPS MOTION MODEL',
  '  AIRBORNE 4G: ------------------------ ON',
  '==========================',
];

test('the status block banner means a Dogtooth board on USB', () => {
  const d = createSourceDetector();
  for (const line of STARTUP) assert.equal(d.push(line), null, `"${line}" says nothing about the source`);
  const source = d.push(BANNER);
  assert.ok(source);
  assert.equal(source.id, 'dogtooth-usb');
  assert.equal(source.name, 'Dogtooth board over USB');
  assert.equal(source.mode, 'bench');
  assert.equal(d.source, source);
  // Once found, it stays found, whatever the line.
  assert.equal(d.push('GPS'), source);
  assert.equal(d.push('random noise'), source);
  assert.equal(d.unknown, false);
});

test('banners with other times and counts still match, other "=" lines don\'t', () => {
  for (const line of [
    '==================== HEARTBEAT #1 | TIME RUNNING: 1.0 s ====================',
    '==================== HEARTBEAT #3725 | TIME RUNNING: 1 h 2 min 5 s ====================',
    '==================== HEARTBEAT #65 | TIME RUNNING: 1 min 5.3 s ====================\r',
  ]) {
    assert.equal(createSourceDetector().push(line)?.id, 'dogtooth-usb', line);
  }
  for (const line of ['====', '==== READY ====', '=== HEART ===']) {
    assert.equal(createSourceDetector().push(line), null, line);
  }
});

test('reset() forgets the source for a new connection', () => {
  const d = createSourceDetector();
  d.push(BANNER);
  assert.ok(d.source);
  d.reset();
  assert.equal(d.source, null);
  assert.equal(d.push('GPS'), null);
  assert.equal(d.push(BANNER)?.id, 'dogtooth-usb');
});

test('lines that never match turn into "unknown data" after enough of them', () => {
  const d = createSourceDetector();
  // NMEA passthrough mode prints raw GPS sentences, which aren't a source.
  const nmea = '$GNGGA,194213.00,4220.31753,N,07105.37761,W,1,11,0.99,17.3,M,-33.0,M,,*6B';
  for (let i = 1; i < UNKNOWN_AFTER_LINES; i++) {
    d.push(nmea);
    d.push('');   // blank lines don't count
  }
  assert.equal(d.unknown, false, `${UNKNOWN_AFTER_LINES - 1} lines is not enough yet`);
  d.push(nmea);
  assert.equal(d.unknown, true);
  assert.equal(d.source, null);

  // A banner later still counts, and then the data isn't unknown.
  assert.equal(d.push(BANNER)?.id, 'dogtooth-usb');
  assert.equal(d.unknown, false);

  // reset() starts the count again.
  const d2 = createSourceDetector({ unknownAfter: 3 });
  for (let i = 0; i < 3; i++) d2.push('x');
  assert.equal(d2.unknown, true);
  d2.reset();
  assert.equal(d2.unknown, false);
  assert.equal(d2.unmatchedLines, 0);
});

test('the Manta ground station hook is there but switched off', () => {
  // The Dogtooth board and the radio board receiver are the sources today.
  // (test/radio-board-rx.test.mjs checks the receiver.)
  assert.deepEqual(SOURCES.map((s) => s.id), ['dogtooth-usb', 'radio-board-rx']);
  for (const s of SOURCES) {
    assert.ok(['bench', 'flight'].includes(s.mode), s.id);
    assert.equal(typeof s.test, 'function');
    assert.ok(s.name);
  }
  // The receiver is the one flight-mode source, and it can read its lines.
  const flightSources = SOURCES.filter((s) => s.mode === 'flight');
  assert.deepEqual(flightSources.map((s) => s.id), ['radio-board-rx']);
  assert.equal(typeof flightSources[0].parse, 'function');

  // A receiver's packet line is picked up as the receiver. A simulator
  // packet line (a Dogtooth board's flight_sim build) is no source's.
  const d = createSourceDetector();
  assert.equal(d.push('SIM PKT seq=1 len=34 sim_s=0.10 phase=pad hex=01 01 00'), null);
  assert.equal(d.push('PKT node=1 seq=12 up_s=12.0 fix=yes sats=11 hdop=0.99 lat=42.3386255 lon=-71.0896268 alt_m=17.3 spd_mps=0.0 crs_deg=0 utc=19:42:13.000 airborne=yes rssi_dbm=-41.0 snr_db=9.5 missed=0')?.id, 'radio-board-rx');

  // The Manta hook itself is in the file, commented out, with mode 'flight'.
  const lines = readFileSync(new URL('../js/live/sources.js', import.meta.url), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.includes("'manta-ground-station'"));
  assert.ok(start > 0, 'the hook entry is in sources.js');
  const hookLines = lines.slice(start - 1, start + 5);
  assert.ok(hookLines.some((l) => l.includes("mode: 'flight'")), 'the hook has mode flight');
  assert.ok(hookLines.every((l) => l.trimStart().startsWith('//')), 'and every line of it is commented out');
  assert.ok(!SOURCES.some((s) => s.id === 'manta-ground-station'), 'so it is not a source');
  assert.match(lines.join('\n'), /parseSerialLine\(\) in js\/parser\.js/, 'the hook says where to start');
});
