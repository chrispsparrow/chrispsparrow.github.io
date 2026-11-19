// position-input.js: reads a position the way a person types or pastes it
// at the launch field. The launch panel's ground station setting has two
// boxes, latitude and longitude, and this file turns what is in them into
// numbers, or says in plain words why it can't.
//
// What it reads:
//   44.825278 and -73.171727           one value in each box
//   44.825278, -73.171727              a pair in either box (latitude first)
//   44.825278 -73.171727               the same with a space or a tab
//   44.825278N 73.171727W              N, S, E and W, before or after the
//   N44.825278 W73.171727              number. With letters on both, either
//                                      order works.
//   (44.825278, -73.171727), 44.825278°  brackets and degree signs are dropped
// What it refuses, with a message for the panel to show next to the box:
//   an empty box, words, more numbers than fit, degrees and minutes
//   (44°49'31", and also "44 49.517": a whole number, a space and a number
//   under 60 is how degrees and minutes are written, so it is not taken as
//   the pair 44 and 49.517), a latitude past 90 or a longitude past 180, E
//   or W in the latitude box, a minus sign together with a letter, a letter
//   squeezed between two numbers with no other letter to say whose it is
//   ("1e5"), and a decimal comma ("44,82" would read as the pair 44 and 82,
//   which nobody means).
//
//   parsePosition(latText, lonText)
//     -> { ok: true, lat, lon }
//     -> { ok: false, box: 'lat' | 'lon' | 'both', message }
//     A pair in one box wins over whatever the other box holds, because a
//     pair pasted into one box leaves the old value in the other.
//   readPair(text)
//     -> { lat, lon } when the text is a whole position on its own, or
//        null. The panel uses it to split a pasted pair into the two boxes.
//   formatDegrees(value) -> '44.825278' (6 decimals, about 0.1 m)
//
// Used by: js/launch/launch-panel.js and test/launch-panel.test.mjs. No DOM.

const EXAMPLE_LAT = '44.825278';
const EXAMPLE_LON = '-73.171727';
const EXAMPLE_PAIR = `${EXAMPLE_LAT}, ${EXAMPLE_LON}`;

// 6 decimal places of a degree is about 0.1 m, more than a GPS fix is good for.
export function formatDegrees(value) {
  return Number.isFinite(value) ? value.toFixed(6) : '';
}

// One box's text, as a list of parts: [{ value, letter, signed }]. letter is
// 'N', 'S', 'E', 'W' or ''. Returns { empty: true } for a blank box and
// { error } for text that can't be read.
function readBox(text) {
  const raw = String(text ?? '');
  // Minus signs from a web page or a phone are often not the keyboard's.
  let clean = raw.replace(/[−‒–—]/g, '-').toUpperCase();
  if (/['"′″]|\bMIN|\bSEC/.test(clean) || /\d\s*°\s*\d/.test(clean)) {
    return { error: `Type decimal degrees, like ${EXAMPLE_LAT}. Degrees and minutes aren't read here.` };
  }
  // A comma straight between two whole numbers is a decimal comma.
  if (/(^|[^\d.])\d+,\d+($|[^\d.])/.test(clean.replace(/\s+$/, '')) && !/\./.test(clean)) {
    return { error: `Use a point for decimals, like ${EXAMPLE_LAT}.` };
  }
  clean = clean.replace(/°|\bDEG(REES)?\b|\bLAT(ITUDE)?\b|\bLON(G|GITUDE)?\b|\bLNG\b|[()[\]:=]/g, ' ');
  if (clean.trim() === '') return { empty: true };

  // The text as numbers and letters, each with where it sits. Only spaces,
  // commas and semicolons may stand between them.
  const tokens = [];
  const pattern = /[NSEW]|[-+]?(?:\d+\.?\d*|\.\d+)/g;
  let last = 0;
  for (let m = pattern.exec(clean); m; m = pattern.exec(clean)) {
    if (/[^\s,;]/.test(clean.slice(last, m.index))) return { error: unreadable(raw) };
    // A second point in one number ("44.82.5") is a slip, never a pair.
    if (m.index === last && m[0].startsWith('.') && tokens.length && !tokens[tokens.length - 1].letter) return { error: unreadable(raw) };
    tokens.push({ text: m[0], start: m.index, end: pattern.lastIndex, letter: /^[NSEW]$/.test(m[0]) });
    last = pattern.lastIndex;
  }
  if (/[^\s,;]/.test(clean.slice(last))) return { error: unreadable(raw) };

  const numbers = tokens.filter((t) => !t.letter);
  const letters = tokens.filter((t) => t.letter);
  if (numbers.length === 0) return { error: unreadable(raw) };
  if (numbers.length > 2 || letters.length > numbers.length) {
    return { error: `There are too many numbers here. Type one value, or a pair like ${EXAMPLE_PAIR}.` };
  }
  // "44 49.517" is degrees and minutes, not the pair 44 and 49.517: a whole
  // number, only spaces, then a number under 60 with no sign. A pair with a
  // comma between its two numbers ("44, 49.517") is still read as a pair,
  // and so is one with a letter on each number ("44N 49E").
  if (numbers.length === 2 && letters.length < 2) {
    const [first, second] = numbers;
    const between = clean.slice(first.end, second.start);
    if (/^[-+]?\d+$/.test(first.text) && /^\s+$/.test(between) && !/^[-+]/.test(second.text) && Number(second.text) < 60) {
      return { error: `This looks like degrees and minutes. Type decimal degrees, like ${EXAMPLE_LAT}. If it is a pair, put a comma between the two.` };
    }
  }
  // Each letter belongs to the number it touches (44.8 W73.1). A letter
  // that stands apart goes with the number after it when the text starts
  // with a letter (N 44.8 W 73.1), and with the one before it when it
  // doesn't (44.8 N, 73.1 W).
  const lettersFirst = tokens[0].letter;
  const letterOf = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok.letter) continue;
    const prev = tokens[i - 1] && !tokens[i - 1].letter ? tokens[i - 1] : null;
    const next = tokens[i + 1] && !tokens[i + 1].letter ? tokens[i + 1] : null;
    const touchesPrev = Boolean(prev) && prev.end === tok.start;
    const touchesNext = Boolean(next) && tok.end === next.start;
    // One letter squeezed between two numbers ("1e5", "44N73") could belong
    // to either. With a letter for each number ("44.8N73.1W") it is clear.
    if (touchesPrev && touchesNext && letters.length < numbers.length) return { error: unreadable(raw) };
    let owner = lettersFirst ? next : prev;
    if (touchesNext && !touchesPrev) owner = next;
    else if (touchesPrev && !touchesNext) owner = prev;
    if (!owner || letterOf.has(owner)) return { error: unreadable(raw) };
    letterOf.set(owner, tok.text);
  }
  const parts = numbers.map((tok) => ({
    value: Number(tok.text),
    letter: letterOf.get(tok) ?? '',
    signed: /^[-+]/.test(tok.text),
  }));
  if (parts.some((p) => !Number.isFinite(p.value))) return { error: unreadable(raw) };
  if (parts.some((p) => p.letter && p.signed)) return { error: 'Use a minus sign or a letter, not both.' };
  return { parts };
}

function unreadable(raw) {
  const shown = raw.trim().length > 24 ? `${raw.trim().slice(0, 24)}...` : raw.trim();
  return `"${shown}" can't be read as a position. Type decimal degrees, like ${EXAMPLE_LAT}.`;
}

// A part's number with its letter applied (S and W are negative).
const signedValue = (part) => (part.letter === 'S' || part.letter === 'W' ? -part.value : part.value);
const isLatLetter = (letter) => letter === 'N' || letter === 'S';
const isLonLetter = (letter) => letter === 'E' || letter === 'W';

function checkRange(lat, lon) {
  if (Math.abs(lat) > 90) return { box: 'lat', message: 'Latitude goes from -90 to 90.' };
  if (Math.abs(lon) > 180) return { box: 'lon', message: 'Longitude goes from -180 to 180.' };
  return null;
}

// Two parts from one box, as a position. Without letters the latitude
// comes first, the way the console writes its own coordinates.
function readPairParts(parts, box) {
  let [a, b] = parts;
  if (isLonLetter(a.letter) || isLatLetter(b.letter)) [a, b] = [b, a];
  if (isLonLetter(a.letter) || isLatLetter(b.letter)) {
    return { ok: false, box, message: 'A pair needs one latitude (N or S) and one longitude (E or W).' };
  }
  const lat = signedValue(a);
  const lon = signedValue(b);
  const bad = checkRange(lat, lon);
  return bad ? { ok: false, box, message: bad.message } : { ok: true, lat, lon };
}

export function parsePosition(latText, lonText) {
  const a = readBox(latText);
  const b = readBox(lonText);
  const aPair = a.parts?.length === 2;
  const bPair = b.parts?.length === 2;
  // An unreadable box is refused, unless the other box holds a whole pair.
  if (a.error && !bPair) return { ok: false, box: 'lat', message: a.error };
  if (b.error && !aPair) return { ok: false, box: 'lon', message: b.error };

  if (aPair && bPair) {
    const fromA = readPairParts(a.parts, 'lat');
    const fromB = readPairParts(b.parts, 'lon');
    if (!fromA.ok) return fromA;
    if (!fromB.ok) return fromB;
    if (fromA.lat !== fromB.lat || fromA.lon !== fromB.lon) {
      return { ok: false, box: 'both', message: 'Each box has a different pair. Put the pair in one box.' };
    }
    return fromA;
  }
  if (aPair) return readPairParts(a.parts, 'lat');
  if (bPair) return readPairParts(b.parts, 'lon');

  if (a.empty) return { ok: false, box: 'lat', message: `Type a latitude, like ${EXAMPLE_LAT}.` };
  if (b.empty) return { ok: false, box: 'lon', message: `Type a longitude, like ${EXAMPLE_LON}.` };
  const [latPart] = a.parts;
  const [lonPart] = b.parts;
  if (isLonLetter(latPart.letter)) return { ok: false, box: 'lat', message: 'E and W are for longitude. Latitude uses N or S.' };
  if (isLatLetter(lonPart.letter)) return { ok: false, box: 'lon', message: 'N and S are for latitude. Longitude uses E or W.' };
  const lat = signedValue(latPart);
  const lon = signedValue(lonPart);
  const bad = checkRange(lat, lon);
  return bad ? { ok: false, box: bad.box, message: bad.message } : { ok: true, lat, lon };
}

export function readPair(text) {
  const box = readBox(text);
  if (box.parts?.length !== 2) return null;
  const pair = readPairParts(box.parts, 'both');
  return pair.ok ? { lat: pair.lat, lon: pair.lon } : null;
}
