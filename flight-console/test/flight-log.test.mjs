// Checks launch mode's flight log without a page: the file format
// (js/launch/log-format.js), the two copies that write it (the disk file and
// the local server's copy, js/launch/log-sinks.js) with a stand-in file and
// a stand-in server that fail in every way they can, loading a log back
// into the console (js/parser.js and js/local/local-flights.js), and how a
// saved capture is paced and moved for the test capture
// (js/launch/capture-plan.js).
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/flight-log.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LOG_PREFIX, formatLogTime, dataLine, noteLine, headerLines, logFileName, otherFileName, createLogText, byteLength,
} from '../js/launch/log-format.js';
import { createDiskSink, createServerSink, KEEPALIVE_MAX_BYTES } from '../js/launch/log-sinks.js';
import {
  planCapture, captureTimes, readCapture, shiftLines, firstFix, cleanSpeed, MAX_GAP_S,
} from '../js/launch/capture-plan.js';
import { parseFile, readFlightLogLine } from '../js/parser.js?v=3';
import { readFlightFile, detectFlightFile, storeFile, openLocalFlight, linesToBlocks, rawLogText } from '../js/local/local-flights.js';
import { openFlightDb } from '../js/local/flight-db.js';
import { createSourceDetector } from '../js/live/sources.js';
import { createFlightFeed } from '../js/live/flight-feed.js';
import { LIVE_STORE_OPTIONS } from '../js/live/bench-feed.js';
import { createStore } from '../js/store.js';
import { createFleet } from '../js/fleet.js';

const CAPTURE = readFileSync(new URL('./radio-board-rx-capture.log', import.meta.url), 'utf8');
const CAPTURE_LINES = CAPTURE.split(/\r?\n/).filter((l) => l !== '');
const KOMODO = readFileSync(new URL('../data/flights/komodo-sim-01/pc_sim_flight.log', import.meta.url), 'utf8');
const FIELD = JSON.parse(readFileSync(new URL('../../launch-mode/field.json', import.meta.url), 'utf8')).center;
const START = Date.UTC(2026, 10, 21, 19, 3, 20, 4);

// A flight log the way the launch page writes one: the header, then each
// line with the time it arrived. reconnectAfter puts a dropped cable after
// that many lines.
function writeLog(lines, { start = START, every = 500, reconnectAfter = null, writer } = {}) {
  const text = createLogText();
  for (const l of headerLines(start, writer ? { writer } : {})) text.add(l);
  let t = start;
  lines.forEach((line, i) => {
    if (i === reconnectAfter) {
      text.add(noteLine(`connection closed ${formatLogTime(t + 100)}`));
      t += 20000;
      text.add(noteLine(`connected ${formatLogTime(t)}`));
    }
    t += every;
    text.add(dataLine(line, t), true);
  });
  return text;
}

const sampleKey = (s) => [s.rocketId, s.t, s.gps?.lat, s.gps?.lon, s.gps?.altMsl, s.gps?.fix, s.radio?.rssi, s.extra?.seq];

// ------------------------------------------------------------------
// The format
// ------------------------------------------------------------------

test('a data line is the local time with milliseconds and the UTC offset, " > ", then the line as it came', () => {
  for (const ms of [START, Date.UTC(2026, 6, 4, 3, 0, 0, 999), Date.UTC(2027, 0, 1, 0, 0, 0, 0)]) {
    const stamp = formatLogTime(ms);
    assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    assert.equal(Date.parse(stamp), ms, 'the time reads back to the same millisecond');
  }
  const raw = '  PKT node=1 seq=806  trailing spaces stay   ';
  const line = dataLine(raw, START);
  assert.ok(line.endsWith(`${raw}\n`), 'nothing is trimmed');
  assert.match(line, LOG_PREFIX);
  assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} > /);
  assert.deepEqual(readFlightLogLine(line.slice(0, -1)), { line: raw, t: START });
  assert.equal(readFlightLogLine('# connected 2026-11-21T14:03:22.123-05:00'), null);
  assert.equal(readFlightLogLine('14:03:22.123 > PKT node=1'), null, 'PlatformIO\'s time is not a flight log time');
});

test('the header says what the file is, and the file names follow the plan', () => {
  const lines = headerLines(START, { notes: ['test capture, not live data'] });
  assert.equal(lines[0], '# Dogtooth flight log\n');
  assert.equal(lines[1], `# started ${formatLogTime(START)}\n`);
  assert.equal(lines[2], '# written by the Flight Console launch page\n');
  assert.equal(lines[3], '# each line: the time it arrived on this computer, then \' > \', then the receiver\'s line\n');
  assert.equal(lines[4], '# test capture, not live data\n');
  assert.equal(headerLines(START, { writer: 'the backup logger on COM5 at 115200 baud' })[2], '# written by the backup logger on COM5 at 115200 baud\n');
  const d = new Date(START);
  const p = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const hm = `${p(d.getHours())}${p(d.getMinutes())}`;
  assert.equal(logFileName('flight', START), `flight-${day}-${hm}.log`);
  assert.equal(logFileName('flight', START, 'server'), `flight-${day}-${hm}${p(d.getSeconds())}-page.log`);
  assert.equal(logFileName('test', START), `test-capture-${day}-${hm}.log`);
  assert.equal(logFileName('test', START, 'server'), `test-capture-${day}-${hm}${p(d.getSeconds())}-page.log`);
  const other = otherFileName(logFileName('flight', START, 'server'), () => 0.5);
  assert.match(other, /^flight-\d{4}-\d{2}-\d{2}-\d{6}-page-[a-z0-9]{4}\.log$/);
  assert.match(otherFileName(other, () => 0.25), /^flight-\d{4}-\d{2}-\d{2}-\d{6}-page-[a-z0-9]{4}\.log$/, 'a second rename does not stack');
});

test('the log text knows how many bytes its first k lines take, so a file\'s size says how many lines it has', () => {
  const text = createLogText();
  text.add('# Dogtooth flight log\n');
  text.add('2026-11-21T14:03:22.123-05:00 > PKT a\n', true);
  text.add('2026-11-21T14:03:22.124-05:00 > Ünïcödé °\n', true);
  assert.equal(text.count, 3);
  assert.equal(text.dataCount, 2);
  assert.equal(byteLength('Ünïcödé °'), Buffer.byteLength('Ünïcödé °'));
  assert.equal(text.bytes, Buffer.byteLength(text.text(0, 3)));
  for (let k = 0; k <= 3; k++) assert.equal(text.lineAtBytes(text.bytesAt(k)), k);
  assert.equal(text.lineAtBytes(5), -1);
  assert.equal(text.lineAtBytes(text.bytes + 1), -1);
  assert.equal(text.dataAt(1), 0);
  assert.equal(text.dataAt(3), 2);
});

// ------------------------------------------------------------------
// The disk file
// ------------------------------------------------------------------

// A stand-in for a FileSystemFileHandle that behaves like the real one:
// a writable writes into a copy, and the file changes only on close().
function fakeFile(initial = '') {
  let content = Buffer.from(initial);
  const faults = [];      // 'write' | 'close' | 'close-after' | 'size', used up in order
  let open = 0;
  let maxOpen = 0;
  const handle = {
    name: 'flight-2026-11-21-1403.log',
    async getFile() {
      if (faults[0] === 'size') { faults.shift(); throw new Error('could not read the size'); }
      return { size: content.length };
    },
    async createWritable({ keepExistingData } = {}) {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      let swap = keepExistingData ? Buffer.from(content) : Buffer.alloc(0);
      let at = 0;
      return {
        async seek(n) { at = n; },
        async write(data) {
          if (faults[0] === 'write') { faults.shift(); throw new Error('the disk is full'); }
          const bytes = Buffer.from(data);
          const grown = Buffer.alloc(Math.max(swap.length, at + bytes.length));
          swap.copy(grown);
          bytes.copy(grown, at);
          swap = grown;
          at += bytes.length;
        },
        async close() {
          open -= 1;
          if (faults[0] === 'close') { faults.shift(); throw new Error('the close failed'); }
          content = swap;
          if (faults[0] === 'close-after') { faults.shift(); throw new Error('the close reported an error after it landed'); }
        },
        async abort() { open -= 1; },
      };
    },
  };
  return { handle, faults, text: () => content.toString('utf8'), get maxOpen() { return maxOpen; } };
}

test('the disk file gets every line in order, through failed writes and closes, and never a line twice', async () => {
  const text = writeLog(CAPTURE_LINES.slice(0, 40));
  const file = fakeFile();
  let clock = 1000;
  const disk = createDiskSink({ text, now: () => clock });
  assert.equal(await disk.cycle(), false, 'no file yet');
  disk.use(file.handle);
  assert.equal(await disk.cycle(), true);
  assert.equal(file.text(), text.text(0, text.count));
  assert.equal(disk.state().lines, 40);
  assert.equal(disk.state().lastWriteAt, 1000);

  // More lines, with every kind of failure on the way.
  const more = CAPTURE_LINES.slice(40, 80);
  for (const [i, kind] of ['write', 'close', 'close-after', 'size'].entries()) {
    for (const line of more.slice(i * 10, i * 10 + 10)) text.add(dataLine(line, START + i), true);
    file.faults.push(kind);
    clock += 1000;
    assert.equal(await disk.cycle(), false, `${kind} fails the cycle`);
    assert.ok(disk.state().error, `${kind} is shown`);
    clock += 1000;
    assert.equal(await disk.cycle(), true, `the next cycle after ${kind} catches up`);
    assert.equal(disk.state().error, null);
    assert.equal(file.text(), text.text(0, text.count), `after ${kind}: the file is the log, nothing doubled or lost`);
  }
  assert.equal(disk.state().lines, 80);
  assert.equal(disk.state().pending, 0);
});

test('the disk file keeps what it held, runs one cycle at a time, and a new file gets everything so far', async () => {
  const text = writeLog(CAPTURE_LINES.slice(0, 10));
  const file = fakeFile('an older log that must stay\n');
  const disk = createDiskSink({ text });
  disk.use(file.handle);
  const a = disk.cycle();
  const b = disk.cycle();
  assert.equal(a, b, 'a second call joins the running cycle');
  await a;
  assert.equal(file.maxOpen, 1);
  assert.equal(file.text(), `an older log that must stay\n${text.text(0, text.count)}`);
  // Something else added to the file: this log carries on after it.
  for (const line of CAPTURE_LINES.slice(10, 12)) text.add(dataLine(line, START), true);
  await disk.cycle();
  assert.equal(file.text(), `an older log that must stay\n${text.text(0, text.count)}`);

  const later = fakeFile();
  disk.use(later.handle);
  assert.equal(disk.state().lines, 0);
  await disk.cycle();
  assert.equal(later.text(), text.text(0, text.count), 'a file chosen later gets every line recorded so far');
});

// ------------------------------------------------------------------
// The server's copy
// ------------------------------------------------------------------

// A stand-in for launch-mode/server.mjs's POST /launch-mode/log/append, and
// a fetch that can lose answers, time out or be refused.
function fakeServer() {
  const files = new Map();
  const faults = [];   // 'lost' (written, answer lost), 'down' (not written, no answer), 'error' (500, not written)
  const calls = [];
  const append = (name, body) => {
    const old = files.get(name) ?? Buffer.alloc(0);
    const next = Buffer.concat([old, Buffer.from(body ?? '')]);
    files.set(name, next);
    return next.length;
  };
  async function fetch(url, { body, method } = {}) {
    const name = new URL(url, 'http://localhost/').searchParams.get('name');
    const text = body instanceof Uint8Array ? Buffer.from(body).toString('utf8') : String(body ?? '');
    calls.push({ name, bytes: Buffer.byteLength(text), method });
    const fault = faults.shift();
    if (fault === 'down') throw new TypeError('Failed to fetch');
    if (fault === 'error') return { ok: false, status: 500, json: async () => ({ ok: false, error: 'disk full' }) };
    const bytes = append(name, text);
    if (fault === 'lost') throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, json: async () => ({ ok: true, name, bytes }) };
  }
  return { files, faults, calls, fetch, append, text: (name) => (files.get(name) ?? Buffer.alloc(0)).toString('utf8') };
}

test('the server copy is the log exactly, through lost answers, a server that is down, and errors', async () => {
  const server = fakeServer();
  const text = writeLog(CAPTURE_LINES.slice(0, 20));
  const name = logFileName('flight', START, 'server');
  const sink = createServerSink({ text, name, url: '/launch-mode/log/append', fetch: server.fetch });
  assert.equal(await sink.cycle(), true);
  assert.equal(server.text(name), text.text(0, text.count));
  assert.equal(sink.state().state, 'saving');
  assert.equal(sink.state().lines, 20);

  let at = 20;
  for (const fault of ['lost', 'down', 'error', 'lost']) {
    for (const line of CAPTURE_LINES.slice(at, at + 15)) text.add(dataLine(line, START), true);
    at += 15;
    server.faults.push(fault);
    assert.equal(await sink.cycle(), false, `${fault} fails the cycle`);
    assert.equal(sink.state().state, 'failing');
    assert.equal(await sink.cycle(), true, `the next cycle after ${fault} catches up`);
    assert.equal(server.text(name), text.text(0, text.count), `after ${fault}: nothing doubled or lost`);
  }
  assert.equal(sink.state().lines, 80);
  assert.equal(server.files.size, 1);
});

test('the server copy never adds to a file that was already there, and says when there is no server', async () => {
  const server = fakeServer();
  const name = logFileName('flight', START, 'server');
  server.append(name, 'another page\'s log\n');
  const text = writeLog(CAPTURE_LINES.slice(0, 5));
  const sink = createServerSink({ text, name, url: '/x', fetch: server.fetch, rename: (n) => n.replace('.log', '-ab12.log') });
  assert.equal(await sink.cycle(), true);
  assert.equal(server.text(name), 'another page\'s log\n', 'the other file is left alone');
  assert.equal(sink.state().name, name.replace('.log', '-ab12.log'));
  assert.equal(server.text(sink.state().name), text.text(0, text.count));

  const absent = createServerSink({
    text, name, url: '/x', fetch: async () => ({ ok: false, status: 405, json: async () => { throw new Error('not json'); } }),
  });
  assert.equal(await absent.cycle(), false);
  assert.equal(absent.state().state, 'none');
});

test('the last request when the page closes sends what is left, and a page that lives on never doubles it', async () => {
  const server = fakeServer();
  const name = 'flight-x-page.log';
  const beacons = [];
  const text = writeLog(CAPTURE_LINES.slice(0, 10));
  const sink = createServerSink({
    text, name, url: '/a', fetch: server.fetch,
    sendBeacon: (url, blob) => { beacons.push({ url, blob }); return true; },
  });
  assert.equal(sink.beacon(), 0, 'nothing goes before the server has been heard from');
  await sink.cycle();
  for (const line of CAPTURE_LINES.slice(10, 30)) text.add(dataLine(line, START), true);
  assert.equal(sink.beacon(), 20);
  assert.equal(beacons.length, 1);
  assert.match(beacons[0].url, /name=flight-x-page\.log$/);
  // The beacon lands.
  server.append(name, Buffer.from(await beacons[0].blob.arrayBuffer()).toString('utf8'));
  assert.equal(server.text(name), text.text(0, text.count));
  // The page lived on: the next cycle asks first and sends nothing twice.
  for (const line of CAPTURE_LINES.slice(30, 35)) text.add(dataLine(line, START), true);
  assert.equal(await sink.cycle(), true);
  assert.equal(server.text(name), text.text(0, text.count));
  // A beacon that never landed: the next cycle sends those lines itself.
  for (const line of CAPTURE_LINES.slice(35, 40)) text.add(dataLine(line, START), true);
  assert.equal(sink.beacon(), 5);
  assert.equal(await sink.cycle(), true);
  assert.equal(server.text(name), text.text(0, text.count));
  // A big backlog goes in pieces the browser lets outlive the page.
  for (let i = 0; i < 2000; i++) text.add(dataLine(CAPTURE_LINES[i % CAPTURE_LINES.length], START), true);
  const sentLines = sink.beacon();
  assert.ok(sentLines > 0 && sentLines < 2000);
  assert.ok((await beacons.at(-1).blob.arrayBuffer()).byteLength <= KEEPALIVE_MAX_BYTES);
});

// ------------------------------------------------------------------
// Loading a log back
// ------------------------------------------------------------------

test('a launch log of the capture parses to exactly the samples of the capture itself', () => {
  const plain = parseFile(CAPTURE, 'radio-board-rx-capture.log');
  assert.equal(plain.samples.length, 126);
  const log = writeLog(CAPTURE_LINES).text(0, Infinity);
  const logged = parseFile(log, 'flight-2026-11-21-1403.log');
  assert.equal(logged.format, plain.format);
  assert.equal(logged.badRows, 0);
  assert.deepEqual(logged.samples.map(sampleKey), plain.samples.map(sampleKey));
  // The same with Windows line ends, and as the backup logger writes it.
  assert.deepEqual(parseFile(log.replace(/\n/g, '\r\n'), 'x.log').samples.map(sampleKey), plain.samples.map(sampleKey));
  const backup = writeLog(CAPTURE_LINES, { writer: 'the backup logger on COM5 at 115200 baud' }).text(0, Infinity);
  assert.deepEqual(parseFile(backup, 'backup-2026-11-21-140320.log').samples.map(sampleKey), plain.samples.map(sampleKey));
});

test('a log with a reconnect in the middle loads, keeps its arrival times, and replays every sample', async () => {
  const log = writeLog(CAPTURE_LINES, { reconnectAfter: 101 }).text(0, Infinity);
  assert.ok(log.includes('# connection closed '));
  assert.ok(log.includes('# connected '));
  assert.equal(detectFlightFile(log), 'log');
  const loaded = readFlightFile(log, 'flight-2026-11-21-1403.log', START);
  assert.equal(loaded.error, undefined);
  assert.equal(loaded.record.kind, 'log');
  assert.equal(loaded.record.sampleCount, 126);
  assert.equal(loaded.lines.length, 4 + 253 + 2);
  // The arrival times come from the prefixes, and the "#" lines have none.
  assert.equal(loaded.times.length, loaded.lines.length);
  assert.equal(loaded.times[0], null);
  assert.equal(loaded.times[4], START + 500);
  assert.ok(loaded.times[4 + 101 + 2] - loaded.times[4 + 100] >= 20000, 'the gap of the reconnect is in the times');

  const db = await openFlightDb({ indexedDB: null });
  await storeFile(db, loaded.record, loaded.lines, 50, loaded.times);
  const stored = await db.readLines(loaded.record.id);
  assert.deepEqual(stored.lines, loaded.lines);
  assert.deepEqual(stored.times, loaded.times);
  assert.equal(rawLogText(loaded.record, stored.lines), log, 'it exports back exactly as it was loaded');
  const flight = await (await openLocalFlight(db, loaded.record.id)).load();
  assert.deepEqual(flight.samples.map(sampleKey), parseFile(CAPTURE, 'c.log').samples.map(sampleKey));
});

test('a log of a Dogtooth board on USB replays from its status blocks, with the arrival times for the CSV', () => {
  const lines = KOMODO.split('\r\n').filter((l, i, all) => i < all.length - 1 && !l.startsWith('SIM PKT'));
  const log = writeLog(lines, { every: 3 }).text(0, Infinity);
  const plain = parseFile(lines.join('\r\n'), 'board.log', { defaultRocketId: '1' });
  const logged = parseFile(log, 'flight.log', { defaultRocketId: '1' });
  assert.equal(plain.format, 'serial-log-blocks');
  assert.equal(logged.format, 'serial-log-blocks');
  assert.deepEqual(logged.samples.map(sampleKey), plain.samples.map(sampleKey));
  const blocks = linesToBlocks(log.split('\n').slice(0, -1));
  assert.equal(blocks.length, linesToBlocks(lines).length);
  assert.ok(blocks.length > 300);
  assert.ok(blocks.every((b) => Number.isFinite(b.t) && b.t > START), 'each block has the time its banner arrived');
});

test('a log where no packet came in is still a log, with nothing to replay', () => {
  const statusOnly = writeLog(CAPTURE_LINES.filter((l) => l.startsWith('# DEKEL_RX'))).text(0, Infinity);
  assert.equal(detectFlightFile(statusOnly), 'log');
  assert.equal(readFlightFile(statusOnly, 'x.log').error, 'no-data');
  const headerOnly = writeLog([]).text(0, Infinity);
  assert.equal(detectFlightFile(headerOnly), 'log');
});

// ------------------------------------------------------------------
// The test capture's plan
// ------------------------------------------------------------------

test('the capture is paced by its own clocks: each packet 0.1 s after a status line, one of each a second', () => {
  const times = captureTimes(CAPTURE_LINES);
  assert.equal(times.length, 253);
  assert.equal(times[0], 0);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] >= times[i - 1], `line ${i + 1} never goes before the one above`);
  // Status lines are a second apart, and each packet came 0.1 s after the
  // status line before it (the next one says last_good_s_ago=0.9).
  for (let i = 0; i < 253; i += 2) assert.ok(Math.abs(times[i] - i / 2) < 1e-6, `status line ${i + 1}`);
  for (let i = 1; i < 253; i += 2) assert.ok(Math.abs(times[i] - ((i - 1) / 2 + 0.1)) < 1e-6, `packet line ${i + 1}`);
  assert.ok(Math.abs(times.at(-1) - 126) < 1e-6);
  const fast = planCapture(CAPTURE, { speed: 20 });
  assert.ok(Math.abs(fast.durationS - 126 / 20) < 1e-6);
  assert.equal(planCapture(CAPTURE, { speed: 5 }).times[2], 0.2);
});

test('pacing copes with a restart, a long silence, a packet-only capture and a capture with no clock', () => {
  const restart = [
    '# DEKEL_RX listening good=1 bad=0 last_good_s_ago=0.5 rx_up_s=100.0',
    '# DEKEL_RX listening good=0 bad=0 rx_up_s=2.0',
    '# DEKEL_RX listening good=0 bad=0 rx_up_s=500.0',
  ];
  assert.deepEqual(captureTimes(restart), [0, 1, 1 + MAX_GAP_S]);
  const packets = CAPTURE_LINES.filter((l) => l.startsWith('PKT ')).slice(0, 5);
  assert.deepEqual(captureTimes(packets), [0, 1, 2, 3, 4]);
  assert.deepEqual(captureTimes(['hello', 'there', 'BAD reason=crc']), [0, 1, 2]);
  assert.deepEqual(captureTimes([]), []);
  assert.equal(cleanSpeed('20'), 20);
  assert.equal(cleanSpeed('fast'), 1);
  assert.equal(cleanSpeed(0), 1);
  assert.equal(cleanSpeed(1e6), 200);
});

test('a flight log plays as a capture too: its own lines, paced by the times they arrived', () => {
  const log = writeLog(CAPTURE_LINES.slice(0, 6), { reconnectAfter: 3, every: 700 }).text(0, Infinity);
  const read = readCapture(log);
  assert.deepEqual(read.lines, CAPTURE_LINES.slice(0, 6), 'the logger\'s own "#" lines are left out');
  const times = captureTimes(read.lines, read.arrived);
  // The reconnect took 20 s, and the line after it came 0.7 s later.
  assert.deepEqual(times.map((t) => Math.round(t * 1000) / 1000), [0, 0.7, 1.4, 22.1, 22.8, 23.5]);
  // A longer silence is cut to MAX_GAP_S.
  const far = readCapture(`${dataLine('a', START)}${dataLine('b', START + 3600e3)}`);
  assert.deepEqual(captureTimes(far.lines, far.arrived), [0, MAX_GAP_S]);
});

test('moving the capture puts its first fix on the field and keeps every movement after it exactly', () => {
  const plan = planCapture(CAPTURE, { name: 'test/radio-board-rx-capture.log', speed: 20, target: FIELD });
  assert.equal(plan.lines.length, 253);
  const first = firstFix(plan.lines);
  assert.equal(first.lat.toFixed(6), FIELD.lat.toFixed(6));
  assert.equal(first.lon.toFixed(6), FIELD.lon.toFixed(6));
  // A position in steps of the 7th decimal place, which the line prints.
  const units = (line, key) => Math.round(Number(new RegExp(`\\s${key}=(-?[\\d.]+)`).exec(line)[1]) * 1e7);
  const before = CAPTURE_LINES.filter((l) => l.startsWith('PKT '));
  const after = plan.lines.filter((l) => l.startsWith('PKT '));
  const dLat = units(after[0], 'lat') - units(before[0], 'lat');
  const dLon = units(after[0], 'lon') - units(before[0], 'lon');
  for (let i = 0; i < before.length; i++) {
    assert.equal(units(after[i], 'lat') - units(before[i], 'lat'), dLat, `packet ${i + 1}: one fixed offset`);
    assert.equal(units(after[i], 'lon') - units(before[i], 'lon'), dLon);
    assert.equal(after[i].replace(/\slat=\S+\slon=\S+/, ''), before[i].replace(/\slat=\S+\slon=\S+/, ''), 'nothing else changes');
    assert.match(after[i], /\slat=-?\d+\.\d{7}\slon=-?\d+\.\d{7}\s/);
  }
  assert.deepEqual(plan.lines.filter((l) => !l.startsWith('PKT ')), CAPTURE_LINES.filter((l) => !l.startsWith('PKT ')));
  assert.match(plan.notes[0], /^test capture, not live data: test\/radio-board-rx-capture\.log, played at 20 times real speed$/);
  assert.match(plan.notes[1], /^every lat= and lon= in its PKT lines was moved by \+\d+\.\d{7} and \+\d+\.\d{7} degrees, so its first fix lands on the launch field$/);
  assert.equal(planCapture(CAPTURE, { speed: 1 }).notes[1], 'its positions were not moved');
  assert.match(planCapture(CAPTURE).notes[0], /played at real speed$/);
  // No position at all is left alone.
  assert.deepEqual(shiftLines(['PKT node=1 fix=no lat=0.0000000 lon=0.0000000 alt_m=0'], { dLat: 1, dLon: 1 }), ['PKT node=1 fix=no lat=0.0000000 lon=0.0000000 alt_m=0']);
});

test('the moved capture goes through the live path and lands on the field', () => {
  const plan = planCapture(CAPTURE, { speed: 20, target: FIELD });
  const detector = createSourceDetector();
  const store = createStore({ fleet: createFleet(), ...LIVE_STORE_OPTIONS.flight });
  let realMs = START;
  const feed = createFlightFeed({ store, clock: () => realMs, every: null });
  plan.lines.forEach((line, i) => {
    realMs = START + plan.times[i] * 1000;
    const source = detector.push(line);
    feed.noteLine(line);
    feed.push(source.parse(line), realMs);
  });
  assert.equal(feed.counts.samples, 126);
  assert.equal(feed.counts.bad, 0);
  const rocket = store.getRocket('1');
  assert.equal(rocket.samples.length, 126);
  assert.equal(rocket.samples[0].gps.lat.toFixed(6), FIELD.lat.toFixed(6));
  assert.equal(rocket.samples[0].gps.lon.toFixed(6), FIELD.lon.toFixed(6));
});
