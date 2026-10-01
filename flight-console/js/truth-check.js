// truth-check.js
// Compares detected events with the simulator's ground truth (the "phase"
// values in a simulated log). This is the only code besides the debug panel
// that reads truth. detector.js never imports it, so detection can't cheat.
// Used by: views/debug-panel.js and tools/check_detection.mjs. No DOM.

import { FLIGHT_EVENT_TYPES } from './detector.js';

// Which simulator phase each flight event should line up with. The firmware
// simulator's phases are pad, boost, coast, apogee, drogue, main, landed.
export const TRUTH_PHASE_FOR_EVENT = Object.freeze({
  liftoff: 'boost',
  apogee: 'apogee',
  drogue: 'drogue',
  main: 'main',
  landed: 'landed',
});

// The time each phase first appears, in order: [{ phase, t }].
export function truthPhaseStarts(truthRows) {
  const starts = [];
  const seen = new Set();
  for (const row of truthRows) {
    if (!seen.has(row.phase)) {
      seen.add(row.phase);
      starts.push({ phase: row.phase, t: row.t });
    }
  }
  return starts;
}

// The true phase at data time t, or null before the first row.
export function truthPhaseAt(truthRows, t) {
  let phase = null;
  for (const row of truthRows) {
    if (row.t > t) break;
    phase = row.phase;
  }
  return phase;
}

// One comparison row per flight event type:
//   { type, truthPhase, truthT, detectedT, confirmedT, diffS, count }
// diffS is detected time minus true start (positive = detected late).
// count is how many times the event fired (more than 1 is a bug).
export function compareWithTruth(events, truthRows) {
  const starts = truthPhaseStarts(truthRows);
  const startOf = (phase) => starts.find((s) => s.phase === phase)?.t ?? null;
  // If a simulator has no "boost" phase, liftoff lines up with the first
  // phase after the pad.
  const firstAfterPad = starts.find((s) => s.phase !== 'pad') ?? null;

  return FLIGHT_EVENT_TYPES.map((type) => {
    let truthPhase = TRUTH_PHASE_FOR_EVENT[type];
    let truthT = startOf(truthPhase);
    if (type === 'liftoff' && truthT === null && firstAfterPad) {
      truthPhase = firstAfterPad.phase;
      truthT = firstAfterPad.t;
    }
    const matching = events.filter((e) => e.type === type);
    const first = matching[0] ?? null;
    return {
      type,
      truthPhase,
      truthT,
      detectedT: first ? first.t : null,
      confirmedT: first ? first.confirmedT : null,
      diffS: first && truthT !== null ? first.t - truthT : null,
      count: matching.length,
    };
  });
}
