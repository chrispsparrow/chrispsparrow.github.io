// log-format.js: what a flight log looks like as text. Launch mode's flight
// log (flight-log.js) writes it to the disk file and to the local server,
// and the backup logger writes the same format. The Flight Console loads it
// back with LOAD FILE (readFlightLogLine() in js/parser.js takes the time
// off each line).
//
// THE FORMAT. UTF-8 text, one line per serial line, each ending in a line
// feed.
//   - A data line is the time the line arrived on this computer, then " > ",
//     then the receiver's line exactly as it came:
//       2026-11-21T14:03:22.123-05:00 > PKT node=1 seq=806 up_s=807.0 ...
//     The time is local time with milliseconds and the UTC offset.
//   - A line the logger adds itself starts with "# " and has no time:
//       # Dogtooth flight log
//       # started 2026-11-21T14:03:20.004-05:00
//       # written by the Flight Console launch page
//       # each line: the time it arrived on this computer, then ' > ', then the receiver's line
//       # connection closed 2026-11-21T14:09:41.250-05:00
//       # connected 2026-11-21T14:09:55.871-05:00
//
// FILE NAMES. The file the user picks is suggested as
// flight-YYYY-MM-DD-HHMM.log. The server's copy is
// flight-YYYY-MM-DD-HHMMSS-page.log in flight-logs/. A played test capture
// uses test-capture- in place of flight-, so test data is never taken for
// the flight.
//
// createLogText() holds one log's lines while the page is open, with how
// many bytes the first k lines take. The file on disk and the server's copy
// are each a growing copy of that text, so a file's size alone says how many
// lines it has (log-sinks.js uses that to never write a line twice).
//
// No DOM here, so Node can test it.

const pad = (n, width = 2) => String(n).padStart(width, '0');
const encoder = new TextEncoder();

// Who wrote the log, for its third line.
export const WRITER_PAGE = 'the Flight Console launch page';

// A data line's prefix, as a pattern.
export const LOG_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} > /;

// "2026-11-21T14:03:22.123-05:00": ms on the computer's clock as local time
// with milliseconds and the UTC offset.
export function formatLogTime(ms) {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now());
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin < 0 ? '-' : '+';
  const off = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(off / 60))}:${pad(off % 60)}`;
}

// One receiver line with the time it arrived, ready to write.
export function dataLine(line, ms) {
  return `${formatLogTime(ms)} > ${line}\n`;
}

// A line the logger adds itself.
export function noteLine(text) {
  return `# ${text}\n`;
}

// The lines a log starts with. notes are more "# " lines for after them (a
// test capture says what it played and how its positions were moved).
export function headerLines(startedAt, { writer = WRITER_PAGE, notes = [] } = {}) {
  return [
    noteLine('Dogtooth flight log'),
    noteLine(`started ${formatLogTime(startedAt)}`),
    noteLine(`written by ${writer}`),
    noteLine('each line: the time it arrived on this computer, then \' > \', then the receiver\'s line'),
    ...notes.map(noteLine),
  ];
}

// A log's file name.
//   kind    'flight' or 'test'
//   where   'pick'    the name suggested in the save box: flight-2026-11-21-1403.log
//           'server'  the server's copy: flight-2026-11-21-140322-page.log
export function logFileName(kind, ms, where = 'pick') {
  const d = new Date(ms);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const start = kind === 'test' ? 'test-capture' : 'flight';
  const clock = `${pad(d.getHours())}${pad(d.getMinutes())}`;
  return where === 'server'
    ? `${start}-${day}-${clock}${pad(d.getSeconds())}-page.log`
    : `${start}-${day}-${clock}.log`;
}

// Another name for the server's copy, for when the first one can't be used
// (see createServerSink() in log-sinks.js): the same name with four random
// letters and numbers before ".log".
export function otherFileName(name, random = Math.random) {
  const stem = String(name).replace(/\.log$/, '').replace(/-page(-[a-z0-9]{4})?$/, '-page');
  const token = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0');
  return `${stem}-${token}.log`;
}

// How many bytes a piece of text takes as UTF-8.
export function byteLength(text) {
  // The receiver prints plain ASCII, so most lines need no encoding to count.
  return /^[\x00-\x7f]*$/.test(text) ? text.length : encoder.encode(text).length;
}

// One log's lines, in order, each with its line feed.
//   add(text, isData)   adds a line. isData marks a receiver line (the ones
//                       the status counts), not one the logger added itself.
//   count               lines so far
//   dataCount           receiver lines so far
//   bytes               bytes so far
//   text(from, to)      the lines from..to (to not included) as one string
//   bytesAt(k)          bytes in the first k lines
//   dataAt(k)           receiver lines among the first k
//   lineAtBytes(n)      k when the first k lines take exactly n bytes, else -1
export function createLogText() {
  const lines = [];
  const bytesAt = [0];
  const dataAt = [0];
  return {
    add(text, isData = false) {
      lines.push(text);
      bytesAt.push(bytesAt[bytesAt.length - 1] + byteLength(text));
      dataAt.push(dataAt[dataAt.length - 1] + (isData ? 1 : 0));
    },
    get count() { return lines.length; },
    get dataCount() { return dataAt[dataAt.length - 1]; },
    get bytes() { return bytesAt[bytesAt.length - 1]; },
    text: (from, to) => lines.slice(from, to).join(''),
    bytesAt: (k) => bytesAt[Math.max(0, Math.min(k, lines.length))],
    dataAt: (k) => dataAt[Math.max(0, Math.min(k, lines.length))],
    lineAtBytes(n) {
      let lo = 0;
      let hi = lines.length;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (bytesAt[mid] === n) return mid;
        if (bytesAt[mid] < n) lo = mid + 1;
        else hi = mid - 1;
      }
      return -1;
    },
  };
}
