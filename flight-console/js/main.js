// main.js
// The page's starting point. It reads the address and shows one of three
// screens:
//   /flight-console/              the landing: one full-screen hero
//   /flight-console/?track        Track a Rocket, live. Connect a board (or,
//                                 later, the ground station) and watch it.
//   /flight-console/?flight=<id>  Track a Rocket, playing a saved flight
// plus a friendly message if a flight is unknown or its data didn't load.
//
// Track a Rocket (#fc-console) fills the window under the nav with no page
// scroll: a slim bar (← FLIGHT CONSOLE, CONNECT, the replay's name and
// SAVED FLIGHTS), then two panels, one on screen at a time
// (js/views/panels.js): the 3D view with the HUD over it, and the graphs
// and readings. Two attributes on the console tell the CSS what to show:
//   data-mode   which source is on screen:
//     idle      nothing found on the serial link yet
//     bench     a Dogtooth board's status block came in over USB
//     flight    a flight source (the Manta ground station, not built yet)
//     replay    a saved flight
//   data-state  where the flight is, worked out from the data alone
//               (flightState() in js/flight-state.js, through the HUD):
//     idle      nothing connected or loaded: only the globe and the map's
//               controls
//     pad       connected, or data in, with no liftoff yet: the checklist
//     flight    liftoff detected: the full HUD
//     recovery  landed: the HUD with where to find the board
//   A replay goes through pad, flight and recovery as it plays, and back
//   again when the viewer seeks.
//
// THE STAGE. The 3D view, the HUD, the phase bar and the rocket chips are
// made once, the first time the console opens, and kept until the visitor
// goes back to the landing. So the globe never goes blank, even while a
// saved flight downloads. Their store is a store switch (store-switch.js):
// main.js points it at the live store or at a replay's store with use(),
// and the views start over from the new store. ctx.session says what is on
// screen ({ kind: 'live' | 'replay', prescan, player, entry, loading }).
// main.js changes its fields first, then calls use(), and the views read it
// fresh on every draw.
//
// Opening a saved flight: its store is made as soon as its library entry is
// known, the session says { kind: 'replay', loading: true }, and the stage
// switches to it. The map flies toward the flight's launch point while the
// data downloads, and the bar says LOADING. When the data is in, the
// session gets the pre-scan and the player, and the samples arrive through
// the store. The altitude timeline and panel 2 are made per flight, and
// thrown away with it, so nothing from one flight can linger in the next.
//
// Live data (the files in js/live/): the serial link reads lines from the
// port. sources.js works out what is talking from those lines. Every line
// goes to the bench panel (readings, graphs, raw output and the CSV), and
// its finished blocks go to the bench feed, which turns them into samples
// for the live store. The live session (link, panel, stores) is made the
// first time the console opens and is never thrown away, so the connection
// and every block for the CSV survive a trip to a replay and back.
//
// Links change the address with history.pushState, and the browser's back
// and forward buttons fire "popstate", which runs route() again.
//
// Used by: index.html (<script type="module" src="js/main.js">).

// A module whose code changed gets a new ?v= on its import, so a browser
// that still has the old copy cached (GitHub Pages lets it keep one for 10
// minutes) fetches the new one instead of mixing old and new code. Every
// file that imports a module uses the same query, or the browser would
// load it twice.
import * as config from './config.js?v=3';
import { loadManifest, loadFlight } from './library.js?v=4';
import { createStore } from './store.js?v=4';
import { createStoreSwitch } from './store-switch.js?v=2';
import { createPlayer } from './player.js?v=3';
import { createFleet } from './fleet.js?v=3';
import { STATE } from './flight-state.js?v=3';
import { h, setChildren } from './views/dom.js?v=2';
import { createLanding } from './views/launcher.js?v=6';
import { createSavedMenu } from './views/saved-menu.js?v=3';
import { createPanels } from './views/panels.js?v=2';
import { createHud } from './views/hud.js?v=3';
import { createRocketBar } from './views/rocket-bar.js?v=3';
import { createPhaseStrip } from './views/phase-strip.js?v=3';
import { createMapView } from './views/map-view.js?v=8';
import { createTimeline } from './views/timeline.js?v=5';
import { createDataPanel } from './views/data-panel.js?v=3';
import { createSerialLink } from './live/serial-link.js';
import { createSourceDetector } from './live/sources.js?v=2';
import { createBenchPanel } from './live/bench-panel.js?v=5';
import { createLiveFeed, LIVE_STORE_OPTIONS } from './live/bench-feed.js?v=3';

const TITLE_LANDING = 'Flight Console | Dogtooth Systems';
const TITLE_CONSOLE = 'Track a Rocket | Dogtooth Systems';
const $ = (id) => document.getElementById(id);
const sections = { landing: $('fc-landing'), console: $('fc-console'), message: $('fc-message') };
// The spots the stage's views go in (made once), and the ones a replay's
// own views go in (made per flight).
const STAGE_MOUNTS = ['fc-map', 'fc-hud', 'fc-phases', 'fc-rocketbar'];
const REPLAY_MOUNTS = ['fc-timeline', 'fc-data-replay'];
// The room (px) kept between the timeline or the map's controls and what
// sits above them, in --fc-tl-space and --fc-ctl-space.
const SPACE_GAP_PX = 8;

// The live stores' options (no ground station, and the detector settings
// for a board) are LIVE_STORE_OPTIONS in js/live/bench-feed.js, where the
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

// The console's source: 'idle', 'bench', 'flight' or 'replay'.
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

// The replay's name in the bar. null hides it (live). loading adds a
// blinking LOADING after the name while the flight's data downloads.
function setReplayChip(chip) {
  $('fc-replay-chip').hidden = !chip;
  $('fc-replay-name').textContent = chip?.name ?? '';
  $('fc-replay-name').hidden = !chip?.name;
  $('fc-replay-wait').hidden = !chip?.loading;
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
  // On a phone the raw output sits below the graphs, so bring it into view.
  if (raw) revealInPanel(raw, $('fc-panel-data'));
});

// Scrolls el into view inside its panel, only up and down. (scrollIntoView
// would also scroll the sliding track sideways while the panel is still
// off screen, which left a blank screen on phones.) Every box between el
// and the panel that scrolls up and down moves just enough to show el's
// top, with an 8 px gap.
function revealInPanel(el, panel) {
  if (!el || !panel) return;
  const gap = 8;
  for (let box = el.parentElement; box; box = box.parentElement) {
    const y = getComputedStyle(box).overflowY;
    if ((y === 'auto' || y === 'scroll') && box.scrollHeight > box.clientHeight + 1) {
      const outer = box.getBoundingClientRect();
      const inner = el.getBoundingClientRect();
      if (inner.top < outer.top || inner.bottom > outer.bottom) box.scrollTop += inner.top - outer.top - gap;
    }
    if (box === panel) break;
  }
}

// The map's scale bar and credits (its bottom right corner) sit just above
// the altitude timeline, and on narrow screens just above the map's
// controls. So the panel keeps three numbers for the CSS, in px:
//   --fc-tl-space   from the panel's bottom edge up to the top of the
//                   timeline, plus a gap (0px when there is no timeline)
//   --fc-ctl-space  the same up to the top of the map's controls (the
//                   same as --fc-tl-space when the controls are empty)
//   --fc-corner-h   the corner's own height plus a gap (0px before the
//                   map view makes it). In short windows the overlay keeps
//                   a band this tall free for it (flight-console.css).
// The map view makes the corner, so spaces.findCorner() looks for it
// again after each new stage.
const spaces = (() => {
  const stage = $('fc-panel-globe');
  const timeline = $('fc-timeline');
  const controls = $('fc-map-controls');
  if (!stage || !timeline || !controls || !('ResizeObserver' in window)) return null;
  let corner = null;
  const above = (el) => {
    const box = el.getBoundingClientRect();
    if (!(box.height > 0)) return null;
    return Math.round(stage.getBoundingClientRect().bottom - box.top + SPACE_GAP_PX);
  };
  const update = () => {
    const tl = above(timeline) ?? 0;
    const ctl = above(controls) ?? tl;
    const cornerH = corner?.isConnected ? corner.getBoundingClientRect().height : 0;
    stage.style.setProperty('--fc-tl-space', `${tl}px`);
    stage.style.setProperty('--fc-ctl-space', `${ctl}px`);
    stage.style.setProperty('--fc-corner-h', `${cornerH > 0 ? Math.round(cornerH + SPACE_GAP_PX) : 0}px`);
  };
  const observer = new ResizeObserver(update);
  for (const el of [stage, timeline, controls]) observer.observe(el);
  return {
    findCorner() {
      const found = stage.querySelector('.fc-map-corner');
      if (found === corner) return;
      if (corner) observer.unobserve(corner);
      corner = found;
      if (corner) observer.observe(corner);
      update();
    },
  };
})();

// ------------------------------------------------------------------
// Routing
// ------------------------------------------------------------------
let routeToken = 0;      // bumps on every route, so late async results are ignored
let screen = null;       // 'landing', 'track', 'replay', 'loading' or 'message'
let landing = null;

async function route() {
  const where = readAddress();
  // Only the #part of the address changed (popstate fires for that too):
  // the same screen is already up, so leave it alone.
  // (A replay that hit a loading error has no player, so TRY AGAIN loads it again.)
  if (where.flight && replay?.player && where.flight === replay.id) return;
  if (where.track && screen === 'track') return;
  if (where.landing && screen === 'landing') return;
  const token = ++routeToken;
  savedMenu.close({ focus: false });
  closeReplay();
  if (where.landing) closeStage();
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
  showLive();
  // The graphs were hidden, so they draw again at their new size.
  live?.panel?.render();
  // An address ending in #fc-saved opens the SAVED FLIGHTS dropdown.
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
    internalLink('BACK TO THE CONSOLE', { track: true }, 'fc-bkt'),
    retry ? h('button', { type: 'button', class: 'fc-bkt', onclick: () => route() }, 'TRY AGAIN') : null);
  const heading = h('h1', {}, title);
  setChildren(sections.message, h('div', { class: 'fc-message-body' },
    heading,
    paragraphs.map((p) => h('p', {}, p)),
    actions));
  focusHeading(heading);
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
      setChildren(mount, h('p', { class: 'fc-view-error' }, 'This part of the console hit an error. The rest still works.'));
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
// The stage: the 3D view, the HUD, the phase bar and the rocket chips,
// made once and kept while the console is up.
//   store     the store switch the views read
//   session   what is on screen (see the top of this file)
//   views     the views, for closing them
//   hud       the HUD, to redraw when the serial link opens or closes
// ------------------------------------------------------------------
let stage = null;
// A replay's store that the stage may still be showing. It is cleared once
// the stage shows something else, so nothing from it can linger.
let retired = null;

function ensureStage() {
  if (stage) return stage;
  const session = { kind: 'live', prescan: new Map(), player: null, entry: null, loading: false };
  const store = createStoreSwitch(liveStore(liveMode()));
  const ctx = {
    store,
    config,
    libs: { leaflet: watchLibrary('L', 'fc-lib-leaflet') },
    tileKey,
    navigate,
    session,
    // The open replay's parts, read fresh, for views written before the
    // session existed.
    get prescan() { return session.prescan; },
    get player() { return session.player; },
    get flight() { return replay?.flight ?? null; },
    get link() { return replay ? flightUrl(replay.id).href : null; },
    // For the HUD: whether the live link is open, and the state it found.
    isConnected: () => session.kind === 'live' && live?.linkState === 'open',
    onState: setFlightState,
  };
  const views = startViews([
    ['fc-map', createMapView],
    ['fc-phases', createPhaseStrip],
    ['fc-rocketbar', createRocketBar],
  ], ctx);
  const [hud] = startViews([['fc-hud', createHud]], ctx);
  stage = { store, session, ctx, views: [...views, hud], hud };
  spaces?.findCorner();
  return stage;
}

// Leaving for the landing: the stage goes, and so does any replay store.
function closeStage() {
  if (!stage) return;
  stopViews(stage.views, STAGE_MOUNTS);
  stage = null;
  retired?.clearAll();
  retired = null;
  setFlightState({ state: STATE.IDLE }, { quiet: true });
}

// Points the stage at another store, after the session says what it is.
function showOnStage(store, session) {
  const s = ensureStage();
  Object.assign(s.session, session);
  s.store.use(store);
  if (retired && retired !== store) {
    retired.clearAll();
    retired = null;
  }
  s.hud?.refresh();
}

// The console's data-state, from the HUD's flightState(). Liftoff and the
// landing are read out, unless they came from a seek.
function setFlightState(st, { quiet = false } = {}) {
  const el = sections.console;
  const state = st?.state ?? STATE.IDLE;
  if (el.dataset.state === state) return;
  const before = el.dataset.state;
  el.dataset.state = state;
  if (quiet || screen === 'loading') return;
  if (state === STATE.FLIGHT && before === STATE.PAD) announce('Liftoff detected. The flight readout is showing.');
  else if (state === STATE.RECOVERY) announce('Landing detected. The recovery details are at the top left.');
}

// ------------------------------------------------------------------
// Saved flights
// ------------------------------------------------------------------
// The open replay: { id, entry, store, player, flight, views }.
let replay = null;

async function openFlight(id, token) {
  // The live session is made here too, so CONNECT in the bar works from a
  // replay (it goes back to live first).
  ensureLive();
  // The console stays up while the flight loads. The stage keeps showing
  // what it had, and the bar says LOADING.
  screen = 'loading';
  setMode('replay');
  setReplayChip({ name: '', loading: true });
  panels.show('globe');
  show('console');
  document.title = TITLE_CONSOLE;
  ensureStage();

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
  setReplayChip({ name: entry.title, loading: true });
  savedMenu.setCurrent(entry.id);

  // The flight's store, made now so the map can fly to the site while the
  // data downloads. Its ground station is Manta's position for this flight
  // when the library has one, otherwise the demo position in config.js.
  const store = createStore({ fleet: createFleet(), ...(entry.groundStation ? { groundStation: entry.groundStation } : {}) });
  for (const r of entry.rockets) store.registerRocket({ id: r.rocketId, name: r.name, board: r.board });
  const rp = { id: entry.id, entry, store, player: null, flight: null, views: [] };
  replay = rp;
  showOnStage(store, { kind: 'replay', loading: true, entry, prescan: new Map(), player: null });

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
  startReplay(rp, flight);
}

// The flight's data is in: the pre-scan, the player, the timeline and
// panel 2, then playback.
function startReplay(rp, flight) {
  const { entry, store } = rp;
  screen = 'replay';
  setMode('replay');
  setReplayChip({ name: entry.title, loading: false });

  // A rocket in the data that the manifest doesn't list is added now, in the
  // order it first appears, so every view knows it before playback reaches
  // its first reading.
  for (const s of flight.samples) {
    if (s.type !== 'gs' && !store.getRocket(s.rocketId)) store.registerRocket({ id: s.rocketId });
  }

  const player = createPlayer({ store });
  // Each rocket's whole-flight altitude curve and events, for the timeline
  // and the 3D view's first framing. See prescanFlight() below.
  const prescan = prescanFlight(entry, flight.samples);
  rp.player = player;
  rp.flight = {
    entry,
    truth: flight.truth,
    badRows: flight.badRows,
    badRowDetails: flight.badRowDetails,
    files: flight.files,
    notes: flight.files.flatMap((f) => f.notes ?? []),
    sampleCount: flight.samples.length,
  };
  Object.assign(stage.session, { prescan, player, loading: false });

  // The views made for this flight alone, on its own store.
  const ctx = {
    store,
    player,
    config,
    libs: stage.ctx.libs,
    tileKey,
    prescan,
    flight: rp.flight,
    link: flightUrl(entry.id).href,
    navigate,
    session: stage.session,
  };
  rp.views = startViews([
    ['fc-timeline', createTimeline],
    ['fc-data-replay', createDataPanel],
  ], ctx);

  focusHeading($('fc-replay-name'));
  player.load(flight.samples);
  player.setSpeed(config.DEFAULT_SPEED);
  player.play();
}

// ------------------------------------------------------------------
// Whole-flight pre-scan for the timeline. A second store, never shown,
// takes the whole flight at once (in the same order the player uses), so
// every rocket's full altitude curve and events are known before playback
// gets there. It is a separate copy with its own detectors: nothing it
// works out reaches the store on screen, and the views never read it as
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

// Closes the open replay: its player and its own views. Its store stays on
// the stage until the stage shows something else (see showOnStage), so the
// globe never goes blank in between.
function closeReplay() {
  if (!replay) return;
  replay.player?.destroy();
  stopViews(replay.views, REPLAY_MOUNTS);
  retired = replay.store;
  replay = null;
}

// ------------------------------------------------------------------
// The live console
// ------------------------------------------------------------------
let live = null;        // the live session, see ensureLive()

// Made the first time the console opens, then kept for the whole visit.
//   detector   which source is talking on this connection (sources.js)
//   source     the source found on this connection, or null
//   mode       'bench' or 'flight': the newest source's mode, kept after a
//              disconnect so its data stays on screen. null before any.
//   unknown    lines arrive but none match a source
//   stores     { bench, flight }: the live stores, made on first use
//   feed       the bench feed into stores.bench (bench-feed.js)
//   panel      the bench panel: CONNECT, readings, graphs, raw output, CSV
//   link       the serial port (serial-link.js)
//   linkState  the link's state ('idle', 'picking', 'opening', 'open', ...)
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
    linkState: 'idle',
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
      onLink: (state, text) => {
        next.linkState = state;
        next.panel.setLink(state, text);
        // Connected with no data yet already counts as the pad.
        stage?.hud?.refresh();
      },
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

// The live store's mode: the newest source's, or the bench store before
// any source (it has no ground station and nothing in it yet, so the 3D
// view waits looking at the whole Earth).
function liveMode() {
  return live?.mode === 'flight' ? 'flight' : 'bench';
}

// Puts the live store on the stage.
function showLive() {
  showOnStage(liveStore(liveMode()), { kind: 'live', loading: false, entry: null, prescan: new Map(), player: null });
  // The live panel 2's mission timeline strip follows the same store.
  live?.panel?.showEvents(liveStore(liveMode()));
}

// A source was found on this connection.
function useSource(source) {
  live.source = source;
  setUnknown(false);
  const mode = source.mode === 'flight' ? 'flight' : 'bench';
  liveStore(mode);
  live.mode = mode;
  if (screen === 'track') {
    setMode(mode);
    showLive();
  }
  announce(mode === 'bench'
    ? `${source.name} found. Its position is in the 3D view, and its readings and graphs are in the second panel.`
    : `${source.name} found. The 3D view is showing.`);
}

// The live store for a mode, made the first time it is needed. The bench
// store gets the bench feed, which registers the board as its one rocket.
function liveStore(mode) {
  if (!live) ensureLive();
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
// into the flight store, and the 3D view and the HUD show it.
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

// ------------------------------------------------------------------
// Start
// ------------------------------------------------------------------
window.addEventListener('popstate', () => {
  moveFocus = true;
  route();
});
route();
