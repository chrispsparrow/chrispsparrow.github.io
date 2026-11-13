// csv.js: builds the "Save as CSV" file from every line received this visit.
// No DOM here, so Node can run it too.
//
// One row per line from the board, in the order it arrived:
//   PC time, seconds since the first line, line type, one column per known
//   value, then the line exactly as received (so labels the page doesn't
//   know, errors and heartbeats are all kept).

import { FIELDS } from './parse.js';

// Quotes a cell only when it has to: commas, quotes or line breaks.
function cell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

// records: [{ t (ms since 1970), type, fields, line }]
// units: { key: first unit the board sent for it }, used in the header.
export function buildCsv(records, units = {}) {
  const t0 = records.length ? records[0].t : 0;
  const header = ['PC time (UTC)', 'Seconds since first line', 'Line type'];
  for (const f of FIELDS) {
    const unit = units[f.key] || f.unit || '';
    header.push(unit ? `${f.label} (${unit})` : f.label);
  }
  header.push('Line as received');

  const rows = [header.map(cell).join(',')];
  for (const r of records) {
    const row = [new Date(r.t).toISOString(), ((r.t - t0) / 1000).toFixed(3), r.type];
    for (const f of FIELDS) {
      const v = r.fields[f.key];
      row.push(v ? v.raw : '');
    }
    row.push(r.line);
    rows.push(row.map(cell).join(','));
  }
  // CRLF line ends, and a byte order mark so Excel reads the ° sign right.
  return '﻿' + rows.join('\r\n') + '\r\n';
}

// "dogtooth-bench-2026-11-12-1942.csv", in the computer's local time.
export function csvFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `dogtooth-bench-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.csv`;
}
