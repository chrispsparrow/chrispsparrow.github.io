// hero-seafloor.js
// The slowly moving sea-floor lines behind the landing's hero. A smooth
// made-up height field drifts and swells a little, and this file draws its
// contour lines live on a canvas: marching squares on a coarse grid, the
// pieces joined into lines, then drawn as curves through the midpoints so
// they look like the old hand-smoothed paths. Every fifth level is an index
// line, a little brighter and thicker, like on a chart. A few thin dashed
// gold "ocean current" lines run along two of the middle levels, and their
// dashes drift slowly along them.
//
// The motion loops. Time moves around a circle in two of the noise's four
// dimensions, so after cycleS seconds the field is exactly where it started.
//
// The page only ever calls this:
//   const stop = startSeafloor(canvas, options);
//   ...
//   stop();   // ends the loop and removes every listener and observer
// A later version that draws real ocean current data can replace this whole
// file, as long as it exports the same start function shape: a canvas in,
// a stop function out. stop() leaves the last frame on the canvas.
//
// Options (all optional):
//   fps       redraws per second, 15 to 30 (20)
//   cellPx    marching squares cell size in CSS px, 6 to 32 (12)
//   cycleS    seconds for one full loop of the motion (24)
//   seed      whole number that picks the sea floor (1)
//   levels    contour levels across the field's range, 4 to 30 (14)
//   currents  how many gold current lines, 0 to 4 (3, at most 2 on a
//             canvas narrower than 600 px)
//   onFrame   called after every drawn frame with
//             { frame, t, drawMs, width, height, dpr, lines, currents }
//             where currents lists { id, level, alpha, fading, ghost, len,
//             anchor }
//             (for tests)
//
// Colors and line weights come from CSS custom properties on the canvas,
// with these fallbacks:
//   --seafloor-line           line color (then --fc-text-2, then #b8bfcc)
//   --seafloor-line-alpha     plain line opacity (0.075)
//   --seafloor-index-alpha    index line opacity (0.13)
//   --seafloor-line-width     plain line width in CSS px (1)
//   --seafloor-index-width    index line width in CSS px (1.3)
//   --seafloor-current        current color (then --fc-gold, then #d4a843)
//   --seafloor-current-alpha  current opacity (0.3)
// They are read when drawing starts and again on every resize. The canvas
// background stays transparent, so the page color shows through.
//
// To keep it cheap and calm: at most fps redraws a second (frames in between
// are skipped), devicePixelRatio capped at 2, a pause while the tab is hidden
// or the canvas is off screen, and one still frame with no loop at all when
// the visitor asks for reduced motion (it follows that setting live).
//
// Used by: the landing's hero (js/views/launcher.js starts it). It only
// touches the canvas it is given. No imports.

const TAU = Math.PI * 2;

// The field. One noise unit is about featurePx CSS px across (set from the
// canvas width on resize, see featureSizeFor).
const FIELD_RANGE = 0.6;      // the levels spread over about -0.6 to +0.6, where most of the field is
const TIME_RADIUS = 0.055;    // radius of the time circle in noise units (bigger moves more)
const DETAIL_SCALE = 2.0;     // second octave, finer
const DETAIL_WEIGHT = 0.22;   // and weaker
const DETAIL_TIME_RADIUS = 0.065;
const SWELL = 0.3;            // every level rises and falls this many level spacings per cycle

// The gold current lines.
const CURRENT_WIDTH = 1.2;    // CSS px
const CURRENT_DASH = 9;       // dash and gap, CSS px
const CURRENT_GAP = 13;
const CURRENT_SPEED = 11;     // how fast the dashes drift along the line, CSS px a second
const CURRENT_FADE_IN_S = 2.5;
const CURRENT_FADE_OUT_S = 2;
const CURRENT_NEW_EVERY_S = 1.5;  // at most one new current this often
const CURRENT_SAMPLES = 16;   // points kept from each current to find it again next frame
const CURRENT_KEEP = 0.3;     // share of those points that must still sit on a line to follow it
const CURRENT_SWAP_S = 1.2;   // crossfade time when a current's line changes route
const ROUTE_STEP = 24;        // CSS px between the points compared to spot a route change
const ROUTE_CHANGE_PX = 72;   // this much path gained or lost in one frame counts as a new route

const DEFAULT_LINE = '#b8bfcc';
const DEFAULT_CURRENT = '#d4a843';

export function startSeafloor(canvas, options = {}) {
  const fps = clamp(numberOr(options.fps, 20), 15, 30);
  const cellPx = clamp(numberOr(options.cellPx, 12), 6, 32);
  const cycleS = clamp(numberOr(options.cycleS, 24), 5, 600);
  const seed = Math.floor(numberOr(options.seed, 1)) >>> 0;
  const levels = Math.round(clamp(numberOr(options.levels, 14), 4, 30));
  const wantCurrents = Math.round(clamp(numberOr(options.currents, 3), 0, 4));
  const onFrame = typeof options.onFrame === 'function' ? options.onFrame : null;

  const ctx = canvas.getContext('2d');
  if (!ctx) return () => {};

  const noise4 = makeSimplex4(seed);
  const frameMs = 1000 / fps;

  // Levels are numbered 0 to levels - 1 around a middle one at value 0.
  // Index lines are every fifth level counting from the middle.
  const midLevel = Math.floor(levels / 2);
  const spacing = (2 * FIELD_RANGE) / levels;
  const isIndex = (k) => ((k - midLevel) % 5 + 5) % 5 === 0;
  // The currents ride the two plain levels next to the middle one, where the
  // longest lines are.
  const currentLevels = [midLevel - 1, midLevel + 1].filter((k) => k >= 0 && k < levels);

  // Size and grid
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let featurePx = 400;
  let nx = 0;
  let ny = 0;
  let values = new Float32Array(0);   // field at each grid point
  let cellMin = new Float32Array(0);  // lowest and highest corner of each cell
  let cellMax = new Float32Array(0);
  // Per edge scratch for joining segments, reused every level. Stamps
  // instead of clearing.
  let hEdges = 0;
  let next = new Int32Array(0);
  let nextStamp = new Uint32Array(0);
  let prevStamp = new Uint32Array(0);
  let seenStamp = new Uint32Array(0);
  let edgeX = new Float32Array(0);
  let edgeY = new Float32Array(0);
  let touched = new Int32Array(0);
  let stamp = 0;

  // Every contour point of the current frame, and the lines made of them.
  let ptX = new Float32Array(8192);
  let ptY = new Float32Array(8192);
  let ptCount = 0;
  let lines = [];   // { level, start, count, closed, len }

  // Colors
  let style = readStyle();

  // State
  let stopped = false;
  let reduced = false;
  let tabVisible = document.visibilityState !== 'hidden';
  let onScreen = true;   // until the first IntersectionObserver report says otherwise
  let raf = 0;
  let lastTick = 0;
  let lastDraw = 0;
  let animT = 0;         // seconds of motion so far (does not move while paused)
  let lastFrameT = 0;
  let frame = 0;
  let picks = [];        // the gold currents being drawn
  let newPickWait = 0;
  let pickCount = 0;     // gives each current a number, for onFrame

  // ---------- Size ----------

  function measure() {
    const rect = canvas.getBoundingClientRect();
    return { w: Math.max(0, Math.round(rect.width)), h: Math.max(0, Math.round(rect.height)) };
  }

  // Returns true when the canvas changed size (or pixel ratio).
  function resizeTo(w, h) {
    const newDpr = Math.min(2, window.devicePixelRatio || 1);
    if (w === cssW && h === cssH && newDpr === dpr) return false;
    const widthChanged = w !== cssW;
    cssW = w;
    cssH = h;
    dpr = newDpr;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    if (widthChanged) {
      featurePx = featureSizeFor(w);
      picks = [];   // the lines move when the scale changes, so pick again
    }
    nx = Math.ceil(w / cellPx) + 1;
    ny = Math.ceil(h / cellPx) + 1;
    const points = nx * ny;
    const cells = Math.max(0, (nx - 1) * (ny - 1));
    if (values.length < points) values = new Float32Array(points);
    if (cellMin.length < cells) {
      cellMin = new Float32Array(cells);
      cellMax = new Float32Array(cells);
    }
    hEdges = (nx - 1) * ny;
    const edges = hEdges + nx * (ny - 1);
    if (next.length < edges) {
      next = new Int32Array(edges);
      nextStamp = new Uint32Array(edges);
      prevStamp = new Uint32Array(edges);
      seenStamp = new Uint32Array(edges);
      edgeX = new Float32Array(edges);
      edgeY = new Float32Array(edges);
      touched = new Int32Array(edges);
      stamp = 0;
    }
    style = readStyle();
    return true;
  }

  function readStyle() {
    const cs = getComputedStyle(canvas);
    const prop = (name) => cs.getPropertyValue(name).trim();
    const num = (name, fallback) => {
      const v = parseFloat(prop(name));
      return Number.isFinite(v) ? v : fallback;
    };
    return {
      line: prop('--seafloor-line') || prop('--fc-text-2') || DEFAULT_LINE,
      lineAlpha: num('--seafloor-line-alpha', 0.075),
      indexAlpha: num('--seafloor-index-alpha', 0.13),
      lineWidth: num('--seafloor-line-width', 1),
      indexWidth: num('--seafloor-index-width', 1.3),
      current: prop('--seafloor-current') || prop('--fc-gold') || DEFAULT_CURRENT,
      currentAlpha: num('--seafloor-current-alpha', 0.3),
    };
  }

  // ---------- The field ----------

  function computeField(t) {
    const angle = (TAU * t) / cycleS;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const z1 = c * TIME_RADIUS;
    const w1 = s * TIME_RADIUS;
    const z2 = c * DETAIL_TIME_RADIUS + 7.1;
    const w2 = s * DETAIL_TIME_RADIUS - 3.3;
    const step = cellPx / featurePx;
    const norm = 1 / (1 + DETAIL_WEIGHT);
    for (let j = 0; j < ny; j++) {
      const y = j * step;
      const row = j * nx;
      for (let i = 0; i < nx; i++) {
        const x = i * step;
        const v = noise4(x, y, z1, w1) +
          DETAIL_WEIGHT * noise4(x * DETAIL_SCALE + 31.7, y * DETAIL_SCALE - 12.9, z2, w2);
        values[row + i] = v * norm;
      }
    }
    const cw = nx - 1;
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < cw; i++) {
        const p = j * nx + i;
        const a = values[p];
        const b = values[p + 1];
        const d = values[p + nx];
        const e = values[p + nx + 1];
        cellMin[j * cw + i] = Math.min(a, b, d, e);
        cellMax[j * cw + i] = Math.max(a, b, d, e);
      }
    }
    return SWELL * spacing * s;
  }

  // ---------- Contours ----------

  function addPoint(x, y) {
    if (ptCount === ptX.length) {
      const bx = new Float32Array(ptX.length * 2);
      const by = new Float32Array(ptY.length * 2);
      bx.set(ptX);
      by.set(ptY);
      ptX = bx;
      ptY = by;
    }
    ptX[ptCount] = x;
    ptY[ptCount] = y;
    ptCount += 1;
  }

  // Edge numbers: horizontal edges first (row by row), then vertical ones.
  // Each crossing point is written by both cells that share the edge, with
  // the same numbers, so the two always agree.
  function edgePoint(side, i, j, v0, v1, v2, v3, level) {
    let e;
    let t;
    if (side === 0) {        // top: v0 to v1
      e = j * (nx - 1) + i;
      t = (level - v0) / (v1 - v0);
      edgeX[e] = (i + t) * cellPx;
      edgeY[e] = j * cellPx;
    } else if (side === 1) { // right: v1 to v2
      e = hEdges + j * nx + i + 1;
      t = (level - v1) / (v2 - v1);
      edgeX[e] = (i + 1) * cellPx;
      edgeY[e] = (j + t) * cellPx;
    } else if (side === 2) { // bottom: v3 to v2
      e = (j + 1) * (nx - 1) + i;
      t = (level - v3) / (v2 - v3);
      edgeX[e] = (i + t) * cellPx;
      edgeY[e] = (j + 1) * cellPx;
    } else {                 // left: v0 to v3
      e = hEdges + j * nx + i;
      t = (level - v0) / (v3 - v0);
      edgeX[e] = i * cellPx;
      edgeY[e] = (j + t) * cellPx;
    }
    return e;
  }

  function traceLevels(swellOffset) {
    ptCount = 0;
    lines = [];
    const cw = nx - 1;
    for (let k = 0; k < levels; k++) {
      const level = (k - midLevel) * spacing + swellOffset;
      stamp += 1;
      if (stamp > 0xfffffff0) {
        nextStamp.fill(0);
        prevStamp.fill(0);
        seenStamp.fill(0);
        stamp = 1;
      }
      let nTouched = 0;
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < cw; i++) {
          const c = j * cw + i;
          if (cellMin[c] > level || cellMax[c] <= level) continue;
          const p = j * nx + i;
          const v0 = values[p];
          const v1 = values[p + 1];
          const v2 = values[p + nx + 1];
          const v3 = values[p + nx];
          const kind = (v0 > level ? 1 : 0) | (v1 > level ? 2 : 0) | (v2 > level ? 4 : 0) | (v3 > level ? 8 : 0);
          let pairs = CASES[kind];
          if (kind === 5 || kind === 10) {
            const centerHigh = (v0 + v1 + v2 + v3) * 0.25 > level;
            pairs = SADDLES[kind][centerHigh ? 1 : 0];
          }
          for (let q = 0; q < pairs.length; q += 2) {
            const a = edgePoint(pairs[q], i, j, v0, v1, v2, v3, level);
            const b = edgePoint(pairs[q + 1], i, j, v0, v1, v2, v3, level);
            next[a] = b;
            nextStamp[a] = stamp;
            prevStamp[b] = stamp;
            touched[nTouched++] = a;
          }
        }
      }
      // Lines that start and end at the canvas edge first, then closed loops.
      for (let q = 0; q < nTouched; q++) {
        const a = touched[q];
        if (prevStamp[a] === stamp || seenStamp[a] === stamp) continue;
        walk(a, k, false);
      }
      for (let q = 0; q < nTouched; q++) {
        const a = touched[q];
        if (seenStamp[a] === stamp) continue;
        walk(a, k, true);
      }
    }
  }

  function walk(first, level, closed) {
    const start = ptCount;
    let e = first;
    let guard = next.length + 1;
    while (guard-- > 0) {
      seenStamp[e] = stamp;
      addPoint(edgeX[e], edgeY[e]);
      if (nextStamp[e] !== stamp) break;   // open line ends here
      e = next[e];
      if (e === first) break;              // loop closed
    }
    const isClosed = closed && ptCount - start >= 3;
    const count = cutCorners(start, ptCount - start, isClosed);
    if (count >= 2) lines.push({ level, start, count, closed: isClosed, len: -1 });
  }

  // One pass of corner cutting on a line's points, in place. Marching
  // squares leaves small kinks where a line passes close to a grid point,
  // and small loops come out as polygons. This softens both before the
  // midpoint curves. Open lines keep their end points on the canvas edge.
  let cutX = new Float32Array(1024);
  let cutY = new Float32Array(1024);
  function cutCorners(start, count, isClosed) {
    if (count < 3) return count;
    if (cutX.length < count) {
      cutX = new Float32Array(count * 2);
      cutY = new Float32Array(count * 2);
    }
    cutX.set(ptX.subarray(start, start + count));
    cutY.set(ptY.subarray(start, start + count));
    ptCount = start;
    const segs = isClosed ? count : count - 1;
    for (let q = 0; q < segs; q++) {
      const b = q + 1 === count ? 0 : q + 1;
      const ax = cutX[q];
      const ay = cutY[q];
      const bx = cutX[b];
      const by = cutY[b];
      if (!isClosed && q === 0) addPoint(ax, ay);
      else addPoint(0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by);
      if (!isClosed && q === segs - 1) addPoint(bx, by);
      else addPoint(0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by);
    }
    return ptCount - start;
  }

  // Curves through the midpoints of the segments (a quadratic B-spline), so
  // the lines come out smooth like the old static paths.
  function traceSmooth(line) {
    const s = line.start;
    const n = line.count;
    if (line.closed) {
      ctx.moveTo((ptX[s + n - 1] + ptX[s]) / 2, (ptY[s + n - 1] + ptY[s]) / 2);
      for (let q = 0; q < n; q++) {
        const a = s + q;
        const b = s + ((q + 1) % n);
        ctx.quadraticCurveTo(ptX[a], ptY[a], (ptX[a] + ptX[b]) / 2, (ptY[a] + ptY[b]) / 2);
      }
      ctx.closePath();
      return;
    }
    ctx.moveTo(ptX[s], ptY[s]);
    for (let q = 1; q < n - 1; q++) {
      const a = s + q;
      ctx.quadraticCurveTo(ptX[a], ptY[a], (ptX[a] + ptX[a + 1]) / 2, (ptY[a] + ptY[a + 1]) / 2);
    }
    ctx.lineTo(ptX[s + n - 1], ptY[s + n - 1]);
  }

  function lineLength(line) {
    if (line.len >= 0) return line.len;
    const s = line.start;
    const n = line.count;
    let len = 0;
    for (let q = 1; q < n; q++) len += Math.hypot(ptX[s + q] - ptX[s + q - 1], ptY[s + q] - ptY[s + q - 1]);
    if (line.closed) len += Math.hypot(ptX[s] - ptX[s + n - 1], ptY[s] - ptY[s + n - 1]);
    line.len = len;
    return len;
  }

  // ---------- The gold currents ----------
  // Each current follows one line on one level. Every frame it looks for the
  // line on the same level that still runs through most of the points it had
  // last frame, so it never hops to another line. If its line shrinks away or
  // can't be found, it fades out where it is and a new one fades in on the
  // longest free line.

  function updateCurrents(dt, instant) {
    // A phone-sized canvas gets at most two, so it doesn't look busy.
    const want = cssW < 600 ? Math.min(2, wantCurrents) : wantCurrents;
    if (want === 0 || currentLevels.length === 0) {
      picks = [];
      return;
    }
    const minLen = clamp(0.2 * (cssW + cssH), 180, 480);
    const tol = cellPx * 1.6;
    const candidates = lines.filter((l) => currentLevels.includes(l.level));
    for (const l of candidates) {
      lineLength(l);
      l.box = boxOf(l);
    }
    const claimed = new Set();

    // Currents that are staying get first pick of the lines.
    const order = picks.slice().sort((a, b) => b.target - a.target);
    for (const pick of order) {
      if (pick.ghost) {
        advance(pick, dt);   // an old route fading out, see adopt()
        continue;
      }
      const own = bestMatch(pick, candidates, (cand) => !claimed.has(cand), tol);
      if (own) {
        claimed.add(own);
        if (own.len < minLen * 0.55) pick.target = 0;    // shrinking away
        adopt(pick, own, dt);
        continue;
      }
      // Its line joined one another current already follows. It keeps
      // following that line while it fades out.
      const shared = bestMatch(pick, candidates, (cand) => claimed.has(cand), tol);
      pick.target = 0;
      if (shared) adopt(pick, shared, dt);
      else advance(pick, dt);                            // lost: fade out in place
    }

    for (const pick of picks) {
      const rate = pick.target ? dt / (pick.fadeInS ?? CURRENT_FADE_IN_S) : -dt / (pick.fadeOutS ?? CURRENT_FADE_OUT_S);
      pick.alpha = instant ? pick.target : clamp(pick.alpha + rate, 0, 1);
      if (pick.alpha >= 1) pick.fadeInS = undefined;
    }
    picks = picks.filter((p) => p.target || p.alpha > 0);

    newPickWait = Math.max(0, newPickWait - dt);
    let active = picks.filter((p) => p.target).length;   // ghosts never count
    const firstFill = picks.length === 0;
    while (active < want && (instant || firstFill || newPickWait <= 0)) {
      const cand = chooseNewLine(candidates, claimed, minLen, tol);
      if (!cand) break;
      claimed.add(cand);
      pickCount += 1;
      const pick = { id: pickCount, level: cand.level, target: 1, alpha: instant ? 1 : 0, anchor: null, samples: null, geo: null, offset: 0 };
      adopt(pick, cand, 0);
      picks.push(pick);
      active += 1;
      if (!instant && !firstFill) {
        newPickWait = CURRENT_NEW_EVERY_S;
        break;
      }
    }
  }

  // The line on the pick's level that runs through most of its kept points
  // (at least CURRENT_KEEP of them), the longer one on a tie.
  function bestMatch(pick, candidates, allowed, tol) {
    let best = null;
    let bestScore = 0;
    for (const cand of candidates) {
      if (cand.level !== pick.level || !allowed(cand)) continue;
      const score = overlapScore(pick.samples, cand, tol);
      if (score > bestScore + 1e-6 || (best && Math.abs(score - bestScore) <= 1e-6 && cand.len > best.len)) {
        best = cand;
        bestScore = score;
      }
    }
    return bestScore >= CURRENT_KEEP ? best : null;
  }

  // The longest free line, on the level with fewer currents first, that
  // doesn't run along a current already drawn.
  function chooseNewLine(candidates, claimed, minLen, tol) {
    const perLevel = new Map(currentLevels.map((k) => [k, 0]));
    for (const p of picks) if (p.target) perLevel.set(p.level, (perLevel.get(p.level) ?? 0) + 1);
    let best = null;
    let bestKey = -Infinity;
    for (const cand of candidates) {
      if (claimed.has(cand) || cand.len < minLen) continue;
      if (picks.some((p) => p.level === cand.level && overlapScore(p.samples, cand, tol) > 0.1)) continue;
      const key = cand.len - 1e6 * (perLevel.get(cand.level) ?? 0);
      if (key > bestKey) {
        bestKey = key;
        best = cand;
      }
    }
    return best;
  }

  function boxOf(line) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let q = line.start; q < line.start + line.count; q++) {
      if (ptX[q] < x0) x0 = ptX[q];
      if (ptX[q] > x1) x1 = ptX[q];
      if (ptY[q] < y0) y0 = ptY[q];
      if (ptY[q] > y1) y1 = ptY[q];
    }
    return [x0, y0, x1, y1];
  }

  // Share of a current's kept points that lie within tol of the line.
  function overlapScore(samples, line, tol) {
    if (!samples || samples.length === 0) return 0;
    const [x0, y0, x1, y1] = line.box;
    const tol2 = tol * tol;
    let hits = 0;
    const total = samples.length / 2;
    for (let q = 0; q < samples.length; q += 2) {
      const sx = samples[q];
      const sy = samples[q + 1];
      if (sx < x0 - tol || sx > x1 + tol || sy < y0 - tol || sy > y1 + tol) continue;
      for (let r = line.start; r < line.start + line.count; r++) {
        const dx = ptX[r] - sx;
        const dy = ptY[r] - sy;
        if (dx * dx + dy * dy <= tol2) {
          hits += 1;
          break;
        }
      }
    }
    return hits / total;
  }

  // Takes the matched line's shape, smoothed the same way the contours are
  // drawn, so the gold dashes sit right on top of the line.
  // When the line changes route in one frame (it joins up with another line
  // or splits off at a saddle as the field moves), switching shape straight
  // away would make part of the gold line jump. Instead the old shape stays
  // behind as a "ghost" that fades out while the new shape fades in, both
  // over CURRENT_SWAP_S. Smoothstep fades add up to one, so the shared part
  // of the route keeps the same strength.
  function adopt(pick, line, dt) {
    const raw = { x: ptX.subarray(line.start, line.start + line.count), y: ptY.subarray(line.start, line.start + line.count) };
    const geo = withLengths(chaikin(chaikin(raw, line.closed), line.closed), line.closed);
    if (pick.geo && pick.target && pick.alpha > 0 && routeChanged(pick.geo, geo)) {
      picks.push({
        id: pick.id, level: pick.level, ghost: true, target: 0, alpha: pick.alpha, fadeOutS: CURRENT_SWAP_S,
        geo: pick.geo, anchor: pick.anchor, samples: pick.samples, offset: pick.offset,
      });
      pick.alpha = 0;
      pick.fadeInS = CURRENT_SWAP_S;
    }
    pick.geo = geo;
    advance(pick, dt);
  }

  // True when more than ROUTE_CHANGE_PX of either shape is nowhere near the
  // other one.
  function routeChanged(a, b) {
    const pa = sampleEvery(a, ROUTE_STEP);
    const pb = sampleEvery(b, ROUTE_STEP);
    const off = (unmatched(pa, pb, ROUTE_STEP) + unmatched(pb, pa, ROUTE_STEP)) * ROUTE_STEP;
    return off > ROUTE_CHANGE_PX;
  }

  // The dash pattern is pinned to an anchor point that rides along the line
  // at CURRENT_SPEED, so the dashes drift but never jump when the line's
  // first point moves. A closed loop is redrawn starting at the anchor, so
  // the one spot where the pattern doesn't fit the loop length rides along
  // with the dashes too. On an open line the anchor steps back by whole dash
  // periods before it reaches the end, which the pattern can't show.
  function advance(pick, dt) {
    const g = pick.geo;
    if (!g || g.len <= 0) return;
    const period = CURRENT_DASH + CURRENT_GAP;
    let s = pick.anchor ? project(g, pick.anchor[0], pick.anchor[1]) : g.len * 0.5;
    s += CURRENT_SPEED * dt;
    if (g.closed) {
      s = ((s % g.len) + g.len) % g.len;
      pick.geo = withLengths(rotateTo(g, s), true);
      pick.offset = 0;
      s = 0;
    } else {
      const margin = Math.min(g.len * 0.25, 80);
      if (s > g.len - margin || s < margin) s -= Math.round((s - g.len / 2) / period) * period;
      s = clamp(s, 0, g.len);
      pick.offset = ((-s % period) + period) % period;
    }
    pick.anchor = pointAt(pick.geo, s);
    pick.samples = sampleAlong(pick.geo, CURRENT_SAMPLES);
  }

  // ---------- Drawing ----------

  function draw(t, dt, instant) {
    const started = performance.now();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (cssW === 0 || cssH === 0) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const swellOffset = computeField(t);
    traceLevels(swellOffset);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    ctx.strokeStyle = style.line;
    for (const index of [false, true]) {
      ctx.beginPath();
      for (const line of lines) {
        if (isIndex(line.level) !== index) continue;
        // A just-born loop on a hilltop would be a speck of dust. Skip it
        // until it's big enough to read as a ring.
        if (line.closed && line.count < 16 && lineLength(line) < 10) continue;
        traceSmooth(line);
      }
      ctx.globalAlpha = index ? style.indexAlpha : style.lineAlpha;
      ctx.lineWidth = index ? style.indexWidth : style.lineWidth;
      ctx.stroke();
    }

    updateCurrents(dt, instant);
    ctx.strokeStyle = style.current;
    ctx.lineWidth = CURRENT_WIDTH;
    ctx.setLineDash([CURRENT_DASH, CURRENT_GAP]);
    for (const pick of picks) {
      const g = pick.geo;
      if (!g || pick.alpha <= 0) continue;
      ctx.globalAlpha = style.currentAlpha * smoothstep(pick.alpha);
      ctx.lineDashOffset = pick.offset;
      ctx.beginPath();
      ctx.moveTo(g.x[0], g.y[0]);
      for (let q = 1; q < g.x.length; q++) ctx.lineTo(g.x[q], g.y[q]);
      if (g.closed) ctx.lineTo(g.x[0], g.y[0]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    frame += 1;
    if (onFrame) {
      onFrame({
        frame, t, drawMs: performance.now() - started, width: cssW, height: cssH, dpr,
        lines: lines.length,
        currents: picks.map((p) => ({ id: p.id, level: p.level, alpha: p.alpha, fading: !p.target, ghost: !!p.ghost, len: p.geo?.len ?? 0, anchor: p.anchor })),
      });
    }
  }

  // ---------- Loop ----------

  function running() {
    return !stopped && !reduced && tabVisible && onScreen && cssW > 0 && cssH > 0;
  }

  function sync() {
    if (running()) {
      if (!raf) {
        lastTick = performance.now();
        raf = requestAnimationFrame(tick);
      }
    } else if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  }

  function tick(now) {
    raf = 0;
    if (!running()) return;
    // Time only moves while drawing, and never by more than a quarter second
    // in one step, so a slow frame doesn't make the lines jump.
    animT += Math.min(0.25, Math.max(0, (now - lastTick) / 1000));
    lastTick = now;
    // Skip screen refreshes until a frame is due. A little of any overshoot
    // carries over, so 60 Hz screens get an even 20 frames a second.
    const sinceDraw = now - lastDraw;
    if (sinceDraw >= frameMs - 2) {
      const carry = sinceDraw >= frameMs && sinceDraw < 2 * frameMs ? sinceDraw - frameMs : 0;
      drawAt(animT, false);
      lastDraw = now - carry;
    }
    raf = requestAnimationFrame(tick);
  }

  function drawAt(t, instant) {
    const dt = Math.max(0, t - lastFrameT);
    lastFrameT = t;
    lastDraw = performance.now();
    draw(t, dt, instant);
  }

  // The still frame for reduced motion: the field where it is now (the
  // loop's start if the page opened with reduced motion), with the currents
  // at full strength and not moving.
  function drawStill() {
    drawAt(animT, true);
  }

  function onResize() {
    const { w, h } = measure();
    if (!resizeTo(w, h)) return;
    // A size change clears the canvas, so draw straight away rather than
    // leaving it blank until the next tick.
    if (reduced) drawStill();
    else drawAt(animT, false);
    sync();
  }

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(onResize) : null;
  resizeObserver?.observe(canvas);
  const onWindowResize = () => onResize();
  if (!resizeObserver) window.addEventListener('resize', onWindowResize);

  const intersectionObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) onScreen = last.isIntersecting;
      sync();
    })
    : null;
  intersectionObserver?.observe(canvas);

  const onVisibility = () => {
    tabVisible = document.visibilityState !== 'hidden';
    sync();
  };
  document.addEventListener('visibilitychange', onVisibility);

  const motionQuery = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  reduced = motionQuery?.matches ?? false;
  const onMotionChange = () => {
    const was = reduced;
    reduced = motionQuery.matches;
    if (reduced && !was) {
      sync();         // stops the loop
      drawStill();    // and settles on one still frame
    } else if (!reduced && was) {
      sync();
    }
  };
  if (motionQuery?.addEventListener) motionQuery.addEventListener('change', onMotionChange);
  else motionQuery?.addListener?.(onMotionChange);

  // First frame right away, if the canvas already has a size.
  {
    const { w, h } = measure();
    resizeTo(w, h);
    if (cssW > 0 && cssH > 0) {
      if (reduced) drawStill();
      else drawAt(animT, false);
    }
    sync();
  }

  return function stop() {
    if (stopped) return;
    stopped = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    resizeObserver?.disconnect();
    if (!resizeObserver) window.removeEventListener('resize', onWindowResize);
    intersectionObserver?.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    if (motionQuery?.removeEventListener) motionQuery.removeEventListener('change', onMotionChange);
    else motionQuery?.removeListener?.(onMotionChange);
  };
}

// ---------- Helpers ----------

function numberOr(value, fallback) {
  const n = Number(value);
  return value != null && Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(a) {
  return a * a * (3 - 2 * a);
}

// How big the hills are, in CSS px. Set from the width only, so a phone's
// address bar showing or hiding (a height change) doesn't rescale the lines.
function featureSizeFor(width) {
  return clamp(width * 0.32, 250, 480);
}

// Marching squares. Corners: 0 top left, 1 top right, 2 bottom right,
// 3 bottom left. Sides: 0 top, 1 right, 2 bottom, 3 left. A corner counts
// as high when it is above the level. Each segment goes from side a to
// side b with the high ground on its left, so every line runs the same way
// round the hills and the gold dashes never flip direction.
const CASES = buildCases();
const SADDLES = {
  // Corners 0 and 2 high. Center low: two lines cut off the high corners.
  // Center high: two lines cut off the low corners 1 and 3.
  5: [[3, 0, 1, 2], [1, 0, 3, 2]],
  // Corners 1 and 3 high.
  10: [[0, 1, 2, 3], [0, 3, 2, 1]],
};

function buildCases() {
  const cases = [];
  for (let kind = 0; kind < 16; kind++) {
    const high = [kind & 1, kind & 2, kind & 4, kind & 8].map(Boolean);
    // Walking clockwise round the cell, side n runs from corner n to corner
    // n + 1. The segment starts on the side that goes low to high and ends
    // on the side that goes high to low.
    let from = -1;
    let to = -1;
    for (let side = 0; side < 4; side++) {
      const a = high[side];
      const b = high[(side + 1) % 4];
      if (!a && b) from = side;
      if (a && !b) to = side;
    }
    cases.push(kind === 0 || kind === 15 || kind === 5 || kind === 10 ? [] : [from, to]);
  }
  return cases;
}

// Corner cutting. Two passes of this follow the same curve the contours are
// drawn with, as straight pieces whose lengths are easy to measure.
function chaikin(pts, closed) {
  const n = pts.x.length;
  if (n < 3) return { x: Float32Array.from(pts.x), y: Float32Array.from(pts.y) };
  const segs = closed ? n : n - 1;
  const x = new Float32Array(segs * 2);
  const y = new Float32Array(segs * 2);
  let o = 0;
  for (let q = 0; q < segs; q++) {
    const ax = pts.x[q];
    const ay = pts.y[q];
    const bx = pts.x[(q + 1) % n];
    const by = pts.y[(q + 1) % n];
    if (!closed && q === 0) {
      x[o] = ax; y[o] = ay; o += 1;
    } else {
      x[o] = 0.75 * ax + 0.25 * bx; y[o] = 0.75 * ay + 0.25 * by; o += 1;
    }
    if (!closed && q === segs - 1) {
      x[o] = bx; y[o] = by; o += 1;
    } else {
      x[o] = 0.25 * ax + 0.75 * bx; y[o] = 0.25 * ay + 0.75 * by; o += 1;
    }
  }
  return { x, y };
}

function withLengths(pts, closed) {
  const n = pts.x.length;
  const cum = new Float32Array(n + 1);
  for (let q = 1; q < n; q++) cum[q] = cum[q - 1] + Math.hypot(pts.x[q] - pts.x[q - 1], pts.y[q] - pts.y[q - 1]);
  cum[n] = closed && n > 1 ? cum[n - 1] + Math.hypot(pts.x[0] - pts.x[n - 1], pts.y[0] - pts.y[n - 1]) : cum[n - 1];
  return { x: pts.x, y: pts.y, cum, closed, len: cum[n] };
}

// Distance along the line to the point on it nearest (px, py).
function project(g, px, py) {
  const n = g.x.length;
  const segs = g.closed ? n : n - 1;
  let bestD = Infinity;
  let bestS = 0;
  for (let q = 0; q < segs; q++) {
    const ax = g.x[q];
    const ay = g.y[q];
    const b = (q + 1) % n;
    const dx = g.x[b] - ax;
    const dy = g.y[b] - ay;
    const l2 = dx * dx + dy * dy;
    let u = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const ex = ax + u * dx - px;
    const ey = ay + u * dy - py;
    const d = ex * ex + ey * ey;
    if (d < bestD) {
      bestD = d;
      bestS = g.cum[q] + u * (g.cum[q + 1] - g.cum[q]);
    }
  }
  return bestS;
}

function segmentAt(g, s) {
  let lo = 0;
  let hi = g.x.length - (g.closed ? 0 : 1);
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (g.cum[mid] <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}

function pointAt(g, s) {
  const n = g.x.length;
  if (n === 1) return [g.x[0], g.y[0]];
  const q = segmentAt(g, s);
  const b = (q + 1) % n;
  const segLen = g.cum[q + 1] - g.cum[q];
  const u = segLen > 0 ? clamp((s - g.cum[q]) / segLen, 0, 1) : 0;
  return [g.x[q] + u * (g.x[b] - g.x[q]), g.y[q] + u * (g.y[b] - g.y[q])];
}

// A closed loop redrawn to start at distance s.
function rotateTo(g, s) {
  const n = g.x.length;
  const q = segmentAt(g, s);
  const [sx, sy] = pointAt(g, s);
  const x = new Float32Array(n + 1);
  const y = new Float32Array(n + 1);
  x[0] = sx;
  y[0] = sy;
  for (let r = 1; r <= n; r++) {
    const idx = (q + r) % n;
    x[r] = g.x[idx];
    y[r] = g.y[idx];
  }
  return { x, y };
}

function sampleEvery(g, step) {
  return sampleAlong(g, Math.max(1, Math.ceil(g.len / step)));
}

// How many of the points in a have no point of b within tol.
function unmatched(a, b, tol) {
  const tol2 = tol * tol;
  let misses = 0;
  for (let q = 0; q < a.length; q += 2) {
    let hit = false;
    for (let r = 0; r < b.length; r += 2) {
      const dx = a[q] - b[r];
      const dy = a[q + 1] - b[r + 1];
      if (dx * dx + dy * dy <= tol2) {
        hit = true;
        break;
      }
    }
    if (!hit) misses += 1;
  }
  return misses;
}

function sampleAlong(g, count) {
  const out = new Float32Array(count * 2);
  for (let q = 0; q < count; q++) {
    const [x, y] = pointAt(g, (g.len * (q + 0.5)) / count);
    out[q * 2] = x;
    out[q * 2 + 1] = y;
  }
  return out;
}

// ---------- Noise ----------
// 4D simplex noise (after Stefan Gustavson's public domain version) with a
// seeded permutation table, so the same seed always gives the same sea
// floor. Returns roughly -1 to 1.

function makeSimplex4(seed) {
  const F4 = (Math.sqrt(5) - 1) / 4;
  const G4 = (5 - Math.sqrt(5)) / 20;
  const GRAD = new Int8Array([
    0, 1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1,
    0, -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1,
    1, 0, 1, 1, 1, 0, 1, -1, 1, 0, -1, 1, 1, 0, -1, -1,
    -1, 0, 1, 1, -1, 0, 1, -1, -1, 0, -1, 1, -1, 0, -1, -1,
    1, 1, 0, 1, 1, 1, 0, -1, 1, -1, 0, 1, 1, -1, 0, -1,
    -1, 1, 0, 1, -1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, -1,
    1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1, 0,
    -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1, 0,
  ]);

  // Seeded shuffle of 0 to 255 (mulberry32).
  let state = (seed + 0x6d2b79f5) >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let r = state;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  const p = new Uint8Array(256);
  for (let q = 0; q < 256; q++) p[q] = q;
  for (let q = 255; q > 0; q--) {
    const r = Math.floor(random() * (q + 1));
    const tmp = p[q];
    p[q] = p[r];
    p[r] = tmp;
  }
  const perm = new Uint8Array(512);
  const grad = new Uint8Array(512);   // gradient number times 4
  for (let q = 0; q < 512; q++) {
    perm[q] = p[q & 255];
    grad[q] = (perm[q] % 32) * 4;
  }

  function corner(gi, x, y, z, w) {
    let t = 0.6 - x * x - y * y - z * z - w * w;
    if (t < 0) return 0;
    t *= t;
    return t * t * (GRAD[gi] * x + GRAD[gi + 1] * y + GRAD[gi + 2] * z + GRAD[gi + 3] * w);
  }

  return function noise4(x, y, z, w) {
    const s = (x + y + z + w) * F4;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const l = Math.floor(w + s);
    const t = (i + j + k + l) * G4;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);
    const w0 = w - (l - t);

    // Which of the 24 simplices we're in, from how the four offsets rank.
    let rx = 0;
    let ry = 0;
    let rz = 0;
    let rw = 0;
    if (x0 > y0) rx++; else ry++;
    if (x0 > z0) rx++; else rz++;
    if (x0 > w0) rx++; else rw++;
    if (y0 > z0) ry++; else rz++;
    if (y0 > w0) ry++; else rw++;
    if (z0 > w0) rz++; else rw++;
    const i1 = rx >= 3 ? 1 : 0; const j1 = ry >= 3 ? 1 : 0; const k1 = rz >= 3 ? 1 : 0; const l1 = rw >= 3 ? 1 : 0;
    const i2 = rx >= 2 ? 1 : 0; const j2 = ry >= 2 ? 1 : 0; const k2 = rz >= 2 ? 1 : 0; const l2 = rw >= 2 ? 1 : 0;
    const i3 = rx >= 1 ? 1 : 0; const j3 = ry >= 1 ? 1 : 0; const k3 = rz >= 1 ? 1 : 0; const l3 = rw >= 1 ? 1 : 0;

    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    const ll = l & 255;
    const n0 = corner(grad[ii + perm[jj + perm[kk + perm[ll]]]],
      x0, y0, z0, w0);
    const n1 = corner(grad[ii + i1 + perm[jj + j1 + perm[kk + k1 + perm[ll + l1]]]],
      x0 - i1 + G4, y0 - j1 + G4, z0 - k1 + G4, w0 - l1 + G4);
    const n2 = corner(grad[ii + i2 + perm[jj + j2 + perm[kk + k2 + perm[ll + l2]]]],
      x0 - i2 + 2 * G4, y0 - j2 + 2 * G4, z0 - k2 + 2 * G4, w0 - l2 + 2 * G4);
    const n3 = corner(grad[ii + i3 + perm[jj + j3 + perm[kk + k3 + perm[ll + l3]]]],
      x0 - i3 + 3 * G4, y0 - j3 + 3 * G4, z0 - k3 + 3 * G4, w0 - l3 + 3 * G4);
    const n4 = corner(grad[ii + 1 + perm[jj + 1 + perm[kk + 1 + perm[ll + 1]]]],
      x0 - 1 + 4 * G4, y0 - 1 + 4 * G4, z0 - 1 + 4 * G4, w0 - 1 + 4 * G4);
    return 27 * (n0 + n1 + n2 + n3 + n4);
  };
}
