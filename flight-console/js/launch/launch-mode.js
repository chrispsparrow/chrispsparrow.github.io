// launch-mode.js: the middle of launch mode, the Flight Console set up for
// a launch field with no internet. Launch mode is only on when the page is
// flight-console/launch.html, which sets window.FC_LAUNCH before any of the
// page's code runs. On the normal page (index.html) LAUNCH is false, nothing
// here is fetched or started, and the console works as it always has.
//
// What is here:
//   LAUNCH          true on the launch page
//   launchReady     settles once the field's settings are in (never rejects)
//   hub             what the parts of launch mode share (also window.fcLaunch,
//                   so the test tools can look inside):
//     hub.settings        { field, manifest, tilesUrl } once launchReady has
//                         settled, or null when the settings didn't load
//     hub.groundStation   where I am standing, typed in at the field
//     hub.online          whether the internet answers right now
//     hub.link            the serial link's taps: onOpen(fn), onLine(fn) and
//                         onClose(fn). Each returns a function that stops
//                         it. fn runs for every connection start, every
//                         line (line, t) and every connection end, BEFORE
//                         the console itself sees them. A saved capture
//                         played as a test goes through the same taps.
//     hub.parts           each part puts its own object here for the others
//                         (maps, log, capture, panel)
//   tapLink(handlers)     wraps the serial link's handlers so hub.link's
//                         taps hear everything first (js/main.js does this)
//   startLaunchMode(ctx)  called once by js/main.js when the live console is
//                         made. Builds the launch panel and starts the parts.
//
// THE ONE SETTING. The field's center and the size of the saved map box are
// in /launch-mode/field.json. The tile downloader (launch-mode/
// download_tiles.py) reads the same file, and writes what it saved to
// manifest.json in the tiles folder. Change the center there, run the
// downloader again, and both maps and the ground station's default follow.
//
// js/main.js waits for launchReady before it shows anything on the launch
// page, so every part can read hub.settings without waiting.
//
// No DOM is touched until startLaunchMode() runs, so Node can import this.

export const LAUNCH = globalThis.FC_LAUNCH === true;

// How long (ms) to wait for the settings files before starting without them.
const SETTINGS_TIMEOUT_MS = 3000;
// Where the typed-in ground station position is kept (localStorage).
const GROUND_KEY = 'fc-launch-ground-station';
// Asked to find out whether the internet answers. It replies with an empty
// 204, and nothing about the flight is sent.
const ONLINE_CHECK_URL = 'https://www.google.com/generate_204';
// How long (ms) to wait for that answer, and how often to ask again.
const ONLINE_TIMEOUT_MS = 4000;
const ONLINE_EVERY_MS = 30000;

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

function listeners() {
  const set = new Set();
  return {
    add(fn) { set.add(fn); return () => set.delete(fn); },
    fire(...args) {
      for (const fn of [...set]) {
        try { fn(...args); } catch (err) { console.error('Launch mode: a listener failed', err); }
      }
    },
  };
}

// A usable position: lat from -90 to 90 and lon from -180 to 180.
export function validPosition(p) {
  return Boolean(p) && Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;
}

async function fetchJson(url, timeoutMs) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: abort.signal, cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------
// The settings: field.json, and the downloader's manifest.json
// ------------------------------------------------------------------

// The repo's root, three folders up from flight-console/js/launch/.
const ROOT_URL = new URL('../../../', import.meta.url);

async function loadSettings() {
  const field = await fetchJson(new URL('launch-mode/field.json', ROOT_URL), SETTINGS_TIMEOUT_MS);
  if (!field || !validPosition(field.center)) {
    console.warn('Launch mode: launch-mode/field.json did not load, so there is no field center or saved map');
    return null;
  }
  const folder = String(field.tiles?.folder ?? '').replace(/^\/+|\/+$/g, '');
  const tilesUrl = folder ? new URL(`${folder}/`, ROOT_URL).href : null;
  // No manifest means no tiles were downloaded. The maps then show online
  // imagery when there is internet, and plain ground when there isn't.
  const manifest = tilesUrl ? await fetchJson(new URL('manifest.json', tilesUrl), SETTINGS_TIMEOUT_MS) : null;
  if (!manifest) console.warn('Launch mode: no saved map tiles were found (no manifest.json in the tiles folder)');
  return { field, manifest, tilesUrl };
}

// ------------------------------------------------------------------
// The ground station position
// ------------------------------------------------------------------

function createGroundStation(getDefault) {
  const changed = listeners();
  let typed = null; // { lat, lon } from the field's box, or null for the default
  // Only the launch page reads the saved position. The normal page never
  // touches launch mode's storage.
  if (LAUNCH) {
    try {
      const saved = JSON.parse(globalThis.localStorage?.getItem(GROUND_KEY) ?? 'null');
      if (validPosition(saved)) typed = { lat: saved.lat, lon: saved.lon };
    } catch {
      // Nothing saved, or storage is off. The default is used.
    }
  }
  const get = () => {
    const p = typed ?? getDefault();
    return validPosition(p) ? { lat: p.lat, lon: p.lon, typed: Boolean(typed) } : null;
  };
  return {
    // { lat, lon, typed } or null. typed is false while it is still the
    // field's center from field.json.
    get,
    // Sets the position. Returns false (and changes nothing) for a bad one.
    set(p) {
      if (!validPosition(p)) return false;
      typed = { lat: p.lat, lon: p.lon };
      try { globalThis.localStorage?.setItem(GROUND_KEY, JSON.stringify(typed)); } catch { /* storage is off */ }
      changed.fire(get());
      return true;
    },
    // Back to the field's center.
    reset() {
      typed = null;
      try { globalThis.localStorage?.removeItem(GROUND_KEY); } catch { /* storage is off */ }
      changed.fire(get());
    },
    // fn(position) runs after every change. Returns a function that stops it.
    onChange: (fn) => changed.add(fn),
    // For the settings arriving after the first get().
    refresh: () => changed.fire(get()),
  };
}

// ------------------------------------------------------------------
// Whether the internet answers
// ------------------------------------------------------------------

function createOnlineWatch() {
  const changed = listeners();
  let state = false;      // nothing is taken as online until a check says so
  let checking = null;
  let timer = null;

  function set(next) {
    if (next === state) return;
    state = next;
    changed.fire(state);
  }

  // Asks once. Resolves true or false, never throws, and never takes longer
  // than ONLINE_TIMEOUT_MS. With Wi-Fi off the browser already knows, so
  // nothing is sent at all.
  function check() {
    if (checking) return checking;
    if (globalThis.navigator?.onLine === false || typeof fetch !== 'function') {
      set(false);
      return Promise.resolve(false);
    }
    const abort = new AbortController();
    const giveUp = setTimeout(() => abort.abort(), ONLINE_TIMEOUT_MS);
    checking = fetch(ONLINE_CHECK_URL, { mode: 'no-cors', cache: 'no-store', signal: abort.signal })
      .then(() => true, () => false)
      .then((ok) => {
        clearTimeout(giveUp);
        checking = null;
        set(ok);
        return ok;
      });
    return checking;
  }

  function start() {
    if (timer) return;
    check();
    timer = setInterval(check, ONLINE_EVERY_MS);
    globalThis.addEventListener?.('online', check);
    globalThis.addEventListener?.('offline', check);
  }

  return {
    // The newest answer. false until the first check comes back.
    get: () => state,
    check,
    start,
    // fn(isOnline) runs when the answer changes. Returns a function that stops it.
    onChange: (fn) => changed.add(fn),
  };
}

// ------------------------------------------------------------------
// The hub
// ------------------------------------------------------------------

// The serial link's taps (see hub.link above).
const taps = { open: listeners(), line: listeners(), close: listeners() };

// Wraps the handlers js/main.js gives the serial link. A tap that throws is
// logged and skipped, so it can never stop a line from reaching the console.
export function tapLink(handlers) {
  return {
    ...handlers,
    onOpen(...args) {
      taps.open.fire(...args);
      handlers.onOpen?.(...args);
    },
    onLine(line, t) {
      taps.line.fire(line, t);
      handlers.onLine?.(line, t);
    },
    onClose(...args) {
      taps.close.fire(...args);
      handlers.onClose?.(...args);
    },
  };
}

export const hub = {
  LAUNCH,
  settings: null,
  groundStation: createGroundStation(() => hub.settings?.field?.center ?? null),
  online: createOnlineWatch(),
  link: {
    onOpen: (fn) => taps.open.add(fn),
    onLine: (fn) => taps.line.add(fn),
    onClose: (fn) => taps.close.add(fn),
  },
  parts: {},
};

export const launchReady = LAUNCH
  ? loadSettings().catch(() => null).then((settings) => {
    hub.settings = settings;
    hub.groundStation.refresh();
    return settings;
  })
  : Promise.resolve(null);

if (LAUNCH) globalThis.fcLaunch = hub;

// The ground station the live flight store starts with on the launch page
// (createStore()'s groundStation option), or null when there is no position.
export function launchGroundStation() {
  const p = hub.groundStation.get();
  return p ? { lat: p.lat, lon: p.lon, altMsl: null, source: 'launch-mode' } : null;
}

// Starts launch mode's parts. ctx comes from js/main.js:
//   root          the console's section element
//   live          the live session (its handlers, link, panel, stores)
//   liveStore     (mode) -> the live store for 'bench' or 'flight'
//   getStage      () -> the stage (its views and store switch), or null
//   getScreen     () -> 'landing', 'track' or 'replay'
//   navigate, announce, localConsole, config   main.js's own
// Each part is started on its own, so one that fails can't stop the others
// or the console.
let started = false;
export async function startLaunchMode(ctx) {
  if (!LAUNCH || started) return hub;
  started = true;
  hub.ctx = ctx;
  hub.online.start();
  const start = async (name, load) => {
    try {
      const part = await load();
      if (part) hub.parts[name] = part;
    } catch (err) {
      console.error(`Launch mode: the ${name} part failed to start`, err);
    }
  };
  // The panel first: the other parts put their controls in its slots.
  await start('panel', async () => (await import('./launch-panel.js')).createLaunchPanel({ hub, ctx }));
  await start('log', async () => (await import('./flight-log.js')).createFlightLog({ hub, ctx }));
  await start('capture', async () => (await import('./capture.js')).createCapturePlayer({ hub, ctx }));
  return hub;
}
