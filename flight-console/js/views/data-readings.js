// data-readings.js
// The full readings list in panel 2 for a store: a saved flight at the
// playhead, or a live flight source. It looks the same as the live
// board's readings (js/live/bench-panel.js), with the same bc-* classes.
//
// The first group is the flight itself: phase, flight time, ALT AGL, the
// highest so far, VS, GS, ground level and the age of the last packet.
// Then one group for each sensor group the board really sent, built from
// the channel registry in schema.js, so a board with a barometer or an
// IMU gets those rows without any change here. Last, any values the
// console has no place for yet, as they were read from the file.
//
// Missing values show "--", never 0. Old values never look live: a value
// that stopped coming in is dimmed and says how old it is, a position from
// before the fix was lost says when it was good, and the vertical speed
// isn't shown at all once the altitude is old.
//
// It warns like the HUD does: the GPS fix row is amber with no fix, Sats
// under MIN_SATS and HDOP over MAX_HDOP are amber, and so is an old packet.
// The "From Manta" row comes from rangeReading() in flight-state.js, so in
// recovery it gives the same distance and bearing as the HUD.
//
//   const readings = createReadings(container);
//   readings.render(store, rocket, config);   // as often as it likes
//
// Used by: js/views/data-panel.js.

import { h, setText, setChildren } from './dom.js?v=2';
import { GROUPS, GROUP_LABELS, channelsInGroup } from '../schema.js?v=2';
import { groundSpeed, rangeReading } from '../flight-state.js?v=2';
import {
  formatNumber, formatAge as ageText, formatFlightClock, formatDistance, formatBearing, MISSING,
} from '../geo.js?v=2';

// Shorter labels for a few GPS channels, so the list reads like the HUD.
// Every other channel uses its label from schema.js.
const LABELS = {
  fix: 'GPS fix',
  sats: 'Sats',
  altMsl: 'ALT MSL',
  speed: 'GS from the board',
  stale: 'Position old',
};

// GPS channels that are a position. The board keeps sending its last
// position after the fix is lost, so these come from the last good fix.
const POSITION_KEYS = ['lat', 'lon', 'altMsl', 'speed', 'course'];

// Notes for the values the console has no place for yet.
const EXTRA_NOTES = {
  sim_s: 'sim_s is the simulator\'s own clock, not something the board sent.',
  missed: 'missed is the receiver\'s count of lost packets.',
  rebooted: 'rebooted is the receiver\'s note that the board restarted.',
  time_shift_s: 'time_shift_s isn\'t in the file. The console worked it out after the board restarted, to keep its times in order.',
  fileRocketId: 'fileRocketId is the ID written in the file, before the library named this rocket.',
};

export function createReadings(container) {
  let shapeKey = null;
  let cells = new Map();   // row key -> { dd, arrow, sr, text, unit, small }
  let notes = new Map();   // section id -> its note element

  function render(store, rocket, config) {
    const model = describe(store, rocket, config);
    const key = model.map((s) => `${s.id}:${s.rows.map((r) => r.key).join(',')}`).join('|');
    if (key !== shapeKey) {
      shapeKey = key;
      build(model);
    }
    update(model);
  }

  function build(model) {
    cells = new Map();
    notes = new Map();
    if (!model.length) {
      setChildren(container, h('p', { class: 'fc-dp-empty' }, 'No readings yet. They fill in as the data arrives.'));
      return;
    }
    setChildren(container, model.map((section) => {
      const note = h('p', { class: 'fc-dp-note', hidden: true });
      notes.set(section.id, note);
      return h('div', { class: 'bc-group' },
        h('h3', { class: 'bc-group-title' }, section.title),
        note,
        h('dl', { class: 'bc-readings-list' }, section.rows.map((row) => {
          const cell = {
            dd: h('dd', { class: 'bc-num' }),
            arrow: h('span', { class: 'fc-dp-arrow', 'aria-hidden': 'true' }),
            sr: h('span', { class: 'sr-only' }),
            text: h('span', {}),
            unit: h('span', { class: 'fc-dp-unit' }),
            small: h('dd', { class: 'bc-reading-note bc-num', hidden: true }),
          };
          cell.dd.append(cell.arrow, cell.sr, cell.text, cell.unit);
          cells.set(row.key, cell);
          return h('div', { class: 'bc-reading' }, h('dt', {}, row.label), cell.dd, cell.small);
        })));
    }));
  }

  function update(model) {
    for (const section of model) {
      const note = notes.get(section.id);
      if (note) {
        setText(note, section.note ?? '');
        note.hidden = !section.note;
      }
      for (const row of section.rows) {
        const cell = cells.get(row.key);
        if (!cell) continue;
        setText(cell.arrow, row.arrow ?? '');
        setText(cell.sr, row.srArrow ?? '');
        setText(cell.text, row.value);
        // A unit only goes with a real value, never with "--".
        setText(cell.unit, row.unit && row.value !== MISSING ? ` ${row.unit}` : '');
        setText(cell.small, row.small ?? '');
        cell.small.hidden = !row.small;
        const className = `bc-num${row.value === MISSING ? ' is-empty' : ''}${row.tone ? ` is-${row.tone}` : ''}`;
        if (cell.dd.className !== className) cell.dd.className = className;
      }
    }
  }

  return { render };
}

// ------------------------------------------------------------------
// What to show. A list of sections { id, title, note, rows }, each row
// { key, label, value, unit, small, arrow, srArrow, tone }:
//   small   a second line under the value (how old it is, say)
//   arrow   ▲ or ▼ before the value, hidden from screen readers, which
//           hear srArrow ("rising" or "falling") instead
//   tone    'old' (dimmed: the last known value) or 'warn' (amber)
// ------------------------------------------------------------------
function describe(store, rocket, config) {
  const d = rocket?.derived;
  if (!rocket || !d || !rocket.samples.length) return [];
  const now = store.getNow();
  const silent = store.isSilent(rocket);
  const sections = [];

  // The flight.
  const altOld = store.altitudeIsOld(rocket);
  const altAge = store.ageOf(d.altitudeT);
  const v = altOld ? null : d.vSpeed;
  // The same rule as the HUD: an arrow only when the speed on screen
  // (rounded to 0.1 m/s) is more than LEVEL_VSPEED_MPS.
  const level = Number.isFinite(v) && Math.round(Math.abs(v) * 10) / 10 <= config.LEVEL_VSPEED_MPS;
  const gs = groundSpeed(store, rocket);
  const landed = d.events?.landed;
  let flightTime = MISSING;
  if (Number.isFinite(d.liftoffT)) flightTime = formatFlightClock(Math.max(0, (landed ? landed.t : now) - d.liftoffT));
  let ground = MISSING;
  if (d.phase === 'waiting') ground = 'Not known yet';
  else if (Number.isFinite(d.groundRef)) ground = `${formatNumber(d.groundRef, 0)} m MSL${d.groundEstimated ? ', estimated' : ''}`;
  const packetAge = store.ageOf(rocket.lastPacketT);

  sections.push({
    id: 'flight',
    title: 'Flight',
    rows: [
      { key: 'phase', label: 'Phase', value: d.phase ? d.phase.toUpperCase() : MISSING },
      { key: 'time', label: 'Flight time', value: flightTime, small: landed && flightTime !== MISSING ? 'Total' : '' },
      {
        key: 'agl', label: 'ALT AGL', value: num(d.agl, 0), unit: 'm',
        tone: altOld && Number.isFinite(d.agl) ? 'old' : null,
        small: altOld && Number.isFinite(d.agl) ? `Last known, ${formatAge(altAge)}` : '',
      },
      { key: 'max', label: 'Highest AGL', value: num(d.maxAgl, 0), unit: 'm' },
      {
        key: 'vs', label: 'VS', value: Number.isFinite(v) ? formatNumber(Math.abs(v), 1) : MISSING, unit: 'm/s',
        arrow: !Number.isFinite(v) || level ? '' : v > 0 ? '▲ ' : '▼ ',
        srArrow: !Number.isFinite(v) || level ? '' : v > 0 ? 'rising ' : 'falling ',
      },
      {
        key: 'gs', label: 'GS', value: num(gs.mps, 1), unit: 'm/s',
        small: gs.source === 'fixes' ? 'From the last two fixes' : '',
      },
      { key: 'ground', label: 'Ground level', value: ground },
      {
        key: 'pkt', label: 'Last PKT', value: Number.isFinite(packetAge) ? formatAge(packetAge) : MISSING,
        tone: silent ? 'warn' : null,
      },
    ],
  });

  // GPS, with the position from the last good fix.
  if (rocket.sensorGroups.has('gps')) {
    const latest = rocket.latestByChannel.gps ?? {};
    const fix = rocket.lastGoodFix;
    const fixNow = store.hasFixNow(rocket);
    const fixAge = fix ? store.ageOf(fix.t) : null;
    const rows = [];
    for (const c of channelsInGroup('gps')) {
      if (POSITION_KEYS.includes(c.key)) {
        if (!latest[c.key] && !(fix && Number.isFinite(fix[c.key]))) continue;
        const value = fix ? channelValue(c, fix[c.key]) : MISSING;
        rows.push({
          key: `gps.${c.key}`, label: LABELS[c.key] ?? c.label, value,
          tone: !fixNow && value !== MISSING ? 'old' : null,
          small: !fixNow && value !== MISSING ? `Last good fix, ${formatAge(fixAge)}` : '',
        });
        continue;
      }
      if (!latest[c.key]) continue;
      rows.push(channelRow(store, rocket, 'gps', c, config));
    }
    // The fix row turns amber while there is no fix.
    const fixRow = rows.find((r) => r.key === 'gps.fix');
    if (fixRow && !fixNow) fixRow.tone = 'warn';
    rows.push({ key: 'gps.age', label: 'Last good fix', value: fix ? formatAge(fixAge) : MISSING, tone: fix && !fixNow ? 'warn' : null });
    // The satellite count and HDOP turn amber on the same limits as the
    // HUD's GPS and HDOP lines (the map's quality gate), while they are
    // current. An old value stays dimmed instead.
    const satsRow = rows.find((r) => r.key === 'gps.sats');
    const sats = latest.sats?.value;
    if (satsRow && !satsRow.tone && Number.isFinite(sats) && sats < config.MIN_SATS) satsRow.tone = 'warn';
    const hdopRow = rows.find((r) => r.key === 'gps.hdop');
    const hdop = latest.hdop?.value;
    if (hdopRow && !hdopRow.tone && Number.isFinite(hdop) && hdop > config.MAX_HDOP) hdopRow.tone = 'warn';
    // Distance and bearing, from rangeReading(): from Manta to the newest
    // fix, and in recovery the HUD's own answer (to the recovery position,
    // from the launch point when there is no Manta position).
    const range = rangeReading(store, rocket);
    if (range) {
      const demo = range.from === 'manta' && range.demo;
      let note = demo ? 'Demo ground station position' : '';
      if (range.recovery) note = demo ? 'From the demo spot to the recovery position' : 'To the recovery position';
      rows.push({
        key: `gps.from.${range.from}`,
        label: range.from === 'manta' ? 'From Manta' : 'From launch point',
        value: Number.isFinite(range.distanceM) ? `${formatDistance(range.distanceM)}, ${formatBearing(range.bearingDeg)}` : MISSING,
        small: note,
      });
    }
    sections.push({ id: 'gps', title: GROUP_LABELS.gps, rows });
  }

  // Every other group, straight from the channel registry.
  for (const group of GROUPS) {
    if (group === 'gps' || !rocket.sensorGroups.has(group)) continue;
    const latest = rocket.latestByChannel[group] ?? {};
    const rows = channelsInGroup(group).filter((c) => latest[c.key]).map((c) => channelRow(store, rocket, group, c, config));
    if (!rows.length) continue;
    sections.push({
      id: group,
      title: GROUP_LABELS[group],
      note: group === 'radio' ? 'Measured by the receiver on the ground, not by the board.' : '',
      rows,
    });
  }

  // Values the console has no place for yet, from the newest sample.
  const extraKeys = [...rocket.extraKeys].sort((a, b) => a.localeCompare(b));
  if (extraKeys.length) {
    const said = ['Values the console has no place for yet, as they were read from the file.',
      ...extraKeys.map((k) => EXTRA_NOTES[k]).filter(Boolean)];
    sections.push({
      id: 'extra',
      title: 'Other values',
      note: said.join(' '),
      rows: extraKeys.map((k) => {
        const val = rocket.extraLatest[k];
        return { key: `extra.${k}`, label: k, value: val === null || val === undefined ? MISSING : String(val) };
      }),
    });
  }
  return sections;
}

// One channel's row, with its newest value. A channel that stopped while
// the rest of its group kept coming, or a whole group that went quiet,
// is dimmed and says how old it is.
function channelRow(store, rocket, group, c, config) {
  const { t, value } = rocket.latestByChannel[group][c.key];
  const age = store.ageOf(t);
  const old = Number.isFinite(age) && age > config.LINK_STALE_S;
  const shown = channelValue(c, value);
  return {
    key: `${group}.${c.key}`,
    label: LABELS[c.key] ?? c.label,
    value: shown,
    tone: old && shown !== MISSING ? 'old' : null,
    small: old && shown !== MISSING ? `Last reading ${formatAge(age)}` : '',
  };
}

function channelValue(channel, value) {
  if (value === null || value === undefined) return MISSING;
  if (channel.kind === 'text') return String(value);
  if (channel.kind === 'flag') return value === 1 ? 'YES' : 'NO';
  if (!Number.isFinite(value)) return MISSING;
  const n = formatNumber(value, channel.decimals ?? 1);
  if (!channel.unit) return n;
  return channel.unit === '°' ? `${n}°` : `${n} ${channel.unit}`;
}

// "4 S AGO", in capitals like the rest of the readouts.
function formatAge(seconds) {
  return ageText(seconds).toUpperCase();
}

function num(value, decimals) {
  return Number.isFinite(value) ? formatNumber(value, decimals) : MISSING;
}
