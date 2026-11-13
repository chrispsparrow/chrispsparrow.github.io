// parse.js: turns one line from the board into something the page can use.
// No DOM here, so Node can run it too (see README, "Checking the parser").
//
// A reading line looks like this (the flight firmware's status line, see
// "Serial output format" in the firmware's docs/FIRMWARE_GUIDE.md):
//   Time: 16.1 s | GPS fix: yes | Satellites: 11 | Position accuracy (HDOP): 0.99 | Altitude: 17.3 m
// Each part is "Label: value unit". Parts are matched by their label, never
// by their position, so the board can add, drop or reorder parts. A label
// the page doesn't know is skipped.
//
// Two other kinds of line:
//   Error: radio not ready, code 3     -> shown in the errors box
//   Heartbeat: 12345 ms                -> updates the "last heartbeat" time
// The current firmware's "heartbeat 12345" (no colon) counts too.

// Every value the page knows. `label` is the full name the page shows.
// `aliases` are the labels the board may send, already normalized (see
// normalizeLabel). `kind` is 'number' or 'text'. `main` fields always have
// a row in the readings panel. The others get a row once the board sends them.
export const FIELDS = [
  { key: 'fix', label: 'GPS fix', kind: 'text', main: true,
    aliases: ['gps fix', 'fix', 'gps fix status', 'fix status'] },
  { key: 'sats', label: 'Satellites in use', kind: 'number', main: true,
    aliases: ['satellites', 'sats', 'sat', 'satellites in use', 'gps satellites', 'gps sats', 'num sats'] },
  { key: 'hdop', label: 'HDOP', kind: 'number', main: true,
    aliases: ['hdop', 'gps hdop', 'position accuracy hdop', 'position accuracy'] },
  { key: 'lat', label: 'Latitude', kind: 'number', unit: '°', main: true,
    aliases: ['latitude', 'lat', 'gps latitude', 'gps lat'] },
  { key: 'lon', label: 'Longitude', kind: 'number', unit: '°', main: true,
    aliases: ['longitude', 'lon', 'lng', 'long', 'gps longitude', 'gps lon'] },
  { key: 'alt', label: 'Altitude', kind: 'number', unit: 'm', main: true,
    aliases: ['altitude', 'alt', 'alt m', 'gps altitude', 'gps alt', 'altitude msl', 'alt msl'] },
  { key: 'radioSent', label: 'Radio packets sent', kind: 'number', main: true,
    aliases: ['radio sent', 'sent', 'packets sent', 'radio packets sent', 'tx sent'] },
  { key: 'radioErrors', label: 'Radio errors', kind: 'number', main: true,
    aliases: ['radio errors', 'errors', 'radio error', 'tx errors'] },
  { key: 'time', label: 'Board time', kind: 'number', unit: 's',
    aliases: ['time', 't', 'board time', 'uptime'] },
  { key: 'radioSkipped', label: 'Radio packets skipped', kind: 'number',
    aliases: ['radio skipped', 'skipped', 'packets skipped', 'radio packets skipped'] },
  { key: 'gpsMode', label: 'GPS mode', kind: 'text',
    aliases: ['gps mode', 'model', 'gps model', 'dynamic model'] },
  { key: 'gpsChars', label: 'GPS characters', kind: 'number',
    aliases: ['gps characters', 'nmea chars', 'nmea characters'] },
  { key: 'gpsBad', label: 'Bad GPS sentences', kind: 'number',
    aliases: ['bad gps sentences', 'nmea bad', 'nmea errors', 'bad checksums'] },
];

export const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

const BY_ALIAS = new Map();
for (const f of FIELDS) for (const a of f.aliases) BY_ALIAS.set(a, f);

// "Altitude (m)" -> "altitude", "GPS_Fix" -> "gps fix", "HDOP:" -> "hdop".
// With keepBrackets, the words in brackets stay: "Position accuracy (HDOP)"
// -> "position accuracy hdop".
export function normalizeLabel(text, keepBrackets = false) {
  return text
    .toLowerCase()
    .replace(keepBrackets ? /[()[\]]/g : /\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[_\-.]/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// A unit written into the label, like "Altitude (m)".
function unitFromLabel(text) {
  const m = /\(([^)]+)\)|\[([^\]]+)\]/.exec(text);
  return m ? (m[1] || m[2]).trim() : '';
}

// A number, then optionally a unit. The unit may follow a space ("25.4 m")
// or sit right against the number ("25.4m", "45%"). "19:42:13" and "1.2.3"
// are not numbers, so they stay text.
const NUMBER = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)(?:\s*([^\d\s:.,/|].*))?$/;

function splitValue(rest, field, labelUnit) {
  const text = rest.trim();
  if (field.kind === 'number') {
    const m = NUMBER.exec(text);
    if (m) {
      const num = Number(m[1]);
      if (Number.isFinite(num)) {
        return { raw: m[1], num, unit: (m[2] || '').trim() || labelUnit, text };
      }
    }
  }
  // Text fields, and numbers the board couldn't fill in (like "HDOP: ?").
  return { raw: text, num: null, unit: '', text };
}

// Splits a line into fields. Returns { type, fields, message }.
//   type: 'data' (at least one known label), 'error', 'heartbeat',
//         'other' (anything else, like the startup banner), or 'empty'.
//   fields: { key: { raw, num, unit, text, label } } for known labels only.
//           `label` is the label exactly as the board sent it.
//   message: the text after "Error:" or "Heartbeat".
export function parseLine(line) {
  const text = line.replace(/[\r\n]+$/, '');
  const trimmed = text.trim();
  if (!trimmed) return { type: 'empty', fields: {}, message: '' };

  const err = /^error\s*:\s*(.*)$/i.exec(trimmed);
  if (err) return { type: 'error', fields: {}, message: err[1].trim() };

  const beat = /^heartbeat(?:\s*:\s*|\s+|$)(.*)$/i.exec(trimmed);
  if (beat) return { type: 'heartbeat', fields: {}, message: beat[1].trim() };

  const fields = {};
  for (const part of trimmed.split('|')) {
    const colon = part.indexOf(':');
    if (colon < 1) continue;
    const labelText = part.slice(0, colon);
    // First the whole label, brackets and all ("Position accuracy (HDOP)").
    // If that isn't known, the brackets may hold a unit ("Altitude (m)").
    let field = BY_ALIAS.get(normalizeLabel(labelText, true));
    let labelUnit = '';
    if (!field) {
      field = BY_ALIAS.get(normalizeLabel(labelText));
      labelUnit = unitFromLabel(labelText);
    }
    if (!field) continue;
    const value = splitValue(part.slice(colon + 1), field, labelUnit);
    if (!value.text) continue;
    fields[field.key] = { ...value, label: labelText.trim() };
  }
  return { type: Object.keys(fields).length ? 'data' : 'other', fields, message: '' };
}

// Reads a GPS fix value. true, false, or null when it can't tell.
// "yes", "3D", "1", "ok" mean a fix. "no", "none", "0", "lost" mean none.
export function readFix(value) {
  if (!value) return null;
  const t = value.text.toLowerCase();
  if (/\b(no|none|false|invalid|lost|0)\b/.test(t)) return false;
  if (/\b(yes|true|ok|valid|locked|fixed|2d|3d|1)\b/.test(t)) return true;
  return null;
}

// "42.33 N" and "71.08 W" style values: south and west are negative.
function signed(value) {
  if (!value || !Number.isFinite(value.num)) return NaN;
  return /^°?\s*[sw]$/i.test(value.unit) ? -Math.abs(value.num) : value.num;
}

// A position worth drawing: real numbers, on the globe, not the 0, 0 a GPS
// reports before its first fix, and not from a line that says "no fix".
export function readPosition(fields) {
  const lat = signed(fields.lat);
  const lon = signed(fields.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (lat === 0 && lon === 0) return null;
  if (readFix(fields.fix) === false) return null;
  return { lat, lon };
}
