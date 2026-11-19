// cdp.mjs
// The test rig for launch mode. It starts launch-mode/server.mjs on a test
// port, starts a real Chrome with the internet blocked (or open, or up but
// dead), and drives a page through the Chrome DevTools Protocol. It lists
// every request the page made, so a test can prove that nothing was asked
// of the internet.
//
// It only uses what comes with Node 24 (WebSocket, child_process, http).
// There is nothing to install. Playwright and Puppeteer are not used.
//
// A whole test:
//
//   import { startServer, launchChrome } from './cdp.mjs';   // or the path from your file
//
//   const server = await startServer({ port: 8102 });        // never 8000, that one is real
//   const browser = await launchChrome({ network: 'blocked' });
//   try {
//     const page = await browser.newPage();
//     await page.goto(server.url('/flight-console/launch.html?track'));
//     await page.waitFor(() => window.fcStarted === true, { message: 'the console did not start' });
//     const title = await page.evaluate(() => document.title);
//     const sum = await page.evaluate((a, b) => a + b, 2, 3);        // arguments are sent as JSON
//     await page.click('#some-button');
//     await page.type('#some-input', '44.825278', { clear: true });
//     await page.screenshot('C:/some/folder/shot.png');
//     console.log(page.externalRequests());    // must be [] on the launch page
//     console.log(page.exceptions(), page.consoleErrors());
//   } finally {
//     await browser.close();                   // ends only this Chrome
//     await server.stop();                     // ends only this server
//   }
//
// THE THREE NETWORKS (launchChrome's network option)
//   'blocked'  every host but this laptop fails at once, like Wi-Fi off.
//              This is the default.
//   'tarpit'   every host but this laptop connects and then never answers,
//              like a phone hotspot with no signal. A page that waits on
//              the internet shows up here as a slow start.
//              browser.tarpit.connections() lists what tried to connect.
//   'open'     the real internet.
//   Chrome is started with --no-proxy-server, as launch-mode.bat starts
//   it. A plain Chrome first looks for a proxy (WPAD), and in 'tarpit'
//   that held every page, even localhost, for 30 s. systemProxy: true
//   leaves that look-up on.
//
// A TEST THAT NEEDS http://localhost:8000 (the map keys only work there)
//   127.0.0.1 port 8000 belongs to the real server, so the test's server
//   takes another address of this laptop, and the test's Chrome is told
//   that "localhost" means that address:
//
//   const server = await startServer({ port: 8000, host: '127.0.0.2' });   // or 127.0.0.3, ...
//   const browser = await launchChrome({ network: 'open', args: server.chromeArgs });
//   await page.goto(server.url('/flight-console/launch.html?track'));      // http://localhost:8000/...
//
//   server.chromeArgs is ['--host-resolver-rules=MAP localhost 127.0.0.2'].
//   It works with 'blocked' and 'tarpit' too: your own --host-resolver-rules
//   in args is put in front of the network's rules, in one switch. From
//   Node, ask that server at server.direct (http://127.0.0.2:8000), because
//   Node's "localhost" is still the real one.
//
// WHAT THERE IS
//   startServer({ port, host, verbose, timeout })
//     -> { port, host, origin, url(path), direct, directUrl(path), hostRule,
//          chromeArgs, pid, owned, info, output(), stop() }
//     If launch mode already answers on that port from this folder, it is
//     used as it is (owned is false, and stop() leaves it running).
//   launchChrome({ headless, network, userDataDir, args, windowSize, systemProxy, timeout })
//     -> browser: newPage(options), pages(), close(), kill(), send(method, params),
//                 pid, userDataDir, version, network, hostRules, tarpit
//     Give userDataDir to keep the profile, so a test can close Chrome and
//     open it again on the same storage. That folder is never deleted
//     here. Without it a temporary profile is made, and close() removes it.
//     kill() ends Chrome with no goodbye, like a crash.
//   page: goto(url, { waitUntil: 'load' | 'domcontentloaded' | 'none', timeout })
//         reload({ waitUntil, timeout })
//         evaluate(functionOrSource, ...args)   awaits promises, returns plain values,
//                                               throws the page's own error message
//         waitFor(functionOrSource, { timeout, interval, message, args })
//         click(selector, { force })   a real mouse click in the middle of the element
//         type(selector, text, { clear })
//         press(key)                   'Enter', 'Tab', 'Escape', an arrow, or one character
//         setFiles(selector, [paths])  for an <input type="file">
//         screenshot(path, { clip: { x, y, width, height }, fullPage })
//         requests()           every request: { url, method, resourceType, status, fromCache,
//                              failed, errorText, ms, pending, target, startedAt }
//         externalRequests()   the ones not to localhost, 127.0.0.1 or [::1]
//                              (data:, blob:, about: and chrome: addresses are left out)
//         consoleMessages()    { type, text, source, url, line, target }
//         consoleErrors()      the ones with type 'error'
//         exceptions()         { text, url, line, column, target }
//         dialogs()            alert, confirm and prompt boxes (each one is accepted for you)
//         send(method, params) any other DevTools Protocol command
//         close()
//
// GOOD TO KNOW
//   - Requests from workers, service workers and frames are in requests()
//     too. target says where each one came from. Cesium fetches from workers.
//   - A <link rel="preconnect"> opens a connection without a request, so
//     it is not in requests(). In 'tarpit' it is in browser.tarpit.connections().
//   - Everything has a timeout, so a stuck check fails with a message
//     instead of hanging.
//   - kill() is a real crash for storage too. Measured with Chrome 157: an
//     IndexedDB write whose transaction had completed was always there
//     after reopening, even 0.2 s after it. A localStorage write made 1.5 s
//     before kill() was lost, and one made 5 s before was kept.
//   - A test that throws, or is stopped with Ctrl+C, ends its Chromes and
//     servers on the way out. If Node is killed from outside (a timeout,
//     Task Manager) a headless Chrome can be left behind. This removes the
//     ones whose test is gone:
//       node launch-mode/test/cdp.mjs --clean
//
// Used by: launch-mode/test/smoke.mjs and the other launch mode checks.
// Nothing on the website imports it.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The website folder, two folders up from launch-mode/test/.
export const ROOT = path.resolve(HERE, '..', '..');
const SERVER_SCRIPT = path.join(ROOT, 'launch-mode', 'server.mjs');
const APP = 'dogtooth-launch-mode';

// Temporary profiles are named fc-launch-chrome-<this Node's process ID>-<random>,
// so --clean can tell whose test a leftover Chrome belonged to.
const PROFILE_PREFIX = 'fc-launch-chrome-';

const CHROME_PLACES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
].filter(Boolean);

// Hosts that count as this laptop.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// Addresses that are not network requests at all.
const NOT_NETWORK = /^(data|blob|about|chrome|chrome-extension|chrome-untrusted|devtools|javascript):/i;

const DEFAULT_TIMEOUT_MS = 30000;

export const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ------------------------------------------------------------------
// Ending what this file started, and nothing else
// ------------------------------------------------------------------

// Ends one process and everything it started.
function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Whatever is still running when Node ends is ended with it, so a test
// that throws does not leave a Chrome or a server behind.
const stillRunning = new Set();
const endAll = () => {
  for (const pid of [...stillRunning]) killTree(pid);
  stillRunning.clear();
};
process.on('exit', endAll);
// Ctrl+C (or a closed terminal) ends Node without an 'exit' event, so the
// same is done then. When the test has its own handler for the signal, it
// decides when Node ends. Otherwise Node ends here, as it would have anyway.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
  process.on(signal, function onSignal() {
    endAll();
    if (process.listeners(signal).every((fn) => fn === onSignal)) process.exit(130);
  });
}

async function removeFolder(dir) {
  // Chrome lets go of its files a moment after it ends, so this retries.
  try {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  } catch (err) {
    console.error(`cdp.mjs: could not remove ${dir}: ${err.message}`);
  }
}

// ------------------------------------------------------------------
// The server
// ------------------------------------------------------------------

// GET a small JSON answer from this laptop. Resolves null when nothing
// usable comes back. (node:http and not fetch(): on Windows, Node can crash
// on the way out when a script exits just after a fetch.)
function getJson(port, urlPath, timeoutMs = 2000, address = '127.0.0.1') {
  return new Promise((resolve) => {
    let text = '';
    const finish = (value) => {
      clearTimeout(timer);
      req.destroy();
      resolve(value);
    };
    const req = http.get({
      host: address,
      port,
      path: urlPath,
      agent: false,
      headers: { Host: `localhost:${port}` },
    }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        try {
          finish(res.statusCode === 200 ? JSON.parse(text) : null);
        } catch {
          finish(null);
        }
      });
      res.on('error', () => finish(null));
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    req.on('error', () => finish(null));
  });
}

function samePath(a, b) {
  const clean = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  try {
    return clean(fs.realpathSync.native(a)) === clean(fs.realpathSync.native(b));
  } catch {
    return clean(a) === clean(b);
  }
}

export async function startServer({ port, host = null, verbose = false, timeout = 10000 } = {}) {
  if (!Number.isInteger(port)) throw new Error('startServer needs a port, for example { port: 8102 }. Never 8000 by itself: that is the real one.');
  // host is one address of this laptop, such as '127.0.0.2'. Without it the
  // server listens on 127.0.0.1 and ::1, as it does at the field.
  const address = host ? String(host).replace(/^\[(.*)\]$/, '$1') : null;
  if (address && !(net.isIP(address) === 4 ? address.startsWith('127.') : address === '::1')) {
    throw new Error(`startServer: host must be an address of this laptop (127.x.x.x or ::1), not ${JSON.stringify(host)}`);
  }
  const pingAt = address ?? '127.0.0.1';
  const hostName = address && net.isIP(address) === 6 ? `[${address}]` : address;
  const args = [SERVER_SCRIPT, '--port', String(port)];
  if (address) args.push('--host', address);
  if (verbose) args.push('--verbose');
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  stillRunning.add(child.pid);
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  let exitCode = null;
  const exited = new Promise((resolve) => {
    child.on('exit', (code) => {
      exitCode = code ?? -1;
      stillRunning.delete(child.pid);
      resolve();
    });
  });

  const where = address ? `${hostName} port ${port}` : `port ${port}`;
  const deadline = Date.now() + timeout;
  let info = null;
  for (;;) {
    info = await getJson(port, '/launch-mode/ping', 1000, pingAt);
    if (info && info.app === APP) break;
    if (exitCode !== null && exitCode !== 0) {
      throw new Error(`The server did not start on ${where} (exit code ${exitCode}).\n${output.trim()}`);
    }
    if (Date.now() > deadline) {
      if (exitCode === null) killTree(child.pid);
      throw new Error(`The server did not answer on ${where} within ${timeout} ms.\n${output.trim()}`);
    }
    await sleep(100);
  }
  if (!samePath(info.root, ROOT)) {
    // Ours has ended by itself (exit code 2) or is about to. A process ID
    // is only ended while it is still ours.
    if (exitCode === null) killTree(child.pid);
    throw new Error(`${where[0].toUpperCase()}${where.slice(1)} is answered by a launch mode server from another folder: ${info.root}`);
  }
  // A server that was already there answers the ping, and ours has exited
  // with code 0. It is used, and left running afterward.
  const owned = info.pid === child.pid;
  // What a page calls the server. With a host, that is only true in a
  // Chrome started with hostRule (see the top of this file).
  const origin = `http://localhost:${port}`;
  // The server's real address, for asking it things from Node.
  const direct = `http://${hostName ?? '127.0.0.1'}:${port}`;
  const join = (base, urlPath) => base + (urlPath.startsWith('/') ? urlPath : `/${urlPath}`);
  return {
    port,
    host: address,
    origin,
    direct,
    // The rule that makes "localhost" mean this server in Chrome, or '' when
    // it already does.
    hostRule: address ? `MAP localhost ${hostName}` : '',
    // The same, ready to spread into launchChrome's args.
    chromeArgs: address ? [`--host-resolver-rules=MAP localhost ${hostName}`] : [],
    pid: info.pid,
    owned,
    info,
    url: (urlPath = '/') => join(origin, urlPath),
    directUrl: (urlPath = '/') => join(direct, urlPath),
    output: () => output,
    async stop() {
      if (!owned || exitCode !== null) return;
      child.kill();
      await Promise.race([exited, sleep(3000)]);
      if (exitCode === null) killTree(child.pid);
      await Promise.race([exited, sleep(2000)]);
    },
  };
}

// ------------------------------------------------------------------
// The tarpit: a connection that is up but dead
// ------------------------------------------------------------------

// Reads the host name out of the first bytes a browser sends: the server
// name in a TLS hello, or the Host line of plain HTTP. Returns null when
// it is not there (yet).
function sniffHost(buf) {
  if (buf.length >= 5 && buf[0] === 0x16 && buf[1] === 0x03) {
    try {
      let at = 5;                       // the record header
      if (buf[at] !== 0x01) return null; // not a hello
      at += 4;                          // type and length
      at += 2 + 32;                     // version and random
      at += 1 + buf[at];                // session ID
      at += 2 + buf.readUInt16BE(at);   // cipher suites
      at += 1 + buf[at];                // compression
      const end = at + 2 + buf.readUInt16BE(at);
      at += 2;
      while (at + 4 <= end && at + 4 <= buf.length) {
        const type = buf.readUInt16BE(at);
        const size = buf.readUInt16BE(at + 2);
        if (type === 0) {
          const nameSize = buf.readUInt16BE(at + 7);
          const name = buf.subarray(at + 9, at + 9 + nameSize);
          return name.length === nameSize ? name.toString('latin1') : null;
        }
        at += 4 + size;
      }
    } catch {
      return null; // the hello has not all arrived
    }
    return null;
  }
  const m = /\r\nHost: *([^\r\n]+)/i.exec(buf.toString('latin1'));
  return m ? m[1].trim() : null;
}

// A server that accepts every connection and never says anything.
function startTarpit() {
  return new Promise((resolve, reject) => {
    const sockets = new Set();
    const seen = [];
    const server = net.createServer((socket) => {
      const record = { host: null, at: Date.now() };
      seen.push(record);
      sockets.add(socket);
      let got = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        if (record.host || got.length > 32768) return;
        got = Buffer.concat([got, chunk]);
        record.host = sniffHost(got);
      });
      socket.on('error', () => {});
      socket.on('close', () => sockets.delete(socket));
    });
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      resolve({
        port: server.address().port,
        // Every connection made so far: { host, at }. host is null when
        // the browser hung up before saying who it wanted.
        connections: () => seen.map((record) => ({ ...record })),
        stop: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}

// ------------------------------------------------------------------
// The DevTools Protocol connection
// ------------------------------------------------------------------

// One WebSocket to the browser. Every page, frame and worker is a session
// on it (flat mode), told apart by sessionId.
function connect(wsUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();   // id -> { resolve, reject, timer, method }
    const listeners = new Set(); // fn(method, params, sessionId)
    let nextId = 1;
    let closed = false;
    let opened = false;

    const openTimer = setTimeout(() => {
      if (opened) return;
      try { ws.close(); } catch { /* never opened */ }
      reject(new Error(`Chrome's DevTools connection did not open within ${timeoutMs} ms (${wsUrl})`));
    }, timeoutMs);

    const failAll = (why) => {
      closed = true;
      for (const [, call] of pending) {
        clearTimeout(call.timer);
        call.reject(new Error(`${call.method}: ${why}`));
      }
      pending.clear();
    };

    const connection = {
      get closed() { return closed; },
      // Sends one command. Rejects with Chrome's message, or on a timeout.
      send(method, params = {}, { sessionId, timeout = DEFAULT_TIMEOUT_MS } = {}) {
        if (closed) return Promise.reject(new Error(`${method}: Chrome is closed`));
        const id = nextId;
        nextId += 1;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`${method} got no answer from Chrome within ${timeout} ms`));
          }, timeout);
          pending.set(id, { resolve: res, reject: rej, timer, method });
          const message = { id, method, params };
          if (sessionId) message.sessionId = sessionId;
          try {
            ws.send(JSON.stringify(message));
          } catch (err) {
            clearTimeout(timer);
            pending.delete(id);
            rej(new Error(`${method}: could not be sent (${err.message})`));
          }
        });
      },
      on(fn) {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
      close() {
        if (!closed) failAll('Chrome was closed');
        try { ws.close(); } catch { /* already closed */ }
      },
    };

    ws.addEventListener('open', () => {
      opened = true;
      clearTimeout(openTimer);
      resolve(connection);
    });
    ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const call = pending.get(message.id);
        if (!call) return;
        pending.delete(message.id);
        clearTimeout(call.timer);
        if (message.error) call.reject(new Error(`${call.method}: ${message.error.message}${message.error.data ? ` (${message.error.data})` : ''}`));
        else call.resolve(message.result ?? {});
        return;
      }
      for (const fn of [...listeners]) {
        try {
          fn(message.method, message.params ?? {}, message.sessionId ?? '');
        } catch (err) {
          console.error('cdp.mjs: an event handler failed', err);
        }
      }
    });
    ws.addEventListener('close', () => {
      clearTimeout(openTimer);
      if (!opened) reject(new Error(`Chrome's DevTools connection closed before it opened (${wsUrl})`));
      if (!closed) failAll('Chrome closed the connection');
    });
    ws.addEventListener('error', () => {
      // A 'close' always follows, and it does the telling.
    });
  });
}

// ------------------------------------------------------------------
// Turning what Chrome reports into plain records
// ------------------------------------------------------------------

function sourceOf(fnOrSource, args = []) {
  if (typeof fnOrSource === 'function') {
    const list = args.map((arg) => (arg === undefined ? 'undefined' : JSON.stringify(arg)));
    return `(${fnOrSource.toString()})(${list.join(', ')})`;
  }
  return String(fnOrSource);
}

function shortSource(fnOrSource) {
  const text = String(fnOrSource).replace(/\s+/g, ' ');
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

// One console argument as text.
function argText(arg) {
  if (!arg) return '';
  if (arg.type === 'string') return arg.value;
  if (arg.type === 'undefined') return 'undefined';
  if ('unserializableValue' in arg) return String(arg.unserializableValue);
  if (arg.subtype === 'null') return 'null';
  if (arg.subtype === 'error' || arg.type === 'function') return arg.description ?? '';
  if (arg.type === 'object') {
    const props = arg.preview?.properties;
    if (props) {
      const inside = props.map((p) => (arg.subtype === 'array' ? p.value : `${p.name}: ${p.value}`)).join(', ');
      const more = arg.preview.overflow ? ', ...' : '';
      return arg.subtype === 'array' ? `[${inside}${more}]` : `{${inside}${more}}`;
    }
    return arg.description ?? 'Object';
  }
  return 'value' in arg ? String(arg.value) : (arg.description ?? '');
}

function exceptionText(details) {
  const description = details?.exception?.description;
  if (description) return description;
  const value = details?.exception?.value;
  if (value !== undefined) return `${details.text ?? 'Uncaught'} ${typeof value === 'string' ? value : JSON.stringify(value)}`;
  return details?.text ?? 'An exception with no message';
}

// True for an address that is not on this laptop. data:, blob:, about: and
// chrome: addresses are not network requests, and are never external.
export function isExternalUrl(url) {
  if (NOT_NETWORK.test(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    // Every 127.x.x.x address is this laptop. A test server started with a
    // host (127.0.0.2) lives on one.
    return !(LOCAL_HOSTS.has(host) || /^127(\.\d{1,3}){3}$/.test(host));
  } catch {
    return false;
  }
}

const trimUrl = (url) => (/^data:/i.test(url) && url.length > 120 ? `${url.slice(0, 120)}...` : url);
const round1 = (n) => Math.round(n * 10) / 10;

// Keeps the requests, console lines and exceptions of one session (a page,
// a frame or a worker) in the lists it is given.
function recorder(lists, target) {
  const open = new Map(); // requestId -> record
  const finish = (record, monotonic) => {
    record.pending = false;
    if (record.started !== undefined && monotonic !== undefined) record.ms = round1((monotonic - record.started) * 1000);
  };
  const begin = (id, url, method, resourceType, p) => {
    const record = {
      url: trimUrl(url),
      method,
      resourceType,
      status: null,
      fromCache: false,
      failed: false,
      errorText: null,
      ms: null,
      pending: true,
      target,
      startedAt: p.wallTime ? Math.round(p.wallTime * 1000) : Date.now(),
    };
    Object.defineProperty(record, 'started', { value: p.timestamp, enumerable: false, writable: true });
    open.set(id, record);
    lists.requests.push(record);
    return record;
  };

  return (method, p) => {
    switch (method) {
      case 'Network.requestWillBeSent': {
        const before = open.get(p.requestId);
        if (before && p.redirectResponse) {
          // A redirect: the first address is finished, and the next one starts.
          before.status = p.redirectResponse.status;
          finish(before, p.timestamp);
        }
        begin(p.requestId, p.request.url, p.request.method, p.type ?? 'Other', p);
        break;
      }
      case 'Network.requestServedFromCache': {
        const record = open.get(p.requestId);
        if (record) record.fromCache = true;
        break;
      }
      case 'Network.responseReceived': {
        const record = open.get(p.requestId);
        if (!record) break;
        record.status = p.response.status;
        if (p.response.fromDiskCache || p.response.fromPrefetchCache) record.fromCache = true;
        if (p.type && record.resourceType === 'Other') record.resourceType = p.type;
        break;
      }
      case 'Network.loadingFinished': {
        const record = open.get(p.requestId);
        if (!record) break;
        finish(record, p.timestamp);
        open.delete(p.requestId);
        break;
      }
      case 'Network.loadingFailed': {
        const record = open.get(p.requestId);
        if (!record) break;
        record.failed = true;
        record.errorText = p.blockedReason ? `${p.errorText || 'blocked'} (${p.blockedReason})` : (p.errorText || 'failed');
        if (p.canceled) record.errorText += ' (canceled)';
        finish(record, p.timestamp);
        open.delete(p.requestId);
        break;
      }
      // A WebSocket: one record for the connection. ms is how long the
      // handshake took (or how long until it failed).
      case 'Network.webSocketCreated': {
        begin(p.requestId, p.url, 'GET', 'WebSocket', {});
        break;
      }
      case 'Network.webSocketHandshakeResponseReceived': {
        const record = open.get(p.requestId);
        if (!record) break;
        record.status = p.response.status;
        record.pending = false;
        record.ms = Date.now() - record.startedAt;
        break;
      }
      case 'Network.webSocketFrameError': {
        const record = open.get(p.requestId);
        if (!record) break;
        record.failed = true;
        record.errorText = p.errorMessage || 'failed';
        if (record.pending) record.ms = Date.now() - record.startedAt;
        record.pending = false;
        break;
      }
      case 'Network.webSocketClosed': {
        const record = open.get(p.requestId);
        if (!record) break;
        if (record.status === null && !record.failed) {
          record.failed = true;
          record.errorText = 'closed before it connected';
        }
        if (record.pending) record.ms = Date.now() - record.startedAt;
        record.pending = false;
        open.delete(p.requestId);
        break;
      }
      case 'Runtime.consoleAPICalled': {
        const frame = p.stackTrace?.callFrames?.[0];
        lists.console.push({
          type: p.type,
          text: (p.args ?? []).map(argText).join(' '),
          source: 'console',
          url: frame?.url ?? '',
          line: frame ? frame.lineNumber + 1 : null,
          target,
        });
        break;
      }
      case 'Log.entryAdded': {
        // What the browser itself reports, such as a file that failed to load.
        lists.console.push({
          type: p.entry.level,
          text: p.entry.text,
          source: p.entry.source,
          url: p.entry.url ?? '',
          line: p.entry.lineNumber ?? null,
          target,
        });
        break;
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails ?? {};
        lists.exceptions.push({
          text: exceptionText(d),
          url: d.url ?? d.stackTrace?.callFrames?.[0]?.url ?? '',
          line: d.lineNumber !== undefined ? d.lineNumber + 1 : null,
          column: d.columnNumber !== undefined ? d.columnNumber + 1 : null,
          target,
        });
        break;
      }
      default:
    }
  };
}

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

// ------------------------------------------------------------------
// Chrome
// ------------------------------------------------------------------

function findChrome() {
  const found = CHROME_PLACES.find((place) => fs.existsSync(place));
  if (!found) {
    throw new Error(`Chrome was not found. Looked in:\n  ${CHROME_PLACES.join('\n  ')}\nSet CHROME_PATH to chrome.exe to use another one.`);
  }
  return found;
}

// Chrome writes the debugging port it picked, and the browser's address,
// to this file in the profile folder.
async function readDevToolsPort(userDataDir, child, timeoutMs, exitInfo) {
  const file = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const [port, wsPath] = (await fsp.readFile(file, 'utf8')).split('\n').map((line) => line.trim());
      if (Number(port) > 0 && wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
    } catch {
      // Not written yet.
    }
    if (exitInfo.code !== null) {
      throw new Error(`Chrome ended at once (exit code ${exitInfo.code}). Is another Chrome still using the profile folder ${userDataDir}?`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Chrome did not open its debugging port within ${timeoutMs} ms (no ${file})`);
    }
    await sleep(50);
  }
}

export async function launchChrome({
  headless = true,
  network = 'blocked',
  userDataDir,
  args = [],
  windowSize = { width: 1440, height: 900 },
  systemProxy = false,
  timeout = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!['blocked', 'open', 'tarpit'].includes(network)) {
    throw new Error(`launchChrome: network must be 'blocked', 'open' or 'tarpit', not ${JSON.stringify(network)}`);
  }
  const chromePath = findChrome();
  const ownsProfile = !userDataDir;
  const profile = ownsProfile
    ? await fsp.mkdtemp(path.join(os.tmpdir(), `${PROFILE_PREFIX}${process.pid}-`))
    : path.resolve(userDataDir);
  await fsp.mkdir(profile, { recursive: true });
  // Left over from the last run on this profile. It would name a dead port.
  await fsp.rm(path.join(profile, 'DevToolsActivePort'), { force: true });

  const tarpit = network === 'tarpit' ? await startTarpit() : null;
  const size = `${Math.round(windowSize.width)},${Math.round(windowSize.height)}`;
  const flags = [
    `--user-data-dir=${profile}`,
    '--remote-debugging-port=0',
    ...(headless ? ['--headless=new'] : []),
    '--enable-gpu',
    '--use-angle=d3d11',
    '--ignore-gpu-blocklist',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-extensions',
    `--window-size=${size}`,
  ];
  // launch-mode.bat starts Chrome with --no-proxy-server, so the tests do
  // too. Without it Chrome first looks for a proxy (WPAD), and on a
  // connection that is up but dead that look-up held every page, even
  // localhost, for 30 s. systemProxy: true shows what a plain Chrome does.
  // A proxy switch of the caller's own (in args) is left to decide.
  const ownProxy = args.some((arg) => /^--(no-proxy-server|proxy-server|proxy-pac-url|proxy-auto-detect)\b/.test(String(arg)));
  if (!systemProxy && !ownProxy) flags.push('--no-proxy-server');
  // The rules are read by Chrome's own name lookup, so they cover pages,
  // workers and service workers alike. This laptop's own names are left
  // alone. (::1 is written without its brackets. With them the rule does
  // not match, and http://[::1] is blocked too.)
  //
  // Chrome only reads the last --host-resolver-rules it is given, so a
  // caller's own rules (in args) are joined with the network's into one
  // switch. The caller's come first, because the first MAP that matches a
  // host wins. An EXCLUDE beats every MAP, so a local name the caller maps
  // (MAP localhost 127.0.0.2) is taken off the EXCLUDE list.
  const ownRules = [];
  const otherArgs = [];
  for (const arg of args) {
    const m = /^--host-resolver-rules=([\s\S]*)$/.exec(String(arg));
    if (!m) {
      otherArgs.push(arg);
      continue;
    }
    ownRules.push(...m[1].replace(/^"([\s\S]*)"$/, '$1').split(',').map((rule) => rule.trim()).filter(Boolean));
  }
  const mapped = new Set(ownRules
    .map((rule) => /^MAP\s+(\S+)\s+\S+$/i.exec(rule)?.[1].toLowerCase())
    .filter(Boolean));
  const local = ['localhost', '127.0.0.1', '::1']
    .filter((name) => !mapped.has(name))
    .map((name) => `EXCLUDE ${name}`);
  let rules = ownRules;
  if (network === 'blocked') {
    rules = [...ownRules, 'MAP * ~NOTFOUND', ...local];
  } else if (network === 'tarpit') {
    // A MAP rule can name a port, so every host and every port lands on
    // the one tarpit server.
    rules = [...ownRules, `MAP * 127.0.0.1:${tarpit.port}`, ...local];
  }
  if (rules.length) flags.push(`--host-resolver-rules=${rules.join(', ')}`);
  flags.push(...otherArgs, 'about:blank');

  const child = spawn(chromePath, flags, { stdio: 'ignore', windowsHide: false });
  const exitInfo = { code: null };
  const exited = new Promise((resolve) => {
    child.on('exit', (code) => {
      exitInfo.code = code ?? -1;
      stillRunning.delete(child.pid);
      resolve();
    });
  });
  child.on('error', () => {});
  if (!child.pid) {
    if (tarpit) await tarpit.stop();
    if (ownsProfile) await removeFolder(profile);
    throw new Error(`Chrome could not be started from ${chromePath}`);
  }
  stillRunning.add(child.pid);

  const cleanUp = async () => {
    if (tarpit) await tarpit.stop();
    if (ownsProfile) await removeFolder(profile);
  };

  let connection;
  try {
    const wsUrl = await readDevToolsPort(profile, child, timeout, exitInfo);
    connection = await connect(wsUrl, timeout);
  } catch (err) {
    killTree(child.pid);
    await Promise.race([exited, sleep(3000)]);
    await cleanUp();
    throw err;
  }

  // ---- sessions ----
  const pages = new Map();     // targetId -> page
  const sessions = new Map();  // sessionId -> { page, type, targetId, handle }
  const waitingPages = new Map(); // targetId -> resolve
  // What a service worker or shared worker asked for. They belong to the
  // browser, not to one page, so every page's lists include these.
  const shared = { requests: [], console: [], exceptions: [] };
  // A worker can be attached twice (through the browser and through its
  // page). It is only listened to once.
  const listened = new Map(); // targetId -> sessionId

  const quiet = (promise) => promise.catch(() => {});
  const sendTo = (sessionId) => (method, params, options = {}) => connection.send(method, params, { ...options, sessionId });

  function makePage(targetId, sessionId) {
    const lists = { requests: [], console: [], exceptions: [] };
    const dialogs = [];
    const waiters = new Set(); // { test, done }
    const send = sendTo(sessionId);
    const state = { closed: false, crashed: false };
    const since = { requests: shared.requests.length, console: shared.console.length, exceptions: shared.exceptions.length };

    // How far each document of the main frame has come. Chrome names a
    // document by its loader, and reports 'init', 'DOMContentLoaded' and
    // 'load' for it. Waiting on the loader (and not on "the next load
    // event") means an older document's late event is never taken for the
    // new one's.
    const reached = new Map(); // loaderId -> Set of event names
    let newestLoader = null;
    const lifeNames = { load: 'load', domcontentloaded: 'DOMContentLoaded', none: null };

    // Resolves once test() is true. It is tried again after every event.
    const until = (test, timeoutMs, what) => new Promise((resolve, reject) => {
      if (test()) {
        resolve();
        return;
      }
      const waiter = {
        test,
        done: () => { clearTimeout(timer); resolve(); },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(what));
      }, timeoutMs);
      waiters.add(waiter);
    });

    const page = {
      targetId,
      sessionId,
      // How long evaluate() waits (ms) for the page to answer.
      evaluateTimeout: DEFAULT_TIMEOUT_MS,
      get closed() { return state.closed; },
      get crashed() { return state.crashed; },

      send: (method, params = {}, options = {}) => send(method, params, options),

      async goto(url, { waitUntil = 'load', timeout: ms = DEFAULT_TIMEOUT_MS } = {}) {
        const name = lifeNames[waitUntil];
        if (name === undefined) throw new Error(`goto: waitUntil must be 'load', 'domcontentloaded' or 'none', not ${JSON.stringify(waitUntil)}`);
        const began = Date.now();
        let result;
        try {
          result = await send('Page.navigate', { url }, { timeout: ms });
        } catch (err) {
          throw new Error(`Could not open ${url}: ${err.message}`);
        }
        if (result.errorText) throw new Error(`Could not open ${url}: ${result.errorText}`);
        // Moving inside the same document (only the #part changed) has no
        // loader and fires no load event.
        if (name && result.loaderId) {
          const left = Math.max(1, ms - (Date.now() - began));
          await until(
            () => reached.get(result.loaderId)?.has(name),
            left,
            `${url} did not reach "${waitUntil}" within ${ms} ms. Something it loads may never be answering. goto(url, { waitUntil: 'none' }) does not wait for it.`,
          );
        }
        return { ms: Date.now() - began };
      },

      async reload({ waitUntil = 'load', timeout: ms = DEFAULT_TIMEOUT_MS } = {}) {
        const name = lifeNames[waitUntil];
        if (name === undefined) throw new Error(`reload: waitUntil must be 'load', 'domcontentloaded' or 'none', not ${JSON.stringify(waitUntil)}`);
        const began = Date.now();
        const before = newestLoader;
        await send('Page.reload', {}, { timeout: ms });
        if (name) {
          await until(
            () => newestLoader !== before && reached.get(newestLoader)?.has(name),
            Math.max(1, ms - (Date.now() - began)),
            `The reload did not reach "${waitUntil}" within ${ms} ms`,
          );
        }
        return { ms: Date.now() - began };
      },

      async evaluate(fnOrSource, ...args) {
        if (state.crashed) throw new Error('evaluate: the page has crashed');
        const result = await send('Runtime.evaluate', {
          expression: sourceOf(fnOrSource, args),
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
        }, { timeout: page.evaluateTimeout });
        if (result.exceptionDetails) {
          throw new Error(`The page threw: ${exceptionText(result.exceptionDetails)}`);
        }
        return result.result?.value;
      },

      async waitFor(fnOrSource, { timeout: ms = 15000, interval = 100, message, args = [] } = {}) {
        const began = Date.now();
        let lastError = null;
        for (;;) {
          try {
            const value = await page.evaluate(fnOrSource, ...args);
            if (value) return value;
            lastError = null;
          } catch (err) {
            // Mid-navigation, or the thing looked at does not exist yet.
            lastError = err;
          }
          if (Date.now() - began >= ms) {
            const what = message ?? `waitFor gave up: ${shortSource(fnOrSource)}`;
            throw new Error(`${what} (waited ${ms} ms)${lastError ? `. The last try failed: ${lastError.message.split('\n')[0]}` : ''}`);
          }
          await sleep(interval);
        }
      },

      async click(selector, { force = false } = {}) {
        const spot = await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return { problem: 'no element matches' };
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return { problem: 'the element has no size (it is hidden)' };
          const x = r.left + r.width / 2;
          const y = r.top + r.height / 2;
          const top = document.elementFromPoint(x, y);
          const describe = (node) => (node ? `<${node.tagName.toLowerCase()}${node.id ? ` id="${node.id}"` : ''}${node.className && typeof node.className === 'string' ? ` class="${node.className}"` : ''}>` : 'nothing');
          const hit = top === el || el.contains(top);
          return { x, y, hit, top: describe(top) };
        }, selector);
        if (spot.problem) throw new Error(`click(${JSON.stringify(selector)}): ${spot.problem}`);
        if (force) {
          await page.evaluate((sel) => document.querySelector(sel).click(), selector);
          return;
        }
        if (!spot.hit) {
          throw new Error(`click(${JSON.stringify(selector)}): the element is covered by ${spot.top}. click(selector, { force: true }) clicks it from code anyway.`);
        }
        const at = { x: spot.x, y: spot.y, button: 'left', clickCount: 1 };
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: spot.x, y: spot.y });
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
      },

      async type(selector, text, { clear = false } = {}) {
        await page.evaluate((sel, wipe) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`type: no element matches ${sel}`);
          el.focus();
          if (wipe && 'value' in el && el.value !== '') {
            el.value = '';
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }, selector, clear);
        if (text) await send('Input.insertText', { text: String(text) });
      },

      async press(key) {
        const known = KEYS[key] ?? (String(key).length === 1
          ? { key, text: key, keyCode: key.toUpperCase().charCodeAt(0) }
          : null);
        if (!known) throw new Error(`press: I don't know the key ${JSON.stringify(key)}. Known: ${Object.keys(KEYS).join(', ')}, or one character.`);
        const base = { key: known.key, code: known.code, windowsVirtualKeyCode: known.keyCode, nativeVirtualKeyCode: known.keyCode };
        await send('Input.dispatchKeyEvent', { type: known.text ? 'keyDown' : 'rawKeyDown', ...base, text: known.text });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      },

      async setFiles(selector, files) {
        const list = (Array.isArray(files) ? files : [files]).map((file) => path.resolve(file));
        for (const file of list) {
          if (!fs.existsSync(file)) throw new Error(`setFiles: there is no file ${file}`);
        }
        const { root } = await send('DOM.getDocument', { depth: 0 });
        const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector });
        if (!nodeId) throw new Error(`setFiles(${JSON.stringify(selector)}): no element matches`);
        await send('DOM.setFileInputFiles', { nodeId, files: list });
      },

      async screenshot(file, { clip, fullPage = false } = {}) {
        const out = path.resolve(file);
        const ext = path.extname(out).slice(1).toLowerCase();
        const format = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp' }[ext];
        if (!format) throw new Error(`screenshot: the file must end in .png, .jpg or .webp, not ${JSON.stringify(path.basename(out))}`);
        const params = { format };
        if (format !== 'png') params.quality = 90;
        if (clip) {
          // A part of what is on screen now, in CSS pixels from the top left.
          params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale ?? 1 };
        } else if (fullPage) {
          const metrics = await send('Page.getLayoutMetrics');
          const whole = metrics.cssContentSize ?? metrics.contentSize;
          params.clip = { x: 0, y: 0, width: Math.ceil(whole.width), height: Math.ceil(whole.height), scale: 1 };
          params.captureBeyondViewport = true;
        }
        // A page behind another one is not drawn, and its picture would never come.
        await quiet(send('Page.bringToFront'));
        const { data } = await send('Page.captureScreenshot', params);
        await fsp.mkdir(path.dirname(out), { recursive: true });
        await fsp.writeFile(out, Buffer.from(data, 'base64'));
        return out;
      },

      // In the order they started, whoever made them.
      requests: () => [...lists.requests, ...shared.requests.slice(since.requests)]
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((r) => ({ ...r })),
      externalRequests: () => page.requests().filter((r) => isExternalUrl(r.url)),
      consoleMessages: () => [...lists.console, ...shared.console.slice(since.console)].map((m) => ({ ...m })),
      consoleErrors: () => page.consoleMessages().filter((m) => m.type === 'error'),
      exceptions: () => [...lists.exceptions, ...shared.exceptions.slice(since.exceptions)].map((e) => ({ ...e })),
      dialogs: () => dialogs.map((d) => ({ ...d })),

      async close() {
        if (state.closed) return;
        state.closed = true;
        await quiet(connection.send('Target.closeTarget', { targetId }, { timeout: 5000 }));
        pages.delete(targetId);
      },
    };

    // Events of the page's own session.
    const record = recorder(lists, 'page');
    page.handle = (method, params) => {
      record(method, params);
      if (method === 'Page.javascriptDialogOpening') {
        // An open alert or "leave this page?" box stops the page, so each
        // one is accepted and noted.
        dialogs.push({ type: params.type, message: params.message, url: params.url });
        quiet(send('Page.handleJavaScriptDialog', { accept: true }));
      } else if (method === 'Inspector.targetCrashed') {
        state.crashed = true;
        lists.exceptions.push({ text: 'The page crashed', url: '', line: null, column: null, target: 'page' });
      }
      if (method === 'Page.lifecycleEvent' && params.frameId === targetId) {
        // The main frame's ID is the page's own ID. Frames inside it are left out.
        if (!reached.has(params.loaderId)) reached.set(params.loaderId, new Set());
        reached.get(params.loaderId).add(params.name);
        if (params.name === 'init' || params.name === 'commit') newestLoader = params.loaderId;
      }
      for (const waiter of [...waiters]) {
        if (waiter.test()) {
          waiters.delete(waiter);
          waiter.done();
        }
      }
    };
    page.lists = lists;
    return page;
  }

  // Sets up one new session: listen to its network and console, attach to
  // whatever it starts (frames and workers), then let it run.
  function onAttached(params, parentSessionId) {
    const { sessionId, targetInfo, waitingForDebugger } = params;
    const { type, targetId } = targetInfo;
    const send = sendTo(sessionId);
    const parent = sessions.get(parentSessionId);
    const ownerPage = parent?.page ?? null;
    const run = () => { if (waitingForDebugger) quiet(send('Runtime.runIfWaitingForDebugger')); };

    if (type === 'page' && !parentSessionId) {
      const page = makePage(targetId, sessionId);
      pages.set(targetId, page);
      sessions.set(sessionId, { page, type, targetId, handle: page.handle });
      const ready = Promise.all([
        quiet(send('Page.enable')),
        quiet(send('Page.setLifecycleEventsEnabled', { enabled: true })),
        quiet(send('Runtime.enable')),
        quiet(send('Network.enable')),
        quiet(send('Log.enable')),
        quiet(send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })),
      ]);
      run();
      ready.then(() => {
        page.ready = true;
        const resolve = waitingPages.get(targetId);
        waitingPages.delete(targetId);
        resolve?.(page);
      });
      return;
    }

    // Chrome's own parts are let run and not listened to: its toolbar
    // pages (browser_ui) and the service workers of its built-in
    // extensions. Only a website's service worker or shared worker counts.
    const ofBrowser = !parentSessionId;
    const counts = ofBrowser
      ? (type === 'service_worker' || type === 'shared_worker') && /^(https?|file|blob):/i.test(targetInfo.url ?? '')
      : type !== 'browser_ui';
    if (!counts) {
      sessions.set(sessionId, { page: null, type, targetId, handle: () => {} });
      run();
      return;
    }

    // A frame, a worker, a service worker, or a page opened by a page.
    const other = listened.get(targetId);
    if (other && sessions.has(other)) {
      // Already listened to through another session. Just let it run.
      sessions.set(sessionId, { page: ownerPage, type, targetId, handle: () => {} });
      run();
      return;
    }
    listened.set(targetId, sessionId);
    const lists = ownerPage ? ownerPage.lists : shared;
    const label = type === 'page' ? 'popup' : type;
    sessions.set(sessionId, { page: ownerPage, type, targetId, handle: recorder(lists, label) });
    quiet(send('Network.enable'));
    quiet(send('Runtime.enable'));
    if (type === 'iframe' || type === 'page') quiet(send('Log.enable'));
    quiet(send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }));
    run();
  }

  connection.on((method, params, sessionId) => {
    if (method === 'Target.attachedToTarget') {
      onAttached(params, sessionId);
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const gone = sessions.get(params.sessionId);
      sessions.delete(params.sessionId);
      if (gone && listened.get(gone.targetId) === params.sessionId) listened.delete(gone.targetId);
      return;
    }
    sessions.get(sessionId)?.handle(method, params);
  });

  let version = '';
  try {
    version = (await connection.send('Browser.getVersion', {}, { timeout: 10000 })).product ?? '';
    // Every new page, service worker and shared worker is attached and held
    // until it is being listened to, so not one request is missed.
    await connection.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, { timeout: 10000 });
  } catch (err) {
    connection.close();
    killTree(child.pid);
    await Promise.race([exited, sleep(3000)]);
    await cleanUp();
    throw new Error(`Chrome started but would not take commands: ${err.message}`);
  }

  let closing = null;
  const browser = {
    pid: child.pid,
    userDataDir: profile,
    version,
    network,
    // The --host-resolver-rules this Chrome was started with ('' for none).
    hostRules: rules.join(', '),
    tarpit,
    send: (method, params = {}, options = {}) => connection.send(method, params, options),
    pages: () => [...pages.values()].filter((page) => !page.closed),

    // A new page in its own window, so it stays in front and keeps drawing.
    // viewport: { width, height, deviceScaleFactor } sets the page's size
    // exactly. Headless, it is windowSize unless told otherwise (a headless
    // window still has a hidden toolbar, which would make the page a bit
    // smaller than the window). viewport: null leaves the size alone.
    async newPage({ viewport = headless ? windowSize : null, timeout: ms = 15000 } = {}) {
      const { targetId } = await connection.send('Target.createTarget', {
        url: 'about:blank',
        newWindow: true,
        ...(headless ? { width: Math.round(windowSize.width), height: Math.round(windowSize.height) } : {}),
      }, { timeout: ms });
      let page = pages.get(targetId);
      if (!page?.ready) {
        page = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            waitingPages.delete(targetId);
            reject(new Error(`The new page was not ready within ${ms} ms`));
          }, ms);
          waitingPages.set(targetId, (made) => { clearTimeout(timer); resolve(made); });
          // It may have become ready between the look and the wait.
          const now = pages.get(targetId);
          if (now?.ready) {
            clearTimeout(timer);
            waitingPages.delete(targetId);
            resolve(now);
          }
        });
      }
      if (viewport) {
        await page.send('Emulation.setDeviceMetricsOverride', {
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
          deviceScaleFactor: viewport.deviceScaleFactor ?? 1,
          mobile: false,
        });
      }
      return page;
    },

    // Closes Chrome the polite way, so its storage is written out, then
    // makes sure every one of its processes is gone.
    close() {
      if (closing) return closing;
      closing = (async () => {
        if (exitInfo.code === null) {
          await quiet(connection.send('Browser.close', {}, { timeout: 3000 }));
          await Promise.race([exited, sleep(5000)]);
        }
        connection.close();
        if (exitInfo.code === null) killTree(child.pid);
        await Promise.race([exited, sleep(5000)]);
        stillRunning.delete(child.pid);
        await cleanUp();
      })();
      return closing;
    },

    // Ends Chrome with no goodbye, like a crash or a dead battery. A
    // profile given as userDataDir is kept, so the next launchChrome() on it
    // shows what survived.
    kill() {
      if (closing) return closing;
      closing = (async () => {
        if (exitInfo.code === null) killTree(child.pid);
        connection.close();
        await Promise.race([exited, sleep(5000)]);
        stillRunning.delete(child.pid);
        // The files are let go a moment after the processes end.
        await sleep(300);
        await cleanUp();
      })();
      return closing;
    },
  };
  return browser;
}

// ------------------------------------------------------------------
// node launch-mode/test/cdp.mjs --clean
// ------------------------------------------------------------------

// Finds the Chromes this helper started whose test (the Node process named
// in the profile folder) is gone. Returns [{ pid, profile, owner }].
export function findStrays() {
  if (process.platform !== 'win32') return [];
  const ps = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }",
  ], { encoding: 'utf8', windowsHide: true });
  const strays = [];
  for (const line of String(ps.stdout ?? '').split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const commandLine = line.slice(tab + 1);
    if (/--type=/.test(commandLine)) continue; // a helper process. Its browser is the one to end.
    const m = new RegExp(`--user-data-dir=("?)([^"]*?${PROFILE_PREFIX}(\\d+)-[A-Za-z0-9]+)\\1`).exec(commandLine);
    if (!m) continue;
    const owner = Number(m[3]);
    if (owner === process.pid || isRunning(owner)) continue;
    strays.push({ pid: Number(line.slice(0, tab)), profile: m[2], owner });
  }
  return strays;
}

async function cleanStrays() {
  const strays = findStrays();
  if (!strays.length) {
    console.log('No leftover test Chrome was found.');
    return;
  }
  for (const stray of strays) {
    killTree(stray.pid);
    await sleep(300);
    await removeFolder(stray.profile);
    console.log(`Ended a leftover test Chrome (process ${stray.pid}) and removed ${stray.profile}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--clean')) {
    await cleanStrays();
  } else {
    console.log('cdp.mjs is a helper for the launch mode tests. See the comment at its top.');
    console.log('  node launch-mode/test/cdp.mjs --clean   ends test Chromes left behind by a killed test');
  }
}
