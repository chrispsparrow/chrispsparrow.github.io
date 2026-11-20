// launch-panel.js: the launch panel, a column down the right side of Track
// a Rocket on the launch page (launch.html). It is the reason launch mode
// exists: after the rocket lands somewhere in a field, this panel has the
// coordinates to walk to, with no internet.
//
// It sits beside the two panels (the 3D view and the graphs), not over
// them, so it never hides the HUD or the map's controls and it stays on
// screen whichever panel is showing. flight-console-launch.css gives it the
// column. The last good fix stays pinned at the top of the column while the
// parts under it scroll. In a narrow window the panel goes under the panels.
//
// What it holds, top to bottom:
//   LAST GOOD FIX    the focused rocket's last good GPS fix, large: latitude
//                    and longitude to 6 decimals, whether that fix is
//                    current or old, the distance and bearing from the
//                    ground station, how long ago the last packet came (and
//                    when, on the computer's clock), the GPS altitude above
//                    sea level and the height above the ground when the
//                    store knows the ground level, COPY COORDINATES, and
//                    OPEN IN MAPS while the internet answers. Under those,
//                    a newer fix that doesn't go in the big numbers, when
//                    there is one, with its own COPY: a weak fix, or one
//                    that is far from the good fix and not confirmed.
//                    It never goes blank once a fix has been heard: not
//                    when packets stop, not when the cable is pulled, and
//                    not when the page is reloaded.
//   ALSO SAVED       only with two boards on the air: the saved fixes of
//                    the rockets that are not on show (see TWO BOARDS)
//   GROUND STATION   where I am standing. Two boxes, SET, and USE FIELD
//                    CENTER. The dish and the radio link on both maps and
//                    every range and bearing on the page use it.
//   FLIGHT LOG       a slot the flight log fills (js/launch/flight-log.js)
//   TEST CAPTURE     a slot the capture player fills (js/launch/capture.js)
//
// WHICH FIX. The readout follows the live store on screen (the flight
// store, or the bench store while a Dogtooth board is on the USB cable) and
// its focused rocket's crumbs, the fixes js/track.js graded good, weak or
// outlier for the trail and the 3D board marker. pickFix() in
// recovery-fix.js picks from them:
//   - The big readout is the newest good fix the readout trusts. It says
//     CURRENT FIX only while the store says the rocket has a fix now, that
//     crumb is the rocket's newest, and packets are arriving.
//   - An outlier is never shown or saved. One packet 50 km away, or at
//     0, 0, can't take the readout. A real move takes over after a few
//     fixes that agree (the trail's own number).
//   - The trail's test is not enough by itself: after a few seconds
//     without packets it takes a position kilometers away as good. So a
//     good crumb that is further from the last trusted fix than a rocket
//     gets over the ground in that time (reachM() in recovery-fix.js) is
//     held back. It shows on the lines under the readout as NEWER FIX, NOT
//     CONFIRMED, with how far it is and COPY NEWER FIX. It is never called
//     current and never saved as the main fix. It takes over once three
//     fixes in a row agree. The first fix that is back within reach of the
//     trusted one is current again at once, also when the trail calls it
//     an outlier (the trail measures from the far one by then).
//   - The same goes for the first fix after a reload or a crash. A new
//     store has nothing to measure it against and takes it as good, so it
//     is measured against the kept good fix (see THE SAVED FIX). While it
//     is out of reach of that one and fewer than three fixes back it, the
//     kept fix stays in the big readout and in storage, and the new one
//     goes under it (farUnderGood() in recovery-fix.js).
//   - A weak fix (few satellites or a high HDOP, usual for a rocket lying
//     in grass) that is newer than the good one shows on its own lines
//     under the readout: its coordinates, its satellites and HDOP, and how
//     far it is from the good fix, with COPY WEAK FIX.
//   - With no good crumb at all, the newest weak fix takes the main
//     readout, named a weak fix, and COPY COORDINATES copies it. The panel
//     never says "no fix" while it has a position.
//   - A good fix that is kept from before (see THE SAVED FIX) is worth more
//     than a weak one heard now. After a reload or a crash the store starts
//     empty, and a rocket lying in the grass may only send weak fixes. The
//     kept good fix then stays in the big readout as a saved fix, the weak
//     one goes on the lines under it, and the saved record keeps both. This
//     holds for a good fix up to six hours old (weakUnderGood() in
//     recovery-fix.js). The first good fix heard takes the readout back.
//   - With both a weak fix and one that is not confirmed, the lines under
//     the readout show the newer of the two.
// The store's own lastGoodFix skips the quality gate and the outlier test,
// so the panel doesn't read it. The map, the trail and the HUD go by the
// trail's grades, so after a far packet they can show a position the panel
// holds back. The HUD's recovery block also shows something a little
// different after a landing: the average of the fixes in the landing
// window. The two can be a few meters apart.
//
// TWO BOARDS. With two boards on the air the readout follows the rocket in
// focus (the rocket bar picks it). While that rocket has no fix of its own,
// in the store or saved, the readout stays with the rocket whose fix it
// has and follows that one in the store. So after a reload, a second board
// that is heard first never hides the first rocket's newer fixes. Every
// rocket's newest fix is kept, not only the one on show. The others are
// listed under ALSO SAVED and have their own key in localStorage
// (SAVED_OTHERS_KEY), so one rocket's fix never takes another's out of
// storage. When the focus moves to a rocket on that list, the two change
// places. CLEAR SAVED FIX clears the one on show, and the newest of the
// others then shows. Another launch tab's list is read when the page loads.
//
// THE TIMES. How long ago the last packet and the fix came, and when, are
// on the computer's clock. For the flight store they come from the flight
// feed's lastArrival() (js/live/flight-feed.js): the time the rocket's
// newest packet arrived. The feed keeps each line's own arrival time, so
// after RECOVER plays a crashed recording back, the panel shows when the
// packets really came, not when they were put back on screen. Each crumb is
// stamped with that time when the panel first sees it. The ages count up
// from there between packets. The bench store has no flight feed, so its
// times are counted back from the store's own clock. LAST PACKET under a
// saved fix only follows the live store while the packets come from the
// rocket whose fix is shown.
//
// THE SAVED FIX. The fix on show is written to localStorage as it changes
// (SAVED_FIX_KEY in recovery-fix.js), with the computer's clock, the
// altitude, the rocket's ID, a newer weak fix, a newer fix that is not
// confirmed, and the ground station used.
// A fresh page reads it back and shows it as a saved fix, with its real
// age, until a newer fix is heard. CLEAR SAVED FIX removes one from an
// earlier day. It asks first.
//   After a crash that copy is not enough. Chrome puts localStorage on the
// disk a few seconds after a write and then about once a minute, so after
// Chrome is killed (a crash, a dead battery) the saved fix can be most of a
// minute older than the last packet, or missing. The recording in IndexedDB
// is written within a quarter of a second and does survive. So the panel
// asks the console for recordings left unfinished (the ones RECOVER
// offers, never a test capture's), reads the newest fix out of each with
// lastFixInLines(), by the same rule as the readout, and when that is newer
// than the saved copy it becomes the saved fix, with its line's own arrival
// time, and is written back to localStorage. This happens when the panel
// starts and whenever a new unfinished recording turns up, without holding
// the panel up, and whether or not RECOVER or CONNECT is pressed. While
// such a recording waits, the saved fix says to press RECOVER. It never
// says that no newer fix has been heard, which the page can't know then.
//   RECOVER plays a recording back into the live store with the times its
// lines first arrived. When that is an earlier flight than the saved fix
// (a recording left over from a test the day before), the saved fix stays
// on the panel and in storage: older data in the store never takes a newer
// saved fix's place while nothing arrives.
//   Another launch tab on this laptop writes the same key. When it saves a
// newer fix, this panel shows it and says where it came from. It never
// writes that one back, and it stops showing it as soon as this page hears
// the rocket itself.
//
// THE TEST CAPTURE. A fix heard while the test capture plays (hub.parts.
// capture.status().playing, or the flight log saying the live view holds
// test data) is marked as a test, and the panel says so under it. It is
// dropped when the store is cleared, which the flight log does when a real
// connection follows the capture. A test fix never takes a real fix's
// place, on this page or in storage: while the capture plays the readout
// shows the test fix from the live store, and once the store is cleared the
// real saved fix is back.
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
//                     source, test, quality, sats, hdop, weak, held, under,
//                     unfinished, fromRecording, weakSince, farSince }.
//                     ageS is the fix's age in
//                     seconds and packetAgeS the newest packet's. wallMs
//                     and packetWallMs are when they arrived, on the
//                     computer's clock. source is 'live', 'reload', 'earlier'
//                     or 'tab'
//                     (see recovery-fix.js), and restored is true for
//                     'reload'. test is true for a fix from the test
//                     capture. quality is 'good' or 'weak'. weak is the
//                     newer weak fix under a good one, or null: { lat, lon,
//                     altM, sats, hdop, ageS, wallMs, fromGoodM }.
//                     held is the newer fix that is far from the good one
//                     and not confirmed, the same shape, or null. under
//                     says which of the two shows on the lines under the
//                     readout, 'weak' or 'held', or null with neither.
//                     unfinished is whether a real recording waits for
//                     RECOVER (null until storage has said), and
//                     fromRecording is true when the fix was read out of one.
//                     weakSince and farSince are for a saved good fix with
//                     the live store's own fix under it: farSince when
//                     that one is a good fix far from the saved one,
//                     weakSince when the one on the lines is weak.
//     others          the other rockets' saved fixes, newest first:
//                     [{ rocketId, lat, lon, quality, wallMs }]
//     rangeM, bearingDeg     from the ground station to the fix, or null
//     rangeText       '1,240 M AT 073° ENE', or '--'
//     copyText        what COPY COORDINATES copies, '' with no fix
//     weakCopyText    what the COPY under the readout copies (COPY WEAK
//                     FIX or COPY NEWER FIX), '' with no fix there
//     mapsLinkShown   whether the panel's OPEN IN MAPS shows
//     panelShown      whether the panel is on screen
//     replay          true while a saved flight is on screen
//     store           'flight' or 'bench', the live store it follows
//   setGroundStation(latText, lonText)   what SET does, for the tests:
//                          { ok, lat, lon } or { ok: false, box, message }
//   copy(which)            what COPY COORDINATES does, or with 'weak' the
//                          COPY under the readout. Resolves to 'copied',
//                          'blocked' or 'nothing'.
//   clearSavedFix()        clears the saved fix on show with no question
//                          (the button asks first)
//   checkRecordings()      looks for unfinished recordings now (the panel
//                          does this by itself). Resolves when it is done.
// }
//
// Used by: js/launch/launch-mode.js (startLaunchMode). Launch page only.

import { h, setText, createScheduler, copyText as copyTextOldWay } from '../views/dom.js?v=2';
import { rangeAndBearing, formatNumber, MISSING } from '../geo.js?v=3';
import { mapsUrl } from '../flight-state.js?v=4';
import { launchGroundStation, launchDetectorConfig } from './launch-mode.js';
import { parsePosition, readPair, formatDegrees, roundDegrees } from './position-input.js';
import {
  SAVED_FIX_KEY, SAVED_OTHERS_KEY, OTHERS_MAX, coordsText, distanceWords, rangeWords, measureFrom, ageWords, clockWords, altitudeWords,
  heightWords, qualityWords, arrivalMs, ageSince, fixState, pickFix, heightAboveGround, makeSavedFix, readSavedFix, readOtherFixes,
  newerRecord, weakUnderGood, keepUnder, underFix, lastFixInLines,
} from './recovery-fix.js';

// How often (ms) the panel looks again on its own: a saved fix's age comes
// from the computer's clock, which no store announces.
const LOOK_EVERY_MS = 500;
// How often (ms) the panel asks the browser's storage again for recordings
// left unfinished. It only asks while the readout shows no live fix, so
// nothing extra reads the storage during a flight.
const RECORDINGS_EVERY_MS = 2000;
// How many unfinished recordings are read for their last fix, newest first,
// and how many times one that fails to read is tried (storage that refuses
// to list them is asked that many times too).
const RECORDINGS_MAX = 5;
const RECORDING_TRIES = 3;
// Two records whose times are closer together than this (ms) hold the same
// news of the rocket. A recording that RECOVER plays back gives the same
// fix the panel read out of it, and its times may differ by a rounding.
const SAME_NEWS_MS = 1000;
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
  const localConsole = ctx.localConsole ?? null;
  const staleS = config?.LINK_STALE_S ?? 5;

  // ------------------------------------------------------------------
  // The recovery readout
  // ------------------------------------------------------------------
  const titleWords = h('span', { id: 'fcl-rec-words' }, 'LAST GOOD FIX');
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
  // Only for a weak fix in the main readout: the two numbers that make it weak.
  const qualityValue = h('dd', { id: 'fcl-quality' }, MISSING);
  const qualityRow = h('div', { class: 'fcl-row fcl-row--quality', hidden: true }, h('dt', {}, 'FIX QUALITY'), qualityValue);

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

  // A newer fix that the readout doesn't put in the big numbers, on its own
  // lines under the readout and its buttons: a weak fix, or one that is far
  // from the good fix and not confirmed (data-kind says which, and with
  // both, the newer one shows). It sits below the buttons so the
  // coordinates, the range and COPY COORDINATES don't move when it comes
  // and goes.
  const weakState = h('p', { id: 'fcl-weak-state', class: 'fcl-weak-state' });
  const weakCoords = h('p', { id: 'fcl-weak-coords', class: 'fcl-weak-coords' });
  const weakNote = h('p', { id: 'fcl-weak-note', class: 'fcl-weak-note' });
  const weakCopyButton = h('button', { id: 'fcl-weak-copy', type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: () => { copy('weak'); } }, 'COPY WEAK FIX');
  const weakCopyStatus = h('span', { id: 'fcl-weak-copied', class: 'fcl-copied', role: 'status' });
  const weakBlock = h('div', { id: 'fcl-weak', class: 'fcl-weak', hidden: true },
    weakState, weakCoords, weakNote, h('p', { class: 'fcl-actions' }, weakCopyButton, weakCopyStatus));

  // The saved fixes of the other rockets, when two boards are on the air,
  // so a fix that is not on show can still be read. It is a part of its
  // own, the first under the readout, so the readout pinned at the top of
  // the panel doesn't grow with it.
  const othersList = h('div', { id: 'fcl-others-list' });
  const othersBlock = h('section', { id: 'fcl-others', class: 'fcl-sec fcl-also', 'aria-labelledby': 'fcl-others-title', hidden: true },
    h('h2', { id: 'fcl-others-title', class: 'fcl-title' }, 'ALSO SAVED'), othersList);

  // CLEAR SAVED FIX, for a fix saved on an earlier day. Pressing it only
  // asks. The answer is a second press on a different button.
  const clearButton = h('button', { id: 'fcl-clear', type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: askClear }, 'CLEAR SAVED FIX');
  const clearYes = h('button', { id: 'fcl-clear-yes', type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: answerClear }, 'YES, CLEAR IT');
  const clearNo = h('button', { id: 'fcl-clear-no', type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: () => closeClear({ focus: true }) }, 'KEEP IT');
  const clearAsk = h('span', { class: 'fcl-clear-ask', hidden: true },
    h('span', { class: 'fcl-clear-q' }, 'CLEAR THE SAVED FIX FOR GOOD?'), clearNo, clearYes);
  const clearRow = h('p', { class: 'fcl-actions fcl-clear', hidden: true }, clearButton, clearAsk);

  const recovery = h('section', { class: 'fcl-sec fcl-recovery', 'aria-labelledby': 'fcl-rec-title', 'data-fix': 'none', 'data-quality': 'none' },
    h('div', { class: 'fcl-head' },
      h('h2', { id: 'fcl-rec-title', class: 'fcl-title' }, h('span', { class: 'sr-only' }, 'Recovery. '), titleWords),
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
      qualityRow,
      h('div', { class: 'fcl-row' }, h('dt', {}, 'GPS ALTITUDE'), altValue),
      aglRow),
    h('p', { class: 'fcl-actions fcl-actions--copy' }, copyButton, mapsLink, copyStatus),
    copyField,
    weakBlock,
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
    recovery, othersBlock, station, logSlot.section, captureSlot.section);
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
  // The kept record (and its copy in localStorage)
  // ------------------------------------------------------------------
  // kept is the newest fix this panel knows of the rocket on show, as a
  // saved-fix record. keptFrom says where it came from:
  //   'reload'     read from localStorage when the page loaded
  //   'recording'  read out of a recording that was left unfinished
  //   'tab'        saved by another launch tab on this laptop
  //   'live'       heard on this page
  // others holds the newest fix of every other rocket this panel knows,
  // by rocket ID: { record, from }. Only real fixes go there, never one
  // from the test capture. They have their own key in localStorage
  // (SAVED_OTHERS_KEY), so a second board's fix never takes the first
  // one's out of storage. See TWO BOARDS at the top.
  let kept = null;
  let keptFrom = null;
  let keptKey = '';
  const others = new Map();
  const otherKeys = new Map();   // rocket ID -> what its record was last made from
  try {
    kept = readSavedFix(globalThis.localStorage?.getItem(SAVED_FIX_KEY) ?? null);
    if (kept) keptFrom = 'reload';
    for (const record of readOtherFixes(globalThis.localStorage?.getItem(SAVED_OTHERS_KEY) ?? null)) {
      if (record.rocketId !== kept?.rocketId) others.set(record.rocketId, { record, from: 'reload' });
    }
    // The fix on show was cleared, or never written. The newest other one shows.
    if (!kept) promoteOther();
  } catch {
    // Storage is off. The readout still works, it just can't outlive the page.
  }

  function saveKept() {
    try { globalThis.localStorage?.setItem(SAVED_FIX_KEY, JSON.stringify(kept)); } catch { /* storage is off or full */ }
  }

  // The others, newest first.
  function otherRecords() {
    return [...others.values()].map((o) => o.record).sort((a, b) => (newerRecord(a, b) ? -1 : newerRecord(b, a) ? 1 : 0));
  }

  function saveOthers() {
    // Only the newest few are kept, in storage and here.
    const list = otherRecords();
    for (const record of list.slice(OTHERS_MAX)) others.delete(record.rocketId);
    try {
      if (others.size) globalThis.localStorage?.setItem(SAVED_OTHERS_KEY, JSON.stringify(list.slice(0, OTHERS_MAX)));
      else globalThis.localStorage?.removeItem(SAVED_OTHERS_KEY);
    } catch { /* storage is off or full */ }
  }

  // Makes a record the kept one. A real fix of another rocket that it takes
  // the place of moves to the others, so it stays in storage and on the
  // ALSO SAVED lines. write: false leaves storage alone (another tab's
  // record is never written back).
  function take(record, from, { write = true } = {}) {
    let changed = false;
    if (kept && !kept.test && kept.rocketId !== record.rocketId) {
      others.set(kept.rocketId, { record: kept, from: keptFrom });
      changed = true;
    }
    // A test fix never touches a real one of the same rocket ID.
    if (!record.test && others.delete(record.rocketId)) changed = true;
    otherKeys.delete(record.rocketId);
    kept = record;
    keptFrom = from;
    if (changed && write) saveOthers();
  }

  // With no kept record, the newest of the others becomes it.
  function promoteOther() {
    const next = otherRecords()[0] ?? null;
    if (!next) return;
    const { from } = others.get(next.rocketId);
    others.delete(next.rocketId);
    otherKeys.delete(next.rocketId);
    kept = next;
    keptFrom = from;
    keptKey = '';
    saveKept();
    saveOthers();
  }

  // The rocket in focus changed to one whose saved fix is among the
  // others: that one goes on show, and the one that was moves to the others.
  function showSavedOf(rocket) {
    const id = String(rocket.id);
    if (!kept || kept.rocketId === id || !others.has(id)) return;
    const { record, from } = others.get(id);
    take(record, from);
    keptKey = '';
    if (keptFrom !== 'tab') saveKept();
  }

  function forgetKept() {
    kept = null;
    keptFrom = null;
    keptKey = '';
    try { globalThis.localStorage?.removeItem(SAVED_FIX_KEY); } catch { /* storage is off */ }
    promoteOther();
  }

  function clearSavedFix() {
    forgetKept();
    closeClear({ focus: false });
    scheduler.flush();
  }

  // A record from somewhere other than the live store (an unfinished
  // recording, or another launch tab) becomes the kept one when it is newer
  // than the one kept now. A test record never takes a real one's place,
  // and a real one always takes a test's. A record with only a weak fix
  // goes under a kept good fix (weakUnderGood) and never takes its place.
  // Returns true when it was taken.
  function offer(record, from) {
    if (!record) return false;
    if (kept) {
      if (record.test && !kept.test) return false;
      const under = weakUnderGood(kept, record);
      if (under) {
        if (!newerRecord(under, kept)) return false;
        // The main fix is still the kept one, so where it came from stays.
        kept = under;
        keptKey = '';
        return true;
      }
      const realForTest = kept.test && !record.test;
      if (!realForTest && !newerRecord(record, kept)) return false;
    }
    take(record, from, { write: from !== 'tab' });
    keptKey = '';
    return true;
  }

  // The kept record stays on show, in place of what this page's own store
  // has for the same rocket, while nothing arrives here and the kept record
  // is the newer of the two:
  //   - Another tab's record. That tab hears the rocket and this page doesn't.
  //   - One from storage or from an unfinished recording, when what the
  //     store holds is older. That is a recording RECOVER put back on the
  //     live view: its lines keep the times they first arrived. An earlier
  //     flight put back this way never takes a newer saved fix off the
  //     panel. While the recording the fix was read out of plays back, the
  //     store catches up with the kept record, and from then on the store is
  //     on show.
  // A record heard on this page is the store's own, so it never does this.
  // As soon as packets arrive here, the live store is back.
  function savedWins(saved, from, silent, record) {
    if (from === 'live' || !silent || !saved || !record) return false;
    return saved.rocketId === record.rocketId && !(saved.test && !record.test) && newerRecord(saved, record, SAME_NEWS_MS);
  }
  const keptWins = (silent, record) => savedWins(kept, keptFrom, silent, record);

  // ------------------------------------------------------------------
  // Recordings left unfinished (see THE SAVED FIX at the top)
  // ------------------------------------------------------------------
  // unfinished: whether a real recording waits for RECOVER. null until the
  // browser's storage has answered once.
  let unfinished = null;
  const readTries = new Map();   // recording id -> times read (Infinity once it was read)
  let checking = null;           // the look that is running, a promise
  let checkedAt = 0;
  let checksFailed = 0;          // looks in a row that storage refused

  function checkRecordings() {
    if (checking) return checking;
    if (typeof localConsole?.unfinished !== 'function' || typeof localConsole?.readLines !== 'function') {
      unfinished = false;
      return Promise.resolve();
    }
    checking = (async () => {
      try {
        // A test capture's recording is never read: its fixes aren't the rocket's.
        const real = (await localConsole.unfinished()).filter((rec) => rec && !rec.test);
        checksFailed = 0;
        const waits = real.length > 0;
        if (waits !== unfinished) {
          unfinished = waits;
          scheduler.schedule();
        }
        for (const rec of real.slice(0, RECORDINGS_MAX)) await readRecording(rec);
      } catch (err) {
        checksFailed += 1;
        console.warn('Launch mode: could not look for an unfinished recording', err);
      } finally {
        checking = null;
        checkedAt = Date.now();
      }
    })();
    return checking;
  }

  // Reads one unfinished recording for its last fix and offers it.
  async function readRecording(rec) {
    const tries = readTries.get(rec.id) ?? 0;
    if (tries >= RECORDING_TRIES) return;
    readTries.set(rec.id, tries + 1);
    try {
      const { lines, times } = await localConsole.readLines(rec.id);
      const defaults = config?.DETECTOR_DEFAULTS ?? null;
      const record = await lastFixInLines(lines, times, {
        // The scratch store is made like the live flight store (main.js),
        // so the height above ground comes out the same.
        storeOptions: { groundStation: launchGroundStation(), ...(defaults ? { detectorConfig: launchDetectorConfig(defaults) } : {}) },
        prefer: kept?.rocketId || null,
        missingMs: rec.updatedAt ?? rec.createdAt ?? null,
        groundStation: hub.groundStation.get(),
        pause: () => new Promise((resolve) => { setTimeout(resolve, 0); }),
      });
      readTries.set(rec.id, Infinity);
      if (!record) return;
      // The saved copy is one of this recording's own packets when a line of
      // the recording arrived at exactly the copy's packet time. The end of
      // the recording is then the newer of the two by the order of its
      // lines, whatever the clock says (Windows can set the clock back in
      // the middle of a flight). Otherwise the times decide.
      const fromStorage = Boolean(kept) && (keptFrom === 'reload' || keptFrom === 'tab') && !kept.test;
      const sameFix = Boolean(kept) && kept.rocketId === record.rocketId && record.fixMs === kept.fixMs && record.packetMs === kept.packetMs &&
        (record.weak?.fixMs ?? null) === (kept.weak?.fixMs ?? null);
      const ownPacket = fromStorage && keptFrom === 'reload' && Array.isArray(times) && times.includes(kept.packetMs);
      if (ownPacket && !sameFix) {
        // A recording with only weak fixes never takes a good fix's place.
        const under = weakUnderGood(kept, record);
        if (under) kept = under;
        else take(record, 'recording');
        keptFrom = 'recording';
        keptKey = '';
      } else if (!offer(record, 'recording')) {
        // The copy in storage already is the recording's last fix (another
        // launch tab may have read the same recording first and written it
        // back). It is this recording's all the same, so RECOVER is what
        // the panel points to.
        if (fromStorage && sameFix) {
          keptFrom = 'recording';
          scheduler.schedule();
        }
        return;
      }
      saveKept();
      scheduler.flush();
    } catch (err) {
      console.warn('Launch mode: an unfinished recording could not be read for its last fix', err);
    }
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

  // True while what comes in is the test capture's: the capture is playing
  // (js/launch/capture.js says so with playing: true), or the flight log
  // says the live view holds test data (js/launch/flight-log.js, which
  // still says so after the capture has ended). A part that isn't built
  // yet, or that fails to answer, counts as no.
  function testDataNow() {
    try {
      const st = hub.parts.capture?.status?.();
      if (st && (st.playing === true || st.state === 'playing')) return true;
    } catch { /* not playing */ }
    try {
      return hub.parts.log?.liveData?.() === 'test';
    } catch {
      return false;
    }
  }

  // When each rocket's newest packet arrived, and when each crumb the
  // readout shows did, on the computer's clock. The store's own times are
  // the board's clock, which can't say what time of day it was. A rocket's
  // object is replaced when the store starts over, and so are its crumbs.
  // test says whether it arrived as test data. It is worked out once, when
  // the packet or the crumb is first seen, so it stays true afterwards.
  const packetStamps = new WeakMap();   // rocket -> { t, ms, test }
  const crumbStamps = new WeakMap();    // crumb -> { ms, test }

  // Brings a rocket's stamps up to date. Returns its newest packet's stamp,
  // what pickFix() picks from its crumbs, and the stamps of the picked ones.
  function stamp(store, rocket) {
    // A time first seen now is counted back from the newest packet's real
    // arrival (the flight feed's), or else by its age on the store's clock.
    const newestMs = feedArrival(store, rocket);
    const nowMs = Date.now();
    const arrived = (t) => arrivalMs({ t, newestT: rocket.lastPacketT, newestMs, ageS: store.ageOf(t), nowMs });
    let packet = packetStamps.get(rocket);
    if (!packet) {
      packet = { t: null, ms: null, test: false };
      packetStamps.set(rocket, packet);
    }
    if (rocket.lastPacketT !== packet.t) {
      packet.t = rocket.lastPacketT;
      packet.ms = Number.isFinite(packet.t) ? arrived(packet.t) : null;
      packet.test = testDataNow();
    }
    const stampOf = (crumb) => {
      if (!crumb) return null;
      let mark = crumbStamps.get(crumb);
      if (!mark) {
        mark = { ms: arrived(crumb.t), test: testDataNow() };
        crumbStamps.set(crumb, mark);
      }
      return mark;
    };
    const pick = pickFix(rocket.crumbs);
    return { packet, pick, main: stampOf(pick.main), weak: stampOf(pick.weak), held: stampOf(pick.held) };
  }

  // The rocket the readout follows: the one in focus. While that one has no
  // fix of its own, in the store or saved, the readout stays with the
  // rocket whose fix it has, and follows that one in the store when it is
  // there. So after a reload, a second board that is heard first never
  // hides the first rocket's newer fixes. See TWO BOARDS at the top.
  function subjectOf(store) {
    const focused = store?.getFocused?.() ?? null;
    if (!focused || !kept || String(focused.id) === kept.rocketId) return focused;
    if (others.has(String(focused.id)) || pickFix(focused.crumbs).main) return focused;
    return store.getRocket?.(kept.rocketId) ?? focused;
  }

  // The rocket's newest packet: how long ago it came, when, and whether it
  // was test data. With the flight feed's arrival time, the age counts on
  // the computer's clock from when the packet really came. Otherwise on the
  // store's. null before any packet.
  function newestPacket(store, rocket, st, nowMs) {
    if (!rocket || !Number.isFinite(rocket.lastPacketT)) return null;
    const newestMs = feedArrival(store, rocket);
    const fed = newestMs !== null;
    return {
      fed,
      ageS: fed ? ageSince(newestMs, nowMs) : store.ageOf(rocket.lastPacketT),
      ms: fed ? newestMs : st.packet.ms,
      test: st.packet.test,
    };
  }

  // Quiet by the real arrival time too. Right after RECOVER the store's
  // clock still stands at the last packet until the feed's next tick, and
  // the fix would flash up as current.
  const quiet = (store, rocket, packet) => store.isSilent(rocket) ||
    Boolean(packet?.fed && Number.isFinite(packet.ageS) && packet.ageS > staleS);

  // What the live store has for a rocket, as a saved-fix record.
  function recordOf(rocket, st) {
    const { pick } = st;
    if (!pick.main || !st.main) return null;
    return makeSavedFix({
      fix: pick.main,
      quality: pick.quality,
      weak: pick.weak ? { ...pick.weak, fixMs: st.weak.ms } : null,
      held: pick.held ? { ...pick.held, fixMs: st.held.ms } : null,
      rocketId: rocket.id,
      rocketName: rocket.profile?.name ?? '',
      fixMs: st.main.ms,
      packetMs: st.packet.ms,
      aglM: heightAboveGround(rocket, pick.main),
      aglEstimated: rocket.derived?.groundEstimated === true,
      groundStation: hub.groundStation.get(),
      test: st.main.test,
    });
  }

  // Every change in the store: the stamps and the kept record are brought
  // up to date at once, not on the next frame, so each crumb gets the time
  // its own packet arrived and a reload a moment later finds the newest fix
  // in storage. (A crash may not: see THE SAVED FIX at the top.) When the
  // store is cleared (the flight log clears it when a real connection
  // follows the test capture), a fix from the test capture goes with it. A
  // real fix stays.
  function onStoreChange(change) {
    if (change?.type === 'clear' && kept?.test) {
      forgetKept();
      scheduler.flush();
      return;
    }
    keep();
    scheduler.schedule();
  }

  // What a record of the store was made from. While it is the same, the
  // record is too.
  const recordKey = (rocket, st) => `${rocket.id}|${st.pick.main.t}|${st.pick.weak?.t ?? ''}|${st.pick.held?.t ?? ''}|${st.pick.agree}|` +
    `${rocket.lastPacketT}|${stationKey()}`;

  // Takes what the readout shows into kept, and into storage, when it (or
  // the newest packet's time) changed. Then the same for every other rocket
  // the store hears.
  function keep() {
    const store = watched;
    const rocket = subjectOf(store);
    if (rocket) {
      showSavedOf(rocket);
      keepSubject(store, rocket);
    }
    keepOthers(store, rocket);
    // Nothing on show yet, and another rocket has a fix: that one shows.
    if (!kept && others.size) promoteOther();
  }

  function keepSubject(store, rocket) {
    const st = stamp(store, rocket);
    if (!st.pick.main) return;
    const key = recordKey(rocket, st);
    if (key === keptKey) return;
    const record = recordOf(rocket, st);
    if (!record) return;
    keptKey = key;
    // A fix from the test capture never takes a real one's place, in
    // memory or in storage. The readout still shows it from the live store.
    if (kept && record.test && !kept.test) return;
    if (keptWins(quiet(store, rocket, newestPacket(store, rocket, st, Date.now())), record)) return;
    // A good fix of the same rocket is kept from before (the page was
    // reloaded or crashed), and the store has only weak fixes (the rocket
    // now lies in the grass), or a fix far from the kept one that too few
    // fixes back so far (a new store takes its first fix as good, whatever
    // it says). The kept fix stays the main one and the store's goes under
    // it. Where the kept fix came from stays as it was. Another tab's
    // record is never written back, with or without a fix under it.
    const under = keepUnder(kept, record, st.pick.agree);
    if (under) {
      kept = under;
      if (keptFrom !== 'tab') saveKept();
      return;
    }
    take(record, 'live');
    saveKept();
  }

  // The other rockets in the store: each one's newest fix is kept too, by
  // the same rules, so it is in storage whichever rocket is on show.
  function keepOthers(store, subject) {
    let changed = false;
    for (const rocket of store?.getRockets?.() ?? []) {
      const id = String(rocket.id);
      if (rocket === subject || id === kept?.rocketId) continue;
      const st = stamp(store, rocket);
      if (!st.pick.main) continue;
      const key = recordKey(rocket, st);
      if (otherKeys.get(id) === key) continue;
      otherKeys.set(id, key);
      const record = recordOf(rocket, st);
      if (!record || record.test) continue;
      const had = others.get(id) ?? null;
      if (had && savedWins(had.record, had.from, quiet(store, rocket, newestPacket(store, rocket, st, Date.now())), record)) continue;
      const under = had ? keepUnder(had.record, record, st.pick.agree) : null;
      others.set(id, under ? { record: under, from: had.from } : { record, from: 'live' });
      changed = true;
    }
    if (changed) {
      saveOthers();
      scheduler.schedule();
    }
  }

  const stationKey = () => {
    const p = hub.groundStation.get();
    return p ? `${p.lat},${p.lon}` : '';
  };

  // What the readout shows right now, or null with no fix at all:
  //   { source, quality, lat, lon, altMsl, sats, hdop, aglM, aglEstimated,
  //     rocketId, rocketName, fixAgeS, packetAgeS, fixMs, packetMs, silent,
  //     fixNow, newest, skipped, heldNewest, test, unfinished, fromRecording,
  //     weakSince, farSince, weak, held }
  // weak is the newer weak fix under a good one, and held the newer fix
  // that is far from it and not confirmed: { lat, lon, altMsl, sats, hdop,
  // ageS, ms }, or null. weakSince and farSince are for a kept good fix
  // with the store's own fix under it: farSince when that fix is a good one
  // far from the kept one, weakSince when the one on the lines below is
  // weak. With no fix but a packet from the store:
  // { source: 'none', packetAgeS, packetMs }.
  function look() {
    const store = currentStore();
    const rocket = subjectOf(store);
    const nowMs = Date.now();
    const st = rocket ? stamp(store, rocket) : null;
    const packet = newestPacket(store, rocket, st, nowMs);
    const pick = st?.pick ?? null;
    // How old a crumb of the store is: on the computer's clock from when it
    // arrived, when the flight feed says, or else on the store's clock.
    const crumbAge = (crumb, mark) => (packet?.fed && Number.isFinite(mark.ms) ? ageSince(mark.ms, nowMs) : store.ageOf(crumb.t));
    // A crumb of the store, as the lines under the readout show it.
    const lineOf = (crumb, mark) => (crumb ? {
      lat: crumb.lat,
      lon: crumb.lon,
      altMsl: crumb.altMsl,
      sats: crumb.sats,
      hdop: crumb.hdop,
      ageS: crumbAge(crumb, mark),
      ms: mark.ms,
    } : null);
    // The record that stands in below. When the store's own fix goes under
    // the kept one (keepUnder), it is the two together.
    let shown = kept;
    let farSince = false;
    let underKept = false;
    if (pick?.main) {
      const silent = quiet(store, rocket, packet);
      const record = recordOf(rocket, st);
      // The store only has weak fixes, or a fix far from the kept one that
      // too few fixes back, and a good fix of this rocket is kept: the kept
      // one stays the main fix, with the store's under it.
      const under = keepUnder(kept, record, pick.agree);
      if (under) {
        shown = under;
        underKept = true;
        farSince = record?.quality === 'good';
      } else if (!keptWins(silent, record)) {
        return {
          source: 'live',
          quality: pick.quality,
          lat: pick.main.lat,
          lon: pick.main.lon,
          altMsl: pick.main.altMsl,
          sats: pick.main.sats,
          hdop: pick.main.hdop,
          aglM: heightAboveGround(rocket, pick.main),
          aglEstimated: rocket.derived?.groundEstimated === true,
          rocketId: String(rocket.id),
          rocketName: rocket.profile?.name ?? '',
          fixAgeS: crumbAge(pick.main, st.main),
          fixMs: st.main.ms,
          packetAgeS: packet?.ageS ?? null,
          packetMs: packet?.ms ?? null,
          silent,
          fixNow: store.hasFixNow(rocket) && !silent,
          newest: pick.newest,
          skipped: pick.skipped,
          heldNewest: pick.heldNewest,
          test: st.main.test,
          unfinished,
          fromRecording: false,
          weakSince: false,
          farSince: false,
          weak: lineOf(pick.weak, st.weak),
          held: lineOf(pick.held, st.held),
        };
      }
    }
    // No fix in the store, or one that gives way to the kept record (see
    // keptWins and keepUnder). The kept record stands in: one from storage,
    // from an unfinished recording or from another tab, or one heard
    // earlier on this page that the store on screen doesn't have (its data
    // was cleared, or another board is on the cable now). A fix heard on
    // this page from a rocket that the store on screen doesn't have never
    // stands in for the rocket in focus.
    const sameRocket = Boolean(rocket) && String(rocket.id) === kept?.rocketId;
    const usable = kept && (keptFrom !== 'live' || !rocket || sameRocket);
    if (!usable) return packet ? { source: 'none', packetAgeS: packet.ageS, packetMs: packet.ms } : null;
    const ageOf = (ms) => ageSince(ms, nowMs);
    // A packet heard since (with no fix in it) is newer than the saved one,
    // but only a packet from the rocket whose fix this is, and never a test
    // packet under a real fix.
    const heard = packet && sameRocket && !(packet.test && !kept.test) && Number.isFinite(packet.ms) && packet.ms >= kept.packetMs ? packet : null;
    const savedLine = (fix) => (fix ? {
      lat: fix.lat,
      lon: fix.lon,
      altMsl: fix.altMsl,
      sats: fix.sats,
      hdop: fix.hdop,
      ageS: ageOf(fix.fixMs),
      ms: fix.fixMs,
    } : null);
    const weak = savedLine(shown.weak);
    const held = savedLine(shown.held);
    const below = underFix({ weak, held });
    return {
      source: keptFrom === 'live' ? 'earlier' : keptFrom === 'tab' ? 'tab' : 'reload',
      quality: kept.quality,
      lat: kept.lat,
      lon: kept.lon,
      altMsl: kept.altMsl,
      sats: kept.sats,
      hdop: kept.hdop,
      aglM: kept.aglM,
      aglEstimated: kept.aglEstimated,
      rocketId: kept.rocketId,
      rocketName: kept.rocketName,
      fixAgeS: ageOf(kept.fixMs),
      fixMs: kept.fixMs,
      packetAgeS: heard ? heard.ageS : ageOf(kept.packetMs),
      packetMs: heard ? heard.ms : kept.packetMs,
      silent: false,
      fixNow: false,
      newest: true,
      skipped: false,
      heldNewest: false,
      test: kept.test,
      unfinished,
      fromRecording: keptFrom === 'recording',
      // What the store has now, heard since the kept good fix: a weak fix
      // on the lines below, and a good one far from the kept fix. A fix
      // that was saved with the kept one as not confirmed, and shows on
      // the lines below, counts as that too: the line above it then never
      // says that no newer fix has been heard.
      weakSince: underKept && below?.kind === 'weak',
      farSince: farSince || below?.kind === 'held',
      weak,
      held,
    };
  }

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------
  let lastWhy = null;
  let shown = 'none';        // the source of what the readout shows now
  let fieldFor = 'main';     // which fix the copy field holds, 'main' or 'weak'

  // How far a fix on the lines below is from the good one above it, in meters.
  const apartM = (view, fix) => (fix ? measureFrom(view, fix).rangeM : null);

  function render() {
    const view = look();
    const hasFix = Boolean(view) && view.source !== 'none';
    const gs = hub.groundStation.get();
    const nowMs = Date.now();
    // Back to a saved fix after a live one: what storage said about
    // unfinished recordings may be old by now, so it is asked again.
    const source = hasFix ? view.source : 'none';
    if (shown === 'live' && source !== 'live') {
      checkedAt = 0;
      checksFailed = 0;
      unfinished = null;
      if (hasFix) view.unfinished = null;
    }
    shown = source;

    const weakMain = hasFix && view.quality === 'weak';
    setText(titleWords, weakMain ? 'LAST FIX' : 'LAST GOOD FIX');
    setText(latValue, hasFix ? formatDegrees(view.lat) : MISSING);
    setText(lonValue, hasFix ? formatDegrees(view.lon) : MISSING);
    setText(rocketName, hasFix ? rocketWords(view) : '');

    const st = hasFix ? fixState({ ...view, staleS }) : null;
    recovery.dataset.fix = !hasFix ? 'none' : !st.old ? 'current' : view.source === 'live' ? 'old' : 'saved';
    recovery.dataset.quality = hasFix ? view.quality : 'none';
    setText(stateLine, st ? st.headline : 'NO GOOD FIX HEARD YET');
    setText(detailLine, st ? st.detail : 'The rocket\'s last good GPS fix shows here and stays.');
    detailLine.hidden = Boolean(st) && !st.detail;
    announceState(st?.why ?? null);

    const rb = hasFix && gs ? rangeAndBearing(gs, view) : null;
    setText(rangeValue, rangeWords(rb));
    const packetAge = view?.packetAgeS ?? null;
    setText(packetValue, Number.isFinite(packetAge) ? `${ageWords(packetAge)} AGO, ${clockWords(view.packetMs, nowMs)}` : MISSING);
    setText(qualityValue, weakMain ? qualityWords(view) : MISSING);
    qualityRow.hidden = !weakMain;
    setText(altValue, hasFix ? altitudeWords(view.altMsl) : MISSING);
    const hasAgl = hasFix && Number.isFinite(view.aglM);
    setText(aglValue, hasAgl ? heightWords(view.aglM, view.aglEstimated) : MISSING);
    aglRow.hidden = !hasAgl;

    const coords = hasFix ? coordsText(view) : '';
    copyButton.disabled = !coords;

    // The newer fix under the readout, when there is one: a weak fix, or
    // one that is far from the good fix and not confirmed.
    const below = hasFix ? underFix(view) : null;
    const weakText = below ? coordsText(below.fix) : '';
    weakBlock.hidden = !weakText;
    if (weakText) {
      const held = below.kind === 'held';
      // A different fix on these lines than the one COPIED was said about.
      if (weakBlock.dataset.kind !== below.kind && weakCopyStatus.textContent) setText(weakCopyStatus, '');
      weakBlock.dataset.kind = below.kind;
      setText(weakState, `${held ? 'NEWER FIX, NOT CONFIRMED' : 'NEWER WEAK FIX'}, FROM ${ageWords(below.fix.ageS)} AGO`);
      setText(weakCoords, weakText);
      setText(weakNote, `${qualityWords(below.fix)}, ${distanceWords(apartM(view, below.fix))} FROM THE GOOD FIX`);
      setText(weakCopyButton, held ? 'COPY NEWER FIX' : 'COPY WEAK FIX');
    } else if (weakCopyStatus.textContent) {
      setText(weakCopyStatus, '');
    }

    // The other rockets' saved fixes: which rocket and how old, then its
    // coordinates on a line of their own, so they never break in two.
    const alsoSaved = otherRecords().slice(0, OTHERS_MAX);
    othersBlock.hidden = alsoSaved.length === 0;
    while (othersList.children.length > alsoSaved.length) othersList.lastChild.remove();
    while (othersList.children.length < alsoSaved.length) {
      othersList.append(h('div', { class: 'fcl-other' }, h('p', { class: 'fcl-weak-note' }), h('p', { class: 'fcl-weak-coords' })));
    }
    alsoSaved.forEach((record, i) => {
      const [who, where] = othersList.children[i].children;
      const what = record.quality === 'weak' ? 'WEAK FIX FROM' : 'FROM';
      setText(who, `${rocketWords(record) || 'A ROCKET'}, ${what} ${ageWords(ageSince(record.fixMs, nowMs))} AGO`);
      setText(where, coordsText(record));
    });

    // The fallback field follows the fix it was opened for, and goes when
    // that fix does.
    if (!copyField.hidden) {
      const text = fieldFor === 'weak' ? weakText : coords;
      if (!text) copyField.hidden = true;
      else if (copyField.value !== text) copyField.value = text;
    }

    // OPEN IN MAPS only while the internet answers. The link carries the
    // numbers the readout shows, so one that rounds to zero has no minus sign.
    const url = hasFix && hub.online.get() ? mapsUrl({ lat: roundDegrees(view.lat), lon: roundDegrees(view.lon) }) : '';
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

  // Tells screen readers when the fix on the panel stops being current. One
  // position left out as a jump is not announced, and neither is the fix
  // coming back after it: that would be said every time one packet is bad.
  function announceState(why) {
    if (why === lastWhy) return;
    const before = lastWhy;
    lastWhy = why;
    if (before === null || !ctx.announce) return;
    if (why === 'no-packets') ctx.announce('Packets from the rocket have stopped. Its last good fix stays on the launch panel.');
    else if (why === 'no-fix') ctx.announce('The rocket has no good GPS fix now. Its last good fix stays on the launch panel.');
    else if (why === 'current' && before !== 'current' && before !== 'jump' && before !== 'far') ctx.announce('The rocket has a good GPS fix again.');
  }

  // ------------------------------------------------------------------
  // COPY COORDINATES, and COPY WEAK FIX or COPY NEWER FIX for the fix on
  // the lines under the readout ('weak' here, whichever of the two it is).
  // If the browser blocks copying, the coordinates show in a field, already
  // selected, to copy by hand.
  // ------------------------------------------------------------------
  const copyTimers = { main: null, weak: null };
  async function copy(which = 'main') {
    const view = look();
    const hasFix = Boolean(view) && view.source !== 'none';
    const below = hasFix && which === 'weak' ? underFix(view) : null;
    const fix = !hasFix ? null : which === 'weak' ? below?.fix ?? null : view;
    const coords = fix ? coordsText(fix) : '';
    if (!coords) return 'nothing';
    const kind = which === 'weak' ? 'weak' : 'main';
    const said = kind === 'weak' ? weakCopyStatus : copyStatus;
    clearTimeout(copyTimers[kind]);
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
      setText(said, `COPIED ${coords}`);
      copyTimers[kind] = setTimeout(() => setText(said, ''), config?.LINK_COPIED_MS ?? 2500);
      return 'copied';
    }
    setText(copyStatus, COPY_BLOCKED);
    fieldFor = kind;
    copyField.setAttribute('aria-label', kind !== 'weak' ? 'Last good fix coordinates'
      : below?.kind === 'held' ? 'Newer fix coordinates, not confirmed' : 'Newer weak fix coordinates');
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
  // changes hub.groundStation: both live stores move their ground station
  // (the dish, the radio link and every distance follow through the store),
  // and the readout measures from the new spot at once. A store made later
  // starts from it (main.js). The bench store is included because the
  // receiver's newer firmware feeds the rocket's packets into it.
  function applyGroundStation() {
    const next = launchGroundStation();
    for (const store of [live?.stores?.flight, live?.stores?.bench]) {
      const now = store?.getGroundStation?.() ?? null;
      const same = (!next && !now) || (next && now && next.lat === now.lat && next.lon === now.lon && now.source === next.source);
      if (store?.setGroundStation && !same) store.setGroundStation(next);
    }
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
    // Storage is asked again for unfinished recordings until it has
    // answered once, and after that only while no live fix is on show. A
    // storage that keeps refusing is left alone after a few tries. The
    // clock may have been set back, which counts as long enough.
    const since = Date.now() - checkedAt;
    const due = (since < 0 || since >= RECORDINGS_EVERY_MS) && checksFailed < RECORDING_TRIES;
    if (!checking && due && (unfinished === null || shown !== 'live')) checkRecordings();
    scheduler.schedule();
  }, LOOK_EVERY_MS);

  // After a crash, the last fix is in the recording, not in localStorage.
  checkRecordings();
  // RECOVER saved a recording: it no longer waits, so storage is asked again.
  localConsole?.onRecovered?.(() => {
    checkedAt = 0;
    checksFailed = 0;
  });

  // Another launch tab on this laptop saved a fix. It is shown, with words
  // that say where it came from, when it is newer than the one kept here.
  // A record this page itself read from the same key (at load, or from an
  // earlier one of these events) is simply the key's older value, so the
  // new value takes its place without asking the clock, which Windows can
  // set back. Either way a test record never takes a real one's place. The
  // record is never written back: that tab owns its copy. A key that was
  // removed there (CLEAR SAVED FIX in that tab) changes nothing here.
  globalThis.addEventListener?.('storage', (e) => {
    if (e.key !== SAVED_FIX_KEY || typeof e.newValue !== 'string') return;
    const record = readSavedFix(e.newValue);
    if (!record) return;
    if (kept && (keptFrom === 'reload' || keptFrom === 'tab')) {
      if (record.test && !kept.test) return;
      // That tab's fix of another rocket: the one kept here stays on the
      // ALSO SAVED lines, and storage is left to that tab.
      take(record, 'tab', { write: false });
      keptKey = '';
    } else if (!offer(record, 'tab')) {
      return;
    }
    scheduler.flush();
  });

  function status() {
    const view = look();
    const hasFix = Boolean(view) && view.source !== 'none';
    const gs = hub.groundStation.get();
    const st = hasFix ? fixState({ ...view, staleS }) : null;
    const m = hasFix ? measureFrom(gs, view) : { rangeM: null, bearingDeg: null };
    const below = hasFix ? underFix(view) : null;
    // A fix on the lines under the readout, for the tests.
    const line = (fix) => (fix ? {
      lat: fix.lat,
      lon: fix.lon,
      altM: fix.altMsl,
      sats: fix.sats,
      hdop: fix.hdop,
      ageS: fix.ageS,
      wallMs: fix.ms,
      fromGoodM: apartM(view, fix),
    } : null);
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
        quality: view.quality,
        sats: view.sats,
        hdop: view.hdop,
        weak: line(view.weak),
        held: line(view.held),
        under: below?.kind ?? null,
        unfinished: view.unfinished,
        fromRecording: view.fromRecording === true,
        weakSince: view.weakSince === true,
        farSince: view.farSince === true,
      } : null,
      others: otherRecords().slice(0, OTHERS_MAX).map((record) => ({
        rocketId: record.rocketId,
        lat: record.lat,
        lon: record.lon,
        quality: record.quality,
        wallMs: record.fixMs,
      })),
      rangeM: m.rangeM,
      bearingDeg: m.bearingDeg,
      rangeText: rangeWords(m.rangeM === null ? null : { distanceM: m.rangeM, bearingDeg: m.bearingDeg }),
      copyText: hasFix ? coordsText(view) : '',
      weakCopyText: below ? coordsText(below.fix) : '',
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
    checkRecordings,
  };
}
