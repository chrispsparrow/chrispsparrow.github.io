// launch-panel.js: the launch panel, a column down the right side of Track
// a Rocket on the launch page (launch.html). It is the reason launch mode
// exists: after the rocket lands somewhere in a field, this panel has the
// coordinates to walk to, with no internet.
//
// It sits beside the two panels (the 3D view and the graphs), not over
// them, so it never hides the HUD or the map's controls and it stays on
// screen whichever panel is showing. flight-console-launch.css gives it the
// column. The last good fix stays pinned at the top of the column while the
// parts under it scroll. In a window narrower than a laptop's the panel
// goes under the panels.
//
// What it holds, top to bottom:
//   LAST GOOD FIX    the focused rocket's last good GPS fix, large: latitude
//                    and longitude to 6 decimals, whether that fix is
//                    current or old, the distance and bearing from the
//                    ground station, how long ago the last packet came (and
//                    when, on the computer's clock), the GPS altitude above
//                    sea level and the height above the ground when the
//                    store knows the ground level, COPY COORDINATES, and
//                    OPEN IN MAPS while the internet answers. It never goes
//                    blank once a fix has been heard: not when packets
//                    stop, not when the cable is pulled, and not when the
//                    page is reloaded.
//   GROUND STATION   where I am standing. Two boxes, SET, and USE FIELD
//                    CENTER. The dish and the radio link on both maps and
//                    every range and bearing on the page use it.
//   FLIGHT LOG       a slot the flight log fills (js/launch/flight-log.js)
//   TEST CAPTURE     a slot the capture player fills (js/launch/capture.js)
//
// WHICH FIX. The readout follows the live store on screen (the flight
// store, or the bench store while a Dogtooth board is on the USB cable) and
// its focused rocket's lastGoodFix. That is the last fix the board itself
// called good, raw. The HUD's recovery block shows something a little
// different after a landing: the average of the fixes in the landing
// window. The two can be a few meters apart.
//
// THE TIMES. How long ago the last packet and the fix came, and when, are
// on the computer's clock. For the flight store they come from the flight
// feed's lastArrival() (js/live/flight-feed.js): the time the rocket's
// newest packet arrived. The feed keeps each line's own arrival time, so
// after RECOVER plays a crashed recording back, the panel shows when the
// packets really came, not when they were put back on screen. The ages
// count up from there between packets. The bench store has no flight feed,
// so its times are counted back from the store's own clock.
//
// THE SAVED FIX. Every new good fix is written to localStorage at once
// (SAVED_FIX_KEY in recovery-fix.js), with the computer's clock, the
// altitude, the rocket's ID and the ground station used. A fresh page reads
// it back and shows it as a saved fix, with its real age, until a newer fix
// is heard. CLEAR SAVED FIX removes one from an earlier day. It asks first.
//
// THE TEST CAPTURE. A fix heard while the test capture plays (hub.parts.
// capture.status().playing) is marked as a test, and the panel says so
// under it. It is dropped when the store is cleared, which the flight log
// does when a real connection follows the capture.
//
// A SAVED FLIGHT PLAYING. The panel stays, and says that it shows the live
// flight. A replay has its own store and its own ground station, and the
// coordinates of a rocket lying in a field are worth more than the room.
//
// createLaunchPanel({ hub, ctx }) -> {
//   el                     the panel (#fc-launch-panel)
//   slots: { log, capture }   empty boxes for the other parts' controls
//   refresh()              reads everything again and redraws now
//   status()               what is on the panel, for the other parts and the
//                          test tools (also window.fcLaunch.parts.panel):
//     groundStation   { lat, lon, typed } or null
//     fix             null, or { lat, lon, altM, aglM, rocketId, ageS,
//                     packetAgeS, wallMs, packetWallMs, old, why, restored,
//                     source, test }. ageS is the fix's age in seconds and
//                     packetAgeS the newest packet's. wallMs and
//                     packetWallMs are when they arrived, on the computer's
//                     clock. source is 'live', 'reload' or 'earlier' (see
//                     recovery-fix.js), and restored is true for 'reload'.
//                     test is true for a fix from the test capture.
//     rangeM, bearingDeg     from the ground station to the fix, or null
//     rangeText       '1,240 M AT 073° ENE', or '--'
//     copyText        what COPY COORDINATES copies, '' with no fix
//     mapsLinkShown   whether the panel's OPEN IN MAPS shows
//     panelShown      whether the panel is on screen
//     replay          true while a saved flight is on screen
//     store           'flight' or 'bench', the live store it follows
//   setGroundStation(latText, lonText)   what SET does, for the tests:
//                          { ok, lat, lon } or { ok: false, box, message }
//   copy()                 what COPY COORDINATES does. Resolves to 'copied',
//                          'blocked' or 'nothing'.
//   clearSavedFix()        clears the saved fix with no question (the
//                          button asks first)
// }
//
// Used by: js/launch/launch-mode.js (startLaunchMode). Launch page only.

import { h, setText, createScheduler, copyText as copyTextOldWay } from '../views/dom.js?v=2';
import { rangeAndBearing, formatNumber, MISSING } from '../geo.js?v=3';
import { mapsUrl } from '../flight-state.js?v=4';
import { launchGroundStation } from './launch-mode.js';
import { parsePosition, readPair, formatDegrees } from './position-input.js';
import {
  SAVED_FIX_KEY, coordsText, rangeWords, measureFrom, ageWords, clockWords, altitudeWords, heightWords,
  arrivalMs, ageSince, fixState, makeSavedFix, readSavedFix,
} from './recovery-fix.js';

// How often (ms) the panel looks again on its own: a saved fix's age comes
// from the computer's clock, which no store announces.
const LOOK_EVERY_MS = 500;
// A typed position further than this (m) from the field center gets a note
// saying how far, since a dropped minus sign lands on another continent.
const FAR_FROM_FIELD_M = 50000;
// CLEAR SAVED FIX asks first. The question goes away by itself after this
// long (ms), and its YES ignores presses for the first moment, so a double
// click on CLEAR can't answer it.
const CLEAR_ASK_MS = 8000;
const CLEAR_ARM_MS = 600;
// What COPY COORDINATES says when the browser blocks copying (the HUD says
// the same).
const COPY_BLOCKED = 'COPYING WAS BLOCKED. COPY THEM FROM HERE.';

export function createLaunchPanel({ hub, ctx }) {
  const { config, root, live } = ctx;
  const staleS = config?.LINK_STALE_S ?? 5;

  // ------------------------------------------------------------------
  // The recovery readout
  // ------------------------------------------------------------------
  const rocketName = h('span', { class: 'fcl-rocket' });
  const latValue = h('dd', { id: 'fcl-lat', class: 'fcl-coord-value' }, MISSING);
  const lonValue = h('dd', { id: 'fcl-lon', class: 'fcl-coord-value' }, MISSING);
  const stateLine = h('p', { id: 'fcl-fix-state', class: 'fcl-state' });
  const detailLine = h('p', { id: 'fcl-fix-detail', class: 'fcl-detail', hidden: true });
  const rangeValue = h('dd', { id: 'fcl-range' }, MISSING);
  const packetValue = h('dd', { id: 'fcl-packet' }, MISSING);
  const altValue = h('dd', { id: 'fcl-alt' }, MISSING);
  const aglValue = h('dd', { id: 'fcl-agl' }, MISSING);
  const aglRow = h('div', { class: 'fcl-row', hidden: true }, h('dt', {}, 'ABOVE GROUND'), aglValue);

  const copyButton = h('button', { id: 'fcl-copy', type: 'button', class: 'fc-bkt fc-bkt--sm', disabled: true, onclick: () => { copy(); } }, 'COPY COORDINATES');
  const mapsLink = h('a', { id: 'fcl-maps', class: 'fc-bkt fc-bkt--sm', target: '_blank', rel: 'noopener', hidden: true }, 'OPEN IN MAPS');
  const copyStatus = h('span', { id: 'fcl-copied', class: 'fcl-copied', role: 'status' });
  // Shown only when the browser blocks copying: the coordinates, ready to
  // select and copy by hand (the HUD's recovery block does the same). It
  // goes again once focus leaves it, so it doesn't keep the room it takes
  // in the readout pinned at the top of the panel.
  const copyField = h('input', {
    id: 'fcl-copy-field',
    class: 'fcl-copy-field',
    type: 'text',
    readOnly: true,
    'aria-label': 'Last good fix coordinates',
    hidden: true,
    onfocus: (e) => e.target.select(),
    onblur: () => {
      copyField.hidden = true;
      if (copyStatus.textContent === COPY_BLOCKED) setText(copyStatus, '');
    },
  });

  // CLEAR SAVED FIX, for a fix saved on an earlier day. Pressing it only
  // asks. The answer is a second press on a different button.
  const clearButton = h('button', { id: 'fcl-clear', type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: askClear }, 'CLEAR SAVED FIX');
  const clearYes = h('button', { id: 'fcl-clear-yes', type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: answerClear }, 'YES, CLEAR IT');
  const clearNo = h('button', { id: 'fcl-clear-no', type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: () => closeClear({ focus: true }) }, 'KEEP IT');
  const clearAsk = h('span', { class: 'fcl-clear-ask', hidden: true },
    h('span', { class: 'fcl-clear-q' }, 'CLEAR THE SAVED FIX FOR GOOD?'), clearNo, clearYes);
  const clearRow = h('p', { class: 'fcl-actions fcl-clear', hidden: true }, clearButton, clearAsk);

  const recovery = h('section', { class: 'fcl-sec fcl-recovery', 'aria-labelledby': 'fcl-rec-title', 'data-fix': 'none' },
    h('div', { class: 'fcl-head' },
      h('h2', { id: 'fcl-rec-title', class: 'fcl-title' }, h('span', { class: 'sr-only' }, 'Recovery. '), 'LAST GOOD FIX'),
      rocketName),
    h('p', { class: 'fcl-replay-note' }, 'This shows the live flight while a saved flight plays.'),
    // LAT and LON for the eye, the whole word for screen readers.
    h('dl', { class: 'fcl-coords' },
      h('div', { class: 'fcl-coord' }, h('dt', {}, h('span', { 'aria-hidden': 'true' }, 'LAT'), h('span', { class: 'sr-only' }, 'Latitude')), latValue),
      h('div', { class: 'fcl-coord' }, h('dt', {}, h('span', { 'aria-hidden': 'true' }, 'LON'), h('span', { class: 'sr-only' }, 'Longitude')), lonValue)),
    stateLine,
    detailLine,
    h('dl', { class: 'fcl-rows' },
      h('div', { class: 'fcl-row fcl-row--range' }, h('dt', {}, 'FROM GROUND STATION'), rangeValue),
      h('div', { class: 'fcl-row' }, h('dt', {}, 'LAST PACKET'), packetValue),
      h('div', { class: 'fcl-row' }, h('dt', {}, 'GPS ALTITUDE'), altValue),
      aglRow),
    h('p', { class: 'fcl-actions' }, copyButton, mapsLink, copyStatus),
    copyField,
    clearRow);

  // ------------------------------------------------------------------
  // The ground station setting
  // ------------------------------------------------------------------
  const gsState = h('span', { id: 'fcl-gs-state', class: 'fcl-head-note' });
  const gsMessage = h('p', { id: 'fcl-gs-msg', class: 'fcl-msg', 'aria-live': 'polite' });
  const box = (id, label) => h('input', {
    id,
    class: 'fcl-input',
    type: 'text',
    inputMode: 'text',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    'aria-label': label,
    'aria-describedby': 'fcl-gs-msg',
  });
  const latBox = box('fcl-gs-lat', 'Ground station latitude, in decimal degrees');
  const lonBox = box('fcl-gs-lon', 'Ground station longitude, in decimal degrees');
  const setButton = h('button', { id: 'fcl-gs-set', type: 'submit', class: 'fc-bkt fc-bkt--sm' }, 'SET');
  const resetButton = h('button', { id: 'fcl-gs-reset', type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: onReset }, 'USE FIELD CENTER');
  const gsForm = h('form', { id: 'fcl-gs-form', class: 'fcl-form', novalidate: true, onsubmit: onSet },
    h('div', { class: 'fcl-fields' },
      h('label', { class: 'fcl-field' }, h('span', { class: 'fcl-field-name', 'aria-hidden': 'true' }, 'LATITUDE'), latBox),
      h('label', { class: 'fcl-field' }, h('span', { class: 'fcl-field-name', 'aria-hidden': 'true' }, 'LONGITUDE'), lonBox)),
    gsMessage,
    h('p', { class: 'fcl-actions' }, setButton, resetButton));
  const station = h('section', { class: 'fcl-sec fcl-station', 'aria-labelledby': 'fcl-gs-title' },
    h('div', { class: 'fcl-head' },
      h('h2', { id: 'fcl-gs-title', class: 'fcl-title' }, 'GROUND STATION'),
      gsState),
    gsForm);

  // ------------------------------------------------------------------
  // The other parts' slots. A slot's section shows once something is in it.
  // ------------------------------------------------------------------
  const slot = (name, title) => {
    const inner = h('div', { id: `fc-launch-${name}`, class: 'fcl-slot', 'data-slot': name });
    const section = h('section', { class: 'fcl-sec fcl-slot-sec', 'aria-labelledby': `fcl-${name}-title` },
      h('h2', { id: `fcl-${name}-title`, class: 'fcl-title' }, title),
      inner);
    return { inner, section };
  };
  const logSlot = slot('log', 'FLIGHT LOG');
  const captureSlot = slot('capture', 'TEST CAPTURE');

  const el = h('aside', { id: 'fc-launch-panel', class: 'fcl-panel', 'aria-label': 'Launch panel' },
    recovery, station, logSlot.section, captureSlot.section);
  // The placeholder left by an earlier start, if any, makes way.
  root.querySelector('#fc-launch-panel')?.remove();
  root.append(el);
  // The readout stays at the top of the panel while the rest scrolls under
  // it (flight-console-launch.css). The panel's scroll padding is the
  // readout's height, so a box that gets focus is scrolled clear of it.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => el.style.setProperty('--fcl-rec-h', `${Math.ceil(recovery.getBoundingClientRect().height)}px`)).observe(recovery);
  }

  // ------------------------------------------------------------------
  // The saved fix (localStorage)
  // ------------------------------------------------------------------
  // kept is the newest good fix this panel knows, as a saved-fix record.
  // keptFrom says where it came from: 'reload' (read from storage when the
  // page loaded) or 'live' (heard on this page).
  let kept = null;
  let keptFrom = null;
  let keptKey = '';
  try {
    kept = readSavedFix(globalThis.localStorage?.getItem(SAVED_FIX_KEY) ?? null);
    if (kept) keptFrom = 'reload';
  } catch {
    // Storage is off. The readout still works, it just can't outlive the page.
  }

  function saveKept() {
    try { globalThis.localStorage?.setItem(SAVED_FIX_KEY, JSON.stringify(kept)); } catch { /* storage is off or full */ }
  }

  function forgetKept() {
    kept = null;
    keptFrom = null;
    keptKey = '';
    try { globalThis.localStorage?.removeItem(SAVED_FIX_KEY); } catch { /* storage is off */ }
  }

  function clearSavedFix() {
    forgetKept();
    closeClear({ focus: false });
    scheduler.flush();
  }

  // ------------------------------------------------------------------
  // Reading the live store
  // ------------------------------------------------------------------

  // The live store on screen, the way main.js picks it on the launch page:
  // the bench store while a Dogtooth board is on the USB cable, otherwise
  // the flight store.
  const storeMode = () => (live?.mode === 'bench' ? 'bench' : 'flight');
  let watched = null;
  let stopWatching = null;

  function currentStore() {
    let store = null;
    try { store = ctx.liveStore(storeMode()); } catch { store = null; }
    if (store !== watched) {
      stopWatching?.();
      watched = store;
      stopWatching = store ? store.subscribe(onStoreChange) : null;
    }
    return store;
  }

  // When the rocket's newest packet arrived, in ms on the computer's clock,
  // as the flight feed recorded it (see THE TIMES at the top), or null. Only
  // the flight store has the flight feed.
  function feedArrival(store, rocket) {
    if (!rocket || !store || store !== live?.stores?.flight) return null;
    try {
      const ms = live.flightFeed?.lastArrival?.(rocket.id);
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  }

  // When each rocket's newest packet and newest good fix arrived, on the
  // computer's clock. The store's own times are the board's clock, which
  // can't say what time of day it was. Keyed by the rocket's object, which
  // the store replaces when it starts over. fixTest says whether the fix
  // arrived while the test capture was playing. It is worked out once, when
  // the fix is first seen, so it stays true after the capture ends.
  const stamps = new WeakMap();
  function stampOf(store, rocket) {
    let s = stamps.get(rocket);
    if (!s) {
      s = { packetT: null, packetMs: null, fixT: null, fixMs: null, fixTest: false };
      stamps.set(rocket, s);
    }
    // A time first seen now is counted back from the newest packet's real
    // arrival (the flight feed's), or else by its age on the store's clock.
    const newestMs = feedArrival(store, rocket);
    const nowMs = Date.now();
    const arrived = (t) => arrivalMs({ t, newestT: rocket.lastPacketT, newestMs, ageS: store.ageOf(t), nowMs });
    if (rocket.lastPacketT !== s.packetT) {
      s.packetT = rocket.lastPacketT;
      s.packetMs = Number.isFinite(s.packetT) ? arrived(s.packetT) : null;
    }
    const fixT = rocket.lastGoodFix?.t ?? null;
    if (fixT !== s.fixT) {
      s.fixT = fixT;
      s.fixMs = Number.isFinite(fixT) ? arrived(fixT) : null;
      s.fixTest = Number.isFinite(fixT) && capturePlaying();
    }
    return s;
  }

  // True while the test capture plays (js/launch/capture.js). Its status()
  // says so with playing: true. A capture that isn't built yet, or that
  // fails to answer, counts as not playing.
  function capturePlaying() {
    try {
      const st = hub.parts.capture?.status?.();
      return Boolean(st) && (st.playing === true || st.state === 'playing');
    } catch {
      return false;
    }
  }

  // Height above the ground level the store worked out (the launch site's),
  // for a fix. null when the store has no ground level yet.
  function aglOf(rocket, fix) {
    const d = rocket?.derived;
    if (!d || d.phase === 'waiting' || !Number.isFinite(d.groundRef) || !Number.isFinite(fix?.altMsl)) return null;
    return fix.altMsl - d.groundRef;
  }

  // Every change in the store: the stamps and the saved fix are brought up
  // to date at once, not on the next frame, so a crash a moment later
  // still finds the newest fix in storage. When the store is cleared (the
  // flight log clears it when a real connection follows the test capture),
  // a fix from the test capture goes with it. A real fix stays.
  function onStoreChange(change) {
    if (change?.type === 'clear' && kept?.test) {
      forgetKept();
      scheduler.flush();
      return;
    }
    keep();
    scheduler.schedule();
  }

  // Takes the focused rocket's newest good fix into kept, and into storage
  // when it (or the newest packet's time) changed.
  function keep() {
    const store = watched;
    const rocket = store?.getFocused?.() ?? null;
    if (!rocket) return;
    const s = stampOf(store, rocket);
    const fix = rocket.lastGoodFix;
    if (!fix) return;
    const key = `${rocket.id}|${fix.t}|${rocket.lastPacketT}|${stationKey()}`;
    if (key === keptKey) return;
    const record = makeSavedFix({
      fix,
      rocketId: rocket.id,
      rocketName: rocket.profile?.name ?? '',
      fixMs: s.fixMs,
      packetMs: s.packetMs,
      aglM: aglOf(rocket, fix),
      aglEstimated: rocket.derived?.groundEstimated === true,
      groundStation: hub.groundStation.get(),
      test: s.fixTest,
    });
    if (!record) return;
    kept = record;
    keptFrom = 'live';
    keptKey = key;
    saveKept();
  }

  const stationKey = () => {
    const p = hub.groundStation.get();
    return p ? `${p.lat},${p.lon}` : '';
  };

  // What the readout shows right now, or null with no fix at all:
  //   { source, lat, lon, altMsl, aglM, aglEstimated, rocketId, rocketName,
  //     fixAgeS, packetAgeS, fixMs, packetMs, silent, fixNow, test }
  // and, with or without a fix, the newest packet when the store has one.
  function look() {
    const store = currentStore();
    const rocket = store?.getFocused?.() ?? null;
    const nowMs = Date.now();
    const s = rocket ? stampOf(store, rocket) : null;
    // With the flight feed's arrival time, the ages count on the computer's
    // clock from when the packets really came. Otherwise on the store's.
    const newestMs = feedArrival(store, rocket);
    const fed = newestMs !== null;
    const livePacket = rocket && Number.isFinite(rocket.lastPacketT)
      ? fed
        ? { ageS: ageSince(newestMs, nowMs), ms: newestMs }
        : { ageS: store.ageOf(rocket.lastPacketT), ms: s.packetMs }
      : null;
    const fix = rocket?.lastGoodFix ?? null;
    if (fix) {
      // Quiet by the real arrival time too. Right after RECOVER the store's
      // clock still stands at the last packet until the feed's next tick,
      // and the fix would flash up as current.
      const silent = store.isSilent(rocket) || (fed && Number.isFinite(livePacket?.ageS) && livePacket.ageS > staleS);
      return {
        source: 'live',
        lat: fix.lat,
        lon: fix.lon,
        altMsl: Number.isFinite(fix.altMsl) ? fix.altMsl : null,
        aglM: aglOf(rocket, fix),
        aglEstimated: rocket.derived?.groundEstimated === true,
        rocketId: String(rocket.id),
        rocketName: rocket.profile?.name ?? '',
        fixAgeS: fed && Number.isFinite(s.fixMs) ? ageSince(s.fixMs, nowMs) : store.ageOf(fix.t),
        fixMs: s.fixMs,
        packetAgeS: livePacket?.ageS ?? null,
        packetMs: livePacket?.ms ?? null,
        silent,
        fixNow: store.hasFixNow(rocket) && !silent,
        test: s.fixTest,
      };
    }
    // No fix in the store. A saved one stands in: the one read from storage
    // when the page loaded, or one heard earlier on this page that the
    // store on screen doesn't have (its data was cleared, or another board
    // is on the cable now). A fix heard on this page from another rocket
    // doesn't stand in for the rocket in focus.
    const usable = kept && (keptFrom === 'reload' || !rocket || String(rocket.id) === kept.rocketId);
    if (!usable) return livePacket ? { source: 'none', packetAgeS: livePacket.ageS, packetMs: livePacket.ms } : null;
    const ageOf = (ms) => ageSince(ms, nowMs);
    return {
      source: keptFrom === 'reload' ? 'reload' : 'earlier',
      lat: kept.lat,
      lon: kept.lon,
      altMsl: kept.altMsl,
      aglM: kept.aglM,
      aglEstimated: kept.aglEstimated,
      rocketId: kept.rocketId,
      rocketName: kept.rocketName,
      fixAgeS: ageOf(kept.fixMs),
      fixMs: kept.fixMs,
      // A packet heard since (with no fix in it) is newer than the saved one.
      packetAgeS: livePacket?.ageS ?? ageOf(kept.packetMs),
      packetMs: livePacket?.ms ?? kept.packetMs,
      silent: false,
      fixNow: false,
      test: kept.test,
    };
  }

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------
  let lastWhy = null;
  let shownCoords = '';

  function render() {
    const view = look();
    const hasFix = Boolean(view) && view.source !== 'none';
    const gs = hub.groundStation.get();
    const nowMs = Date.now();

    setText(latValue, hasFix ? formatDegrees(view.lat) : MISSING);
    setText(lonValue, hasFix ? formatDegrees(view.lon) : MISSING);
    setText(rocketName, hasFix ? rocketWords(view) : '');

    const st = hasFix ? fixState({ ...view, staleS }) : null;
    recovery.dataset.fix = !hasFix ? 'none' : !st.old ? 'current' : view.source === 'live' ? 'old' : 'saved';
    setText(stateLine, st ? st.headline : 'NO GOOD FIX HEARD YET');
    setText(detailLine, st ? st.detail : 'The rocket\'s last good GPS fix shows here and stays.');
    detailLine.hidden = Boolean(st) && !st.detail;
    announceState(st?.why ?? null);

    const rb = hasFix && gs ? rangeAndBearing(gs, view) : null;
    setText(rangeValue, rangeWords(rb));
    const packetAge = view?.packetAgeS ?? null;
    setText(packetValue, Number.isFinite(packetAge) ? `${ageWords(packetAge)} AGO, ${clockWords(view.packetMs, nowMs)}` : MISSING);
    setText(altValue, hasFix ? altitudeWords(view.altMsl) : MISSING);
    const hasAgl = hasFix && Number.isFinite(view.aglM);
    setText(aglValue, hasAgl ? heightWords(view.aglM, view.aglEstimated) : MISSING);
    aglRow.hidden = !hasAgl;

    const coords = hasFix ? coordsText(view) : '';
    copyButton.disabled = !coords;
    if (coords !== shownCoords) {
      shownCoords = coords;
      // The fallback field follows the fix. A "COPIED" from another fix goes.
      if (!copyField.hidden) copyField.value = coords;
    }
    // OPEN IN MAPS only while the internet answers.
    const url = hasFix && hub.online.get() ? mapsUrl(view) : '';
    if (url) {
      if (mapsLink.getAttribute('href') !== url) mapsLink.setAttribute('href', url);
    } else {
      mapsLink.removeAttribute('href');
    }
    mapsLink.hidden = !url;

    // CLEAR SAVED FIX shows only for a saved fix. A live one would come
    // straight back from the store.
    const canClear = hasFix && view.source !== 'live';
    clearRow.hidden = !canClear;
    if (!canClear && !clearAsk.hidden) closeClear({ focus: false });

    renderStation(gs);
  }

  function rocketWords(view) {
    const name = view.rocketName ? view.rocketName.toUpperCase() : '';
    const id = view.rocketId ? `ROCKET ${view.rocketId}` : '';
    return name && name !== id ? name : id;
  }

  // Tells screen readers when the fix on the panel stops being current.
  function announceState(why) {
    if (why === lastWhy) return;
    const before = lastWhy;
    lastWhy = why;
    if (before === null || !ctx.announce) return;
    if (why === 'no-packets') ctx.announce('Packets from the rocket have stopped. Its last good fix stays on the launch panel.');
    else if (why === 'no-fix') ctx.announce('The rocket has no good GPS fix now. Its last good fix stays on the launch panel.');
    else if (why === 'current' && before !== 'current') ctx.announce('The rocket has a good GPS fix again.');
  }

  // ------------------------------------------------------------------
  // COPY COORDINATES. If the browser blocks copying, the coordinates show
  // in a field, already selected, to copy by hand.
  // ------------------------------------------------------------------
  let copyTimer = null;
  async function copy() {
    const view = look();
    const coords = view && view.source !== 'none' ? coordsText(view) : '';
    if (!coords) return 'nothing';
    clearTimeout(copyTimer);
    copyField.hidden = true;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(coords);
        copied = true;
      }
    } catch { copied = false; }
    if (!copied) copied = copyTextOldWay(coords);
    if (copied) {
      setText(copyStatus, `COPIED ${coords}`);
      copyTimer = setTimeout(() => setText(copyStatus, ''), config?.LINK_COPIED_MS ?? 2500);
      return 'copied';
    }
    setText(copyStatus, COPY_BLOCKED);
    copyField.value = coords;
    copyField.hidden = false;
    copyField.focus({ preventScroll: true });
    copyField.select();
    return 'blocked';
  }

  // ------------------------------------------------------------------
  // CLEAR SAVED FIX
  // ------------------------------------------------------------------
  let clearTimer = null;
  let clearArmedAt = 0;
  function askClear() {
    clearButton.hidden = true;
    clearAsk.hidden = false;
    clearArmedAt = Date.now() + CLEAR_ARM_MS;
    clearNo.focus({ preventScroll: true });
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => closeClear({ focus: false }), CLEAR_ASK_MS);
  }
  function answerClear() {
    if (Date.now() < clearArmedAt) return;
    clearSavedFix();
    ctx.announce?.('The saved fix was cleared.');
  }
  function closeClear({ focus }) {
    clearTimeout(clearTimer);
    const hadFocus = clearAsk.contains(document.activeElement);
    clearAsk.hidden = true;
    clearButton.hidden = false;
    if (focus && hadFocus && !clearRow.hidden) clearButton.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------
  // The ground station
  // ------------------------------------------------------------------
  let boxesFor = null;       // the position the boxes were last filled with
  let boxesDirty = false;    // typed in since, and not SET yet

  function fillBoxes(gs) {
    latBox.value = gs ? formatDegrees(gs.lat) : '';
    lonBox.value = gs ? formatDegrees(gs.lon) : '';
    boxesFor = gs ? `${gs.lat},${gs.lon}` : '';
    boxesDirty = false;
    markBad(null);
  }

  function renderStation(gs) {
    setText(gsState, !gs ? 'NO POSITION SET' : gs.typed ? 'TYPED IN' : 'FIELD CENTER');
    station.dataset.position = !gs ? 'none' : gs.typed ? 'typed' : 'field';
    // The boxes follow the setting, unless I am in the middle of typing.
    const key = gs ? `${gs.lat},${gs.lon}` : '';
    if (key !== boxesFor && !boxesDirty) fillBoxes(gs);
    // USE FIELD CENTER has nothing to do while the field center is in use
    // and the boxes still show it. After typing, it puts the boxes back.
    const center = hub.settings?.field?.center ?? null;
    resetButton.disabled = !center || (Boolean(gs) && !gs.typed && !boxesDirty);
  }

  function markBad(which) {
    for (const [name, input] of [['lat', latBox], ['lon', lonBox]]) {
      const bad = which === name || which === 'both';
      if (bad) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    }
  }

  function say(text, kind = 'info') {
    setText(gsMessage, text);
    gsMessage.dataset.kind = kind;
  }

  // SET: reads the boxes and applies them. A bad value changes nothing.
  function setGroundStation(latText, lonText) {
    const result = parsePosition(latText, lonText);
    if (!result.ok) {
      markBad(result.box);
      say(result.message, 'warn');
      return result;
    }
    boxesDirty = false;
    boxesFor = null;
    hub.groundStation.set({ lat: result.lat, lon: result.lon });
    // How far the new spot is from the field, when it is a long way: the
    // usual slip is a minus sign left off the longitude.
    const center = hub.settings?.field?.center ?? null;
    const far = center ? rangeAndBearing(center, result) : null;
    if (far && far.distanceM > FAR_FROM_FIELD_M) {
      say(`Set. This is ${formatNumber(far.distanceM / 1000, 0)} km from the field center. Check the signs if that is wrong.`, 'warn');
    } else {
      say('Set. Range and bearing now measure from here.');
    }
    return result;
  }

  function onSet(e) {
    e.preventDefault();
    const result = setGroundStation(latBox.value, lonBox.value);
    if (!result.ok) (result.box === 'lon' ? lonBox : latBox).focus({ preventScroll: true });
  }

  function onReset() {
    boxesDirty = false;
    boxesFor = null;
    hub.groundStation.reset();
    say('Back to the field center.');
  }

  // Typing in a box: the message says the position isn't in use yet.
  function onBoxInput() {
    boxesDirty = true;
    markBad(null);
    say('Press SET to use this position.');
    renderStation(hub.groundStation.get());
  }
  // A whole position pasted into either box fills both.
  function onBoxPaste(e) {
    const pair = readPair(e.clipboardData?.getData('text') ?? '');
    if (!pair) return;
    e.preventDefault();
    latBox.value = formatDegrees(pair.lat);
    lonBox.value = formatDegrees(pair.lon);
    onBoxInput();
  }
  for (const input of [latBox, lonBox]) {
    input.addEventListener('input', onBoxInput);
    input.addEventListener('paste', onBoxPaste);
  }

  // A new position, from SET, USE FIELD CENTER or anything else that
  // changes hub.groundStation: the live flight store moves its ground
  // station (the dish, the radio link and every distance follow through
  // the store), and the readout measures from the new spot at once. A
  // flight store made later starts from it (main.js).
  function applyGroundStation() {
    const store = live?.stores?.flight ?? null;
    const next = launchGroundStation();
    const now = store?.getGroundStation?.() ?? null;
    const same = (!next && !now) || (next && now && next.lat === now.lat && next.lon === now.lon && now.source === next.source);
    if (store?.setGroundStation && !same) store.setGroundStation(next);
    keep();
    scheduler.flush();
  }

  // ------------------------------------------------------------------
  // Updates
  // ------------------------------------------------------------------
  const scheduler = createScheduler(render, { maxFps: config?.STATS_MAX_FPS ?? 10 });
  hub.groundStation.onChange(applyGroundStation);
  hub.online.onChange(() => scheduler.schedule());
  // The store may have been made before the setting was read.
  currentStore();
  applyGroundStation();
  setInterval(() => {
    currentStore();
    keep();
    scheduler.schedule();
  }, LOOK_EVERY_MS);

  function status() {
    const view = look();
    const hasFix = Boolean(view) && view.source !== 'none';
    const gs = hub.groundStation.get();
    const st = hasFix ? fixState({ ...view, staleS }) : null;
    const m = hasFix ? measureFrom(gs, view) : { rangeM: null, bearingDeg: null };
    return {
      groundStation: gs ? { lat: gs.lat, lon: gs.lon, typed: gs.typed } : null,
      fix: hasFix ? {
        lat: view.lat,
        lon: view.lon,
        altM: view.altMsl,
        aglM: view.aglM,
        rocketId: view.rocketId,
        ageS: view.fixAgeS,
        packetAgeS: view.packetAgeS,
        wallMs: view.fixMs,
        packetWallMs: view.packetMs,
        old: st.old,
        why: st.why,
        restored: view.source === 'reload',
        source: view.source,
        test: view.test === true,
      } : null,
      rangeM: m.rangeM,
      bearingDeg: m.bearingDeg,
      rangeText: rangeWords(m.rangeM === null ? null : { distanceM: m.rangeM, bearingDeg: m.bearingDeg }),
      copyText: hasFix ? coordsText(view) : '',
      mapsLinkShown: !mapsLink.hidden,
      panelShown: el.isConnected && !el.hidden && el.getClientRects().length > 0,
      replay: root.dataset.mode === 'replay',
      store: storeMode(),
    };
  }

  return {
    el,
    slots: { log: logSlot.inner, capture: captureSlot.inner },
    refresh() {
      currentStore();
      applyGroundStation();
    },
    status,
    setGroundStation,
    copy,
    clearSavedFix,
  };
}
