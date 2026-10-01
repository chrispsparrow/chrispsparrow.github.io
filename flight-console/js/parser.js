// parser.js
// The ONLY code that understands data file formats. Everything else works
// with normalized samples:
//   { rocketId, t, type, gps, baro, imu, radio, power, status, extra }
// Each sensor group is null unless the row had at least one value for it.
// Empty values become null (never 0). Fields that match no channel go into
// `extra` under their original name, so nothing is thrown away.
//
// Formats:
//   parseCsv(text, fileName)        a header row plus one row per reading
//   parseJsonLine(line)             one JSON object (live links will use this)
//   parseSerialLog(text, fileName)  text printed by my firmware over USB:
//     "SIM PKT ... hex=01 01 ..."  flight_sim and the PC sim dump program
//                                  (the 34-byte telemetry packet as hex)
//     "PKT node=1 seq=.. ..."      bench_rx receiver lines (key=value)
//   parseFile(text, fileName)       picks one of the above
//
// A "phase" field is simulated ground truth. It never goes on a sample. It is
// returned in a separate `truth` array that only the debug panel and
// tools/check_detection.mjs read.
//
// Used by: library.js (page and Node tools). Later, live sources will call
// parseJsonLine() and parseSerialLine() for each line they receive and pass
// the returned `sample` to the store. (Board restart shifting only happens
// in parseSerialLog(), which sees a whole file.) No DOM.

import { CHANNELS, GROUPS, lookupAlias, lookupAliasInGroup } from './schema.js';

// Firmware telemetry packet layout (DOGTOOTH_V1_FIRMWARE src/core/Telemetry.h).
const PACKET_SIZE = 34;
const PACKET_VERSION = 1;
const CHECKSUMMED_LENGTH = 32;
const FLAG_LOCATION_FRESH = 1 << 0;
const FLAG_ALTITUDE_FRESH = 1 << 1;
const FLAG_TIME_VALID = 1 << 2;
const FLAG_GPS_AIRBORNE = 1 << 3;
const HDOP_UNKNOWN = 0xffff;

// A byte order mark at the start of a file. Browsers drop it when they
// download text, Node keeps it, so it is removed here for both to match.
function stripBom(text) {
  return String(text ?? '').replace(/^﻿/, '');
}

// Text that means "no value".
const EMPTY_TEXT = new Set(['', 'null', 'nan', 'none', 'n/a', '?', '--']);

// ------------------------------------------------------------------
// Value helpers
// ------------------------------------------------------------------

function isEmpty(raw) {
  if (raw === null || raw === undefined) return true;
  if (typeof raw === 'number') return !Number.isFinite(raw);
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    return EMPTY_TEXT.has(s) || /^-+(:-+)*(\.-+)?$/.test(s); // "--:--:--.---"
  }
  return false;
}

function toNumber(raw, scale) {
  if (isEmpty(raw)) return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return undefined; // undefined = not a number
  if (scale === 1) return n;
  // Dividing by 100 gives exactly 99.99, multiplying by 0.01 gives
  // 99.99000000000001, so divide whenever the scale is 1/whole number.
  const inverse = Math.round(1 / scale);
  return Math.abs(1 / scale - inverse) < 1e-9 ? n / inverse : n * scale;
}

function toFlag(raw) {
  if (isEmpty(raw)) return null;
  if (raw === true) return 1;
  if (raw === false) return 0;
  const s = String(raw).trim().toLowerCase();
  if (s === '1' || s === 'yes' || s === 'true' || s === 'y') return 1;
  if (s === '0' || s === 'no' || s === 'false' || s === 'n') return 0;
  return undefined;
}

function toText(raw) {
  if (isEmpty(raw)) return null;
  return String(raw).trim();
}

// Keeps an unknown field's value, as a number when it looks like one.
function extraValue(raw) {
  if (isEmpty(raw)) return null;
  if (typeof raw !== 'string') return raw;
  const s = raw.trim();
  // Only plain decimal numbers are converted, so "0x07" stays as written.
  return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s) ? Number(s) : s;
}

function emptyGroup(group) {
  const out = {};
  for (const c of CHANNELS) if (c.group === group) out[c.key] = null;
  return out;
}

// ------------------------------------------------------------------
// Normalizing one record
// ------------------------------------------------------------------

// Turns a list of [fieldName, rawValue] pairs into a normalized sample.
// Returns { sample, truth } or { error } when the record can't be used.
function normalizeFields(pairs, options = {}) {
  const groups = {};
  const hasValue = {};
  for (const g of GROUPS) { groups[g] = emptyGroup(g); hasValue[g] = false; }
  const extra = {};
  let rocketId = null;
  let t = null;
  let type = null;
  let phase = null;

  for (const [name, raw, where] of pairs) {
    if (typeof name !== 'string' || name.trim() === '') continue;
    const lower = name.trim().toLowerCase();
    if (lower === 'phase') { phase = toText(raw); continue; }

    const hit = where?.group ? lookupAliasInGroup(where.group, lower) : lookupAlias(lower);
    if (!hit) {
      extra[where?.path ?? name.trim()] = extraValue(raw);
      continue;
    }
    const { channel, scale } = hit;
    let value;
    if (channel.kind === 'flag') value = toFlag(raw);
    else if (channel.kind === 'text') value = toText(raw);
    else value = toNumber(raw, scale);
    if (value === undefined) return { error: `"${name}" is not a valid value: ${raw}` };

    if (channel.group === null) {
      if (channel.key === 'rocketId') rocketId = value;
      else if (channel.key === 't') t = value;
      else if (channel.key === 'type') type = value ? value.toLowerCase() : null;
      continue;
    }
    // The first alias found wins, so a later duplicate column can't erase it.
    if (groups[channel.group][channel.key] === null && value !== null) {
      groups[channel.group][channel.key] = value;
      hasValue[channel.group] = true;
    }
  }

  if (type === null) type = 'tlm';
  // Ground station packets belong to no rocket, so they never get a default ID.
  if (type !== 'gs' && rocketId === null &&
      options.defaultRocketId !== undefined && options.defaultRocketId !== null) {
    rocketId = String(options.defaultRocketId);
  }
  if (type !== 'gs' && rocketId === null) return { error: 'no rocket ID in the row and none given for the file' };
  if (t === null && type !== 'gs') return { error: 'no time value' };

  const sample = { rocketId, t, type };
  for (const g of GROUPS) sample[g] = hasValue[g] ? groups[g] : null;
  sample.extra = Object.keys(extra).length ? extra : null;
  const truth = phase !== null && type !== 'gs' ? { rocketId, t, phase } : null;
  return { sample, truth };
}

// ------------------------------------------------------------------
// CSV
// ------------------------------------------------------------------

// Splits one CSV line, honoring double-quoted fields.
function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

// Reads a CSV file with a header row. Returns
// { samples, truth, badRows, badRowDetails, format, ignoredLines }.
export function parseCsv(text, fileName = '', options = {}) {
  const result = newResult('csv', fileName);
  const lines = stripBom(text).split(/\r?\n/);
  let header = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) { result.ignoredLines++; continue; }
    if (!header) { header = splitCsvLine(line).map((h) => h.trim()); continue; }
    const cells = splitCsvLine(line);
    if (cells.length !== header.length) { addBad(result, i + 1, `expected ${header.length} columns, found ${cells.length}`); continue; }
    const out = normalizeFields(header.map((h, k) => [h, cells[k]]), options);
    if (out.error) { addBad(result, i + 1, out.error); continue; }
    pushRecord(result, out);
  }
  if (!header) result.notes.push('The file has no header row.');
  return finish(result);
}

// ------------------------------------------------------------------
// JSON lines
// ------------------------------------------------------------------

// Reads one line of JSON. Returns { sample, truth } or null if the line is
// not a usable JSON object. A ground station position update looks like
//   {"type":"gs","lat":42.34,"lon":-71.09,"alt":12.0,"fix":1}
// and comes back as a sample with type "gs" and its position in `gps`.
export function parseJsonLine(line, options = {}) {
  if (typeof line !== 'string' || line.trim() === '') return null;
  let obj;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = normalizeFields(flattenObject(obj), options);
  return out.error ? null : out;
}

// Turns nested JSON into [name, value, where] pairs, so nested and flat JSON
// both work. Inside a sensor group's object, names are looked up only in
// that group: {"baro":{"alt_m":152}} is barometer altitude, not GPS.
// Unknown nested fields keep their full path, like "gps.status".
function flattenObject(obj, pairs = [], path = [], group = null) {
  for (const [key, value] of Object.entries(obj)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const lower = key.toLowerCase();
      flattenObject(value, pairs, [...path, key], GROUPS.includes(lower) ? lower : group);
    } else {
      pairs.push([key, value, { group, path: [...path, key].join('.') }]);
    }
  }
  return pairs;
}

function parseJsonLines(text, fileName, options) {
  const result = newResult('jsonl', fileName);
  const lines = stripBom(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') { result.ignoredLines++; continue; }
    const out = parseJsonLine(lines[i], options);
    if (!out) { addBad(result, i + 1, 'not a usable JSON object'); continue; }
    pushRecord(result, out);
  }
  return finish(result);
}

// ------------------------------------------------------------------
// Firmware serial logs
// ------------------------------------------------------------------

// The 8-bit Fletcher checksum, exactly as the firmware computes it
// (src/core/Checksum.cpp): a += byte, b += a, both mod 256.
export function fletcher8(bytes, length) {
  let a = 0;
  let b = 0;
  for (let i = 0; i < length; i++) {
    a = (a + bytes[i]) & 0xff;
    b = (b + a) & 0xff;
  }
  return { a, b };
}

// Decodes the 34-byte telemetry packet (little-endian). Returns
// { ok: true, packet } or { ok: false, reason } with the same reasons the
// firmware's Telemetry::decode() uses.
export function decodePacket(bytes) {
  if (!bytes || bytes.length !== PACKET_SIZE) return { ok: false, reason: 'wrong-length' };
  const sum = fletcher8(bytes, CHECKSUMMED_LENGTH);
  if (sum.a !== bytes[32] || sum.b !== bytes[33]) return { ok: false, reason: 'bad-checksum' };
  if (bytes[0] !== PACKET_VERSION) return { ok: false, reason: 'unsupported-version' };
  const view = new DataView(Uint8Array.from(bytes).buffer);
  return {
    ok: true,
    packet: {
      version: view.getUint8(0),
      nodeId: view.getUint8(1),
      sequence: view.getUint16(2, true),
      uptimeMs: view.getUint32(4, true),
      flags: view.getUint8(8),
      satellites: view.getUint8(9),
      hdopX100: view.getUint16(10, true),
      latitudeE7: view.getInt32(12, true),
      longitudeE7: view.getInt32(16, true),
      altitudeCm: view.getInt32(20, true),
      groundSpeedCmPerS: view.getUint16(24, true),
      courseCdeg: view.getUint16(26, true),
      utcTimeOfDayMs: view.getUint32(28, true),
    },
  };
}

// Milliseconds since midnight to "HH:MM:SS.mmm".
function formatUtc(ms) {
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:` +
    `${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

// A decoded packet as [name, value] pairs. The names are the aliases in
// schema.js, so the packet goes through the same normalizing as every other
// format. Values the packet marks as unknown stay null.
function packetFields(p) {
  const locationFresh = (p.flags & FLAG_LOCATION_FRESH) !== 0;
  const altitudeFresh = (p.flags & FLAG_ALTITUDE_FRESH) !== 0;
  const timeValid = (p.flags & FLAG_TIME_VALID) !== 0;
  return [
    ['node_id', String(p.nodeId)],
    ['uptime_ms', p.uptimeMs],
    ['fix', locationFresh ? 1 : 0],
    ['stale', altitudeFresh ? 0 : 1],
    ['sats', p.satellites],
    ['hdop_x100', p.hdopX100 === HDOP_UNKNOWN ? null : p.hdopX100],
    ['latitude_e7', p.latitudeE7],
    ['longitude_e7', p.longitudeE7],
    ['altitude_cm', p.altitudeCm],
    ['ground_speed_cm_per_s', p.groundSpeedCmPerS],
    ['course_cdeg', p.courseCdeg],
    // Not channels, so they land in `extra`.
    ['version', p.version],
    ['seq', p.sequence],
    ['flags', `0x${p.flags.toString(16).padStart(2, '0').toUpperCase()}`],
    ['utc', timeValid ? formatUtc(p.utcTimeOfDayMs) : null],
    ['airborne_model', (p.flags & FLAG_GPS_AIRBORNE) !== 0 ? 'yes' : 'no'],
  ];
}

// "a=1 b=two c" -> [["a","1"],["b","two"],["c",true]]
function keyValuePairs(text) {
  const pairs = [];
  for (const token of text.trim().split(/\s+/)) {
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq === -1) pairs.push([token, true]);
    else pairs.push([token.slice(0, eq), token.slice(eq + 1)]);
  }
  return pairs;
}

// PlatformIO's "time" monitor filter puts "HH:MM:SS.mmm > " in front of
// every line. The laptop clock is not flight data, so it is dropped.
const MONITOR_TIME_PREFIX = /^\d{2}:\d{2}:\d{2}\.\d{3}\s*>\s?/;

// Reads text my firmware printed over USB. Returns
// { samples, truth, badRows, badRowDetails, format, ignoredLines, meta }.
export function parseSerialLog(text, fileName = '', options = {}) {
  const result = newResult('serial-log', fileName);
  result.meta = { launchSite: null, damagedPackets: 0 };
  const lines = stripBom(text).split(/\r?\n/);
  const records = []; // { out, line } in the order the lines arrived
  for (let i = 0; i < lines.length; i++) {
    const out = parseSerialLine(lines[i], options);
    if (out.kind === 'ignored') { result.ignoredLines++; continue; }
    if (out.kind === 'launchSite') { result.meta.launchSite = out.launchSite; result.ignoredLines++; continue; }
    if (out.kind === 'bad') {
      addBad(result, i + 1, out.reason);
      if (out.damaged) result.meta.damagedPackets++;
      continue;
    }
    records.push({ out, line: i + 1 });
  }
  followBoardClocks(result, records, fileName);
  for (const { out } of records) pushRecord(result, out);
  return finish(result);
}

// Times in these logs come from the board's own clock (ms since power-up).
// If a board restarts mid-log (bench_rx prints REBOOTED, often a brownout),
// its clock starts again near 0. Lines stay in the order they arrived, and
// later times are shifted to follow on, so the replay doesn't jump back.
// After a restart the clock counts from the restart, which came after the
// last reading, so "last reading's time + new clock" is the best guess and
// keeps the real spacing between later readings. The shift is kept in
// extra.time_shift_s, and one note per board says what happened.
//
// A restarted board never gets back to its old clock. So each reading is
// matched to the clock it continues (the one whose last time is closest
// below it). If a reading continues an older clock than the one in use,
// two clocks are running side by side: two boards are sending the same ID
// (every board sends node 1 until it is given its own number). Then nothing
// is shifted and the note says so.
function followBoardClocks(result, records, fileName) {
  const byRocket = new Map(); // rocketId -> records of that rocket
  for (const r of records) {
    const s = r.out.sample;
    if (s.type === 'gs' || !Number.isFinite(s.t)) continue;
    if (!byRocket.has(s.rocketId)) byRocket.set(s.rocketId, []);
    byRocket.get(s.rocketId).push(r);
  }
  const where = fileName ? ` in ${fileName}` : '';
  for (const [rocketId, list] of byRocket) {
    // A plausible step between two readings of one clock: several times the
    // usual spacing, and at least 2 s.
    const gaps = [];
    for (let i = 1; i < list.length; i++) {
      const d = list[i].out.sample.t - list[i - 1].out.sample.t;
      if (d > 0 && d < 60) gaps.push(d);
    }
    gaps.sort((a, b) => a - b);
    const step = Math.max(2, 5 * (gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1));
    const fits = (last, raw) => raw >= last - 0.5 && raw - last <= step;

    const restarts = [];
    const clocks = []; // last raw time of each clock seen
    let current = -1;
    let shared = false;
    for (const { out, line } of list) {
      const raw = out.sample.t;
      if (current !== -1 && fits(clocks[current], raw)) {
        clocks[current] = Math.max(clocks[current], raw);
        continue;
      }
      // The clock in use can't take this reading. Does an older one?
      let other = -1;
      for (let c = 0; c < clocks.length; c++) {
        if (c !== current && fits(clocks[c], raw) && (other === -1 || raw - clocks[c] < raw - clocks[other])) other = c;
      }
      if (other !== -1) {
        shared = true;
        clocks[other] = Math.max(clocks[other], raw);
        current = other;
        continue;
      }
      // A new clock: a restart if it went back in time, a long gap if forward.
      if (current !== -1 && raw < clocks[current] - 0.5) restarts.push(line);
      clocks.push(raw);
      current = clocks.length - 1;
    }
    if (shared) {
      result.notes.push(`The board ID ${rocketId}${where} has two clocks running side by side, which means two boards are sending the same ID. Its times were left as they are.`);
      continue;
    }
    if (!restarts.length) continue;
    let lastRaw = null;
    let lastT = null;
    let shift = 0;
    for (const { out } of list) {
      const s = out.sample;
      const raw = s.t;
      if (lastRaw !== null && raw < lastRaw - 0.5) shift = lastT;
      lastRaw = raw;
      if (shift) {
        s.t = raw + shift;
        s.extra = { ...(s.extra ?? {}), time_shift_s: Math.round(shift * 1000) / 1000 };
        if (out.truth) out.truth.t = s.t;
      }
      lastT = s.t;
    }
    result.notes.push(restarts.length === 1
      ? `The board with ID ${rocketId}${where} restarted at line ${restarts[0]}. Its clock started over, so the times after that are shifted to follow on.`
      : `The board with ID ${rocketId}${where} restarted ${restarts.length} times, first at line ${restarts[0]}. Its clock started over each time, so the times after that are shifted to follow on.`);
  }
}

// Reads ONE line of firmware output. Returns one of
//   { kind: 'sample', sample, truth }
//   { kind: 'bad', reason, damaged }   a data line that can't be used
//   { kind: 'launchSite', launchSite } the sim banner's (placeholder) site
//   { kind: 'ignored' }                banners, status lines, comments
// A live serial link will call this for each line it receives.
export function parseSerialLine(rawLine, options = {}) {
  const line = String(rawLine ?? '').replace(MONITOR_TIME_PREFIX, '').trim();
  if (line === '') return { kind: 'ignored' };

  if (line.startsWith('SIM PKT')) return parseSimPacketLine(line, options);
  if (line.startsWith('PKT ')) return parseBenchLine(line, options);
  if (line.startsWith('BAD ')) {
    // bench_rx caught a damaged or foreign packet. Counted, never used.
    const reason = keyValuePairs(line.slice(4)).find(([k]) => k === 'reason');
    return { kind: 'bad', reason: `receiver reported a bad packet (${reason ? reason[1] : 'unknown'})`, damaged: true };
  }
  const site = /^SIM launch site:\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\s*m MSL/.exec(line);
  if (site) {
    return { kind: 'launchSite', launchSite: { lat: Number(site[1]), lon: Number(site[2]), altMsl: Number(site[3]) } };
  }
  return { kind: 'ignored' };
}

function parseSimPacketLine(line, options) {
  const hexAt = line.indexOf('hex=');
  if (hexAt === -1) return { kind: 'bad', reason: 'SIM PKT line has no hex bytes' };
  const pairs = keyValuePairs(line.slice('SIM PKT'.length, hexAt));
  const hexText = line.slice(hexAt + 4).trim();
  const tokens = hexText.split(/\s+/);
  if (!tokens.every((b) => /^[0-9A-Fa-f]{2}$/.test(b))) return { kind: 'bad', reason: 'hex bytes are not valid' };
  const bytes = tokens.map((b) => parseInt(b, 16));
  const lenPair = pairs.find(([k]) => k === 'len');
  if (lenPair && Number(lenPair[1]) !== bytes.length) {
    return { kind: 'bad', reason: `len=${lenPair[1]} but ${bytes.length} bytes were printed` };
  }
  const decoded = decodePacket(bytes);
  if (!decoded.ok) return { kind: 'bad', reason: `packet rejected (${decoded.reason})` };

  // The line's own fields: sim_s and phase come from the simulator, seq and
  // len repeat what is inside the packet. "phase" becomes ground truth.
  const lineFields = pairs.filter(([k]) => k !== 'seq' && k !== 'len');
  const out = normalizeFields([...packetFields(decoded.packet), ...lineFields], options);
  if (out.error) return { kind: 'bad', reason: out.error };
  return { kind: 'sample', ...out };
}

// Every field bench_rx prints on a PKT line (src/main_bench_rx.cpp,
// printPacket). Its text lines have no checksum of their own, so a line cut
// short (capture stopped mid-print, USB dropped) could carry a half-written
// number, like alt_m=70 for 700.00. A line missing any of these is bad.
const BENCH_FIELDS = ['node', 'seq', 'up_s', 'fix', 'sats', 'hdop', 'lat', 'lon', 'alt_m', 'spd_mps',
  'crs_deg', 'utc', 'airborne', 'rssi_dbm', 'snr_db', 'missed'];

function parseBenchLine(line, options) {
  const raw = keyValuePairs(line.slice(4));
  const have = new Map(raw.map(([k, v]) => [k, v]));
  const missing = BENCH_FIELDS.filter((k) => typeof have.get(k) !== 'string' || have.get(k) === '');
  if (missing.length) return { kind: 'bad', reason: `PKT line is cut short or incomplete (missing ${missing.join(', ')})` };
  // Two packets run together (the end of one line and its line break were
  // lost) repeat keys, or show "PKT" again. bench_rx prints each key once.
  const known = new Set([...BENCH_FIELDS, 'REBOOTED']);
  if (have.size !== raw.length || /.PKT\b/.test(line) || raw.some(([k]) => !known.has(k))) {
    return { kind: 'bad', reason: 'PKT line holds parts of more than one packet' };
  }
  const pairs = raw.map(([k, v]) => {
    // Rename bench_rx names that would otherwise be ambiguous.
    if (k === 'node') return ['node_id', v];
    if (k === 'REBOOTED') return ['rebooted', 'yes'];
    if (k === 'airborne') return ['airborne_model', v];
    return [k, v];
  });
  const out = normalizeFields(pairs, options);
  if (out.error) return { kind: 'bad', reason: out.error };
  return { kind: 'sample', ...out };
}

// ------------------------------------------------------------------
// Picking a format
// ------------------------------------------------------------------

// Chooses a parser from the file extension, or from the text itself when
// the extension says nothing. options.defaultRocketId fills in files that
// carry no rocket ID.
export function parseFile(text, fileName = '', options = {}) {
  const name = String(fileName).toLowerCase();
  if (name.endsWith('.csv')) return parseCsv(text, fileName, options);
  if (name.endsWith('.jsonl') || name.endsWith('.ndjson')) return parseJsonLines(text, fileName, options);
  // Look at the lines with PlatformIO's time prefix removed. Any firmware
  // data line (or the firmware's banner) means a serial log. A "#" line on
  // its own decides nothing, since CSV files can have comments too.
  const lines = stripBom(text).split(/\r?\n/).map((l) => l.replace(MONITOR_TIME_PREFIX, '').trim());
  if (lines.some((l) => /^(SIM PKT|PKT |BAD |DOGTOOTH_V1_FIRMWARE)/.test(l))) {
    return parseSerialLog(text, fileName, options);
  }
  const firstLine = lines.find((l) => l !== '' && !l.startsWith('#')) ?? '';
  if (firstLine.startsWith('{')) return parseJsonLines(text, fileName, options);
  return parseCsv(text, fileName, options);
}

// ------------------------------------------------------------------
// Result helpers
// ------------------------------------------------------------------

function newResult(format, fileName) {
  return { format, fileName, samples: [], truth: [], badRows: 0, badRowDetails: [], ignoredLines: 0, notes: [] };
}

function addBad(result, lineNumber, reason) {
  result.badRows++;
  // Keep the first few reasons for the debug panel and the tools.
  if (result.badRowDetails.length < 20) result.badRowDetails.push({ line: lineNumber, reason });
}

function pushRecord(result, out) {
  result.samples.push(out.sample);
  if (out.truth) result.truth.push(out.truth);
}

// Sorts by time. A stable sort keeps same-time rows in file order.
function finish(result) {
  // A ground station line with no time of its own (live links may send
  // them that way) takes the time of the reading before it in the file, or
  // the first reading after it, so a replay still puts it in order.
  let lastT = null;
  let waiting = [];
  let filled = 0;
  for (const s of result.samples) {
    if (Number.isFinite(s.t)) {
      lastT = s.t;
      for (const w of waiting) w.t = s.t;
      filled += waiting.length;
      waiting = [];
    } else if (s.type === 'gs') {
      if (lastT !== null) { s.t = lastT; filled++; } else waiting.push(s);
    }
  }
  if (filled) result.notes.push(`${filled} ground station line${filled === 1 ? ' has' : 's have'} no time, so ${filled === 1 ? 'it uses' : 'they use'} the time of the reading next to ${filled === 1 ? 'it' : 'them'}.`);
  result.samples.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  result.truth.sort((a, b) => a.t - b.t);
  return result;
}
