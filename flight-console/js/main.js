// main.js
// The page's starting point. It reads the address and shows one of three
// screens:
//   /flight-console/              the landing: the hero and two cards
//   /flight-console/?track        the console, live. Connect a board (or,
//                                 later, the ground station) and watch it.
//   /flight-console/?flight=<id>  the console, playing a saved flight
// plus a friendly message if a flight is unknown or its data didn't load.
//
// The console (#fc-console) fills the window under the nav with no page
// scroll: a slim bar (CONNECT and the SAVED FLIGHTS dropdown), then two
// panels, one on screen at a time (js/views/panels.js): the 3D view, and
// the graphs and readings. Its data-mode says what it is showing, and
// flight-console.css shows what that mode needs:
//   idle    no source found yet. The 3D view waits, looking at the whole
//           Earth.
//   bench   a Dogtooth board's status block came in over USB: the 3D view
//           at its position with the readings panel over it, and the
//           board's own readings and graphs in panel 2
//   flight  a flight source (the Manta ground station, not built yet): the
//           3D view with the readings panel over it
//   replay  a saved flight: the 3D view with the clock, phase strip,
//           readings and altitude timeline over it, and the mission
//           timeline, flight details and detection check in panel 2
//
// Live data (the files in js/live/): the serial link reads lines from the
// port. sources.js works out what is talking from those lines. Every line
// goes to the bench panel (readings, graphs, raw output and the CSV), and
// its finished blocks go to the bench feed, which turns them into samples
// for the live store. The live 3D view reads that store. The live session
// (link, panel, stores) is made the first time the console opens and is
// never thrown away, so the connection and every block for the CSV survive
// a trip to a replay and back. The live 3D view only exists while the
// console shows live data, since one 3D view runs at a time.
//
// Links change the address with history.pushState, and the browser's back
// and forward buttons fire "popstate", which runs route() again. Opening a
// replay builds a brand new store, player and set of views. Leaving it
// destroys all of them, so nothing from one flight can linger in the next.
//
// Used by: index.html (<script type="module" src="js/main.js">).

// A module whose code changed gets a new ?v= on its import, so a browser
// that still has the old copy cached (GitHub Pages lets it keep one for 10
// minutes) fetches the new one instead of mixing old and new code. Every
// file that imports a module uses the same query, or the browser would
// load it twice.
import * as config from './config.js';
import { loadManifest, loadFlight } from './library.js';
import { createStore } from './store.js?v=2';
import { createPlayer } from './player.js';
import { createFleet } from './fleet.js';
import { h, setChildren } from './views/dom.js';
import { createLanding, createSavedFlights } from './views/launcher.js?v=2';
import { createSavedMenu } from './views/saved-menu.js';
import { createPanels } from './views/panels.js';
import { createMissionHeader } from './views/mission-header.js?v=3';
import { createRocketBar } from './views/rocket-bar.js';
import { createPhaseStrip } from './views/phase-strip.js';
import { createMapView } from './views/map-view.js?v=3';
import { createStatsPanel } from './views/stats-panel.js?v=3';
import { createTimeline } from './views/timeline.js?v=2';
import { createEventLog } from './views/event-log.js?v=2';
import { createFlightInfo } from './views/flight-info.js?v=2';
import { createDebugPanel } from './views/debug-panel.js';
import { BENCH_WORDS } from './views/hud-text.js?v=2';
import { createSerialLink } from './live/serial-link.js';
import { createSourceDetector } from './live/sources.js';
import { createBenchPanel } from './live/bench-panel.js?v=2';
import { createLiveFeed, LIVE_STORE_OPTIONS } from './live/bench-feed.js';

const TITLE_LANDING = 'Flight Console | Dogtooth Systems';
const TITLE_CONSOLE = 'Track a Rocket | Dogtooth Systems';
const $ = (id) => document.getElementById(id);
const sections = { landing: $('fc-landing'), console: $('fc-console'), message: $('fc-message') };
// The spots the 3D view and the readings panel go in. The replay and the
// live console take turns with them.
const STAGE_MOUNTS = ['fc-map', 'fc-stats'];
const REPLAY_MOUNTS = ['fc-mission', 'fc-rocketbar', 'fc-phases', ...STAGE_MOUNTS, 'fc-timeline', 'fc-log', 'fc-info', 'fc-debug'];

// The live stores' options (no ground station, and no liftoff for a board
// on a desk) are LIVE_STORE_OPTIONS in js/live/bench-feed.js, where the
// tests can use them too.

// Tells the load-failure check in index.html that this module started.
window.fcStarted = true;

// ------------------------------------------------------------------
// The map library (Leaflet), for the 2D map the 3D view falls back to.
// Checked fresh for every map that opens:
//   ready  resolves to the library, or to null if it failed or took longer
//          than LIBRARY_LOAD_TIMEOUT_MS, so nothing ever waits on it.
//   late   resolves if the library finishes loading after that, so the map
//          can switch from its fallback to the real view.
// ------------------------------------------------------------------
function watchLibrary(globalName, scriptId) {
  const script = $(scriptId);
  const found = () => window[globalName] ?? null;
  const failed = () => !script || script.dataset.state === 'failed';
  const late = new Promise((resolve) => {
    if (found()) { resolve(found()); return; }
    if (failed()) return; // a failed download never arrives
    script.addEventListener('load', () => { if (found()) resolve(found()); }, { once: true });
  });
  const ready = new Promise((resolve) => {
    if (found()) { resolve(found()); return; }
    if (failed()) { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), config.LIBRARY_LOAD_TIMEOUT_MS);
    late.then((lib) => { clearTimeout(timer); resolve(lib); });
    script.addEventListener('error', () => { clearTimeout(timer); resolve(null); }, { once: true });
  });
  return { ready, late };
}

// ------------------------------------------------------------------
// Which CARTO map key to use. The live site uses the public key in
// config.js. On my laptop (localhost or 127.0.0.1) CARTO refuses that key,
// so the page loads js/config.local.js, which is never committed, and uses
// its key. On any other host config.local.js is never requested.
// Resolves to { key, source: 'public' | 'local' | 'missing-local' }.
// ------------------------------------------------------------------
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const tileKey = (async () => {
  if (!LOCAL_HOSTS.includes(window.location.hostname)) {
    return { key: config.TILE_API_KEY, source: 'public' };
  }
  try {
    const local = await import('./config.local.js');
    if (local.TILE_API_KEY_LOCAL) return { key: local.TILE_API_KEY_LOCAL, source: 'local' };
  } catch {
    // No config.local.js on this computer.
  }
  return { key: '', source: 'missing-local' };
})();

// ------------------------------------------------------------------
// The manifest is downloaded once and reused. A failed download is
// forgotten, so the next visit to the console tries again.
// ------------------------------------------------------------------
let manifestPromise = null;
function getManifest() {
  if (!manifestPromise) {
    manifestPromise = loadManifest().then((manifest) => {
      if (manifest.error) manifestPromise = null;
      return manifest;
    });
  }
  return manifestPromise;
}

// ------------------------------------------------------------------
// Addresses and navigation
// ------------------------------------------------------------------

// What the address asks for: { flight: id }, { track: true } or
// { landing: true }. ?flight= wins over ?track.
function readAddress() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('flight');
  if (id !== null && id.trim() !== '') return { flight: id.trim() };
  if (params.has('track')) return { track: true };
  return { landing: true };
}

function landingUrl() {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  return url;
}

function trackUrl() {
  const url = landingUrl();
  url.search = '?track';
  return url;
}

function flightUrl(id) {
  const url = landingUrl();
  url.searchParams.set('flight', id);
  return url;
}

function urlFor(target) {
  if (target.flight) return flightUrl(target.flight);
  if (target.track) return trackUrl();
  return landingUrl();
}

// target is { flight: id }, { track: true } or { landing: true }.
function navigate(target) {
  const url = urlFor(target);
  if (url.href !== window.location.href) {
    window.history.pushState(target.flight ? { flight: target.flight } : target.track ? { track: true } : {}, '', url);
  }
  moveFocus = true;
  route();
}

// After switching screens inside the page (not on the first load), keyboard
// focus moves to the new screen's main heading, so it isn't left behind on
// a link that just disappeared.
let moveFocus = false;
function focusHeading(el) {
  if (!moveFocus || !el) return;
  moveFocus = false;
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

function isModifiedClick(e) {
  return e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
}

// A link that goes through navigate() on a plain click, but still works
// normally with a middle click or Ctrl+click (new tab).
function internalLink(text, target, className = '') {
  return h('a', {
    href: urlFor(target).href,
    class: className,
    onclick: (e) => {
      if (isModifiedClick(e)) return;
      e.preventDefault();
      navigate(target);
    },
  }, text);
}

// The same for the links written in index.html: data-fc-nav="track" or
// "landing" on an <a> with a real href.
document.addEventListener('click', (e) => {
  const link = e.target instanceof Element ? e.target.closest('a[data-fc-nav]') : null;
  if (!link || isModifiedClick(e)) return;
  e.preventDefault();
  navigate(link.dataset.fcNav === 'track' ? { track: true } : { landing: true });
});

// Shows one screen. The body says which (data-fc-screen), so the CSS can
// hide the site footer and stop the page scrolling while the console is up.
function show(name) {
  for (const [key, el] of Object.entries(sections)) el.hidden = key !== name;
  document.body.dataset.fcScreen = name;
}

// The console's mode: 'idle', 'bench', 'flight' or 'replay'.
function setMode(mode) {
  if (sections.console.dataset.mode !== mode) sections.console.dataset.mode = mode;
}

// One short line for screen readers, for changes that happen on their own.
function announce(text) {
  const box = $('fc-announce');
  if (box) box.textContent = text;
}

// ------------------------------------------------------------------
// The console's frame: the panels, the SAVED FLIGHTS dropdown, the
// replay's name in the bar, and the status lines. Made once.
// ------------------------------------------------------------------
const panels = createPanels(sections.console, {
  // The graphs draw again once they are on screen.
  onChange: (name) => { if (name === 'data') live?.panel?.render(); },
});

const savedMenu = createSavedMenu($('fc-saved'), {
  hrefFor: (id) => flightUrl(id).href,
  liveHref: trackUrl().href,
  onOpen: (id) => navigate({ flight: id }),
  onLive: () => navigate({ track: true }),
});

// The open replay's name in the bar, or null for live.
function setReplayChip(text) {
  const chip = $('fc-replay-chip');
  chip.hidden = !text;
  $('fc-replay-name').textContent = text ?? '';
}

// The close buttons on the status lines.
sections.console.addEventListener('click', (e) => {
  const button = e.target instanceof Element ? e.target.closest('[data-close]') : null;
  if (!button) return;
  const box = $(button.dataset.close);
  if (box) box.hidden = true;
});

// RAW OUTPUT on the "not recognized" line: panel 2, with the raw output open.
$('fc-notice-raw').addEventListener('click', () => {
  panels.show('data');
  const raw = $('bc-raw');
  if (raw && !raw.open) raw.open = true;
  raw?.querySelector('summary')?.focus({ preventScroll: true });
});

// The altitude timeline floats at the bottom of the 3D view. The 3D view's
// own controls and credits sit just above it, so the room it takes from
// the bottom edge (its height, the space under it and an 8 px gap) is kept
// in --fc-tl-space on the panel (0 when there is no timeline).
(() => {
  const stage = $('fc-panel-globe');
  const timeline = $('fc-timeline');
  if (!stage || !timeline || !('ResizeObserver' in window)) return;
  new ResizeObserver(() => {
    const height = timeline.offsetHeight;
    const under = parseFloat(getComputedStyle(timeline.parentElement).paddingBottom) || 0;
    stage.style.setProperty('--fc-tl-space', height ? `${Math.round(height + under + 8)}px` : '0px');
  }).observe(timeline);
})();

// ------------------------------------------------------------------
// Routing
// ------------------------------------------------------------------
let routeToken = 0;      // bumps on every route, so late async results are ignored
let screen = null;       // 'landing', 'track', 'replay', 'loading' or 'message'
let session = null;      // the open replay: { id, store, player, views }
let landing = null;

async function route() {
  const where = readAddress();
  // Only the #part of the address changed (popstate fires for that too):
  // the same screen is already up, so leave it alone.
  if (where.flight && session && where.flight === session.id) return;
  if (where.track && screen === 'track') return;
  if (where.landing && screen === 'landing') return;
  const token = ++routeToken;
  savedMenu.close({ focus: false });
  closeConsole();
  if (!where.track) closeLiveViews();
  // A new screen starts at the top at once, never with a smooth scroll.
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  if (where.flight) await openFlight(where.flight, token);
  else if (where.track) await showTrack(token);
  else showLanding();
}

function showLanding() {
  screen = 'landing';
  show('landing');
  document.title = TITLE_LANDING;
  if (!landing) landing = createLanding(sections.landing);
  focusHeading($('fc-landing-title'));
}

async function showTrack(token) {
  screen = 'track';
  ensureLive();
  setMode(live?.mode ?? 'idle');
  setReplayChip(null);
  savedMenu.setCurrent('live');
  panels.show('globe');
  show('console');
  document.title = TITLE_CONSOLE;
  openLiveViews();
  // The graphs were hidden, so they draw again at their new size.
  live?.panel?.render();
  // An address ending in #fc-saved (the overview's "Saved flights" link)
  // opens the SAVED FLIGHTS dropdown.
  const toSaved = window.location.hash === '#fc-saved';
  if (!toSaved) focusHeading($('fc-console-title'));
  else moveFocus = false;

  savedMenu.renderLoading();
  const manifest = await getManifest();
  if (token !== routeToken) return;
  savedMenu.render(manifest);
  if (toSaved && window.location.hash === '#fc-saved') {
    const button = $('fc-saved-button');
    button.click();
    button.focus({ preventScroll: true });
  }
}

function showMessage(title, paragraphs, { retry = false } = {}) {
  screen = 'message';
  show('message');
  const actions = h('p', { class: 'fc-message-actions' },
    internalLink('BACK TO THE CONSOLE', { track: true }, 'fc-btn fc-btn--accent'),
    retry ? ' ' : null,
    retry ? h('button', { type: 'button', class: 'fc-btn', onclick: () => route() }, 'TRY AGAIN') : null);
  const heading = h('h1', {}, title);
  setChildren(sections.message, h('div', { class: 'fc-card' },
    heading,
    paragraphs.map((p) => h('p', {}, p)),
    actions));
  focusHeading(heading);
}

async function openFlight(id, token) {
  // The live session is made here too, so CONNECT in the bar works from a
  // replay (it goes back to live first).
  ensureLive();
  // The console stays up while the flight loads, with an empty 3D panel
  // that says so.
  screen = 'loading';
  setMode('replay');
  setReplayChip('Loading the flight...');
  panels.show('globe');
  show('console');
  document.title = TITLE_CONSOLE;
  setChildren($('fc-map'), h('p', { class: 'fc-stage-wait' }, 'Loading the flight...'));

  const manifest = await getManifest();
  if (token !== routeToken) return;
  savedMenu.render(manifest);
  if (manifest.error) {
    console.warn('Flight library did not load:', manifest.error);
    const why = {
      network: 'Check your internet connection and try again.',
      server: 'The site had a problem sending it. Try again in a moment.',
    }[manifest.errorKind] ?? 'The flight list on the site is missing or damaged. That\'s on my end, not yours.';
    showMessage('The flight library didn\'t load', [
      'I couldn\'t load the list of flights, so this flight can\'t open right now.',
      why,
    ], { retry: true });
    return;
  }

  const entry = manifest.flights.find((f) => f.id === id);
  if (!entry) {
    const broken = manifest.problems.find((p) => p.id === id);
    if (broken) {
      showMessage('This flight can\'t open', [`The library entry for "${id}" has a problem, so it can't open.`, 'The other flights still work.']);
    } else {
      showMessage('Flight not found', [`There's no flight called "${id}" in the library. It may have been renamed or removed.`]);
    }
    return;
  }
  setReplayChip(entry.title);
  savedMenu.setCurrent(entry.id);

  let flight;
  try {
    flight = await loadFlight(entry);
  } catch (err) {
    if (token !== routeToken) return;
    console.warn('Flight data did not load:', err);
    const why = {
      network: [`The data for "${entry.title}" couldn't be downloaded.`, 'Check your internet connection and try again.'],
      server: [`The site had a problem sending the data for "${entry.title}".`, 'Try again in a moment.'],
      missing: [`The data file for "${entry.title}" is missing from the site. That's on my end, not yours.`],
      damaged: [`The data for "${entry.title}" downloaded but couldn't be read.`],
    }[err?.kind] ?? [`The data for "${entry.title}" couldn't be loaded.`];
    showMessage('This flight\'s data didn\'t load', why, { retry: err?.kind === 'network' || err?.kind === 'server' });
    return;
  }
  if (token !== routeToken) return;

  if (!flight.samples.some((s) => s.type !== 'gs')) {
    showMessage('No readable data', [
      `"${entry.title}" loaded, but none of its lines could be read as telemetry (${flight.badRows} bad line${flight.badRows === 1 ? '' : 's'} skipped).`,
    ]);
    return;
  }
  startConsole(entry, flight);
}

// ------------------------------------------------------------------
// Views: starting and stopping a set of them
// ------------------------------------------------------------------

// makers is a list of [mount id, make function]. One broken view must not
// take the rest of the console down.
function startViews(makers, ctx) {
  const views = [];
  for (const [mountId, make] of makers) {
    const mount = $(mountId);
    try {
      views.push(make(mount, ctx));
    } catch (err) {
      console.error(`Flight Console: the ${mountId} view failed to start`, err);
      setChildren(mount, h('div', { class: 'fc-panel' }, h('p', { class: 'fc-wait' }, 'This part of the console hit an error. The rest still works.')));
    }
  }
  return views;
}

function stopViews(views, mounts) {
  for (const view of views) {
    try { view?.destroy?.(); } catch (err) { console.error('Flight Console: error closing a view', err); }
  }
  for (const id of mounts) $(id).replaceChildren();
}

// ------------------------------------------------------------------
// The replay console
// ------------------------------------------------------------------
function startConsole(entry, flight) {
  screen = 'replay';
  setMode('replay');
  show('console');
  document.title = TITLE_CONSOLE;
  setReplayChip(entry.title);
  savedMenu.setCurrent(entry.id);
  $('fc-map').replaceChildren();

  const store = createStore({ fleet: createFleet() });
  for (const r of entry.rockets) store.registerRocket({ id: r.rocketId, name: r.name, board: r.board });

  // A rocket in the data that the manifest doesn't list is added now, in the
  // order it first appears, so every view knows it before playback reaches
  // its first reading.
  for (const s of flight.samples) {
    if (s.type !== 'gs' && !store.getRocket(s.rocketId)) store.registerRocket({ id: s.rocketId });
  }

  const player = createPlayer({ store });
  const ctx = {
    store,
    player,
    config,
    libs: { leaflet: watchLibrary('L', 'fc-lib-leaflet') },
    tileKey,
    // Each rocket's whole-flight altitude curve and events, for the
    // timeline and the 3D view's first framing. See prescanFlight() below.
    prescan: prescanFlight(entry, flight.samples),
    flight: {
      entry,
      truth: flight.truth,
      badRows: flight.badRows,
      badRowDetails: flight.badRowDetails,
      files: flight.files,
      notes: flight.files.flatMap((f) => f.notes ?? []),
      sampleCount: flight.samples.length,
    },
    link: flightUrl(entry.id).href,
    navigate,
  };

  const views = startViews([
    ['fc-mission', createMissionHeader],
    ['fc-rocketbar', createRocketBar],
    ['fc-phases', createPhaseStrip],
    ['fc-map', createMapView],
    ['fc-stats', createStatsPanel],
    ['fc-timeline', createTimeline],
    ['fc-log', createEventLog],
    ['fc-info', createFlightInfo],
    ['fc-debug', createDebugPanel],
  ], ctx);

  session = { id: entry.id, store, player, views };
  focusHeading($('fc-mission').querySelector('h2'));
  player.load(flight.samples);
  player.setSpeed(config.DEFAULT_SPEED);
  player.play();
}

// ------------------------------------------------------------------
// Whole-flight pre-scan for the timeline. A second store, never shown,
// takes the whole flight at once (in the same order the player uses), so
// every rocket's full altitude curve and events are known before playback
// gets there. It is a separate copy with its own detectors: nothing it
// works out reaches the live store, and the live views never read it as
// "now". Returns rocketId -> {
//   profile    [{ t, agl }] one point per altitude reading, in data time.
//              agl is null where a reading should have had an altitude and
//              didn't (a GPS fix gap), which the timeline draws as a break.
//              Heights use the ground level frozen at liftoff.
//   events     every event the detector found, in order
//   state      the detector's final state (maxAgl, liftoffT, events, ...)
// }
// ------------------------------------------------------------------
function prescanFlight(entry, samples) {
  const scan = createStore({ fleet: createFleet() });
  for (const r of entry.rockets) scan.registerRocket({ id: r.rocketId, name: r.name, board: r.board });
  const ordered = samples
    .filter((s) => s && Number.isFinite(s.t))
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.t - b.s.t || a.i - b.i)
    .map((x) => x.s);
  scan.addSamples(ordered, { quiet: true });
  const out = new Map();
  for (const rocket of scan.getRockets()) {
    const state = rocket.derived;
    const ground = state?.groundRef;
    const profile = Number.isFinite(ground)
      ? rocket.altSeries.map((p) => Object.freeze({ t: p.t, agl: p.alt === null ? null : p.alt - ground }))
      : [];
    out.set(rocket.id, Object.freeze({ profile: Object.freeze(profile), events: Object.freeze(rocket.events.slice()), state }));
  }
  scan.clearAll();
  return out;
}

function closeConsole() {
  if (!session) return;
  session.player.destroy();
  stopViews(session.views, REPLAY_MOUNTS);
  session.store.clearAll();
  session = null;
}

// ------------------------------------------------------------------
// The live console
// ------------------------------------------------------------------
let live = null;        // the live session, see ensureLive()
let liveViews = null;   // the live 3D view, and its readings panel once a source is found, while they're on screen

// Made the first time the console opens, then kept for the whole visit.
//   detector  which source is talking on this connection (sources.js)
//   source    the source found on this connection, or null
//   mode      'bench' or 'flight': the newest source's mode, kept after a
//             disconnect so its data stays on screen. null before any.
//   unknown   lines arrive but none match a source
//   stores    { bench, flight }: the live stores, made on first use
//   feed      the bench feed into stores.bench (bench-feed.js)
//   panel     the bench panel: CONNECT, readings, graphs, raw output, CSV
//   link      the serial port (serial-link.js)
function ensureLive() {
  if (live) return live;
  const next = {
    detector: createSourceDetector(),
    source: null,
    mode: null,
    unknown: false,
    stores: {},
    feed: null,
    panel: null,
    link: null,
  };
  try {
    next.panel = createBenchPanel({
      root: sections.console,
      onBlock: (block) => next.feed?.push(block),
      onRestart: () => next.feed?.restart(),
      onConnect: () => {
        // CONNECT in a replay goes back to live first. The port picker
        // opens right away, still inside the click.
        if (screen !== 'track') navigate({ track: true });
        next.link?.connect();
      },
      onDisconnect: () => next.link?.disconnect(),
    });
    next.link = createSerialLink({
      onLine(line, t) {
        const before = next.source;
        const source = next.detector.push(line);
        // A source has to be set up before its first block reaches the
        // panel, so the bench feed is there to take it.
        if (source && source !== before) useSource(source);
        else if (!source) setUnknown(next.detector.unknown);
        if (source?.mode === 'flight') feedFlightLine(source, line);
        next.panel.handleLine(line, t);
      },
      onLink: (state, text) => next.panel.setLink(state, text),
      onNote: (text, kind) => next.panel.note(text, kind),
      onOpen: () => {
        // A new connection can be a different board, so it is worked out
        // again. What the last one showed stays until then.
        next.detector.reset();
        next.source = null;
        setUnknown(false);
        next.panel.connected();
      },
      // Nothing comes in once the port closes, so the "not recognized"
      // line goes away with it.
      onClose: ({ lost }) => {
        setUnknown(false);
        next.panel.closed({ lost });
      },
    });
  } catch (err) {
    console.error('Flight Console: the live console failed to start', err);
    const note = $('bc-link-note');
    if (note) {
      note.textContent = 'The live part of the console hit an error, so it can\'t connect. Saved flights still play.';
      $('fc-link-note-box').hidden = false;
    }
    const connect = $('bc-connect');
    if (connect) connect.disabled = true;
    next.failed = true;
  }
  live = next;
  // Leaving the page closes the port and drops every block, so the browser
  // asks first while there are blocks that weren't saved as a CSV file.
  // (The landing and the replays are on this page, so they keep them.)
  window.addEventListener('beforeunload', (e) => {
    if (!live?.panel?.hasUnsaved()) return;
    e.preventDefault();
    e.returnValue = '';
  });
  return live;
}

// A source was found on this connection.
function useSource(source) {
  live.source = source;
  setUnknown(false);
  const mode = source.mode === 'flight' ? 'flight' : 'bench';
  liveStore(mode);
  live.mode = mode;
  if (screen === 'track') {
    if (liveViews && liveViews.mode !== mode) closeLiveViews();
    setMode(mode);
    openLiveViews();
  }
  announce(mode === 'bench'
    ? `${source.name} found. Its position is in the 3D view, and its readings and graphs are in the second panel.`
    : `${source.name} found. The 3D view is showing.`);
}

// The live store for a mode, made the first time it is needed. The bench
// store gets the bench feed, which registers the board as its one rocket.
function liveStore(mode) {
  if (!live.stores[mode]) {
    const store = createStore({ fleet: createFleet(), ...LIVE_STORE_OPTIONS[mode] });
    live.stores[mode] = store;
    if (mode === 'bench') live.feed = createLiveFeed({ store });
  }
  return live.stores[mode];
}

// ------------------------------------------------------------------
// MANTA HOOK. A flight source, like the Manta ground station (see the
// commented-out entry in js/live/sources.js), has mode 'flight' and a
// parse(line) that gives back { kind: 'sample', sample } for a line with a
// reading, the way parseSerialLine() in js/parser.js does. Each sample goes
// into the flight store, and the 3D view and readings panel show it.
// Nothing calls this yet. Before something does, the flight store's clock
// also has to keep moving between packets (store.setTime), the way
// createLiveFeed() in js/live/bench-feed.js does it for the board, or the
// views never say the data is old.
// ------------------------------------------------------------------
function feedFlightLine(source, line) {
  if (typeof source.parse !== 'function') return;
  let result;
  try {
    result = source.parse(line);
  } catch (err) {
    // A line the parser can't handle is skipped. The raw output still
    // shows it.
    console.error(`Flight Console: ${source.name} couldn't read a line`, err);
    return;
  }
  if (result?.kind === 'sample') live.stores.flight?.addSample(result.sample);
}

// Lines arrive and none match a source: say so (the line under the bar)
// and open the raw output.
function setUnknown(unknown) {
  if (!live || unknown === live.unknown) return;
  live.unknown = unknown;
  $('fc-notice').hidden = !unknown;
  if (unknown) {
    const raw = $('bc-raw');
    if (raw && !raw.open) raw.open = true;
    announce('The console doesn\'t recognize this data yet. The raw serial output is open in the second panel.');
  }
}

// The live 3D view, on the live store of the current mode. Before any
// source (idle) it runs on the bench store, which has no ground station
// and nothing in it yet, so the view waits looking at the whole Earth.
// Once a source is found (bench or flight), the readings panel floats over
// it too. It is added on its own, so the 3D view keeps running.
function openLiveViews() {
  if (screen !== 'track' || !live || live.failed) return;
  if (!liveViews) {
    const mode = live.mode === 'flight' ? 'flight' : 'bench';
    const ctx = {
      store: liveStore(mode),
      config,
      libs: { leaflet: watchLibrary('L', 'fc-lib-leaflet') },
      tileKey,
      // Live data has no whole flight to scan ahead of time.
      prescan: new Map(),
      navigate,
      // A board on a desk isn't a rocket, and its "pad" is only where it
      // first sat still with a GPS fix (hud-text.js).
      ...(mode === 'bench' ? { words: BENCH_WORDS } : {}),
    };
    liveViews = { mode, ctx, views: startViews([['fc-map', createMapView]], ctx), readings: null };
  }
  if (live.mode && !liveViews.readings) {
    liveViews.readings = startViews([['fc-stats', createStatsPanel]], liveViews.ctx);
  }
}

function closeLiveViews() {
  if (!liveViews) return;
  stopViews([...liveViews.views, ...(liveViews.readings ?? [])], STAGE_MOUNTS);
  liveViews = null;
}

// ------------------------------------------------------------------
// Start
// ------------------------------------------------------------------
window.addEventListener('popstate', () => {
  moveFocus = true;
  route();
});
route();
