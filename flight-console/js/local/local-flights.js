// local-flights.js: LOCAL flights, the ones this browser keeps (see
// flight-db.js). A recording of a board on the USB cable, or a file loaded
// from the computer. Both replay through the same code as the library's
// flights (buildFlight() in library.js), so they look and play the same.
//
// Here:
//   createRecorder()      records a connection's lines, a chunk every 2 s
//   saveRecording()       names a finished (or recovered) recording
//   findUnfinished()      recordings a crash or a closed tab left behind
//   readFlightFile()      checks a loaded file and turns it into a flight
//   openLocalFlight()     a LOCAL flight's entry and its loader, for main.js
//   rawLogText(), csvText(), exportFileName()  the two exports
//
// No DOM here, so Node can test it.

import { buildFlight, LibraryError } from '../library.js?v=5';
import { parseFile } from '../parser.js?v=3';
import { BlockParser } from '../bench/parse.js?v=5';
import { buildCsv, blockUnits, readCsvBlocks } from '../bench/csv.js?v=6';
import { DEFAULT_ROCKET } from '../live/bench-feed.js?v=3';
import { KNOWN_ROCKETS } from '../fleet.js?v=3';

export const LOCAL_PREFIX = 'local-';
export const isLocalId = (id) => typeof id === 'string' && id.startsWith(LOCAL_PREFIX);

// How often a running recording is written to the browser's storage, in ms.
export const FLUSH_MS = 2000;
// Without Web Locks, a recording whose record hasn't been touched for this
// long (ms) is taken as left behind rather than still running in another tab.
export const STALE_MS = 15000;
// The longest name a flight can have.
export const MAX_NAME = 80;
// The biggest file the console will load, in bytes.
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

// The file name each kind of LOCAL flight is parsed under (parseFile()
// picks its reader partly by name).
const PARSE_NAME = { log: 'local.log', csv: 'local.csv' };

// The first line of the console's own CSV file (bench/csv.js).
const CONSOLE_CSV_START = 'PC time (UTC),HEARTBEAT #,TIME RUNNING (s),';
// A line only my firmware prints (the same test parseFile() uses).
const SERIAL_LINE = /^(SIM PKT|PKT |BAD |DOGTOOTH_V1_FIRMWARE|=+ *HEARTBEAT #)/;
const MONITOR_TIME_PREFIX = /^\d{2}:\d{2}:\d{2}\.\d{3}\s*>\s?/;

const stripBom = (text) => String(text ?? '').replace(/^﻿/, '');
const pad = (n) => String(n).padStart(2, '0');

// A new LOCAL flight id, like "local-mhxw2k3c-4fz1".
export function newLocalId(now = Date.now()) {
  return `${LOCAL_PREFIX}${Math.floor(now).toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
}

// The name a flight gets when it isn't given one: its date and time, like
// "Nov 17, 2026, 2:32 PM", on this computer's clock.
export function defaultName(ms) {
  return new Date(ms).toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// "2026-11-17", on this computer's clock.
export function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// A name as typed: spaces tidied, cut to MAX_NAME. Empty gives the default.
export function cleanName(text, createdAt) {
  const name = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME).trim();
  return name || defaultName(createdAt);
}

// A recording's lock name. The tab that is recording holds it, so another
// tab knows the recording isn't left behind.
const lockName = (id) => `fc-recording-${id}`;

// Splits text into lines and remembers its line ending, so the lines can be
// put back together exactly as they were.
export function splitText(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const trailingEol = lines.length > 1 && lines[lines.length - 1] === '';
  if (trailingEol) lines.pop();
  return { lines, eol, trailingEol };
}

// The lines' status blocks (bench/parse.js), with the time each banner
// arrived when the lines have times.
export function linesToBlocks(lines, times = null) {
  const parser = new BlockParser();
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const r = parser.push(lines[i], times ? times[i] : null);
    if (r.done) blocks.push(r.done);
  }
  const last = parser.finish();
  if (last) blocks.push(last);
  return blocks;
}

// What the menu and the exports need to know about a flight's lines:
//   durationS    how long its data runs, from its first reading to its last
//                (or how long the recording ran, when nothing in it reads as
//                a reading), or null
//   sampleCount  readings the replay will have
//   blockCount   status blocks, which the CSV export is made from
export function summarize(record, { lines, times }) {
  const parsed = parseFile(lines.join('\n'), PARSE_NAME[record.kind] ?? PARSE_NAME.log);
  let first = Infinity;
  let last = -Infinity;
  let sampleCount = 0;
  for (const s of parsed.samples) {
    if (s.type === 'gs' || !Number.isFinite(s.t)) continue;
    sampleCount++;
    if (s.t < first) first = s.t;
    if (s.t > last) last = s.t;
  }
  let durationS = sampleCount ? last - first : null;
  if (!durationS && times?.length) {
    const known = times.filter(Number.isFinite);
    if (known.length > 1) durationS = (known[known.length - 1] - known[0]) / 1000;
  }
  const blockCount = record.kind === 'csv'
    ? (readCsvBlocks(lines.join('\n'))?.blocks.length ?? 0)
    : linesToBlocks(lines).length;
  return { durationS: Number.isFinite(durationS) ? Math.round(durationS * 10) / 10 : null, sampleCount, blockCount };
}

// ------------------------------------------------------------------
// Recording
// ------------------------------------------------------------------

// Records the lines of one connection at a time. The page calls start()
// when the port opens, line() for every line, and stop() when the port
// closes or STOP is pressed. Every FLUSH_MS the new lines go to storage as
// one chunk, with the record, so a crash loses at most that much.
//
// After stop() the recording is still marked 'recording' in storage, and
// this tab still holds its lock, until saveRecording() or discard() (see
// local-console.js). So a tab that closes while the name is being typed
// leaves it to be recovered on the next visit.
//
//   onState(rec)      the recording started, stopped or was released
//   onProblem(err)    storing failed (err), or works again (null)
export function createRecorder({
  db,
  now = () => Date.now(),
  flushMs = FLUSH_MS,
  locks = globalThis.navigator?.locks ?? null,
  onState = () => {},
  onProblem = () => {},
} = {}) {
  let rec = null;            // the record of the running recording
  let stopped = null;        // the record after stop(), until released
  let buffer = { lines: [], times: [] };
  const queue = [];          // chunks not stored yet, in order
  let seq = 0;
  let timer = null;
  let writing = Promise.resolve();
  let failing = false;
  let unlock = null;         // releases this recording's lock
  let startedAt = 0;

  function start() {
    if (rec) return rec;
    const t = now();
    startedAt = t;
    seq = 0;
    buffer = { lines: [], times: [] };
    rec = {
      id: newLocalId(t),
      status: 'recording',
      title: '',
      createdAt: t,
      updatedAt: t,
      source: 'recording',
      originalName: '',
      kind: 'log',
      eol: '\r\n',
      trailingEol: true,
      lineCount: 0,
      byteCount: 0,
      durationS: null,
      sampleCount: null,
      blockCount: null,
    };
    // The lock comes first, so another tab never sees this recording
    // without it and offers to recover it.
    const locked = takeLock(rec.id);
    const first = { ...rec };
    writing = writing.then(() => locked).then(() => db.putFlight(first)).then(() => setFailing(null), setFailing);
    timer = setInterval(flush, flushMs);
    onState(rec);
    return rec;
  }

  function takeLock(id) {
    if (!locks?.request) return Promise.resolve();
    return new Promise((resolve) => {
      locks.request(lockName(id), { mode: 'exclusive' }, () => {
        resolve();
        return new Promise((release) => { unlock = release; });
      }).catch(() => resolve());
    });
  }

  function line(text, t) {
    if (!rec) return;
    buffer.lines.push(text);
    buffer.times.push(Number.isFinite(t) ? t : now());
  }

  // Writes what came in since the last write. Returns a promise that is
  // done when it's stored (or has failed and will be tried again).
  function flush() {
    if (!rec) return writing;
    if (buffer.lines.length) {
      queue.push({ seq: seq++, lines: buffer.lines, times: buffer.times });
      rec.lineCount += buffer.lines.length;
      for (const l of buffer.lines) rec.byteCount += l.length + 2;
      buffer = { lines: [], times: [] };
    }
    rec.updatedAt = now();
    const snapshot = { ...rec };
    writing = writing.then(() => writeQueue(snapshot));
    return writing;
  }

  async function writeQueue(snapshot) {
    try {
      if (!queue.length) await db.putFlight(snapshot);
      while (queue.length) {
        const c = queue[0];
        await db.addChunk(snapshot.id, c.seq, c.lines, c.times, snapshot);
        queue.shift();
      }
      setFailing(null);
    } catch (err) {
      setFailing(err);
    }
  }

  function setFailing(err) {
    const now_ = Boolean(err);
    if (now_ === failing) return;
    failing = now_;
    onProblem(err ?? null);
  }

  // Ends the recording. Resolves with its record once every line is stored
  // (or with the record anyway if storing failed, see stored()).
  async function stop() {
    if (!rec) return stopped;
    clearInterval(timer);
    timer = null;
    flush();
    const done = rec;
    rec = null;
    stopped = done;
    await writing;
    // One more try for anything a failed write left behind.
    if (queue.length) {
      await writeQueue({ ...done, updatedAt: now() });
    }
    onState(null);
    return done;
  }

  // Lets go of the stopped recording's lock (after it's saved or discarded).
  function release() {
    stopped = null;
    unlock?.();
    unlock = null;
    onState(null);
  }

  return {
    start,
    line,
    flush,
    stop,
    release,
    // True while a recording runs.
    get active() { return Boolean(rec); },
    // The running recording's record, or the stopped one until released.
    get record() { return rec ?? stopped; },
    // How long the running recording has been going, in ms.
    elapsed: () => (rec ? now() - startedAt : 0),
    // True when every line so far is in storage.
    stored: () => !queue.length && !failing,
    get failing() { return failing; },
  };
}

// Names a finished or recovered recording and marks it saved. Its lines are
// read back from storage to work out its summary.
export async function saveRecording(db, record, name) {
  const data = await db.readLines(record.id);
  const saved = {
    ...record,
    status: 'saved',
    title: cleanName(name, record.createdAt),
    updatedAt: Date.now(),
    lineCount: data.lines.length,
    ...summarize(record, data),
  };
  await db.putFlight(saved);
  return saved;
}

// Recordings left behind: still marked 'recording', and not running in any
// tab (nobody holds the lock, or without Web Locks, not touched for
// STALE_MS). Newest first. `except` skips this tab's own recording.
export async function findUnfinished(db, { locks = globalThis.navigator?.locks ?? null, now = Date.now(), except = null } = {}) {
  const all = (await db.listFlights()).filter((r) => r.status === 'recording' && r.id !== except);
  if (!all.length) return [];
  let held = null;
  if (locks?.query) {
    try {
      const q = await locks.query();
      held = new Set((q.held ?? []).map((l) => l.name));
    } catch {
      held = null;
    }
  }
  return all
    .filter((r) => (held ? !held.has(lockName(r.id)) : now - (r.updatedAt ?? 0) > STALE_MS))
    .sort((a, b) => b.createdAt - a.createdAt);
}

// Every saved LOCAL flight, newest first.
export async function listSaved(db) {
  return (await db.listFlights()).filter((r) => r.status === 'saved').sort((a, b) => b.createdAt - a.createdAt);
}

// ------------------------------------------------------------------
// Loading a file
// ------------------------------------------------------------------

// What a file holds, from its contents (never only its name):
//   'csv'  the console's own CSV file (SAVE AS CSV or EXPORT CSV)
//   'log'  my firmware's serial output (a raw log, pc_sim_flight.log)
//   null   neither
export function detectFlightFile(text) {
  const body = stripBom(text);
  if (body.startsWith(CONSOLE_CSV_START)) return readCsvBlocks(body) ? 'csv' : null;
  for (const raw of body.split(/\r?\n/)) {
    if (SERIAL_LINE.test(raw.replace(MONITOR_TIME_PREFIX, '').trim())) return 'log';
  }
  return null;
}

// A flight's name from its file's name: "komodo test 2.log" -> "komodo test 2".
export function nameFromFile(fileName) {
  return String(fileName ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

// Checks a loaded file's text and makes its LOCAL flight. Returns
// { record, lines } (the record is ready to store, already 'saved'), or
// { error } with error one of:
//   'empty'    nothing in it
//   'unknown'  not a raw log or the console's CSV file
//   'no-data'  the right kind of file, but no readings in it
export function readFlightFile(text, originalName = '', now = Date.now()) {
  const body = String(text ?? '');
  if (!body.trim()) return { error: 'empty' };
  const kind = detectFlightFile(body);
  if (!kind) return { error: 'unknown' };
  const { lines, eol, trailingEol } = splitText(body);
  const record = {
    id: newLocalId(now),
    status: 'saved',
    title: nameFromFile(originalName) || defaultName(now),
    createdAt: now,
    updatedAt: now,
    source: 'file',
    originalName: String(originalName ?? ''),
    kind,
    eol,
    trailingEol,
    lineCount: lines.length,
    byteCount: body.length,
  };
  const summary = summarize(record, { lines, times: null });
  if (!summary.sampleCount) return { error: 'no-data', kind };
  return { record: { ...record, ...summary }, lines };
}

// Stores a loaded file's lines and record. Big files go in as several chunks.
export async function storeFile(db, record, lines, chunkLines = 20000) {
  for (let seq = 0, i = 0; i < lines.length || seq === 0; seq++, i += chunkLines) {
    await db.addChunk(record.id, seq, lines.slice(i, i + chunkLines), null);
  }
  await db.putFlight(record);
  return record;
}

// ------------------------------------------------------------------
// Replaying
// ------------------------------------------------------------------

// A LOCAL flight as a library entry (the shape validateEntry() in
// library.js gives), so main.js opens it like any other. It has no ground
// station, like the live console (a board on the bench has none, and a
// real ground station sends its own position), so the demo position in
// config.js is never used for it.
export function localEntry(record) {
  const board = KNOWN_ROCKETS.find((r) => r.id === DEFAULT_ROCKET.id) ?? KNOWN_ROCKETS[0];
  return {
    id: record.id,
    title: record.title || defaultName(record.createdAt),
    date: localDate(record.createdAt),
    kind: 'real',
    featured: false,
    description: '',
    site: null,
    cover: null,
    groundStation: null,
    local: true,
    source: record.source,
    rockets: [{ rocketId: DEFAULT_ROCKET.id, name: board.name, board: board.board ?? null, file: PARSE_NAME[record.kind] ?? PARSE_NAME.log, timeOffsetS: 0 }],
    summary: {
      rocketCount: 1,
      maxAglM: null,
      flightDurationS: record.durationS ?? null,
      sensors: null,
      events: null,
      trackRocketId: null,
      track: null,
      trackGaps: [],
      padPoint: null,
      landingPoint: null,
      altProfile: null,
      driftM: null,
      maxGsDistanceM: null,
      gsDemo: false,
    },
  };
}

// A saved LOCAL flight for main.js: { entry, load() }, where load() reads
// its lines and gives back what loadFlight() in library.js gives. null when
// there's no saved flight with that id.
export async function openLocalFlight(db, id) {
  const record = await db.getFlight(id);
  if (!record || record.status !== 'saved') return null;
  const entry = localEntry(record);
  return {
    entry,
    record,
    // A failure is a LibraryError of kind 'local', which main.js explains.
    async load() {
      let lines;
      try {
        ({ lines } = await db.readLines(id));
      } catch (err) {
        throw new LibraryError('local', `Couldn't read the flight from this browser's storage: ${err?.message ?? err}`);
      }
      try {
        return buildFlight(entry, new Map([[entry.rockets[0].file, lines.join('\n')]]));
      } catch (err) {
        throw new LibraryError('local', `Couldn't read the flight's data: ${err?.message ?? err}`);
      }
    },
  };
}

// ------------------------------------------------------------------
// Exports
// ------------------------------------------------------------------

// The lines put back together with the line ending they came with. For a
// recording that's the board's serial output, CRLF after every line, the
// same as data/flights/komodo-sim-01/pc_sim_flight.log. For a loaded file
// it's the file as it was.
export function rawLogText(record, lines) {
  const eol = record.eol ?? '\r\n';
  if (!lines.length) return '';
  return lines.join(eol) + (record.trailingEol === false ? '' : eol);
}

// The CSV file, the same one SAVE AS CSV in the second panel writes
// (bench/csv.js). For a loaded CSV file it's the file as it was. null when
// the flight has no status blocks to make one from.
export function csvText(record, { lines, times }) {
  if (record.kind === 'csv') return rawLogText(record, lines);
  const blocks = linesToBlocks(lines, times);
  return blocks.length ? buildCsv(blocks, blockUnits(blocks)) : null;
}

// The two exports can be made for this flight:
//   rawLog  there's a raw log (not for a loaded CSV file, which never had one)
//   csv     there are status blocks to make the CSV from
export function exportsFor(record) {
  return { rawLog: record.kind !== 'csv', csv: record.kind === 'csv' || (record.blockCount ?? 0) > 0 };
}

// "dogtooth-flight-2026-11-17-1432.log", or the flight's own name when it
// was given one: "dogtooth-komodo-test-2.csv".
export function exportFileName(record, ext) {
  const d = new Date(record.createdAt);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
  const named = record.title && record.title !== defaultName(record.createdAt);
  const slug = named ? record.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '') : '';
  return `dogtooth-${slug || `flight-${stamp}`}.${ext}`;
}
