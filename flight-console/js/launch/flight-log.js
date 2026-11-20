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
// THE SUGGESTED NAME has the minute in it. Picking a file that is already
// there makes the browser empty it, and after a crash and a quick restart
// the same minute would suggest the earlier log's own name. So the names
// this browser has suggested are remembered (localStorage), and one that
// comes up again gets -2 before ".log", then -3.
//
// A FILE THAT WAITS. A file picked before the flight log has started (the
// "press CONNECT again" path, or CHOOSE FILE after a test capture) waits
// for the flight log. A test capture never takes it.
//
// ONE TAB AT A TIME. Only one program can have the receiver's port, and
// launch-mode.bat run a second time opens a second tab. The tab that is
// connected (or reconnecting, see below) holds a Web Lock,
// fc-launch-receiver, and a tab playing a test capture holds
// fc-launch-test-capture. CONNECT asks for the lock before the save box.
// When another tab has one, this tab says so under the bar, shows no save
// box and makes no file. A tab that closes or crashes lets go by itself.
//
// A LOST PORT. A bumped cable closes the port. Nothing the receiver prints
// while it is closed reaches any copy, so the page opens it again by
// itself, with no click, no save box and no port list. It hears
// navigator.serial's "connect" event and also looks at the ports it may
// open every 2 s. It takes a port with the lost port's USB vendor and
// product ids, the one the event named first (the browser hands over a new
// port object after a replug, so the objects can't be compared). A port
// with other ids is some other board, and is never opened in the
// receiver's place. Only when the lost port had no USB ids does it take
// the event's port, else the only port it may open. An open that fails is
// tried again quietly (Windows may not be ready yet, or another program
// has the port). The log carries on in the same files, with
// "# connection closed" and "# connected" lines between. While it tries,
// the bar's button reads DISCONNECT. Pressing it stops the trying, which
// frees the port for the backup logger. It never opens a port by itself on
// a fresh page: only after a port was lost in this visit.
//
// WARNINGS UNDER THE BAR. The launch panel's rows can be scrolled out of
// sight, so what needs a person goes in two lines of the console's status
// lines under the bar, which are on screen at every window size:
//   - the local server has not answered for 5 s (its window was closed):
//     don't reload, and how to start it again. The server is asked every
//     12 s whether it is there (every second while it is not), so this
//     shows before the first CONNECT too.
//   - the port was lost and the page is reconnecting, then that it has
//   - a connected port says nothing. The receiver prints a start-up report
//     the moment its port opens, so a port with no line at all 8 s after it
//     opened is probably the wrong one (NO DATA). After that the receiver
//     prints a line at least every 5 s, also while it hears no packets
//     ("Error: No packets received for 13 s"), so one that has sent nothing
//     for 12 s may be stuck (RECEIVER SILENT). The limits are well above
//     the 5 s on purpose: a healthy receiver that waits for the rocket must
//     never set this off.
//   - another launch tab has the receiver
// Each one clears by itself when it is no longer true.
//
// WRITING. Lines collect in memory (one log text per log) and each copy
// adds the new ones about once a second, one cycle at a time, never two at
// once. A cycle that fails keeps its lines and the next one tries again,
// so nothing is dropped or put out of order. The disk file is opened,
// added to and closed again each cycle, because the browser only puts what
// was written into the real file when it is closed. When the page is hidden
// or closing, every copy is written at once, and the server gets one last
// request that outlives the page (navigator.sendBeacon). The spacing
// between cycles holds when Windows sets the clock back (isDue() in
// log-sinks.js), and the ages the status shows are measured on a clock
// that only goes forward.
//
// ONE LOG PER VISIT for the flight: every real connection of the visit goes
// in the same files. A played test capture (capture.js) gets a log of its
// own, named test-capture-..., so test data is never taken for the flight.
// When a real connection opens after a test capture, the live stores are
// cleared of it, so the test's track never joins the flight's. (The
// capture the panel plays fills the flight store. A flight log in the
// receiver's newer format, played with ?capture=, fills the bench store.)
//
// RECOVER. When RECOVER saves a recording a crash left behind, its lines are
// played back into the live view through the console's own handlers (not
// the recorder and not this log, so nothing is stored twice). The track,
// the last fix and the launch panel come back, and the same flight carries
// on. That happens while the live view has no data yet, also when CONNECT
// was pressed first and the port is already open, and never for a test
// capture. With a port open the lines go back in one go, so no new line
// can land between the old ones. When the live view already has data, the
// status says that the recording is in SAVED FLIGHTS and why it stayed
// there.
//
// ALSO, on this page only: the browser asks before the tab closes or
// reloads while a port is open, a test capture plays, the page is
// reconnecting or the local server does not answer (the page can't load
// again without it). The screen is kept awake while connected (a wake lock,
// taken again when the page shows again, and nothing is said if the
// browser refuses it).
//
// createFlightLog({ hub, ctx }) -> hub.parts.log:
//   status()               what the log is doing (see status() below)
//   useFileHandle(handle)  writes the log to this FileSystemFileHandle from
//                          now on, everything so far first. For the tests,
//                          which can't drive the save box: a handle from
//                          navigator.storage.getDirectory() runs the same
//                          code. It goes where CHOOSE FILE's file would go.
//                          Resolves true once the file has every line the
//                          log held when it was given (more may have come
//                          in since), false when that write failed or the
//                          file waits for the flight log to start.
//   chooseFile()           what CHOOSE FILE does
//   expectTest({ notes })  capture.js: the next connection is a test capture
//   claimTest()            capture.js: resolves false when another launch
//                          tab is connected or playing (see otherTabNote())
//   otherTabNote()         what the page says about that other tab
//   reconnecting()         true while the page is opening a lost port again
//   liveData()             what the live view holds: 'none', 'test' or 'real'
//   liveHasData()          true when either live store has samples. The
//                          receiver's older firmware fills the flight store
//                          and its newer one the bench store (it prints a
//                          Dogtooth board's status blocks), so "is there a
//                          flight on the live view" has to ask both.
//   clearTestData()        clears the live stores of test data
//   flush({ urgent })      runs every copy's cycle now
//   logText()              the shown log's whole text (for the tests)
//   connect(), disconnect()   what CONNECT and DISCONNECT do on this page
//
// Used by: js/launch/launch-mode.js (startLaunchMode). Launch page only.

import { h, setText, createScheduler } from '../views/dom.js?v=2';
import { formatLogTime, dataLine, noteLine, headerLines, logFileName, freshPickName, createLogText } from './log-format.js';
import { createDiskSink, createServerSink, isDue, steadyClock } from './log-sinks.js';

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
// How long (ms) the local server gets to answer "are you there".
const PING_TIMEOUT_MS = 3000;
// How often (ms) it is asked, and how often while it does not answer or its
// copy is failing. (A server that is not there refuses in a few ms, so
// asking every second costs nothing and finds it back within a second.)
const PING_EVERY_MS = 12000;
const PING_FAST_MS = 1000;
// A server that has been silent, or a server copy that has been failing,
// for this long (ms) gets the warning under the bar.
const SERVER_WARN_MS = 5000;
// A receiver that hears no packets prints one line every 5 s ("Error: No
// packets received for 13 s", or the Error line of a radio that did not
// start), and with packets one status block for each. That 5 s is
// kGpsSilentRepeatMs and kRadioRetryIntervalMs in DEKEL_RX_FIRMWARE's
// include/Config.h. On the real board those lines came 4.995 to 5.563 s
// apart, so a limit of 5 s went off on a healthy receiver. An open port
// that has sent lines and then nothing for this long (ms), two missed
// lines and some room, gets the RECEIVER SILENT warning under the bar.
const SILENT_MS = 12000;
// The receiver prints its start-up report as soon as a program opens its
// port, and its first waiting line within 5 s. A port that has sent nothing
// at all this long (ms) after it opened gets the NO DATA warning.
const NO_DATA_MS = 8000;
// While a port is lost: how often (ms) the page looks at the ports it may
// open, and how long it waits after an open that failed.
const RECONNECT_LOOK_MS = 2000;
const RECONNECT_RETRY_MS = 1500;
// Failed opens in a row before the warning says the port will not open.
const RECONNECT_STUCK_TRIES = 3;
// After this long (ms) without a port to try, the warning also says how to
// pick the port by hand.
const RECONNECT_HINT_MS = 20000;
// The Web Locks that say which launch tab has the receiver or plays a test
// capture, and how often (ms) this tab looks at who holds them.
const RECEIVER_LOCK = 'fc-launch-receiver';
const TEST_LOCK = 'fc-launch-test-capture';
const LOCK_LOOK_MS = 2000;
// Where the names the save box has suggested are kept (localStorage), and
// how many of them.
const NAMES_KEY = 'fc-launch-log-names';
const NAMES_KEPT = 200;
// A recovered recording goes back on screen this many lines at a time, so
// the page keeps answering while a long one plays back.
const RESTORE_CHUNK = 400;
// The status redraws at most this often (times a second).
const STATUS_FPS = 8;

const LINK_BUSY = new Set(['picking', 'opening', 'open', 'closing']);
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
// "14:03:22": a time of day on the computer's clock.
const clockOf = (ms) => formatLogTime(ms).slice(11, 19);

// "0.4 S", "12 S", "3 MIN": how long ago, for the status. '' when it isn't
// known.
function agoWords(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)} S`;
  if (s < 120) return `${Math.round(s)} S`;
  return `${Math.round(s / 60)} MIN`;
}

// "1 second", "19 seconds", "3 minutes": a length of time, for a sentence.
function spanWords(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 120) return `${s} second${s === 1 ? '' : 's'}`;
  return `${Math.round(s / 60)} minutes`;
}

export function createFlightLog({ hub, ctx }) {
  const live = ctx.live;
  const localConsole = ctx.localConsole ?? null;
  const canPick = typeof globalThis.showSaveFilePicker === 'function';
  const serial = globalThis.navigator?.serial ?? null;
  const locks = globalThis.navigator?.locks ?? null;

  const sessions = [];       // every log this visit, oldest first
  let current = null;        // the log lines go to now (a connection is open), or null
  let flight = null;         // this visit's flight log, made at the first real connection
  let pendingHandle = null;  // a file picked before the flight log started. It waits for the flight log
  let pendingPick = null;    // how the save box went before the flight log started
  let asked = false;         // the save box for the flight was shown this visit
  let testNext = null;       // { notes } from capture.js for the next connection
  let liveData = 'none';     // what the live view holds: 'none', 'test' or 'real'
  let lostAt = null;         // when the port was lost (ms), until the next real connection
  let lastPort = null;       // the port the last real connection used
  let lastInfo = null;       // its USB ids, { vendor, product }, to find it again after a replug
  let pickPortNext = false;  // DISCONNECT was pressed: the next CONNECT shows the port list
  let connecting = false;
  let conn = null;           // the open real connection: { openTick, lastTick, lines, again }
  let reconnect = null;      // the page is opening a lost port again by itself (see startReconnect())
  let back = null;           // { lostAt, at, tries } the last time that worked
  let restoring = null;      // a recovered recording going back on screen
  let restored = null;       // { id, lines } the last one that did
  let presence = 'unknown';  // the local server: 'unknown', 'present', 'absent' (something else answers) or 'down' (no answer)
  let downTick = null;       // since when it has not answered, on the steady clock
  let lastPingTick = -Infinity;
  let pinging = false;
  let note = null;           // { text, kind } a sentence under the status
  let flashed = null;        // { tag, text } a note under the bar that stays until HIDE
  const held = new Map();    // lock name -> the function that lets go of it, for the locks this tab holds
  const asking = new Map();  // lock name -> the promise of a request on its way
  const unwanted = new Set();   // locks let go of while their request was still on its way
  let others = new Set();    // the launch locks other tabs hold, from the last look

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
      serverFailTick: null,       // since when its server copy has been failing, on the steady clock
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
    return isDue(Date.now(), sink.lastStartAt, gap);
  }

  function serverDue(s) {
    const sink = s.server;
    const st = sink.state();
    if (st.busy || st.state === 'none') return false;
    if (!st.pending && st.state === 'saving') return false;
    const gap = st.state === 'failing'
      ? Math.min(RETRY_MAX_MS, CYCLE_MS * 2 ** Math.min(sink.failures, 4))
      : Math.max(CYCLE_MS, 2 * s.took.server);
    return isDue(Date.now(), sink.lastStartAt, gap);
  }

  function runCycle(s, which, urgent = false) {
    const began = steadyClock();
    return s[which].cycle({ urgent }).then((ok) => {
      s.took[which] = Math.round(steadyClock() - began);
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
    watchServer();
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
  // The local server: is it still there?
  // ------------------------------------------------------------------

  // Asks the server who it is. Only this laptop is asked. 'present' is the
  // launch mode server, 'absent' something else at this address, and 'down'
  // no answer at all (its window was closed).
  async function ping() {
    if (pinging) return;
    pinging = true;
    const began = steadyClock();
    lastPingTick = began;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PING_TIMEOUT_MS);
    let next = 'down';
    try {
      const res = await fetch(PING_URL, { cache: 'no-store', signal: abort.signal });
      const body = res.ok ? await res.json().catch(() => null) : null;
      next = body?.app === 'dogtooth-launch-mode' ? 'present' : 'absent';
    } catch {
      next = 'down';
    } finally {
      clearTimeout(timer);
      pinging = false;
    }
    presence = next;
    if (next !== 'down') downTick = null;
    else if (downTick === null) downTick = began;
    // The server answers: a copy that was failing catches up now, without
    // waiting out its own spacing between tries.
    if (next === 'present') {
      for (const s of sessions) {
        if (s.server.state().state === 'failing') runCycle(s, 'server');
      }
    }
    draw();
  }

  // Runs with the pump. Notes since when each server copy has been failing,
  // and asks the server again when it is time: every PING_EVERY_MS, and
  // every PING_FAST_MS while it does not answer or a copy is failing.
  function watchServer() {
    const now = steadyClock();
    let failing = false;
    for (const s of sessions) {
      const bad = s.server.state().state === 'failing';
      if (!bad) s.serverFailTick = null;
      else if (s.serverFailTick === null) s.serverFailTick = now;
      failing = failing || bad;
    }
    const every = presence === 'down' || failing ? PING_FAST_MS : PING_EVERY_MS;
    if (now - lastPingTick >= every) ping();
  }

  // What is wrong with the server's copy, once it has been wrong for
  // SERVER_WARN_MS: 'stopped' (no answer), 'refusing' (it answers, and its
  // copy still fails) or null.
  function serverTrouble() {
    const now = steadyClock();
    if (presence === 'down' && downTick !== null && now - downTick > SERVER_WARN_MS) return 'stopped';
    if (presence === 'present' && sessions.some((s) => s.serverFailTick !== null && now - s.serverFailTick > SERVER_WARN_MS)) return 'refusing';
    return null;
  }

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
      takeLock(TEST_LOCK);
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
      // A file that waited is the flight's. A test capture never gets here.
      if (pendingHandle) {
        session.disk.use(pendingHandle);
        pendingHandle = null;
      }
      lastPort = live.link?.port ?? lastPort;
      lastInfo = portInfo(lastPort);
      pickPortNext = false;
      // again: this is the lost port, opened again by the page itself and
      // told by its USB ids, so it is known to be the receiver's.
      conn = { openTick: steadyClock(), lastTick: null, lines: 0, again: Boolean(reconnect) && lastInfo.vendor !== null };
      if (reconnect) cameBack();
      lostAt = null;
      takeLock(RECEIVER_LOCK);
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
    if (conn && s.kind === 'flight') {
      conn.lastTick = steadyClock();
      conn.lines += 1;
    }
    pump();
    draw();
  });

  hub.link.onClose(({ lost } = {}) => {
    const s = current;
    current = null;
    conn = null;
    if (s) {
      s.open = false;
      s.text.add(noteLine(`connection closed ${formatLogTime(Date.now())}`));
      if (lost && s.kind === 'flight') {
        lostAt = Date.now();
        startReconnect();
      }
    }
    // The screen stays awake while the page waits for the port to come back.
    keepAwake(Boolean(reconnect));
    syncLocks();
    if (!s) return;
    flush();
    draw();
  });

  // ------------------------------------------------------------------
  // One tab at a time (see ONE TAB AT A TIME at the top)
  // ------------------------------------------------------------------

  // This tab's own id among the lock holders. It is read off a lock only
  // this tab asks for, which it keeps for as long as it lives. With it a
  // look at the locks can tell this tab's from another tab's, also in the
  // moment after this tab let one go, when the browser still lists it.
  const TAB_LOCK = `fc-launch-tab-${Math.random().toString(36).slice(2, 10)}`;
  try {
    locks?.request?.(TAB_LOCK, () => new Promise(() => {}))?.catch?.(() => {});
  } catch {
    // No Web Locks here. Nothing is claimed about other tabs then.
  }

  // Takes a lock if no tab holds it. Resolves true when this tab holds it
  // now (or the browser has no Web Locks), false when it is not free.
  function takeLock(name) {
    unwanted.delete(name);
    if (!locks?.request || held.has(name)) return Promise.resolve(true);
    if (asking.has(name)) return asking.get(name);
    const request = new Promise((resolve) => {
      locks.request(name, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        // Let go of while the request was still on its way: not kept.
        if (unwanted.delete(name)) {
          resolve(true);
          return undefined;
        }
        // Held until dropLock() lets it go, or the tab closes.
        return new Promise((release) => {
          held.set(name, release);
          resolve(true);
        });
      }).catch(() => resolve(true));
    }).finally(() => { asking.delete(name); });
    asking.set(name, request);
    return request;
  }

  function dropLock(name) {
    const release = held.get(name);
    if (release) {
      held.delete(name);
      release();
    } else if (asking.has(name)) {
      // The request is still on its way. It is let go when it arrives.
      unwanted.add(name);
    }
  }

  const capturing = () => (hub.parts.capture?.status?.().state ?? 'idle') !== 'idle';

  // Lets go of the locks this tab no longer needs.
  function syncLocks() {
    if (!connecting && !reconnect && current?.kind !== 'flight') dropLock(RECEIVER_LOCK);
    if (current?.kind !== 'test' && !capturing()) dropLock(TEST_LOCK);
  }

  // Looks at which launch locks other tabs hold. Resolves with their names.
  async function lookForOthers() {
    if (!locks?.query) return others;
    try {
      const q = await locks.query();
      const all = q.held ?? [];
      const me = all.find((lock) => lock.name === TAB_LOCK)?.clientId ?? null;
      const names = new Set();
      for (const lock of all) {
        if (lock.name !== RECEIVER_LOCK && lock.name !== TEST_LOCK) continue;
        // By this tab's id when the browser gives one. Until then, by what
        // this tab holds or has asked for.
        const mine = me !== null && lock.clientId ? lock.clientId === me : held.has(lock.name) || asking.has(lock.name);
        if (!mine) names.add(lock.name);
      }
      const changed = names.size !== others.size || [...names].some((n) => !others.has(n));
      others = names;
      if (changed) draw();
    } catch {
      // The browser would not say. Nothing is known, so nothing is claimed.
    }
    return others;
  }

  // What the page says while another launch tab has the receiver.
  function otherTabNote() {
    return others.has(TEST_LOCK) && !others.has(RECEIVER_LOCK)
      ? 'Another launch tab on this laptop is playing a test capture. Use that tab and close this one.'
      : 'Another launch tab on this laptop is connected to the receiver. Use that tab and close this one.';
  }

  // Asks for a lock before this tab connects or plays. Resolves false when
  // another launch tab is connected or playing, and the line under the bar
  // then says so.
  async function claim(name) {
    let free = false;
    // A lock this tab let go of a moment ago can still be on its way out.
    // So when the lock is not free and no other tab is seen with one, it is
    // asked for again, up to three times in all.
    for (let tries = 0; tries < 3 && !free; tries += 1) {
      if (tries) await new Promise((r) => { setTimeout(r, 100); });
      if ((await lookForOthers()).size) break;
      free = await takeLock(name);
    }
    if (!free) {
      // Not free, and the browser did not say who has it.
      if (!others.size) others = new Set([name]);
      ctx.announce?.(otherTabNote());
      draw();
    }
    return free;
  }

  // ------------------------------------------------------------------
  // A lost port: the page opens it again by itself
  // ------------------------------------------------------------------

  // A port's USB vendor and product ids, or nulls for a port without them.
  function portInfo(port) {
    try {
      const info = port?.getInfo?.() ?? {};
      return { vendor: info.usbVendorId ?? null, product: info.usbProductId ?? null };
    } catch {
      return { vendor: null, product: null };
    }
  }

  // The port to open again, from the ones the page may open, or null when
  // none of them is clearly the receiver's.
  function reconnectPort(ports, r) {
    const plugged = r.eventPort && ports.includes(r.eventPort) ? r.eventPort : null;
    // The receiver is a USB board, so the lost port had USB ids, and only
    // a port with the same ids can be the receiver. (The browser hands
    // over a new port object after a replug, so the objects themselves
    // can't be compared.) Some other board this browser was once given,
    // still plugged in while the receiver's cable is out, is never opened
    // in its place. Of two that fit, the one just plugged in comes first.
    if (lastInfo && lastInfo.vendor !== null) {
      const fits = ports.filter((p) => {
        const info = portInfo(p);
        return info.vendor === lastInfo.vendor && info.product === lastInfo.product;
      });
      return plugged && fits.includes(plugged) ? plugged : fits[0] ?? null;
    }
    // A lost port without ids: the port the browser just said was plugged
    // in, else the only port the page may open.
    if (plugged) return plugged;
    return ports.length === 1 ? ports[0] : null;
  }

  // Starts when a real connection's port was lost, never on a fresh page.
  //   tries       opens tried so far
  //   fails       opens that failed in a row
  //   seen        how many ports the page could open at the last look
  //   eventPort   the port from the newest "connect" event
  //   back        the port is open again (cameBack())
  function startReconnect() {
    if (reconnect || !serial || !live.link?.supported) return;
    reconnect = { sinceTick: steadyClock(), tries: 0, fails: 0, seen: 0, eventPort: null, timer: null, busy: false, again: false, back: false };
    flashed = null;
    reconnect.timer = setTimeout(tryReconnect, RECONNECT_LOOK_MS);
    // The bench panel writes CONNECT on the button right after this.
    queueMicrotask(showButton);
    draw();
  }

  async function tryReconnect() {
    const r = reconnect;
    if (!r) return;
    if (r.busy) {
      r.again = true;
      return;
    }
    clearTimeout(r.timer);
    r.busy = true;
    let wait = RECONNECT_LOOK_MS;
    try {
      // A recovered recording that is still going back on screen finishes first.
      if (restoring) await restoring;
      const link = live.link;
      const ports = await link.granted();
      if (reconnect !== r) return;
      r.seen = ports.length;
      const port = reconnectPort(ports, r);
      if (port && !connecting && !capturing() && !LINK_BUSY.has(link.link)) {
        r.tries += 1;
        const opened = await link.connect({ port, quiet: true, still: () => reconnect === r });
        if (opened) {
          // onOpen has ended the reconnect (cameBack()). Unless DISCONNECT
          // was pressed in the instant the port opened: then it is closed
          // again, so the port is free, as the note under the bar says.
          if (!r.back) {
            pickPortNext = true;
            await link.disconnect();
          }
          return;
        }
        r.fails += 1;
        wait = RECONNECT_RETRY_MS;
      } else if (!port) {
        r.fails = 0;
      }
    } catch (err) {
      console.warn('Launch mode: the lost port could not be opened again yet', err);
    } finally {
      r.busy = false;
      if (reconnect === r) {
        r.timer = setTimeout(tryReconnect, r.again ? 0 : wait);
        r.again = false;
        draw();
      }
    }
  }

  // The browser says a port this page may open was plugged in.
  function onSerialConnect(e) {
    const r = reconnect;
    if (!r) return;
    const port = [e?.target, e?.port].find((p) => p && typeof p.open === 'function') ?? null;
    if (port) r.eventPort = port;
    tryReconnect();
  }
  try { serial?.addEventListener?.('connect', onSerialConnect); } catch { /* no such event here: the 2 s look still finds the port */ }

  // The port is open again (called from onOpen).
  function cameBack() {
    const r = reconnect;
    reconnect = null;
    r.back = true;
    clearTimeout(r.timer);
    const now = Date.now();
    back = { lostAt, at: now, tries: r.tries };
    const text = `The receiver's port was lost at ${clockOf(lostAt ?? now)}. The page reconnected by itself ${spanWords(steadyClock() - r.sinceTick)} later, at ${clockOf(now)}. The log carries on in the same files.`;
    flashed = { tag: 'RECEIVER BACK', text };
    showButton();
  }

  // DISCONNECT while the page is trying.
  function stopReconnect() {
    const r = reconnect;
    if (!r) return;
    reconnect = null;
    clearTimeout(r.timer);
    pickPortNext = true;
    flashed = { tag: 'RECEIVER', text: 'The page stopped trying to reconnect, so the receiver\'s port is free. Press CONNECT to connect again. The log carries on in the same files.' };
    keepAwake(false);
    syncLocks();
    showButton();
    draw();
  }

  // A real connection that has gone silent: null, or { ms, any }. ms is how
  // long nothing has arrived. any says whether this port is known to be the
  // receiver's: a line came on this connection, or it is the lost port that
  // the page opened again and told by its USB ids. Without that it may be
  // the wrong port, and the shorter limit applies (see NO_DATA_MS).
  function quiet() {
    if (!conn || current?.kind !== 'flight') return null;
    const ms = steadyClock() - (conn.lastTick ?? conn.openTick);
    const any = conn.lines > 0 || conn.again;
    return ms > (any ? SILENT_MS : NO_DATA_MS) ? { ms, any } : null;
  }

  // ------------------------------------------------------------------
  // CONNECT, DISCONNECT and the save box
  // ------------------------------------------------------------------

  // Says something on the line under the bar, the way the serial link does.
  const barNote = (text, kind = 'info') => {
    try { live.handlers?.onNote?.(text, kind); } catch { /* the panel isn't there */ }
  };

  // The link's own two notes, in this page's words. A lost port has the
  // RECEIVER LOST line under the bar, so the link says nothing more. And at
  // the field the other program is most likely the backup logger.
  live.link?.useNotes?.({
    lost: '',
    busy: 'The port didn\'t open. Another program is probably using it. Close the backup logger or any serial monitor, then press CONNECT again.',
  });

  // The port to open without asking, or null to show the port list.
  function grantedPort(ports) {
    if (!ports.length || pickPortNext) return null;
    if (lastPort && ports.includes(lastPort)) return lastPort;
    return ports.length === 1 ? ports[0] : null;
  }

  async function connect() {
    const link = live.link;
    // While the page reconnects by itself the bar's button reads
    // DISCONNECT, and this is what it does.
    if (reconnect) {
      stopReconnect();
      return;
    }
    if (!link || connecting || LINK_BUSY.has(link.link)) return;
    connecting = true;
    flashed = null;
    try {
      // Another launch tab may have the receiver. Asked before the save
      // box, so this tab shows no box and leaves no empty file.
      if (!(await claim(RECEIVER_LOCK))) return;
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
      syncLocks();
      draw();
    }
  }

  function disconnect() {
    const capture = hub.parts.capture;
    if (capture?.status?.().playing) return capture.stop();
    flashed = null;
    if (reconnect) {
      stopReconnect();
      return undefined;
    }
    pickPortNext = true;
    return live.link?.disconnect();
  }

  // The names the save box has suggested or been given (see THE SUGGESTED
  // NAME at the top).
  function usedNames() {
    try {
      const list = JSON.parse(globalThis.localStorage?.getItem(NAMES_KEY) ?? '[]');
      return Array.isArray(list) ? list.filter((n) => typeof n === 'string') : [];
    } catch {
      return [];
    }
  }
  function saveNames(list) {
    try { globalThis.localStorage?.setItem(NAMES_KEY, JSON.stringify(list.slice(-NAMES_KEPT))); } catch { /* storage is off */ }
  }
  const rememberName = (name) => saveNames([...usedNames().filter((n) => n !== name), name]);
  const forgetName = (name) => saveNames(usedNames().filter((n) => n !== name));

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
    const suggested = freshPickName(session?.pickName ?? logFileName(kind, Date.now(), 'pick'), usedNames());
    // Remembered before the box opens, so a crash right after the pick
    // can't lose it.
    rememberName(suggested);
    try {
      const handle = await globalThis.showSaveFilePicker({
        suggestedName: suggested,
        types: [{ description: 'Flight log', accept: { 'text/plain': ['.log'] } }],
        id: 'dogtooth-flight-log',
      });
      if (handle?.name && handle.name !== suggested) rememberName(handle.name);
      mark(null);
      return handle;
    } catch (err) {
      // No file was made under that name, so it is free again.
      forgetName(suggested);
      if (err?.name === 'AbortError') mark('cancelled');
      else {
        console.warn('Launch mode: the save box failed', err);
        mark('failed', err?.message ?? String(err));
      }
      return null;
    }
  }

  // Gives a log its file and writes everything so far into it. Resolves
  // true once the file has every line the log held at this moment.
  function useOn(session, handle) {
    session.disk.use(handle);
    session.pick = null;
    session.pickError = null;
    const had = session.text.count;
    draw();
    return runCycle(session, 'disk', true).then(() => {
      const st = session.disk.state();
      return !st.error && session.text.count - st.pending >= had;
    });
  }

  // The log a file picked now is for: a test capture's own log while it
  // plays, otherwise the flight log, or null for the flight log to come.
  function chooseTarget() {
    const s = shown();
    if (s?.kind === 'test' && s.open) return s;
    return flight;
  }

  // CHOOSE FILE: a file for that log.
  async function chooseFile() {
    const target = chooseTarget();
    const handle = await askForFile(target, target?.kind ?? 'flight');
    // A box cancelled here, before the flight log has started, settles
    // nothing: CONNECT still asks where to save.
    if (!handle) return false;
    if (target) return useOn(target, handle);
    // The flight's file is picked, so CONNECT does not ask again.
    asked = true;
    pendingHandle = handle;
    draw();
    return false;
  }

  // The tests' way in (see the top of this file).
  function useFileHandle(handle) {
    if (!handle || typeof handle.createWritable !== 'function' || typeof handle.getFile !== 'function') {
      throw new TypeError('useFileHandle needs a FileSystemFileHandle');
    }
    const target = chooseTarget();
    if (target) return useOn(target, handle);
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
    // A capture in the receiver's newer format (a flight log played back
    // with ?capture=) puts its status blocks in the bench store. While the
    // live view holds test data no real packet is in either store (the
    // capture refuses to play over real ones), so what the bench store has
    // is the test's. Its feed starts over the way it does for a board that
    // restarted, which empties the store and keeps the board.
    if ((live.stores?.bench?.getTotals?.().samples ?? 0) > 0) live.feed?.restart?.();
    liveData = 'none';
  }

  // capture.js calls this right before its onOpen.
  function expectTest(info = {}) {
    testNext = { notes: Array.isArray(info.notes) ? info.notes.map(String) : [] };
  }

  // ------------------------------------------------------------------
  // RECOVER: a recovered recording back on the live view
  // ------------------------------------------------------------------

  // Either live store has samples (see liveHasData() at the top). The test
  // capture asks this too before it plays (capture.js).
  const liveHasData = () => (live.stores?.flight?.getTotals?.().samples ?? 0) > 0 ||
    (live.stores?.bench?.getTotals?.().samples ?? 0) > 0;
  // A port is open or opening right now.
  const linked = () => Boolean(current) || LINK_BUSY.has(live.link?.link);

  // Why a recovered recording can't go on the live view now, or ''.
  function keptOff() {
    if (current?.kind === 'test' || capturing()) return 'because a test capture is playing';
    // A finished test's data gives way to a real flight.
    if (liveData === 'test') return '';
    if (liveHasData()) return 'because the live view already has data from this visit, and the two would mix';
    return '';
  }

  async function putBack(record) {
    if (record?.test) return;
    const refuse = (why) => tell(`The recovered recording is saved in SAVED FLIGHTS as "${record.title}". It was not put back on the live view, ${why}. Open it from SAVED FLIGHTS to see it.`);
    let why = keptOff();
    if (why) {
      refuse(why);
      return;
    }
    const { lines, times } = await localConsole.readLines(record.id);
    const handlers = live.consoleHandlers;
    if (!handlers || !lines.length) return;
    // Data may have come in while the lines were read.
    why = keptOff();
    if (why) {
      refuse(why);
      return;
    }
    if (liveData === 'test') clearTestData();
    liveData = 'real';
    const call = (fn, ...args) => {
      try { fn?.(...args); } catch (err) { console.error('Launch mode: a recovered line could not be shown', err); }
    };
    call(handlers.onOpen);
    for (let i = 0; i < lines.length; i++) {
      call(handlers.onLine, lines[i], Number.isFinite(times?.[i]) ? times[i] : Date.now());
      // With a port open it all goes back in one go, so no new line lands
      // between the old ones. With none, the page keeps answering.
      if (i % RESTORE_CHUNK === RESTORE_CHUNK - 1 && !linked()) await new Promise((r) => { setTimeout(r, 0); });
    }
    // With a port open, its lines follow as a new connection's (the console
    // works out the source again). With none, the old connection has ended.
    if (linked()) call(handlers.onOpen);
    else call(handlers.onClose, { lost: false });
    restored = { id: record.id, lines: lines.length };
    const next = current ? 'The flight carries on from here.'
      : asked ? 'CONNECT carries the same flight on.'
        : 'CONNECT carries the same flight on in a new log file. Keep the new name the save box suggests, because picking the earlier file would empty it.';
    tell(`${fmt(lines.length)} lines from the recovered recording are back on the live view. ${next}`);
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
    // Without the local server the page can't load again, so the browser
    // asks then too.
    if (!linkOpen() && !hub.parts.capture?.status?.().playing && !reconnect && presence !== 'down') return;
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

  // The same sentence under the log's rows and under the bar (until HIDE),
  // and read out once.
  function tell(text) {
    flashed = { tag: 'RECOVERED', text };
    ctx.announce?.(text);
    say(text, 'info');
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

  // The two lines under the bar (see WARNINGS UNDER THE BAR at the top):
  // { server, receiver }, each null or { tag, kind, text, hide }. kind is
  // 'warn' or 'info', and hide is true for a note that stays until HIDE.
  function alerts() {
    const out = { server: null, receiver: null };

    const trouble = serverTrouble();
    if (trouble) {
      const s = shown();
      const disk = Boolean(current) && fileState(s) === 'saving';
      const browser = Boolean(current) && browserState(s).state === 'saving';
      const still = disk && browser ? ' The disk file and the browser copy are still saving.'
        : browser ? ' The browser copy is still saving.'
          : disk ? ' The disk file is still saving.'
            : current ? ' No copy of the log is saving right now.' : '';
      out.server = trouble === 'stopped'
        ? { tag: 'SERVER STOPPED', kind: 'warn', text: `The launch mode server has stopped.${still} Do not reload or close this page. Double-click launch-mode.bat to start the server again, then close the extra tab that opens and come back to this one.` }
        : { tag: 'SERVER COPY', kind: 'warn', text: `The launch mode server answers, but it is not saving its copy of the log.${still} The server's window says why.` };
    }

    const q = quiet();
    if (others.size && !current && !reconnect) {
      out.receiver = { tag: 'OTHER TAB', kind: 'warn', text: otherTabNote() };
    } else if (reconnect) {
      const r = reconnect;
      const lost = `The receiver's port was lost at ${clockOf(lostAt ?? Date.now())}.`;
      let text;
      if (r.fails >= RECONNECT_STUCK_TRIES) {
        text = `${lost} It is plugged in, but it will not open. Another program may be using it, so close the backup logger or any serial monitor. The page keeps trying by itself. Press DISCONNECT to stop it.`;
      } else {
        text = `${lost} The page is trying to reconnect by itself, so check the cable and plug it back in. The log carries on in the same files. Press DISCONNECT to stop it and free the port.`;
        if (steadyClock() - r.sinceTick > RECONNECT_HINT_MS) text += ' If it is plugged in and this line stays, press DISCONNECT, then CONNECT, and pick the receiver\'s port.';
      }
      out.receiver = { tag: 'RECEIVER LOST', kind: 'warn', text };
    } else if (q) {
      out.receiver = q.any
        ? { tag: 'RECEIVER SILENT', kind: 'warn', text: `The receiver has sent nothing for ${spanWords(q.ms)}. It prints a line at least every 5 seconds, so it may be stuck. Unplug it and plug it back in. The page reconnects by itself.` }
        : { tag: 'NO DATA', kind: 'warn', text: `Nothing has come from this port in ${spanWords(q.ms)}. It may be the wrong port. Press DISCONNECT, then CONNECT, and pick the receiver's port.` };
    } else if (flashed) {
      out.receiver = { tag: flashed.tag, kind: 'info', text: flashed.text, hide: true };
    }
    return out;
  }

  // What the log is doing. status().file.lastWriteMs is when the disk file
  // was last written (ms on the computer's clock), and lastWriteAgoMs how
  // long ago that was (measured on a clock that only goes forward).
  function status() {
    const s = shown();
    const disk = s?.disk.state() ?? null;
    const server = s?.server.state() ?? null;
    const q = quiet();
    return {
      kind: s?.kind ?? 'flight',
      startedAt: s?.startedAt ?? null,
      open: Boolean(s?.open),
      lines: s?.text.dataCount ?? 0,
      logs: sessions.map((x) => ({ kind: x.kind, lines: x.text.dataCount, server: x.server.state().name, file: x.disk.state().name })),
      file: {
        state: fileState(s),
        name: disk?.name || (!s ? pendingHandle?.name ?? '' : ''),
        // A file picked for the flight log that has not started yet.
        waiting: pendingHandle?.name ?? null,
        lines: disk?.lines ?? 0,
        bytes: disk?.bytes ?? 0,
        pending: disk?.pending ?? 0,
        lastWriteMs: disk?.lastWriteAt ?? null,
        lastWriteAgoMs: disk?.lastWriteAgoMs ?? null,
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
      // The local server itself: 'unknown', 'present', 'absent' or 'down'.
      presence,
      // The connection: whether the page is reconnecting by itself (and how
      // many opens it has tried), the last time that worked, a connected
      // port that has gone silent ({ ms, any }), and the launch locks other
      // tabs and this tab hold.
      link: {
        reconnecting: Boolean(reconnect),
        tries: reconnect?.tries ?? 0,
        back,
        quiet: q ? { ms: Math.round(q.ms), any: q.any } : null,
        otherTab: others.size ? [...others] : null,
        locks: [...held.keys()],
      },
      // The two lines under the bar, each null or { tag, kind, text }.
      alerts: alerts(),
      liveData,
      lostAt,
      asked,
      wakeLock: Boolean(wakeLock),
      restored,
    };
  }

  // The DOM: two lines under the bar, and in the launch panel the line
  // count with three rows for the copies under it.
  function barLine(id) {
    const tag = h('span', { class: 'fc-status-tag' });
    const text = h('span', {});
    const hide = h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm fc-status-close', hidden: true, 'aria-label': 'Hide this note' }, 'HIDE');
    const el = h('div', { id, class: 'fc-status-line fcl-alert', hidden: true }, h('p', { class: 'fc-status-text' }, tag, ' ', text), hide);
    return { el, tag, text, hide, said: '' };
  }
  const bar = { server: barLine('fcl-server-alert'), receiver: barLine('fcl-receiver-alert') };
  bar.receiver.hide.addEventListener('click', () => {
    flashed = null;
    draw();
  });
  ctx.root?.querySelector('.fc-status')?.prepend(bar.server.el, bar.receiver.el);

  function showBarLine(line, alert) {
    line.el.hidden = !alert;
    if (!alert) {
      line.said = '';
      return;
    }
    setText(line.tag, alert.tag);
    setText(line.text, alert.text);
    line.el.dataset.kind = alert.kind;
    line.hide.hidden = !alert.hide;
    // Read out once when it appears, not at every second of its count.
    if (line.said !== alert.tag) {
      line.said = alert.tag;
      ctx.announce?.(alert.text);
    }
  }

  // The bar's button. While the page reconnects by itself it reads
  // DISCONNECT, and pressing it stops that (see connect()). The bench panel
  // writes the button's word at every change of the link, so this runs with
  // every draw.
  const buttonText = document.getElementById('bc-connect-text');
  let buttonMine = false;
  function showButton() {
    if (!buttonText) return;
    if (reconnect) {
      buttonMine = true;
      setText(buttonText, 'DISCONNECT');
    } else if (buttonMine) {
      buttonMine = false;
      // An open link has the panel's own DISCONNECT. Any other gets CONNECT back.
      if (!LINK_BUSY.has(live.link?.link)) setText(buttonText, 'CONNECT');
    }
  }

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
    showButton();
    const st = status();
    showBarLine(bar.server, st.alerts.server);
    showBarLine(bar.receiver, st.alerts.receiver);
    if (!slot) return;
    const s = shown();
    const test = st.kind === 'test';
    els.root.dataset.kind = st.kind;
    els.kind.hidden = !test;

    // The line count. A connected port that has gone silent shows here too.
    const q = st.link.quiet;
    setRow('lines', fmt(st.lines), Boolean(q), q ? `NOTHING FOR ${agoWords(q.ms)}` : '');

    // The disk file.
    const f = st.file;
    const name = f.name || '';
    let disk;
    let diskFile = '';
    let diskWarn = !test;
    if (f.state === 'saving') {
      diskWarn = false;
      const ago = agoWords(f.lastWriteAgoMs);
      disk = `${fmt(f.lines)} LINES, ${ago ? `${ago} AGO` : 'WRITING'}`;
      diskFile = name;
    } else if (f.state === 'failing') {
      diskWarn = true;
      disk = `NOT SAVING. WRITE FAILED (${s?.disk.state().error?.name ?? 'Error'}). TRYING AGAIN`;
      diskFile = name;
    } else if (f.state === 'ready') {
      diskWarn = false;
      disk = 'READY';
      diskFile = name;
    } else if (test) {
      // A test log has no file of its own unless one is picked while it
      // plays. The flight's file, picked already, waits for the flight.
      const flightFile = flight?.disk.handle?.name ?? f.waiting ?? '';
      disk = flightFile ? 'NONE FOR THIS TEST. THE FLIGHT\'S FILE IS READY' : 'NONE FOR THIS TEST';
      diskFile = flightFile;
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
      disk = 'NOT SAVING. NO FILE PICKED';
    }
    setRow('disk', disk, diskWarn, diskFile);
    // CHOOSE FILE shows while the log it would pick for has no file, or a
    // failing one (a failing file can be swapped for another).
    const target = chooseTarget();
    const hasFile = target ? Boolean(target.disk.handle) && !target.disk.state().error : Boolean(pendingHandle);
    els.choose.hidden = !canPick || hasFile || (!s && !asked);

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
    const down = st.presence === 'down';
    let server;
    let serverWarn = false;
    if (v.state === 'none') { server = 'NOT SAVING. NO LOCAL SERVER'; serverWarn = true; }
    else if (v.state === 'failing') {
      serverWarn = true;
      server = `NOT SAVING. ${v.error && /did not answer/.test(v.error) ? 'NO ANSWER' : 'REFUSED'}. TRYING AGAIN`;
    } else if (down) {
      // Nothing waits to be sent, and the server is gone all the same.
      serverWarn = true;
      server = s && v.state === 'saving' ? `${fmt(v.lines)} LINES. THE SERVER HAS STOPPED` : 'THE SERVER HAS STOPPED';
    } else if (!s) server = st.presence === 'present' ? 'READY' : 'STARTS ON CONNECT';
    else if (v.state === 'unknown') server = 'STARTING';
    else server = `${fmt(v.lines)} LINES`;
    setRow('server', server, serverWarn, s && v.state !== 'none' ? `flight-logs/${v.name}` : '');

    // One plain sentence when something needs saying. A warning about the
    // receiver comes first, in the same words as under the bar.
    const rx = st.alerts.receiver;
    let message = note;
    if (rx?.kind === 'warn') {
      message = { text: rx.text, kind: 'warn' };
    } else if (!test && (f.state === 'cancelled' || f.state === 'failed' || (f.state === 'none' && s))) {
      message = { text: 'There is no disk file, so the log is only in the copies above. CHOOSE FILE saves everything so far to a file and carries on.', kind: 'warn' };
    } else if (test && st.open) {
      message = { text: 'This log is a test capture, not live data. Its files have test-capture in their names.', kind: 'info' };
    } else if (rx) {
      message = { text: rx.text, kind: 'info' };
    } else if (v.state === 'none' && !note) {
      message = { text: 'This page was not opened from the launch mode server, so flight-logs has no copy. The other copies still save.', kind: 'warn' };
    } else if (test && !els.choose.hidden && !note) {
      message = { text: 'CHOOSE FILE picks the disk file for the flight now. Without it, CONNECT asks for one.', kind: 'info' };
    }
    els.note.hidden = !message;
    if (message) {
      setText(els.note, message.text);
      els.note.dataset.kind = message.kind;
    }
  }

  const scheduler = createScheduler(render, { maxFps: STATUS_FPS });
  function draw() { scheduler.schedule(); }
  // The ages ("0.4 S AGO") and the warnings' counts move on their own.
  setInterval(draw, 500);
  render();

  // The server is asked at once, for the status before the first
  // connection, and then by the pump (watchServer()). The other tabs' locks
  // are looked at now and every LOCK_LOOK_MS, and a lock this tab no longer
  // needs is let go.
  ping();
  lookForOthers();
  setInterval(() => {
    syncLocks();
    lookForOthers();
  }, LOCK_LOOK_MS);

  // CONNECT and DISCONNECT on this page go through the log (main.js).
  live.connect = connect;
  live.disconnect = disconnect;

  return {
    status,
    useFileHandle,
    chooseFile,
    expectTest,
    claimTest: () => claim(TEST_LOCK),
    otherTabNote,
    reconnecting: () => Boolean(reconnect),
    liveData: () => liveData,
    liveHasData,
    clearTestData,
    flush,
    logText: () => shown()?.text.text(0, Infinity) ?? '',
    connect,
    disconnect,
  };
}
