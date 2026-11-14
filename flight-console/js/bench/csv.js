// csv.js: builds the "Save as CSV" file from every block received this
// visit. No DOM here, so Node can run it too.
//
// One row per block from the board, in the order they arrived:
//   PC time, HEARTBEAT #, TIME RUNNING in seconds, then one column per
//   field in FIELDS. LOCK QUALITY splits into its percent and its HDOP,
//   and GPS DATA RATE into its status word and its rate. Last, ERRORS:
//   every "Error:" message from the block's banner until the next one.

import { BANNER, FIELDS } from './parse.js?v=4';

// Quotes a cell only when it has to: commas, quotes or line breaks.
function cell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

// A number as the board printed it, or the text when it isn't a number.
const printed = (v) => (v ? v.raw || v.text : '');

// The columns, as [{ header, get(block) }].
// units: { key: first unit the board sent for it }, used in the headers.
export function csvColumns(units = {}) {
  const columns = [
    { header: 'PC time (UTC)', get: (b) => new Date(b.t).toISOString() },
    { header: `${BANNER.heartbeat} #`, get: (b) => b.heartbeat },
    { header: `${BANNER.time} (s)`, get: (b) => b.timeRunning },
  ];
  const withUnit = (label, unit) => (unit ? `${label} (${unit})` : label);
  for (const f of FIELDS) {
    const unit = units[f.key] || f.unit || '';
    const v = (b) => b.fields[f.key];
    if (f.kind === 'quality') {
      columns.push(
        { header: withUnit(f.label, unit), get: (b) => printed(v(b)) },
        { header: f.hdop, get: (b) => v(b)?.hdopRaw },
      );
    } else if (f.kind === 'rate') {
      columns.push(
        { header: `${f.label} STATUS`, get: (b) => v(b)?.word },
        { header: withUnit(f.label, unit), get: (b) => printed(v(b)) },
      );
    } else if (f.kind === 'onoff') {
      // "AIRBORNE 4G" alone doesn't say what it is, so the section goes first.
      columns.push({ header: `${f.section} ${f.label}`, get: (b) => v(b)?.word });
    } else if (f.kind === 'status') {
      columns.push({ header: f.label, get: (b) => v(b)?.word });
    } else {
      columns.push({ header: withUnit(f.label, unit), get: (b) => printed(v(b)) });
    }
  }
  // Several errors in one block are split by " | ", like the banner's parts.
  columns.push({ header: 'ERRORS', get: (b) => b.errors.join(' | ') });
  return columns;
}

// blocks: the BlockParser's blocks, in order.
export function buildCsv(blocks, units = {}) {
  const columns = csvColumns(units);
  const rows = [columns.map((c) => cell(c.header)).join(',')];
  for (const b of blocks) rows.push(columns.map((c) => cell(c.get(b))).join(','));
  // CRLF line ends, and a byte order mark so Excel reads the ° sign right.
  return '﻿' + rows.join('\r\n') + '\r\n';
}

// "dogtooth-bench-2026-11-12-1942.csv", in the computer's local time.
export function csvFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `dogtooth-bench-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.csv`;
}
