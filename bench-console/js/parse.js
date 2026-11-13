// parse.js: reads the board's USB status block. No DOM here, so Node can
// run it too (see "Checking the parser" in the README).
//
// The board prints one block per second:
//
//   ==================== HEARTBEAT #65 | TIME RUNNING: 1 min 5.3 s ====================
//
//   GPS
//     TARGET LOCK [GPS]: ------------------ LOCKED
//     CONNECTED SATELLITES: --------------- 11
//     ...
//
//   RADIO
//     RADIO PACKETS SENT: ----------------- 65
//     ...
//
// The banner (the line starting with "====") begins a block. A line with no
// colon is a section header. Every other line is "LABEL: ----- value", and
// the dashes only line the values up. Lines are matched by their label,
// never by their position. A label the page doesn't know is skipped.
//
// A block is finished at the next banner, or at the blank line that ends
// the last section (RADIO). A line starting with "Error:" can come at any
// time. It goes to the errors box, and it's kept with the newest block
// (from its banner until the next one) for the CSV.

// ------------------------------------------------------------------
// Every name the page matches against the board's text, copied exactly
// from the board's output, capitals and brackets included. If the firmware
// renames something, change it here and nowhere else.
// ------------------------------------------------------------------

export const BANNER = {
  start: '====',               // a banner line starts with this
  heartbeat: 'HEARTBEAT',      // "HEARTBEAT #65"
  time: 'TIME RUNNING',        // "TIME RUNNING: 1 min 5.3 s"
  units: { h: 3600, min: 60, s: 1 },   // the time's units, in seconds
};

export const ERROR_LABEL = 'Error';   // "Error: radio not ready, code 3"

const ON_OFF = { ON: 'on', OFF: 'off' };

// `section` is the header the field sits under, and the readings panel
// groups by it. `kind` says how to read the value:
//   status   one word from `words` (LOCKED), shown in that word's color
//   number   a number with an optional unit (17.3 m)
//   quality  a percent, then the HDOP in brackets (100 % (HDOP 0.99))
//   rate     a word from `words`, then a number and unit (GOOD 723 char/s)
//   onoff    ON or OFF. The panel shows the fields in the section that are ON.
// `unit` is the unit to show when the board doesn't print one.
// Word colors: good is teal, warn is gold, bad is coral.
export const FIELDS = [
  { key: 'lock', section: 'GPS', label: 'TARGET LOCK [GPS]', kind: 'status',
    words: { LOCKED: 'good', SEARCHING: 'bad' } },
  { key: 'sats', section: 'GPS', label: 'CONNECTED SATELLITES', kind: 'number' },
  { key: 'quality', section: 'GPS', label: 'LOCK QUALITY', kind: 'quality', unit: '%', hdop: 'HDOP' },
  { key: 'lat', section: 'GPS', label: 'LATITUDE', kind: 'number', unit: '°' },
  { key: 'lon', section: 'GPS', label: 'LONGITUDE', kind: 'number', unit: '°' },
  { key: 'alt', section: 'GPS', label: 'ALTITUDE', kind: 'number', unit: 'm' },
  { key: 'gpsRate', section: 'GPS', label: 'GPS DATA RATE', kind: 'rate', unit: 'char/s',
    words: { GOOD: 'good', LOW: 'warn', SILENT: 'bad' } },
  { key: 'gpsCorrupt', section: 'GPS', label: 'CORRUPTED DATA OCCURRENCES (GPS)', kind: 'number' },
  { key: 'modePortable', section: 'GPS MOTION MODEL', label: 'PORTABLE', kind: 'onoff', words: ON_OFF },
  { key: 'modeAutomotive', section: 'GPS MOTION MODEL', label: 'AUTOMOTIVE', kind: 'onoff', words: ON_OFF },
  { key: 'modeAirborne', section: 'GPS MOTION MODEL', label: 'AIRBORNE 4G', kind: 'onoff', words: ON_OFF },
  { key: 'modeOther', section: 'GPS MOTION MODEL', label: 'OTHER', kind: 'onoff', words: ON_OFF },
  { key: 'radioSent', section: 'RADIO', label: 'RADIO PACKETS SENT', kind: 'number' },
  { key: 'radioSkipped', section: 'RADIO', label: 'RADIO PACKETS SKIPPED', kind: 'number' },
  { key: 'radioErrors', section: 'RADIO', label: 'RADIO PACKET ERROR OCCURRENCES', kind: 'number' },
];

// ------------------------------------------------------------------

export const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
export const SECTIONS = [...new Set(FIELDS.map((f) => f.section))];
const LAST_SECTION = SECTIONS[SECTIONS.length - 1];
const BY_LABEL = new Map(FIELDS.map((f) => [f.label, f]));

const collapse = (text) => text.trim().replace(/\s+/g, ' ');
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// " ------------------ LOCKED" -> "LOCKED". A minus sign right before the
// number stays: " ---------- -71.0896268" -> "-71.0896268".
function stripLeader(rest) {
  const text = rest.trim().replace(/^-+\s+/, '');
  return /^-+$/.test(text) ? '' : text;
}

// A number, then optionally a unit. The unit may follow a space ("17.3 m")
// or sit right against the number ("17.3m"). "19:42:13" and "1.2.3" are
// not numbers, so they stay text.
const NUM = '[-+]?(?:\\d+\\.?\\d*|\\.\\d+)';
const NUMBER = new RegExp(`^(${NUM})(?:\\s*([^\\d\\s:.,|].*))?$`);
const PERCENT = new RegExp(`^(${NUM})\\s*%`);

function readNumber(text) {
  const m = NUMBER.exec(text);
  if (!m || !Number.isFinite(Number(m[1]))) return null;
  return { raw: m[1], num: Number(m[1]), unit: (m[2] || '').trim() };
}

// Reads a value as its field's kind says. Always returns the same shape:
//   text  the value as printed, dashes stripped
//   word  the status word (LOCKED, GOOD, ON), or ''
//   tone  that word's color from `words`, or '' for a word the page doesn't know
//   raw, num, unit  the number as printed, as a number, and its unit.
//                   num is null when there's no number (like "--").
//   hdopRaw, hdop   lock quality only: the HDOP as printed and as a number
function readValue(field, text) {
  const v = { text, word: '', tone: '', raw: '', num: null, unit: '' };
  if (!text) return v;
  if (field.kind === 'status' || field.kind === 'onoff') {
    v.word = text;
    v.tone = field.words[text] || '';
  } else if (field.kind === 'number') {
    Object.assign(v, readNumber(text));
  } else if (field.kind === 'quality') {
    const pct = PERCENT.exec(text);
    if (pct) Object.assign(v, { raw: pct[1], num: Number(pct[1]), unit: '%' });
    const hdop = new RegExp(`\\(\\s*${escapeRe(field.hdop)}\\s*(${NUM})\\s*\\)`).exec(text);
    v.hdopRaw = hdop ? hdop[1] : '';
    v.hdop = hdop ? Number(hdop[1]) : null;
  } else if (field.kind === 'rate') {
    const m = /^([A-Za-z]\S*)\s*(.*)$/.exec(text);
    if (m) {
      v.word = m[1];
      v.tone = field.words[m[1]] || '';
    }
    Object.assign(v, readNumber(m ? m[2] : text));
  }
  return v;
}

// "5.3 s", "1 min 5.3 s" or "1 h 2 min 5 s" -> seconds (5.3, 65.3, 3725).
// null when the text isn't made only of those parts.
export function parseDuration(text) {
  let total = 0;
  let found = false;
  const rest = text.replace(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi, (all, n, unit) => {
    if (!Object.hasOwn(BANNER.units, unit)) return all;
    total += Number(n) * BANNER.units[unit];
    found = true;
    return '';
  });
  return found && !rest.trim() ? Math.round(total * 1000) / 1000 : null;
}

// "==== HEARTBEAT #65 | TIME RUNNING: 1 min 5.3 s ====" -> { heartbeat: 65,
// timeRunning: 65.3, timeText: '1 min 5.3 s' }. A part that can't be read
// is null. A line of "=" with neither part isn't a banner, so it's null.
function parseBanner(text) {
  const inner = text.replace(/^=+|=+$/g, '');
  let heartbeat = null;
  let timeRunning = null;
  let timeText = '';
  let found = false;
  for (const part of inner.split('|')) {
    const s = collapse(part);
    if (s.startsWith(BANNER.heartbeat)) {
      found = true;
      const m = /^#?\s*(\d+)$/.exec(s.slice(BANNER.heartbeat.length).trim());
      if (m) heartbeat = Number(m[1]);
      continue;
    }
    const colon = s.indexOf(':');
    if (colon > 0 && collapse(s.slice(0, colon)) === BANNER.time) {
      found = true;
      timeText = s.slice(colon + 1).trim();
      timeRunning = parseDuration(timeText);
    }
  }
  return found ? { heartbeat, timeRunning, timeText } : null;
}

// Sorts one line on its own, with no memory of the lines before it.
// Returns { type, ... }:
//   banner   { heartbeat, timeRunning, timeText }
//   error    { message }
//   section  { name }
//   field    { label, field, value }. field is null for a label the page
//            doesn't know, and then value is only { text }.
//   empty    a blank line
//   other    anything else, like a line of "=" with no heartbeat in it
export function parseLine(line) {
  const trimmed = line.replace(/[\r\n]+$/, '').trim();
  if (!trimmed) return { type: 'empty' };
  if (trimmed.startsWith(BANNER.start)) {
    const banner = parseBanner(trimmed);
    return banner ? { type: 'banner', ...banner } : { type: 'other' };
  }
  const colon = trimmed.indexOf(':');
  if (colon < 0) return { type: 'section', name: collapse(trimmed) };
  const label = collapse(trimmed.slice(0, colon));
  if (label.toLowerCase() === ERROR_LABEL.toLowerCase()) {
    return { type: 'error', message: trimmed.slice(colon + 1).trim() };
  }
  const field = BY_LABEL.get(label) || null;
  const text = stripLeader(trimmed.slice(colon + 1));
  return { type: 'field', label, field, value: field ? readValue(field, text) : { text } };
}

// Puts lines together into blocks. Feed it every line, in order, with
// push(). It remembers the block being read and the section it's in, and
// the last heartbeat number and running time, so it can spot lost blocks
// and a board restart.
export class BlockParser {
  constructor() {
    this.block = null;      // the block being read
    this.current = null;    // the newest block, which keeps errors until the next banner
    this.section = '';      // the section header it's under
    this.inSection = 0;     // field lines since that header
    this.lastBeat = null;   // heartbeat number of the last banner
    this.lastTime = null;   // TIME RUNNING of the last banner, in seconds
  }

  // Call on every new connection. The board keeps counting while the port
  // is closed, so that jump in heartbeat numbers isn't lost blocks. A
  // restart still shows, because TIME RUNNING goes back.
  newConnection() {
    this.finish();
    this.current = null;
    this.lastBeat = null;
  }

  // Reads one line. `t` is when it arrived, in ms on the computer's clock.
  // Returns { type, done, ... } with parseLine's types, except that a
  // section or field line outside a block, or a label the page doesn't
  // know, is 'other'. `done` is the block this line finished, or null.
  // A banner also has `block` (the new block), `missed` (heartbeat numbers
  // skipped since the last banner) and `restarted` (the board started over).
  //
  // A block is { t, heartbeat, timeRunning, timeText, fields, errors },
  // where t is when its banner arrived, fields is { key: value } for known
  // labels, and errors lists the "Error:" messages from its banner until the
  // next one. Errors can still be added after the block is done, up to the
  // next banner.
  push(line, t) {
    const p = parseLine(line);
    if (p.type === 'banner') return this.startBlock(p, t);
    if (p.type === 'error') {
      this.current?.errors.push(p.message || line.trim());
      return { ...p, done: null };
    }
    if (p.type === 'empty') {
      const end = this.block && this.section === LAST_SECTION && this.inSection > 0;
      return { type: 'empty', done: end ? this.finish() : null };
    }
    if (!this.block) return { type: 'other', done: null };
    if (p.type === 'section') {
      this.section = p.name;
      this.inSection = 0;
      return { ...p, done: null };
    }
    if (p.type === 'field') {
      this.inSection++;
      if (!p.field) return { type: 'other', done: null };
      this.block.fields[p.field.key] = p.value;
      return { ...p, done: null };
    }
    return { type: 'other', done: null };
  }

  startBlock(p, t) {
    const done = this.finish();
    const { heartbeat, timeRunning, timeText } = p;
    let missed = 0;
    let restarted = false;
    if (heartbeat !== null && this.lastBeat !== null) {
      if (heartbeat < this.lastBeat) restarted = true;
      else if (heartbeat > this.lastBeat + 1) missed = heartbeat - this.lastBeat - 1;
    }
    if (timeRunning !== null && this.lastTime !== null && timeRunning < this.lastTime) restarted = true;
    if (restarted) missed = 0;
    if (heartbeat !== null) this.lastBeat = heartbeat;
    if (timeRunning !== null) this.lastTime = timeRunning;
    this.block = { t, heartbeat, timeRunning, timeText, fields: {}, errors: [] };
    this.current = this.block;
    return { type: 'banner', done, block: this.block, missed, restarted };
  }

  // Ends the block being read and returns it, or null if there isn't one.
  // The page calls it when the port closes, so a cut-off block still counts.
  finish() {
    const block = this.block;
    this.block = null;
    this.section = '';
    this.inSection = 0;
    return block;
  }
}

// true for a word with the good tone (LOCKED), false for the bad one
// (SEARCHING), null when there's no value or the word is unknown.
export function readLock(value) {
  if (!value || !value.tone) return null;
  return value.tone === 'good' ? true : value.tone === 'bad' ? false : null;
}

// A position worth drawing: real numbers, on the globe, not the 0, 0 a GPS
// reports before its first lock, and not from a block that says SEARCHING.
export function readPosition(fields) {
  const lat = fields.lat?.num;
  const lon = fields.lon?.num;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  if (readLock(fields.lock) === false) return null;
  return { lat, lon };
}
