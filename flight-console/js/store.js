// store.js
// All the live state of the console in one place: every rocket with its
// samples, detector, events, sensor groups, last packet and last good fix,
// plus the ground station, the focused rocket and the current time.
//
// Views subscribe to the store and redraw from it. They never talk to each
// other directly. The store does not know where samples come from: today
// the player feeds it a recorded flight, later a live serial or Bluetooth
// link can call addSample() directly.
//
// Used by: main.js, player.js and every view. No DOM.

import { GROUND_STATION, DETECTOR_DEFAULTS, LINK_STALE_S, ALTITUDE_STALE_S } from './config.js';
import { GROUPS, hasGoodPosition } from './schema.js';
import { createDetector, FLIGHT_EVENT_TYPES } from './detector.js';
import { createFleet } from './fleet.js';

export function createStore({ fleet = createFleet(), detectorConfig = DETECTOR_DEFAULTS, groundStation = GROUND_STATION } = {}) {
  const listeners = new Set();
  const rockets = new Map();       // rocketId -> rocket (below)
  const prescans = new Map();      // rocketId -> { liftoff: event, apogee: event, ... }
  let focusedRocketId = null;
  let events = [];                 // every rocket's events, in the order they were logged
  let now = null;                  // current data time in seconds
  let gs = makeConfigGroundStation();
  let totals = { samples: 0, gsPackets: 0, late: 0 };

  function makeConfigGroundStation() {
    return { lat: groundStation.lat, lon: groundStation.lon, altMsl: groundStation.altMsl ?? null, source: 'config', t: null };
  }

  // One rocket's state. Everything here except the profile and pre-scan is
  // cleared by reset().
  function makeRocket(id) {
    return {
      id,
      profile: fleet.get(id),
      detector: createDetector(detectorConfig),
      derived: null,             // detector.getState() after the latest sample
      samples: [],
      events: [],
      sensorGroups: new Set(),   // groups this rocket has ever sent
      lastPacketT: null,
      lastSample: null,
      latestByGroup: {},         // group -> { t, values } from the last sample that had it
      latestByChannel: {},       // group -> key -> { t, value }, last non-empty value of each channel
      extraKeys: new Set(),      // names of unknown fields ever seen
      extraLatest: {},           // unknown fields in the latest sample
      lastGoodFix: null,         // { t, lat, lon, altMsl, speed, course, sats, hdop }
      padPosition: null,         // last good position before liftoff
      padLookedUp: false,        // pad position searched for once after a short-log liftoff
      track: [],                 // good positions: { t, lat, lon, altMsl, gapBefore }
      altSeries: [],             // { t, alt } per altitude reading, alt null marks a gap
      altitudeMissing: false,    // the latest sample that should have had an altitude didn't
      gapPending: false,
      prescan: prescans.get(id) ?? null,
    };
  }

  function ensureRocket(id) {
    const key = String(id);
    let rocket = rockets.get(key);
    if (!rocket) {
      rocket = makeRocket(key);
      rockets.set(key, rocket);
      if (focusedRocketId === null) focusedRocketId = key;
    }
    return rocket;
  }

  // ---------------------------------------------------------------
  // Adding data
  // ---------------------------------------------------------------

  // Processes one sample without telling anyone. Returns its new events.
  function ingest(sample) {
    if (!sample) return [];
    if (sample.type === 'gs') {
      applyGroundStation(sample);
      return [];
    }
    if (sample.rocketId === null || sample.rocketId === undefined || !Number.isFinite(sample.t)) return [];
    const rocket = ensureRocket(sample.rocketId);
    // A live link can deliver a packet late. Older than this rocket's last
    // packet means it would roll the state backwards, so it is only counted.
    if (rocket.lastPacketT !== null && sample.t < rocket.lastPacketT) {
      totals.late += 1;
      return [];
    }
    totals.samples += 1;

    rocket.samples.push(sample);
    rocket.lastSample = sample;
    rocket.lastPacketT = sample.t;
    if (now === null || sample.t > now) now = sample.t;
    for (const g of GROUPS) {
      if (sample[g]) {
        rocket.sensorGroups.add(g);
        rocket.latestByGroup[g] = { t: sample.t, values: sample[g] };
        // Latest value of each channel, so a field sent at a slower rate
        // than the rest of its group (temperature once a second, say) keeps
        // showing between its own readings.
        const byKey = (rocket.latestByChannel[g] ??= {});
        for (const [key, value] of Object.entries(sample[g])) {
          if (value !== null && value !== undefined) byKey[key] = { t: sample.t, value };
        }
      }
    }
    // Unknown fields: every name ever seen, with the value from THIS sample
    // (a one-off like "rebooted" must not keep showing as current).
    for (const [key, value] of Object.entries(sample.extra ?? {})) {
      // Only fields this rocket gave a value for (a CSV row has every column).
      if (value !== null && value !== undefined) rocket.extraKeys.add(key);
    }
    rocket.extraLatest = { ...(sample.extra ?? {}) };

    const newEvents = rocket.detector.push(sample);
    const derived = rocket.detector.getState();
    rocket.derived = derived;

    // Positions: only good ones are ever drawn or measured.
    const good = hasGoodPosition(sample);
    if (good) {
      const g = sample.gps;
      rocket.lastGoodFix = { t: sample.t, lat: g.lat, lon: g.lon, altMsl: g.altMsl, speed: g.speed, course: g.course, sats: g.sats, hdop: g.hdop };
      rocket.track.push({ t: sample.t, lat: g.lat, lon: g.lon, altMsl: g.altMsl, gapBefore: rocket.gapPending && rocket.track.length > 0 });
      rocket.gapPending = false;
      // The launch pad is where the rocket sat still before liftoff. Data
      // that starts in flight never shows a pad, so none is drawn.
      if (derived.phase === 'pad') rocket.padPosition = { lat: g.lat, lon: g.lon, altMsl: g.altMsl, t: sample.t };
    } else if (sample.gps) {
      rocket.gapPending = true;
    }
    // Data that turned out to start in flight never had a pad.
    if (derived.startedInFlight) rocket.padPosition = null;
    // A short log can go from "waiting" straight to liftoff with a real pad
    // behind it: the pad is the last good position before liftoff.
    // (Looked up once, when liftoff first becomes known.)
    if (!rocket.padPosition && !rocket.padLookedUp && derived.liftoffT !== null && !derived.startedInFlight) {
      rocket.padLookedUp = true;
      const before = [...rocket.track].reverse().find((p) => p.t < derived.liftoffT);
      if (before) rocket.padPosition = { lat: before.lat, lon: before.lon, altMsl: before.altMsl, t: before.t };
    }
    // If liftoff was placed earlier than this sample (fix lost on the pad),
    // the pad position is the last good one from before that moment.
    if (derived.liftoffT !== null && rocket.padPosition && rocket.padPosition.t > derived.liftoffT) {
      const before = [...rocket.track].reverse().find((p) => p.t <= derived.liftoffT);
      if (before) rocket.padPosition = { lat: before.lat, lon: before.lon, altMsl: before.altMsl, t: before.t };
    }

    // Altitude series for the chart. A sample that should have carried an
    // altitude but didn't (GPS with no fix, a barometer row with no
    // altitude) leaves a gap instead of a made-up value. Samples that simply
    // carry other sensors (a status row, GPS rows of a barometer rocket)
    // are not gaps.
    const expected = derived.altSource === 'GPS' ? Boolean(sample.gps) : derived.altSource === 'barometer' ? Boolean(sample.baro) : false;
    if (derived.altitudeT === sample.t && Number.isFinite(derived.altitude)) {
      rocket.altSeries.push({ t: sample.t, alt: derived.altitude });
      rocket.altitudeMissing = false;
    } else if (expected) {
      // This sample should have carried an altitude and didn't.
      rocket.altitudeMissing = true;
      if (rocket.altSeries.length && rocket.altSeries[rocket.altSeries.length - 1].alt !== null) {
        rocket.altSeries.push({ t: sample.t, alt: null });
      }
    }

    for (const e of newEvents) {
      rocket.events.push(e);
      events.push(e);
    }
    return newEvents;
  }

  function applyGroundStation(sample) {
    totals.gsPackets += 1;
    const g = sample.gps;
    if (!g || g.fix !== 1 || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) return;
    gs = { lat: g.lat, lon: g.lon, altMsl: Number.isFinite(g.altMsl) ? g.altMsl : null, source: 'ground station GPS', t: sample.t ?? null };
  }

  // Adds one sample and tells every subscriber.
  function addSample(sample) {
    const newEvents = ingest(sample);
    notify({ type: 'samples', newEvents, quiet: false });
  }

  // Adds many samples (in time order) and tells subscribers once.
  // options.time moves the clock. options.quiet marks a replay after a seek,
  // so views skip flashes and animations.
  function addSamples(samples, { time, quiet = false } = {}) {
    const newEvents = [];
    for (const sample of samples) newEvents.push(...ingest(sample));
    if (Number.isFinite(time)) now = time;
    notify({ type: 'samples', newEvents, quiet });
  }

  // Moves the clock without new data, so ages ("4 s ago") keep counting.
  function setTime(t) {
    if (!Number.isFinite(t)) return;
    now = t;
    notify({ type: 'time', newEvents: [], quiet: true });
  }

  // ---------------------------------------------------------------
  // Clearing
  // ---------------------------------------------------------------

  // Clears all flight data but keeps the registered rockets (with their
  // profiles, pre-scan and focus), so a seek can re-feed the same flight.
  function reset() {
    for (const id of [...rockets.keys()]) rockets.set(id, makeRocket(id));
    events = [];
    now = null;
    gs = makeConfigGroundStation();
    totals = { samples: 0, gsPackets: 0, late: 0 };
    notify({ type: 'reset', newEvents: [], quiet: true });
  }

  // Forgets everything, including which rockets exist. Used when switching
  // flights so nothing from the previous flight can linger.
  function clearAll() {
    rockets.clear();
    prescans.clear();
    fleet.reset();
    focusedRocketId = null;
    events = [];
    now = null;
    gs = makeConfigGroundStation();
    totals = { samples: 0, gsPackets: 0, late: 0 };
    notify({ type: 'clear', newEvents: [], quiet: true });
  }

  // ---------------------------------------------------------------
  // Rockets and focus
  // ---------------------------------------------------------------

  // Adds a rocket before any of its data arrives (from the manifest).
  function registerRocket({ id, name, board, color } = {}) {
    fleet.register({ id, name, board, color });
    const rocket = ensureRocket(id);
    rocket.profile = fleet.get(id);
    notify({ type: 'rockets', newEvents: [], quiet: true });
    return rocket;
  }

  // Stores the pre-scanned events for one rocket (used only by the jump
  // buttons). They survive reset().
  function setPrescan(id, prescanEvents) {
    const byType = {};
    for (const e of prescanEvents) {
      if (FLIGHT_EVENT_TYPES.includes(e.type) && !byType[e.type]) byType[e.type] = e;
    }
    prescans.set(String(id), byType);
    const rocket = rockets.get(String(id));
    if (rocket) rocket.prescan = byType;
    notify({ type: 'rockets', newEvents: [], quiet: true });
  }

  function focus(id) {
    const key = String(id);
    if (!rockets.has(key) || key === focusedRocketId) return;
    focusedRocketId = key;
    notify({ type: 'focus', newEvents: [], quiet: true });
  }

  // ---------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function notify(change) {
    for (const listener of [...listeners]) {
      try { listener(change); } catch (err) { console.error('Flight Console view error:', err); }
    }
  }

  const getRockets = () => [...rockets.values()];
  const getRocket = (id) => rockets.get(String(id)) ?? null;
  const getFocused = () => (focusedRocketId === null ? null : rockets.get(focusedRocketId) ?? null);

  // Seconds since a data time, measured on the store's clock.
  function ageOf(t) {
    if (!Number.isFinite(t) || !Number.isFinite(now)) return null;
    return Math.max(0, now - t);
  }

  // True when a rocket has been quiet longer than LINK_STALE_S: out of
  // radio contact, so nothing it last said can be shown as current.
  function isSilent(rocket) {
    const age = ageOf(rocket?.lastPacketT);
    return age !== null && age > LINK_STALE_S;
  }

  // True when the rocket still sends packets but its GPS rows stopped more
  // than LINK_STALE_S ago (boards that send each sensor in its own row).
  function gpsIsQuiet(rocket) {
    if (!rocket?.sensorGroups.has('gps')) return false;
    const age = ageOf(rocket.latestByGroup.gps?.t);
    return age !== null && age > LINK_STALE_S;
  }

  // True when the GPS fix is good right now: the last GPS data said so, it
  // is recent, and the rocket isn't silent.
  function hasFixNow(rocket) {
    return rocket?.derived?.fixGood === true && !isSilent(rocket) && !gpsIsQuiet(rocket);
  }

  // True when the altitude (and so the vertical speed) shown for a rocket
  // is old: its latest packet had no altitude, the altitude reading is older
  // than ALTITUDE_STALE_S, or the rocket has gone silent.
  function altitudeIsOld(rocket) {
    const d = rocket?.derived;
    if (!d || !Number.isFinite(d.altitudeT)) return false;
    const age = ageOf(d.altitudeT);
    return rocket.altitudeMissing || (age !== null && age > ALTITUDE_STALE_S) || isSilent(rocket);
  }

  // Flight time (seconds since that rocket's liftoff) of a data time.
  function flightTimeOf(rocket, t) {
    const liftoffT = rocket?.derived?.liftoffT;
    return Number.isFinite(liftoffT) && Number.isFinite(t) ? t - liftoffT : null;
  }

  return {
    addSample,
    addSamples,
    setTime,
    reset,
    clearAll,
    registerRocket,
    setPrescan,
    focus,
    subscribe,
    getRockets,
    getRocket,
    getFocused,
    getFocusedId: () => focusedRocketId,
    getEvents: () => events,
    getGroundStation: () => gs,
    getNow: () => now,
    getTotals: () => ({ ...totals }),
    ageOf,
    isSilent,
    gpsIsQuiet,
    hasFixNow,
    altitudeIsOld,
    flightTimeOf,
  };
}
