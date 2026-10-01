// detector.js
// Works out what one rocket is doing from its own readings, one sample at a
// time: ground level, altitude above ground (AGL), smoothed vertical speed,
// and the flight events (liftoff, apogee, drogue, main, landed, GPS fix lost
// and regained, and anything the board reports itself).
//
// It only ever sees normalized samples. It never sees the simulator's ground
// truth, so a simulated flight is judged exactly like a real one.
//
// Every time threshold is in SECONDS. "For X seconds" means the condition
// held on every reading in a streak, and the streak's last reading time
// minus its first reading time is at least X. That works the same at 1 or
// 20 readings per second.
//
// Used by: store.js (one detector per rocket), main.js (a separate detector
// pre-scans each flight for the jump buttons), and both Node tools. No DOM.

import { DETECTOR_DEFAULTS } from './config.js';
import { hasGoodPosition } from './schema.js';
import { formatRounded10, formatFlightSeconds, formatDuration, formatNumber } from './geo.js';

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
      moveStreak: null,    // { t, alt, sign } while moving one way before anything is decided
      belowSince: null,    // { t, alt } where a streak far below a confirmed pad began
      preMax: null,        // { t, alt } highest reading before liftoff, kept in full
      preMaxSmooth: null,  // highest smoothed altitude before liftoff
      altSmooth: null,     // average altitude over the vertical speed window
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
      // Streaks in progress: { startT, startAgl }.
      apogeeStreak: null,
      drogueStreak: null,
      mainStreak: null,
      landedBuf: [],   // altitude readings, for the landed window
      speedBuf: [],    // GPS horizontal speeds from good fixes, for the landed window
      // GPS fix tracking.
      fixGood: null,
      lastGoodFixT: null,
      fixLostT: null,
      padFixLostT: null,           // fix dropped while still on the pad
      padFixBackT: null,           // ...and came back (still before liftoff)
      readingsSincePadFixLoss: 0,  // altitude readings since that drop
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
      if (s.liftoffT === null && s.padFixLostT !== null && s.padFixBackT === null) s.padFixBackT = t;
      s.fixGood = true;
      s.lastGoodFixT = t;
      if (Number.isFinite(sample.gps.speed)) s.speedBuf.push({ t, v: sample.gps.speed });
    } else {
      if (s.fixGood === true) {
        s.fixLostT = t;
        if (s.liftoffT === null) {
          s.padFixLostT = t;
          s.padFixBackT = null;
          s.readingsSincePadFixLoss = 0;
        }
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
      s.moveStreak = null;
      s.belowSince = null;
      s.preMax = null;
      s.preMaxSmooth = null;
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
    const v = s.vSpeed;
    if (v === null) return;

    // A short log that starts just before launch: the first readings sat
    // still for at least PAD_RUN_MIN_S, and the rocket is now climbing like
    // a liftoff, well above them. That's a real pad and a real liftoff, not
    // data starting in flight. (A settling GPS climbs only a few m/s, and two
    // readings 50 ms apart can look still even in fast flight, hence both
    // checks.)
    const run = leadingStillRun();
    const runSpan = run.length ? run[run.length - 1].t - run[0].t : 0;
    if (v > cfg.LIFTOFF_VSPEED_MPS && run.length >= 2 && runSpan >= cfg.PAD_RUN_MIN_S - EPS) {
      const ground = mean(run.map((r) => r.alt));
      if (alt - ground > cfg.LIFTOFF_AGL_M) {
        const firstAbove = s.padReadings.find((r) => r.t > run[run.length - 1].t && r.alt - ground > cfg.LIFTOFF_AGL_M);
        s.padConfirmed = true;
        s.padReadings = run;
        liftoffFromPad(t, alt, events, { triggerT: firstAbove ? firstAbove.t : t, byHeight: true });
        return;
      }
    }

    // Still for PAD_CONFIRM_S: the rocket is on a pad.
    if (Math.abs(v) <= cfg.PAD_STILL_MAX_MPS) {
      s.moveStreak = null;
      if (s.stillSinceT === null) s.stillSinceT = t;
      if (t - s.stillSinceT >= cfg.PAD_CONFIRM_S - EPS) {
        s.padConfirmed = true;
        s.agl = alt - padGround();
      }
      return;
    }
    s.stillSinceT = null;

    // Still falling (faster than PAD_STILL_MAX_MPS over the last
    // VSPEED_AVG_S) and already well below the highest reading: the data
    // began in flight, coming down. This catches a slow main, where noise
    // keeps breaking the streak below.
    if (v < -cfg.PAD_STILL_MAX_MPS && s.preMaxSmooth !== null && s.preMaxSmooth - s.altSmooth > cfg.LIFTOFF_AGL_M) {
      startInFlight(t, alt, events, false);
      return;
    }

    // Moving one way, far enough, for long enough: the data began in flight.
    // (Altitude change measured on the smoothed altitude.) Climbing also has
    // to be as fast as a liftoff: a slow rise is a GPS fix settling, or a
    // rocket right at apogee, which the falling rule above catches next.
    const sign = Math.sign(v);
    if (!s.moveStreak || s.moveStreak.sign !== sign) s.moveStreak = { t, alt: s.altSmooth, sign };
    const fastEnough = sign < 0 || v > cfg.LIFTOFF_VSPEED_MPS;
    if (fastEnough && t - s.moveStreak.t >= cfg.DESCENT_CONFIRM_S - EPS && Math.abs(s.altSmooth - s.moveStreak.alt) > cfg.LIFTOFF_AGL_M) {
      startInFlight(t, alt, events, sign > 0);
    }
  }

  // On a confirmed pad: watch for liftoff, and for the rocket sinking well
  // below the pad, which means it was never on one (data that starts under
  // a slow main parachute can look still at first).
  function checkPad(t, alt, events) {
    const ground = padGround();
    const agl = ground === null ? null : alt - ground;
    s.agl = agl;
    if (agl !== null && agl < -cfg.LIFTOFF_AGL_M) {
      if (s.belowSince === null) s.belowSince = { t, alt };
      // Only a real, continuing descent counts. A GPS glitch that reads low
      // for a few seconds doesn't keep dropping.
      const dropped = s.belowSince.alt - alt;
      if (t - s.belowSince.t >= cfg.DESCENT_CONFIRM_S - EPS &&
          dropped > cfg.PAD_STILL_MAX_MPS * cfg.DESCENT_CONFIRM_S && s.vSpeed !== null && s.vSpeed < -cfg.PAD_STILL_MAX_MPS) {
        s.padConfirmed = false;
        startInFlight(t, alt, events, false);
      }
      return; // readings far below the pad don't join the pad average
    }
    s.belowSince = null;
    const byHeight = agl !== null && agl > cfg.LIFTOFF_AGL_M;
    const bySpeed = s.vSpeed !== null && s.vSpeed > cfg.LIFTOFF_VSPEED_MPS;
    if (!byHeight && !bySpeed) {
      addPadReading(t, alt);
      return;
    }
    liftoffFromPad(t, alt, events, { triggerT: t, byHeight });
  }

  // Liftoff from a pad. triggerT is the first reading that met the liftoff
  // condition, t the reading where we knew.
  function liftoffFromPad(t, alt, events, { triggerT, byHeight }) {
    // If the GPS fix dropped on the pad and the altitude source saw nothing
    // between that drop and now (a GPS-only board losing its fix in boost),
    // the drop is the best guess for liftoff. If altitude readings did
    // arrive after the drop, they time the liftoff themselves.
    let liftoffT = triggerT;
    let estimated = false;
    const fixStillOut = s.padFixBackT === null || s.padFixBackT >= t - EPS;
    if (s.padFixLostT !== null && fixStillOut && s.readingsSincePadFixLoss === 0 && s.padFixLostT < triggerT) {
      liftoffT = s.padFixLostT;
      estimated = true;
    }

    // Freeze the ground reference: pad readings in the PAD_AVG_S before
    // liftoff, or the latest pad readings if a gap left none in that window.
    let pad = s.padReadings.filter((r) => r.t < liftoffT - EPS && r.t >= liftoffT - cfg.PAD_AVG_S - EPS);
    if (!pad.length) pad = s.padReadings.filter((r) => r.t < liftoffT - EPS);
    if (!pad.length) pad = s.padReadings;
    if (pad.length) {
      s.groundRef = mean(pad.map((r) => r.alt));
      s.groundEstimated = false;
    } else {
      s.groundRef = cfg.GROUND_ELEV_FALLBACK_M;
      s.groundEstimated = true;
    }
    s.padReadings = [];
    s.liftoffT = liftoffT;
    s.liftoffDetectedT = t;
    s.liftoffEstimated = estimated;
    s.agl = alt - s.groundRef;

    const reason = byHeight
      ? `more than ${cfg.LIFTOFF_AGL_M} m above the pad`
      : `climbing faster than ${cfg.LIFTOFF_VSPEED_MPS} m/s`;
    let message = `Liftoff detected, ${reason}`;
    if (estimated) message = `Liftoff detected, ${reason} (confirmed ${at(t)}). T+0 is estimated from when the GPS fix dropped on the pad`;
    else if (t > liftoffT + EPS) message = `Liftoff detected, ${reason} (confirmed ${at(t)})`;
    s.liftoff = makeEvent('liftoff', {
      t: liftoffT, confirmedT: t, basis: 'detected', message,
      aglM: estimated ? null : s.agl,
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
    // The readings so far were taken in flight, not on a pad. The highest
    // one is tracked in full (padReadings only keeps the last PAD_AVG_S).
    s.padReadings = [];
    const top = s.preMax && s.preMax.alt >= alt ? s.preMax : { t, alt };
    s.maxAgl = top.alt - s.groundRef;
    s.maxAglT = top.t;
    s.agl = alt - s.groundRef;
    s.liftoff = makeEvent('liftoff', {
      t: s.liftoffT, confirmedT: t, basis: 'detected',
      message: `Liftoff detected from data that starts in flight, already ${climbing ? 'climbing' : 'falling'} at ` +
        `${formatNumber(Math.abs(s.vSpeed), 0)} m/s. The liftoff itself wasn't seen, so T+0 is the first reading ` +
        `and ground level is estimated at ${formatNumber(cfg.GROUND_ELEV_FALLBACK_M, 0)} m above sea level`,
    });
    events.push(s.liftoff);
    if (!climbing) {
      // Already falling: the peak came before the data did.
      s.armed = true;
      s.apogee = makeEvent('apogee', {
        t: s.maxAglT, confirmedT: t, basis: 'detected', aglM: s.maxAgl,
        message: `Apogee detected as already passed, because the data starts in flight and falling. ` +
          `The highest reading is about ${formatRounded10(s.maxAgl)} m AGL at ${at(s.maxAglT)}`,
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
          message: `Apogee detected: about ${formatRounded10(s.maxAgl)} m AGL at ${at(s.maxAglT)} (confirmed ${at(t)})`,
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

  function checkLanded(t, alt, events) {
    if (!s.apogee || s.landed) return;
    s.landedBuf.push({ t, alt });
    // Keep exactly one reading at or before the start of the window.
    while (s.landedBuf.length > 1 && s.landedBuf[1].t <= t - cfg.LANDED_WINDOW_S + EPS) s.landedBuf.shift();
    const first = s.landedBuf[0];
    if (t - first.t < cfg.LANDED_WINDOW_S - EPS) return;
    const alts = s.landedBuf.map((r) => r.alt);
    if (Math.max(...alts) - Math.min(...alts) >= cfg.LANDED_ALT_RANGE_M) return;
    // If GPS speeds arrived during the window, every one must be slow. A
    // rocket whose GPS sent no speed in the window (fix lost in the grass,
    // or GPS in separate rows) is judged on altitude alone.
    const speeds = s.speedBuf.filter((p) => p.t >= first.t - EPS && p.t <= t + EPS);
    if (speeds.some((p) => p.v >= cfg.LANDED_MAX_SPEED_MPS)) return;
    const firstAgl = first.alt - s.groundRef;
    s.landed = makeEvent('landed', {
      t: first.t, confirmedT: t, basis: 'detected', aglM: firstAgl,
      message: `Landing detected: altitude steady at about ${formatRounded10(firstAgl)} m AGL from ` +
        `${at(first.t)} (confirmed ${at(t)})`,
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

    s.altitude = alt;
    s.altitudeT = t;
    if (s.firstAltT === null) s.firstAltT = t;
    if (s.liftoffT === null && (!s.preMax || alt > s.preMax.alt)) s.preMax = { t, alt };
    updateVerticalSpeed(t, alt);
    if (s.liftoffT === null && s.altSmooth !== null && (s.preMaxSmooth === null || s.altSmooth > s.preMaxSmooth)) s.preMaxSmooth = s.altSmooth;

    if (s.liftoffT === null) {
      checkLiftoff(t, alt, events);
      if (s.liftoffT === null) {
        // Still on the pad. A fix that came back on the pad no longer
        // explains a liftoff.
        if (s.padFixBackT !== null) { s.padFixLostT = null; s.padFixBackT = null; }
        if (s.padFixLostT !== null) s.readingsSincePadFixLoss += 1;
        return events;
      }
    } else {
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
