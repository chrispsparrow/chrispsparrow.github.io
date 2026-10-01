// library.js
// The flight library. A static site can't list its own folders, so
// data/flights/index.json (the manifest) is the only way the page knows
// which flights exist. This file downloads and checks the manifest, and
// loads one flight's data files when it is opened.
//
// A broken manifest entry is skipped with a console warning and reported
// back as a "problem" so the launcher can mention it. One bad entry never
// stops the others from loading.
//
// Used by: main.js and views/launcher.js in the page, and by
// tools/add_flight.mjs and tools/check_detection.mjs in Node (they pass
// their own file reader instead of fetch). No DOM.

import { LIBRARY_BASE, MANIFEST_FILE } from './config.js';
import { parseFile } from './parser.js';

const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const KINDS = ['simulated', 'real'];

// An error that says what kind of failure it was, so the page can tell a
// dropped connection ('network') or a server hiccup ('server') apart from a
// missing or broken file on the site ('missing', 'damaged').
export class LibraryError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

// Downloads text in the browser. Node tools pass their own reader.
async function fetchText(url) {
  let response;
  try {
    response = await fetch(url, { cache: 'no-cache' });
  } catch (err) {
    // fetch only throws when the request never got an answer.
    throw new LibraryError('network', `${url} could not be reached (${err?.message ?? err})`);
  }
  if (!response.ok) {
    // 404 and 410 mean the file isn't there. Server trouble (5xx) and
    // "too many requests" (429, 408) are worth trying again.
    const status = response.status;
    const kind = status >= 500 || status === 429 || status === 408 ? 'server' : 'missing';
    throw new LibraryError(kind, `${url} answered HTTP ${response.status}`);
  }
  return response.text();
}

// The URL of one data file inside a flight's folder. Names are encoded, so
// spaces and other characters are safe.
export function flightFileUrl(flightId, file, base = LIBRARY_BASE) {
  return `${base}${encodeURIComponent(flightId)}/${encodeURIComponent(file)}`;
}

// ------------------------------------------------------------------
// Checking entries
// ------------------------------------------------------------------

const isText = (v) => typeof v === 'string' && v.trim() !== '';
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const numberOrNull = (v) => (isNumber(v) ? v : null);

// Summary shapes for the launcher's map picture and altitude line. Anything
// with the wrong shape becomes null, so the launcher just leaves that part
// out instead of breaking.
// [lat, lon], inside the range a web map can draw (Web Mercator stops at
// about 85 degrees north and south).
const pointOrNull = (v) => (Array.isArray(v) && v.length === 2 && v.every(isNumber) &&
  Math.abs(v[0]) <= 85.05 && Math.abs(v[1]) <= 180 ? [v[0], v[1]] : null);
// [[lat, lon], ...]
const pointListOrNull = (v) => (Array.isArray(v) && v.length > 0 && v.every((p) => pointOrNull(p)) ? v.map(pointOrNull) : null);
// [[seconds, meters or null], ...]. null meters marks a gap with no altitude.
const profileOrNull = (v) => (Array.isArray(v) && v.length > 0 &&
  v.every((p) => Array.isArray(p) && p.length === 2 && isNumber(p[0]) && (p[1] === null || isNumber(p[1])))
  ? v.map((p) => [p[0], p[1]]) : null);
// [index, ...] into the track list.
const indexListOrNull = (v) => (Array.isArray(v) && v.every((i) => Number.isInteger(i) && i >= 0) ? v.slice() : null);

function isSafeFileName(name) {
  return isText(name) && !/[\\/]/.test(name) && !name.startsWith('.') && !name.includes('..');
}

function isRealDate(text) {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

// Checks one manifest entry. Returns { ok: true, entry } with a cleaned-up
// copy, or { ok: false, reason } in plain words.
export function validateEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'the entry is not an object' };
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return { ok: false, reason: 'the id is missing or has characters other than letters, numbers, - and _' };
  if (!isText(raw.title)) return { ok: false, reason: 'the title is missing' };
  if (!isRealDate(raw.date)) return { ok: false, reason: 'the date is not a real YYYY-MM-DD date' };
  if (!KINDS.includes(raw.kind)) return { ok: false, reason: 'kind must be "simulated" or "real"' };
  if (!Array.isArray(raw.rockets) || raw.rockets.length === 0) return { ok: false, reason: 'the rockets list is empty' };

  const rockets = [];
  const seenIds = new Set();
  for (const [i, r] of raw.rockets.entries()) {
    if (!r || typeof r !== 'object') return { ok: false, reason: `rocket ${i + 1} is not an object` };
    if (!isText(r.rocketId)) return { ok: false, reason: `rocket ${i + 1} has no rocketId` };
    if (seenIds.has(r.rocketId)) return { ok: false, reason: `rocketId "${r.rocketId}" is listed twice` };
    if (!isText(r.name)) return { ok: false, reason: `rocket ${i + 1} has no name` };
    if (!isSafeFileName(r.file)) return { ok: false, reason: `rocket ${i + 1} has a missing or unsafe file name` };
    seenIds.add(r.rocketId);
    rockets.push({
      rocketId: r.rocketId,
      name: r.name,
      board: isText(r.board) ? r.board : null,
      file: r.file,
      // Optional: seconds added to this file's times, to line up boards
      // whose clocks started at different moments.
      timeOffsetS: numberOrNull(r.timeOffsetS) ?? 0,
    });
  }

  const summary = raw.summary && typeof raw.summary === 'object' ? raw.summary : {};
  const stringList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : null);
  return {
    ok: true,
    entry: {
      id: raw.id,
      title: raw.title.trim(),
      date: raw.date,
      kind: raw.kind,
      featured: raw.featured === true,
      description: isText(raw.description) ? raw.description.trim() : '',
      site: isText(raw.site) ? raw.site.trim() : null,
      rockets,
      summary: {
        rocketCount: numberOrNull(summary.rocketCount),
        maxAglM: numberOrNull(summary.maxAglM),
        flightDurationS: numberOrNull(summary.flightDurationS),
        sensors: stringList(summary.sensors),
        events: stringList(summary.events),
        // For the launcher's featured card (see add_flight.mjs). They all
        // describe one rocket, trackRocketId: the one that flew highest.
        trackRocketId: isText(summary.trackRocketId) ? summary.trackRocketId : null,
        track: pointListOrNull(summary.track),
        trackGaps: indexListOrNull(summary.trackGaps) ?? [],
        padPoint: pointOrNull(summary.padPoint),
        landingPoint: pointOrNull(summary.landingPoint),
        altProfile: profileOrNull(summary.altProfile),
        driftM: numberOrNull(summary.driftM),
        maxGsDistanceM: numberOrNull(summary.maxGsDistanceM),
        // Only an explicit false means a real ground station position. A
        // hand-written entry that leaves it out is treated as the demo one.
        gsDemo: summary.gsDemo !== false,
      },
    },
  };
}

// Checks a whole manifest object. Returns { flights, problems }, where
// problems lists every skipped entry and why.
export function validateManifest(manifest) {
  const problems = [];
  const flights = [];
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.flights)) {
    return { flights, problems: [{ index: null, id: null, reason: 'the file has no "flights" list' }] };
  }
  const seen = new Set();
  manifest.flights.forEach((raw, index) => {
    const checked = validateEntry(raw);
    const id = raw && typeof raw.id === 'string' ? raw.id : null;
    if (!checked.ok) {
      problems.push({ index, id, reason: checked.reason });
      return;
    }
    if (seen.has(checked.entry.id)) {
      problems.push({ index, id, reason: 'another flight already uses this id' });
      return;
    }
    seen.add(checked.entry.id);
    flights.push(checked.entry);
  });
  // Newest first. If more than one says featured, only the first one counts.
  flights.sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  let featuredSeen = false;
  for (const f of flights) {
    if (f.featured && featuredSeen) f.featured = false;
    if (f.featured) featuredSeen = true;
  }
  return { flights, problems };
}

// Downloads and checks the manifest. Never throws: a failure comes back as
// { flights: [], problems: [], error: 'why', errorKind: 'network' | 'missing' | 'damaged' }.
export async function loadManifest({ readText = fetchText, base = LIBRARY_BASE } = {}) {
  let text;
  try {
    text = await readText(`${base}${MANIFEST_FILE}`);
  } catch (err) {
    return { flights: [], problems: [], error: err?.message ?? String(err), errorKind: err?.kind ?? 'network' };
  }
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (err) {
    return { flights: [], problems: [], error: `index.json is not valid JSON (${err.message})`, errorKind: 'damaged' };
  }
  const result = validateManifest(manifest);
  // A problem with the whole file (no "flights" list) is a broken library,
  // not one hidden flight.
  const fileProblem = result.problems.find((p) => p.index === null);
  if (fileProblem) {
    console.warn(`Flight library: ${fileProblem.reason}`);
    return { flights: [], problems: [], error: fileProblem.reason, errorKind: 'damaged' };
  }
  for (const p of result.problems) {
    console.warn(`Flight library: skipped entry ${p.index + 1}${p.id ? ` ("${p.id}")` : ''}: ${p.reason}`);
  }
  return { ...result, error: null, errorKind: null };
}

// ------------------------------------------------------------------
// Loading a flight
// ------------------------------------------------------------------

// Parses each file of an entry and gives every sample the right rocket ID.
// `texts` maps file name -> file text.
//   - A file listed by ONE rocket, holding at most one board ID, belongs to
//     that rocket: every sample in it gets that rocketId, even if the board's
//     own ID differs (every board still sends node 1 today). The board's ID
//     is kept in extra.fileRocketId.
//   - A file that holds several board IDs keeps them, so two rockets are
//     never merged into one track. Each manifest rocket listing it should
//     use one of those IDs as its rocketId.
export function buildFlight(entry, texts) {
  const byFile = new Map();
  for (const r of entry.rockets) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }

  const samples = [];
  const truth = [];
  const files = [];
  let badRows = 0;
  const badRowDetails = [];
  let launchSite = null;

  for (const [file, owners] of byFile) {
    const onlyOwner = owners.length === 1 ? owners[0] : null;
    const text = texts.get(file) ?? '';
    // Board IDs actually written in the file. (A first read without a
    // default ID, so rows that carry no ID don't count as another board.)
    const idsInFile = new Set(parseFile(text, file).samples.filter((s) => s.type !== 'gs').map((s) => s.rocketId));
    const parsed = parseFile(text, file, { defaultRocketId: onlyOwner ? onlyOwner.rocketId : undefined });
    // Rename to the manifest's rocket only if the file holds one board.
    const single = onlyOwner && idsInFile.size <= 1 ? onlyOwner : null;
    if (onlyOwner && !single) {
      const note = `${file} holds ${idsInFile.size} board IDs (${[...idsInFile].join(', ')}), so each keeps its own ID instead of all becoming "${onlyOwner.rocketId}".`;
      parsed.notes.push(note);
      console.warn(`Flight library: ${note}`);
    }
    // A rocket's time offset applies to its samples. If only one rocket
    // lists the file, its offset applies to the whole file.
    const offset = (id) => (owners.find((o) => o.rocketId === id)?.timeOffsetS ?? onlyOwner?.timeOffsetS ?? 0);
    for (const s of parsed.samples) {
      if (single && s.type !== 'gs') {
        if (s.rocketId !== single.rocketId) s.extra = { ...(s.extra ?? {}), fileRocketId: s.rocketId };
        s.rocketId = single.rocketId;
      }
      if (Number.isFinite(s.t)) s.t += single ? single.timeOffsetS : offset(s.rocketId);
      samples.push(s);
    }
    for (const row of parsed.truth) {
      const rocketId = single ? single.rocketId : row.rocketId;
      truth.push({ ...row, rocketId, t: row.t + (single ? single.timeOffsetS : offset(rocketId)) });
    }
    badRows += parsed.badRows;
    for (const d of parsed.badRowDetails) badRowDetails.push({ file, ...d });
    if (parsed.meta?.launchSite && !launchSite) launchSite = parsed.meta.launchSite;
    files.push({ file, format: parsed.format, sampleCount: parsed.samples.length, badRows: parsed.badRows, ignoredLines: parsed.ignoredLines, notes: parsed.notes });
  }

  samples.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  truth.sort((a, b) => a.t - b.t);
  return { entry, samples, truth, badRows, badRowDetails, files, launchSite };
}

// Downloads every file of one manifest entry and builds the flight.
// Throws a LibraryError: kind 'network' or 'missing' if a file can't be
// downloaded, 'damaged' if it downloaded but couldn't be read.
export async function loadFlight(entry, { readText = fetchText, base = LIBRARY_BASE } = {}) {
  const texts = new Map();
  const uniqueFiles = [...new Set(entry.rockets.map((r) => r.file))];
  await Promise.all(uniqueFiles.map(async (file) => {
    try {
      texts.set(file, await readText(flightFileUrl(entry.id, file, base)));
    } catch (err) {
      throw new LibraryError(err?.kind ?? 'network', `Couldn't load ${file}: ${err?.message ?? err}`);
    }
  }));
  try {
    return buildFlight(entry, texts);
  } catch (err) {
    throw new LibraryError('damaged', `Couldn't read the flight's data: ${err?.message ?? err}`);
  }
}
