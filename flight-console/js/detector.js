// detector.js
// Works out what one rocket is doing from its own readings, one sample at a
// time: ground level, altitude above ground (AGL), smoothed vertical speed,
// and the flight events (liftoff, apogee, drogue, main, landed, GPS fix lost
// and regained, and anything the board reports itself). Once the landing is
// detected it also works out where the rocket is: the average of the GPS
// fixes in the landing window (state.landing).
//
// It only ever sees normalized samples. It never sees the simulator's ground
// truth, so a simulated flight is judged exactly like a real one.
//
// Every time threshold is in SECONDS. "For X seconds" means the condition
// held on every reading in a streak, and the streak's last reading time
// minus its first reading time is at least X. That works the same at 1 or
// 20 readings per second.
//
// The rules (every number is in config.js, with the reasons):
//   Pad        still (vertical speed under PAD_STILL_MAX_MPS) for
//              PAD_CONFIRM_S. Ground level is the average of the last
//              PAD_AVG_S of pad readings, frozen at liftoff.
//   Liftoff    a fast climb of several readings in a row well above the
//              pad, or the GPS fix coming back far above the pad after a
//              break. A board on a desk that wanders tens of meters, with
//              single jumps, can't do either. A wandering board stays on
//              its pad, so the live store keeps liftoff switched on too.
//   Apogee     falling for APOGEE_CONFIRM_S after climbing APOGEE_ARM_AGL_M.
//   Drogue     falling faster than DROGUE_MIN_DESCENT_MPS after apogee.
//   Main       a slower descent, started high enough above the ground.
//   Landed     after apogee (or well below the highest point): altitude
//              steady with no downward trend over LANDED_WINDOW_S, every
//              fix inside a LANDED_RADIUS_M circle, and the receiver's own
//              ground speed slow when it sends one.
//
// Used by: store.js (one detector per rocket), main.js (a separate detector
// pre-scans each flight for the jump buttons), and both Node tools. No DOM.

import { DETECTOR_DEFAULTS } from './config.js?v=2';
import { hasGoodPosition } from './schema.js?v=2';
import { distanceM, formatRounded10, formatFlightSeconds, formatDuration, formatNumber } from './geo.js?v=2';

// Flight events in the order they happen.
export const FLIGHT_EVENT_TYPES = Object.freeze(['liftoff', 'apogee', 'drogue', 'main', 'landed']);

// Short names for buttons, chart markers and lists.
export const EVENT_LABELS = Object.freeze({
  liftoff: 'Liftoff',
  apogee: 'Apogee',
  drogue: 'Drogue',
  main: 'Main',
  landed: 'Landed',
  gps_fix_lost: 'GPS fix lost',
  gps_fix_regained: 'GPS fix back',
  reported: 'Board event',
});

// What each phase is called on the page.
export const PHASE_LABELS = Object.freeze({
  waiting: 'Waiting for more data',
  pad: 'On pad',
  ascent: 'Ascending',
  descent: 'Descending',
  drogue: 'Descending (drogue, inferred)',
  main: 'Descending (main, inferred)',
  landed: 'Landed',
});

// Small tolerance for comparing reading times, so 2.9999999 s counts as 3 s.
const EPS = 1e-6;

const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

// The middle value of a list of numbers.
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The slope (m/s) of the best straight line through { t, alt } readings
// (least squares). 0 when there are fewer than two times.
function slopeOf(readings) {
  const n = readings.length;
  if (n < 2) return 0;
  const tm = mean(readings.map((r) => r.t));
  const am = mean(readings.map((r) => r.alt));
  let num = 0;
  let den = 0;
  for (const r of readings) {
    num += (r.t - tm) * (r.alt - am);
    den += (r.t - tm) ** 2;
  }
  return den > 0 ? num / den : 0;
}

export function createDetector(overrides = {}) {
  const cfg = { ...DETECTOR_DEFAULTS, ...overrides };
  let s = freshState();

  function freshState() {
    return {
      rocketId: null,
      lastT: null,
      // Which altitude drives detection: 'barometer' or 'GPS'.
      altSource: null,
      hasBaro: false,
      hasGps: false,
      // Before liftoff: have we seen the rocket sitting still (a real pad)?
      firstAltT: null,
      padConfirmed: false,
      startedInFlight: false,
      stillSinceT: null,   // start of the current still streak (before a pad is confirmed)
      preMax: null,        // { t, alt } highest reading before liftoff, kept in full
      altSmooth: null,     // average altitude over the vertical speed window
      prevReading: null,   // { t, alt } the altitude reading before this one
      // Liftoff evidence being collected (see config.js):
      //   climb  { fromT, fromAlt, readings: [{ t, alt }] } readings in a row
      //          that each climbed at least LIFTOFF_MIN_STEP_MPS. fromT and
      //          fromAlt are the reading just before the run.
      //   jump   { t, alt, fromT } the first reading after a break, far
      //          above the pad, waiting for the next reading to agree
      //   fall   { t, alt } start of a steady fall (data that starts in flight)
      climb: null,
      jump: null,
      fall: null,
      // Altitude readings on the pad, for the ground reference.
      padReadings: [],
      groundRef: null,
      groundEstimated: false,
      // Latest altitude reading (chosen source) and what it means.
      altitude: null,
      altitudeT: null,
      agl: null,
      // Readings covering the last VSPEED_AVG_S, for vertical speed.
      altHistory: [],
      vSpeed: null,
      maxAgl: null,
      maxAglT: null,
      armed: false,
      // Liftoff. liftoffT is when T+0 is, liftoffDetectedT when we knew.
      liftoffT: null,
      liftoffDetectedT: null,
      liftoffEstimated: false,
      // The event objects once they happen.
      liftoff: null,
      apogee: null,
      drogue: null,
      main: null,
      landed: null,
      // Where the rocket came down: { lat, lon, fixCount, fromT, toT }.
      landing: null,
      // Streaks in progress: { startT, startAgl }.
      apogeeStreak: null,
      drogueStreak: null,
      mainStreak: null,
      landedBuf: [],   // altitude readings after liftoff, for the landed window
      fixBuf: [],      // good GPS fixes after liftoff { t, lat, lon }, for the landed window
      speedBuf: [],    // GPS ground speeds from good fixes, for the landed window
      // GPS fix tracking.
      fixGood: null,
      lastGoodFixT: null,
      fixLostT: null,
      padFixLostT: null,   // the latest time the fix dropped while still on the pad
    };
  }

  function flightTimeOf(t) {
    return s.liftoffT === null || !Number.isFinite(t) ? null : t - s.liftoffT;
  }

  function makeEvent(type, fields) {
    return Object.freeze({
      rocketId: s.rocketId,
      type,
      label: EVENT_LABELS[type] ?? type,
      t: fields.t,
      flightT: flightTimeOf(fields.t),
      aglM: Number.isFinite(fields.aglM) ? fields.aglM : null,
      confirmedT: Number.isFinite(fields.confirmedT) ? fields.confirmedT : fields.t,
      basis: fields.basis,
      message: fields.message,
    });
  }

  // "T+25 s" for a data time, using this rocket's liftoff.
  const at = (t) => formatFlightSeconds(flightTimeOf(t));

  // ---------------------------------------------------------------
  // GPS fix
  // ---------------------------------------------------------------
  function trackFix(sample, good, t, events) {
    if (!sample.gps) return;
    s.hasGps = true;
    if (good) {
      if (s.fixGood === false && s.lastGoodFixT !== null) {
        const gap = t - s.lastGoodFixT;
        events.push(makeEvent('gps_fix_regained', {
          t, basis: 'reported',
          message: `GPS fix back after ${formatDuration(gap)} without a good position (reported by the board)`,
        }));
      }
      s.fixGood = true;
      s.lastGoodFixT = t;
      const g = sample.gps;
      if (s.liftoffT !== null) s.fixBuf.push({ t, lat: g.lat, lon: g.lon });
      // The receiver's own ground speed (u-blox works it out from the
      // Doppler shift of the satellite signals, not from position changes).
      if (Number.isFinite(g.speed)) s.speedBuf.push({ t, v: g.speed });
    } else {
      if (s.fixGood === true) {
        s.fixLostT = t;
        if (s.liftoffT === null) s.padFixLostT = t;
        events.push(makeEvent('gps_fix_lost', {
          t, basis: 'reported',
          message: 'GPS fix lost, showing the last good position (reported by the board)',
        }));
      }
      s.fixGood = false;
    }
  }

  // ---------------------------------------------------------------
  // Altitude source
  // ---------------------------------------------------------------
  // Barometer if this rocket has ever sent one, otherwise GPS altitude from
  // good positions only. If a barometer first appears while the rocket is
  // still on the pad, detection switches to it and starts over. After
  // liftoff the source never changes mid-flight.
  function chooseAltitude(sample, good) {
    const baroAlt = Number.isFinite(sample.baro?.altM) ? sample.baro.altM : null;
    if (baroAlt !== null) s.hasBaro = true;
    if (s.altSource === null) {
      if (baroAlt !== null) s.altSource = 'barometer';
      else if (good) s.altSource = 'GPS';
    } else if (s.altSource === 'GPS' && baroAlt !== null && s.liftoffT === null) {
      s.altSource = 'barometer';
      s.padReadings = [];
      s.altHistory = [];
      s.vSpeed = null;
      s.firstAltT = null;
      s.padConfirmed = false;
      s.stillSinceT = null;
      s.preMax = null;
      s.prevReading = null;
      s.climb = null;
      s.jump = null;
      s.fall = null;
    }
    if (s.altSource === 'barometer') return baroAlt;
    if (s.altSource === 'GPS' && good) return sample.gps.altMsl;
    return null;
  }

  // ---------------------------------------------------------------
  // Vertical speed: the change between readings, averaged over the last
  // VSPEED_AVG_S. The average is weighted by time, which is the same as
  // (altitude now - altitude VSPEED_AVG_S ago) / time between them. That
  // way one short, noisy interval (50 ms at 20 Hz) can't swing it. Until the
  // readings cover the whole window there is no vertical speed at all.
  // ---------------------------------------------------------------
  function updateVerticalSpeed(t, alt) {
    const h = s.altHistory;
    if (h.length && t <= h[h.length - 1].t + EPS) return; // same moment again: nothing new
    h.push({ t, alt });
    // Keep one reading at or before the start of the window.
    while (h.length > 1 && h[1].t <= t - cfg.VSPEED_AVG_S + EPS) h.shift();
    s.vSpeed = h.length > 1 && h[0].t <= t - cfg.VSPEED_AVG_S + EPS
      ? (alt - h[0].alt) / (t - h[0].t)
      : null;
    // The same window's average altitude, for decisions that compare
    // altitudes before liftoff, so one noisy reading can't swing them.
    s.altSmooth = s.vSpeed === null ? null : mean(h.map((r) => r.alt));
  }

  // ---------------------------------------------------------------
  // Liftoff evidence, collected on every reading before liftoff
  // ---------------------------------------------------------------

  // The climb run: readings in a row that each climbed at least
  // LIFTOFF_MIN_STEP_MPS from the one before. Jitter and slow wander break
  // it at once.
  function updateClimb(t, alt) {
    const prev = s.prevReading;
    if (!prev || t <= prev.t + EPS) return;
    const stepRate = (alt - prev.alt) / (t - prev.t);
    if (stepRate >= cfg.LIFTOFF_MIN_STEP_MPS) {
      if (!s.climb) s.climb = { fromT: prev.t, fromAlt: prev.alt, readings: [] };
      s.climb.readings.push({ t, alt });
    } else {
      s.climb = null;
    }
  }

  // Is the climb run a liftoff? ground is the pad's altitude, or null when
  // there is no pad (then the run just has to rise more than LIFTOFF_AGL_M).
  // Returns { startT, fromT, rate } or null.
  function climbLiftoff(ground) {
    const c = s.climb;
    if (!c) return null;
    // The run only rises, so the readings above the pad are its last ones.
    const above = ground === null ? c.readings : c.readings.filter((r) => r.alt - ground > cfg.LIFTOFF_AGL_M);
    if (above.length < cfg.LIFTOFF_CONFIRM_READINGS) return null;
    const last = above[above.length - 1];
    if (last.t - above[0].t < cfg.LIFTOFF_CONFIRM_S - EPS) return null;
    const rate = (last.alt - c.fromAlt) / (last.t - c.fromT);
    if (!(rate > cfg.LIFTOFF_VSPEED_MPS)) return null;
    if (ground === null && last.alt - c.fromAlt <= cfg.LIFTOFF_AGL_M) return null;
    return { startT: c.readings[0].t, fromT: c.fromT, rate, rise: last.alt - c.fromAlt };
  }

  // The comeback: the first reading after a break (the fix dropped, or no
  // reading for LIFTOFF_BREAK_S) far above the pad, climbing fast since the
  // last pad reading. It only counts once the next reading agrees.
  // Returns { startT, fromT, aglM } when confirmed, or null.
  function jumpLiftoff(t, alt, ground) {
    const high = alt - ground > cfg.LIFTOFF_FIX_BACK_AGL_M;
    if (s.jump) {
      const j = s.jump;
      s.jump = null;
      if (high) return { startT: j.t, fromT: j.fromT, aglM: j.alt - ground };
      return null;
    }
    const prev = s.prevReading;
    if (!prev || !high || t <= prev.t + EPS) return null;
    const fixDropped = s.padFixLostT !== null && s.padFixLostT > prev.t + EPS;
    const broke = fixDropped || t - prev.t > cfg.LIFTOFF_BREAK_S + EPS;
    if (broke && (alt - prev.alt) / (t - prev.t) > cfg.LIFTOFF_VSPEED_MPS) s.jump = { t, alt, fromT: prev.t };
    return null;
  }

  // The steady fall that means data started in flight, coming down.
  function updateFall(t) {
    if (s.vSpeed !== null && s.vSpeed < -cfg.START_FALL_MIN_MPS) {
      if (!s.fall) s.fall = { t, alt: s.altSmooth };
    } else {
      s.fall = null;
    }
  }

  function fallConfirmed(t) {
    return Boolean(s.fall) && t - s.fall.t >= cfg.START_FALL_CONFIRM_S - EPS &&
      s.fall.alt - s.altSmooth > cfg.LIFTOFF_AGL_M;
  }

  // ---------------------------------------------------------------
  // Pad and liftoff
  // ---------------------------------------------------------------
  function padGround() {
    return s.padReadings.length ? mean(s.padReadings.map((r) => r.alt)) : null;
  }

  function addPadReading(t, alt) {
    while (s.padReadings.length && s.padReadings[0].t < t - cfg.PAD_AVG_S - EPS) s.padReadings.shift();
    s.padReadings.push({ t, alt });
  }

  // The readings at the start that stay within PAD_SPREAD_M of the first one.
  function leadingStillRun() {
    const out = [];
    const first = s.padReadings[0];
    for (const r of s.padReadings) {
      if (Math.abs(r.alt - first.alt) > cfg.PAD_SPREAD_M) break;
      out.push(r);
    }
    return out;
  }

  function checkLiftoff(t, alt, events) {
    if (!s.padConfirmed) decideStart(t, alt, events);
    else checkPad(t, alt, events);
  }

  // Before anything is decided: is the rocket sitting on a pad, or did the
  // data begin in flight? Every choice here needs a streak, so one noisy
  // reading (a GPS first fix 16 m off, say) can't decide it.
  function decideStart(t, alt, events) {
    addPadReading(t, alt);
    s.agl = null;

    // A short log that starts just before launch: the first readings sat
    // still for at least PAD_RUN_MIN_S, then a liftoff climb well above
    // them. That's a real pad and a real liftoff, not data starting in
    // flight.
    // (Only the still readings up to the start of the climb count. At
    // 20 Hz the first climbing readings can still sit within PAD_SPREAD_M.)
    const run = s.climb ? leadingStillRun().filter((r) => r.t <= s.climb.fromT + EPS) : [];
    const runSpan = run.length ? run[run.length - 1].t - run[0].t : 0;
    if (s.climb && run.length >= 2 && runSpan >= cfg.PAD_RUN_MIN_S - EPS) {
      const ground = mean(run.map((r) => r.alt));
      const climb = climbLiftoff(ground);
      if (climb) {
        s.padConfirmed = true;
        s.padReadings = run;
        liftoffFromPad(t, alt, events, climb, 'climb');
        return;
      }
    }
    // A liftoff climb with no pad under it: the data began in flight,
    // going up. With no pad to measure from, the climb has to rise more
    // than LIFTOFF_FIX_BACK_AGL_M, so a GPS settling after power-up (its
    // first fixes can sit far too low) can't pass for it.
    const noPadClimb = climbLiftoff(null);
    if (noPadClimb && noPadClimb.rise > cfg.LIFTOFF_FIX_BACK_AGL_M) {
      startInFlight(t, alt, events, true);
      return;
    }
    // A steady fall: the data began in flight, coming down.
    if (fallConfirmed(t)) {
      startInFlight(t, alt, events, false);
      return;
    }

    // Still for PAD_CONFIRM_S: the rocket is on a pad.
    const v = s.vSpeed;
    if (v === null) return;
    if (Math.abs(v) <= cfg.PAD_STILL_MAX_MPS) {
      if (s.stillSinceT === null) s.stillSinceT = t;
      if (t - s.stillSinceT >= cfg.PAD_CONFIRM_S - EPS) {
        s.padConfirmed = true;
        s.agl = alt - padGround();
      }
      return;
    }
    s.stillSinceT = null;
  }

  // On a confirmed pad: watch for liftoff, and for the rocket falling
  // steadily far below the pad, which means it was never on one (data that
  // starts under a slow main parachute can look still at first).
  function checkPad(t, alt, events) {
    const ground = padGround();
    const agl = ground === null ? null : alt - ground;
    s.agl = agl;
    if (agl === null) {
      addPadReading(t, alt);
      return;
    }
    if (agl < -cfg.LIFTOFF_AGL_M) {
      s.jump = null;
      if (fallConfirmed(t)) {
        s.padConfirmed = false;
        startInFlight(t, alt, events, false);
        return;
      }
      // Far below the pad while still falling stays out of the pad average.
      // Once it stops, it joins, so a GPS that settled lower moves the pad.
      if (!s.fall) addPadReading(t, alt);
      return;
    }
    const climb = climbLiftoff(ground);
    if (climb) {
      liftoffFromPad(t, alt, events, climb, 'climb');
      return;
    }
    const jump = jumpLiftoff(t, alt, ground);
    if (jump) {
      liftoffFromPad(t, alt, events, jump, 'jump');
      return;
    }
    // A reading far above the pad that might be the start of a liftoff
    // stays out of the pad average. A lone jump joins it.
    if (agl > cfg.LIFTOFF_AGL_M && (s.climb || s.jump)) return;
    addPadReading(t, alt);
  }

  // Liftoff from a pad, confirmed at reading t. found is what climbLiftoff
  // or jumpLiftoff returned, how is 'climb' or 'jump'.
  function liftoffFromPad(t, alt, events, found, how) {
    // T+0 is the first reading of the climb. If the GPS fix dropped after
    // the last pad reading (a GPS-only board losing its fix in boost), the
    // drop is the best guess. After a plain break in the data, the last
    // pad reading is.
    let liftoffT = found.startT;
    let estimated = false;
    let estimateWords = '';
    if (s.padFixLostT !== null && s.padFixLostT > found.fromT + EPS && s.padFixLostT <= found.startT + EPS) {
      liftoffT = s.padFixLostT;
      estimated = true;
      estimateWords = 'T+0 is estimated from when the GPS fix dropped on the pad';
    } else if (how === 'jump') {
      liftoffT = found.fromT;
      estimated = true;
      estimateWords = 'T+0 is estimated as the last reading on the pad, since nothing came during the climb';
    }

    // Freeze the ground reference: pad readings in the PAD_AVG_S before
    // liftoff, or the latest pad readings if a gap left none in that window.
    let pad = s.padReadings.filter((r) => r.t < liftoffT - EPS && r.t >= liftoffT - cfg.PAD_AVG_S - EPS);
    if (!pad.length) pad = s.padReadings.filter((r) => r.t < liftoffT + EPS);
    if (!pad.length) pad = s.padReadings;
    if (pad.length) {
      s.groundRef = mean(pad.map((r) => r.alt));
      s.groundEstimated = false;
    } else {
      s.groundRef = cfg.GROUND_ELEV_FALLBACK_M;
      s.groundEstimated = true;
    }
    s.padReadings = [];
    s.climb = null;
    s.jump = null;
    s.fall = null;
    s.liftoffT = liftoffT;
    s.liftoffDetectedT = t;
    s.liftoffEstimated = estimated;
    s.agl = alt - s.groundRef;

    const reason = how === 'climb'
      ? `climbing at about ${formatNumber(found.rate, 0)} m/s, more than ${cfg.LIFTOFF_AGL_M} m above the pad`
      : `the GPS fix came back about ${formatRounded10(found.aglM)} m above the pad`;
    let message = `Liftoff detected, ${reason}`;
    if (estimated) message = `Liftoff detected, ${reason} (confirmed ${at(t)}). ${estimateWords}`;
    else if (t > liftoffT + EPS) message = `Liftoff detected, ${reason} (confirmed ${at(t)})`;
    const startReading = s.altHistory.find((r) => Math.abs(r.t - liftoffT) < EPS);
    s.liftoff = makeEvent('liftoff', {
      t: liftoffT, confirmedT: t, basis: 'detected', message,
      aglM: estimated || !startReading ? null : startReading.alt - s.groundRef,
    });
    events.push(s.liftoff);
  }

  // The data began with the rocket already flying, so liftoff (and maybe
  // apogee) happened before the first reading. Say so plainly: T+0 is the
  // first reading and the ground level is the configured estimate.
  function startInFlight(t, alt, events, climbing) {
    s.startedInFlight = true;
    s.groundRef = cfg.GROUND_ELEV_FALLBACK_M;
    s.groundEstimated = true;
    s.liftoffT = s.firstAltT;
    s.liftoffDetectedT = t;
    s.liftoffEstimated = true;
    s.climb = null;
    s.jump = null;
    s.fall = null;
    // The readings so far were taken in flight, not on a pad. The highest
    // one is tracked in full (padReadings only keeps the last PAD_AVG_S).
    s.padReadings = [];
    const top = s.preMax && s.preMax.alt >= alt ? s.preMax : { t, alt };
    s.maxAgl = top.alt - s.groundRef;
    s.maxAglT = top.t;
    s.agl = alt - s.groundRef;
    const speed = Number.isFinite(s.vSpeed) ? Math.abs(s.vSpeed) : null;
    s.liftoff = makeEvent('liftoff', {
      t: s.liftoffT, confirmedT: t, basis: 'detected',
      message: `Liftoff detected from data that starts in flight, already ${climbing ? 'climbing' : 'falling'}` +
        `${speed === null ? '' : ` at ${formatNumber(speed, 0)} m/s`}. The liftoff itself wasn't seen, so T+0 is the first reading ` +
        `and ground level is estimated at ${formatNumber(cfg.GROUND_ELEV_FALLBACK_M, 0)} m above sea level`,
    });
    events.push(s.liftoff);
    if (!climbing) {
      // Already falling: the peak came before the data did.
      s.armed = true;
      s.apogee = makeEvent('apogee', {
        t: s.maxAglT, confirmedT: t, basis: 'detected', aglM: s.maxAgl,
        message: `Apogee detected as already passed, because the data starts in flight and falling. ` +
          `The highest reading is ${formatNumber(s.maxAgl, 0)} m AGL at ${at(s.maxAglT)}`,
      });
      events.push(s.apogee);
    }
  }

  // ---------------------------------------------------------------
  // After liftoff
  // ---------------------------------------------------------------
  function checkApogee(t, events) {
    if (s.apogee || s.landed || !s.armed) return;
    if (s.vSpeed !== null && s.vSpeed < 0) {
      if (!s.apogeeStreak) s.apogeeStreak = { startT: t };
      if (t - s.apogeeStreak.startT >= cfg.APOGEE_CONFIRM_S - EPS) {
        s.apogee = makeEvent('apogee', {
          t: s.maxAglT, confirmedT: t, basis: 'detected', aglM: s.maxAgl,
          // The highest reading in whole meters, the same number as the
          // map's APOGEE label. Other heights here are estimates, so they
          // say "about" and are rounded to 10 m.
          message: `Apogee detected: ${formatNumber(s.maxAgl, 0)} m AGL at ${at(s.maxAglT)} (confirmed ${at(t)})`,
        });
        events.push(s.apogee);
      }
    } else {
      s.apogeeStreak = null;
    }
  }

  function checkDrogue(t, events) {
    if (s.drogue || s.landed) return;
    if (s.vSpeed !== null && s.vSpeed < -cfg.DROGUE_MIN_DESCENT_MPS) {
      if (!s.drogueStreak) s.drogueStreak = { startT: t, startAgl: s.agl };
    } else {
      s.drogueStreak = null;
    }
    // Only after apogee: the streak must start after the peak.
    const streak = s.drogueStreak;
    if (s.apogee && streak && streak.startT > s.apogee.t + EPS &&
        t - streak.startT >= cfg.DESCENT_CONFIRM_S - EPS) {
      s.drogue = makeEvent('drogue', {
        t: streak.startT, confirmedT: t, basis: 'inferred', aglM: streak.startAgl,
        message: `Drogue inferred: falling faster than ${cfg.DROGUE_MIN_DESCENT_MPS} m/s from about ` +
          `${formatRounded10(streak.startAgl)} m AGL at ${at(streak.startT)} (confirmed ${at(t)})`,
      });
      events.push(s.drogue);
    }
  }

  function checkMain(t, events) {
    if (!s.drogue || s.main || s.landed) return;
    const rate = s.vSpeed === null ? null : -s.vSpeed;
    // Slowing down near the ground is a landing, not a main parachute.
    const highEnough = Number.isFinite(s.agl) && s.agl > cfg.MAIN_MIN_AGL_M;
    if (rate !== null && rate < cfg.MAIN_MAX_DESCENT_MPS && rate > cfg.MAIN_MIN_DESCENT_MPS && (s.mainStreak || highEnough)) {
      if (!s.mainStreak) s.mainStreak = { startT: t, startAgl: s.agl };
    } else {
      s.mainStreak = null;
    }
    const streak = s.mainStreak;
    if (streak && t - streak.startT >= cfg.DESCENT_CONFIRM_S - EPS) {
      s.main = makeEvent('main', {
        t: streak.startT, confirmedT: t, basis: 'inferred', aglM: streak.startAgl,
        message: `Main inferred: descent slowed below ${cfg.MAIN_MAX_DESCENT_MPS} m/s at about ` +
          `${formatRounded10(streak.startAgl)} m AGL, ${at(streak.startT)} (confirmed ${at(t)})`,
      });
      events.push(s.main);
    }
  }

  // The average position of some { lat, lon } fixes.
  function centerOf(fixes) {
    return { lat: mean(fixes.map((f) => f.lat)), lon: mean(fixes.map((f) => f.lon)) };
  }

  // The altitude range of { t, alt } readings, with the single highest and
  // single lowest set aside when there are 10 or more. One pass, no
  // sorting, since it runs on every reading after apogee.
  function trimmedRange(readings) {
    let lo1 = Infinity; let lo2 = Infinity;     // lowest, second lowest
    let hi1 = -Infinity; let hi2 = -Infinity;   // highest, second highest
    for (const { alt } of readings) {
      if (alt < lo1) { lo2 = lo1; lo1 = alt; } else if (alt < lo2) lo2 = alt;
      if (alt > hi1) { hi2 = hi1; hi1 = alt; } else if (alt > hi2) hi2 = alt;
    }
    return readings.length >= 10 ? hi2 - lo2 : hi1 - lo1;
  }

  // { t, alt } readings without the single highest and single lowest, when
  // there are 10 or more.
  function withoutEnds(readings) {
    if (readings.length < 10) return readings;
    let lo = 0;
    let hi = 0;
    readings.forEach((r, i) => {
      if (r.alt < readings[lo].alt) lo = i;
      if (r.alt > readings[hi].alt) hi = i;
    });
    return readings.filter((_, i) => i !== lo && i !== hi);
  }

  // The fixes the landing uses: all of them, or with 10 or more, all but
  // the one farthest from their average.
  function keptFixes(fixes) {
    if (fixes.length < 10) return fixes;
    const c = centerOf(fixes);
    let worst = 0;
    fixes.forEach((f, i) => {
      if (distanceM(c.lat, c.lon, f.lat, f.lon) > distanceM(c.lat, c.lon, fixes[worst].lat, fixes[worst].lon)) worst = i;
    });
    return fixes.filter((_, i) => i !== worst);
  }

  // Landing is only possible after apogee, or once the rocket is well below
  // its highest point. A board on a desk never lifts off, so it never gets
  // here, however much it wanders.
  function landingArmed() {
    if (s.apogee) return true;
    return Number.isFinite(s.maxAgl) && Number.isFinite(s.agl) && s.maxAgl - s.agl >= cfg.LANDED_ARM_DROP_M;
  }

  function checkLanded(t, alt, events) {
    if (s.landed) return;
    const buf = s.landedBuf;
    buf.push({ t, alt });
    // Keep exactly one reading at or before the start of the window.
    while (buf.length > 1 && buf[1].t <= t - cfg.LANDED_WINDOW_S + EPS) buf.shift();
    const first = buf[0];
    while (s.fixBuf.length && s.fixBuf[0].t < first.t - EPS) s.fixBuf.shift();
    if (!landingArmed()) return;
    if (t - first.t < cfg.LANDED_WINDOW_S - EPS || buf.length < cfg.LANDED_MIN_READINGS) return;

    // Altitude steady: within the range, with one stray reading at each
    // end set aside when there are enough readings...
    if (trimmedRange(buf) > cfg.LANDED_ALT_RANGE_M) return;
    // ...and not sinking (the same stray readings left out).
    if (slopeOf(withoutEnds(buf)) < -cfg.LANDED_MAX_SINK_MPS) return;

    // Every fix in the window fits in the circle around their average. With
    // 10 or more fixes, the one farthest from the average is set aside
    // first (like the altitude above), so one wild fix can't hold the
    // landing off. It stays out of the recovery position too.
    const fixes = keptFixes(s.fixBuf.filter((f) => f.t >= first.t - EPS && f.t <= t + EPS));
    if (fixes.length) {
      const c = centerOf(fixes);
      if (fixes.some((f) => distanceM(c.lat, c.lon, f.lat, f.lon) > cfg.LANDED_RADIUS_M)) return;
    }
    // If the receiver sent its ground speed in the window, every one must be
    // slow. A rocket whose GPS sent no speed (a bench block, a barometer
    // rocket with the fix lost in the grass) is judged on the rest alone.
    const speeds = s.speedBuf.filter((p) => p.t >= first.t - EPS && p.t <= t + EPS);
    if (speeds.some((p) => p.v >= cfg.LANDED_MAX_SPEED_MPS)) return;

    // Touchdown: the first reading close to where the altitude settled.
    const settled = median(buf.map((r) => r.alt));
    const touch = buf.find((r) => r.alt <= settled + cfg.LANDED_TOUCHDOWN_M) ?? first;
    // Where it is: the average of the fixes from touchdown on, never just
    // the last one.
    let pos = fixes.filter((f) => f.t >= touch.t - EPS);
    if (!pos.length) pos = fixes;
    s.landing = Object.freeze({
      lat: pos.length ? mean(pos.map((f) => f.lat)) : null,
      lon: pos.length ? mean(pos.map((f) => f.lon)) : null,
      fixCount: pos.length,
      fromT: touch.t,
      toT: t,
    });

    const touchAgl = touch.alt - s.groundRef;
    s.landed = makeEvent('landed', {
      t: touch.t, confirmedT: t, basis: 'detected', aglM: touchAgl,
      message: `Landing detected: altitude steady at about ${formatRounded10(touchAgl)} m AGL from ` +
        `${at(touch.t)} (confirmed ${at(t)})` +
        (pos.length ? `. The position is the average of ${pos.length} GPS fix${pos.length === 1 ? '' : 'es'}` : ''),
    });
    events.push(s.landed);
  }

  // ---------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------

  // Feeds one sample. Returns an array of the NEW events it caused (often
  // empty). Samples must arrive in time order: an older one is ignored.
  function push(sample) {
    if (!sample || sample.type === 'gs' || !Number.isFinite(sample.t)) return [];
    const t = sample.t;
    if (s.lastT !== null && t < s.lastT - EPS) return [];
    const events = [];
    if (s.rocketId === null) s.rocketId = sample.rocketId;
    s.lastT = t;

    // Anything the board reports is logged at once, never merged with our
    // own inferred events, so the two can be compared.
    const reported = sample.status?.event;
    if (reported !== null && reported !== undefined && String(reported).trim() !== '') {
      events.push(makeEvent('reported', {
        t, basis: 'reported', message: `Board reported "${String(reported).trim()}"`,
      }));
    }

    const good = hasGoodPosition(sample);
    trackFix(sample, good, t, events);
    // Keep only the GPS speeds the landed window can still use.
    while (s.speedBuf.length && s.speedBuf[0].t < t - cfg.LANDED_WINDOW_S - 1) s.speedBuf.shift();

    const alt = chooseAltitude(sample, good);
    if (alt === null) return events;
    // The same moment twice (a duplicate packet) tells us nothing new.
    if (s.prevReading && t <= s.prevReading.t + EPS) return events;

    s.altitude = alt;
    s.altitudeT = t;
    if (s.firstAltT === null) s.firstAltT = t;
    if (s.liftoffT === null && (!s.preMax || alt > s.preMax.alt)) s.preMax = { t, alt };
    updateVerticalSpeed(t, alt);

    if (s.liftoffT === null) {
      updateClimb(t, alt);
      updateFall(t);
      checkLiftoff(t, alt, events);
      s.prevReading = { t, alt };
      if (s.liftoffT === null) return events;
    } else {
      s.prevReading = { t, alt };
      s.agl = alt - s.groundRef;
    }

    if (s.maxAgl === null || s.agl > s.maxAgl) {
      s.maxAgl = s.agl;
      s.maxAglT = t;
    }
    if (s.agl > cfg.APOGEE_ARM_AGL_M) s.armed = true;

    // Landing is checked before main, so a landing confirmed by this same
    // reading stops any main inference.
    checkApogee(t, events);
    checkDrogue(t, events);
    checkLanded(t, alt, events);
    checkMain(t, events);
    return events;
  }

  function phase() {
    if (s.landed) return 'landed';
    if (s.main) return 'main';
    if (s.drogue) return 'drogue';
    if (s.apogee) return 'descent';
    if (s.liftoffT !== null) return 'ascent';
    return s.padConfirmed ? 'pad' : 'waiting';
  }

  // A read-only snapshot of everything worked out so far.
  function getState() {
    const p = phase();
    return {
      rocketId: s.rocketId,
      lastT: s.lastT,
      altSource: s.altSource,
      hasBaro: s.hasBaro,
      hasGps: s.hasGps,
      padConfirmed: s.padConfirmed,
      startedInFlight: s.startedInFlight,
      groundRef: s.groundRef ?? padGround(),
      groundFrozen: s.groundRef !== null,
      groundEstimated: s.groundEstimated,
      altitude: s.altitude,
      altitudeT: s.altitudeT,
      agl: s.agl,
      vSpeed: s.vSpeed,
      maxAgl: s.maxAgl,
      maxAglT: s.maxAglT,
      liftoffT: s.liftoffT,
      liftoffDetectedT: s.liftoffDetectedT,
      liftoffEstimated: s.liftoffEstimated,
      flightT: flightTimeOf(s.lastT),
      phase: p,
      phaseLabel: PHASE_LABELS[p],
      fixGood: s.fixGood,
      lastGoodFixT: s.lastGoodFixT,
      // { lat, lon, fixCount, fromT, toT } once landed, else null. lat and
      // lon are null when no GPS fix came in the landing window.
      landing: s.landing,
      events: { liftoff: s.liftoff, apogee: s.apogee, drogue: s.drogue, main: s.main, landed: s.landed },
    };
  }

  function reset() {
    s = freshState();
  }

  return { push, getState, reset, config: Object.freeze({ ...cfg }) };
}

// Runs a fresh detector over a whole list of one rocket's samples. Returns
// { events, state }. Used for the jump-button pre-scan and the Node tools.
export function detectAll(samples, overrides = {}) {
  const detector = createDetector(overrides);
  const events = [];
  for (const sample of samples) events.push(...detector.push(sample));
  return { events, state: detector.getState() };
}
