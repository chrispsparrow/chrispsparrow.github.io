// hud.js
// The HUD over the 3D view, drone-camera style: white mono text with a
// thin black outline straight on the picture, no boxes. It fills four
// blocks, each its own child of the overlay grid (flight-console.css
// places them):
//
//   top left      the flight time and the phase on one line (T+0:56  DROGUE),
//                 then small honest labels (simulated or real flight, liftoff
//                 time estimated, data starts in flight, ground level
//                 estimated). Under them the pad checklist (PAD) or the
//                 recovery block (RECOVERY).
//   top right     ALT (the largest number on the screen), VS with an up or
//                 down arrow, GS, and the [ MORE ] button
//   more          the full readings list, a column under the top right
//                 readout that scrolls inside itself (closed at first)
//   bottom left   GPS (satellites and fix), HDOP and PKT (the last
//                 packet's age)
//
// Which blocks show is decided by the console's data-state (idle, pad,
// flight or recovery), which main.js sets from flightState(). The HUD works
// that state out on every draw and hands it to ctx.onState(), so the page
// and the HUD always agree.
//
// The rules it keeps (see "What the page promises" in the README):
//   - A missing value shows "--", never 0, and gets no unit.
//   - Old values never look live. An old altitude turns its line amber and
//     says how old it is, and VS shows "--" while the altitude is old.
//   - A warning (no fix, packets gone stale, an old altitude) turns its line
//     amber and blinks it once. Every value sits in a fixed-width field, so
//     the layout never moves when a value or a warning changes.
//
// ctx (from main.js):
//   store         the store to read. The console passes a store switch
//                 (store-switch.js), so a 'source' change means "start over".
//   config        js/config.js
//   session       { kind: 'live' | 'replay', entry, ... }, read fresh on
//                 every draw
//   isConnected() true while the live serial link is open
//   onState(state, { quiet })   called on every draw with flightState()
//
// createHud(root, ctx) -> { refresh(), destroy() }. root is an element with
// display: contents (#fc-hud), so the four blocks are grid items of the
// overlay.
//
// Used by: main.js. Reads the store, never other views.

import { h, setText, setChildren, createScheduler, copyText } from './dom.js';
import { hudAge } from './hud-text.js?v=3';
import { GROUPS, GROUP_LABELS, channelsInGroup } from '../schema.js';
import { flightState, padChecklist, recoveryInfo, groundSpeed, STATE } from '../flight-state.js';
import {
  formatNumber, formatFlightClock, formatRangeBearing, rangeAndBearing, metersToFeet, MISSING,
} from '../geo.js';

// The phase word next to the flight time, for each detector phase.
const PHASE_WORDS = Object.freeze({
  waiting: 'PAD',
  pad: 'PAD',
  ascent: 'ASCENT',
  descent: 'DESCENT',
  drogue: 'DROGUE',
  main: 'MAIN',
  landed: 'LANDED',
});

// The pad checklist and the recovery block line their values up in one
// column, like "GPS LOCK ...... 12 SAT": the label, a space, dots and a
// space take this many characters.
const LEADER_COLUMNS = 16;

// How long (ms) a warning's one blink lasts. It matches the CSS animation,
// and clears the mark when there is no animation to end it (less motion).
const BLINK_MS = 700;

let instances = 0;

export function createHud(root, ctx) {
  const { store, config } = ctx;
  const n = ++instances;

  // ------------------------------------------------------------------
  // Top left: the clock and phase, the labels, the checklist, recovery
  // ------------------------------------------------------------------
  const clockTime = h('span', { class: 'fc-hud-time' });
  const clockPhase = h('span', { class: 'fc-hud-phase' });
  const flags = h('p', { class: 'fc-hud-flags' });

  const pad = {
    gps: leaderRow('GPS LOCK'),
    hdop: leaderRow('HDOP'),
    link: leaderRow('LINK'),
    status: leaderRow('STATUS'),
  };
  const padList = h('dl', { class: 'fc-hud-list fc-hud-pad', 'aria-label': 'Pad checklist' },
    pad.gps.row, pad.hdop.row, pad.link.row, pad.status.row);

  const rec = {
    lastFix: leaderRow('LAST FIX'),
    distance: leaderRow('DISTANCE'),
    bearing: leaderRow('BEARING'),
  };
  const copyButton = h('button', { type: 'button', class: 'fc-bkt fc-bkt--sm', onclick: onCopy }, 'COPY COORDINATES');
  const mapsLink = h('a', { class: 'fc-bkt fc-bkt--sm', target: '_blank', rel: 'noopener' }, 'OPEN IN MAPS');
  const copyStatus = h('span', { class: 'fc-hud-copied', role: 'status' });
  // Shown only when the browser blocks copying: the coordinates, ready to
  // select and copy by hand.
  const copyField = h('input', {
    class: 'fc-hud-copy-field',
    type: 'text',
    readOnly: true,
    'aria-label': 'Recovery coordinates',
    hidden: true,
    onfocus: (e) => e.target.select(),
  });
  const recBlock = h('div', { class: 'fc-hud-recovery' },
    h('h3', { class: 'sr-only' }, 'Recovery'),
    h('dl', { class: 'fc-hud-list' }, rec.lastFix.row, rec.distance.row, rec.bearing.row),
    h('p', { class: 'fc-hud-actions' }, copyButton, mapsLink, copyStatus),
    copyField);

  const tl = h('section', { class: 'fc-hud-tl', 'data-fc-cover': '', 'aria-labelledby': `fc-hud-title-${n}` },
    h('h2', { class: 'sr-only', id: `fc-hud-title-${n}` }, 'Flight status'),
    h('p', { class: 'fc-hud-clock' }, clockTime, clockPhase),
    flags,
    padList,
    recBlock);

  // ------------------------------------------------------------------
  // Top right: ALT, VS, GS and MORE
  // ------------------------------------------------------------------
  // ALT's label sits above it, and the number grows to the left from the
  // right edge, so nothing else moves when it gains a digit.
  const alt = valueCell('fc-hud-big', 0);
  const altNote = h('p', { class: 'fc-hud-note' });
  const altRow = h('div', { class: 'fc-hud-alt' },
    h('span', { class: 'fc-hud-label' }, 'ALT'), alt.value);
  const altLine = { row: altRow, warn: false, blinkTimer: null };
  const vs = row('VS', 5);
  const gs = row('GS', 5);
  const moreId = `fc-hud-more-${n}`;
  const moreButton = h('button', {
    type: 'button',
    class: 'fc-bkt fc-bkt--sm fc-hud-more-button',
    'aria-expanded': 'false',
    'aria-controls': moreId,
    onclick: () => setMore(more.hidden),
  }, 'MORE');
  const tr = h('section', { class: 'fc-hud-tr', 'data-fc-cover': '', 'aria-label': 'Altitude and speed' },
    altRow, altNote,
    h('dl', { class: 'fc-hud-list' }, vs.row, gs.row),
    moreButton);

  // ------------------------------------------------------------------
  // The MORE column
  // ------------------------------------------------------------------
  const moreBody = h('div', { class: 'fc-hud-more-body' });
  const more = h('section', { class: 'fc-hud-more', id: moreId, 'data-fc-cover': '', 'aria-label': 'All readings', tabindex: '-1', hidden: true },
    moreBody);

  // ------------------------------------------------------------------
  // Bottom left: GPS, HDOP and PKT
  // ------------------------------------------------------------------
  const gps = row('GPS', 12);
  const hdop = row('HDOP', 12);
  const pkt = row('PKT', 12);
  const bl = h('section', { class: 'fc-hud-bl', 'data-fc-cover': '', 'aria-label': 'GPS and radio link' },
    h('dl', { class: 'fc-hud-list' }, gps.row, hdop.row, pkt.row));

  setChildren(root, tl, tr, more, bl);

  // ------------------------------------------------------------------
  // Small builders
  // ------------------------------------------------------------------

  // A value with an optional arrow (read out as "rising" or "falling") and
  // a unit, in a field `width` characters wide.
  function valueCell(className, width) {
    const arrow = h('span', { class: 'fc-hud-arrow', 'aria-hidden': 'true' });
    const sr = h('span', { class: 'sr-only' });
    const num = h('span', { class: 'fc-hud-num', style: width ? { minWidth: `${width}ch` } : null });
    const unit = h('span', { class: 'fc-hud-unit' });
    const value = h('span', { class: `fc-hud-value ${className}` }, arrow, sr, num, unit);
    return { value, arrow, sr, num, unit };
  }

  // One "LABEL  value" line of the readout.
  function row(label, width) {
    const cell = valueCell('', width);
    const el = h('div', { class: 'fc-hud-row' },
      h('dt', { class: 'fc-hud-label' }, label),
      h('dd', {}, cell.value));
    return { row: el, cell, text: cell.num, warn: false, blinkTimer: null };
  }

  // One "LABEL ...... value" line of the checklist or the recovery block.
  // The dots are only for the eye, so screen readers skip them.
  function leaderRow(label) {
    const dots = '.'.repeat(Math.max(2, LEADER_COLUMNS - label.length - 2));
    const value = h('dd', { class: 'fc-hud-lead-value' });
    const el = h('div', { class: 'fc-hud-row fc-hud-row--lead' },
      h('dt', {}, label, h('span', { class: 'fc-hud-leader', 'aria-hidden': 'true' }, ` ${dots} `)),
      value);
    return { row: el, text: value, warn: false, blinkTimer: null };
  }

  // Sets a line's text and its warning.
  function setLine(line, text, warn) {
    setText(line.text, text);
    setWarn(line, warn);
  }

  // Turns a line amber or back. A line that just turned amber blinks once,
  // unless the change came from a seek or a new source.
  function setWarn(line, warn) {
    if (warn === line.warn) return;
    line.warn = warn;
    line.row.classList.toggle('is-warn', warn);
    clearTimeout(line.blinkTimer);
    line.row.classList.remove('is-blink');
    if (warn && !quietDraw) {
      void line.row.offsetWidth; // restart the animation
      line.row.classList.add('is-blink');
      line.blinkTimer = setTimeout(() => line.row.classList.remove('is-blink'), BLINK_MS);
    }
  }

  // A number, its arrow and its unit. A missing value gets no unit.
  function setValue(cell, text, { unit = '', arrow = '', sr = '' } = {}) {
    setText(cell.num, text);
    setText(cell.unit, unit && text !== MISSING ? ` ${unit}` : '');
    setText(cell.arrow, arrow);
    setText(cell.sr, sr);
  }

  // ------------------------------------------------------------------
  // Drawing
  // ------------------------------------------------------------------
  let quietDraw = true;      // the draw comes from a seek, a reset or a new source: no blinks
  let lastStateKey = '';

  function render() {
    const rocket = store.getFocused();
    const connected = Boolean(ctx.isConnected?.());
    const st = flightState(store, rocket, { connected });
    ctx.onState?.(st, { quiet: quietDraw });
    if (st.state !== STATE.IDLE) {
      renderTopLeft(rocket, st);
      if (st.state === STATE.PAD) renderPad(rocket);
      if (st.state === STATE.RECOVERY) renderRecovery(rocket);
      if (st.state !== STATE.PAD && rocket?.derived) {
        renderReadout(rocket);
        renderLinkLines(rocket);
        if (!more.hidden) renderMore(rocket);
      }
    }
    // A state change can hide the MORE column's button, so the column
    // closes with it.
    if (st.state !== lastStateKey) {
      lastStateKey = st.state;
      if (st.state === STATE.IDLE || st.state === STATE.PAD) setMore(false, { focus: false });
    }
    quietDraw = false;
  }

  function renderTopLeft(rocket, st) {
    const d = rocket?.derived ?? null;
    // The clock: the time since liftoff on the store's clock, stopped at
    // the landing. Before liftoff there is no flight time, only the phase.
    let time = '';
    if (d && Number.isFinite(d.liftoffT)) {
      const end = st.state === STATE.RECOVERY && d.events?.landed ? d.events.landed.t : (store.getNow() ?? d.lastT);
      time = formatFlightClock(Math.max(0, end - d.liftoffT));
    }
    setText(clockTime, time);
    clockTime.hidden = !time;
    setText(clockPhase, PHASE_WORDS[d?.phase] ?? 'PAD');

    // Where the data comes from, and anything the console had to estimate.
    const session = ctx.session ?? {};
    const words = [];
    if (session.kind === 'replay') words.push(session.entry?.kind === 'real' ? 'REAL FLIGHT' : 'SIMULATED FLIGHT');
    else words.push('LIVE DATA');
    if (d?.liftoffEstimated && Number.isFinite(d.liftoffT)) words.push('LIFTOFF TIME ESTIMATED');
    if (d?.startedInFlight) words.push('DATA STARTS IN FLIGHT');
    if (d?.groundEstimated) words.push('GROUND LEVEL ESTIMATED');
    const key = words.join('|');
    if (flags.dataset.key !== key) {
      flags.dataset.key = key;
      setChildren(flags, words.map((w) => h('span', {}, w)));
    }
  }

  function renderPad(rocket) {
    const list = padChecklist(store, rocket);
    for (const name of ['gps', 'hdop', 'link', 'status']) setLine(pad[name], list[name].text, !list[name].ok);
  }

  function renderRecovery(rocket) {
    const info = recoveryInfo(store, rocket);
    const text = info?.text ?? { lastFix: MISSING, distance: MISSING, bearing: MISSING };
    // An old last fix is a warning: the board may have stopped sending.
    const oldFix = !Number.isFinite(info?.lastFixAgeS) || info.lastFixAgeS > config.LINK_STALE_S;
    setLine(rec.lastFix, text.lastFix, oldFix);
    setLine(rec.distance, text.distance, false);
    setLine(rec.bearing, text.bearing, false);
    const coords = info?.coordsText ?? '';
    copyButton.disabled = !coords;
    copyButton.dataset.coords = coords;
    if (info?.mapsUrl) {
      if (mapsLink.getAttribute('href') !== info.mapsUrl) mapsLink.setAttribute('href', info.mapsUrl);
      mapsLink.removeAttribute('aria-disabled');
    } else {
      mapsLink.removeAttribute('href');
      mapsLink.setAttribute('aria-disabled', 'true');
    }
    if (!copyField.hidden && copyField.value !== coords) copyField.value = coords;
  }

  function renderReadout(rocket) {
    const d = rocket.derived;
    const old = store.altitudeIsOld(rocket);
    const hasAgl = Number.isFinite(d.agl);
    setValue(alt, hasAgl ? formatNumber(d.agl, 0) : MISSING, { unit: 'M AGL' });
    // An old altitude stays on screen for recovery, but its line turns
    // amber and the note under it says how old it is. Otherwise the note
    // has the height in feet.
    const altWarn = hasAgl && old;
    setWarn(altLine, altWarn);
    let note = '';
    if (altWarn) note = `LAST READING ${hudAge(store.ageOf(d.altitudeT))} AGO`;
    else if (hasAgl) note = `${formatNumber(metersToFeet(Math.round(d.agl)), 0)} FT`;
    setText(altNote, note);
    altNote.classList.toggle('is-warn', altWarn);

    // VS only while the altitude is current. Nearly level gets no arrow.
    const v = old ? null : d.vSpeed;
    if (Number.isFinite(v)) {
      const level = Math.abs(v) < config.LEVEL_VSPEED_MPS;
      setValue(vs.cell, formatNumber(Math.abs(v), 1), {
        unit: 'M/S',
        arrow: level ? '' : v > 0 ? '▲' : '▼',
        sr: level ? '' : v > 0 ? 'rising ' : 'falling ',
      });
    } else {
      setValue(vs.cell, MISSING);
    }
    const speed = groundSpeed(store, rocket);
    setValue(gs.cell, Number.isFinite(speed.mps) ? formatNumber(speed.mps, 1) : MISSING, { unit: 'M/S' });
  }

  function renderLinkLines(rocket) {
    const silent = store.isSilent(rocket);
    const packetAge = store.ageOf(rocket.lastPacketT);
    if (rocket.sensorGroups.has('gps')) {
      const values = rocket.latestByGroup.gps?.values ?? {};
      const quiet = store.gpsIsQuiet(rocket);
      const fixNow = store.hasFixNow(rocket);
      const sats = Number.isFinite(values.sats) && !silent && !quiet ? `${formatNumber(values.sats, 0)} SAT ` : '';
      let text = fixNow ? `${sats}FIX` : `${sats}NO FIX`;
      if (silent || quiet) text = 'NO DATA';
      setLine(gps, text, !fixNow);
      const hd = Number.isFinite(values.hdop) && !silent && !quiet ? values.hdop : null;
      setLine(hdop, hd === null ? MISSING : formatNumber(hd, 2), hd !== null && hd > config.MAX_HDOP);
    } else {
      setLine(gps, 'NOT SENT', false);
      setLine(hdop, MISSING, false);
    }
    setLine(pkt, Number.isFinite(packetAge) ? `${hudAge(packetAge)} AGO` : MISSING, silent);
  }

  // ------------------------------------------------------------------
  // The MORE column: every reading, rebuilt only when the set of rows
  // changes, so it keeps its scroll.
  // ------------------------------------------------------------------
  let moreKey = null;
  let moreCells = [];

  function setMore(open, { focus = true } = {}) {
    if (open === !more.hidden) return;
    more.hidden = !open;
    moreButton.setAttribute('aria-expanded', String(open));
    moreButton.classList.toggle('is-active', open);
    if (open) {
      moreKey = null;
      const rocket = store.getFocused();
      if (rocket?.derived) renderMore(rocket);
      if (focus) more.focus({ preventScroll: true });
    } else if (focus && more.contains(document.activeElement)) {
      moreButton.focus({ preventScroll: true });
    }
  }

  function renderMore(rocket) {
    const sections = describeMore(rocket);
    const key = sections.map((s) => `${s.title}:${s.rows.map((r) => r.label).join(',')}`).join('|');
    if (key !== moreKey) {
      moreKey = key;
      moreCells = [];
      setChildren(moreBody, sections.map((s) => {
        const note = h('p', { class: 'fc-hud-more-note' });
        const rows = s.rows.map((r) => {
          const value = h('dd', {});
          const small = h('span', { class: 'fc-hud-more-small' });
          const el = h('div', { class: 'fc-hud-more-row' }, h('dt', {}, r.label), value, small);
          moreCells.push({ el, value, small });
          return el;
        });
        moreCells.push({ note });
        return h('section', { class: 'fc-hud-more-sec' },
          s.title ? h('h3', { class: 'fc-hud-more-title' }, s.title) : null,
          note,
          rows.length ? h('dl', {}, rows) : null);
      }));
    }
    let i = 0;
    for (const s of sections) {
      for (const r of s.rows) {
        const cell = moreCells[i++];
        setText(cell.value, r.value);
        setText(cell.small, r.small ?? '');
        cell.small.hidden = !r.small;
        cell.el.classList.toggle('is-warn', Boolean(r.warn));
      }
      const noteCell = moreCells[i++];
      setText(noteCell.note, s.note ?? '');
      noteCell.note.hidden = !s.note;
    }
  }

  // The sections of the MORE column. Each is { title, note, rows }, and a
  // row is { label, value, small, warn }.
  function describeMore(rocket) {
    const d = rocket.derived;
    const out = [];
    const fix = rocket.lastGoodFix;
    const hasGps = rocket.sensorGroups.has('gps');

    if (hasGps) {
      const gsPos = store.getGroundStation();
      const fromGs = fix && gsPos ? rangeAndBearing(gsPos, fix) : null;
      const fixAge = fix ? store.ageOf(fix.t) : null;
      out.push({
        title: 'POSITION',
        note: fix && !store.hasFixNow(rocket) ? 'From the last good fix.' : '',
        rows: [
          { label: 'LAT', value: fix ? `${formatNumber(fix.lat, 6)}°` : MISSING },
          { label: 'LON', value: fix ? `${formatNumber(fix.lon, 6)}°` : MISSING },
          { label: 'ALT MSL', value: fix && Number.isFinite(fix.altMsl) ? `${formatNumber(fix.altMsl, 1)} M` : MISSING },
          { label: 'LAST FIX', value: fix ? `${hudAge(fixAge)} AGO` : MISSING, warn: !fix || fixAge > config.LINK_STALE_S },
          // Left out when there is no ground station (a board on the bench).
          ...(gsPos ? [{
            label: gsPos.source === 'config' ? 'MANTA (DEMO SPOT)' : 'MANTA',
            value: fromGs ? formatRangeBearing(fromGs).toUpperCase() : MISSING,
          }] : []),
          // Any other GPS channel this board sent (new ones in the schema
          // show up here with no change).
          ...channelRows(rocket, 'gps', GPS_SHOWN, store, config),
        ],
      });
    }

    let ground = MISSING;
    if (d.phase === 'waiting') ground = 'NOT KNOWN YET';
    else if (Number.isFinite(d.groundRef)) {
      ground = `${formatNumber(d.groundRef, 0)} M MSL${d.groundEstimated ? ', ESTIMATED' : d.groundFrozen ? '' : ', AVERAGING'}`;
    }
    out.push({
      title: 'ALTITUDE',
      note: '',
      rows: [
        { label: 'MAX ALT', value: Number.isFinite(d.maxAgl) ? `${formatNumber(d.maxAgl, 0)} M AGL` : MISSING },
        { label: 'FROM', value: d.altSource === 'barometer' ? 'BAROMETER' : d.altSource === 'GPS' ? 'GPS' : MISSING },
        { label: 'LAST READING', value: Number.isFinite(d.altitudeT) ? `${hudAge(store.ageOf(d.altitudeT))} AGO` : MISSING },
        { label: 'GROUND', value: ground },
      ],
    });

    // Every other group this board really sent, straight from the schema.
    for (const group of GROUPS) {
      if (group === 'gps' || !rocket.sensorGroups.has(group)) continue;
      const rows = channelRows(rocket, group, [], store, config);
      if (!rows.length) continue;
      const age = store.ageOf(rocket.latestByGroup[group]?.t);
      const notes = [];
      if (group === 'radio') notes.push('Measured by the receiver on the ground, not by the board.');
      if (Number.isFinite(age) && age >= 2) notes.push(`Last reading ${hudAge(age).toLowerCase()} ago.`);
      out.push({ title: GROUP_LABELS[group].toUpperCase(), note: notes.join(' '), rows });
    }

    // Only real sensors on the board count here.
    const names = GROUPS.filter((g) => !NOT_SENSORS.includes(g) && rocket.sensorGroups.has(g))
      .map((g) => SENSOR_NAMES[g] ?? GROUP_LABELS[g]);
    out.push({ title: '', note: `Sensors on this board: ${names.length ? joinList(names) : 'none yet'}.`, rows: [] });

    // Fields the console has no place for, with their latest value.
    const extraKeys = [...rocket.extraKeys].sort((a, b) => a.localeCompare(b));
    if (extraKeys.length) {
      const notes = ['As read from the data file, except where noted.'];
      if (extraKeys.includes('sim_s')) notes.push('sim_s is the simulator\'s own clock.');
      if (extraKeys.includes('missed')) notes.push('missed is the receiver\'s count of lost packets.');
      if (extraKeys.includes('rebooted')) notes.push('rebooted is the receiver\'s note that the board restarted.');
      if (extraKeys.includes('time_shift_s')) notes.push('time_shift_s isn\'t in the file. The console worked it out after the board restarted.');
      if (extraKeys.includes('fileRocketId')) notes.push('fileRocketId is the ID written in the file.');
      out.push({
        title: 'OTHER VALUES',
        note: notes.join(' '),
        rows: extraKeys.map((k) => {
          const val = rocket.extraLatest[k];
          return { label: k, value: val === null || val === undefined ? MISSING : String(val), raw: true };
        }),
      });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // COPY COORDINATES. If the browser blocks copying, the coordinates show
  // in a field, already selected, to copy by hand.
  // ------------------------------------------------------------------
  let copyTimer = null;
  async function onCopy() {
    const coords = copyButton.dataset.coords ?? '';
    if (!coords) return;
    clearTimeout(copyTimer);
    copyField.hidden = true;
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(coords);
        copied = true;
      }
    } catch { copied = false; }
    if (!copied) copied = copyText(coords);
    if (copied) {
      setText(copyStatus, 'COPIED');
      copyTimer = setTimeout(() => setText(copyStatus, ''), config.LINK_COPIED_MS);
    } else {
      setText(copyStatus, 'COPYING WAS BLOCKED. COPY THEM FROM HERE.');
      copyField.value = coords;
      copyField.hidden = false;
      copyField.focus({ preventScroll: true });
      copyField.select();
    }
  }

  // ------------------------------------------------------------------
  // Updates
  // ------------------------------------------------------------------
  const scheduler = createScheduler(render, { maxFps: config.STATS_MAX_FPS });
  const unsubscribe = store.subscribe((change) => {
    // A new source, a seek or a new focus: draw now, and no blinks for
    // warnings that were already there.
    if (change.type === 'source' || change.type === 'clear' || change.type === 'reset' || change.type === 'focus' || change.type === 'rockets') {
      quietDraw = true;
      if (change.type !== 'rockets') {
        moreKey = null;
        clearTimeout(copyTimer);
        setText(copyStatus, '');
        copyField.hidden = true;
      }
      scheduler.flush();
      return;
    }
    if (change.quiet) quietDraw = true;
    scheduler.schedule();
  });
  render();

  return {
    // Draws again now, for things the store doesn't announce (the serial
    // link opening or closing).
    refresh() { scheduler.flush(); },
    destroy() {
      unsubscribe();
      scheduler.cancel();
      clearTimeout(copyTimer);
      for (const line of [altLine, gps, hdop, pkt, vs, gs, ...Object.values(pad), ...Object.values(rec)]) clearTimeout(line.blinkTimer);
      root.replaceChildren();
    },
  };
}

// Groups that aren't sensors on the board, and how the others read in a
// sentence. A new group added to the schema counts as a sensor by default.
const NOT_SENSORS = ['radio', 'status'];
const SENSOR_NAMES = { gps: 'GPS', baro: 'barometer', imu: 'IMU', power: 'battery voltage' };
// GPS channels the HUD already shows in its own lines.
const GPS_SHOWN = ['fix', 'stale', 'sats', 'hdop', 'lat', 'lon', 'altMsl', 'speed', 'course'];

// One row per channel of a group this rocket ever sent a value for, with
// the latest value. A channel that stopped while the rest of its group kept
// coming says how old its value is, so it never looks current.
function channelRows(rocket, group, skip, store, config) {
  const latest = rocket.latestByChannel[group] ?? {};
  const groupT = rocket.latestByGroup[group]?.t;
  return channelsInGroup(group)
    .filter((c) => !skip.includes(c.key) && latest[c.key])
    .map((c) => {
      const { t, value } = latest[c.key];
      const old = Number.isFinite(groupT) && groupT - t > config.LINK_STALE_S;
      return {
        label: c.label.toUpperCase(),
        value: channelValue(c, value),
        small: old ? `${hudAge(store.ageOf(t))} AGO` : '',
        warn: old,
      };
    });
}

function channelValue(channel, value) {
  if (channel.kind === 'text') return String(value);
  if (channel.kind === 'flag') return value === 1 ? 'YES' : 'NO';
  if (!Number.isFinite(value)) return MISSING;
  return `${formatNumber(value, channel.decimals ?? 1)}${channel.unit ? ` ${channel.unit}` : ''}`;
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
