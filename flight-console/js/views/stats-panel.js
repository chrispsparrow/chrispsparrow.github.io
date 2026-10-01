// stats-panel.js
// Numbers for the focused rocket. The top block is always there: altitude
// above ground, vertical speed, flight time and phase, last packet age, and
// which sensor the altitude comes from. Below it is one section for each
// sensor group this rocket has actually sent, built from the channel
// registry in schema.js, so a board with a barometer or IMU gets those
// sections without any change here. Values a board never sent are never
// shown, and missing values show "--", never 0.
// Used by: main.js. Reads the store, never other views.

import { h, setText, setChildren, createScheduler } from './dom.js';
import { GROUPS, GROUP_LABELS, channelsInGroup } from '../schema.js';
import {
  formatNumber, formatAge, formatDuration, formatFlightClock, formatBearing, formatRangeBearing,
  rangeAndBearing, metersToFeet, MISSING,
} from '../geo.js';

export function createStatsPanel(root, ctx) {
  const { store, config } = ctx;
  const body = h('div', {});
  setChildren(root, h('section', { class: 'fc-panel', 'aria-labelledby': 'fc-stats-title' },
    h('div', { class: 'fc-panel-head' }, h('h2', { class: 'fc-panel-title', id: 'fc-stats-title' }, 'Readings')),
    body));

  let shapeKey = null;
  let cells = [];   // value elements, in the same order as the rows

  function render() {
    const rocket = store.getFocused();
    if (!rocket) {
      shapeKey = null;
      setChildren(body, h('p', { class: 'fc-wait' }, 'No rocket to show yet.'));
      return;
    }
    const model = describe(rocket);
    const key = `${rocket.id}#${model.map((s) => `${s.kind}:${s.title}:${s.rows.map((r) => r.label).join(',')}`).join('|')}`;
    if (key !== shapeKey) {
      shapeKey = key;
      build(model);
    }
    update(model);
  }

  // ------------------------------------------------------------------
  // What to show. Each section is { kind, title, note, rows }, each row is
  // { label, value, small, amber, prefix, srPrefix, wide }.
  // ------------------------------------------------------------------
  function describe(rocket) {
    const d = rocket.derived;
    const now = store.getNow();
    const sections = [];

    if (!d) {
      sections.push({ kind: 'wait', title: '', note: 'Waiting for the first reading from this rocket.', rows: [] });
      return sections;
    }

    // Always shown. When the altitude is old (no fix right now, or the
    // rocket went quiet), the last value stays for recovery but loses its
    // amber and says how old it is. An old vertical speed isn't shown.
    const old = store.altitudeIsOld(rocket);
    const altAge = store.ageOf(d.altitudeT);
    const v = old ? null : d.vSpeed;
    const level = Number.isFinite(v) && Math.abs(v) < config.LEVEL_VSPEED_MPS;
    let flightTime = 'On pad';
    if (d.phase === 'waiting') flightTime = MISSING;
    else if (d.liftoffT !== null) flightTime = formatFlightClock(Math.max(0, (now ?? d.lastT) - d.liftoffT));
    sections.push({
      kind: 'top',
      title: '',
      rows: [
        {
          label: 'Altitude above ground',
          value: meters(d.agl),
          small: old && Number.isFinite(d.agl) ? `Last known, ${formatAge(altAge)}` : feet(d.agl),
          amber: !old,
        },
        {
          label: 'Vertical speed',
          value: Number.isFinite(v) ? formatNumber(Math.abs(v), 1) : MISSING,
          small: Number.isFinite(v) ? 'm/s' : old && Number.isFinite(altAge) ? `No new altitude for ${formatDuration(altAge)}` : '',
          prefix: !Number.isFinite(v) || level ? '' : v > 0 ? '▲ ' : '▼ ',
          srPrefix: !Number.isFinite(v) || level ? '' : v > 0 ? 'rising ' : 'falling ',
          amber: Number.isFinite(v),
        },
        { label: 'Flight time', value: flightTime },
        { label: 'Last packet', value: formatAge(store.ageOf(rocket.lastPacketT)) },
      ],
    });
    // Until a pad is confirmed (or the data turns out to start in flight),
    // there is no ground level to show, only readings being checked.
    let groundText = MISSING;
    if (d.phase === 'waiting') groundText = 'Not known yet';
    else if (Number.isFinite(d.groundRef)) {
      groundText = `${formatNumber(d.groundRef, 0)} m above sea level${d.groundEstimated ? ', estimated' : d.groundFrozen ? '' : ', averaging pad readings'}`;
    }
    sections.push({
      kind: 'flight',
      title: '',
      rows: [
        { label: 'Phase', value: d.phaseLabel, wide: true },
        { label: 'Altitude from', value: d.altSource === 'barometer' ? 'Barometer' : d.altSource === 'GPS' ? 'GPS' : 'No altitude yet' },
        // Altitude and vertical speed above come from this reading, so its age says how current they are.
        { label: 'Last altitude reading', value: Number.isFinite(d.altitudeT) ? formatAge(store.ageOf(d.altitudeT)) : MISSING },
        { label: 'Highest so far', value: meters(d.maxAgl), small: feet(d.maxAgl) },
        { label: 'Ground level', value: groundText, wide: true },
      ],
    });

    // GPS
    if (rocket.sensorGroups.has('gps')) {
      const gps = rocket.latestByGroup.gps?.values ?? {};
      const fix = rocket.lastGoodFix;
      const silent = store.isSilent(rocket);
      const gpsQuiet = store.gpsIsQuiet(rocket);
      const fixNow = store.hasFixNow(rocket);
      const gs = store.getGroundStation();
      const fromGs = fix ? rangeAndBearing(gs, fix) : null;
      const fixAge = fix ? store.ageOf(fix.t) : null;
      const fromLastFix = fix ? ` Position values are from the last good fix, ${formatAge(fixAge)}.` : '';
      let note = '';
      if (silent) note = `No packets for ${formatDuration(store.ageOf(rocket.lastPacketT))}.${fromLastFix}`;
      else if (gpsQuiet) note = `No GPS data for ${formatDuration(store.ageOf(rocket.latestByGroup.gps.t))}, though other packets still arrive.${fromLastFix}`;
      else if (!fix) note = 'No GPS fix yet, so there is no position to show.';
      else if (!fixNow) note = `No GPS fix right now.${fromLastFix}`;
      let fixText = fixNow ? 'Fix' : 'No fix';
      if (silent || gpsQuiet) fixText = 'No recent data';
      sections.push({
        kind: 'gps',
        title: GROUP_LABELS.gps,
        note,
        rows: [
          { label: 'Fix', value: fixText, cls: fixNow ? 'fc-fix-ok' : 'fc-fix-no' },
          { label: 'Satellites', value: num(gps.sats, 0) },
          { label: 'Altitude above sea level', value: fix ? meters(fix.altMsl, 1) : MISSING },
          { label: 'HDOP', value: num(gps.hdop, 2) },
          { label: 'Latitude', value: fix ? `${formatNumber(fix.lat, 5)}°` : MISSING },
          { label: 'Longitude', value: fix ? `${formatNumber(fix.lon, 5)}°` : MISSING },
          { label: 'Horizontal speed', value: fix && Number.isFinite(fix.speed) ? `${formatNumber(fix.speed, 1)} m/s` : MISSING },
          { label: 'Course', value: courseText(fix, config.COURSE_MIN_SPEED_MPS) },
          { label: 'Last good fix', value: fix ? formatAge(fixAge) : MISSING },
          {
            label: gs.source === 'config' ? 'From the ground station (demo position)' : 'From the ground station',
            value: fromGs ? formatRangeBearing(fromGs) : MISSING,
            wide: true,
          },
          // Any other GPS channel this board has sent (new ones added to the
          // schema show up here without changes).
          ...channelRows(rocket, 'gps', GPS_SHOWN_ABOVE, store, config),
        ],
      });
    }

    // Every other group, straight from the channel registry. Each channel
    // this rocket has ever sent keeps its row, with its latest value.
    for (const group of GROUPS) {
      if (group === 'gps' || !rocket.sensorGroups.has(group)) continue;
      const rows = channelRows(rocket, group, [], store, config);
      if (!rows.length) continue;
      const age = store.ageOf(rocket.latestByGroup[group]?.t);
      const notes = [];
      if (group === 'radio') notes.push('Measured by the receiver on the ground, not by the board.');
      if (Number.isFinite(age) && age >= 2) notes.push(`Last reading ${formatAge(age)}.`);
      sections.push({ kind: group, title: GROUP_LABELS[group], note: notes.join(' '), rows });
    }

    // Only real sensors on the board count here. Radio signal is measured
    // by the receiver, and board status is not a sensor.
    const names = GROUPS.filter((g) => !NOT_SENSORS.includes(g) && rocket.sensorGroups.has(g))
      .map((g) => SENSOR_NAMES[g] ?? GROUP_LABELS[g]);
    sections.push({ kind: 'sensors', title: '', note: `Sensors on this board: ${names.length ? joinList(names) : 'none yet'}`, rows: [] });

    // Every unknown field ever seen, with its value from the latest sample
    // ("--" when the latest sample didn't carry it).
    const extraKeys = [...rocket.extraKeys].sort((a, b) => a.localeCompare(b));
    if (extraKeys.length) {
      // Say plainly which of these values the board did not send itself.
      const notes = ['Values the console has no place for yet, as they were read from the data file, except where noted.'];
      if (extraKeys.includes('sim_s')) notes.push('sim_s is the simulator\'s own clock, not something the board sent.');
      if (extraKeys.includes('missed')) notes.push('missed is the receiver\'s count of lost packets.');
      if (extraKeys.includes('rebooted')) notes.push('rebooted is the receiver\'s note that the board restarted.');
      if (extraKeys.includes('time_shift_s')) notes.push('time_shift_s isn\'t in the file. The console worked it out after the board restarted, to keep its times in order.');
      if (extraKeys.includes('fileRocketId')) notes.push('fileRocketId is the ID written in the file, before the library named this rocket.');
      sections.push({
        kind: 'extra',
        title: 'Other values from this board',
        note: notes.join(' '),
        rows: extraKeys.map((k) => {
          const val = rocket.extraLatest[k];
          return { label: k, value: val === null || val === undefined ? MISSING : String(val) };
        }),
      });
    }
    return sections;
  }

  // ------------------------------------------------------------------
  // Building and updating the elements
  // ------------------------------------------------------------------
  function build(model) {
    cells = [];
    const parts = model.map((section) => {
      if (section.kind === 'wait') return h('p', { class: 'fc-wait', dataset: { note: '' } }, section.note);
      if (section.kind === 'sensors') return h('p', { class: 'fc-sensors-line', dataset: { note: '' } });
      if (section.kind === 'top') {
        return h('div', { class: 'fc-stats-top' }, section.rows.map((row) => {
          const cell = valueCell('fc-big-value', 'fc-big-unit');
          cells.push(cell);
          return h('div', {}, h('div', { class: 'fc-big-label' }, row.label), cell.el);
        }));
      }
      const grid = h('dl', { class: 'fc-stat-grid' }, section.rows.map((row) => {
        const cell = valueCell('fc-stat-value', 'fc-big-unit');
        cells.push(cell);
        return h('div', { class: `fc-stat${row.wide ? ' fc-stat--wide' : ''}` },
          h('dt', { class: 'fc-stat-label' }, row.label), h('dd', {}, cell.el));
      }));
      if (section.kind === 'extra') {
        return h('details', { class: 'fc-extra' },
          h('summary', {}, section.title),
          h('p', { class: 'fc-stat-note' }, section.note),
          grid);
      }
      return h('div', { class: section.kind === 'flight' ? '' : 'fc-stat-section' },
        section.title ? h('h3', { class: 'fc-stat-section-title' }, section.title) : null,
        h('p', { class: 'fc-stat-note', dataset: { note: '' } }),
        grid);
    });
    setChildren(body, parts);
  }

  function valueCell(valueClass, smallClass) {
    const prefix = h('span', { 'aria-hidden': 'true' });
    const sr = h('span', { class: 'sr-only' });
    const text = h('span', {});
    const small = h('span', { class: smallClass });
    const el = h('div', { class: valueClass }, prefix, sr, text, small);
    return { el, prefix, sr, text, small };
  }

  function update(model) {
    let i = 0;
    const noteEls = body.querySelectorAll('[data-note]');
    let n = 0;
    for (const section of model) {
      if (section.kind === 'wait' || section.kind === 'sensors' || section.kind === 'top' || section.kind === 'extra') {
        if (section.kind === 'wait' || section.kind === 'sensors') {
          const el = noteEls[n++];
          if (el) setText(el, section.note);
        }
      } else {
        const el = noteEls[n++];
        if (el) { setText(el, section.note ?? ''); el.hidden = !section.note; }
      }
      for (const row of section.rows) {
        const cell = cells[i++];
        if (!cell) continue;
        setText(cell.prefix, row.prefix ?? '');
        setText(cell.sr, row.srPrefix ?? '');
        setText(cell.text, row.value);
        setText(cell.small, row.small ?? '');
        cell.el.classList.toggle('fc-amber', Boolean(row.amber));
        cell.text.className = row.cls ?? '';
      }
    }
  }

  const scheduler = createScheduler(render, { maxFps: config.STATS_MAX_FPS });
  const unsubscribe = store.subscribe((change) => {
    if (change.type === 'focus' || change.type === 'clear' || change.type === 'reset') scheduler.flush();
    else scheduler.schedule();
  });
  render();

  return {
    destroy() {
      unsubscribe();
      scheduler.cancel();
    },
  };
}

// Groups that aren't sensors on the board, and how the others read in a
// sentence. A new group added to the schema counts as a sensor by default.
const NOT_SENSORS = ['radio', 'status'];
const SENSOR_NAMES = { gps: 'GPS', baro: 'barometer', imu: 'IMU', power: 'battery voltage' };
// GPS channels the GPS section already shows in its own rows.
const GPS_SHOWN_ABOVE = ['fix', 'stale', 'sats', 'hdop', 'lat', 'lon', 'altMsl', 'speed', 'course'];

// One row per channel of a group that this rocket has ever sent a value
// for, with the latest value. Channels it never sent get no row. A channel
// that stopped while the rest of its group kept coming says how old its
// value is, so it never looks current.
function channelRows(rocket, group, skip, store, config) {
  const latest = rocket.latestByChannel[group] ?? {};
  const groupT = rocket.latestByGroup[group]?.t;
  return channelsInGroup(group)
    .filter((c) => !skip.includes(c.key) && latest[c.key])
    .map((c) => {
      const { t, value } = latest[c.key];
      const old = Number.isFinite(groupT) && groupT - t > config.LINK_STALE_S;
      return { label: c.label, value: channelValue(c, value), small: old ? `last reading ${formatAge(store.ageOf(t))}` : '' };
    });
}

function meters(m, decimals = 0) {
  return Number.isFinite(m) ? `${formatNumber(m, decimals)} m` : MISSING;
}

// Feet from the meters as shown (whole meters), so "0 m" never sits next
// to "-1 ft".
function feet(m) {
  return Number.isFinite(m) ? `${formatNumber(metersToFeet(Math.round(m)), 0)} ft` : '';
}

// Course as the board sent it. Below walking pace a GPS course points
// nowhere in particular, so it gets no compass name.
function courseText(fix, minSpeed) {
  if (!fix || !Number.isFinite(fix.course)) return MISSING;
  if (Number.isFinite(fix.speed) && fix.speed < minSpeed) return `${Math.round(fix.course)}° (not moving sideways)`;
  return formatBearing(fix.course);
}

function num(value, decimals) {
  return Number.isFinite(value) ? formatNumber(value, decimals) : MISSING;
}

function channelValue(channel, value) {
  if (channel.kind === 'text') return String(value);
  if (channel.kind === 'flag') return value === 1 ? 'Yes' : 'No';
  if (!Number.isFinite(value)) return MISSING;
  return `${formatNumber(value, channel.decimals ?? 1)}${channel.unit ? ` ${channel.unit}` : ''}`;
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
