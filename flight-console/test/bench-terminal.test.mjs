// Checks js/bench/parse.js and js/bench/csv.js against real serial output:
// two blocks in a row, copied character for character from a screenshot of
// my terminal during a bench test on the Northeastern campus (heartbeats
// 3533 and 3534, about an hour after the board started).
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/bench-terminal.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockParser, FIELDS, readLock, readPosition } from '../js/bench/parse.js?v=3';
import { buildCsv, csvColumns } from '../js/bench/csv.js?v=3';

const TERMINAL = `==================== HEARTBEAT #3533 | TIME RUNNING: 58 min 53.0 s ====================

GPS
  TARGET LOCK [GPS]: ------------------ LOCKED
  CONNECTED SATELLITES: --------------- 12
  LOCK QUALITY: ----------------------- 89 % (HDOP 1.45)
  LATITUDE: --------------------------- 42.3368853
  LONGITUDE: -------------------------- -71.0857403
  ALTITUDE: --------------------------- 49.4 m
  GPS DATA RATE: ---------------------- GOOD 772 char/s
  CORRUPTED DATA OCCURRENCES (GPS): --- 0

GPS MOTION MODEL
  PORTABLE: --------------------------- OFF
  AUTOMOTIVE: ------------------------- OFF
  AIRBORNE 4G: ------------------------ ON
  OTHER: ------------------------------ OFF

RADIO
  RADIO PACKETS SENT: ----------------- 3532
  RADIO PACKETS SKIPPED: -------------- 0
  RADIO PACKET ERROR OCCURRENCES: ----- 0

==================== HEARTBEAT #3534 | TIME RUNNING: 58 min 54.0 s ====================

GPS
  TARGET LOCK [GPS]: ------------------ LOCKED
  CONNECTED SATELLITES: --------------- 12
  LOCK QUALITY: ----------------------- 89 % (HDOP 1.45)
  LATITUDE: --------------------------- 42.3368821
  LONGITUDE: -------------------------- -71.0857330
  ALTITUDE: --------------------------- 48.3 m
  GPS DATA RATE: ---------------------- GOOD 763 char/s
  CORRUPTED DATA OCCURRENCES (GPS): --- 0

GPS MOTION MODEL
  PORTABLE: --------------------------- OFF
  AUTOMOTIVE: ------------------------- OFF
  AIRBORNE 4G: ------------------------ ON
  OTHER: ------------------------------ OFF

RADIO
  RADIO PACKETS SENT: ----------------- 3533
  RADIO PACKETS SKIPPED: -------------- 0
  RADIO PACKET ERROR OCCURRENCES: ----- 0
`;

// Feeds the text line by line with the board's \r\n endings, like the page does.
function feed(text) {
  const parser = new BlockParser();
  const blocks = [];
  const banners = [];
  const types = {};
  text.split('\n').forEach((line, i) => {
    const r = parser.push(line.replace(/\r$/, ''), 1_763_000_000_000 + i);
    types[r.type] = (types[r.type] || 0) + 1;
    if (r.done) blocks.push(r.done);
    if (r.type === 'banner') banners.push(r);
  });
  return { blocks, banners, types };
}

test('every field in the real terminal output reads correctly', () => {
  const { blocks, banners, types } = feed(TERMINAL.replace(/\n/g, '\r\n'));
  assert.equal(blocks.length, 2);
  assert.deepEqual(types, { banner: 2, empty: 8, section: 6, field: 30 });
  assert.deepEqual(banners.map((b) => [b.missed, b.restarted]), [[0, false], [0, false]], 'no lost blocks, no restart');

  const [a, b] = blocks;
  assert.equal(a.heartbeat, 3533);
  assert.equal(a.timeRunning, 3533);
  assert.equal(a.timeText, '58 min 53.0 s');
  assert.equal(b.heartbeat, 3534);
  assert.equal(b.timeRunning, 3534);
  assert.equal(b.timeText, '58 min 54.0 s');

  for (const blk of blocks) {
    const f = blk.fields;
    assert.deepEqual(Object.keys(f).sort(), FIELDS.map((x) => x.key).sort(), 'every field in FIELDS is found');
    assert.equal(f.lock.word, 'LOCKED');
    assert.equal(readLock(f.lock), true);
    assert.equal(f.sats.num, 12);
    assert.equal(f.quality.num, 89);
    assert.equal(f.quality.unit, '%');
    assert.equal(f.quality.hdop, 1.45);
    assert.equal(f.quality.hdopRaw, '1.45');
    assert.equal(f.gpsRate.word, 'GOOD');
    assert.equal(f.gpsRate.tone, 'good');
    assert.equal(f.gpsRate.unit, 'char/s');
    assert.equal(f.alt.unit, 'm');
    assert.equal(f.gpsCorrupt.num, 0);
    assert.equal(f.modePortable.word, 'OFF');
    assert.equal(f.modeAutomotive.word, 'OFF');
    assert.equal(f.modeAirborne.word, 'ON');
    assert.equal(f.modeOther.word, 'OFF');
    assert.equal(f.radioSkipped.num, 0);
    assert.equal(f.radioErrors.num, 0);
    assert.deepEqual(blk.errors, []);
  }

  assert.equal(a.fields.lat.raw, '42.3368853');
  assert.equal(a.fields.lon.raw, '-71.0857403', 'the minus sign after the dashes stays');
  assert.equal(a.fields.alt.num, 49.4);
  assert.equal(a.fields.gpsRate.num, 772);
  assert.equal(a.fields.radioSent.num, 3532);
  assert.deepEqual(readPosition(a.fields), { lat: 42.3368853, lon: -71.0857403 });

  assert.equal(b.fields.lat.raw, '42.3368821');
  assert.equal(b.fields.lon.raw, '-71.0857330', 'a trailing zero is kept as printed');
  assert.equal(b.fields.lon.num, -71.085733);
  assert.equal(b.fields.alt.num, 48.3);
  assert.equal(b.fields.gpsRate.num, 763);
  assert.equal(b.fields.radioSent.num, 3533);
  assert.deepEqual(readPosition(b.fields), { lat: 42.3368821, lon: -71.085733 });
});

test('the real terminal output makes two CSV rows with the values as printed', () => {
  const { blocks } = feed(TERMINAL);
  const units = { alt: 'm', quality: '%', gpsRate: 'char/s' };
  const csv = buildCsv(blocks, units);
  const rows = csv.slice(1).trimEnd().split('\r\n');
  assert.equal(rows.length, 3, 'a header and one row per block');
  assert.equal(csvColumns(units).length, rows[0].split(',').length);
  assert.deepEqual(rows[1].split(',').slice(1), ['3533', '3533', 'LOCKED', '12', '89', '1.45', '42.3368853', '-71.0857403', '49.4', 'GOOD', '772', '0', 'OFF', 'OFF', 'ON', 'OFF', '3532', '0', '0', '']);
  assert.deepEqual(rows[2].split(',').slice(1), ['3534', '3534', 'LOCKED', '12', '89', '1.45', '42.3368821', '-71.0857330', '48.3', 'GOOD', '763', '0', 'OFF', 'OFF', 'ON', 'OFF', '3533', '0', '0', '']);
});
