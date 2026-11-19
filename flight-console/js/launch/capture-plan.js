// capture-plan.js: works out how a saved receiver capture is played as a
// test (js/launch/capture.js): which lines go out, when each one goes, and
// how the positions are moved so the first fix lands on the launch field.
//
// THE FILE. Either the receiver's raw output, one line per line, like
// test/radio-board-rx-capture.log, or a flight log written by launch mode or
// the backup logger (js/launch/log-format.js). In a flight log every
// receiver line has the time it arrived in front of it. Those times pace the
// lines, and the logger's own "# " lines (which have no time) are left out.
//
// THE PACE of a raw capture comes from the lines' own clocks:
//   - The status line "# DEKEL_RX listening ... last_good_s_ago=0.9
//     rx_up_s=730.0" carries the receiver's clock (rx_up_s).
//   - A PKT line carries only the flight board's clock (up_s), which is a
//     different clock. The status line after it says how long before it
//     the last good packet came in, so the packet arrived at
//     rx_up_s - last_good_s_ago on the receiver's clock.
//   - A line with no clock (BAD, the start-up header) goes out with the
//     line before it.
//   - A capture with no status lines at all is paced by the first board's
//     up_s, and one with no clock anywhere goes at one line a second.
//   - A clock that goes back (the receiver restarted) costs one second, and
//     a silence longer than MAX_GAP_S is cut to it.
//
// THE SHIFT moves every lat= and lon= in the PKT lines by one fixed offset,
// so the first good fix lands on a given spot (the field's center) and every
// movement after it stays exactly as recorded. The offset is a whole number
// of the last decimal place the line prints (7 places for the receiver), so
// no rounding creeps in. A line with lat=0 and lon=0 has no position and is
// left alone.
//
// No DOM here, so Node tests it (test/flight-log.test.mjs).

// A longer silence (s) in a capture is cut to this when it plays.
export const MAX_GAP_S = 30;
// The speeds the launch panel offers. 1 is real time.
export const SPEEDS = [1, 5, 20];
// The slowest and fastest speed a URL may ask for.
export const MIN_SPEED = 0.1;
export const MAX_SPEED = 200;

const STATUS_START = '# DEKEL_RX ';
const FLIGHT_LOG_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}) > /;

// The value of key=... in a line, as a number, or null.
function numberAfter(line, key) {
  const m = new RegExp(`(?:^|\\s)${key}=(-?\\d+(?:\\.\\d+)?)(?=\\s|$)`).exec(line);
  return m ? Number(m[1]) : null;
}

// A speed from a URL or a select box, kept between MIN_SPEED and MAX_SPEED.
// Anything that isn't a number gives 1 (real time).
export function cleanSpeed(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(MAX_SPEED, Math.max(MIN_SPEED, n));
}

// The file's lines, without line ends. A flight log's receiver lines come
// with the time they arrived (ms), and its "# " lines are dropped:
//   { lines, arrived }   arrived is null for a raw capture
export function readCapture(text) {
  const all = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  if (all.length && all[all.length - 1] === '') all.pop();
  if (!all.some((l) => FLIGHT_LOG_PREFIX.test(l))) return { lines: all, arrived: null };
  const lines = [];
  const arrived = [];
  for (const raw of all) {
    const m = FLIGHT_LOG_PREFIX.exec(raw);
    if (!m) continue;
    lines.push(raw.slice(m[0].length));
    const t = Date.parse(m[1]);
    arrived.push(Number.isFinite(t) ? t : null);
  }
  return { lines, arrived };
}

// When each line goes out, in seconds from the first one, at real speed.
// arrived is readCapture()'s (a flight log's arrival times), or null.
export function captureTimes(lines, arrived = null) {
  const n = lines.length;
  const out = new Array(n).fill(0);
  if (!n) return out;
  // Each line's time on its source clock (s), or null for a line without one.
  const clock = new Array(n).fill(null);
  if (arrived) {
    for (let i = 0; i < n; i++) clock[i] = Number.isFinite(arrived[i]) ? arrived[i] / 1000 : null;
  } else {
    const status = lines.map((l) => (l.startsWith(STATUS_START)
      ? { rx: numberAfter(l, 'rx_up_s'), ago: numberAfter(l, 'last_good_s_ago') }
      : null));
    const hasStatus = status.some((s) => s && Number.isFinite(s.rx));
    if (hasStatus) {
      let nextStatus = null;  // the next status line with a clock, looking back from the end
      let lastRx = null;      // the status line before, looking forward
      const next = new Array(n).fill(null);
      for (let i = n - 1; i >= 0; i--) {
        next[i] = nextStatus;
        if (status[i] && Number.isFinite(status[i].rx)) nextStatus = status[i];
      }
      for (let i = 0; i < n; i++) {
        const s = status[i];
        if (s && Number.isFinite(s.rx)) {
          clock[i] = s.rx;
          lastRx = s.rx;
        } else if (lines[i].startsWith('PKT ')) {
          const b = next[i];
          // The packet came in last_good_s_ago before the next status line,
          // unless the receiver restarted in between.
          if (b && Number.isFinite(b.ago) && !(lastRx !== null && b.rx < lastRx - 0.5)) {
            clock[i] = Math.min(b.rx, Math.max(lastRx ?? -Infinity, b.rx - b.ago));
          }
        }
      }
    } else {
      // Only packets: the first board's own clock.
      const first = lines.find((l) => l.startsWith('PKT '));
      const node = first ? numberAfter(first, 'node') : null;
      for (let i = 0; i < n; i++) {
        if (lines[i].startsWith('PKT ') && numberAfter(lines[i], 'node') === node) clock[i] = numberAfter(lines[i], 'up_s');
      }
      if (!clock.some(Number.isFinite)) {
        for (let i = 0; i < n; i++) out[i] = i;
        return out;
      }
    }
  }
  let prev = null;
  for (let i = 0; i < n; i++) {
    let dt = 0;
    const c = clock[i];
    if (Number.isFinite(c)) {
      if (prev !== null) {
        dt = c - prev;
        if (dt < -0.5) dt = 1;          // the clock started over
        else if (dt < 0) dt = 0;        // a little out of order: at once
        else if (dt > MAX_GAP_S) dt = MAX_GAP_S;
      }
      prev = c;
    }
    out[i] = i === 0 ? 0 : out[i - 1] + dt;
  }
  return out;
}

// The first good fix in the lines: { lat, lon, index }, or null.
export function firstFix(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('PKT ')) continue;
    if (!/(?:^|\s)fix=(yes|1)(?=\s|$)/.test(line)) continue;
    const lat = numberAfter(line, 'lat');
    const lon = numberAfter(line, 'lon');
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
    return { lat, lon, index: i };
  }
  return null;
}

// Moves one number by an offset, in whole steps of its own last decimal
// place, and prints it with the same number of decimals.
function moveNumber(text, by) {
  const decimals = text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
  const scale = 10 ** decimals;
  const moved = (Math.round(Number(text) * scale) + Math.round(by * scale)) / scale;
  return moved.toFixed(decimals);
}

// The lines with every PKT line's lat= and lon= moved by { dLat, dLon }.
export function shiftLines(lines, { dLat, dLon }) {
  return lines.map((line) => {
    if (!line.startsWith('PKT ')) return line;
    const lat = numberAfter(line, 'lat');
    const lon = numberAfter(line, 'lon');
    if (lat === 0 && lon === 0) return line;
    return line
      .replace(/(\slat=)(-?\d+(?:\.\d+)?)(?=\s|$)/, (_, key, value) => key + moveNumber(value, dLat))
      .replace(/(\slon=)(-?\d+(?:\.\d+)?)(?=\s|$)/, (_, key, value) => key + moveNumber(value, dLon));
  });
}

const signed = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(7)}`;

// Everything capture.js needs to play a file:
//   text      the file's contents
//   name      what to call it in the log's header lines
//   speed     1 is real time
//   target    { lat, lon } to move the first fix to, or null to leave the
//             positions as they are
// Returns { lines, times, durationS, shift, notes }:
//   lines      the lines to hand over, moved when asked
//   times      when each goes out, in seconds from the start, at this speed
//   durationS  how long the whole capture takes at this speed
//   shift      { dLat, dLon } that was applied, or null
//   shiftNote  why there was no shift when one was asked for, or ''
//   notes      the lines for the flight log's header (without "# ")
export function planCapture(text, { name = 'a saved capture', speed = 1, target = null } = {}) {
  const read = readCapture(text);
  const pace = cleanSpeed(speed);
  const realTimes = captureTimes(read.lines, read.arrived);
  const times = realTimes.map((t) => t / pace);
  let lines = read.lines;
  let shift = null;
  let shiftNote = '';
  if (target) {
    const fix = firstFix(lines);
    if (!fix) shiftNote = 'it has no good fix to move';
    else {
      shift = { dLat: target.lat - fix.lat, dLon: target.lon - fix.lon };
      lines = shiftLines(lines, shift);
    }
  }
  const speedWords = pace === 1 ? 'real speed' : `${pace} times real speed`;
  const notes = [
    `test capture, not live data: ${name}, played at ${speedWords}`,
    shift
      ? `every lat= and lon= in its PKT lines was moved by ${signed(shift.dLat)} and ${signed(shift.dLon)} degrees, so its first fix lands on the launch field`
      : `its positions were not moved${shiftNote ? ` (${shiftNote})` : ''}`,
  ];
  return {
    lines,
    times,
    durationS: times.length ? times[times.length - 1] : 0,
    shift,
    shiftNote,
    notes,
  };
}
