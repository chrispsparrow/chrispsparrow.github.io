/* ============================================================
   FLIGHT REPLAY
   A JavaScript copy of the flight logic in my AerospaceNU firmware
   (main.cpp, core/Debounce.h, and MS5607::calculateAltitudeM), run on the
   same recorded data the firmware replays in sim mode (SimData.h).

   The port follows the C++ line for line on purpose, quirks included.
   Math.fround rounds to a 32-bit float everywhere the C++ uses a float, and
   the altitude formula runs in double like it does in the C++.
   ============================================================ */
(function (root) {
  'use strict';

  const f32 = Math.fround;

  /* ── MS5607.h ─────────────────────────────────────────────── */
  const G_EARTH_MSS = 9.80665;
  const ATMOSPHERIC_PRESSURE_PA = 101325;
  const LAPSE_RATE_K_M = -0.0065;
  const GAS_CONSTANT_J_KG_K = 287.0474909;

  function calculateAltitudeM(pressurePa) {
    return f32((286.0 / LAPSE_RATE_K_M) *
      (Math.pow(pressurePa / ATMOSPHERIC_PRESSURE_PA,
        -GAS_CONSTANT_J_KG_K * LAPSE_RATE_K_M / G_EARTH_MSS) - 1));
  }

  /* ── core/Debounce.h ──────────────────────────────────────── */
  class Debounce {
    constructor(time, millis) {
      this.m_debounceTimeMs = time;
      this.m_referenceTime = 0;
      this.m_isInitialized = false;
      this.millis = millis;
    }

    check(condition) {
      const currentTime = this.millis();

      if (!this.m_isInitialized) {
        this.m_referenceTime = currentTime;
        this.m_isInitialized = true;
      }

      if (condition) {
        if (((currentTime - this.m_referenceTime) >>> 0) >= this.m_debounceTimeMs) {
          return true;
        }
      } else {
        this.m_referenceTime = currentTime;
      }

      return false;
    }
  }

  /* ── main.cpp ─────────────────────────────────────────────── */
  const PRE_FLIGHT = 0, ASCENT = 1, DESCENT = 2, POST_FLIGHT = 3;
  const STATE_NAMES = ['Pre-flight', 'Ascent', 'Descent', 'Post-flight'];
  const LOOP_MS = 20;   // loop(): tickEndTime = millis() + 20

  /**
   * Replays the recorded data through the flight logic.
   * data: { t, p, ax, ay, az } column arrays (see assets/firmware/flight-data.json)
   * opts.holdTimers: false turns the three Debounce hold times into 0 ms
   * opts.startMs: millis() at the first loop (only moves the velocity filter's startup spike)
   */
  function run(data, opts) {
    opts = opts || {};
    const holdTimers = opts.holdTimers !== false;
    const n = data.p.length;

    // Sim clock: the firmware waits for each 20 ms tick, so millis() steps by 20 per loop
    let now = opts.startMs || 0;
    const millis = () => now;

    let state = PRE_FLIGHT;
    const takeoffDebounce = new Debounce(holdTimers ? 100 : 0, millis);
    const apogeeDebounce = new Debounce(holdTimers ? 500 : 0, millis);
    const landingDebounce = new Debounce(holdTimers ? 5000 : 0, millis);

    // lowPassPosition() statics
    let posInitialized = false;
    let posOutput = 0;
    function lowPassPosition(position) {
      const alpha = f32(0.1);
      if (!posInitialized) {
        posOutput = position;
        posInitialized = true;
        return posOutput;
      }
      posOutput = f32(posOutput + f32(alpha * f32(position - posOutput)));
      return posOutput;
    }

    // lowPassVelocity() statics
    let velInitialized = false;
    let lastPosition = 0;
    let lastTime = 0;
    let velocity = 0;
    function lowPassVelocity(position) {
      const alpha = f32(0.05);

      const currentTime = millis();
      const dt = f32(f32((currentTime - lastTime) >>> 0) / 1000);
      const newVelocity = f32(f32(position - lastPosition) / dt);

      if (!velInitialized) {
        velInitialized = true;
        velocity = 0;
        return 0;          // returns before saving lastPosition and lastTime (same as the C++)
      }

      velocity = f32(velocity + f32(alpha * f32(newVelocity - velocity)));

      lastPosition = position;
      lastTime = currentTime;

      return velocity;
    }

    // static float referenceAltitude = 0 (inside the DESCENT branch)
    let referenceAltitude = 0;

    // SimData: index starts at 0 and getNext() runs before each read
    let index = 0;
    function getNext() {
      index++;
      if (index >= n) index--;
    }

    const out = { row: [], raw: [], smooth: [], velocity: [], state: [], events: {} };

    for (let loop = 0; ; loop++) {
      if (loop > 0) now += LOOP_MS;

      getNext();
      const pressurePa = f32(data.p[index]);
      const ax = f32(data.ax[index]), ay = f32(data.ay[index]), az = f32(data.az[index]);

      const altitudeMRaw = calculateAltitudeM(pressurePa);
      const netAccelerationMSS = f32(Math.sqrt(f32(f32(f32(ax * ax) + f32(ay * ay)) + f32(az * az))));
      const altitudeM = lowPassPosition(altitudeMRaw);
      const velocityMS = lowPassVelocity(altitudeMRaw);

      if (state === PRE_FLIGHT) {
        if (takeoffDebounce.check(altitudeM > 100 || netAccelerationMSS > 40)) {
          state = ASCENT;
          out.events.launch = index;
        }
      } else if (state === ASCENT) {
        // logger.writeLogEntry(logData)
        if (apogeeDebounce.check(velocityMS < -2.0)) {
          state = DESCENT;
          out.events.apogee = index;
        }
      } else if (state === DESCENT) {
        // logger.writeLogEntry(logData)
        const altitudeChanged = Math.abs(f32(altitudeM - referenceAltitude)) > 3.0;

        if (altitudeChanged) {
          referenceAltitude = altitudeM;
        }

        if (landingDebounce.check(!altitudeChanged)) {
          state = POST_FLIGHT;
          out.events.landing = index;
        }
      }

      out.row.push(index);
      out.raw.push(altitudeMRaw);
      out.smooth.push(altitudeM);
      out.velocity.push(velocityMS);
      out.state.push(state);

      // After the last row the firmware keeps rereading it, and nothing changes
      if (index === n - 1) break;
    }
    return out;
  }

  const FlightSim = { run, calculateAltitudeM, Debounce, STATE_NAMES, LOOP_MS,
                      PRE_FLIGHT, ASCENT, DESCENT, POST_FLIGHT };
  if (typeof module !== 'undefined' && module.exports) { module.exports = FlightSim; return; }
  root.FlightSim = FlightSim;

  /* ============================================================
     CHART (browser only): vanilla JS + inline SVG, no library
     ============================================================ */

  // millis() at the first loop. setup() takes well over 100 ms (the ICM-20602
  // wake-up alone waits 100 ms) and in sim mode it also waits for the serial
  // monitor. Any start of 38 ms or later gives the same result with the hold
  // timers off, so 1 s stands in for "after setup finished".
  const START_MS = 1000;
  const CROP_S = 100;      // the rest of the recording is the rocket on the ground
  const GAP_MS = 250;      // a jump this big between rows is a gap in the recording
  const EVENTS = [['launch', 'Launch'], ['apogee', 'Apogee'], ['landing', 'Landing']];
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const dataCache = {};
  function loadData(url) {
    if (!dataCache[url]) dataCache[url] = fetch(url).then(r => {
      if (!r.ok) throw new Error('flight data ' + r.status);
      return r.json();
    });
    return dataCache[url];
  }

  function fmtTime(ms) {
    return (Math.round(ms / 10) / 100).toFixed(2) + ' s';
  }

  function buildSeries(data, holdTimers) {
    const sim = run(data, { holdTimers, startMs: START_MS });
    const base = sim.raw[0];                       // height is measured from the first reading
    const pts = [];
    for (let k = 0; k < sim.row.length; k++) {
      const i = sim.row[k];
      if (data.t[i] / 1000 > CROP_S) break;
      pts.push({
        ms: data.t[i],
        t: data.t[i] / 1000,
        raw: sim.raw[k] - base,
        smooth: sim.smooth[k] - base,
        state: sim.state[k],
        gap: k > 0 && data.t[i] - data.t[sim.row[k - 1]] > GAP_MS
      });
    }
    const events = {};
    for (const [key] of EVENTS) {
      const row = sim.events[key];
      if (row === undefined) continue;
      const k = sim.row.indexOf(row);
      if (k < pts.length) events[key] = { k, ms: data.t[row], t: data.t[row] / 1000, h: pts[k].smooth };
    }
    let peak = 0;
    for (let k = 1; k < pts.length; k++) if (pts[k].smooth > pts[peak].smooth) peak = k;
    return { pts, events, peak: pts[peak] };
  }

  function niceStep(range, target) {
    const raw = range / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  }

  function summaryText(series, holdTimers) {
    const e = series.events;
    if (!e.launch) return 'Chart of the recorded flight data.';
    const parts = [];
    if (holdTimers) {
      parts.push(`Replay of recorded flight data through my flight logic, height above the starting point over the first ${CROP_S} seconds.`);
      parts.push(`The code detected launch at ${fmtTime(e.launch.ms)}` +
        (e.apogee ? `, apogee at ${fmtTime(e.apogee.ms)} at a height of ${Math.round(e.apogee.h)} meters` : '') +
        (e.landing ? `, and landing at ${fmtTime(e.landing.ms)}` : '') + '.');
      parts.push(`The highest smoothed altitude was ${Math.round(series.peak.smooth)} meters at ${fmtTime(series.peak.ms)}.`);
    } else {
      parts.push('With the hold timers off, the altitude reading dips about a meter right at ignition, so the code thinks the rocket is already falling.');
      parts.push(`It calls launch at ${fmtTime(e.launch.ms)}` +
        (e.apogee ? `, apogee at ${fmtTime(e.apogee.ms)}` : '') +
        (e.landing ? `, and landing at ${fmtTime(e.landing.ms)}` : '') + ', all right at ignition.');
    }
    return parts.join(' ').replace(/ s\b/g, ' seconds');
  }

  /**
   * Mounts an interactive chart.
   * el: the container. Its data-src attribute is the flight-data.json URL.
   * opts.fill: the chart takes the container's height (home page panel)
   *            instead of sizing itself from its width (project page)
   * opts.toggle: button that turns the hold timers off and on
   * opts.summary: element that gets the screen-reader summary
   */
  function mount(el, opts) {
    opts = opts || {};
    const fill = !!opts.fill;
    let holdTimers = true;
    let series = null;
    const seriesCache = {};
    let hoverK = null;

    el.classList.add('fr-chart', fill ? 'fr-chart--fill' : 'fr-chart--full');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    el.appendChild(svg);

    const tip = document.createElement('div');
    tip.className = 'fr-tip';
    tip.hidden = true;
    el.appendChild(tip);

    let layout = null;

    function render() {
      if (!series) return;
      const W = Math.max(240, el.clientWidth);
      const narrow = W < 480;
      const H = fill ? Math.max(220, el.clientHeight)
                     : narrow ? 340 : Math.round(Math.max(300, Math.min(460, W * 0.5)));
      const m = { l: narrow ? 50 : 62, r: narrow ? 12 : 20, b: 40 };
      const pw = W - m.l - m.r;
      const x = t => m.l + (t / CROP_S) * pw;

      // Event labels sit in rows above the plot. Lay them out first (they only
      // depend on x), stacking any that would overlap, then size the top margin.
      const labelY = 16, rowH = 16;
      const rowsEnd = [];
      const labels = [];
      for (const [key, name] of EVENTS) {
        const ev = series.events[key];
        if (!ev) continue;
        const ex = x(ev.t);
        const text = `${name} ${fmtTime(ev.ms)}`;
        const tw = text.length * 7.1 + 8;
        const anchorEnd = ex + tw > W - 4;
        const left = anchorEnd ? ex - tw : ex;
        let row = 0;
        while (rowsEnd[row] !== undefined && rowsEnd[row] > left - 6) row++;
        rowsEnd[row] = left + tw;
        labels.push({ ev, ex, text, anchorEnd, ly: labelY + row * rowH });
      }
      m.t = labelY + Math.max(0, rowsEnd.length - 1) * rowH + 20;
      const ph = H - m.t - m.b;

      // Height axis: nice steps from 0 up. The dip at ignition is only a meter or
      // two, so the bottom sits just under the lowest point instead of a whole step down.
      const pts = series.pts;
      let yMax = 0, dataMin = 0;
      for (const p of pts) { yMax = Math.max(yMax, p.raw, p.smooth); dataMin = Math.min(dataMin, p.raw, p.smooth); }
      const yStep = niceStep(yMax - dataMin, ph < 260 ? 4 : 6);
      yMax = Math.ceil(yMax / yStep) * yStep;
      const yMin = dataMin - (yMax - dataMin) * 0.02;
      const y = h => m.t + (1 - (h - yMin) / (yMax - yMin)) * ph;

      const path = key => {
        let d = '';
        for (let k = 0; k < pts.length; k++) {
          const p = pts[k];
          d += (k === 0 || p.gap ? 'M' : 'L') + x(p.t).toFixed(1) + ' ' + y(p[key]).toFixed(1);
        }
        return d;
      };

      // grid + axes
      let s = '';
      for (let v = 0; v <= yMax + 1e-9; v += yStep) {
        s += `<line class="fr-grid" x1="${m.l}" x2="${m.l + pw}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>`;
        s += `<text class="fr-axis" x="${m.l - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`;
      }
      s += `<line class="fr-tick" x1="${m.l}" x2="${m.l + pw}" y1="${m.t + ph}" y2="${m.t + ph}"/>`;
      const xStep = narrow ? 20 : 10;
      for (let t = 0; t <= CROP_S; t += xStep) {
        s += `<line class="fr-tick" x1="${x(t).toFixed(1)}" x2="${x(t).toFixed(1)}" y1="${m.t + ph}" y2="${m.t + ph + 5}"/>`;
        s += `<text class="fr-axis" x="${x(t).toFixed(1)}" y="${m.t + ph + 19}" text-anchor="middle">${t}</text>`;
      }
      s += `<text class="fr-axis-title" x="${m.l + pw}" y="${H - 4}" text-anchor="end">Time (s)</text>`;
      const ty = m.t + ph / 2;
      s += `<text class="fr-axis-title" x="14" y="${ty.toFixed(1)}" text-anchor="middle" transform="rotate(-90 14 ${ty.toFixed(1)})">Height above start (m)</text>`;

      s += `<path class="fr-raw" d="${path('raw')}"/>`;
      s += `<path class="fr-smooth" d="${path('smooth')}"/>`;

      // event markers: dashed drop line, dot on the smoothed line, label at the top
      for (const { ev, ex, text, anchorEnd, ly } of labels) {
        const ey = y(ev.h);
        s += `<line class="fr-event-line" x1="${ex.toFixed(1)}" x2="${ex.toFixed(1)}" y1="${ly + 4}" y2="${ey.toFixed(1)}"/>`;
        s += `<circle class="fr-event-dot" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4.5"/>`;
        s += `<text class="fr-event-label" x="${(anchorEnd ? ex - 5 : ex + 5).toFixed(1)}" y="${ly}" text-anchor="${anchorEnd ? 'end' : 'start'}">${text}</text>`;
      }

      s += `<line class="fr-cross" x1="0" x2="0" y1="${m.t}" y2="${m.t + ph}" visibility="hidden"/>`;
      s += `<circle class="fr-hover-dot" r="4" visibility="hidden"/>`;

      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('width', W);
      svg.setAttribute('height', H);
      svg.innerHTML = s;
      layout = { x, y, m, pw, ph, W, H };
      if (hoverK !== null) showHover(hoverK);
    }

    function nearest(t) {
      const pts = series.pts;
      let lo = 0, hi = pts.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].t < t) lo = mid; else hi = mid;
      }
      return Math.abs(pts[lo].t - t) <= Math.abs(pts[hi].t - t) ? lo : hi;
    }

    function showHover(k) {
      if (!layout) return;
      hoverK = k;
      const p = series.pts[k];
      const cx = layout.x(p.t), cy = layout.y(p.smooth);
      const cross = svg.querySelector('.fr-cross'), dot = svg.querySelector('.fr-hover-dot');
      cross.setAttribute('x1', cx.toFixed(1)); cross.setAttribute('x2', cx.toFixed(1));
      cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', cx.toFixed(1)); dot.setAttribute('cy', cy.toFixed(1));
      dot.setAttribute('visibility', 'visible');
      tip.innerHTML =
        `<div><span>Time</span> ${fmtTime(p.ms)}</div>` +
        `<div><span>Height</span> ${Math.round(p.smooth)} m</div>` +
        `<div><span>State</span> ${STATE_NAMES[p.state]}</div>`;
      tip.hidden = false;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = cx + 12;
      if (left + tw > layout.W - 4) left = cx - tw - 12;
      const top = Math.min(Math.max(cy - th - 12, layout.m.t), layout.m.t + layout.ph - th);
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = top + 'px';
    }

    function hideHover() {
      hoverK = null;
      tip.hidden = true;
      const cross = svg.querySelector('.fr-cross'), dot = svg.querySelector('.fr-hover-dot');
      if (cross) cross.setAttribute('visibility', 'hidden');
      if (dot) dot.setAttribute('visibility', 'hidden');
    }

    function pointerToK(ev) {
      const r = svg.getBoundingClientRect();
      const px = ev.clientX - r.left;
      const t = ((px - layout.m.l) / layout.pw) * CROP_S;
      return nearest(Math.min(Math.max(t, 0), CROP_S));
    }

    el.tabIndex = 0;
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Flight replay chart. Use the left and right arrow keys to move through the flight.');
    el.addEventListener('pointermove', ev => { if (series && layout) showHover(pointerToK(ev)); });
    el.addEventListener('pointerdown', ev => { if (series && layout) showHover(pointerToK(ev)); });
    el.addEventListener('pointerleave', ev => { if (ev.pointerType === 'mouse') hideHover(); });
    el.addEventListener('keydown', ev => {
      if (!series) return;
      const stepS = ev.shiftKey ? 5 : 0.5;
      let t = hoverK === null ? 0 : series.pts[hoverK].t;
      if (ev.key === 'ArrowRight') t += stepS;
      else if (ev.key === 'ArrowLeft') t -= stepS;
      else if (ev.key === 'Escape') { hideHover(); return; }
      else return;
      ev.preventDefault();
      showHover(nearest(Math.min(Math.max(t, 0), CROP_S)));
    });
    el.addEventListener('blur', hideHover);

    function setHoldTimers(on) {
      holdTimers = on;
      if (!seriesCache[on]) seriesCache[on] = buildSeries(el._data, on);
      series = seriesCache[on];
      if (opts.toggle) {
        opts.toggle.setAttribute('aria-pressed', String(!on));
        opts.toggle.textContent = on ? 'Turn off the hold timers' : 'Turn the hold timers back on';
      }
      if (opts.summary) opts.summary.textContent = summaryText(series, on);
      render();
    }

    if (opts.toggle) opts.toggle.addEventListener('click', () => { if (el._data) setHoldTimers(!holdTimers); });

    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(render); });

    return loadData(el.dataset.src).then(data => {
      el._data = data;
      el.classList.add('fr-ready');
      setHoldTimers(true);
      ro.observe(el);
      return { setHoldTimers };
    }).catch(err => {
      el.classList.add('fr-failed');
      if (opts.summary) opts.summary.textContent = 'The flight chart could not load.';
      console.error(err);
    });
  }

  root.FlightChart = { mount };

  // Auto-mount: data-flight-chart="full" on the project page, "panel" on the
  // home page. The panel chart fills its card and waits until it's close to
  // the screen before loading the data, so the home page loads light.
  function autoMount() {
    document.querySelectorAll('[data-flight-chart]').forEach(el => {
      const panel = el.dataset.flightChart === 'panel';
      const go = () => mount(el, {
        fill: panel,
        toggle: document.getElementById(el.dataset.toggle || ''),
        summary: document.getElementById(el.dataset.summary || '')
      });
      if (panel && 'IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
          if (entries.some(e => e.isIntersecting)) { io.disconnect(); go(); }
        }, { rootMargin: '600px 0px' });
        io.observe(el);
      } else {
        go();
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', autoMount);
  else autoMount();
})(typeof window !== 'undefined' ? window : this);
