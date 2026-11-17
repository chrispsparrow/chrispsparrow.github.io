// csv.js: builds the "Save as CSV" file from every block received this
// visit. No DOM here, so Node can run it too.
//
// One row per block from the board, in the order they arrived:
//   PC time, HEARTBEAT #, TIME RUNNING in seconds, then one column per
//   field in FIELDS. LOCK QUALITY splits into its percent and its HDOP,
//   and GPS DATA RATE into its status word and its rate. Last, ERRORS:
//   every "Error:" message from the block's banner until the next one.

import { BANNER, FIELDS } from './parse.js?v=5';

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
    // Empty for a block with no arrival time (one read from a loaded log).
    { header: 'PC time (UTC)', get: (b) => (Number.isFinite(b.t) ? new Date(b.t).toISOString() : '') },
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

// The first unit the board sent for each value, the way the bench panel
// keeps them for its column headers.
export function blockUnits(blocks) {
  const units = {};
  for (const b of blocks) {
    for (const [key, value] of Object.entries(b?.fields ?? {})) {
      if (value?.unit && !units[key]) units[key] = value.unit;
    }
  }
  return units;
}

// Splits CSV text into rows of cells, following the quoting buildCsv()
// writes ("" inside a quoted cell is one "). Line ends can be \r\n or \n.
function splitCsvRows(text) {
  const rows = [];
  let row = [];
  let cellText = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cellText += '"'; i += 2; continue; }
        quoted = false;
        i += 1;
        continue;
      }
      cellText += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cellText === '') { quoted = true; i += 1; continue; }
    if (ch === ',') { row.push(cellText); cellText = ''; i += 1; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(cellText);
      rows.push(row);
      row = [];
      cellText = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cellText += ch;
    i += 1;
  }
  if (cellText !== '' || row.length) {
    row.push(cellText);
    rows.push(row);
  }
  return rows;
}

// A number as the board printed it: "49.4" -> { raw, num }. Anything else
// is kept as text.
const NUMBER_TEXT = /^[-+]?(?:\d+\.?\d*|\.\d+)$/;
function printedValue(cellText, unit) {
  if (NUMBER_TEXT.test(cellText)) return { text: unit ? `${cellText} ${unit}` : cellText, word: '', tone: '', raw: cellText, num: Number(cellText), unit };
  return { text: cellText, word: '', tone: '', raw: '', num: null, unit: '' };
}

// Reads a CSV file that buildCsv() wrote back into the blocks it came from,
// so a saved file replays like the board's own output and saves again
// unchanged. Returns { blocks, units }, or null when the text isn't one of
// these files (its header row isn't exactly what buildCsv() writes).
// What a block keeps: its banner's time (from PC time), its heartbeat
// number, its TIME RUNNING, every value as the board printed it (with the
// column's unit), and its errors. What the CSV never had stays out: the
// TIME RUNNING as the board wrote it, and labels the page doesn't know.
// An empty cell means the board didn't print that value.
export function readCsvBlocks(text) {
  const rows = splitCsvRows(String(text ?? '').replace(/^\uFEFF/, ''));
  if (!rows.length) return null;
  const header = rows[0];
  // The units, from the headers that can carry one: "ALTITUDE (m)".
  const units = {};
  let c = 3;
  for (const f of FIELDS) {
    const unitAt = f.kind === 'quality' ? c : f.kind === 'rate' ? c + 1 : f.kind === 'number' ? c : -1;
    if (unitAt >= 0) {
      // "LABEL (unit)": the unit is whatever sits in the brackets.
      const cellText = header[unitAt] ?? '';
      const start = `${f.label} (`;
      if (cellText.startsWith(start) && cellText.endsWith(')') && cellText.length > start.length + 1) {
        units[f.key] = cellText.slice(start.length, -1);
      }
    }
    c += f.kind === 'quality' || f.kind === 'rate' ? 2 : 1;
  }
  const expected = csvColumns(units).map((col) => col.header);
  if (header.length !== expected.length || expected.some((h, i) => h !== header[i])) return null;

  const blocks = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === '') continue;   // the blank end of the file
    if (cells.length !== expected.length) return null;
    const t = Date.parse(cells[0]);
    const block = {
      t: Number.isFinite(t) ? t : null,
      heartbeat: cells[1] === '' ? null : Number(cells[1]),
      timeRunning: cells[2] === '' ? null : Number(cells[2]),
      timeText: '',
      fields: {},
      errors: cells[cells.length - 1] === '' ? [] : cells[cells.length - 1].split(' | '),
    };
    let at = 3;
    for (const f of FIELDS) {
      const unit = units[f.key] || f.unit || '';
      if (f.kind === 'quality') {
        const pct = cells[at];
        const hd = cells[at + 1];
        at += 2;
        if (pct === '' && hd === '') continue;
        const v = printedValue(pct, NUMBER_TEXT.test(pct) ? '%' : '');
        v.hdopRaw = hd;
        v.hdop = hd === '' ? null : Number(hd);
        block.fields[f.key] = v;
      } else if (f.kind === 'rate') {
        const word = cells[at];
        const value = cells[at + 1];
        at += 2;
        if (word === '' && value === '') continue;
        const v = printedValue(value, unit);
        v.word = word;
        v.tone = f.words[word] || '';
        block.fields[f.key] = v;
      } else if (f.kind === 'status' || f.kind === 'onoff') {
        const word = cells[at];
        at += 1;
        if (word === '') continue;
        block.fields[f.key] = { text: word, word, tone: f.words[word] || '', raw: '', num: null, unit: '' };
      } else {
        const value = cells[at];
        at += 1;
        if (value === '') continue;
        block.fields[f.key] = printedValue(value, unit);
      }
    }
    blocks.push(block);
  }
  return { blocks, units };
}
