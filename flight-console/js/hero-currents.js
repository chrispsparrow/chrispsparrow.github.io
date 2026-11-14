// hero-currents.js
// The moving ocean currents behind the landing's hero, drawn on Canvas 2D
// in the style of earth.nullschool.net. The currents are made up, not real
// data. Thousands of pale streaks ride a flow field, a soft speed color
// glows under them (blue where the water is slow, near white in the fast
// jets), and the Dogtooth tuna sits in the middle as a solid shape the water
// has to go around. The fish is never drawn as a picture of a fish. It shows
// because no streak can get into it and the fastest water hugs its outline.
//
// The page only ever calls this:
//   const stop = startCurrents(canvas, { fishSlot });
//   ...
//   stop();   // ends the loop and removes every listener and observer
// stop() leaves the last frame on screen.
//
// canvas shows the water: every frame it gets the speed colors, then the
// streaks on top with the "screen" blend (the streaks build up on a second,
// hidden canvas, black with light trails, so black adds nothing). Until the
// first frame it is plain navy (SPEED_RAMP[0]), never black. The script
// adds one more layer after it in the same parent, the fish, a still image
// it only redraws when the layout changes. The parent should be an
// absolutely placed box with overflow hidden (see the landing part of
// flight-console.css). Everything the browser has to blend each frame is
// in that one canvas, which keeps the graphics card's work small.
//
// Options (all optional):
//   fishSlot  an empty element in the hero's layout. The fish fills its box,
//             read on load and on every resize, so the page's CSS decides
//             where the fish goes and how big it is. No slot, no fish.
//   fishSrc   the tuna SVG (default: the logo's tuna, one evenodd path in a
//             1356 by 802 viewBox)
//   onFish    called with true when the currents start drawing the fish,
//             and with false when they run without it because the outline
//             didn't load in FISH_WAIT_MS or failed. The page can show a
//             plain logo in the slot while it is false. If the outline
//             arrives late, it is called with true then.
//   seed      whole number that picks the currents (1)
//   onFrame   called after every drawn frame with { frame, ms, particles,
//             width, height, dpr, fish, still } (for tests)
//
// How the water works
//   The flow comes from a stream function psi on a grid. The water moves
//   along lines of equal psi at u = dpsi/dy, v = -dpsi/dx, so it never piles
//   up or thins out anywhere. psi is the sum of
//     - three layers of smooth noise at different sizes (big loops with
//       smaller swirls inside), each sliding and changing shape slowly, and
//       turned down in "calm" patches so some water is nearly still,
//     - two meandering jets like the Gulf Stream, psi = A w tanh((n - n0) / w)
//       across a wavy center line n0,
//     - a few eddies, Gaussian vortices that drift, grow and fade.
//   A new grid is made every FIELD_STEP_S seconds, a few rows per frame, and
//   the streaks read a blend of the two grids around the current time.
//
// How the fish works (after Bridson's curl noise paper)
//   The tuna's path is filled into a mask, and everything the outside can't
//   reach from the border counts as fish, so the logo's holes (the eye, the
//   stripes) fill in solid. An exact distance transform gives d, the distance
//   to the fish. Near the fish
//     psi = ramp(d / reach) (psi - p0) + RIM w (1 - exp(-d / w))
//   where ramp goes smoothly from 0 at the edge to 1 at reach, and p0 is the
//   average psi over the fish. psi is then the same all along the edge, so
//   the outline is a streamline: water goes around the fish, never through
//   it, and stands still inside. The second term adds a fast current hugging
//   the edge, the bright rim. A streak that still ends up inside the fish
//   starts over somewhere else, and the fish layer paints the inside navy
//   with a sharp edge.
//
// Keeping the nav readable
//   The page's nav is see-through and sits over the top of the water. So
//   the water right behind it is drawn dimmer: the speed colors use only a
//   share of the real speed there and the streaks are fainter, easing back
//   to full strength a little below the nav (see NAV_FADE_START). The flow
//   itself doesn't change. The bottom edge fades a little too, so a bright
//   jet doesn't stop in a hard line where the footer starts.
//
// Keeping it light
//   At most about 60 frames a second, a particle count that scales with the
//   window, a canvas pixel ratio capped at 2 and at MAX_CANVAS_PX pixels in
//   all (the fish layer keeps the full ratio, so its edge stays sharp), and
//   the loop pauses while the tab is hidden, the hero is scrolled away or the
//   landing isn't showing. With reduced motion it draws one still frame and
//   stops (it follows that setting live). The fish mask is made once, in
//   short slices of work spread over several tasks, so the page keeps
//   answering clicks and keys while it is built.
//
// Used by: the landing's hero (js/views/launcher.js starts it). No imports.

// ------------------------------------------------------------------
// Settings worth changing
// ------------------------------------------------------------------

// How fast the streaks move through the field, as a multiplier. Bigger is
// faster and gives longer trails. It doesn't change the speed colors.
const SPEED = 1.3;
// How many streaks a 1920 by 1080 window gets. Other sizes scale from it
// (see particleCountFor).
const PARTICLE_COUNT = 9000;
// How much of every trail fades away each frame, at 60 frames a second.
// Bigger gives shorter trails.
const TRAIL_FADE = 0.06;

// Speed colors, from still water to the fastest jets, spread evenly over the
// speeds from 0 to HOT_SPEED. To compare a warm ramp (green, yellow, red),
// swap this line for:
//   const SPEED_RAMP = ['#0B1A2E', '#123F2A', '#2E8B3E', '#E3D23F', '#F08A24', '#D7301F'];
const SPEED_RAMP = ['#0B1A2E', '#12306B', '#1F5FBF', '#2FB3D9', '#9FE8F0', '#F2FBFF'];

// ------------------------------------------------------------------
// The flow, sized for a 1920 by 1080 window. Sizes are CSS px and speeds
// CSS px a second. Other windows scale both (see unitFor).
// ------------------------------------------------------------------

// Noise layers. size: how big the loops are. speed: their typical speed.
// driftX, driftY: how the pattern slides (px a second). change: how fast it
// changes shape.
const LAYERS = [
  { size: 640, speed: 95, driftX: 9, driftY: -4, change: 0.03 },
  { size: 260, speed: 62, driftX: -6, driftY: 5, change: 0.06 },
  { size: 110, speed: 30, driftX: 5, driftY: 7, change: 0.1 },
];
const CALM_SIZE = 1000;     // size of the calm and busy patches
const CALM_CHANGE = 0.02;
const CALM_FLOOR = 0.2;     // the calmest water keeps this share of its speed

// The jets. y: where the jet crosses the middle of the window, as a share of
// its height. tilt: its slope in radians (positive runs down to the right).
// speed: top speed at its center (negative flows right to left). width: its
// half width. waves: meanders along it, each { amp, length, rate } in px,
// px and radians a second. The top one is pushed down if it would come
// within TOP_CLEAR px of the top, so it never runs behind the nav links.
// Eddy centers stay at least TOP_CLEAR px plus their own size below the top
// too.
const JETS = [
  { y: 0.18, tilt: -0.03, speed: 520, width: 34, waves: [{ amp: 64, length: 1150, rate: 0.12 }, { amp: 22, length: 430, rate: -0.2 }] },
  { y: 0.91, tilt: 0.05, speed: -400, width: 28, waves: [{ amp: 46, length: 950, rate: -0.1 }, { amp: 16, length: 340, rate: 0.24 }] },
];
const TOP_CLEAR = 96;

// The water behind the nav: from the top down to NAV_FADE_START times the
// nav's height, the speed colors show NAV_SPEED_KEEP of the real speed and
// the streaks keep NAV_STREAK_KEEP of their opacity. Both ease back to full
// strength by NAV_FADE_EXTRA px below the nav. The nav's height comes from
// the page's --fc-nav-h (64px when it isn't set).
const NAV_FADE_START = 0.6;
const NAV_FADE_EXTRA = 64;
const NAV_SPEED_KEEP = 0.22;
const NAV_STREAK_KEEP = 0.3;
const NAV_H_DEFAULT = 64;
// The hero's bottom edge: over the last BOTTOM_FADE px the speed colors ease
// down to BOTTOM_SPEED_KEEP of the speed and the streaks to
// BOTTOM_STREAK_KEEP of their opacity.
const BOTTOM_FADE = 110;
const BOTTOM_SPEED_KEEP = 0.2;
const BOTTOM_STREAK_KEEP = 0.45;

const EDDY_COUNT = 6;
const EDDY_SIZE = 70;       // where an eddy spins fastest, px from its center
const EDDY_SPEED = 230;     // its top speed
const EDDY_LIFE = 26;       // seconds from appearing to gone
const EDDY_DRIFT = 12;      // px a second

// The fish, as shares of the fish's width.
const FISH_REACH = 0.17;    // how far out the fish bends the flow
const RIM_WIDTH = 0.022;    // how wide the fast current along its edge is
const RIM_SPEED = 330;      // that current's speed right at the edge
const FISH_SEAL = 5.5;      // channels in the logo narrower than twice this (in the SVG's units, the fish is 1251 wide) fill in, see solidify()
const FISH_MASK_SCALE = 1;  // the fish mask's px per SVG unit (see buildTunaMask)

// ------------------------------------------------------------------
// Drawing
// ------------------------------------------------------------------

const FIELD_CELL = 12;      // px per flow grid cell at 1920 by 1080 (8 to 16)
const FIELD_STEP_S = 0.3;   // seconds of motion between flow grids
const NOISE_SLOPE = 2.2;    // typical slope of the noise, to turn a speed into psi
const OVERLAY_CELL = 8;     // px per speed color pixel (the colors are 1/8 resolution)
const OVERLAY_BLUR = 1;     // speed color pixels of blur (two box blur passes), before scaling up
const OVERLAY_EVERY = 3;    // frames between speed color updates
const HOT_SPEED = 520;      // the speed at the end of SPEED_RAMP
const RAMP_CURVE = 1.0;     // below 1 gives the slow speeds more of the ramp
const LIFE_MIN = 0.9;       // seconds a streak lives, picked between these
const LIFE_MAX = 2.8;
const BIRTH_S = 0.18;       // a new streak fades in over this long
const LINE_WIDTH = 0.9;     // CSS px
const STREAK_RGB = '232, 237, 242';   // the theme's off-white
const STREAK_ALPHA_MIN = 0.3;         // the slowest streak's opacity
const STREAK_ALPHA_MAX = 0.95;        // the fastest streak's opacity
const ALPHA_LEVELS = 12;    // streaks are drawn in this many opacity batches
const GHOST_CUT = 6;        // 0 to 255, see fadeTrails()
const CLEAN_EVERY = 12;     // frames
const MAX_CANVAS_PX = 2.1e6; // the streaks canvas never has more device pixels than this (it costs GPU time per pixel)
const MIN_FRAME_MS = 12;    // screen refreshes closer than this are skipped (120 Hz runs at 60)
const STILL_STEPS = 14;     // the still frame's trails: this many steps
const STILL_STEP_S = 1 / 40;  // of this many seconds each

// The tuna inside its SVG: the path's bounding box in viewBox units.
const TUNA_BOX = { x: 77, y: 16, w: 1251, h: 524 };
const DEFAULT_FISH_SRC = new URL('../../assets/dogtooth_kicad_silkscreen_files/01_primary_full_logo_kicad_white_tuna.svg', import.meta.url).href;
const FISH_WAIT_MS = 1500;  // start without the fish if it takes longer than this to load
const RESIZE_WAIT_MS = 150; // see queueResize()

const REF_AREA = 1920 * 1080;
const GRID_MARGIN = 2;      // flow grid nodes beyond each edge of the window
const OVERLAY_MARGIN = 2;   // speed color pixels beyond each edge (so the edges blur like the rest)

export function startCurrents(canvas, options = {}) {
  const parent = canvas?.parentElement;
  const ctx = parent ? canvas.getContext('2d', { alpha: false }) : null;
  if (!ctx) return () => {};

  const fishSlot = options.fishSlot && typeof options.fishSlot.getBoundingClientRect === 'function' ? options.fishSlot : null;
  const fishSrc = typeof options.fishSrc === 'string' ? options.fishSrc : DEFAULT_FISH_SRC;
  const seed = Math.floor(numberOr(options.seed, 1)) >>> 0;
  const onFrame = typeof options.onFrame === 'function' ? options.onFrame : null;
  const onFish = typeof options.onFish === 'function' ? options.onFish : null;

  const noise = makeSimplex3(seed);
  const random = mulberry32(seed ^ 0x9e3779b9);
  const rampLut = buildRampLut(SPEED_RAMP, RAMP_CURVE);

  // An opaque canvas starts out black. Paint it navy at once, so the hero
  // is navy (never black) until the first frame of water.
  function paintBlank() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = SPEED_RAMP[0];
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  paintBlank();

  // ---------- Layers ----------
  // trails: hidden, the same size as canvas, opaque black with the light
  // streaks fading on it. speedLayer: hidden and small, one pixel per
  // OVERLAY_CELL px. fishLayer: shown over canvas, at the fish's box.
  const trails = document.createElement('canvas');
  const tctx = trails.getContext('2d', { alpha: false });
  const speedLayer = document.createElement('canvas');
  const speedCtx = speedLayer.getContext('2d');
  const fishLayer = document.createElement('canvas');
  fishLayer.className = 'fc-currents-fish';
  Object.assign(fishLayer.style, {
    position: 'absolute', left: '0', top: '0', display: 'none', pointerEvents: 'none',
  });
  const fishCtx = fishLayer.getContext('2d');
  if (!tctx || !speedCtx || !fishCtx) return () => {};
  canvas.after(fishLayer);

  // ---------- State ----------
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let unit = 1;

  // The dimmed bands at the top (behind the nav) and the bottom, in CSS px
  // from the top of the canvas: full dimming above topFull, none below
  // topClear, and from bottomClear down to the bottom edge it dims again.
  let topFull = 0;
  let topClear = 0;
  let bottomClear = 0;
  let overlayKeep = new Float32Array(0);   // the speed share kept on each speed color row

  // The flow grid: three grids in time (the two being blended and the next
  // one being built) and the blend the streaks read.
  let cell = FIELD_CELL;
  let invCell = 1 / cell;
  let gw = 0;
  let gh = 0;
  let grids = [];
  let curPsi = new Float32Array(0);
  let curU = new Float32Array(0);
  let curV = new Float32Array(0);
  let flow = null;         // the scaled flow settings for this window

  // The fish
  let tunaPath = null;     // Path2D in viewBox units
  let tunaMask = null;     // the solid silhouette, see buildTunaMask()
  let fishState = fishSlot ? 'loading' : 'none';   // 'loading', 'ready', 'failed' or 'none'
  let fishRectNow = null;
  let fish = null;         // the flow grid around the fish, see buildFish()

  // Streaks
  let count = 0;
  let px = new Float32Array(0);
  let py = new Float32Array(0);
  let age = new Float32Array(0);
  let life = new Float32Array(0);
  const segs = [];
  const segCount = new Int32Array(ALPHA_LEVELS);
  const levelStyles = [];
  for (let l = 0; l < ALPHA_LEVELS; l++) {
    levelStyles.push(`rgba(${STREAK_RGB}, ${(STREAK_ALPHA_MAX * (l + 1) / ALPHA_LEVELS).toFixed(3)})`);
  }

  // Speed colors
  let ow = 0;
  let oh = 0;
  let overlayImg = null;
  let blurTmp = new Uint8ClampedArray(0);
  let overlayWait = 0;

  // The velocity sample written by sampleAt().
  let su = 0;
  let sv = 0;

  // Loop
  let stopped = false;
  let reduced = false;
  let tabVisible = document.visibilityState !== 'hidden';
  let onScreen = true;     // until the first IntersectionObserver report says otherwise
  let raf = 0;
  let lastTick = 0;
  let animT = 0;           // seconds of motion so far (still while paused)
  let frameNo = 0;
  let cleanWait = 0;
  let drewOnce = false;
  let layoutQueued = 0;

  // ---------- Size ----------

  function unitFor(w, h) {
    return clamp(Math.sqrt((w * h) / REF_AREA), 0.38, 1.5);
  }

  // Keeps the streaks canvas under MAX_CANVAS_PX device pixels.
  function dprFor(w, h) {
    const want = Math.min(2, window.devicePixelRatio || 1);
    const cap = Math.sqrt(MAX_CANVAS_PX / Math.max(1, w * h));
    return Math.max(1, Math.min(want, cap));
  }

  function particleCountFor(w, h, u) {
    const n = Math.round((PARTICLE_COUNT * (w * h)) / REF_AREA / u);
    return clamp(n, 400, Math.round(PARTICLE_COUNT * 1.6));
  }

  function measure() {
    const rect = canvas.getBoundingClientRect();
    return { w: Math.max(0, Math.round(rect.width)), h: Math.max(0, Math.round(rect.height)) };
  }

  function readFishRect() {
    if (!fishSlot) return null;
    const a = fishSlot.getBoundingClientRect();
    const b = canvas.getBoundingClientRect();
    if (a.width < 24 || a.height < 10) return null;
    return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height };
  }

  // Returns true when anything changed.
  function layout() {
    const { w, h } = measure();
    if (w === 0 || h === 0) return false;   // hidden: keep everything for when it comes back
    const newDpr = dprFor(w, h);
    const sizeChanged = w !== cssW || h !== cssH || newDpr !== dpr;
    const rect = fishState === 'ready' ? readFishRect() : null;
    const fishChanged = !sameRect(rect, fishRectNow);
    if (!sizeChanged && !fishChanged) return false;
    if (sizeChanged) {
      cssW = w;
      cssH = h;
      dpr = newDpr;
      unit = unitFor(w, h);
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      paintBlank();
      trails.width = canvas.width;
      trails.height = canvas.height;
      setupBands();
      setupFlow();
      setupOverlay();
      setupParticles();
    }
    fishRectNow = rect;
    buildFish(rect);
    blendFlow(animT);
    updateP0();
    for (let i = 0; i < count; i++) {
      if (insideFish(px[i], py[i])) respawn(i, true);
    }
    return true;
  }

  // ---------- The dimmed bands ----------

  function setupBands() {
    // --fc-nav-h is a plain custom property, so it comes back as written:
    // px, or rem (times the root font size).
    const raw = getComputedStyle(canvas).getPropertyValue('--fc-nav-h').trim();
    let navH = parseFloat(raw);
    if (/rem$/.test(raw)) navH *= parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    if (!Number.isFinite(navH) || navH <= 0) navH = NAV_H_DEFAULT;
    topFull = navH * NAV_FADE_START;
    topClear = navH + NAV_FADE_EXTRA;
    bottomClear = cssH - Math.min(BOTTOM_FADE, cssH * 0.15);
  }

  // How much of the water's strength shows at height y: 1 in the open
  // water, down to topKeep behind the nav and bottomKeep at the bottom
  // edge, with a smooth step between.
  function bandKeep(y, topKeep, bottomKeep) {
    if (y < topClear) {
      if (y <= topFull) return topKeep;
      const t = (y - topFull) / (topClear - topFull);
      return topKeep + (1 - topKeep) * t * t * (3 - 2 * t);
    }
    if (y > bottomClear) {
      const t = Math.min(1, (y - bottomClear) / (cssH - bottomClear));
      return 1 - (1 - bottomKeep) * t * t * (3 - 2 * t);
    }
    return 1;
  }

  // ---------- The flow ----------

  function setupFlow() {
    cell = clamp(Math.round(FIELD_CELL * unit), 8, 16);
    invCell = 1 / cell;
    gw = Math.ceil(cssW / cell) + 1 + 2 * GRID_MARGIN;
    gh = Math.ceil(cssH / cell) + 1 + 2 * GRID_MARGIN;
    const n = gw * gh;
    grids = [0, 1, 2].map((q) => ({
      t: animT + q * FIELD_STEP_S, rows: 0, done: false, frame: null,
      psi: new Float32Array(n), u: new Float32Array(n), v: new Float32Array(n),
    }));
    curPsi = new Float32Array(n);
    curU = new Float32Array(n);
    curV = new Float32Array(n);

    const u = unit;
    // Each noise layer's psi is speed * size / NOISE_SLOPE times noise of
    // (position / size), so its speed comes out near the speed asked for.
    flow = {
      layers: LAYERS.map((l, q) => ({
        k: 1 / (l.size * u),
        amp: (l.speed * u * l.size * u) / NOISE_SLOPE,
        driftX: l.driftX * u,
        driftY: l.driftY * u,
        change: l.change,
        z: 13.7 * (q + 1),
      })),
      calmK: 1 / (CALM_SIZE * u),
      jets: JETS.map((j, q) => {
        const cx = cssW * 0.5;
        // How far the center line can rise above cy: its waves, plus its
        // tilt across half the window.
        const rise = j.waves.reduce((sum, wv) => sum + wv.amp * u, 0) + Math.abs(Math.sin(j.tilt)) * cssW * 0.5;
        const cy = j.y < 0.5 ? Math.max(cssH * j.y, TOP_CLEAR + j.width * u + rise) : cssH * j.y;
        return {
          cx, cy, cos: Math.cos(j.tilt), sin: Math.sin(j.tilt),
          aw: j.speed * u * j.width * u,       // A w: top speed times half width
          invW: 1 / (j.width * u),
          waves: j.waves.map((wv, r) => ({
            amp: wv.amp * u, k: (Math.PI * 2) / (wv.length * u), rate: wv.rate, phase: 1.7 * q + 2.9 * r + seed,
          })),
          // The jet's strength rises and falls along it, slowly.
          pulseK: (Math.PI * 2) / (1400 * u), pulsePhase: 0.8 * q + seed,
        };
      }),
    };
    for (const g of grids.slice(0, 2)) buildGrid(g, gh);
  }

  // The time-dependent parts of the flow at time t, worked out once per grid.
  function frameAt(t) {
    const layers = flow.layers.map((l) => ({
      k: l.k, amp: l.amp, ox: -l.driftX * t, oy: -l.driftY * t, z: l.z + l.change * t,
    }));
    const jets = flow.jets.map((j) => ({
      ...j,
      waves: j.waves.map((wv) => ({ amp: wv.amp, k: wv.k, off: wv.phase + wv.rate * t })),
      pulseOff: j.pulsePhase - 0.06 * t,
    }));
    return { layers, jets, eddies: eddiesAt(t), calmZ: 91.3 + CALM_CHANGE * t };
  }

  // Each eddy lives EDDY_LIFE seconds (a little more or less), grows and
  // fades with sin^2, and drifts in a straight line, then comes back
  // somewhere else. Everything comes from its number and its life count, so
  // the same time always gives the same eddies.
  function eddiesAt(t) {
    const out = [];
    const u = unit;
    for (let e = 0; e < EDDY_COUNT; e++) {
      const span = EDDY_LIFE * (0.75 + 0.5 * hash01(e, 0, seed));
      const phase = t / span + hash01(e, 1, seed);
      const round = Math.floor(phase);
      const f = phase - round;
      const strength = Math.sin(Math.PI * f) ** 2;
      if (strength < 0.01) continue;
      const hx = hash01(e, round * 7 + 2, seed);
      const hy = hash01(e, round * 7 + 3, seed);
      const ha = hash01(e, round * 7 + 4, seed) * Math.PI * 2;
      const hs = hash01(e, round * 7 + 5, seed);
      const size = EDDY_SIZE * u * (0.7 + 0.6 * hs);
      const drift = EDDY_DRIFT * u * span * f;
      const sign = hash01(e, round * 7 + 6, seed) < 0.5 ? -1 : 1;
      // psi0 exp(-r^2 / 2 s^2) spins fastest at r = s, at psi0 e^-0.5 / s.
      // Its fastest ring never comes above TOP_CLEAR, behind the nav.
      out.push({
        x: (0.04 + 0.92 * hx) * cssW + Math.cos(ha) * drift,
        y: Math.max(TOP_CLEAR + size, (0.04 + 0.92 * hy) * cssH + Math.sin(ha) * drift),
        psi0: (sign * strength * EDDY_SPEED * u * size) / 0.6065,
        inv2s2: 1 / (2 * size * size),
        reach2: 9 * size * size,
      });
    }
    return out;
  }

  function psiAt(x, y, fr) {
    // Noise layers, turned down in calm patches.
    let p = 0;
    const ls = fr.layers;
    for (let q = 0; q < ls.length; q++) {
      const l = ls[q];
      p += l.amp * noise((x + l.ox) * l.k, (y + l.oy) * l.k, l.z);
    }
    let calm = (noise(x * flow.calmK + 5.1, y * flow.calmK - 3.7, fr.calmZ) + 0.2) / 0.75;
    calm = calm <= 0 ? 0 : calm >= 1 ? 1 : calm * calm * (3 - 2 * calm);
    p *= CALM_FLOOR + (1 - CALM_FLOOR) * calm;

    // Jets
    const js = fr.jets;
    for (let q = 0; q < js.length; q++) {
      const j = js[q];
      const dx = x - j.cx;
      const dy = y - j.cy;
      const s = dx * j.cos + dy * j.sin;
      let n = -dx * j.sin + dy * j.cos;
      for (let r = 0; r < j.waves.length; r++) {
        const wv = j.waves[r];
        n -= wv.amp * Math.sin(wv.k * s + wv.off);
      }
      const pulse = 0.72 + 0.28 * Math.sin(j.pulseK * s + j.pulseOff);
      p += j.aw * pulse * Math.tanh(n * j.invW);
    }

    // Eddies
    const es = fr.eddies;
    for (let q = 0; q < es.length; q++) {
      const e = es[q];
      const dx = x - e.x;
      const dy = y - e.y;
      const r2 = dx * dx + dy * dy;
      if (r2 < e.reach2) p += e.psi0 * Math.exp(-r2 * e.inv2s2);
    }
    return p;
  }

  // Fills rows [g.rows, toRow) of a grid's psi, and its velocity once all
  // rows are in.
  function buildGrid(g, toRow) {
    if (!g.frame) g.frame = frameAt(g.t);
    const fr = g.frame;
    const psi = g.psi;
    for (let j = g.rows; j < toRow; j++) {
      const y = (j - GRID_MARGIN) * cell;
      const row = j * gw;
      for (let i = 0; i < gw; i++) psi[row + i] = psiAt((i - GRID_MARGIN) * cell, y, fr);
    }
    g.rows = Math.max(g.rows, toRow);
    if (g.rows >= gh && !g.done) {
      velocityOf(g);
      g.done = true;
    }
  }

  // u = dpsi/dy, v = -dpsi/dx, by central differences (one-sided at the edges).
  function velocityOf(g) {
    const { psi, u, v } = g;
    for (let j = 0; j < gh; j++) {
      const jm = j > 0 ? j - 1 : j;
      const jp = j < gh - 1 ? j + 1 : j;
      const sy = 1 / ((jp - jm) * cell);
      for (let i = 0; i < gw; i++) {
        const im = i > 0 ? i - 1 : i;
        const ip = i < gw - 1 ? i + 1 : i;
        const k = j * gw + i;
        u[k] = (psi[jp * gw + i] - psi[jm * gw + i]) * sy;
        v[k] = -(psi[j * gw + ip] - psi[j * gw + im]) / ((ip - im) * cell);
      }
    }
  }

  // Moves the grids along to time t: builds a share of the next grid's rows
  // each frame, so it is ready before it is needed.
  function advanceFlow(t) {
    while (t >= grids[1].t) {
      const next = grids[2];
      buildGrid(next, gh);
      const old = grids[0];
      grids = [grids[1], next, old];
      old.t = next.t + FIELD_STEP_S;
      old.rows = 0;
      old.done = false;
      old.frame = null;
    }
    const f = (t - grids[0].t) / FIELD_STEP_S;
    const want = Math.min(gh, Math.ceil(gh * Math.min(1, f / 0.75)));
    if (grids[2].rows < want) buildGrid(grids[2], want);
  }

  function blendFlow(t) {
    const a = grids[0];
    const b = grids[1];
    const f = clamp((t - a.t) / (b.t - a.t), 0, 1);
    const n = curPsi.length;
    for (let k = 0; k < n; k++) {
      curPsi[k] = a.psi[k] + f * (b.psi[k] - a.psi[k]);
      curU[k] = a.u[k] + f * (b.u[k] - a.u[k]);
      curV[k] = a.v[k] + f * (b.v[k] - a.v[k]);
    }
  }

  // Writes the velocity at (x, y) to su, sv. Returns true when the point is
  // inside the fish (and leaves su, sv at 0).
  function sampleAt(x, y) {
    let gx = x * invCell + GRID_MARGIN;
    let gy = y * invCell + GRID_MARGIN;
    if (gx < 0) gx = 0; else if (gx > gw - 1.001) gx = gw - 1.001;
    if (gy < 0) gy = 0; else if (gy > gh - 1.001) gy = gh - 1.001;
    const i = gx | 0;
    const j = gy | 0;
    const fx = gx - i;
    const fy = gy - j;
    const k = j * gw + i;
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    let u = curU[k] * w00 + curU[k + 1] * w10 + curU[k + gw] * w01 + curU[k + gw + 1] * w11;
    let v = curV[k] * w00 + curV[k + 1] * w10 + curV[k + gw] * w01 + curV[k + gw + 1] * w11;

    const f = fish;
    if (f !== null && x > f.x0 && x < f.x1 && y > f.y0 && y < f.y1) {
      const ax = (x - f.x0) * f.inv;
      const ay = (y - f.y0) * f.inv;
      const cols = f.cols;
      if (f.mask[((ay + 0.5) | 0) * cols + ((ax + 0.5) | 0)]) {
        su = 0;
        sv = 0;
        return true;
      }
      const fi = ax | 0;
      const fj = ay | 0;
      const ex = ax - fi;
      const ey = ay - fj;
      const fk = fj * cols + fi;
      const e00 = (1 - ex) * (1 - ey);
      const e10 = ex * (1 - ey);
      const e01 = (1 - ex) * ey;
      const e11 = ex * ey;
      const dist = f.dist;
      const d = dist[fk] * e00 + dist[fk + 1] * e10 + dist[fk + cols] * e01 + dist[fk + cols + 1] * e11;
      const ddx = f.gx[fk] * e00 + f.gx[fk + 1] * e10 + f.gx[fk + cols] * e01 + f.gx[fk + cols + 1] * e11;
      const ddy = f.gy[fk] * e00 + f.gy[fk + 1] * e10 + f.gy[fk + cols] * e01 + f.gy[fk + cols + 1] * e11;
      const p = curPsi[k] * w00 + curPsi[k + 1] * w10 + curPsi[k + gw] * w01 + curPsi[k + gw + 1] * w11 - f.p0;
      const r = d * f.invReach;
      let ramp = 1;
      let dramp = 0;
      if (r < 1) {
        const r2 = r * r;
        ramp = r * (1.875 - r2 * (1.25 - 0.375 * r2));
        const q = 1 - r2;
        dramp = 1.875 * q * q * f.invReach;
      }
      // psi = ramp (psi - p0) + rim w (1 - exp(-d / w)), differentiated.
      const along = p * dramp + f.rim * Math.exp(-d * f.invRimW);
      u = ramp * u + along * ddy;
      v = ramp * v - along * ddx;
    }
    su = u;
    sv = v;
    return false;
  }

  // ---------- The fish ----------

  function insideFish(x, y) {
    const f = fish;
    if (f === null || !(x > f.x0 && x < f.x1 && y > f.y0 && y < f.y1)) return false;
    return f.mask[(((y - f.y0) * f.inv + 0.5) | 0) * f.cols + (((x - f.x0) * f.inv + 0.5) | 0)] === 1;
  }

  // The solid silhouette, made once and kept: 1 for fish, 0 for water, at
  // FISH_MASK_SCALE px per SVG unit with a 2 px border. The path is filled
  // with the evenodd rule, so the logo's holes come out empty, then
  // solidify() decides what is fish. Below 1 px per unit the logo's
  // thinnest lines blur away and the fill would leak through them, so it
  // never follows the screen's size. "inner" is the fish less a 1 px rim,
  // drawn navy into its own small canvas: the fish layer lays it under the
  // path's sharp edge, so the layer is solid even where the logo has holes.
  // The work is cut into short slices (see runInSlices), and the promise
  // ends with the mask, or undefined if stop() came first.
  function buildTunaMask() {
    const s = FISH_MASK_SCALE;
    const pad = 2;
    const W = Math.ceil(TUNA_BOX.w * s) + 2 * pad;
    const H = Math.ceil(TUNA_BOX.h * s) + 2 * pad;
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const octx = off.getContext('2d', { willReadFrequently: true });
    octx.setTransform(s, 0, 0, s, pad - TUNA_BOX.x * s, pad - TUNA_BOX.y * s);
    octx.fillStyle = '#fff';
    octx.fill(tunaPath, 'evenodd');
    const alpha = octx.getImageData(0, 0, W, H).data;
    return runInSlices(function* steps() {
      const solid = yield* solidify(alpha, W, H, FISH_SEAL * s);
      const inner = new Uint8Array(W * H);
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          const p = y * W + x;
          inner[p] = solid[p] & solid[p - 1] & solid[p + 1] & solid[p - W] & solid[p + W]
            & solid[p - W - 1] & solid[p - W + 1] & solid[p + W - 1] & solid[p + W + 1];
        }
      }
      yield;
      // The same off-screen canvas, reused for the navy inner shape.
      octx.setTransform(1, 0, 0, 1, 0, 0);
      const img = octx.createImageData(W, H);
      const [r, g, b] = hexToRgb(SPEED_RAMP[0]);
      const d = img.data;
      for (let p = 0, o = 0; p < W * H; p++, o += 4) {
        if (!inner[p]) continue;
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
        d[o + 3] = 255;
      }
      octx.putImageData(img, 0, 0);
      return { W, H, s, pad, solid, innerCanvas: off };
    }(), () => stopped);
  }

  // rect is the fish slot's box in CSS px, relative to the canvas.
  function buildFish(rect) {
    if (!tunaPath || !tunaMask || !rect) {
      fish = null;
      fishLayer.style.display = 'none';
      return;
    }
    const tm = tunaMask;
    const mx = (tm.s * TUNA_BOX.w) / rect.w;   // mask px per CSS px, across
    const my = (tm.s * TUNA_BOX.h) / rect.h;   // and down

    // 1. The fish layer, at the screen's full resolution with a 2 CSS px
    //    border: the inner shape scaled up, then the path filled navy (the
    //    slowest speed color) over it. The path keeps its own soft edge
    //    pixels, so the outline is sharp and smooth, and the inner shape
    //    fills the holes inside.
    const fdpr = Math.min(3, window.devicePixelRatio || 1);
    const LW = Math.ceil((rect.w + 4) * fdpr);
    const LH = Math.ceil((rect.h + 4) * fdpr);
    const sx = (rect.w * fdpr) / TUNA_BOX.w;
    const sy = (rect.h * fdpr) / TUNA_BOX.h;
    fishLayer.width = LW;
    fishLayer.height = LH;
    // In SVG units from here: the mask's pixel (0, 0) sits pad / s units
    // up and left of the tuna's box.
    fishCtx.setTransform(sx, 0, 0, sy, 2 * fdpr - TUNA_BOX.x * sx, 2 * fdpr - TUNA_BOX.y * sy);
    fishCtx.imageSmoothingEnabled = true;
    fishCtx.drawImage(tm.innerCanvas, TUNA_BOX.x - tm.pad / tm.s, TUNA_BOX.y - tm.pad / tm.s, tm.W / tm.s, tm.H / tm.s);
    fishCtx.fillStyle = SPEED_RAMP[0];
    fishCtx.fill(tunaPath, 'evenodd');
    fishCtx.setTransform(1, 0, 0, 1, 0, 0);
    Object.assign(fishLayer.style, {
      display: 'block',
      left: `${rect.x - 2}px`,
      top: `${rect.y - 2}px`,
      width: `${LW / fdpr}px`,
      height: `${LH / fdpr}px`,
    });

    // 2. The flow grid around the fish: a node every fc px, out to reach
    //    past the fish on every side.
    const fc = clamp(rect.w / 420, 1, 2.5);
    const reach = FISH_REACH * rect.w;
    const rimW = Math.max(3, RIM_WIDTH * rect.w);
    const margin = reach + 2 * fc;
    const x0 = rect.x - margin;
    const y0 = rect.y - margin;
    const cols = Math.ceil((rect.w + 2 * margin) / fc) + 1;
    const rows = Math.ceil((rect.h + 2 * margin) / fc) + 1;
    const n = cols * rows;
    const mask = new Uint8Array(n);
    for (let j = 0; j < rows; j++) {
      const sy2 = Math.floor((y0 + j * fc - rect.y) * my + tm.pad);
      if (sy2 < 0 || sy2 >= tm.H) continue;
      for (let i = 0; i < cols; i++) {
        const sx2 = Math.floor((x0 + i * fc - rect.x) * mx + tm.pad);
        if (sx2 >= 0 && sx2 < tm.W) mask[j * cols + i] = tm.solid[sy2 * tm.W + sx2];
      }
    }
    const d2 = distanceSquared(mask, cols, rows);
    const dist = new Float32Array(n);
    for (let q = 0; q < n; q++) dist[q] = mask[q] ? 0 : Math.max(0, Math.sqrt(d2[q]) - 0.5) * fc;
    // The distance's slope, by central differences. Where it is clear which
    // way is "away from the fish", it is made exactly 1 long, so the rim
    // current keeps its full speed right at the edge.
    const gx = new Float32Array(n);
    const gy = new Float32Array(n);
    for (let j = 0; j < rows; j++) {
      const jm = j > 0 ? j - 1 : j;
      const jp = j < rows - 1 ? j + 1 : j;
      for (let i = 0; i < cols; i++) {
        const im = i > 0 ? i - 1 : i;
        const ip = i < cols - 1 ? i + 1 : i;
        const k = j * cols + i;
        let ax = (dist[j * cols + ip] - dist[j * cols + im]) / ((ip - im) * fc);
        let ay = (dist[jp * cols + i] - dist[jm * cols + i]) / ((jp - jm) * fc);
        const len = Math.hypot(ax, ay);
        if (len > 0.5) {
          ax /= len;
          ay /= len;
        }
        gx[k] = ax;
        gy[k] = ay;
      }
    }

    // Points inside the fish's box where p0 (the average psi) is measured.
    const p0At = [];
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 7; i++) p0At.push(rect.x + ((i + 0.5) / 7) * rect.w, rect.y + ((j + 0.5) / 3) * rect.h);
    }

    fish = {
      x0, y0, x1: x0 + (cols - 1) * fc, y1: y0 + (rows - 1) * fc, inv: 1 / fc, cols, rows,
      mask, dist, gx, gy, invReach: 1 / reach, rim: RIM_SPEED * unit, invRimW: 1 / rimW, p0: 0, p0At,
    };
  }

  // p0: the base flow's psi averaged over the fish, so the fish doesn't
  // spin the water around itself (only the rim current does).
  function updateP0() {
    if (!fish) return;
    const pts = fish.p0At;
    let sum = 0;
    for (let q = 0; q < pts.length; q += 2) {
      let gx = pts[q] * invCell + GRID_MARGIN;
      let gy = pts[q + 1] * invCell + GRID_MARGIN;
      gx = clamp(gx, 0, gw - 1.001);
      gy = clamp(gy, 0, gh - 1.001);
      const i = gx | 0;
      const j = gy | 0;
      const fx = gx - i;
      const fy = gy - j;
      const k = j * gw + i;
      sum += (curPsi[k] * (1 - fx) + curPsi[k + 1] * fx) * (1 - fy) + (curPsi[k + gw] * (1 - fx) + curPsi[k + gw + 1] * fx) * fy;
    }
    fish.p0 = sum / (pts.length / 2);
  }

  // ---------- Streaks ----------

  function setupParticles() {
    count = particleCountFor(cssW, cssH, unit);
    px = new Float32Array(count);
    py = new Float32Array(count);
    age = new Float32Array(count);
    life = new Float32Array(count);
    // Room for every streak's piece in every batch. pushSegment() makes
    // more room if the still frame needs it.
    for (let l = 0; l < ALPHA_LEVELS; l++) segs[l] = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) respawn(i, true);
  }

  // A new streak somewhere in the water. "anyAge" gives it a random age, so
  // a whole batch of new streaks doesn't die all at once.
  function respawn(i, anyAge) {
    let x = 0;
    let y = 0;
    for (let tries = 0; tries < 10; tries++) {
      x = random() * cssW;
      y = random() * cssH;
      if (!insideFish(x, y)) break;
    }
    px[i] = x;
    py[i] = y;
    life[i] = LIFE_MIN + random() * (LIFE_MAX - LIFE_MIN);
    age[i] = anyAge ? random() * life[i] : 0;
  }

  // Streak opacity from its speed (0 to 1 of HOT_SPEED) and how far into
  // its fade-in it is, as one of ALPHA_LEVELS batches (-1 for none).
  function levelFor(s, fadeIn) {
    const a = (STREAK_ALPHA_MIN + (STREAK_ALPHA_MAX - STREAK_ALPHA_MIN) * Math.sqrt(s > 1 ? 1 : s)) * fadeIn;
    return Math.round((a / STREAK_ALPHA_MAX) * ALPHA_LEVELS) - 1;
  }

  function pushSegment(level, x0, y0, x1, y1) {
    if (level < 0) return;
    let a = segs[level];
    const c = segCount[level];
    if (c + 4 > a.length) {
      const bigger = new Float32Array(a.length * 2);
      bigger.set(a);
      segs[level] = bigger;
      a = bigger;
    }
    a[c] = x0;
    a[c + 1] = y0;
    a[c + 2] = x1;
    a[c + 3] = y1;
    segCount[level] = c + 4;
  }

  // Moves every streak one step (midpoint steps near the fish, where the
  // flow turns fast) and queues the piece it just drew.
  function stepParticles(dt) {
    const k = dt * SPEED;
    const invHot = 1 / (HOT_SPEED * unit);
    const f = fish;
    segCount.fill(0);
    for (let i = 0; i < count; i++) {
      const a = age[i] + dt;
      const x = px[i];
      const y = py[i];
      if (a > life[i] || sampleAt(x, y)) {
        respawn(i, false);
        continue;
      }
      age[i] = a;
      let u = su;
      let v = sv;
      if (f !== null && x > f.x0 && x < f.x1 && y > f.y0 && y < f.y1) {
        if (sampleAt(x + u * k * 0.5, y + v * k * 0.5)) {
          respawn(i, false);
          continue;
        }
        u = su;
        v = sv;
      }
      const nx = x + u * k;
      const ny = y + v * k;
      if (nx < -10 || ny < -10 || nx > cssW + 10 || ny > cssH + 10) {
        respawn(i, false);
        continue;
      }
      px[i] = nx;
      py[i] = ny;
      const s = Math.sqrt(u * u + v * v) * invHot;
      let fadeIn = a < BIRTH_S ? a / BIRTH_S : 1;
      if (y < topClear || y > bottomClear) fadeIn *= bandKeep(y, NAV_STREAK_KEEP, BOTTOM_STREAK_KEEP);
      pushSegment(levelFor(s, fadeIn), x, y, nx, ny);
    }
  }

  function drawSegments() {
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tctx.globalCompositeOperation = 'source-over';
    tctx.lineWidth = LINE_WIDTH;
    tctx.lineCap = 'butt';
    for (let l = 0; l < ALPHA_LEVELS; l++) {
      const n = segCount[l];
      if (!n) continue;
      const a = segs[l];
      tctx.beginPath();
      for (let q = 0; q < n; q += 4) {
        tctx.moveTo(a[q], a[q + 1]);
        tctx.lineTo(a[q + 2], a[q + 3]);
      }
      tctx.strokeStyle = levelStyles[l];
      tctx.stroke();
    }
  }

  // Fades the old trails toward black. In some browsers a small fade can
  // leave very dim pixels that round back to the same value every frame and
  // never clear, so every CLEAN_EVERY frames a "color-burn" fill with a
  // nearly white gray takes GHOST_CUT off the darkest pixels (and almost
  // nothing off the bright ones), which clears them.
  function fadeTrails(dt) {
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.globalCompositeOperation = 'source-over';
    const a = 1 - Math.pow(1 - TRAIL_FADE, dt * 60);
    tctx.fillStyle = `rgba(0, 0, 0, ${a.toFixed(4)})`;
    tctx.fillRect(0, 0, trails.width, trails.height);
    cleanWait += 1;
    if (cleanWait >= CLEAN_EVERY) {
      cleanWait = 0;
      const c = 255 - GHOST_CUT;
      tctx.globalCompositeOperation = 'color-burn';
      tctx.fillStyle = `rgb(${c}, ${c}, ${c})`;
      tctx.fillRect(0, 0, trails.width, trails.height);
      tctx.globalCompositeOperation = 'source-over';
    }
  }

  // What the visitor sees: the speed colors scaled up smoothly to fill the
  // canvas, then the trails over them with the "screen" blend.
  function composite() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const s = OVERLAY_CELL * dpr;
    ctx.drawImage(speedLayer, 0, 0, ow, oh, -OVERLAY_MARGIN * s, -OVERLAY_MARGIN * s, ow * s, oh * s);
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(trails, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
  }

  // A full screen of trails at once: each streak is traced forward
  // STILL_STEPS steps, fading toward its tail the way a live trail does.
  // Used for the reduced motion frame, and as the first frame of the
  // animation so the water is never empty.
  function drawStill() {
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.globalCompositeOperation = 'source-over';
    tctx.fillStyle = '#000';
    tctx.fillRect(0, 0, trails.width, trails.height);
    const k = STILL_STEP_S * SPEED;
    const invHot = 1 / (HOT_SPEED * unit);
    const fadePerStep = Math.pow(1 - TRAIL_FADE, STILL_STEP_S * 60);
    segCount.fill(0);
    for (let i = 0; i < count; i++) {
      let x = px[i];
      let y = py[i];
      let inside = false;
      for (let q = 0; q < STILL_STEPS; q++) {
        if (sampleAt(x, y)) {
          inside = true;
          break;
        }
        const nx = x + su * k;
        const ny = y + sv * k;
        const s = Math.sqrt(su * su + sv * sv) * invHot;
        let fade = Math.pow(fadePerStep, STILL_STEPS - 1 - q);
        if (y < topClear || y > bottomClear) fade *= bandKeep(y, NAV_STREAK_KEEP, BOTTOM_STREAK_KEEP);
        pushSegment(levelFor(s, fade), x, y, nx, ny);
        x = nx;
        y = ny;
      }
      if (inside || x < -10 || y < -10 || x > cssW + 10 || y > cssH + 10) respawn(i, true);
      else {
        px[i] = x;
        py[i] = y;
      }
    }
    drawSegments();
  }

  // ---------- Speed colors ----------

  function setupOverlay() {
    ow = Math.ceil(cssW / OVERLAY_CELL) + 2 * OVERLAY_MARGIN;
    oh = Math.ceil(cssH / OVERLAY_CELL) + 2 * OVERLAY_MARGIN;
    speedLayer.width = ow;
    speedLayer.height = oh;
    overlayImg = speedCtx.createImageData(ow, oh);
    blurTmp = new Uint8ClampedArray(ow * oh * 4);
    overlayKeep = new Float32Array(oh);
    for (let j = 0; j < oh; j++) overlayKeep[j] = bandKeep((j - OVERLAY_MARGIN + 0.5) * OVERLAY_CELL, NAV_SPEED_KEEP, BOTTOM_SPEED_KEEP);
  }

  // One pixel per OVERLAY_CELL px, colored through SPEED_RAMP by the speed
  // there and blurred a little, then scaled up smoothly by composite().
  // Inside the fish it uses the rim speed, so the blur doesn't dim the
  // bright rim. The fish layer covers the inside anyway. Behind the nav and
  // at the bottom edge only a share of the speed counts (overlayKeep).
  function drawOverlay() {
    const d = overlayImg.data;
    const top = rampLut.length / 3 - 1;
    let o = 0;
    for (let j = 0; j < oh; j++) {
      const y = (j - OVERLAY_MARGIN + 0.5) * OVERLAY_CELL;
      const scale = (top * overlayKeep[j]) / (HOT_SPEED * unit);
      for (let i = 0; i < ow; i++) {
        const x = (i - OVERLAY_MARGIN + 0.5) * OVERLAY_CELL;
        const s = sampleAt(x, y) ? fish.rim : Math.sqrt(su * su + sv * sv);
        let q = (s * scale) | 0;
        if (q > top) q = top;
        q *= 3;
        d[o] = rampLut[q];
        d[o + 1] = rampLut[q + 1];
        d[o + 2] = rampLut[q + 2];
        d[o + 3] = 255;
        o += 4;
      }
    }
    for (let pass = 0; pass < 2; pass++) boxBlur(d, blurTmp, ow, oh, OVERLAY_BLUR);
    speedCtx.putImageData(overlayImg, 0, 0);
  }

  // ---------- Loop ----------

  function ready() {
    return cssW > 0 && cssH > 0 && fishState !== 'loading';
  }

  // The loop only runs after drawFirst(), whose full screen of trails is
  // always the first frame.
  function running() {
    return !stopped && !reduced && tabVisible && onScreen && ready() && drewOnce;
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
    raf = requestAnimationFrame(tick);
    if (!running()) {
      cancelAnimationFrame(raf);
      raf = 0;
      return;
    }
    const gap = now - lastTick;
    if (gap < MIN_FRAME_MS) return;
    lastTick = now;
    // Never more than a twentieth of a second in one step, so a slow frame
    // doesn't throw the streaks.
    drawFrame(Math.min(0.05, gap / 1000));
  }

  function drawFrame(dt) {
    const started = performance.now();
    animT += dt;
    advanceFlow(animT);
    blendFlow(animT);
    updateP0();
    fadeTrails(dt);
    stepParticles(dt);
    drawSegments();
    overlayWait -= 1;
    if (overlayWait <= 0) {
      overlayWait = OVERLAY_EVERY;
      drawOverlay();
    }
    composite();
    report(started, false);
  }

  // The first frame after a start or a size change, and the only frame with
  // reduced motion.
  function drawFirst() {
    if (!ready()) return;
    const started = performance.now();
    blendFlow(animT);
    updateP0();
    drawStill();
    drawOverlay();
    composite();
    overlayWait = OVERLAY_EVERY;
    drewOnce = true;
    report(started, true);
  }

  function report(started, still) {
    frameNo += 1;
    if (onFrame) {
      onFrame({
        frame: frameNo, ms: performance.now() - started, particles: count,
        width: cssW, height: cssH, dpr, fish: fish !== null, still,
      });
    }
  }

  // Size and fish changes are handled once per animation frame at most.
  function queueLayout() {
    if (layoutQueued || stopped) return;
    layoutQueued = requestAnimationFrame(() => {
      layoutQueued = 0;
      if (stopped) return;
      const changed = layout();
      if ((changed || !drewOnce) && ready()) {
        if (drewOnce) {
          drawFirst();   // a resize: draw at once, so the water never blinks navy
        } else {
          // A first frame waits for the next animation frame, so the layout
          // and it are two shorter tasks instead of one long one. On a
          // first load the hero is still plain navy meanwhile.
          queueFirst();
          return;
        }
      }
      sync();
    });
  }

  let firstQueued = 0;
  function queueFirst() {
    if (firstQueued || stopped) return;
    firstQueued = requestAnimationFrame(() => {
      firstQueued = 0;
      if (stopped) return;
      if (!drewOnce && ready()) drawFirst();
      sync();
    });
  }

  // A resize rebuilds everything (some 30 to 70 ms), so while the window is
  // being dragged it waits until the size has held for RESIZE_WAIT_MS. The
  // canvas just stretches until then. The very first layout doesn't wait.
  let resizeTimer = 0;
  function queueResize() {
    if (stopped) return;
    if (!drewOnce) {
      queueLayout();
      return;
    }
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(queueLayout, RESIZE_WAIT_MS);
  }

  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(queueResize) : null;
  resizeObserver?.observe(canvas);
  if (fishSlot) resizeObserver?.observe(fishSlot);
  window.addEventListener('resize', queueResize);

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
    sync();
    if (reduced && !was) drawFirst();   // settle on one calm still frame
  };
  if (motionQuery?.addEventListener) motionQuery.addEventListener('change', onMotionChange);
  else motionQuery?.addListener?.(onMotionChange);

  // The tuna's outline and its mask. Until both are ready (or FISH_WAIT_MS
  // passes) no water is drawn, so it never runs through where the fish
  // will be. The hero stays plain navy meanwhile.
  function setFishState(state) {
    if (stopped || state === fishState) return;
    fishState = state;
    if (onFish) {
      try {
        onFish(state === 'ready');
      } catch (err) {
        console.error(err);
      }
    }
  }
  let fishTimer = 0;
  if (fishSlot) {
    fishTimer = setTimeout(() => {
      if (fishState === 'loading') {
        setFishState('failed');
        queueLayout();
      }
    }, FISH_WAIT_MS);
    fetch(fishSrc)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        const d = [...text.matchAll(/<path\b[^>]*?\sd="([^"]+)"/g)].map((m) => m[1]).join(' ');
        if (!d) throw new Error('no path in the SVG');
        tunaPath = new Path2D(d);
        return buildTunaMask();
      })
      .then((mask) => {
        if (!mask) return;   // stopped meanwhile
        tunaMask = mask;
        setFishState('ready');
      })
      .catch((err) => {
        console.warn('Flight Console: the fish outline did not load, so the currents run without it', err);
        tunaPath = null;
        setFishState('failed');
      })
      .finally(() => {
        clearTimeout(fishTimer);
        if (stopped) return;
        // A fish that arrives after the water started redraws the first
        // frame around it.
        if (fishState === 'ready') drewOnce = false;
        queueLayout();
      });
  }

  // The first layout waits for the next animation frame, so it isn't added
  // to the task that started the page. The canvas is navy until then.
  queueLayout();

  return function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(fishTimer);
    clearTimeout(resizeTimer);
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    if (layoutQueued) cancelAnimationFrame(layoutQueued);
    layoutQueued = 0;
    if (firstQueued) cancelAnimationFrame(firstQueued);
    firstQueued = 0;
    resizeObserver?.disconnect();
    window.removeEventListener('resize', queueResize);
    intersectionObserver?.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    if (motionQuery?.removeEventListener) motionQuery.removeEventListener('change', onMotionChange);
    else motionQuery?.removeListener?.(onMotionChange);
  };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function numberOr(value, fallback) {
  const n = Number(value);
  return value != null && Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function sameRect(a, b) {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
}

// One box blur of radius r over RGBA pixels, along the rows then down the
// columns, in place (tmp is scratch of the same size). Edges repeat their
// last pixel. Alpha is left alone.
function boxBlur(d, tmp, w, h, r) {
  const span = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += d[(row + clamp(k, 0, w - 1)) * 4 + c];
      for (let x = 0; x < w; x++) {
        tmp[(row + x) * 4 + c] = sum / span;
        sum += d[(row + Math.min(w - 1, x + r + 1)) * 4 + c] - d[(row + Math.max(0, x - r)) * 4 + c];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += tmp[(clamp(k, 0, h - 1) * w + x) * 4 + c];
      for (let y = 0; y < h; y++) {
        d[(y * w + x) * 4 + c] = sum / span;
        sum += tmp[(Math.min(h - 1, y + r + 1) * w + x) * 4 + c] - tmp[(Math.max(0, y - r) * w + x) * 4 + c];
      }
    }
  }
}

function hexToRgb(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// 1024 colors along the ramp, as r, g, b bytes. Entry q is the color for a
// speed of q / 1023 of HOT_SPEED, bent by curve.
function buildRampLut(stops, curve) {
  const rgb = stops.map(hexToRgb);
  const size = 1024;
  const lut = new Uint8Array(size * 3);
  for (let q = 0; q < size; q++) {
    const pos = Math.pow(q / (size - 1), curve) * (rgb.length - 1);
    const a = Math.min(rgb.length - 2, Math.floor(pos));
    const f = pos - a;
    for (let c = 0; c < 3; c++) lut[q * 3 + c] = Math.round(rgb[a][c] + (rgb[a + 1][c] - rgb[a][c]) * f);
  }
  return lut;
}

// A repeatable number from 0 to 1 for (a, b, seed).
function hash01(a, b, seed) {
  let h = Math.imul(a + 0x632be5ab, 0x85ebca6b) ^ Math.imul(b + 0x2f1d34c9, 0xc2b2ae35) ^ Math.imul(seed + 0x27d4eb2f, 0x165667b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let r = state;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// 1 for fish, 0 for water. Ink is alpha 128 and up. Starting from every
// open pixel on the border, the outside fills through open pixels, and
// whatever it can't reach is fish, holes included.
// The logo's face and the thin lines along its back and belly open to the
// outside through channels only a few pixels wide (the face through a slit
// along the upper jaw), so first the ink grows by seal px all round, which
// closes channels up to twice that wide, and the fill runs on that. Then
// the outside grows back by seal px over open pixels (a closing, with a
// round brush), and one last fill from the border keeps only the outside
// that really connects to it. The outline keeps its shape and the open
// mouth stays open.
// A generator: it yields between its big steps so runInSlices() can spread
// the work over several tasks, and returns the mask.
function* solidify(rgba, W, H, seal) {
  const n = W * H;
  const ink = new Uint8Array(n);
  for (let p = 0; p < n; p++) ink[p] = rgba[p * 4 + 3] >= 128 ? 1 : 0;
  const r2 = seal * seal;
  let open = new Uint8Array(n);
  if (seal > 0) {
    const toInk = yield* distanceSquaredSteps(ink, W, H);
    for (let p = 0; p < n; p++) open[p] = toInk[p] > r2 ? 1 : 0;
    yield;
  } else {
    for (let p = 0; p < n; p++) open[p] = ink[p] ? 0 : 1;
  }
  let outside = fillFromBorder(open, W, H);
  if (seal > 0) {
    yield;
    const toOutside = yield* distanceSquaredSteps(outside, W, H);
    open = new Uint8Array(n);
    for (let p = 0; p < n; p++) open[p] = outside[p] || (!ink[p] && toOutside[p] <= r2) ? 1 : 0;
    yield;
    outside = fillFromBorder(open, W, H);
  }
  yield;
  for (let p = 0; p < n; p++) outside[p] = outside[p] ? 0 : 1;
  return outside;
}

// Runs a generator one step per task, so no single task holds the page
// for long, and resolves with what it returns. The steps run back to back
// through a MessageChannel (setTimeout would wait at least 4 ms between
// them after the first few). If isStopped() turns true it gives up and
// resolves with undefined.
function runInSlices(gen, isStopped) {
  return new Promise((resolve, reject) => {
    const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
    const finish = (settle, value) => {
      if (channel) channel.port1.close();
      settle(value);
    };
    const step = () => {
      if (isStopped()) {
        finish(resolve, undefined);
        return;
      }
      let r;
      try {
        r = gen.next();
      } catch (err) {
        finish(reject, err);
        return;
      }
      if (r.done) finish(resolve, r.value);
      else if (channel) channel.port2.postMessage(0);
      else setTimeout(step, 0);
    };
    if (channel) channel.port1.onmessage = step;
    step();
  });
}

// Runs a generator to its end at once and returns what it returns.
function runNow(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}

// 1 for every open pixel the border reaches through open pixels
// (4-connected), 0 for the rest.
function fillFromBorder(open, W, H) {
  const n = W * H;
  const out = new Uint8Array(n);
  const queue = new Int32Array(n);
  let qn = 0;
  const seedAt = (p) => {
    if (open[p] && !out[p]) {
      out[p] = 1;
      queue[qn++] = p;
    }
  };
  for (let x = 0; x < W; x++) {
    seedAt(x);
    seedAt((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    seedAt(y * W);
    seedAt(y * W + W - 1);
  }
  for (let head = 0; head < qn; head++) {
    const p = queue[head];
    const x = p % W;
    if (x > 0 && open[p - 1] && !out[p - 1]) { out[p - 1] = 1; queue[qn++] = p - 1; }
    if (x < W - 1 && open[p + 1] && !out[p + 1]) { out[p + 1] = 1; queue[qn++] = p + 1; }
    if (p >= W && open[p - W] && !out[p - W]) { out[p - W] = 1; queue[qn++] = p - W; }
    if (p < n - W && open[p + W] && !out[p + W]) { out[p + W] = 1; queue[qn++] = p + W; }
  }
  return out;
}

// The exact squared distance (in grid steps) from every node to the nearest
// fish node, by Felzenszwalb and Huttenlocher's two-pass method (one pass
// down the columns, one along the rows).
function distanceSquared(mask, cols, rows) {
  return runNow(distanceSquaredSteps(mask, cols, rows));
}

// The same as a generator that yields between its two passes, and every
// SLICE_CELLS cells or so within each.
const SLICE_CELLS = 160000;
function* distanceSquaredSteps(mask, cols, rows) {
  const BIG = 1e12;
  const n = cols * rows;
  const out = new Float64Array(n);
  for (let q = 0; q < n; q++) out[q] = mask[q] ? 0 : BIG;
  const len = Math.max(cols, rows);
  const f = new Float64Array(len);
  const d = new Float64Array(len);
  const v = new Int32Array(len);
  const z = new Float64Array(len + 1);
  const colsPerSlice = Math.max(1, Math.floor(SLICE_CELLS / rows));
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) f[j] = out[j * cols + i];
    edt1d(f, rows, d, v, z);
    for (let j = 0; j < rows; j++) out[j * cols + i] = d[j];
    if ((i + 1) % colsPerSlice === 0) yield;
  }
  yield;
  const rowsPerSlice = Math.max(1, Math.floor(SLICE_CELLS / cols));
  for (let j = 0; j < rows; j++) {
    if (j > 0 && j % rowsPerSlice === 0) yield;
    const row = j * cols;
    for (let i = 0; i < cols; i++) f[i] = out[row + i];
    edt1d(f, cols, d, v, z);
    for (let i = 0; i < cols; i++) out[row + i] = d[i];
  }
  return out;
}

function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k -= 1;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k += 1;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

// ------------------------------------------------------------------
// Noise
// ------------------------------------------------------------------
// 3D simplex noise (after Stefan Gustavson's public domain version) with a
// seeded permutation table, so the same seed always gives the same water.
// Returns roughly -1 to 1.

function makeSimplex3(seed) {
  const GRAD = new Float32Array([
    1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
    1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
    0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
  ]);
  const random = mulberry32(seed + 0x6d2b79f5);
  const p = new Uint8Array(256);
  for (let q = 0; q < 256; q++) p[q] = q;
  for (let q = 255; q > 0; q--) {
    const r = Math.floor(random() * (q + 1));
    const tmp = p[q];
    p[q] = p[r];
    p[r] = tmp;
  }
  const perm = new Uint8Array(512);
  const grad = new Uint8Array(512);   // gradient number times 3
  for (let q = 0; q < 512; q++) {
    perm[q] = p[q & 255];
    grad[q] = (perm[q] % 12) * 3;
  }
  const F3 = 1 / 3;
  const G3 = 1 / 6;

  return function noise3(x, y, z) {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);
    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
    else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
    else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    const x1 = x0 - i1 + G3;
    const y1 = y0 - j1 + G3;
    const z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3;
    const y2 = y0 - j2 + 2 * G3;
    const z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 0.5;
    const y3 = y0 - 0.5;
    const z3 = z0 - 0.5;
    const ii = i & 255;
    const jj = j & 255;
    const kk = k & 255;
    let n = 0;
    let c = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (c > 0) {
      const g = grad[ii + perm[jj + perm[kk]]];
      c *= c;
      n += c * c * (GRAD[g] * x0 + GRAD[g + 1] * y0 + GRAD[g + 2] * z0);
    }
    c = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (c > 0) {
      const g = grad[ii + i1 + perm[jj + j1 + perm[kk + k1]]];
      c *= c;
      n += c * c * (GRAD[g] * x1 + GRAD[g + 1] * y1 + GRAD[g + 2] * z1);
    }
    c = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (c > 0) {
      const g = grad[ii + i2 + perm[jj + j2 + perm[kk + k2]]];
      c *= c;
      n += c * c * (GRAD[g] * x2 + GRAD[g + 1] * y2 + GRAD[g + 2] * z2);
    }
    c = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (c > 0) {
      const g = grad[ii + 1 + perm[jj + 1 + perm[kk + 1]]];
      c *= c;
      n += c * c * (GRAD[g] * x3 + GRAD[g + 1] * y3 + GRAD[g + 2] * z3);
    }
    return 32 * n;
  };
}
