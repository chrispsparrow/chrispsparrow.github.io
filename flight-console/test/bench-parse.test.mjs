// Checks js/bench/parse.js and js/bench/csv.js against the board's status block.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/bench-parse.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlockParser, FIELDS, parseDuration, parseLine, readLock, readPosition } from '../js/bench/parse.js?v=3';
import { buildCsv, csvColumns } from '../js/bench/csv.js?v=3';

// The block exactly as the board prints it.
const EXAMPLE = `==================== HEARTBEAT #65 | TIME RUNNING: 1 min 5.3 s ====================

GPS
  TARGET LOCK [GPS]: ------------------ LOCKED
  CONNECTED SATELLITES: --------------- 11
  LOCK QUALITY: ----------------------- 100 % (HDOP 0.99)
  LATITUDE: --------------------------- 42.3386255
  LONGITUDE: -------------------------- -71.0896268
  ALTITUDE: --------------------------- 17.3 m
  GPS DATA RATE: ---------------------- GOOD 723 char/s
  CORRUPTED DATA OCCURRENCES (GPS): --- 1

GPS MOTION MODEL
  PORTABLE: --------------------------- OFF
  AUTOMOTIVE: ------------------------- OFF
  AIRBORNE 4G: ------------------------ ON
  OTHER: ------------------------------ OFF

RADIO
  RADIO PACKETS SENT: ----------------- 65
  RADIO PACKETS SKIPPED: -------------- 0
  RADIO PACKET ERROR OCCURRENCES: ----- 0
`;

// A block like the board's, with values swapped in. `over` is
// { label: value }, and a label set to null leaves its line out.
function makeBlock(beat, time, over = {}) {
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
    `==================== HEARTBEAT #${beat} | TIME RUNNING: ${time} ====================`,
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
  ].filter((l) => l !== null).join('\r\n');
}

// Feeds text through a BlockParser, line by line, like the page does.
// Returns the finished blocks, every banner result, the errors and a
// count of each line type.
function feed(text, parser = new BlockParser(), t0 = 1_700_000_000_000) {
  const blocks = [];
  const banners = [];
  const errors = [];
  const types = {};
  text.split('\n').forEach((raw, i) => {
    const r = parser.push(raw.replace(/\r$/, ''), t0 + i);
    types[r.type] = (types[r.type] || 0) + 1;
    if (r.done) blocks.push(r.done);
    if (r.type === 'banner') banners.push(r);
    if (r.type === 'error') errors.push(r.message);
  });
  return { blocks, banners, errors, types, parser };
}

test('the example block reads every field', () => {
  const { blocks, banners, types } = feed(EXAMPLE);
  assert.equal(blocks.length, 1, 'the blank line after RADIO finishes the block');
  const b = blocks[0];
  assert.equal(b.heartbeat, 65);
  assert.equal(b.timeRunning, 65.3);
  assert.equal(b.timeText, '1 min 5.3 s');
  assert.equal(banners[0].missed, 0);
  assert.equal(banners[0].restarted, false);
  assert.deepEqual(types, { banner: 1, empty: 4, section: 3, field: 15 });

  const f = b.fields;
  assert.deepEqual(Object.keys(f).sort(), FIELDS.map((x) => x.key).sort(), 'every field in FIELDS is found');
  assert.equal(f.lock.word, 'LOCKED');
  assert.equal(f.lock.tone, 'good');
  assert.equal(f.sats.num, 11);
  assert.equal(f.quality.num, 100);
  assert.equal(f.quality.unit, '%');
  assert.equal(f.quality.hdop, 0.99);
  assert.equal(f.quality.hdopRaw, '0.99');
  assert.equal(f.lat.num, 42.3386255);
  assert.equal(f.lat.raw, '42.3386255');
  assert.equal(f.lon.num, -71.0896268, 'the minus sign after the dashes stays');
  assert.equal(f.lon.raw, '-71.0896268');
  assert.equal(f.alt.num, 17.3);
  assert.equal(f.alt.unit, 'm');
  assert.equal(f.gpsRate.word, 'GOOD');
  assert.equal(f.gpsRate.tone, 'good');
  assert.equal(f.gpsRate.num, 723);
  assert.equal(f.gpsRate.unit, 'char/s');
  assert.equal(f.gpsCorrupt.num, 1);
  assert.equal(f.modePortable.word, 'OFF');
  assert.equal(f.modeAutomotive.tone, 'off');
  assert.equal(f.modeAirborne.word, 'ON');
  assert.equal(f.modeAirborne.tone, 'on');
  assert.equal(f.modeOther.word, 'OFF');
  assert.equal(f.radioSent.num, 65);
  assert.equal(f.radioSkipped.num, 0);
  assert.equal(f.radioErrors.num, 0);
  assert.deepEqual(readPosition(f), { lat: 42.3386255, lon: -71.0896268 });
  assert.equal(readLock(f.lock), true);
});

test('a block also finishes at the next banner', () => {
  // The same block with no blank line after RADIO.
  const text = EXAMPLE.trimEnd() + '\n' + makeBlock(66, '1 min 6.3 s');
  const { blocks } = feed(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].heartbeat, 65);
  assert.equal(blocks[0].fields.radioErrors.num, 0, 'the last line of the first block still counts');
  assert.equal(blocks[1].heartbeat, 66);
});

test('a SEARCHING sample', () => {
  const text = makeBlock(3, '3.1 s', {
    'TARGET LOCK [GPS]': 'SEARCHING',
    'CONNECTED SATELLITES': '0',
    'LOCK QUALITY': '0 % (HDOP 99.99)',
    LATITUDE: '0.0000000',
    LONGITUDE: '0.0000000',
    ALTITUDE: '0.0 m',
  });
  const [b] = feed(text).blocks;
  assert.equal(b.fields.lock.word, 'SEARCHING');
  assert.equal(b.fields.lock.tone, 'bad');
  assert.equal(readLock(b.fields.lock), false);
  assert.equal(b.fields.sats.num, 0);
  assert.equal(b.fields.quality.num, 0);
  assert.equal(b.fields.quality.hdop, 99.99);
  assert.equal(readPosition(b.fields), null, 'no position while SEARCHING');

  // Even a real-looking position doesn't count while SEARCHING.
  const [b2] = feed(makeBlock(4, '4.1 s', { 'TARGET LOCK [GPS]': 'SEARCHING' })).blocks;
  assert.equal(readPosition(b2.fields), null);
});

test('LOW and SILENT data rates', () => {
  const [low] = feed(makeBlock(10, '10.0 s', { 'GPS DATA RATE': 'LOW 212 char/s' })).blocks;
  assert.equal(low.fields.gpsRate.word, 'LOW');
  assert.equal(low.fields.gpsRate.tone, 'warn');
  assert.equal(low.fields.gpsRate.num, 212);
  assert.equal(low.fields.gpsRate.unit, 'char/s');

  const [silent] = feed(makeBlock(11, '11.0 s', { 'GPS DATA RATE': 'SILENT 0 char/s' })).blocks;
  assert.equal(silent.fields.gpsRate.word, 'SILENT');
  assert.equal(silent.fields.gpsRate.tone, 'bad');
  assert.equal(silent.fields.gpsRate.num, 0);

  // A status word with no rate after it still reads.
  const bare = parseLine('  GPS DATA RATE: ---------------------- SILENT');
  assert.equal(bare.value.word, 'SILENT');
  assert.equal(bare.value.num, null);
});

test('an Error: line goes to the errors and leaves the block alone', () => {
  const lines = EXAMPLE.split('\n');
  // Put an error in the middle of the GPS section.
  lines.splice(5, 0, 'Error: radio not ready, code 3');
  const { blocks, errors } = feed(lines.join('\n'));
  assert.deepEqual(errors, ['radio not ready, code 3']);
  assert.equal(blocks.length, 1);
  assert.equal(Object.keys(blocks[0].fields).length, FIELDS.length, 'no field was lost around the error');
  assert.deepEqual(blocks[0].errors, ['radio not ready, code 3'], 'the block keeps its error for the CSV');

  assert.deepEqual(parseLine('Error: GPS UART framing error'), { type: 'error', message: 'GPS UART framing error' });
  assert.equal(parseLine('ERROR: shouting').type, 'error');
});

test('each error is kept with the block from its banner until the next one', () => {
  const p = new BlockParser();
  const text = [
    'Error: before any banner',
    makeBlock(10, '10.3 s'),
    // After the blank line that ends block 10, before the next banner.
    'Error: GPS UART framing error',
    'Error: GPS UART framing error',
    makeBlock(11, '11.3 s'),
  ].join('\n');
  const { blocks, errors } = feed(text, p);
  assert.equal(errors.length, 3, 'every error still reaches the errors box');
  assert.deepEqual(blocks.map((b) => b.errors), [['GPS UART framing error', 'GPS UART framing error'], []]);

  // After a new connection, an error before the first banner belongs to
  // no block, not to the one from before the disconnect.
  p.newConnection();
  feed('Error: after reconnect', p);
  assert.deepEqual(blocks[1].errors, []);
});

test('TIME RUNNING past 60 s and past 1 hour', () => {
  assert.equal(parseDuration('5.3 s'), 5.3);
  assert.equal(parseDuration('59.9 s'), 59.9);
  assert.equal(parseDuration('1 min 5.3 s'), 65.3);
  assert.equal(parseDuration('10 min 0.0 s'), 600);
  assert.equal(parseDuration('59 min 59.9 s'), 3599.9);
  assert.equal(parseDuration('1 h 2 min 5 s'), 3725);
  assert.equal(parseDuration('1 h 0 min 0.1 s'), 3600.1);
  assert.equal(parseDuration('26 h 3 min 7.5 s'), 93787.5);
  assert.equal(parseDuration('2 min'), 120);
  assert.equal(parseDuration('5.3'), null, 'a number with no unit');
  assert.equal(parseDuration('5.3 ms'), null, 'a unit the board doesn\'t use');
  assert.equal(parseDuration('soon'), null);

  const { blocks } = feed(makeBlock(3725, '1 h 2 min 5 s') + '\n' + makeBlock(3726, '1 h 2 min 6.1 s'));
  assert.deepEqual(blocks.map((b) => b.timeRunning), [3725, 3726.1]);
});

test('a skipped heartbeat number counts as lost blocks', () => {
  const p = new BlockParser();
  const { banners } = feed([makeBlock(63, '1 min 3.3 s'), makeBlock(64, '1 min 4.3 s'), makeBlock(66, '1 min 6.3 s'), makeBlock(70, '1 min 10.3 s')].join('\n'), p);
  assert.deepEqual(banners.map((b) => b.missed), [0, 0, 1, 3]);
  assert.ok(banners.every((b) => !b.restarted));

  // A new connection: the jump while the port was closed isn't lost.
  p.newConnection();
  const after = feed(makeBlock(400, '6 min 40.3 s'), p).banners;
  assert.equal(after[0].missed, 0);
  assert.equal(after[0].restarted, false);

  // The board restarts: the count and the time go back. Not lost blocks.
  const restart = feed(makeBlock(1, '1.0 s'), p).banners;
  assert.equal(restart[0].missed, 0);
  assert.equal(restart[0].restarted, true);

  // A restart is still caught after a new connection, from the time.
  p.newConnection();
  const again = feed(makeBlock(30, '0.9 s'), p).banners;
  assert.equal(again[0].restarted, true);
});

test('lines outside a block, unknown labels and odd values', () => {
  const start = 'DOGTOOTH_V1_FIRMWARE flight computer\nRadio: 915.000 MHz, BW 125.0 kHz\nGPS\n  ALTITUDE: ---- 17.3 m\n';
  const { blocks, types } = feed(start + EXAMPLE);
  assert.equal(types.other, 4, 'lines before the first banner are only raw output');
  assert.equal(blocks.length, 1);

  const withNew = EXAMPLE.replace('RADIO\n', 'RADIO\n  RADIO TEMPERATURE: ------------- 31 C\n');
  const r = feed(withNew);
  assert.equal(r.blocks.length, 1);
  assert.equal(r.types.other, 1, 'an unknown label is skipped');
  assert.equal(Object.keys(r.blocks[0].fields).length, FIELDS.length);

  assert.equal(parseLine('  LATITUDE: -71.5').value.num, -71.5, 'no dashes and a minus sign');
  assert.equal(parseLine('  LATITUDE: ----------').value.text, '', 'only dashes means no value');
  assert.equal(parseLine('  ALTITUDE: ------- --').value.num, null);
  assert.equal(parseLine('  LOCK QUALITY: --- -- % (HDOP --)').value.num, null);
  assert.equal(parseLine('  TARGET LOCK [GPS]: ---- 2D').value.tone, '', 'a word the page doesn\'t know has no color');
  assert.equal(parseLine('==========================').type, 'other', 'a plain line of = is not a banner');
});

test('the CSV has one row per block and splits the two-part values', () => {
  const { blocks } = feed(EXAMPLE + makeBlock(66, '1 min 6.3 s', { 'TARGET LOCK [GPS]': 'SEARCHING', 'GPS DATA RATE': 'LOW 212 char/s' })
    + '\nError: radio not ready, code 3\nError: GPS UART framing error\n');
  const units = { alt: 'm', quality: '%', gpsRate: 'char/s' };
  const csv = buildCsv(blocks, units);
  assert.equal(csv.charCodeAt(0), 0xfeff, 'starts with a byte order mark');
  const rows = csv.slice(1).trimEnd().split('\r\n');
  assert.equal(rows.length, 3, 'a header and one row per block');
  assert.equal(rows[0], 'PC time (UTC),HEARTBEAT #,TIME RUNNING (s),TARGET LOCK [GPS],CONNECTED SATELLITES,LOCK QUALITY (%),HDOP,LATITUDE (°),LONGITUDE (°),ALTITUDE (m),GPS DATA RATE STATUS,GPS DATA RATE (char/s),CORRUPTED DATA OCCURRENCES (GPS),GPS MOTION MODEL PORTABLE,GPS MOTION MODEL AUTOMOTIVE,GPS MOTION MODEL AIRBORNE 4G,GPS MOTION MODEL OTHER,RADIO PACKETS SENT,RADIO PACKETS SKIPPED,RADIO PACKET ERROR OCCURRENCES,ERRORS');
  const cells = rows[1].split(',');
  assert.match(cells[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.deepEqual(cells.slice(1), ['65', '65.3', 'LOCKED', '11', '100', '0.99', '42.3386255', '-71.0896268', '17.3', 'GOOD', '723', '1', 'OFF', 'OFF', 'ON', 'OFF', '65', '0', '0', ''], 'no errors in the first block');
  const cells2 = rows[2].split(',');
  assert.deepEqual([cells2[1], cells2[2], cells2[3], cells2[10], cells2[11]], ['66', '66.3', 'SEARCHING', 'LOW', '212']);
  // The message has a comma, so the cell is quoted.
  assert.ok(rows[2].endsWith(',"radio not ready, code 3 | GPS UART framing error"'), rows[2]);
  assert.equal(csvColumns(units).length, cells.length);
});
