// server.mjs
// Launch mode's local web server. It serves this website from the laptop, so
// the Flight Console's launch page (flight-console/launch.html) loads at the
// field with no internet, and it keeps a copy of the flight log on disk.
//
// It only uses what comes with Node. There is nothing to install.
//
// Run it:
//   node launch-mode/server.mjs               serves http://localhost:8000
//   node launch-mode/server.mjs --port 8102   another port (the tests do this)
//   node launch-mode/server.mjs --verbose     prints a line for every request
//   node launch-mode/server.mjs --host 127.0.0.2 --port 8000
//                                             for tests only. Listens on that
//                                             one address of this laptop and
//                                             no other (see THE HOST OPTION).
//   node launch-mode/server.mjs --check       starts nothing. Says whether
//                                             launch mode is already running.
//   node launch-mode/server.mjs --check --wait 20   the same, but keeps asking
//                                             for up to 20 s until it answers.
//
// What it does:
//   - Serves the website folder. That is the folder above this file, worked
//     out from where this file is, never from the current directory.
//   - Listens on this laptop only (127.0.0.1 and ::1). Nothing else on the
//     network can reach it.
//   - Never lets the browser keep an old copy of the page's code. Only the
//     saved map tiles (offline-maps/) may be kept, for a day.
//   - GET  /launch-mode/ping         who is answering on this port
//   - POST /launch-mode/log/append   adds lines to a file in flight-logs/
//   - GET  /launch-mode/logs         the files in flight-logs/
//
// THE HOST OPTION. The map keys only work on a page whose address is
// http://localhost:8000, and a test must not take that address from the
// real server. So a test starts its own server on another address of this
// laptop (127.0.0.2, 127.0.0.3, any 127.x.x.x) with the same port, and
// tells its own Chrome that "localhost" means that address:
//   chrome --host-resolver-rules="MAP localhost 127.0.0.2"
// An address that is not on this laptop is refused. With --host the server
// takes that one address even when another program is listening on every
// address of the port, because nothing else was going to use it.
//
// Exit codes:
//   0  stopped normally, or launch mode was already running on the port
//   1  --check only: nothing is running on the port
//   2  the port is taken by something else. The server never moves to
//      another port by itself, because the page keeps its crash-recovery
//      copy per address.
//   3  a bad command line, or a start-up problem
//
// Used by: launch-mode.bat (the one-click start), launch-mode/test/cdp.mjs
// (the tests), and me from a terminal. The page's flight log
// (flight-console/js/launch/flight-log.js) talks to the three addresses above.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

const APP = 'dogtooth-launch-mode';
const VERSION = 1;
const DEFAULT_PORT = 8000;
const START_PAGE = '/flight-console/launch.html?track';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The real path, with every link followed, so the "is this inside the
// website folder" checks below compare like with like.
const ROOT = fs.realpathSync.native(path.resolve(HERE, '..'));
const LOGS_DIR = path.join(ROOT, 'flight-logs');
// The saved map tiles are in this folder of the website (see field.json).
const TILES_FOLDER = 'offline-maps';

// The biggest log append accepted in one request.
const MAX_BODY_BYTES = 4 * 1024 * 1024;
// How long (ms) a log append may take to send its body before it is dropped.
const BODY_TIMEOUT_MS = 10000;
// A log file's name: letters, numbers, dots, dashes and underscores, ending
// in .log. No folders, so nothing can be written outside flight-logs/.
const LOG_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.log$/;
// Names Windows keeps for devices. "nul.log" would write to nowhere.
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
// Files up to this size are read in one go. Bigger ones are streamed.
const READ_WHOLE_BYTES = 1024 * 1024;
// How long (ms) to wait for something on the port to accept a connection,
// and then to answer the ping. A local port accepts or refuses at once, so
// a short wait is enough to tell.
const PROBE_CONNECT_MS = 500;
const PROBE_PING_MS = 2000;
// An idle connection is kept this long (ms). The page adds to the flight
// log about once a second, so its connection stays open between appends.
const KEEP_ALIVE_MS = 120000;

const TEXT = '; charset=utf-8';
const MIME = {
  html: `text/html${TEXT}`,
  htm: `text/html${TEXT}`,
  js: `text/javascript${TEXT}`,
  mjs: `text/javascript${TEXT}`,
  css: `text/css${TEXT}`,
  json: `application/json${TEXT}`,
  map: `application/json${TEXT}`,
  geojson: `application/geo+json${TEXT}`,
  czml: `application/json${TEXT}`,
  webmanifest: `application/manifest+json${TEXT}`,
  jsonl: `application/x-ndjson${TEXT}`,
  xml: `application/xml${TEXT}`,
  svg: `image/svg+xml${TEXT}`,
  txt: `text/plain${TEXT}`,
  log: `text/plain${TEXT}`,
  glsl: `text/plain${TEXT}`,
  csv: `text/csv${TEXT}`,
  md: `text/markdown${TEXT}`,
  wasm: 'application/wasm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  ico: 'image/x-icon',
  ktx2: 'image/ktx2',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf',
  otf: 'font/otf',
  glb: 'model/gltf-binary',
  gltf: `model/gltf+json${TEXT}`,
  bin: 'application/octet-stream',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  zip: 'application/zip',
};
const MIME_OTHER = 'application/octet-stream';
const TILE_TYPES = new Set(['jpg', 'jpeg', 'png', 'webp']);

// ------------------------------------------------------------------
// Command line
// ------------------------------------------------------------------

function usage(problem) {
  if (problem) console.error(`server.mjs: ${problem}`);
  console.error('Usage: node launch-mode/server.mjs [--port N] [--host ADDRESS] [--verbose] [--check [--wait SECONDS]]');
  process.exit(3);
}

// True for an address that only this laptop can reach: 127.x.x.x or ::1.
function isLoopback(address) {
  const kind = net.isIP(address);
  if (kind === 4) return address.split('.')[0] === '127';
  if (kind === 6) return address === '::1';
  return false;
}

function readArgs(argv) {
  // host is null for the normal case: both 127.0.0.1 and ::1.
  const args = { port: DEFAULT_PORT, host: null, verbose: false, check: false, wait: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--host') {
      const value = String(argv[i + 1] ?? '').trim().replace(/^\[(.*)\]$/, '$1');
      i += 1;
      if (value === '' || value.startsWith('--')) usage('--host needs an address, such as 127.0.0.2');
      // "localhost" is the normal case, spelled out.
      if (value.toLowerCase() === 'localhost') {
        args.host = null;
      } else if (isLoopback(value)) {
        args.host = value;
      } else {
        usage(`--host only takes an address of this laptop (127.x.x.x or ::1), not ${value}. The server never listens where the network can reach it.`);
      }
    } else if (arg === '--port' || arg === '--wait') {
      const value = Number(argv[i + 1]);
      i += 1;
      if (arg === '--port') {
        if (!Number.isInteger(value) || value < 1 || value > 65535) usage('--port needs a number from 1 to 65535');
        args.port = value;
      } else {
        if (!Number.isFinite(value) || value < 0) usage('--wait needs a number of seconds');
        args.wait = value;
      }
    } else if (arg === '--verbose') {
      args.verbose = true;
    } else if (arg === '--check') {
      args.check = true;
    } else if (arg === '--help' || arg === '-h') {
      usage();
    } else {
      usage(`I don't know the option ${arg}`);
    }
  }
  return args;
}

const ARGS = readArgs(process.argv.slice(2));
const PORT = ARGS.port;

// The addresses listened on, and the name a browser sends for each.
const nameOf = (address) => (net.isIP(address) === 6 ? `[${address}]` : address);
const ADDRESSES = ARGS.host ? [ARGS.host] : ['127.0.0.1', '::1'];

// The only names this server answers to, and the only pages allowed to add
// to the flight log. "localhost" stays in the list with --host, because the
// test's Chrome still calls this server localhost.
const HOST_NAMES = [...new Set(['localhost', '127.0.0.1', '[::1]', ...ADDRESSES.map(nameOf)])];
const ALLOWED_HOSTS = new Set(HOST_NAMES.map((name) => `${name}:${PORT}`));
if (PORT === 80) for (const name of HOST_NAMES) ALLOWED_HOSTS.add(name);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((host) => `http://${host}`));

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

function clock() {
  return new Date().toTimeString().slice(0, 8);
}

function logProblem(what, err) {
  console.error(`[${clock()}] ${what}${err ? `: ${err.stack || err.message || err}` : ''}`);
}

function samePath(a, b) {
  const clean = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '');
  return process.platform === 'win32'
    ? clean(a).toLowerCase() === clean(b).toLowerCase()
    : clean(a) === clean(b);
}

function send(res, status, headers, body) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const data = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    ...headers,
    'Content-Length': data ? data.length : 0,
  });
  res.end(res.req.method === 'HEAD' ? undefined : data ?? undefined);
}

function sendText(res, status, text, headers = {}) {
  send(res, status, { 'Content-Type': MIME.txt, ...headers }, `${text}\n`);
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, { 'Content-Type': MIME.json, ...headers }, `${JSON.stringify(value)}\n`);
}

// ------------------------------------------------------------------
// The website's files
// ------------------------------------------------------------------

// One piece of a path. Refused: anything starting with a dot (.git,
// .claude, and ".." which would climb out of the folder), and the spellings
// Windows quietly turns into another file (a colon, a dot or space at the
// end, a device name).
function safeSegment(segment) {
  if (segment.startsWith('.')) return false;
  if (/[:*?"<>|]/.test(segment)) return false;
  if (/[. ]$/.test(segment)) return false;
  if (WINDOWS_DEVICE.test(segment.split('.')[0])) return false;
  return true;
}

function insideRoot(file) {
  return file === ROOT || file.startsWith(ROOT + path.sep);
}

// "bytes=0-99", "bytes=100-" or "bytes=-100" for a file of the given size.
// Returns { start, end }, null for no usable range (the whole file is
// sent), or false for a range past the end of the file.
function readRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const last = Number(m[2]);
    if (last === 0) return false;
    start = Math.max(0, size - last);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return false;
  return { start, end };
}

async function serveFile(req, res, rawPath, search) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return sendText(res, 400, 'That address is not valid.');
  }
  if (decoded.includes('\0')) return sendText(res, 400, 'That address is not valid.');
  const parts = decoded.split(/[\\/]+/).filter(Boolean);
  if (!parts.every(safeSegment)) return sendText(res, 403, 'Not allowed.');
  const asked = path.join(ROOT, ...parts);
  if (!insideRoot(asked)) return sendText(res, 403, 'Not allowed.');

  // The real path is checked too. That catches a link that points out of
  // the website folder, and Windows short names (GIT~1 for .git).
  let file;
  let stat;
  try {
    file = await fsp.realpath(asked);
    if (!insideRoot(file)) return sendText(res, 403, 'Not allowed.');
    if (!path.relative(ROOT, file).split(path.sep).filter(Boolean).every(safeSegment)) {
      return sendText(res, 403, 'Not allowed.');
    }
    stat = await fsp.stat(file);
    if (stat.isDirectory()) {
      // A folder's address needs its closing slash, or the page's own
      // links (css/..., js/...) would point one folder too high.
      if (!/[\\/]$/.test(decoded)) {
        const there = `/${parts.map(encodeURIComponent).join('/')}/${search}`;
        return send(res, 301, { Location: there });
      }
      file = path.join(file, 'index.html');
      stat = await fsp.stat(file);
    } else if (/[\\/]$/.test(decoded)) {
      // A file's address has no closing slash.
      return sendText(res, 404, 'Not found.');
    }
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') logProblem(`Could not look up ${rawPath}`, err);
    return sendText(res, 404, 'Not found.');
  }
  if (!stat.isFile()) return sendText(res, 404, 'Not found.');

  const ext = path.extname(file).slice(1).toLowerCase();
  const top = path.relative(ROOT, file).split(path.sep)[0].toLowerCase();
  const isTile = top === TILES_FOLDER && TILE_TYPES.has(ext);
  const headers = {
    'Content-Type': MIME[ext] ?? MIME_OTHER,
    // The code and the data are never kept by the browser, so a reload
    // always shows what is on disk. The saved map tiles don't change.
    'Cache-Control': isTile ? 'public, max-age=86400' : 'no-store',
    'Last-Modified': stat.mtime.toUTCString(),
    'Accept-Ranges': 'bytes',
  };

  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (req.headers.range && stat.size > 0) {
    const range = readRange(req.headers.range, stat.size);
    if (range === false) {
      return send(res, 416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
    }
    if (range) {
      ({ start, end } = range);
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
  }
  const length = stat.size === 0 ? 0 : end - start + 1;

  if (req.method === 'HEAD' || length === 0) {
    res.writeHead(status, { ...headers, 'Content-Length': length });
    return res.end();
  }
  if (status === 200 && length <= READ_WHOLE_BYTES) {
    let data;
    try {
      data = await fsp.readFile(file);
    } catch (err) {
      if (err.code !== 'ENOENT') logProblem(`Could not read ${rawPath}`, err);
      return sendText(res, 404, 'Not found.');
    }
    res.writeHead(200, { ...headers, 'Content-Length': data.length });
    return res.end(data);
  }
  // start and end are always given, so a file that is still growing (a
  // flight log) is sent at the size its header promised.
  res.writeHead(status, { ...headers, 'Content-Length': length });
  pipeline(fs.createReadStream(file, { start, end }), res, (err) => {
    // The browser closing the connection early (a video seek, a closed tab)
    // is normal and is not logged.
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE' && err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
      logProblem(`Could not finish sending ${rawPath}`, err);
    }
  });
  return undefined;
}

// ------------------------------------------------------------------
// The flight log copy
// ------------------------------------------------------------------

function pingInfo() {
  return { app: APP, version: VERSION, root: ROOT, port: PORT, logsDir: LOGS_DIR, pid: process.pid, addresses: ADDRESSES };
}

// Collects a request's body. Rejects with .status set when it is too big
// or too slow.
function readBody(req, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    const problem = (status, message) => Object.assign(new Error(message), { status });
    const timer = setTimeout(() => finish(problem(408, 'The log lines took too long to arrive.')), timeoutMs);
    const tooBig = () => problem(413, `That is more than ${maxBytes} bytes in one request.`);
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) {
        chunks.push(chunk);
        return;
      }
      // Too big. The rest is read and dropped, so the sender gets to see
      // the answer. Far too big, and the answer goes out at once.
      chunks.length = 0;
      if (size > maxBytes * 8) finish(tooBig());
    });
    req.on('end', () => (size > maxBytes ? finish(tooBig()) : finish(null, Buffer.concat(chunks))));
    req.on('aborted', () => finish(problem(400, 'The request was cut off.')));
    req.on('error', (err) => finish(problem(400, `The request failed: ${err.message}`)));
  });
}

// The bytes are on disk before this returns: opened to append, written,
// flushed (fsync), closed. Returns the file's size afterward.
async function appendToLog(name, data) {
  await fsp.mkdir(LOGS_DIR, { recursive: true });
  const handle = await fsp.open(path.join(LOGS_DIR, name), 'a');
  try {
    if (data.length) await handle.appendFile(data);
    await handle.sync();
    return (await handle.stat()).size;
  } finally {
    await handle.close();
  }
}

// One line of appends per file name. A request takes its place in the line
// the moment it arrives, so two appends to one file land in arrival order
// even if the second one's body finishes first.
const appendLines = new Map();

async function handleAppend(req, res, query) {
  const refuse = (status, error) => {
    // The rest of a refused request is not read, so the connection is closed.
    sendJson(res, status, { ok: false, error }, { Connection: 'close' });
    req.resume();
  };
  // Only this server's own pages may write. Another website open in the
  // browser sends its own Origin, and is refused.
  const origin = req.headers.origin;
  if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) {
    return refuse(403, 'Only the launch page on this laptop can add to the flight log.');
  }
  if (req.headers.host === undefined) return refuse(403, 'The request has no Host header.');
  const name = query.get('name') ?? '';
  if (!LOG_NAME.test(name) || WINDOWS_DEVICE.test(name.split('.')[0])) {
    return refuse(400, 'The name must be letters, numbers, dots, dashes or underscores, and end in .log.');
  }

  const body = readBody(req, MAX_BODY_BYTES, BODY_TIMEOUT_MS);
  body.catch(() => {}); // handled in turn below
  const before = appendLines.get(name) ?? Promise.resolve();
  const mine = before.then(async () => appendToLog(name, await body));
  const settled = mine.then(() => {}, () => {});
  appendLines.set(name, settled);
  settled.then(() => {
    if (appendLines.get(name) === settled) appendLines.delete(name);
  });

  try {
    const bytes = await mine;
    return sendJson(res, 200, { ok: true, name, bytes });
  } catch (err) {
    if (err.status) return refuse(err.status, err.message);
    logProblem(`Could not add to flight-logs/${name}`, err);
    return sendJson(res, 500, { ok: false, error: `The log file could not be written: ${err.message}` });
  }
}

async function listLogs() {
  let names;
  try {
    names = await fsp.readdir(LOGS_DIR);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const logs = [];
  for (const name of names) {
    if (!LOG_NAME.test(name)) continue;
    try {
      const stat = await fsp.stat(path.join(LOGS_DIR, name));
      if (stat.isFile()) logs.push({ name, bytes: stat.size, modified: stat.mtime.toISOString() });
    } catch {
      // Deleted between the listing and the look. Left out.
    }
  }
  // Newest first.
  logs.sort((a, b) => (a.modified < b.modified ? 1 : a.modified > b.modified ? -1 : a.name.localeCompare(b.name)));
  return logs;
}

// ------------------------------------------------------------------
// Every request
// ------------------------------------------------------------------

async function handle(req, res) {
  // Answer only when asked by a local name. A page on another site that
  // points its own name at 127.0.0.1 arrives with that other name.
  const host = req.headers.host;
  if (host !== undefined && !ALLOWED_HOSTS.has(host.toLowerCase())) {
    return sendText(res, 403, 'This server only answers on localhost.', { Connection: 'close' });
  }
  const raw = String(req.url ?? '/');
  const cut = raw.search(/[?#]/);
  const rawPath = cut < 0 ? raw : raw.slice(0, cut);
  const search = cut < 0 || raw[cut] !== '?' ? '' : raw.slice(cut).split('#')[0];
  const reading = req.method === 'GET' || req.method === 'HEAD';

  if (rawPath === '/launch-mode/log/append') {
    if (req.method !== 'POST') return sendText(res, 405, 'Use POST to add to the flight log.', { Allow: 'POST' });
    return handleAppend(req, res, new URLSearchParams(search));
  }
  if (!reading) {
    req.resume();
    return sendText(res, 405, 'This server only answers GET and HEAD here.', { Allow: 'GET, HEAD', Connection: 'close' });
  }
  if (rawPath === '/launch-mode/ping') return sendJson(res, 200, pingInfo());
  if (rawPath === '/launch-mode/logs') return sendJson(res, 200, { logs: await listLogs() });
  if (!rawPath.startsWith('/')) return sendText(res, 400, 'That address is not valid.');
  return serveFile(req, res, rawPath, search);
}

function onRequest(req, res) {
  const began = Date.now();
  if (ARGS.verbose) {
    res.on('finish', () => {
      console.log(`[${clock()}] ${res.statusCode} ${req.method} ${req.url} ${Date.now() - began} ms`);
    });
  }
  // One bad request must never take the server down.
  handle(req, res).catch((err) => {
    logProblem(`${req.method} ${req.url} failed`, err);
    try {
      sendText(res, 500, 'The server hit a problem with that request.');
    } catch {
      res.destroy();
    }
  });
}

// ------------------------------------------------------------------
// Who is on the port already
// ------------------------------------------------------------------

function canConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (ok) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

// Asks whatever is listening who it is. Resolves the ping's answer when it
// is launch mode, or null. (node:http and not fetch(): on Windows, Node can
// crash on the way out when a script exits just after a fetch.)
function askPing(address, hostName, port) {
  return new Promise((resolve) => {
    let text = '';
    const finish = (info) => {
      clearTimeout(timer);
      req.destroy();
      resolve(info && info.app === APP ? info : null);
    };
    const req = http.get({
      host: address,
      port,
      path: '/launch-mode/ping',
      agent: false,
      headers: { Host: `${hostName}:${port}` },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        text += chunk;
        if (text.length > 10000) finish(null);
      });
      res.on('end', () => {
        try {
          finish(res.statusCode === 200 ? JSON.parse(text) : null);
        } catch {
          finish(null);
        }
      });
      res.on('error', () => finish(null));
    });
    const timer = setTimeout(() => finish(null), PROBE_PING_MS);
    req.on('error', () => finish(null));
  });
}

// Looks at the addresses this server listens on. Returns one of:
//   { state: 'free' }                    nothing is listening
//   { state: 'running', info }           launch mode, serving this folder
//   { state: 'other-folder', info }      launch mode, serving another folder
//   { state: 'taken' }                   something that is not launch mode
async function lookAtPort(port) {
  const sides = await Promise.all(ADDRESSES.map(async (address) => {
    if (!(await canConnect(address, port, PROBE_CONNECT_MS))) return { state: 'free' };
    const info = await askPing(address, nameOf(address), port);
    if (!info) return { state: 'taken' };
    return { state: samePath(info.root, ROOT) ? 'running' : 'other-folder', info };
  }));
  for (const state of ['taken', 'other-folder', 'running']) {
    const side = sides.find((s) => s.state === state);
    if (side) return side;
  }
  return { state: 'free' };
}

// Prints what was found on a port that is not free, and returns the exit code.
function reportPort(found, port) {
  // With --host the messages name the address too.
  const where = ARGS.host ? `${nameOf(ARGS.host)} port ${port}` : `port ${port}`;
  const capital = (text) => text[0].toUpperCase() + text.slice(1);
  if (found.state === 'running') {
    console.log(`Launch mode is already running on ${where}.`);
    console.log(`Open http://${ARGS.host ? nameOf(ARGS.host) : 'localhost'}:${port}${START_PAGE}`);
    return 0;
  }
  if (found.state === 'other-folder') {
    console.error(`${capital(where)} is taken by a launch mode server started from another folder:`);
    console.error(`  ${found.info.root}`);
    console.error(`This one serves ${ROOT}`);
    console.error('Close the other server window, then start this again.');
    return 2;
  }
  console.error(`${capital(where)} is taken by another program, so launch mode cannot start.`);
  console.error(`Close whatever is using port ${port}, then start this again.`);
  console.error('Launch mode always uses the same port, because the page keeps its crash-recovery copy per address.');
  return 2;
}

// ------------------------------------------------------------------
// Start-up
// ------------------------------------------------------------------

function listen(address, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(onRequest);
    server.keepAliveTimeout = KEEP_ALIVE_MS;
    // A broken request gets a short answer instead of an error event.
    server.on('clientError', (err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    });
    server.once('error', reject);
    server.listen({ host: address, port }, () => {
      server.off('error', reject);
      server.on('error', (err) => logProblem('The server reported a problem', err));
      resolve(server);
    });
  });
}

async function check() {
  const deadline = Date.now() + ARGS.wait * 1000;
  for (;;) {
    const found = await lookAtPort(PORT);
    if (found.state !== 'free') return reportPort(found, PORT);
    if (Date.now() >= deadline) {
      console.log(`Launch mode is not running on ${ARGS.host ? `${nameOf(ARGS.host)} ` : ''}port ${PORT}.`);
      return 1;
    }
    await new Promise((resolve) => { setTimeout(resolve, 250); });
  }
}

async function start() {
  // Normally anything that answers on the port counts as taken, even a
  // program listening on every address. Windows would let this server take
  // 127.0.0.1 from under it, and then the address would quietly show
  // another site. With --host the caller asked for that one address, so
  // the server just tries to take it.
  if (!ARGS.host) {
    const found = await lookAtPort(PORT);
    if (found.state !== 'free') return reportPort(found, PORT);
  }

  const servers = [];
  let ipv6Problem = null;
  for (const address of ADDRESSES) {
    try {
      servers.push(await listen(address, PORT));
    } catch (err) {
      if (!ARGS.host && address === '::1' && err.code !== 'EADDRINUSE' && err.code !== 'EACCES') {
        // No IPv6 on this laptop. 127.0.0.1 alone still works.
        ipv6Problem = err;
        continue;
      }
      for (const server of servers) server.close();
      if (err.code === 'EADDRINUSE') {
        // Something took the port between the look and now.
        const again = await lookAtPort(PORT);
        return reportPort(again.state === 'free' ? { state: 'taken' } : again, PORT);
      }
      console.error(`The server could not listen on ${address} port ${PORT}: ${err.message}`);
      if (err.code === 'EACCES') console.error(`Windows is keeping port ${PORT} for itself right now. Restarting the laptop usually frees it.`);
      return 3;
    }
  }

  console.log('Launch mode is running.');
  console.log('');
  if (ARGS.host) {
    console.log(`This is a test server. It listens on ${ARGS.host} only.`);
    console.log('Open this address:');
    console.log(`  http://${nameOf(ARGS.host)}:${PORT}${START_PAGE}`);
    console.log(`Or start Chrome with --host-resolver-rules="MAP localhost ${nameOf(ARGS.host)}" and open:`);
    console.log(`  http://localhost:${PORT}${START_PAGE}`);
  } else {
    console.log('Open this address in Chrome:');
    console.log(`  http://localhost:${PORT}${START_PAGE}`);
  }
  console.log('');
  console.log('Flight logs are saved in:');
  console.log(`  ${LOGS_DIR}`);
  console.log('');
  console.log('Keep this window open during the flight. While it is closed, the page cannot save to flight-logs or reload.');
  console.log('To stop the server after the flight, press Ctrl+C or close this window.');
  if (ipv6Problem) {
    console.log('');
    console.log(`Note: the server could not listen on ::1 (${ipv6Problem.code || ipv6Problem.message}).`);
    console.log('It answers on 127.0.0.1 only. The address above still works, but connecting can be a little slower.');
  }
  if (ARGS.verbose) console.log('');

  const stop = () => {
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGBREAK', stop);
  return null; // still running
}

// Whatever goes wrong while it runs, the server logs it and carries on.
process.on('uncaughtException', (err) => logProblem('Something went wrong, and the server is carrying on', err));
process.on('unhandledRejection', (err) => logProblem('Something went wrong, and the server is carrying on', err));

const code = await (ARGS.check ? check() : start()).catch((err) => {
  console.error(`The server could not start: ${err.stack || err.message}`);
  return 3;
});
// Not serving: nothing is left open, so Node ends by itself with this code.
if (code !== null) process.exitCode = code;
