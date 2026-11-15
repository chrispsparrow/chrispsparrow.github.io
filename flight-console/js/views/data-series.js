// data-series.js
// The points for panel 2's graphs, worked out from one rocket in a store:
// a saved flight up to the playhead, or a live flight source as it grows.
// No DOM, so Node can run it too.
//
//   const builder = createSeriesBuilder();
//   const series = builder.update(rocket, { zero, ground });
//
//   zero     the data time (s) that is 0 on the graphs: liftoff when it is
//            known, otherwise the first sample
//   ground   the ground level (m above sea level) for the height above
//            ground, or null when it isn't known yet (the ALT graph waits)
//
// It gives back one list of points per graph line, each point { t, v }
// with t in ms from `zero` (what TimeChart draws) and v null where the line
// has to break:
//   agl      height above ground (m), from the altitude the detector used
//   vs       vertical speed (m/s), worked out the same way the detector
//            does it: the change in altitude over the last VSPEED_AVG_S
//   gs       ground speed (m/s): the board's own GPS speed when the packet
//            has one, otherwise the distance between two good fixes in a
//            row over the time between them
//   sats     GPS satellites, as the board sent them
//   hdop     HDOP, as the board sent it, while it has a fix. When the
//            receiver has lost its satellites it reports a placeholder
//            (99.99, sometimes for one packet before the fix flag drops).
//            That isn't a real HDOP and would squash the rest of the graph,
//            so the line breaks there instead.
//   recv     packets received so far (one per sample)
//   missed   packets missed so far, from the jumps in the packets'
//            sequence numbers. Empty when the packets carry none.
//
// It only reads the store. Nothing here goes through the map's quality
// gate, outlier filter or smoothing: the graphs show what the board sent.
//
// It keeps what it worked out and only reads the new samples on the next
// update. A seek (the store makes new rocket objects), a new zero or a new
// ground level starts it over.
//
// Used by: js/views/data-panel.js and the tests.

import { VSPEED_AVG_S, LINK_STALE_S } from '../config.js?v=3';
import { hasGoodPosition } from '../schema.js?v=2';
import { distanceM } from '../geo.js?v=3';

// Settings
const SEQ_MODULO = 65536;   // the packet's sequence number is 16 bits and wraps around
const SEQ_MAX_JUMP = 1000;  // a bigger jump is a board restart, not lost packets
const HDOP_NONE = 99.99;    // the GPS receiver's "no HDOP" placeholder
const EPS = 1e-6;

export const SERIES_KEYS = Object.freeze(['agl', 'vs', 'gs', 'sats', 'hdop', 'recv', 'missed']);

export function createSeriesBuilder({ vspeedAvgS = VSPEED_AVG_S, pairMaxS = LINK_STALE_S } = {}) {
  let rocketRef = null;
  let zeroT = null;
  let groundM = null;
  let sampleIndex = 0;   // rocket.samples read so far
  let altIndex = 0;      // rocket.altSeries read so far
  let out = empty();
  let altHistory = [];   // { t, alt } covering the last vspeedAvgS, for the vertical speed
  let prevFix = null;    // the last good fix, for the ground speed
  let lastSeq = null;
  let received = 0;
  let missed = 0;

  function empty() {
    return Object.fromEntries(SERIES_KEYS.map((k) => [k, []]));
  }

  function restart(rocket, zero, ground) {
    rocketRef = rocket;
    zeroT = zero;
    groundM = ground;
    sampleIndex = 0;
    altIndex = 0;
    out = empty();
    altHistory = [];
    prevFix = null;
    lastSeq = null;
    received = 0;
    missed = 0;
  }

  const ms = (t) => (t - zeroT) * 1000;

  function readSample(s) {
    const t = ms(s.t);
    received += 1;
    out.recv.push({ t, v: received });

    // Lost packets, from the sequence numbers.
    const seq = Number(s.extra?.seq);
    if (s.extra?.seq !== null && s.extra?.seq !== undefined && Number.isFinite(seq)) {
      if (lastSeq !== null) {
        const step = (((seq - lastSeq) % SEQ_MODULO) + SEQ_MODULO) % SEQ_MODULO;
        if (step > 1 && step <= SEQ_MAX_JUMP) missed += step - 1;
      }
      lastSeq = seq;
      out.missed.push({ t, v: missed });
    }

    const g = s.gps;
    if (!g) return;   // a row of other sensors: nothing for the GPS graphs
    out.sats.push({ t, v: Number.isFinite(g.sats) ? g.sats : null });
    out.hdop.push({ t, v: g.fix === 1 && Number.isFinite(g.hdop) && g.hdop < HDOP_NONE ? g.hdop : null });

    if (!hasGoodPosition(s)) {
      out.gs.push({ t, v: null });
      return;
    }
    let speed = null;
    if (Number.isFinite(g.speed)) speed = g.speed;
    else if (prevFix && s.t > prevFix.t && s.t - prevFix.t <= pairMaxS) {
      speed = distanceM(prevFix.lat, prevFix.lon, g.lat, g.lon) / (s.t - prevFix.t);
    }
    out.gs.push({ t, v: speed });
    prevFix = { t: s.t, lat: g.lat, lon: g.lon };
  }

  function readAltitude(p) {
    const t = ms(p.t);
    if (p.alt === null || !Number.isFinite(p.alt)) {
      out.agl.push({ t, v: null });
      out.vs.push({ t, v: null });
      return;
    }
    if (Number.isFinite(groundM)) out.agl.push({ t, v: p.alt - groundM });

    // The detector's own way: keep one reading at or before the start of
    // the window, then (altitude now - altitude then) / time between them.
    const h = altHistory;
    if (h.length && p.t <= h[h.length - 1].t + EPS) return;
    h.push({ t: p.t, alt: p.alt });
    while (h.length > 1 && h[1].t <= p.t - vspeedAvgS + EPS) h.shift();
    if (h.length > 1 && h[0].t <= p.t - vspeedAvgS + EPS) {
      out.vs.push({ t, v: (p.alt - h[0].alt) / (p.t - h[0].t) });
    }
  }

  function update(rocket, { zero, ground = null } = {}) {
    if (!rocket || !Number.isFinite(zero)) {
      if (rocketRef !== null) restart(null, null, null);
      return out;
    }
    const g = Number.isFinite(ground) ? ground : null;
    if (rocket !== rocketRef || zero !== zeroT || g !== groundM ||
        rocket.samples.length < sampleIndex || rocket.altSeries.length < altIndex) {
      restart(rocket, zero, g);
    }
    for (; sampleIndex < rocket.samples.length; sampleIndex++) readSample(rocket.samples[sampleIndex]);
    for (; altIndex < rocket.altSeries.length; altIndex++) readAltitude(rocket.altSeries[altIndex]);
    return out;
  }

  return { update, reset: () => restart(null, null, null) };
}
