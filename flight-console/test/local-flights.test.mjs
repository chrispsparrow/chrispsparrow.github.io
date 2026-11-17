// Checks LOCAL flights (js/local/): the storage, the recorder, loading a
// file, and the two exports, using the Komodo flight's serial log.
// IndexedDB isn't in Node, so these use the in-memory copy of the storage,
// which takes the same calls. Run it from the repo's root folder:
//   node --test flight-console/test/local-flights.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { openFlightDb } from '../js/local/flight-db.js';
import {
  createRecorder, saveRecording, findUnfinished, listSaved, readFlightFile, storeFile,
  openLocalFlight, rawLogText, csvText, exportsFor, exportFileName, defaultName,
  detectFlightFile, linesToBlocks, isLocalId, cleanName, STALE_MS,
} from '../js/local/local-flights.js';
import { BlockParser } from '../js/bench/parse.js?v=5';
import { buildCsv, blockUnits, readCsvBlocks } from '../js/bench/csv.js?v=6';
import { parseFile } from '../js/parser.js?v=3';

const LOG = readFileSync(new URL('../data/flights/komodo-sim-01/pc_sim_flight.log', import.meta.url), 'utf8');

// The lines the serial link hands over: split at \n, one \r taken off,
// and a last line with no \n after it is never finished.
function serialLines(text) {
  const parts = text.split('\n');
  parts.pop();
  return parts.map((l) => l.replace(/\r$/, ''));
}

// What SAVE AS CSV writes for those lines (bench-panel.js: one BlockParser,
// every line with the time it arrived, the cut-off block kept at the end).
function panelCsv(lines, times) {
  const parser = new BlockParser();
  const blocks = [];
  lines.forEach((line, i) => {
    const r = parser.push(line, times[i]);
    if (r.done) blocks.push(r.done);
  });
  const last = parser.finish();
  if (last) blocks.push(last);
  return buildCsv(blocks, blockUnits(blocks));
}

// A clock the test moves by hand.
function fakeClock(start = Date.UTC(2026, 10, 17, 19, 32, 0)) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

// Web Locks as the recorder and findUnfinished() use them.
function fakeLocks() {
  const held = new Map();
  return {
    request(name, opts, fn) {
      let done;
      const finished = new Promise((r) => { done = r; });
      held.set(name, true);
      Promise.resolve(fn()).then(() => { held.delete(name); done(); });
      return finished;
    },
    async query() { return { held: [...held.keys()].map((name) => ({ name })) }; },
  };
}

async function record(lines, { db, clock = fakeClock(), locks = null, flushEvery = 500 } = {}) {
  const rec = createRecorder({ db, now: clock.now, flushMs: 1e9, locks });
  rec.start();
  const times = [];
  lines.forEach((line, i) => {
    clock.advance(3);
    times.push(clock.now());
    rec.line(line, clock.now());
    if (i % flushEvery === flushEvery - 1) rec.flush();
  });
  const stopped = await rec.stop();
  return { rec, stopped, times };
}

test('the storage keeps records and chunks, and reads lines back in order', async () => {
  const db = await openFlightDb({ indexedDB: null });
  assert.equal(db.persistent, false);
  await db.putFlight({ id: 'local-a', status: 'saved', createdAt: 1 });
  await db.addChunk('local-a', 1, ['c', 'd'], [3, 4]);
  await db.addChunk('local-a', 0, ['a', 'b'], [1, 2]);
  assert.deepEqual(await db.readLines('local-a'), { lines: ['a', 'b', 'c', 'd'], times: [1, 2, 3, 4] });
  await db.addChunk('local-b', 0, ['x'], null);
  assert.deepEqual(await db.readLines('local-b'), { lines: ['x'], times: null });
  assert.equal((await db.listFlights()).length, 1);
  await db.deleteFlight('local-a');
  assert.equal(await db.getFlight('local-a'), null);
  assert.deepEqual(await db.readLines('local-a'), { lines: [], times: null });
});

test('a recording stores every line, and its raw log is the board\'s output exactly', async () => {
  const db = await openFlightDb({ indexedDB: null });
  const lines = serialLines(LOG);
  const { stopped, rec } = await record(lines, { db });
  assert.ok(isLocalId(stopped.id));
  assert.equal(stopped.status, 'recording');
  assert.equal(stopped.lineCount, lines.length);
  assert.ok(rec.stored());
  const data = await db.readLines(stopped.id);
  assert.deepEqual(data.lines, lines);
  assert.equal(data.times.length, lines.length);
  // pc_sim_flight.log ends with CRLF, so every line was finished.
  assert.ok(LOG.endsWith('\r\n'));
  assert.equal(rawLogText(stopped, data.lines), LOG);
});

test('a saved recording is named, summed up, and its CSV is what SAVE AS CSV writes', async () => {
  const db = await openFlightDb({ indexedDB: null });
  const lines = serialLines(LOG);
  const { stopped, times } = await record(lines, { db });
  const saved = await saveRecording(db, stopped, '   ');
  assert.equal(saved.status, 'saved');
  assert.equal(saved.title, defaultName(stopped.createdAt));
  assert.equal(saved.sampleCount, 356);
  assert.equal(saved.blockCount, 356);
  assert.equal(saved.durationS, 355);
  assert.deepEqual(exportsFor(saved), { rawLog: true, csv: true });
  const data = await db.readLines(saved.id);
  assert.equal(csvText(saved, data), panelCsv(lines, times));
  assert.deepEqual((await listSaved(db)).map((r) => r.id), [saved.id]);
  assert.match(exportFileName(saved, 'log'), /^dogtooth-flight-2026-11-17-\d{4}\.log$/);
  const named = await saveRecording(db, stopped, '  Komodo   test #2 ');
  assert.equal(named.title, 'Komodo test #2');
  assert.equal(exportFileName(named, 'csv'), 'dogtooth-komodo-test-2.csv');
  assert.equal(cleanName('x'.repeat(200), 0).length, 80);
});

test('a saved recording replays like the library\'s copy of the same log', async () => {
  const db = await openFlightDb({ indexedDB: null });
  const { stopped } = await record(serialLines(LOG), { db });
  const saved = await saveRecording(db, stopped, 'Komodo');
  const local = await openLocalFlight(db, saved.id);
  assert.equal(local.entry.groundStation, null);
  assert.equal(local.entry.title, 'Komodo');
  const flight = await local.load();
  const library = parseFile(LOG, 'pc_sim_flight.log', { defaultRocketId: '1' });
  assert.equal(flight.samples.length, library.samples.length);
  assert.deepEqual(flight.samples.map((s) => [s.t, s.gps?.lat, s.gps?.lon, s.gps?.altMsl]),
    library.samples.map((s) => [s.t, s.gps?.lat, s.gps?.lon, s.gps?.altMsl]));
  assert.equal(await openLocalFlight(db, 'local-nope'), null);
});

test('an empty connection records nothing worth keeping', async () => {
  const db = await openFlightDb({ indexedDB: null });
  const { stopped } = await record([], { db });
  assert.equal(stopped.lineCount, 0);
});

test('a recording left behind is found, unless another tab still holds it', async () => {
  const db = await openFlightDb({ indexedDB: null });
  const locks = fakeLocks();
  const clock = fakeClock();
  const live = createRecorder({ db, now: clock.now, flushMs: 1e9, locks });
  live.start();
  live.line('x', clock.now());
  await live.flush();
  // Still running in "another tab": its lock is held.
  assert.deepEqual(await findUnfinished(db, { locks }), []);
  await live.stop();
  assert.deepEqual(await findUnfinished(db, { locks }), [], 'the name box is still open, so the lock is held');
  live.release();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual((await findUnfinished(db, { locks })).map((r) => r.id), [live.record?.id ?? (await db.listFlights())[0].id]);
  // Without Web Locks, it counts once it hasn't been touched for a while.
  const rec = (await db.listFlights())[0];
  assert.deepEqual(await findUnfinished(db, { locks: null, now: rec.updatedAt + 1000 }), []);
  assert.equal((await findUnfinished(db, { locks: null, now: rec.updatedAt + STALE_MS + 1 })).length, 1);
  assert.deepEqual(await findUnfinished(db, { locks: null, now: rec.updatedAt + STALE_MS + 1, except: rec.id }), []);
});

test('a failed write is tried again, so no line is lost', async () => {
  const mem = await openFlightDb({ indexedDB: null });
  let fail = true;
  const problems = [];
  const db = { ...mem, addChunk: (...a) => (fail ? Promise.reject(Object.assign(new Error('full'), { name: 'QuotaExceededError' })) : mem.addChunk(...a)) };
  const clock = fakeClock();
  const rec = createRecorder({ db, now: clock.now, flushMs: 1e9, onProblem: (e) => problems.push(e?.name ?? null) });
  rec.start();
  rec.line('a', 1);
  await rec.flush();
  rec.line('b', 2);
  await rec.flush();
  assert.equal(rec.stored(), false);
  fail = false;
  rec.line('c', 3);
  const stopped = await rec.stop();
  assert.deepEqual((await mem.readLines(stopped.id)).lines, ['a', 'b', 'c']);
  assert.deepEqual(problems, ['QuotaExceededError', null]);
});

test('files are told apart by what is in them, not their names', () => {
  const blocks = linesToBlocks(serialLines(LOG), null);
  const csv = buildCsv(blocks, blockUnits(blocks));
  assert.equal(detectFlightFile(csv), 'csv');
  assert.equal(detectFlightFile(LOG), 'log');
  assert.equal(detectFlightFile('time,lat,lon\n1,2,3\n'), null);
  assert.equal(detectFlightFile('hello'), null);
  assert.equal(readFlightFile('', 'x.log').error, 'empty');
  assert.equal(readFlightFile('hello\nthere\n', 'x.log').error, 'unknown');
  assert.equal(readFlightFile(csv.split('\r\n')[0] + '\r\n', 'x.csv').error, 'no-data');
  // A raw log named .csv is still a raw log.
  const misnamed = readFlightFile(LOG, 'flight.csv');
  assert.equal(misnamed.record.kind, 'log');
  assert.equal(misnamed.record.sampleCount, 356);
  assert.equal(misnamed.record.title, 'flight');
});

test('a loaded CSV file replays, and exports back byte for byte', async () => {
  const db = await openFlightDb({ indexedDB: null });
  const lines = serialLines(LOG);
  const times = lines.map((_, i) => Date.UTC(2026, 10, 17, 6) + i * 7);
  const csv = panelCsv(lines, times);
  const loaded = readFlightFile(csv, 'dogtooth-bench-2026-11-17-0600.csv', Date.UTC(2026, 10, 17, 7));
  assert.equal(loaded.record.kind, 'csv');
  assert.equal(loaded.record.title, 'dogtooth-bench-2026-11-17-0600');
  assert.deepEqual(exportsFor(loaded.record), { rawLog: false, csv: true });
  await storeFile(db, loaded.record, loaded.lines, 50);
  const data = await db.readLines(loaded.record.id);
  assert.equal(csvText(loaded.record, data), csv);
  // Read back as blocks and written again, it's the same file too.
  const back = readCsvBlocks(csv);
  assert.equal(buildCsv(back.blocks, back.units), csv);
  const flight = await (await openLocalFlight(db, loaded.record.id)).load();
  // The same blocks read straight from the log (its packet lines taken out,
  // as a board on USB prints it) give the same readings. (The packet lines
  // keep the last position while the fix is lost, and the blocks don't, so
  // the whole log isn't the thing to compare with.)
  const blocksOnly = LOG.split('\r\n').filter((l) => !l.startsWith('SIM PKT')).join('\r\n');
  const fromLog = parseFile(blocksOnly, 'board.log', { defaultRocketId: '1' });
  assert.equal(fromLog.format, 'serial-log-blocks');
  assert.equal(flight.files[0].format, 'console-csv');
  assert.deepEqual(flight.samples.map((s) => [s.t, s.gps?.fix, s.gps?.lat, s.gps?.lon, s.gps?.altMsl, s.gps?.sats, s.gps?.hdop]),
    fromLog.samples.map((s) => [s.t, s.gps?.fix, s.gps?.lat, s.gps?.lon, s.gps?.altMsl, s.gps?.sats, s.gps?.hdop]));
});

test('a loaded raw log exports back exactly, with its own line endings', async () => {
  const db = await openFlightDb({ indexedDB: null });
  const lf = LOG.replace(/\r\n/g, '\n');
  for (const text of [LOG, lf, lf.replace(/\n$/, '')]) {
    const loaded = readFlightFile(text, 'pc_sim_flight.log');
    await storeFile(db, loaded.record, loaded.lines, 1000);
    const data = await db.readLines(loaded.record.id);
    assert.equal(rawLogText(loaded.record, data.lines), text);
    // No arrival times in a file, so the CSV's PC time is left empty.
    const csv = csvText(loaded.record, data);
    assert.match(csv.split('\r\n')[1], /^,\d+,/);
    assert.equal(buildCsv(readCsvBlocks(csv).blocks, readCsvBlocks(csv).units), csv);
  }
});

test('a log with only packet lines has no CSV to export', () => {
  const packets = LOG.split('\r\n').filter((l) => l.startsWith('SIM PKT')).join('\r\n') + '\r\n';
  const loaded = readFlightFile(packets, 'packets.log');
  assert.equal(loaded.record.blockCount, 0);
  assert.deepEqual(exportsFor(loaded.record), { rawLog: true, csv: false });
  assert.equal(csvText(loaded.record, { lines: loaded.lines, times: null }), null);
});
