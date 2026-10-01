// stats-panel.js
// The readings panel for the focused rocket. On a wide screen it floats over
// the top right of the map. On a phone it sits under the map as a
// two-column grid (CSS only, the elements are the same).
//
// The part that is always open shows altitude above ground (large),
// vertical speed, ground speed and course, the GPS fix and satellites, and
// the last packet age, plus a coral note when the GPS has a problem.
// "More readings" opens the rest: position, distance from the ground
// station, ground level, and one section for each sensor group the rocket
// has actually sent, built from the channel registry in schema.js, so a
// board with a barometer or IMU gets those sections without any change
// here. On a wide screen that part scrolls inside the panel, so the panel
// never grows past the map.
//
// Values a board never sent are never shown, and missing values show "--",
// never 0. Old values never look live: an old altitude loses its gold and
// says how old it is, and an old vertical speed isn't shown at all.
// Used by: main.js. Reads the store, never other views.

import { h, setText, setChildren, createScheduler, rocketDot } from './dom.js';
import { uiIcon, iconNode } from './icons.js';
import { GROUPS, GROUP_LABELS, channelsInGroup } from '../schema.js';
import {
  formatNumber, formatAge, formatDuration, formatRangeBearing, rangeAndBearing,
  metersToFeet, compassName, MISSING,
} from '../geo.js';

export function createStatsPanel(root, ctx) {
  const { store, config } = ctx;

  // The frame stays put. Only the rows inside it are rebuilt when the set
  // of readings changes, so "More readings" stays open and keeps its scroll.
  const who = h('span', { class: 'fc-rd-who', hidden: true });
  const main = h('div', { class: 'fc-rd-main' });
  const alert = h('p', { class: 'fc-rd-alert', hidden: true });
  const moreBody = h('div', { class: 'fc-rd-more-body' });
  const more = h('details', { class: 'fc-rd-more', hidden: true },
    h('summary', { class: 'fc-rd-more-toggle' }, iconNode(uiIcon('chevron', 16)), h('span', {}, 'More readings')),
    moreBody);
  setChildren(root, h('section', { class: 'fc-readings fc-float', 'aria-labelledby': 'fc-stats-title' },
    h('div', { class: 'fc-rd-head' }, h('h2', { class: 'fc-panel-title', id: 'fc-stats-title' }, 'Readings'), who),
    main, alert, more));

  let shapeKey = null;
  let cells = [];     // value cells, in the same order as the rows in the model
  let noteEls = [];   // one note element per "More readings" section
  let waitEl = null;
  let whoKey = null;

  function render() {
    renderWho();
    const rocket = store.getFocused();
    const model = rocket ? describe(rocket) : { wait: 'No rocket to show yet.' };
    const key = shapeOf(rocket, model);
    if (key !== shapeKey) {
      shapeKey = key;
      build(model);
    }
    update(model);
  }

  // With two or more rockets, the panel says whose readings these are.
  function renderWho() {
    const rocket = store.getFocused();
    const many = store.getRockets().length >= 2;
    const name = rocket?.profile?.name ?? '';
    const key = many && rocket ? `${rocket.id}|${name}|${rocket.profile?.color}` : '';
    if (key === whoKey) return;
    whoKey = key;
    who.hidden = !key;
    if (key) setChildren(who, rocketDot(rocket.profile?.color), h('span', { class: 'fc-rd-who-name' }, name));
    else who.replaceChildren();
  }

  // ------------------------------------------------------------------
  // What to show. The model is { hero, rows, alert, more } (or { wait }).
  // A row is { label, value, unit, small, prefix, srPrefix, tone, wide }:
  //   unit      shown smaller after the value, and only when there is one
  //   small     a second line under the value
  //   prefix    the up or down arrow (hidden from screen readers, which
  //             read srPrefix, "rising" or "falling", instead)
  //   tone      'gold' (live rocket data), 'old' (last known) or 'warn'
  //   wide      the label sits above the value (long values)
  // Each "More readings" section is { kind, title, note, rows }.
  // ------------------------------------------------------------------
  function describe(rocket) {
    const d = rocket.derived;
    if (!d) return { wait: 'Waiting for the first reading from this rocket.' };

    // When the altitude is old (no fix right now, or the rocket went quiet),
    // the last value stays for recovery but loses its gold and says how old
    // it is. An old vertical speed isn't shown.
    const old = store.altitudeIsOld(rocket);
    const altAge = store.ageOf(d.altitudeT);
    const hasAgl = Number.isFinite(d.agl);
    const v = old ? null : d.vSpeed;
    const hasV = Number.isFinite(v);
    const level = hasV && Math.abs(v) < config.LEVEL_VSPEED_MPS;
    const silent = store.isSilent(rocket);
    const packetAge = store.ageOf(rocket.lastPacketT);
    const hasGps = rocket.sensorGroups.has('gps');
    const altFrom = d.altSource === 'barometer' ? 'Barometer' : d.altSource === 'GPS' ? 'GPS' : 'No altitude yet';

    const hero = {
      label: 'Altitude above ground',
      value: num(d.agl, 0),
      unit: 'm',
      small: old && hasAgl ? `Last known, ${formatAge(altAge)}` : feet(d.agl),
      tone: !hasAgl ? null : old ? 'old' : 'gold',
    };
    const rows = [{
      label: 'Vertical speed',
      value: hasV ? formatNumber(Math.abs(v), 1) : MISSING,
      unit: 'm/s',
      small: !hasV && old && Number.isFinite(altAge) ? `No new altitude for ${formatDuration(altAge)}` : '',
      prefix: !hasV || level ? '' : v > 0 ? '▲ ' : '▼ ',
      srPrefix: !hasV || level ? '' : v > 0 ? 'rising ' : 'falling ',
      tone: hasV ? 'gold' : null,
    }];
    const more = [];
    let alertText = '';

    if (hasGps) {
      const gps = rocket.latestByGroup.gps?.values ?? {};
      const sent = rocket.latestByChannel.gps ?? {};
      const fix = rocket.lastGoodFix;
      const gpsQuiet = store.gpsIsQuiet(rocket);
      const fixNow = store.hasFixNow(rocket);
      const gs = store.getGroundStation();
      const fromGs = fix ? rangeAndBearing(gs, fix) : null;
      const fixAge = fix ? store.ageOf(fix.t) : null;
      const fromLastFix = fix ? ` Position values are from the last good fix, ${formatAge(fixAge)}.` : '';
      if (silent) alertText = `No packets for ${formatDuration(packetAge)}.${fromLastFix}`;
      else if (gpsQuiet) alertText = `No GPS data for ${formatDuration(store.ageOf(rocket.latestByGroup.gps.t))}, though other packets still arrive.${fromLastFix}`;
      else if (!fix) alertText = 'No GPS fix yet, so there is no position to show.';
      else if (!fixNow) alertText = `No GPS fix right now.${fromLastFix}`;

      // Ground speed and course only count while the fix is good right now.
      // Otherwise the row says why it shows "--".
      if (sent.speed || sent.course) {
        let why = '';
        if (silent) why = 'No recent packets';
        else if (gpsQuiet) why = 'No recent GPS data';
        else if (!fix) why = 'No GPS fix yet';
        else if (!fixNow) why = 'No GPS fix right now';
        rows.push({
          label: 'Ground speed',
          value: fixNow && Number.isFinite(fix?.speed) ? formatNumber(fix.speed, 1) : MISSING,
          unit: 'm/s',
          small: fixNow ? courseText(fix, config.COURSE_MIN_SPEED_MPS) : why,
        });
      }

      const sats = Number.isFinite(gps.sats) ? `, ${formatNumber(gps.sats, 0)} ${gps.sats === 1 ? 'satellite' : 'satellites'}` : '';
      let fixText = fixNow ? `Fix${sats}` : `No fix${sats}`;
      if (silent || gpsQuiet) fixText = 'No recent data';
      rows.push({ label: 'GPS', value: fixText, tone: fixNow ? null : 'warn' });

      more.push({
        kind: 'gps',
        title: GROUP_LABELS.gps,
        note: '',
        rows: [
          { label: 'Altitude above sea level', value: fix ? meters(fix.altMsl, 1) : MISSING },
          { label: 'HDOP', value: num(gps.hdop, 2) },
          { label: 'Latitude', value: fix ? `${formatNumber(fix.lat, 5)}°` : MISSING },
          { label: 'Longitude', value: fix ? `${formatNumber(fix.lon, 5)}°` : MISSING },
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
    } else {
      // No GPS rows for a rocket that never sent GPS. Its altitude source
      // takes their place, and a quiet rocket still gets its note.
      rows.push({ label: 'Altitude from', value: altFrom });
      if (silent) alertText = `No packets for ${formatDuration(packetAge)}.`;
    }
    rows.push({ label: 'Last packet', value: formatAge(packetAge), tone: silent ? 'warn' : null });

    // Until a pad is confirmed (or the data turns out to start in flight),
    // there is no ground level to show, only readings being checked.
    let groundText = MISSING;
    if (d.phase === 'waiting') groundText = 'Not known yet';
    else if (Number.isFinite(d.groundRef)) {
      groundText = `${formatNumber(d.groundRef, 0)} m above sea level${d.groundEstimated ? ', estimated' : d.groundFrozen ? '' : ', averaging pad readings'}`;
    }
    more.push({
      kind: 'alt',
      title: 'Altitude',
      note: '',
      rows: [
        { label: 'Highest so far', value: meters(d.maxAgl), small: feet(d.maxAgl) },
        hasGps ? { label: 'Altitude from', value: altFrom } : null,
        // Altitude and vertical speed come from this reading, so its age says how current they are.
        { label: 'Last altitude reading', value: Number.isFinite(d.altitudeT) ? formatAge(altAge) : MISSING },
        { label: 'Ground level', value: groundText, wide: true },
      ].filter(Boolean),
    });

    // Every other group, straight from the channel registry. Each channel
    // this rocket has ever sent keeps its row, with its latest value.
    for (const group of GROUPS) {
      if (group === 'gps' || !rocket.sensorGroups.has(group)) continue;
      const groupRows = channelRows(rocket, group, [], store, config);
      if (!groupRows.length) continue;
      const age = store.ageOf(rocket.latestByGroup[group]?.t);
      const notes = [];
      if (group === 'radio') notes.push('Measured by the receiver on the ground, not by the board.');
      if (Number.isFinite(age) && age >= 2) notes.push(`Last reading ${formatAge(age)}.`);
      more.push({ kind: group, title: GROUP_LABELS[group], note: notes.join(' '), rows: groupRows });
    }

    // Only real sensors on the board count here. Radio signal is measured
    // by the receiver, and board status is not a sensor.
    const names = GROUPS.filter((g) => !NOT_SENSORS.includes(g) && rocket.sensorGroups.has(g))
      .map((g) => SENSOR_NAMES[g] ?? GROUP_LABELS[g]);
    more.push({ kind: 'sensors', title: '', note: `Sensors on this board: ${names.length ? joinList(names) : 'none yet'}`, rows: [] });

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
      more.push({
        kind: 'extra',
        title: 'Other values from this board',
        note: notes.join(' '),
        rows: extraKeys.map((k) => {
          const val = rocket.extraLatest[k];
          return { label: k, value: val === null || val === undefined ? MISSING : String(val) };
        }),
      });
    }
    return { hero, rows, alert: alertText, more };
  }

  // The rows' labels, in order. The elements are rebuilt only when this changes.
  function shapeOf(rocket, model) {
    if (model.wait) return `wait#${rocket?.id ?? ''}`;
    const labels = (rows) => rows.map((r) => `${r.label}${r.wide ? '*' : ''}`).join(',');
    return `${rocket.id}#${labels(model.rows)}#${model.more.map((s) => `${s.kind}:${s.title}:${labels(s.rows)}`).join('|')}`;
  }

  // ------------------------------------------------------------------
  // Building and updating the elements
  // ------------------------------------------------------------------
  function build(model) {
    cells = [];
    noteEls = [];
    waitEl = null;
    if (model.wait) {
      waitEl = h('p', { class: 'fc-wait' });
      setChildren(main, waitEl);
      moreBody.replaceChildren();
      more.hidden = true;
      return;
    }
    const hero = valueCell('fc-rd-big');
    cells.push(hero);
    setChildren(main,
      h('div', { class: 'fc-rd-hero' }, h('div', { class: 'fc-rd-label' }, model.hero.label), hero.value, hero.small),
      rowList(model.rows, 'fc-rd-list'));
    setChildren(moreBody, model.more.map((section) => {
      if (section.kind === 'sensors') {
        const line = h('p', { class: 'fc-rd-sensors' });
        noteEls.push(line);
        return line;
      }
      const note = h('p', { class: 'fc-rd-note', hidden: true });
      noteEls.push(note);
      return h('section', { class: 'fc-rd-sec' },
        h('h3', { class: 'fc-rd-sec-title' }, section.title),
        note,
        rowList(section.rows, 'fc-rd-grid'));
    }));
    more.hidden = false;
  }

  // A <dl> with one label and value per row. Adds each value cell to cells.
  function rowList(rows, className) {
    return h('dl', { class: className }, rows.map((row) => {
      const cell = valueCell('fc-rd-value');
      cells.push(cell);
      return h('div', { class: `fc-rd-row${row.wide ? ' fc-rd-row--wide' : ''}` },
        h('dt', { class: 'fc-rd-label' }, row.label),
        h('dd', {}, cell.value, cell.small));
    }));
  }

  function valueCell(className) {
    const prefix = h('span', { class: 'fc-rd-arrow', 'aria-hidden': 'true' });
    const sr = h('span', { class: 'sr-only' });
    const text = h('span', {});
    const unit = h('span', { class: 'fc-rd-unit' });
    const value = h('div', { class: className }, prefix, sr, text, unit);
    const small = h('div', { class: 'fc-rd-small' });
    return { base: className, value, prefix, sr, text, unit, small };
  }

  function update(model) {
    if (model.wait) {
      if (waitEl) setText(waitEl, model.wait);
      alert.hidden = true;
      return;
    }
    const rows = [model.hero, ...model.rows, ...model.more.flatMap((s) => s.rows)];
    rows.forEach((row, i) => {
      const cell = cells[i];
      if (!cell) return;
      setText(cell.prefix, row.prefix ?? '');
      setText(cell.sr, row.srPrefix ?? '');
      setText(cell.text, row.value);
      // A unit only goes with a real value, never with "--".
      setText(cell.unit, row.unit && row.value !== MISSING ? ` ${row.unit}` : '');
      setText(cell.small, row.small ?? '');
      const className = row.tone ? `${cell.base} is-${row.tone}` : cell.base;
      if (cell.value.className !== className) cell.value.className = className;
    });
    setText(alert, model.alert);
    alert.hidden = !model.alert;
    model.more.forEach((section, i) => {
      const el = noteEls[i];
      if (!el) return;
      setText(el, section.note ?? '');
      el.hidden = !section.note;
    });
  }

  const scheduler = createScheduler(render, { maxFps: config.STATS_MAX_FPS });
  const unsubscribe = store.subscribe((change) => {
    if (change.type === 'focus' || change.type === 'clear' || change.type === 'reset' || change.type === 'rockets') scheduler.flush();
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
// GPS channels the panel already shows in its own rows.
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
      return { label: c.label, value: channelValue(c, value), small: old ? `Last reading ${formatAge(store.ageOf(t))}` : '' };
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

// Course as the board sent it, like "Course 58° NE". Below walking pace a
// GPS course points nowhere in particular, so it isn't shown as a direction.
function courseText(fix, minSpeed) {
  if (!fix || !Number.isFinite(fix.course)) return '';
  if (Number.isFinite(fix.speed) && fix.speed < minSpeed) return 'Not moving sideways';
  const deg = Math.round(fix.course) % 360;
  return `Course ${deg}° ${compassName(deg)}`;
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
