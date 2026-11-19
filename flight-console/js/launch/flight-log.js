// flight-log.js: launch mode's flight log. On the launch page (launch.html)
// every raw serial line is written, with the time it arrived, to three
// places at once, so nothing from the flight is lost whatever fails:
//   THE DISK FILE     a file I pick when I press CONNECT, written with the
//                     File System Access API (createDiskSink() in
//                     log-sinks.js)
//   THE SERVER COPY   flight-logs/<name>.log, written by the local server
//                     (launch-mode/server.mjs) from POST
//                     /launch-mode/log/append (createServerSink())
//   THE BROWSER COPY  the recording the console keeps in IndexedDB anyway
//                     (js/views/local-console.js). On this page it keeps up
//                     within a quarter of a second.
// The format of the two files is in log-format.js. The console loads either
// one back with LOAD FILE and replays it.
//
// CONNECT ON THIS PAGE. A save box and the serial port list each need a
// fresh click, so one click can't be counted on for both. The first CONNECT
// of a visit opens the save box (suggested name flight-YYYY-MM-DD-HHMM.log).
// Then the port opens with no second click when the browser already has
// leave to open the receiver (navigator.serial.getPorts(), from an earlier
// visit). Otherwise the port list opens right away if the click still
// counts, or the line under the bar says to press CONNECT again. Cancelling
// the save box never stops the connection: the other copies keep every
// line, the status says plainly that there is no disk file, and CHOOSE FILE
// picks one later and writes everything so far into it. The save box is
// asked once per visit. A reconnect keeps adding to the same file, after a
// "# connected" line. After a DISCONNECT by hand, the next CONNECT always
// shows the port list, in case it was the wrong port.
//
// WRITING. Lines collect in memory (one log text per log) and each copy
// adds the new ones about once a second, one cycle at a time, never two at
// once. A cycle that fails keeps its lines and the next one tries again,
// so nothing is dropped or put out of order. The disk file is opened,
// added to and closed again each cycle, because the browser only puts what
// was written into the real file when it is closed. When the page is hidden
// or closing, every copy is written at once, and the server gets one last
// request that outlives the page (navigator.sendBeacon).
//
// ONE LOG PER VISIT for the flight: every real connection of the visit goes
// in the same files. A played test capture (capture.js) gets a log of its
// own, named test-capture-..., so test data is never taken for the flight.
// When a real connection opens after a test capture, the live flight
// store is cleared, so the test's track never joins the flight's.
//
// RECOVER. When RECOVER saves a recording a crash left behind, its lines are
// played back into the live view through the console's own handlers (not
// the recorder and not this log, so nothing is stored twice). The track,
// the last fix and the launch panel come back, and CONNECT carries the same
// flight on. That only happens while the live view is empty and nothing is
// connected, and never for a test capture.
//
// ALSO, on this page only: the browser asks before the tab closes or
// reloads while a port is open or a test capture plays, the screen is kept
// awake while connected (a wake lock, taken again when the page shows
// again, and nothing is said if the browser refuses it), and a lost port
// is said plainly in the log's status.
//
// createFlightLog({ hub, ctx }) -> hub.parts.log:
//   status()               what the log is doing (see status() below)
//   useFileHandle(handle)  writes the log to this FileSystemFileHandle from
//                          now on, everything so far first. For the tests,
//                          which can't drive the save box: a handle from
//                          navigator.storage.getDirectory() runs the same
//                          code. Resolves true once the file has every line.
//   chooseFile()           what CHOOSE FILE does
//   expectTest({ notes })  capture.js: the next connection is a test capture
//   liveData()             what the live view holds: 'none', 'test' or 'real'
//   clearTestData()        clears the live flight store of test data
//   flush({ urgent })      runs every copy's cycle now
//   logText()              the shown log's whole text (for the tests)
//   connect(), disconnect()   what CONNECT and DISCONNECT do on this page
//
// Used by: js/launch/launch-mode.js (startLaunchMode). Launch page only.

import { h, setText, createScheduler } from '../views/dom.js?v=2';
import { formatLogTime, dataLine, noteLine, headerLines, logFileName, createLogText } from './log-format.js';
import { createDiskSink, createServerSink } from './log-sinks.js';

// The website's root, three folders up from flight-console/js/launch/.
const ROOT_URL = new URL('../../../', import.meta.url);
const APPEND_URL = new URL('launch-mode/log/append', ROOT_URL).href;
const PING_URL = new URL('launch-mode/ping', ROOT_URL).href;

// A copy is written at most this often (ms), and less often when its
// cycles get slow (twice the last one's time).
const CYCLE_MS = 1000;
// How often (ms) the timer looks for a copy with lines waiting. Lines that
// arrive also start a cycle when one is due, so a hidden tab, whose timers
// the browser slows down, still keeps up.
const PUMP_MS = 250;
// A copy that keeps failing is tried again at least this often (ms).
const RETRY_MAX_MS = 10000;
// How long (ms) the local server gets to answer the first "are you there".
const PING_TIMEOUT_MS = 3000;
// A recovered recording goes back on screen this many lines at a time, so
// the page keeps answering while a long one plays back.
const RESTORE_CHUNK = 400;
// The status redraws at most this often (times a second).
const STATUS_FPS = 8;

const LINK_BUSY = new Set(['picking', 'opening', 'open', 'closing']);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');

// "0.4 S", "12 S", "3 MIN": how long ago, for the status.
function agoWords(ms) {
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, ms / 1000);
  if (s < 10) return `${s.toFixed(1)} S`;
  if (s < 120) return `${Math.round(s)} S`;
  return `${Math.round(s / 60)} MIN`;
}

export function createFlightLog({ hub, ctx }) {
  const live = ctx.live;
  const localConsole = ctx.localConsole ?? null;
  const canPick = typeof globalThis.showSaveFilePicker === 'function';

  const sessions = [];       // every log this visit, oldest first
  let current = null;        // the log lines go to now (a connection is open), or null
  let flight = null;         // this visit's flight log, made at the first real connection
  let pendingHandle = null;  // a file picked before its log started
  let pendingPick = null;    // how the save box went before the flight log started
  let asked = false;         // the save box was shown this visit
  let testNext = null;       // { notes } from capture.js for the next connection
  let liveData = 'none';     // what the live view holds: 'none', 'test' or 'real'
  let lostAt = null;         // when the port was lost (ms), until the next connection
  let lastPort = null;       // the port the last real connection used
  let pickPortNext = false;  // DISCONNECT was pressed: the next CONNECT shows the port list
  let connecting = false;
  let restoring = null;      // a recovered recording going back on screen
  let restored = null;       // { id, lines } the last one that did
  let presence = 'unknown';  // the local server: 'unknown', 'present' or 'absent'
  let note = null;           // { text, kind } a sentence under the status

  // ------------------------------------------------------------------
  // The logs
  // ------------------------------------------------------------------

  function makeSession(kind, notes = []) {
    const startedAt = Date.now();
    const text = createLogText();
    for (const line of headerLines(startedAt, { notes })) text.add(line);
    const session = {
      kind,
      startedAt,
      text,
      open: false,
      connections: 0,
      pick: null,                 // 'cancelled' or 'failed' when the save box gave no file
      pickError: null,
      pickName: logFileName(kind, startedAt, 'pick'),
      took: { disk: 0, server: 0 },   // how long the last cycle of each copy took (ms)
      recordingId: null,          // the browser copy of its newest connection
    };
    session.disk = createDiskSink({ text, onChange: draw });
    session.server = createServerSink({ text, name: logFileName(kind, startedAt, 'server'), url: APPEND_URL, onChange: draw });
    sessions.push(session);
    return session;
  }

  // The log the status shows: the one lines go to, or the newest.
  const shown = () => current ?? sessions[sessions.length - 1] ?? null;

  function diskDue(s) {
    const sink = s.disk;
    const st = sink.state();
    if (!sink.handle || st.busy || (!st.pending && !st.error)) return false;
    const gap = st.error ? 3 * CYCLE_MS : Math.max(CYCLE_MS, 2 * s.took.disk);
    return Date.now() - sink.lastStartAt >= gap;
  }

  function serverDue(s) {
    const sink = s.server;
    const st = sink.state();
    if (st.busy || st.state === 'none') return false;
    if (!st.pending && st.state === 'saving') return false;
    const gap = st.state === 'failing'
      ? Math.min(RETRY_MAX_MS, CYCLE_MS * 2 ** Math.min(sink.failures, 4))
      : Math.max(CYCLE_MS, 2 * s.took.server);
    return Date.now() - sink.lastStartAt >= gap;
  }

  function runCycle(s, which, urgent = false) {
    const began = Date.now();
    return s[which].cycle({ urgent }).then((ok) => {
      s.took[which] = Date.now() - began;
      draw();
      return ok;
    });
  }

  // Starts every cycle that is due. Cheap when nothing is.
  function pump() {
    for (const s of sessions) {
      if (diskDue(s)) runCycle(s, 'disk');
      if (serverDue(s)) runCycle(s, 'server');
    }
  }

  // Every copy now, whatever the spacing (the page is hidden or closing).
  function flush({ urgent = true } = {}) {
    const runs = [];
    for (const s of sessions) {
      if (s.disk.handle && (s.disk.state().pending || s.disk.state().error)) runs.push(runCycle(s, 'disk', urgent));
      const server = s.server.state();
      if (server.state !== 'none' && (server.pending || server.state !== 'saving')) runs.push(runCycle(s, 'server', urgent));
    }
    return Promise.all(runs).then((all) => all.every(Boolean));
  }

  setInterval(pump, PUMP_MS);

  // ------------------------------------------------------------------
  // Every serial event, before the console sees it (hub.link's taps)
  // ------------------------------------------------------------------

  hub.link.onOpen(() => {
    const test = testNext;
    testNext = null;
    let session;
    if (test) {
      session = makeSession('test', test.notes ?? []);
      localConsole?.markNextRecording?.({ test: true });
    } else {
      // Real data follows a test: the test leaves the live view first.
      if (liveData === 'test') clearTestData();
      if (!flight) {
        flight = makeSession('flight');
        if (pendingPick) {
          flight.pick = pendingPick.state;
          flight.pickError = pendingPick.error;
          pendingPick = null;
        }
      } else {
        flight.text.add(noteLine(`connected ${formatLogTime(Date.now())}`));
      }
      session = flight;
      lastPort = live.link?.port ?? lastPort;
      pickPortNext = false;
      lostAt = null;
    }
    if (pendingHandle) {
      session.disk.use(pendingHandle);
      pendingHandle = null;
    }
    session.open = true;
    session.connections += 1;
    session.recordingId = null;   // this connection's browser copy, known at its first line
    current = session;
    keepAwake(true);
    pump();
    draw();
  });

  hub.link.onLine((line, t) => {
    const s = current;
    if (!s) return;
    s.text.add(dataLine(line, Number.isFinite(t) ? t : Date.now()), true);
    // The recording started in the console's own onOpen, after this log's.
    if (!s.recordingId) s.recordingId = localConsole?.recording?.().id ?? null;
    liveData = s.kind === 'test' ? 'test' : 'real';
    pump();
    draw();
  });

  hub.link.onClose(({ lost } = {}) => {
    const s = current;
    current = null;
    keepAwake(false);
    if (!s) return;
    s.open = false;
    s.text.add(noteLine(`connection closed ${formatLogTime(Date.now())}`));
    if (lost && s.kind === 'flight') lostAt = Date.now();
    flush();
    draw();
  });

  // ------------------------------------------------------------------
  // CONNECT, DISCONNECT and the save box
  // ------------------------------------------------------------------

  // Says something on the line under the bar, the way the serial link does.
  const barNote = (text, kind = 'info') => {
    try { live.handlers?.onNote?.(text, kind); } catch { /* the panel isn't there */ }
  };

  // The port to open without asking, or null to show the port list.
  function grantedPort(ports) {
    if (!ports.length || pickPortNext) return null;
    if (lastPort && ports.includes(lastPort)) return lastPort;
    return ports.length === 1 ? ports[0] : null;
  }

  async function connect() {
    const link = live.link;
    if (!link || connecting || LINK_BUSY.has(link.link)) return;
    connecting = true;
    try {
      // A test capture gives way to the real port at once.
      const capture = hub.parts.capture;
      if (capture?.status?.().playing) await capture.stop();
      if (!asked) {
        asked = true;
        const picked = await askForFile(flight ?? null, 'flight');
        if (picked) {
          if (flight) useOn(flight, picked);
          else pendingHandle = picked;
        }
      }
      // A recovered recording that is still going back on screen finishes first.
      if (restoring) await restoring;
      const ports = await link.granted();
      const port = grantedPort(ports);
      if (port) {
        await link.connect({ port });
        return;
      }
      // The port list needs a click that still counts. After the save box
      // it may not, and then the next press of CONNECT opens it.
      if (globalThis.navigator?.userActivation && !navigator.userActivation.isActive) {
        barNote('Press CONNECT again to pick the receiver\'s port. The browser needs a second click for it after the save box.');
        return;
      }
      await link.connect();
    } catch (err) {
      console.error('Launch mode: CONNECT failed', err);
    } finally {
      connecting = false;
      draw();
    }
  }

  function disconnect() {
    const capture = hub.parts.capture;
    if (capture?.status?.().playing) return capture.stop();
    pickPortNext = true;
    return live.link?.disconnect();
  }

  // Shows the save box. Resolves with the handle, or null when there is
  // none (the box was cancelled or failed, or the browser has no save box).
  // `session` is the log it is for, or null for the flight log to come.
  async function askForFile(session, kind) {
    const mark = (state, error = null) => {
      if (session) {
        session.pick = state;
        session.pickError = error;
      } else if (kind === 'flight') {
        pendingPick = state ? { state, error } : null;
      }
      draw();
    };
    if (!canPick) {
      mark('unsupported');
      return null;
    }
    try {
      const handle = await globalThis.showSaveFilePicker({
        suggestedName: session?.pickName ?? logFileName(kind, Date.now(), 'pick'),
        types: [{ description: 'Flight log', accept: { 'text/plain': ['.log'] } }],
        id: 'dogtooth-flight-log',
      });
      mark(null);
      return handle;
    } catch (err) {
      if (err?.name === 'AbortError') mark('cancelled');
      else {
        console.warn('Launch mode: the save box failed', err);
        mark('failed', err?.message ?? String(err));
      }
      return null;
    }
  }

  function useOn(session, handle) {
    session.disk.use(handle);
    session.pick = null;
    session.pickError = null;
    draw();
    return runCycle(session, 'disk', true);
  }

  // CHOOSE FILE: a file for the log on show, or for the flight log to come.
  async function chooseFile() {
    const s = shown();
    if (!s || s.kind === 'flight') asked = true;
    const handle = await askForFile(s, s?.kind ?? 'flight');
    if (!handle) return false;
    if (s) return useOn(s, handle);
    pendingHandle = handle;
    draw();
    return false;
  }

  // The tests' way in (see the top of this file). The file goes to the log
  // lines go to now, or the newest log, or the next one to start.
  function useFileHandle(handle) {
    if (!handle || typeof handle.createWritable !== 'function' || typeof handle.getFile !== 'function') {
      throw new TypeError('useFileHandle needs a FileSystemFileHandle');
    }
    const s = shown();
    if (s) return useOn(s, handle);
    pendingHandle = handle;
    draw();
    return Promise.resolve(false);
  }

  // ------------------------------------------------------------------
  // Test data in the live view
  // ------------------------------------------------------------------

  function clearTestData() {
    const store = live.stores?.flight ?? null;
    if (store) {
      live.flightFeed?.reset?.();
      store.clearAll();
    }
    liveData = 'none';
  }

  // capture.js calls this right before its onOpen.
  function expectTest(info = {}) {
    testNext = { notes: Array.isArray(info.notes) ? info.notes.map(String) : [] };
  }

  // ------------------------------------------------------------------
  // RECOVER: a recovered recording back on the live view
  // ------------------------------------------------------------------

  const liveHasData = () => (live.stores?.flight?.getTotals?.().samples ?? 0) > 0 ||
    (live.stores?.bench?.getTotals?.().samples ?? 0) > 0;

  async function putBack(record) {
    if (record?.test) return;
    const busy = current || LINK_BUSY.has(live.link?.link) || hub.parts.capture?.status?.().playing;
    if (busy || liveHasData()) {
      say('The recovered recording is in SAVED FLIGHTS. It was not put back on the live view, because the live view already has data.', 'info');
      return;
    }
    const { lines, times } = await localConsole.readLines(record.id);
    const handlers = live.consoleHandlers;
    if (!handlers || !lines.length) return;
    liveData = 'real';
    const call = (fn, ...args) => {
      try { fn?.(...args); } catch (err) { console.error('Launch mode: a recovered line could not be shown', err); }
    };
    call(handlers.onOpen);
    for (let i = 0; i < lines.length; i++) {
      call(handlers.onLine, lines[i], Number.isFinite(times?.[i]) ? times[i] : Date.now());
      if (i % RESTORE_CHUNK === RESTORE_CHUNK - 1) await new Promise((r) => { setTimeout(r, 0); });
    }
    call(handlers.onClose, { lost: false });
    restored = { id: record.id, lines: lines.length };
    say(`${fmt(lines.length)} lines from the recovered recording are back on the live view. CONNECT carries the same flight on.`, 'info');
    ctx.announce?.('The recovered recording is back on the live view.');
  }

  localConsole?.onRecovered?.((record) => {
    restoring = putBack(record)
      .catch((err) => console.error('Launch mode: the recovered recording could not go back on screen', err))
      .finally(() => { restoring = null; draw(); });
  });

  // ------------------------------------------------------------------
  // Protecting the data: leaving the page, hiding it, the screen
  // ------------------------------------------------------------------

  const linkOpen = () => LINK_BUSY.has(live.link?.link) && live.link?.link !== 'picking';

  window.addEventListener('beforeunload', (e) => {
    flush();
    if (!linkOpen() && !hub.parts.capture?.status?.().playing) return;
    e.preventDefault();
    e.returnValue = '';
  });

  window.addEventListener('pagehide', () => {
    // The cycles start their requests right away, and then what is left
    // goes in one last request that outlives the page.
    flush();
    for (const s of sessions) s.server.beacon();
    localConsole?.flushNow?.();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flush();
      localConsole?.flushNow?.();
    } else if (wantAwake) {
      takeWakeLock();
    }
  });

  let wakeLock = null;
  let wantAwake = false;
  async function takeWakeLock() {
    if (wakeLock || !globalThis.navigator?.wakeLock || document.visibilityState !== 'visible') return;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!wantAwake) {
        lock.release().catch(() => {});
        return;
      }
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    } catch {
      // Refused (battery saver, or the page isn't in front). Nothing to say.
    }
  }
  function keepAwake(on) {
    wantAwake = on;
    if (on) takeWakeLock();
    else if (wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      lock.release().catch(() => {});
    }
  }

  // ------------------------------------------------------------------
  // The status
  // ------------------------------------------------------------------

  function say(text, kind = 'info') {
    note = text ? { text, kind } : null;
    draw();
  }

  function fileState(s) {
    if (s?.disk.handle) return s.disk.state().error ? 'failing' : 'saving';
    if (!s && pendingHandle) return 'ready';
    const pick = s ? s.pick : pendingPick?.state;
    if (pick) return pick;
    if (!canPick) return 'unsupported';
    return 'none';
  }

  // The browser copy of the shown log's newest connection:
  //   'saving'   recording, every line so far stored or on its way
  //   'memory'   recording, but the browser keeps it in memory only
  //   'failing'  storing fails, and the lines wait on the page
  //   'stopped'  STOP was pressed, so the connection goes on unrecorded
  //   'kept'     the connection ended and its lines are stored
  //   'idle'     nothing recorded yet
  function browserState(s) {
    const r = localConsole?.recording?.() ?? null;
    if (!r) return { state: 'none', id: null, lines: 0 };
    const id = s?.recordingId ?? (r.active ? r.id : null);
    const lines = id && r.storedId === id ? r.storedLines : 0;
    let state = 'idle';
    if (r.active && (!id || r.id === id)) state = r.failing ? 'failing' : r.persistent === false ? 'memory' : 'saving';
    else if (r.stopped && s?.open) state = 'stopped';
    else if (id && r.storedId === id) state = r.failing ? 'failing' : 'kept';
    return { state, id: r.active ? r.id : id, lines };
  }

  // What the log is doing. status().file.lastWriteMs is when the disk file
  // was last written (ms on the computer's clock), and lastWriteAgoMs how
  // long ago that was.
  function status() {
    const s = shown();
    const disk = s?.disk.state() ?? null;
    const server = s?.server.state() ?? null;
    const now = Date.now();
    return {
      kind: s?.kind ?? 'flight',
      startedAt: s?.startedAt ?? null,
      open: Boolean(s?.open),
      lines: s?.text.dataCount ?? 0,
      logs: sessions.map((x) => ({ kind: x.kind, lines: x.text.dataCount, server: x.server.state().name, file: x.disk.state().name })),
      file: {
        state: fileState(s),
        name: disk?.name || (!s ? pendingHandle?.name ?? '' : ''),
        lines: disk?.lines ?? 0,
        bytes: disk?.bytes ?? 0,
        pending: disk?.pending ?? 0,
        lastWriteMs: disk?.lastWriteAt ?? null,
        lastWriteAgoMs: Number.isFinite(disk?.lastWriteAt) ? now - disk.lastWriteAt : null,
        cycleMs: s?.took.disk ?? null,
        error: disk?.error ? `${disk.error.name ?? 'Error'}: ${disk.error.message ?? disk.error}` : (s?.pickError ?? null),
      },
      browser: browserState(s),
      server: server ? {
        state: server.state,
        name: server.name,
        lines: server.lines,
        bytes: server.bytes,
        pending: server.pending,
        error: server.error?.message ?? null,
        cycleMs: s.took.server,
      } : { state: presence === 'absent' ? 'none' : 'unknown', name: '', lines: 0, bytes: 0, pending: 0, error: null },
      liveData,
      lostAt,
      asked,
      wakeLock: Boolean(wakeLock),
      restored,
    };
  }

  // The DOM: three rows for the copies and the line count above them.
  const slot = hub.parts.panel?.slots?.log ?? null;
  const els = {};
  if (slot) {
    // Each row: what the copy is doing, and its file's name under that.
    const row = (key, label) => {
      els[key] = h('span', { class: 'fcl-log-main' });
      els[`${key}File`] = h('span', { class: 'fcl-log-file', hidden: true });
      els[`${key}Row`] = h('div', { class: `fcl-row fcl-log-row fcl-log-row--${key}` },
        h('dt', {}, label), h('dd', { id: `fcl-log-${key}` }, els[key], els[`${key}File`]));
      return els[`${key}Row`];
    };
    els.kind = h('p', { id: 'fcl-log-kind', class: 'fcl-log-kind', hidden: true }, 'TEST CAPTURE LOG. NOT LIVE DATA.');
    els.choose = h('button', { id: 'fcl-log-choose', type: 'button', class: 'fc-bkt fc-bkt--sm', hidden: true, onclick: () => { chooseFile(); } }, 'CHOOSE FILE');
    els.note = h('p', { id: 'fcl-log-msg', class: 'fcl-msg fcl-log-msg', role: 'status', hidden: true });
    els.root = h('div', { class: 'fcl-log', 'data-kind': 'flight' },
      els.kind,
      h('dl', { class: 'fcl-rows fcl-log-rows' },
        row('lines', 'LINES'),
        row('disk', 'DISK FILE'),
        row('browser', 'BROWSER'),
        row('server', 'SERVER')),
      els.note,
      h('p', { class: 'fcl-actions fcl-log-actions' }, els.choose));
    slot.replaceChildren(els.root);
  }

  function setRow(key, text, warn, file = '') {
    setText(els[key], text);
    if (els[`${key}File`]) {
      setText(els[`${key}File`], file);
      els[`${key}File`].hidden = !file;
    }
    els[`${key}Row`].dataset.state = warn ? 'warn' : 'ok';
  }

  function render() {
    if (!slot) return;
    const st = status();
    const s = shown();
    const test = st.kind === 'test';
    els.root.dataset.kind = st.kind;
    els.kind.hidden = !test;
    setRow('lines', fmt(st.lines), false);

    // The disk file.
    const f = st.file;
    const name = f.name || '';
    let disk;
    let diskFile = '';
    let diskWarn = !test;
    if (f.state === 'saving') {
      diskWarn = false;
      disk = `${fmt(f.lines)} LINES, ${f.lastWriteAgoMs === null ? 'WRITING' : `${agoWords(f.lastWriteAgoMs)} AGO`}`;
      diskFile = name;
    } else if (f.state === 'failing') {
      diskWarn = true;
      disk = `NOT SAVING. WRITE FAILED (${s?.disk.state().error?.name ?? 'Error'}). TRYING AGAIN`;
      diskFile = name;
    } else if (f.state === 'ready') {
      diskWarn = false;
      disk = 'READY';
      diskFile = name;
    } else if (f.state === 'cancelled') {
      disk = 'NOT SAVING. NO FILE PICKED';
    } else if (f.state === 'failed') {
      disk = 'NOT SAVING. THE SAVE BOX FAILED';
    } else if (f.state === 'unsupported') {
      disk = 'NOT SAVING. THIS BROWSER CAN\'T SAVE FILES';
    } else if (!s) {
      diskWarn = false;
      disk = asked ? 'NOT SAVING. NO FILE PICKED' : 'ASKED FOR ON CONNECT';
    } else {
      disk = test ? 'NONE FOR THIS TEST' : 'NOT SAVING. NO FILE PICKED';
    }
    setRow('disk', disk, diskWarn, diskFile);
    // A failing file can be swapped for another one too.
    els.choose.hidden = !canPick || f.state === 'saving' || f.state === 'ready' || (!s && !asked);

    // The browser copy.
    const b = st.browser;
    let browser;
    let browserWarn = false;
    if (b.state === 'saving') browser = `${fmt(b.lines)} LINES`;
    else if (b.state === 'kept') browser = `${fmt(b.lines)} LINES KEPT`;
    else if (b.state === 'memory') { browser = `${fmt(b.lines)} LINES, IN MEMORY ONLY`; browserWarn = true; }
    else if (b.state === 'failing') { browser = 'NOT SAVING. STORAGE FAILED. TRYING AGAIN'; browserWarn = true; }
    else if (b.state === 'stopped') { browser = 'NOT SAVING. RECORDING STOPPED'; browserWarn = true; }
    else browser = s ? 'NOT CONNECTED' : 'STARTS ON CONNECT';
    setRow('browser', browser, browserWarn);

    // The server copy.
    const v = st.server;
    let server;
    let serverWarn = false;
    if (v.state === 'none') { server = 'NOT SAVING. NO LOCAL SERVER'; serverWarn = true; }
    else if (!s) server = presence === 'present' ? 'READY' : 'STARTS ON CONNECT';
    else if (v.state === 'failing') {
      serverWarn = true;
      server = `NOT SAVING. ${v.error && /did not answer/.test(v.error) ? 'NO ANSWER' : 'REFUSED'}. TRYING AGAIN`;
    } else if (v.state === 'unknown') server = 'STARTING';
    else server = `${fmt(v.lines)} LINES`;
    setRow('server', server, serverWarn, s && v.state !== 'none' ? `flight-logs/${v.name}` : '');

    // One plain sentence when something needs saying.
    let message = note;
    if (lostAt && !current) {
      const clock = formatLogTime(lostAt).slice(11, 19);
      message = { text: `The receiver's port was lost at ${clock}. Plug the cable back in and press CONNECT. The log carries on in the same file.`, kind: 'warn' };
    } else if (!test && (f.state === 'cancelled' || f.state === 'failed' || (f.state === 'none' && s))) {
      message = { text: 'There is no disk file, so the log is only in the copies above. CHOOSE FILE saves everything so far to a file and carries on.', kind: 'warn' };
    } else if (test && st.open) {
      message = { text: 'This log is a test capture, not live data. Its files have test-capture in their names.', kind: 'info' };
    } else if (v.state === 'none' && !note) {
      message = { text: 'This page was not opened from the launch mode server, so flight-logs has no copy. The other copies still save.', kind: 'warn' };
    }
    els.note.hidden = !message;
    if (message) {
      setText(els.note, message.text);
      els.note.dataset.kind = message.kind;
    }
  }

  const scheduler = createScheduler(render, { maxFps: STATUS_FPS });
  function draw() { scheduler.schedule(); }
  // The ages ("0.4 S AGO") move on their own.
  setInterval(draw, 500);
  render();

  // Asks the local server once whether it is there, for the status before
  // the first connection. Only this laptop is asked.
  (async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PING_TIMEOUT_MS);
    try {
      const res = await fetch(PING_URL, { cache: 'no-store', signal: abort.signal });
      const body = res.ok ? await res.json().catch(() => null) : null;
      presence = body?.app === 'dogtooth-launch-mode' ? 'present' : 'absent';
    } catch {
      presence = 'absent';
    } finally {
      clearTimeout(timer);
      draw();
    }
  })();

  // CONNECT and DISCONNECT on this page go through the log (main.js).
  live.connect = connect;
  live.disconnect = disconnect;

  return {
    status,
    useFileHandle,
    chooseFile,
    expectTest,
    liveData: () => liveData,
    clearTestData,
    flush,
    logText: () => shown()?.text.text(0, Infinity) ?? '',
    connect,
    disconnect,
  };
}
