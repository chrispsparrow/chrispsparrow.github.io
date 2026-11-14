// hero-currents.js
// The moving ocean currents behind the landing's hero at /flight-console/,
// drawn on Canvas 2D in the style of earth.nullschool.net and colored like
// a thermal camera. The currents are made up, not real data. Thousands of
// warm white streaks ride a flow field over a soft "ironbow" speed color:
// near-black where the water is still, then purple and red, up to pale
// yellow in the fastest jets.
//
// Two Dogtooth tuna swim slowly through the water, both facing right. They
// are camouflaged. Nothing is filled or outlined, and the speed colors
// under a fish are the ocean's. Inside a fish the streaks run along the
// fish's own lines from the logo instead: nose to tail along the body,
// around the gill arc, along the stripe and through the fins, and round a
// tiny whirlpool at the eye. Near the outline the fish's streaks fade into
// the ocean's. A fish only shows as a change in which way the streaks run,
// so a keen eye spots it and a glance doesn't. FISH_VISIBILITY sets how
// easy it is, from hidden to obvious.
//
// The page only ever calls this:
//   const stop = startCurrents(canvas, { textBox });
//   ...
//   stop();   // ends the loop and removes every listener and observer
// stop() leaves the last frame on screen.
//
// canvas shows the water. Every frame it gets the speed colors, then the
// streaks on top with the "screen" blend (the streaks build up on a second,
// hidden canvas, black with light trails, so black adds nothing), then the
// soft dark patch behind the title. Until the first frame it is plain
// near-black. Its parent should be an absolutely placed box with overflow
// hidden (see flight-console-hero.css).
//
// Options (all optional):
//   textBox         the element that holds the title and the buttons. The
//                   big fish swims in the space above it, the small one in
//                   the space below it, and the dark patch sits behind it.
//                   Without it the fish use fixed heights and the patch
//                   sits in the middle.
//   fishSrc         the tuna SVG (default: the logo's tuna, one evenodd
//                   path in a 1356 by 802 viewBox, facing left)
//   fishVisibility  a number from 0 to 1 that takes the place of
//                   FISH_VISIBILITY (for tests and side by side looks)
//   seed            whole number that picks the currents (1)
//   time            seconds of motion to start from (0), so a test can
//                   look at the fish somewhere along their swim
//   still           true draws one still frame at that time and stops,
//                   like reduced motion does at time 0 (for tests)
//   onFrame         called after every drawn frame with { frame, ms,
//                   particles, width, height, dpr, still, cut, fish } (for
//                   tests). ms is the time the frame's work took, cut is
//                   true once the slow start check has cut the streaks, and
//                   fish lists each fish's box in CSS px.
//
// Also exported for tests: buildFishField(d), which turns the tuna's path
// data into the fish's anatomy field at once (the page builds it in
// slices), and traceFishLines(field, w, margin, gap), which traces one
// fish's flow lines through it.
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
// How the fish work
//   Each fish is a patch that travels across the screen. Its "anatomy
//   field" is worked out once from the logo's path, in the fish's own
//   units, and mirrored so the fish faces right (see fishFieldSteps):
//     1. The path is filled into a mask and the holes are closed, which
//        gives the solid outline. Its distance to the edge gives a weight
//        that is 0 just outside the fish and 1 a little way in, so the edge
//        is soft.
//     2. Every line in the logo (the outline, the gill arc, the mouth, the
//        stripe, the fin lines) gives its direction to the grid cells it
//        crosses. A line has no forward, so it is kept as a doubled angle.
//     3. Those directions are spread over the whole fish by averaging each
//        cell with its neighbors many times, with a gentle pull toward the
//        plain nose to tail direction where no line is near.
//   Both fish share that one field (it is the same at every size). For
//   each fish size, flow lines are traced through it about a streak gap
//   apart, all running nose to tail (or downward where they cross the
//   fish, as on the gill arc), plus a few arms that wind in to the eye
//   (see traceFishLines).
//   The ocean is never changed. Instead each fish has its own streaks,
//   which run along its lines and never leave it (see stepFish). Where a
//   fish is, the ocean's streaks are drawn fainter by the fish's pull and
//   the fish's streaks brighter by the same amount (see coverAt), so the
//   light stays the same and the edge fades softly. The fish's streaks take
//   their speed and opacity from the ocean right where they are, so they
//   match the water around them. Since they never meet the ocean's water,
//   nothing piles up into seams, and all the streaks inside a fish run the
//   same way.
//   FISH_VISIBILITY first swaps the ocean's streaks for the fish's, then,
//   higher up, gathers them onto the lines and adds the other boosts (see
//   FISH_SWAP_GAIN).
//
// Keeping the title readable
//   A soft dark patch (CENTER_DIM) sits behind the title and buttons. The
//   page's nav is see-through and sits over the top of the water, so the
//   water right behind it is drawn dimmer too: the speed colors use only a
//   share of the real speed there and the streaks are fainter, easing back
//   to full strength a little below the nav (see NAV_FADE_START). The flow
//   itself doesn't change. The bottom edge fades a little too, so a bright
//   jet doesn't stop in a hard line where the footer starts.
//
// Keeping it light
//   At most about 60 frames a second on a computer and 30 on a phone, fewer
//   streaks on a phone, a canvas pixel ratio capped at 2 and at MAX_CANVAS_PX
//   pixels in all. If the first second runs slow, the streak count is cut to
//   fit (see checkSpeed). The loop pauses while the tab is hidden, the hero
//   is scrolled away or the landing isn't showing. With reduced motion it
//   draws one still frame with the fish at their starting places and stops
//   (it follows that setting live). The fish field is made once, in short
//   slices of work spread over several tasks, so the page keeps answering
//   clicks and keys while it is built. The fish's lines are traced when the
//   window changes size (a few ms), and moving the fish's streaks costs
//   about as much as a few hundred more ocean streaks.
//
// Used by: the landing's hero (js/views/launcher.js starts it). No imports.

// ------------------------------------------------------------------
// CONFIG: the settings worth changing
// ------------------------------------------------------------------

// How fast the streaks move through the field, as a multiplier. Bigger is
// faster and gives longer trails. It doesn't change the speed colors.
const SPEED = 1.7;
// How many streaks a 1920 by 1080 window gets. Other sizes scale from it,
// and phones get a share of it (PHONE_PARTICLE_SHARE).
const PARTICLE_COUNT = 13000;
// How much of every trail fades away each frame, at 60 frames a second.
// Bigger gives shorter trails.
const TRAIL_FADE = 0.075;
// The speed colors, the thermal "ironbow" ramp from still water to the
// fastest jets. They are the same seven stops as --fc-ramp-0 to --fc-ramp-6
// in css/flight-console-theme.css (a canvas can't read CSS variables).
const SPEED_RAMP = ['#07060D', '#1E0B3A', '#5A0F6B', '#A3215A', '#E0552B', '#F9A23A', '#FFF1B0'];
// How much darker the water gets right behind the title, from 0 (not at
// all) to 1 (black). It fades out softly toward the edges.
const CENTER_DIM = 0.35;
// How much the fish show, from 0 (hidden, there are no fish at all) to 1
// (obvious, two tuna drawn in flowing lines). At 0.6 someone who knows to
// look finds both after a few seconds, and a glance doesn't. Phones add
// PHONE_FISH_VISIBILITY. See FISH_SWAP_GAIN for what changes along the way.
const FISH_VISIBILITY = 0.6;
// How fast the big fish swims, in window widths a second. 1 / 48 crosses
// the window in 48 seconds. The small one swims a little slower
// (SMALL_FISH_DRIFT).
const DRIFT_SPEED = 1 / 48;

// ------------------------------------------------------------------
// The fish
// ------------------------------------------------------------------

// Phones add this to FISH_VISIBILITY (up to 1, and not when it is 0). Their
// fish are smaller and have fewer streaks, so they need a little more to
// be found as easily.
const PHONE_FISH_VISIBILITY = 0.1;
// Sizes as shares of the window's width. Phones (windows narrower than
// PHONE_WIDTH) get their own, bigger shares, since the window is narrow.
const BIG_FISH_WIDTH = 0.34;
const SMALL_FISH_WIDTH = 0.2;
const PHONE_BIG_FISH_WIDTH = 0.6;
const PHONE_SMALL_FISH_WIDTH = 0.4;
const PHONE_WIDTH = 640;     // CSS px
const SMALL_FISH_DRIFT = 0.85;   // the small fish's speed, as a share of DRIFT_SPEED
const FISH_START_IN = 0.05;  // how far in from its side each fish starts, as a share of the window's width
const FISH_TEXT_GAP = 14;    // CSS px kept between a fish and the title, the buttons or the nav
const FISH_BAND_FILL = 0.9;  // a fish is at most this share of the height of the space it swims in
const MIN_FISH_W = 110;      // CSS px. Below this a fish doesn't fit its space and swims behind the text instead
const FISH_BOB = 0.035;      // how far a fish bobs up and down, as a share of its height
const FISH_BOB_S = 7.5;      // seconds for one bob

// The anatomy field, in the logo's units (the tuna is 1251 wide).
const FIELD_UNIT = 4;        // logo units per field cell
const FIELD_PAD = 8;         // cells of room around the tuna's box, for the soft edge
const FEATHER_IN = 30;       // the fish's pull on the water reaches full strength this far inside the outline (logo units)
const FEATHER_OUT = 10;      // and starts this far outside it
const FISH_SEAL = 5.5;       // channels in the logo narrower than twice this fill in, see solidify()
const MIN_LINE_AREA = 40;    // logo pieces smaller than this (specks) don't count as lines
const LINE_STEP = 2;         // logo units between the points read along each line
const LINE_REACH = 5;        // a line's direction at a point comes from the points this many steps either side
const AXIS_PULL = 0.015;     // how strongly the plain nose to tail direction pulls where no line is near
const SPREAD_PASSES = 180;   // averaging passes that spread the lines' directions over the fish
const SPREAD_OMEGA = 1.7;    // over-relaxation, which makes those passes settle faster (1 to 1.9)
// The tuna inside its SVG (the path's box) and three spots on it, all in
// the SVG's own units, where the fish faces left.
const TUNA_BOX = { x: 77, y: 16, w: 1251, h: 524 };
const TUNA_NOSE = { x: 79, y: 254 };
const TUNA_TAIL = { x: 1170, y: 287 };   // the narrowest point of the tail stalk
const TUNA_EYE = { x: 266, y: 247, r: 30 };
const DEFAULT_FISH_SRC = new URL('../../assets/dogtooth_kicad_silkscreen_files/01_primary_full_logo_kicad_white_tuna.svg', import.meta.url).href;
const FISH_WAIT_MS = 1500;   // start without the fish if they take longer than this to load

// The fish's own streaks and flow lines, see traceFishLines() and stepFish().
const FISH_MARGIN = 0.06;         // a fish's patch reaches this share of its width past the tuna on every side
const FISH_GRID_COLS = 80;        // nodes across a fish's patch in its weight grid (how strongly it hides the ocean's streaks)
const PHONE_FISH_GRID_COLS = 56;  // the same on phones
const FLOW_GAP = 0.8;             // the fish's flow lines sit this share of the ocean's typical streak spacing apart
const FLOW_STEP = 1;              // CSS px between the points along a flow line
const FLOW_SEED_WEIGHT = 0.3;     // a flow line only starts where the fish's weight is at least this
const FLOW_END_WEIGHT = 0.02;     // and ends where the weight drops below this
const FLOW_MIN_GAPS = 2;          // flow lines shorter than this many gaps are dropped
const FLOW_MAX_WIDTHS = 2.5;      // and none is longer than this many fish widths
const EYE_REACH = 1.6;            // the eye's whirlpool reaches this many eye radii from its center
const EYE_TURNS = 1.25;           // how many times round each arm of the whirlpool winds on its way in
const FISH_RESTART_FADE = 1.5;    // a fish streak that starts its line again fades in over this many gaps
const FISH_SPEED_MEMORY = 0.5;    // seconds a fish streak's running average speed looks back, see stepFish
const BUNCH_MIN = 0.35;           // and the most its opacity is turned down
const BUNCH_MAX = 2.5;            // or up by it
// How FISH_VISIBILITY works. Two things happen as it goes up.
//   1. Inside a fish, more and more of the streaks are the fish's own,
//      which run along its flow lines, and fewer are the ocean's. They
//      swap evenly, so the amount of light stays the same. All of them are
//      the fish's by FISH_VISIBILITY = 1 / FISH_SWAP_GAIN (0.4).
//   2. From FISH_BOOST_FROM up to 1, the fish's streaks also get easier to
//      see: they gather onto the flow lines, keep a little speed in calm
//      water, and close to 1 the soft edge gets sharper and there are more
//      of them. These are "boosts", 0 at FISH_BOOST_FROM and their full
//      size at 1. The last two grow with the boost squared, so they stay
//      tiny at the default and the fish never shows as a brighter patch
//      there.
const FISH_SWAP_GAIN = 2.5;
const FISH_BOOST_FROM = 0.3;
// Boost: how much the fish's streaks gather onto its flow lines (0 not at
// all, 1 exactly onto them). On the lines they draw the fish like the
// logo's own linework.
const FISH_LINE_GATHER = 0.85;
// Boost (squared): extra fish streaks, as a share of the ocean's count in
// the same area. More streaks on the lines make them run unbroken.
const FISH_EXTRA_STREAKS = 0.6;
// Boost (squared): how much sharper the fish's soft edge gets. The weight is
// multiplied by 1 + this and capped at 1, so the thin fins and the tail
// reach full strength and the outline reads.
const FISH_EDGE_SHARPEN = 1.5;
// Boost: the fish's streaks never run slower than this (CSS px a second,
// at 1920 by 1080). In calm water this gives them enough length to draw
// the fish. They are drawn a little fainter when it speeds them up (see
// fishShade), so they come out longer but not much brighter. Below
// FISH_BOOST_FROM the streaks inside keep the ocean's own speed.
const FISH_SPEED_FLOOR = 170;
// Boost (squared): how much of that dimming is let go by FISH_VISIBILITY 1,
// where the fish may be a little brighter than the water so they are plain
// to see in calm water too.
const FISH_SHADE_EASE = 0.7;

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
const CALM_FLOOR = 0.3;     // the calmest water keeps this share of its speed

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

// ------------------------------------------------------------------
// Drawing
// ------------------------------------------------------------------

const FIELD_CELL = 12;      // px per flow grid cell at 1920 by 1080 (8 to 16)
const FIELD_STEP_S = 0.3;   // seconds of motion between flow grids
const NOISE_SLOPE = 2.2;    // typical slope of the noise, to turn a speed into psi
const OVERLAY_CELL = 8;     // px per speed color pixel (the colors are 1/8 resolution)
const OVERLAY_BLUR = 1;     // speed color pixels of blur (two box blur passes), before scaling up
const OVERLAY_EVERY = 3;    // frames between speed color updates
const HOT_SPEED = 560;      // the speed at the end of SPEED_RAMP
const RAMP_CURVE = 0.8;     // below 1 gives the slow speeds more of the ramp
const LIFE_MIN = 0.8;       // seconds a streak lives, picked between these
const LIFE_MAX = 2.4;
const BIRTH_S = 0.15;       // a new streak fades in over this long
const LINE_WIDTH = 0.9;     // CSS px
const STREAK_RGB = '255, 246, 224';   // warm white, between the theme's white and the ramp's palest stop
const STREAK_ALPHA_MIN = 0.22;        // the slowest streak's opacity
const STREAK_ALPHA_MAX = 0.8;         // the fastest streak's opacity
const ALPHA_LEVELS = 12;    // streaks are drawn in this many opacity batches
const GHOST_CUT = 6;        // 0 to 255, see fadeTrails()
const CLEAN_EVERY = 12;     // frames
const MAX_CANVAS_PX = 2.1e6; // the streaks canvas never has more device pixels than this (it costs GPU time per pixel)
const STILL_STEPS = 14;     // the still frame's trails: this many steps
const STILL_STEP_S = 1 / 40;  // of this many seconds each
const DIM_REACH_X = 0.42;   // the dark patch's half width, as a share of the window's width (at least the text's width)
const DIM_REACH_Y = 0.36;   // its half height, as a share of the window's height
const RESIZE_WAIT_MS = 150; // see queueResize()

// Frame rate and the slow start check.
const MIN_FRAME_MS = 12;          // screen refreshes closer than this are skipped (120 Hz runs at 60)
const PHONE_MIN_FRAME_MS = 30;    // the same on phones, which run at 30 frames a second at most
const PHONE_PARTICLE_SHARE = 0.6; // phones get this share of the streaks
const SLOW_CHECK_S = 1;           // after this many seconds of motion, check how long frames take
const SLOW_CHECKS = 2;            // and check this many times in all, one second apart
const FRAME_BUDGET = 0.45;        // a frame's work may take this share of the time between frames
const MIN_PARTICLES = 500;        // the check never cuts below this many streaks

const REF_AREA = 1920 * 1080;
const GRID_MARGIN = 2;      // flow grid nodes beyond each edge of the window
const OVERLAY_MARGIN = 2;   // speed color pixels beyond each edge (so the edges blur like the rest)

export function startCurrents(canvas, options = {}) {
  const parent = canvas?.parentElement;
  const ctx = parent ? canvas.getContext('2d', { alpha: false }) : null;
  if (!ctx) return () => {};

  const textBox = options.textBox && typeof options.textBox.getBoundingClientRect === 'function' ? options.textBox : null;
  const fishSrc = typeof options.fishSrc === 'string' ? options.fishSrc : DEFAULT_FISH_SRC;
  const fishVis = clamp(numberOr(options.fishVisibility, FISH_VISIBILITY), 0, 1);
  const seed = Math.floor(numberOr(options.seed, 1)) >>> 0;
  const onFrame = typeof options.onFrame === 'function' ? options.onFrame : null;
  const startT = Math.max(0, numberOr(options.time, 0));
  const forceStill = options.still === true;
  // The two parts of FISH_VISIBILITY (see FISH_SWAP_GAIN): fishSwap is the
  // share of the streaks deep inside a fish that are the fish's own, and
  // fishBoost runs from 0 to 1 for the boosts. Phones add
  // PHONE_FISH_VISIBILITY, so these are set again by setFishLook() when
  // the window changes size.
  let fishSwap = 0;
  let fishBoost = 0;
  let fishSpread = 1;   // how far to the side of its line a fish streak may sit, in gaps
  let fishFloor = 0;    // the fish's floor speed, times unit when used
  let edgeGain = 1;
  let shadePow = 0.5;   // see fishShade
  function setFishLook(onPhone) {
    const v = fishVis > 0 ? Math.min(1, fishVis + (onPhone ? PHONE_FISH_VISIBILITY : 0)) : 0;
    fishSwap = Math.min(1, v * FISH_SWAP_GAIN);
    fishBoost = clamp((v - FISH_BOOST_FROM) / (1 - FISH_BOOST_FROM), 0, 1);
    fishSpread = 1 - FISH_LINE_GATHER * fishBoost;
    fishFloor = FISH_SPEED_FLOOR * fishBoost;
    edgeGain = 1 + FISH_EDGE_SHARPEN * fishBoost * fishBoost;
    shadePow = 0.5 * (1 - FISH_SHADE_EASE * fishBoost * fishBoost);
  }
  // The anatomy weight (0 outside a fish, 1 well inside) turned into the
  // fish's pull: the share of the streaks there that are the fish's own.
  const pullOf = (weight) => Math.min(1, weight * edgeGain) * fishSwap;

  const noise = makeSimplex3(seed);
  const random = mulberry32(seed ^ 0x9e3779b9);
  const rampLut = buildRampLut(SPEED_RAMP, RAMP_CURVE);

  // An opaque canvas starts out black. Paint it the page's near-black at
  // once, so it matches the page until the first frame of water.
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
  // OVERLAY_CELL px.
  const trails = document.createElement('canvas');
  const tctx = trails.getContext('2d', { alpha: false });
  const speedLayer = document.createElement('canvas');
  const speedCtx = speedLayer.getContext('2d');
  if (!tctx || !speedCtx) return () => {};

  // The dark patch behind the title, drawn in a 1 by 1 circle that
  // composite() stretches over the title's area.
  const [dr, dg, db] = hexToRgb(SPEED_RAMP[0]);
  const dimFill = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  dimFill.addColorStop(0, `rgba(${dr}, ${dg}, ${db}, ${CENTER_DIM})`);
  dimFill.addColorStop(0.45, `rgba(${dr}, ${dg}, ${db}, ${CENTER_DIM * 0.8})`);
  dimFill.addColorStop(0.75, `rgba(${dr}, ${dg}, ${db}, ${CENTER_DIM * 0.3})`);
  dimFill.addColorStop(1, `rgba(${dr}, ${dg}, ${db}, 0)`);

  // ---------- State ----------
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let unit = 1;
  let navH = NAV_H_DEFAULT;

  // The dimmed bands at the top (behind the nav) and the bottom, in CSS px
  // from the top of the canvas: full dimming above topFull, none below
  // topClear, and from bottomClear down to the bottom edge it dims again.
  let topFull = 0;
  let topClear = 0;
  let bottomClear = 0;
  let overlayKeep = new Float32Array(0);   // the speed share kept on each speed color row
  let dimBox = { x: 0, y: 0, rx: 1, ry: 1 };  // the dark patch: center and half sizes, CSS px

  // The flow grid: three grids in time (the two being blended and the next
  // one being built) and the blend the streaks read.
  let cell = FIELD_CELL;
  let invCell = 1 / cell;
  let gw = 0;
  let gh = 0;
  let grids = [];
  let curU = new Float32Array(0);
  let curV = new Float32Array(0);
  let flow = null;         // the scaled flow settings for this window

  // The fish
  let field = null;        // the anatomy field, see fishFieldSteps()
  let fishState = 'loading';   // 'loading', 'ready', 'failed' or 'off' (FISH_VISIBILITY 0)
  let fishes = [];         // the two fish on screen, see placeFish()

  // Streaks
  let count = 0;
  let particleShare = 1;   // what the slow start check left of the full count
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

  // The velocity sample written by sampleOcean().
  let su = 0;
  let sv = 0;

  // Loop
  let stopped = false;
  let reduced = false;
  let phone = false;
  let tabVisible = document.visibilityState !== 'hidden';
  let onScreen = true;     // until the first IntersectionObserver report says otherwise
  let raf = 0;
  let lastTick = 0;
  let animT = startT;      // seconds of motion so far (still while paused)
  let frameNo = 0;
  let cleanWait = 0;
  let drewOnce = false;
  let layoutQueued = 0;
  // The slow start check: frame work time added up since the last check.
  let checksLeft = SLOW_CHECKS;
  let checkAt = SLOW_CHECK_S;
  let costSum = 0;
  let costFrames = 0;
  let cut = false;

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

  // A phone: a touch screen with no mouse, or a narrow window.
  function isPhone(w) {
    const touchOnly = window.matchMedia ? window.matchMedia('(hover: none) and (pointer: coarse)').matches : false;
    return touchOnly || w < PHONE_WIDTH;
  }

  function particleCountFor(w, h, u) {
    let n = (PARTICLE_COUNT * (w * h)) / REF_AREA / u;
    if (phone) n *= PHONE_PARTICLE_SHARE;
    n = clamp(Math.round(n), 400, Math.round(PARTICLE_COUNT * 1.6));
    return Math.max(Math.min(n, MIN_PARTICLES), Math.round(n * particleShare));
  }

  function measure() {
    const rect = canvas.getBoundingClientRect();
    return { w: Math.max(0, Math.round(rect.width)), h: Math.max(0, Math.round(rect.height)) };
  }

  // The title and buttons' box, relative to the canvas, or null.
  function readTextRect() {
    if (!textBox) return null;
    const a = textBox.getBoundingClientRect();
    const b = canvas.getBoundingClientRect();
    if (a.width < 10 || a.height < 10) return null;
    return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height };
  }

  let textNow = null;
  // Returns true when anything changed.
  function layout() {
    const { w, h } = measure();
    if (w === 0 || h === 0) return false;   // hidden: keep everything for when it comes back
    const newDpr = dprFor(w, h);
    const sizeChanged = w !== cssW || h !== cssH || newDpr !== dpr;
    const text = readTextRect();
    const textChanged = !sameRect(text, textNow);
    if (!sizeChanged && !textChanged && fishes.length === (field ? 2 : 0)) return false;
    textNow = text;
    if (sizeChanged) {
      cssW = w;
      cssH = h;
      dpr = newDpr;
      unit = unitFor(w, h);
      phone = isPhone(w);
      setFishLook(phone);
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
    placeDim();
    placeFish();
    moveFish(reduced ? startT : animT);
    blendFlow(animT);
    return true;
  }

  // ---------- The dimmed bands ----------

  function setupBands() {
    // --fc-nav-h is a plain custom property, so it comes back as written:
    // px, or rem (times the root font size).
    const raw = getComputedStyle(canvas).getPropertyValue('--fc-nav-h').trim();
    navH = parseFloat(raw);
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

  // The dark patch sits on the middle of the title and buttons, and is at
  // least a little bigger than them.
  function placeDim() {
    const t = textNow;
    const x = t ? t.x + t.w / 2 : cssW / 2;
    const y = t ? t.y + t.h / 2 : cssH / 2;
    const rx = Math.max(DIM_REACH_X * cssW, t ? t.w * 0.8 : 0);
    const ry = Math.max(DIM_REACH_Y * cssH, t ? t.h * 1.6 : 0);
    dimBox = { x, y, rx, ry };
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
    const n = curU.length;
    for (let k = 0; k < n; k++) {
      curU[k] = a.u[k] + f * (b.u[k] - a.u[k]);
      curV[k] = a.v[k] + f * (b.v[k] - a.v[k]);
    }
  }

  // Writes the ocean's velocity at (x, y) to su, sv. The fish never change
  // it: they only change which streaks are drawn there (see coverAt).
  function sampleOcean(x, y) {
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
    su = curU[k] * w00 + curU[k + 1] * w10 + curU[k + gw] * w01 + curU[k + gw + 1] * w11;
    sv = curV[k] * w00 + curV[k + 1] * w10 + curV[k + gw] * w01 + curV[k + gw + 1] * w11;
  }

  // How much the fish hide the ocean's streaks at (x, y): the biggest pull
  // of any fish copy there (see pullOf), from 0 in open water up to 1 deep
  // inside a fish once FISH_VISIBILITY reaches 0.4. The ocean's streaks are
  // drawn that much fainter there, and the fish's own streaks that much
  // brighter (see stepFish), so the two add up to the same amount of light.
  function coverAt(x, y) {
    let cover = 0;
    for (let q = 0; q < fishes.length; q++) {
      const f = fishes[q];
      const ly = y - f.top;
      if (ly < 0 || ly >= f.spanH) continue;
      const cs = f.copies;
      for (let c = 0; c < 3; c++) {
        if (!cs[c].active) continue;
        const lx = x - cs[c].left;
        if (lx < 0 || lx >= f.spanW) continue;
        const p = pullAt(f.grid, lx, ly);
        if (p > cover) cover = p;
      }
    }
    return cover;
  }

  // ---------- The fish ----------

  // Sizes the two fish and picks their heights. The big one swims in the
  // space between the nav and the title, the small one in the space between
  // the buttons and the bottom. If a space is too short for a fish, the fish
  // keeps its width and swims behind the text instead.
  function placeFish() {
    fishes = [];
    if (!field) return;
    const narrow = cssW < PHONE_WIDTH;
    const t = textNow;
    const top = navH + FISH_TEXT_GAP;
    const bottom = cssH - FISH_TEXT_GAP;
    const big = makeFish(narrow ? PHONE_BIG_FISH_WIDTH : BIG_FISH_WIDTH,
      top, t ? t.y - FISH_TEXT_GAP : cssH * 0.42, 0.28, 'right', 1, 0);
    const small = makeFish(narrow ? PHONE_SMALL_FISH_WIDTH : SMALL_FISH_WIDTH,
      t ? t.y + t.h + FISH_TEXT_GAP : cssH * 0.58, bottom, 0.76, 'left', SMALL_FISH_DRIFT, 2.1);
    fishes.push(big, small);
  }

  // One fish. share: its width as a share of the window's. bandTop and
  // bandBottom: the space it swims in. fallbackY: its middle, as a share of
  // the window's height, when it doesn't fit there. side: the side it
  // starts on. drift: its speed as a share of DRIFT_SPEED. bobPhase: where
  // in its bob it starts, in radians.
  function makeFish(share, bandTop, bandBottom, fallbackY, side, drift, bobPhase) {
    const aspect = TUNA_BOX.h / TUNA_BOX.w;
    let w = share * cssW;
    let y;
    const room = (bandBottom - bandTop) * FISH_BAND_FILL;
    if (room / aspect >= MIN_FISH_W) {
      w = Math.min(w, room / aspect);
      y = (bandTop + bandBottom) / 2 - (w * aspect) / 2;
    } else {
      w = Math.min(w, (cssH * 0.3) / aspect);
      y = cssH * fallbackY - (w * aspect) / 2;
    }
    const h = w * aspect;
    const startX = side === 'right' ? cssW * (1 - FISH_START_IN) - w : cssW * FISH_START_IN;
    const margin = FISH_MARGIN * w;   // the patch reaches this far past the tuna's box, CSS px
    const f = {
      w, h, startX, baseY: y,
      speed: DRIFT_SPEED * drift * cssW,
      bob: FISH_BOB * h, bobPhase,
      margin, spanW: w + 2 * margin, spanH: h + 2 * margin,
      x: startX, y,      // the tuna's box now, CSS px
      top: 0,            // the patch's top now, CSS px
      grid: null,        // see buildFishGrid()
      lines: null,       // see traceFishLines()
      streaks: null,     // see sizeFishStreaks()
      // The patch, up to three times: one window width to the left, where
      // it is, and one window width to the right. Only the copies that
      // overlap the window are marked active (two at most, while the fish
      // crosses an edge), and only they hide the ocean's streaks.
      copies: [-1, 0, 1].map((place) => ({ side: place, active: false, left: 0 })),
    };
    f.grid = buildFishGrid(f);
    // The gap between the fish's flow lines comes from how far apart the
    // ocean's streaks are on average, so the fish's streaks are as dense
    // as the water around them.
    const gap = clamp(FLOW_GAP / Math.sqrt(count / (cssW * cssH)), 4, 16);
    f.lines = traceFishLines(field, w, margin, gap, seed);
    // The lines carry the anatomy weight at every point. The streaks want
    // the pull, the same number coverAt() reads, so the two add up.
    const pts = f.lines.pts;
    for (let o = 4; o < pts.length; o += 5) pts[o] = pullOf(pts[o]);
    sizeFishStreaks(f);
    return f;
  }

  // The grid a fish carries over its patch, about FISH_GRID_COLS nodes
  // across, with how strongly the fish hides the ocean's streaks at every
  // node (the pull, see pullOf). Built once per
  // fish size.
  function buildFishGrid(f) {
    const cols = phone ? PHONE_FISH_GRID_COLS : FISH_GRID_COLS;
    const h = f.spanW / (cols - 1);   // CSS px between nodes
    const rows = Math.max(3, Math.round(f.spanH / h) + 1);
    const n = cols * rows;
    const F = field;
    const scale = f.w / TUNA_BOX.w;   // CSS px per logo unit
    const cellsPerPx = 1 / (FIELD_UNIT * scale);
    const fieldPad = FIELD_PAD * FIELD_UNIT * scale;   // the field's own border, CSS px
    const pull = new Float32Array(n);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const gx = Math.round((i * h - f.margin + fieldPad) * cellsPerPx - 0.5);
        const gy = Math.round((j * h - f.margin + fieldPad) * cellsPerPx - 0.5);
        if (gx < 0 || gy < 0 || gx >= F.cols || gy >= F.rows) continue;
        pull[j * cols + i] = pullOf(F.weight[gy * F.cols + gx]);
      }
    }
    return { cols, rows, h, inv: 1 / h, pull };
  }

  // The pull at (lx, ly) in CSS px from a fish patch's corner, read
  // smoothly between the grid's nodes.
  function pullAt(g, lx, ly) {
    const gx = lx * g.inv;
    const gy = ly * g.inv;
    const i = Math.min(g.cols - 2, gx | 0);
    const j = Math.min(g.rows - 2, gy | 0);
    const fx = gx - i;
    const fy = gy - j;
    const k = j * g.cols + i;
    const p = g.pull;
    return (p[k] * (1 - fx) + p[k + 1] * fx) * (1 - fy) + (p[k + g.cols] * (1 - fx) + p[k + g.cols + 1] * fx) * fy;
  }

  // Moves the fish to where they are at time t: to the right at their
  // speed, wrapping from the right edge to the left, with a slow bob. At
  // t = 0 every fish is at its start. Each copy that overlaps the window is
  // marked active.
  function moveFish(t) {
    for (let q = 0; q < fishes.length; q++) {
      const f = fishes[q];
      f.x = wrap(f.startX + f.speed * t, cssW);
      f.y = f.baseY + f.bob * Math.sin((Math.PI * 2 * t) / FISH_BOB_S + f.bobPhase) - f.bob * Math.sin(f.bobPhase);
      f.top = f.y - f.margin;
      for (let c = 0; c < 3; c++) {
        const copy = f.copies[c];
        copy.left = f.x - f.margin + copy.side * cssW;
        copy.active = copy.left < cssW && copy.left + f.spanW > 0;
      }
    }
  }

  // ---------- The fish's streaks ----------
  // Each fish has its own streaks, which never leave it. A fish streak sits
  // on one of the fish's flow lines (or a little to one side of it, by up
  // to half a gap, so the streaks fill the space between the lines) and
  // runs along it from nose to tail. One that reaches the end of its line
  // starts again at the line's beginning, so no part of the fish runs out
  // of streaks. They are kept in the fish's own CSS px, from the corner of
  // its patch, and drawn wherever the fish is on screen.

  // Gives fish f as many streaks as the ocean has in the same area, so its
  // streaks are as dense as the water around it. Called again when the
  // slow start check cuts the ocean's streaks.
  function sizeFishStreaks(f) {
    const L = f.lines;
    const extra = 1 + FISH_EXTRA_STREAKS * fishBoost * fishBoost;
    const n = fishVis > 0 && L.count > 0 ? Math.round((count / (cssW * cssH)) * L.total * L.gap * extra) : 0;
    const old = f.streaks;
    if (old && old.n === n) return;
    const S = {
      n,
      line: new Int32Array(n),     // which flow line
      pos: new Float32Array(n),    // how far along it, in points
      off: new Float32Array(n),    // how far to one side of it, CSS px
      age: new Float32Array(n),
      life: new Float32Array(n),
      run: new Float32Array(n),    // CSS px since it last started again at its line's beginning
      vavg: new Float32Array(n),   // its running average speed, see stepFish
    };
    f.streaks = S;
    for (let i = 0; i < n; i++) {
      if (old && i < old.n) {
        S.line[i] = old.line[i];
        S.pos[i] = old.pos[i];
        S.off[i] = old.off[i];
        S.age[i] = old.age[i];
        S.life[i] = old.life[i];
        S.run[i] = old.run[i];
        S.vavg[i] = old.vavg[i];
      } else {
        respawnFishStreak(f, i, true);
      }
    }
  }

  // A new streak somewhere in fish f: on a line picked by length (so long
  // lines get more), anywhere along it. "anyAge" as in respawn().
  function respawnFishStreak(f, i, anyAge) {
    const L = f.lines;
    const S = f.streaks;
    const want = random() * L.total;
    let lo = 0;
    let hi = L.count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (L.cum[mid] < want) lo = mid + 1;
      else hi = mid;
    }
    S.line[i] = lo;
    S.pos[i] = random() * (L.lens[lo] - 1);
    S.off[i] = (random() - 0.5) * L.gap * (lo >= L.eyeFrom ? 0.25 : fishSpread);
    S.life[i] = LIFE_MIN + random() * (LIFE_MAX - LIFE_MIN);
    S.age[i] = anyAge ? random() * S.life[i] : 0;
    S.run[i] = Infinity;
    S.vavg[i] = 0;   // set by its first step
  }

  // Where a fish streak is: line, how far along it (pos, in points, at most
  // the line's length less one) and its side offset (off, CSS px). Writes
  // the point (CSS px from the patch's corner) to lpX, lpY and the fish's
  // pull there (see pullOf) to lpW.
  let lpX = 0;
  let lpY = 0;
  let lpW = 0;
  function linePoint(L, line, pos, off) {
    const q = pos | 0;
    const t = pos - q;
    const a = (L.starts[line] + q) * 5;
    const b = a + 5;
    const p = L.pts;
    const nx = p[a + 2] + t * (p[b + 2] - p[a + 2]);
    const ny = p[a + 3] + t * (p[b + 3] - p[a + 3]);
    lpX = p[a] + t * (p[b] - p[a]) + off * nx;
    lpY = p[a + 1] + t * (p[b + 1] - p[a + 1]) + off * ny;
    lpW = p[a + 4] + t * (p[b + 4] - p[a + 4]);
  }

  // How far a fish streak at (x, y) on screen moves in a step of k seconds
  // (times SPEED), in points along its line: the ocean's speed there, or
  // the fish's floor speed if that is faster. Also leaves the ocean's own
  // speed in fishOcean, which sets the streak's opacity like any other, the
  // speed it really moves at in fishSpeed, and in fishShade how much
  // fainter it is drawn when the floor speeds it up (a longer streak at
  // the same opacity would be a brighter one).
  let fishOcean = 0;
  let fishSpeed = 0;
  let fishShade = 1;
  function fishStep(x, y, k, floor) {
    sampleOcean(x, y);
    fishOcean = Math.sqrt(su * su + sv * sv);
    if (fishOcean >= floor) {
      fishSpeed = fishOcean;
      fishShade = 1;
    } else {
      fishSpeed = floor;
      fishShade = Math.pow(Math.max(fishOcean, floor * 0.1) / floor, shadePow);
    }
    return (fishSpeed * k) / FLOW_STEP;
  }

  // The left edge on screen of the copy of fish f that shows the point lx
  // (CSS px from the patch's corner). The fish's own place is in the window
  // (its x wraps into it), so only a point past the right edge shows on the
  // copy one window width to the left.
  function screenLeft(f, lx) {
    const left = f.x - f.margin;
    return left + lx > cssW ? left - cssW : left;
  }

  // Moves every fish streak one step and queues the piece it just drew.
  // It is drawn as bright as an ocean streak would be there (from the
  // ocean's speed), times the fish's pull there, which is exactly what the
  // ocean's streaks lost in coverAt().
  // One more thing evens out the light. A fish's line doesn't follow the
  // ocean, so a streak on it races through a jet and dawdles in calm water,
  // and streaks thin out in the jet and bunch up after it (an ocean streak
  // stays in its jet, so the jet stays full). Each streak keeps a running
  // average of its own speed (vavg), and is drawn brighter when it moves
  // faster than that and fainter when slower, by the ratio of the two.
  function stepFish(dt) {
    if (fishVis === 0) return;
    const k = dt * SPEED;
    const invHot = 1 / (HOT_SPEED * unit);
    const floor = fishFloor * unit;
    for (let q = 0; q < fishes.length; q++) {
      const f = fishes[q];
      const L = f.lines;
      const S = f.streaks;
      for (let i = 0; i < S.n; i++) {
        const a = S.age[i] + dt;
        if (a > S.life[i]) {
          respawnFishStreak(f, i, false);
          continue;
        }
        S.age[i] = a;
        const line = S.line[i];
        const last = L.lens[line] - 1;
        linePoint(L, line, S.pos[i], S.off[i]);
        const x0 = lpX;
        const y0 = lpY;
        const left = screenLeft(f, x0);
        const step = fishStep(x0 + left, y0 + f.top, k, floor);
        let pos = S.pos[i] + step;
        if (pos >= last) {
          // The end of the line: start again at its beginning. It fades in
          // over the first FISH_RESTART_FADE gaps of the line (by distance,
          // not time, so in a fast jet it isn't faint half its life).
          pos -= last;
          if (pos >= last) pos = 0;
          S.pos[i] = pos;
          S.run[i] = 0;
          continue;
        }
        S.pos[i] = pos;
        const run = S.run[i] + step * FLOW_STEP;
        S.run[i] = run;
        linePoint(L, line, pos, S.off[i]);
        const sx = x0 + left;
        const sy = y0 + f.top;
        const restart = run / (FISH_RESTART_FADE * L.gap);
        let vavg = S.vavg[i];
        vavg = vavg > 0 ? vavg + (fishSpeed - vavg) * Math.min(1, dt / FISH_SPEED_MEMORY) : fishSpeed;
        S.vavg[i] = vavg;
        const bunch = clamp(fishSpeed / Math.max(vavg, 1e-3), BUNCH_MIN, BUNCH_MAX);
        let factor = (a < BIRTH_S ? a / BIRTH_S : 1) * (restart < 1 ? restart : 1) * lpW * bunch * fishShade;
        if (sy < topClear || sy > bottomClear) factor *= bandKeep(sy, NAV_STREAK_KEEP, BOTTOM_STREAK_KEEP);
        pushSegment(levelFor(fishOcean * invHot, factor), sx, sy, lpX + left, lpY + f.top);
      }
    }
  }

  // The fish streaks for the still frame: each traced forward STILL_STEPS
  // steps, fading toward its tail, like drawStill() does for the ocean.
  function stillFish(k, invHot, fadePerStep) {
    if (fishVis === 0) return;
    const floor = fishFloor * unit;
    for (let q = 0; q < fishes.length; q++) {
      const f = fishes[q];
      const L = f.lines;
      const S = f.streaks;
      for (let i = 0; i < S.n; i++) {
        const line = S.line[i];
        const last = L.lens[line] - 1;
        let pos = S.pos[i];
        linePoint(L, line, pos, S.off[i]);
        let x = lpX;
        let y = lpY;
        const left = screenLeft(f, x);
        for (let s = 0; s < STILL_STEPS; s++) {
          pos += fishStep(x + left, y + f.top, k, floor);
          if (pos >= last) {
            // Past the line's end: carry on from its beginning, as a live
            // streak would, with no piece drawn across the jump.
            pos = Math.min(pos - last, last - 1e-3);
            linePoint(L, line, pos, S.off[i]);
            x = lpX;
            y = lpY;
            continue;
          }
          linePoint(L, line, pos, S.off[i]);
          const sy = y + f.top;
          let fade = Math.pow(fadePerStep, STILL_STEPS - 1 - s) * lpW * fishShade;
          if (sy < topClear || sy > bottomClear) fade *= bandKeep(sy, NAV_STREAK_KEEP, BOTTOM_STREAK_KEEP);
          pushSegment(levelFor(fishOcean * invHot, fade), x + left, sy, lpX + left, lpY + f.top);
          x = lpX;
          y = lpY;
        }
      }
    }
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
    px[i] = random() * cssW;
    py[i] = random() * cssH;
    life[i] = LIFE_MIN + random() * (LIFE_MAX - LIFE_MIN);
    age[i] = anyAge ? random() * life[i] : 0;
  }

  // Streak opacity from its speed (0 to 1 of HOT_SPEED) and a factor for
  // its fade-in, the dimmed bands and the fish, as one of ALPHA_LEVELS
  // batches (-1 for none).
  function levelFor(s, factor) {
    const a = (STREAK_ALPHA_MIN + (STREAK_ALPHA_MAX - STREAK_ALPHA_MIN) * Math.sqrt(s > 1 ? 1 : s)) * factor;
    return Math.min(ALPHA_LEVELS - 1, Math.round((a / STREAK_ALPHA_MAX) * ALPHA_LEVELS) - 1);
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

  // Moves every ocean streak one step and queues the piece it just drew.
  // Its opacity comes from the ocean's speed. Inside a fish it is drawn
  // fainter by the fish's cover there, and the fish's own streaks make up
  // the rest (see stepFish).
  function stepParticles(dt) {
    const k = dt * SPEED;
    const invHot = 1 / (HOT_SPEED * unit);
    const hiding = fishVis > 0 && fishes.length > 0;
    segCount.fill(0);
    for (let i = 0; i < count; i++) {
      const a = age[i] + dt;
      if (a > life[i]) {
        respawn(i, false);
        continue;
      }
      age[i] = a;
      const x = px[i];
      const y = py[i];
      sampleOcean(x, y);
      const nx = x + su * k;
      const ny = y + sv * k;
      if (nx < -10 || ny < -10 || nx > cssW + 10 || ny > cssH + 10) {
        respawn(i, false);
        continue;
      }
      px[i] = nx;
      py[i] = ny;
      const s = Math.sqrt(su * su + sv * sv) * invHot;
      let factor = a < BIRTH_S ? a / BIRTH_S : 1;
      if (y < topClear || y > bottomClear) factor *= bandKeep(y, NAV_STREAK_KEEP, BOTTOM_STREAK_KEEP);
      if (hiding) factor *= 1 - coverAt(x, y);
      pushSegment(levelFor(s, factor), x, y, nx, ny);
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
  // canvas, the trails over them with the "screen" blend, then the dark
  // patch behind the title.
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
    if (CENTER_DIM > 0) {
      const d = dimBox;
      ctx.setTransform(d.rx * dpr, 0, 0, d.ry * dpr, d.x * dpr, d.y * dpr);
      ctx.fillStyle = dimFill;
      ctx.fillRect(-1, -1, 2, 2);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
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
    const hiding = fishVis > 0 && fishes.length > 0;
    segCount.fill(0);
    for (let i = 0; i < count; i++) {
      let x = px[i];
      let y = py[i];
      for (let q = 0; q < STILL_STEPS; q++) {
        sampleOcean(x, y);
        const nx = x + su * k;
        const ny = y + sv * k;
        const s = Math.sqrt(su * su + sv * sv) * invHot;
        let fade = Math.pow(fadePerStep, STILL_STEPS - 1 - q);
        if (y < topClear || y > bottomClear) fade *= bandKeep(y, NAV_STREAK_KEEP, BOTTOM_STREAK_KEEP);
        if (hiding) fade *= 1 - coverAt(x, y);
        pushSegment(levelFor(s, fade), x, y, nx, ny);
        x = nx;
        y = ny;
      }
      if (x < -10 || y < -10 || x > cssW + 10 || y > cssH + 10) respawn(i, true);
      else {
        px[i] = x;
        py[i] = y;
      }
    }
    stillFish(k, invHot, fadePerStep);
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
  // there and blurred a little, then scaled up smoothly by composite(). The
  // fish never change the water's speed, so this reads the ocean alone.
  // Behind the nav and at the bottom edge only a share of the speed counts
  // (overlayKeep).
  function drawOverlay() {
    const d = overlayImg.data;
    const top = rampLut.length / 3 - 1;
    let o = 0;
    for (let j = 0; j < oh; j++) {
      const y = (j - OVERLAY_MARGIN + 0.5) * OVERLAY_CELL;
      const scale = (top * overlayKeep[j]) / (HOT_SPEED * unit);
      for (let i = 0; i < ow; i++) {
        const x = (i - OVERLAY_MARGIN + 0.5) * OVERLAY_CELL;
        sampleOcean(x, y);
        let q = (Math.sqrt(su * su + sv * sv) * scale) | 0;
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
    if (gap < (phone ? PHONE_MIN_FRAME_MS : MIN_FRAME_MS)) return;
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
    moveFish(animT);
    fadeTrails(dt);
    stepParticles(dt);
    stepFish(dt);
    drawSegments();
    overlayWait -= 1;
    if (overlayWait <= 0) {
      overlayWait = OVERLAY_EVERY;
      drawOverlay();
    }
    composite();
    const ms = performance.now() - started;
    checkSpeed(ms);
    report(ms, false);
  }

  // The slow start check. Over the first SLOW_CHECK_S seconds of motion it
  // adds up how long each frame's work took. If the average is more than
  // FRAME_BUDGET of the time between frames (16.7 ms, or 33.3 ms on a
  // phone), the streak count is cut so the work fits. It checks again a
  // second later, SLOW_CHECKS times in all.
  function checkSpeed(ms) {
    if (checksLeft <= 0) return;
    costSum += ms;
    costFrames += 1;
    if (animT < checkAt) return;
    const average = costSum / costFrames;
    const budget = (phone ? 1000 / 30 : 1000 / 60) * FRAME_BUDGET;
    if (average > budget && count > MIN_PARTICLES) {
      const keep = clamp((budget / average) * 0.9, 0.2, 0.95);
      particleShare *= keep;
      cutParticles(Math.max(MIN_PARTICLES, Math.round(count * keep)));
      cut = true;
    }
    checksLeft -= 1;
    checkAt = animT + SLOW_CHECK_S;
    costSum = 0;
    costFrames = 0;
  }

  // Keeps the first n streaks and drops the rest.
  function cutParticles(n) {
    if (n >= count) return;
    count = n;
    px = px.slice(0, n);
    py = py.slice(0, n);
    age = age.slice(0, n);
    life = life.slice(0, n);
    for (const f of fishes) sizeFishStreaks(f);
  }

  // The first frame after a start or a size change, and the only frame with
  // reduced motion (which shows the fish at their starting places).
  function drawFirst() {
    if (!ready()) return;
    const started = performance.now();
    blendFlow(animT);
    moveFish(reduced ? startT : animT);
    drawStill();
    drawOverlay();
    composite();
    overlayWait = OVERLAY_EVERY;
    drewOnce = true;
    report(performance.now() - started, true);
  }

  function report(ms, still) {
    frameNo += 1;
    if (onFrame) {
      onFrame({
        frame: frameNo, ms, particles: count,
        width: cssW, height: cssH, dpr, still, cut,
        fish: fishes.map((f) => ({ x: Math.round(f.x), y: Math.round(f.y), w: Math.round(f.w), h: Math.round(f.h) })),
      });
    }
  }

  // Size and text box changes are handled once per animation frame at most.
  function queueLayout() {
    if (layoutQueued || stopped) return;
    layoutQueued = requestAnimationFrame(() => {
      layoutQueued = 0;
      if (stopped) return;
      const changed = layout();
      if ((changed || !drewOnce) && ready()) {
        if (drewOnce) {
          drawFirst();   // a resize: draw at once, so the water never blinks dark
        } else {
          // A first frame waits for the next animation frame, so the layout
          // and it are two shorter tasks instead of one long one. On a
          // first load the hero is still plain near-black meanwhile.
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
  if (textBox) resizeObserver?.observe(textBox);
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
  reduced = forceStill || (motionQuery?.matches ?? false);
  const onMotionChange = () => {
    const was = reduced;
    reduced = forceStill || motionQuery.matches;
    sync();
    if (reduced && !was) drawFirst();   // settle on one calm still frame
  };
  if (motionQuery?.addEventListener) motionQuery.addEventListener('change', onMotionChange);
  else motionQuery?.addListener?.(onMotionChange);

  // The tuna's path and its anatomy field. Until the field is ready (or
  // FISH_WAIT_MS passes) no water is drawn, so the first frame already has
  // the fish in it. The hero stays plain near-black meanwhile. With
  // FISH_VISIBILITY at 0 there are no fish, so none of this happens.
  let fishTimer = 0;
  if (fishVis === 0) {
    fishState = 'off';
  } else {
    fishTimer = setTimeout(() => {
      if (fishState === 'loading') {
        fishState = 'failed';
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
        return runInSlices(fishFieldSteps(d), () => stopped);
      })
      .then((built) => {
        if (!built || stopped) return;   // stopped meanwhile
        field = built;
        fishState = 'ready';
        // Fish that arrive after the water started redraw the first frame
        // with them in it.
        drewOnce = false;
        textNow = null;   // so layout() places the fish
      })
      .catch((err) => {
        console.warn('Flight Console: the fish did not load, so the currents run without them', err);
        fishState = 'failed';
      })
      .finally(() => {
        clearTimeout(fishTimer);
        if (!stopped) queueLayout();
      });
  }

  // The first layout waits for the next animation frame, so it isn't added
  // to the task that started the page. The canvas is near-black until then.
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
// The fish's anatomy field
// ------------------------------------------------------------------

// The whole field at once, from the tuna's path data. For tests. The page
// uses fishFieldSteps() through runInSlices().
export function buildFishField(d) {
  return runNow(fishFieldSteps(d));
}

// ------------------------------------------------------------------
// The fish's flow lines
// ------------------------------------------------------------------

// The lines the water follows inside one fish, traced through the anatomy
// field F (from fishFieldSteps) for a tuna w CSS px wide, in CSS px from
// the corner of its patch (which reaches margin px past the tuna's box).
// Neighboring lines sit about gap px apart. The fish's streaks run along
// them (see stepFish), so the whole fish is one flow that never meets
// itself head on.
//   1. Seeds are tried all over the fish in a shuffled order. A seed that
//      is inside the fish and at least a gap from every line so far starts
//      a new line.
//   2. The line is traced both ways from its seed, one FLOW_STEP at a time
//      (a midpoint step, so it bends smoothly). The field's lines have no
//      forward, so each step keeps going the way the last one went. It
//      stops where the fish fades out, at the eye, or when it comes within
//      half a gap of another line (so lines that squeeze together, as they
//      do toward the tail, end instead of piling up).
//   3. The finished line is turned to run from nose to tail (or downward,
//      where it runs straight across the fish, as on the gill arc).
//   4. The eye gets its own lines: a few arms that wind inward like water
//      going down a drain, so streaks circle there.
// Returns { pts, starts, lens, cum, count, total, gap, eyeFrom }:
//   pts     every point of every line, five numbers each: x, y, the side
//           direction (nx, ny, 1 long) and the fish's weight there
//   starts  where each line's first point is in pts (in points)
//   lens    how many points each line has
//   cum     the total length of the lines up to and including each one
//   count, total   how many lines and how long they are in all (CSS px)
//   eyeFrom the first of the eye's lines (they come last)
// Exported for tests.
export function traceFishLines(F, w, margin, gap, seed = 1) {
  const random = mulberry32((seed * 7919) ^ 0x5bd1e995);
  const scale = w / TUNA_BOX.w;          // CSS px per logo unit
  const unitPx = FIELD_UNIT * scale;     // CSS px per field cell
  const fieldPad = FIELD_PAD * unitPx;
  const spanW = w + 2 * margin;
  const spanH = (w * TUNA_BOX.h) / TUNA_BOX.w + 2 * margin;
  const h = FLOW_STEP;
  // Patch px to field cells (cell centers are at whole numbers).
  const toCell = (v) => (v - margin + fieldPad) / unitPx - 0.5;

  // The eye and the plain nose to tail direction, in patch px. The field is
  // mirrored, so a logo x becomes (box right edge) - x.
  const eyeX = (F.eye.x + 0.5) * unitPx - fieldPad + margin;
  const eyeY = (F.eye.y + 0.5) * unitPx - fieldPad + margin;
  const eyeR = F.eye.r * unitPx;
  const eyeReach = eyeR * EYE_REACH;
  const noseX = (TUNA_BOX.x + TUNA_BOX.w - TUNA_NOSE.x) * scale + margin;
  const noseY = (TUNA_NOSE.y - TUNA_BOX.y) * scale + margin;
  const tailX = (TUNA_BOX.x + TUNA_BOX.w - TUNA_TAIL.x) * scale + margin;
  const tailY = (TUNA_TAIL.y - TUNA_BOX.y) * scale + margin;
  const axisLen = Math.hypot(tailX - noseX, tailY - noseY);
  const axisX = (tailX - noseX) / axisLen;
  const axisY = (tailY - noseY) / axisLen;

  // The fish's weight at a point, read smoothly between cells (0 outside
  // the field).
  function weightAt(x, y) {
    const gx = toCell(x);
    const gy = toCell(y);
    if (gx < 0 || gy < 0 || gx >= F.cols - 1 || gy >= F.rows - 1) return 0;
    const i = gx | 0;
    const j = gy | 0;
    const fx = gx - i;
    const fy = gy - j;
    const k = j * F.cols + i;
    const W = F.weight;
    return (W[k] * (1 - fx) + W[k + 1] * fx) * (1 - fy) + (W[k + F.cols] * (1 - fx) + W[k + F.cols + 1] * fx) * fy;
  }

  // The field's line at a point, as a direction 1 long that goes the same
  // way as (rx, ry). Each of the four cells around the point is turned to
  // agree with (rx, ry) before they are mixed, since a line has no
  // forward. Writes dX, dY.
  let dX = 0;
  let dY = 0;
  function dirAt(x, y, rx, ry) {
    const gx = clamp(toCell(x), 0, F.cols - 1.001);
    const gy = clamp(toCell(y), 0, F.rows - 1.001);
    const i = gx | 0;
    const j = gy | 0;
    const fx = gx - i;
    const fy = gy - j;
    let sx = 0;
    let sy = 0;
    const add = (k, wt) => {
      let a = F.dirX[k];
      let b = F.dirY[k];
      if (a * rx + b * ry < 0) {
        a = -a;
        b = -b;
      }
      sx += a * wt;
      sy += b * wt;
    };
    const k = j * F.cols + i;
    add(k, (1 - fx) * (1 - fy));
    add(k + 1, fx * (1 - fy));
    add(k + F.cols, (1 - fx) * fy);
    add(k + F.cols + 1, fx * fy);
    const len = Math.hypot(sx, sy);
    if (len < 1e-6) {
      dX = rx;
      dY = ry;
    } else {
      dX = sx / len;
      dY = sy / len;
    }
  }

  // Every line's points so far, in buckets a gap wide, for "is any line
  // near here?". Each point remembers its line and its step along it, so
  // a line doesn't stop at its own last few points.
  const bw = Math.ceil(spanW / gap) + 1;
  const bh = Math.ceil(spanH / gap) + 1;
  const buckets = Array.from({ length: bw * bh }, () => []);
  function near(x, y, d, line, step) {
    const d2 = d * d;
    const bi = Math.floor(x / gap);
    const bj = Math.floor(y / gap);
    const lag = (2 * gap) / h;
    for (let j = Math.max(0, bj - 1); j <= Math.min(bh - 1, bj + 1); j++) {
      for (let i = Math.max(0, bi - 1); i <= Math.min(bw - 1, bi + 1); i++) {
        const b = buckets[j * bw + i];
        for (let q = 0; q < b.length; q += 4) {
          if (b[q + 2] === line && Math.abs(b[q + 3] - step) < lag) continue;
          const ex = b[q] - x;
          const ey = b[q + 1] - y;
          if (ex * ex + ey * ey < d2) return true;
        }
      }
    }
    return false;
  }
  let touched = [];   // the buckets the line being traced has marked
  function mark(x, y, line, step) {
    const i = clamp(Math.floor(x / gap), 0, bw - 1);
    const j = clamp(Math.floor(y / gap), 0, bh - 1);
    buckets[j * bw + i].push(x, y, line, step);
    touched.push(j * bw + i);
  }
  // Takes a line that turned out too short back out of the buckets.
  function unmark(line) {
    for (const k of new Set(touched)) {
      const b = buckets[k];
      for (let q = b.length - 4; q >= 0; q -= 4) {
        if (b[q + 2] === line) b.splice(q, 4);
      }
    }
  }
  const inEye = (x, y) => (x - eyeX) ** 2 + (y - eyeY) ** 2 < eyeReach * eyeReach;

  // Traces one way from (x, y), first going (rx, ry), marking its points
  // as it goes. Returns the points as a flat array.
  const maxSteps = Math.ceil((FLOW_MAX_WIDTHS * w) / h);
  function trace(x, y, rx, ry, line, dirSign) {
    const out = [];
    for (let n = 1; n <= maxSteps; n++) {
      dirAt(x, y, rx, ry);
      const ax = dX;
      const ay = dY;
      dirAt(x + (ax * h) / 2, y + (ay * h) / 2, ax, ay);
      const nx = x + dX * h;
      const ny = y + dY * h;
      if (weightAt(nx, ny) < FLOW_END_WEIGHT || inEye(nx, ny) || near(nx, ny, gap * 0.5, line, n * dirSign)) break;
      out.push(nx, ny);
      mark(nx, ny, line, n * dirSign);
      x = nx;
      y = ny;
      rx = dX;
      ry = dY;
    }
    return out;
  }

  // 1. The seeds: a jittered grid half a gap apart, shuffled.
  const seeds = [];
  for (let y = gap / 4; y < spanH; y += gap / 2) {
    for (let x = gap / 4; x < spanW; x += gap / 2) {
      seeds.push(x + (random() - 0.5) * gap * 0.4, y + (random() - 0.5) * gap * 0.4);
    }
  }
  for (let q = seeds.length / 2 - 1; q > 0; q--) {
    const r = Math.floor(random() * (q + 1));
    for (let c = 0; c < 2; c++) {
      const tmp = seeds[q * 2 + c];
      seeds[q * 2 + c] = seeds[r * 2 + c];
      seeds[r * 2 + c] = tmp;
    }
  }

  // 2 and 3. The lines.
  const lines = [];
  for (let q = 0; q < seeds.length; q += 2) {
    const sx = seeds[q];
    const sy = seeds[q + 1];
    if (weightAt(sx, sy) < FLOW_SEED_WEIGHT || inEye(sx, sy)) continue;
    const id = lines.length;
    if (near(sx, sy, gap * 0.9, -1, 0)) continue;
    dirAt(sx, sy, axisX, axisY);
    const fx = dX;
    const fy = dY;
    touched = [];
    mark(sx, sy, id, 0);
    const ahead = trace(sx, sy, fx, fy, id, 1);
    const behind = trace(sx, sy, -fx, -fy, id, -1);
    const n = 1 + (ahead.length + behind.length) / 2;
    if ((n - 1) * h < FLOW_MIN_GAPS * gap) {
      unmark(id);
      continue;
    }
    // Put it together from the far end behind the seed to the far end
    // ahead of it.
    const xy = new Float32Array(n * 2);
    let o = 0;
    for (let p = behind.length - 2; p >= 0; p -= 2) {
      xy[o++] = behind[p];
      xy[o++] = behind[p + 1];
    }
    xy[o++] = sx;
    xy[o++] = sy;
    for (let p = 0; p < ahead.length; p++) xy[o++] = ahead[p];
    // Nose to tail, or downward where it runs across the fish.
    const netX = xy[n * 2 - 2] - xy[0];
    const netY = xy[n * 2 - 1] - xy[1];
    let score = netX * axisX + netY * axisY;
    if (Math.abs(score) < 0.2 * Math.hypot(netX, netY)) score = netY;
    lines.push(score < 0 ? reversePoints(xy) : xy);
  }

  // 4. The eye's whirlpool: arms that wind in from the edge of its reach,
  //    about a gap apart, turning the way that runs toward the tail along
  //    the top of the eye.
  const eyeFrom = lines.length;
  const inner = Math.max(1, eyeReach * 0.12);
  const pitch = (eyeReach - inner) / EYE_TURNS;
  const arms = Math.max(1, Math.round(pitch / gap));
  const turnSign = axisX < 0 ? -1 : 1;
  const sweep = Math.PI * 2 * EYE_TURNS;
  for (let a = 0; a < arms; a++) {
    const xy = [];
    let t = 0;
    while (t <= sweep) {
      const r = eyeReach - ((eyeReach - inner) * t) / sweep;
      const ang = (Math.PI * 2 * a) / arms + turnSign * t;
      xy.push(eyeX + r * Math.cos(ang), eyeY + r * Math.sin(ang));
      t += h / Math.max(r, 1);
    }
    if (xy.length >= 6) lines.push(Float32Array.from(xy));
  }

  // The flat arrays the streaks read.
  let points = 0;
  for (const xy of lines) points += xy.length / 2;
  const pts = new Float32Array(points * 5);
  const starts = new Int32Array(lines.length);
  const lens = new Int32Array(lines.length);
  const cum = new Float32Array(lines.length);
  let at = 0;
  let total = 0;
  lines.forEach((xy, l) => {
    const m = xy.length / 2;
    starts[l] = at;
    lens[l] = m;
    for (let q = 0; q < m; q++) {
      const a = Math.max(0, q - 2);
      const b = Math.min(m - 1, q + 2);
      const tx = xy[b * 2] - xy[a * 2];
      const ty = xy[b * 2 + 1] - xy[a * 2 + 1];
      const len = Math.hypot(tx, ty) || 1;
      const o = (at + q) * 5;
      pts[o] = xy[q * 2];
      pts[o + 1] = xy[q * 2 + 1];
      pts[o + 2] = -ty / len;
      pts[o + 3] = tx / len;
      pts[o + 4] = weightAt(xy[q * 2], xy[q * 2 + 1]);
    }
    at += m;
    total += (m - 1) * h;
    cum[l] = total;
  });
  return { pts, starts, lens, cum, count: lines.length, total, gap, eyeFrom };
}

// The same points, last to first.
function reversePoints(xy) {
  const n = xy.length / 2;
  const out = new Float32Array(xy.length);
  for (let q = 0; q < n; q++) {
    out[q * 2] = xy[(n - 1 - q) * 2];
    out[q * 2 + 1] = xy[(n - 1 - q) * 2 + 1];
  }
  return out;
}

// Makes the anatomy field from the tuna's path data (the d of the logo's
// path). It is a grid of cells FIELD_UNIT logo units wide over the tuna's
// box plus FIELD_PAD cells on every side, mirrored so the fish faces right:
//   dirX, dirY  the line the water inside the fish follows there (1 long),
//               turned toward the tail where it can be
//   weight      how much of that line to use, 0 outside the fish and 1 well
//               inside it, with a soft edge between
//   eye         the eye's center, radius and reach, in field cells
// A generator: it yields between its big steps so runInSlices() can spread
// the work over several tasks, and returns
// { cols, rows, dirX, dirY, weight, eye }.
function* fishFieldSteps(d) {
  const U = FIELD_UNIT;
  const pad = FIELD_PAD * U;
  const flipAt = 2 * TUNA_BOX.x + TUNA_BOX.w;   // x becomes flipAt - x, which mirrors the fish in its own box
  const ox = TUNA_BOX.x - pad;                  // the field's corner, in logo units
  const oy = TUNA_BOX.y - pad;
  const polys = parsePolygons(d).map((p) => {
    const m = new Float64Array(p.length);
    for (let q = 0; q < p.length; q += 2) {
      m[q] = flipAt - p[q];
      m[q + 1] = p[q + 1];
    }
    return m;
  });

  // 1. The solid fish at one pixel per logo unit: the path filled with the
  //    evenodd rule (so the logo's holes come out empty), then solidify()
  //    closes the holes.
  const W = TUNA_BOX.w + 2 * pad;
  const H = TUNA_BOX.h + 2 * pad;
  const ink = fillEvenOdd(polys, W, H, ox, oy);
  yield;
  const solid = yield* solidify(ink, W, H, FISH_SEAL);

  // 2. The field's grid. A cell is fish when at least half of its pixels
  //    are. Its signed distance to the outline (in logo units, positive
  //    inside) sets the weight.
  const cols = Math.ceil(W / U);
  const rows = Math.ceil(H / U);
  const n = cols * rows;
  const inside = new Uint8Array(n);
  const outside = new Uint8Array(n);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let fish = 0;
      let all = 0;
      for (let y = j * U; y < Math.min(H, (j + 1) * U); y++) {
        for (let x = i * U; x < Math.min(W, (i + 1) * U); x++) {
          fish += solid[y * W + x];
          all += 1;
        }
      }
      const k = j * cols + i;
      inside[k] = fish * 2 >= all ? 1 : 0;
      outside[k] = 1 - inside[k];
    }
  }
  yield;
  const toOutside = runNow(distanceSquaredSteps(outside, cols, rows));
  const toInside = runNow(distanceSquaredSteps(inside, cols, rows));
  const weight = new Float32Array(n);
  const sd = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    sd[k] = inside[k] ? (Math.sqrt(toOutside[k]) - 0.5) * U : -(Math.sqrt(toInside[k]) - 0.5) * U;
    weight[k] = smoothstep(-FEATHER_OUT, FEATHER_IN, sd[k]);
  }
  yield;

  // The plain nose to tail direction at a point: toward a spot far behind
  // the tail, on the line from the nose through the tail stalk.
  const nose = { x: flipAt - TUNA_NOSE.x, y: TUNA_NOSE.y };
  const tail = { x: flipAt - TUNA_TAIL.x, y: TUNA_TAIL.y };
  const axisLen = Math.hypot(tail.x - nose.x, tail.y - nose.y);
  const behind = {
    x: tail.x + ((tail.x - nose.x) / axisLen) * 700,
    y: tail.y + ((tail.y - nose.y) / axisLen) * 700,
  };
  const axisX = new Float32Array(n);
  const axisY = new Float32Array(n);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const ax = behind.x - (ox + (i + 0.5) * U);
      const ay = behind.y - (oy + (j + 0.5) * U);
      const len = Math.hypot(ax, ay) || 1;
      axisX[k] = ax / len;
      axisY[k] = ay / len;
    }
  }

  // 3. The lines. Each piece of the logo (except the specks and the eye,
  //    which gets its own whirlpool) is walked in LINE_STEP steps. The
  //    direction at each point comes from the points LINE_REACH steps either
  //    side (the logo's outlines are traced pixel by pixel, so neighbors
  //    alone would zigzag). A line has no "forward" yet, so it is kept as
  //    a doubled angle, (cos 2a, sin 2a), which is the same for a and for
  //    a turned around. Each point adds that to the cell it falls in.
  const eye = { x: flipAt - TUNA_EYE.x, y: TUNA_EYE.y, r: TUNA_EYE.r };
  const sumC = new Float32Array(n);
  const sumS = new Float32Array(n);
  const hits = new Uint16Array(n);
  for (const p of polys) {
    if (Math.abs(polygonArea(p)) < MIN_LINE_AREA) continue;
    const c = polygonCenter(p);
    if (Math.hypot(c.x - eye.x, c.y - eye.y) < eye.r * 1.3) continue;
    const pts = resample(p, LINE_STEP);
    const m = pts.length / 2;
    if (m < 2 * LINE_REACH + 1) continue;
    for (let q = 0; q < m; q++) {
      const a = ((q - LINE_REACH) % m + m) % m;
      const b = (q + LINE_REACH) % m;
      const tx = pts[b * 2] - pts[a * 2];
      const ty = pts[b * 2 + 1] - pts[a * 2 + 1];
      const len2 = tx * tx + ty * ty;
      if (len2 < 1e-9) continue;
      const i = Math.floor((pts[q * 2] - ox) / U);
      const j = Math.floor((pts[q * 2 + 1] - oy) / U);
      if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
      const k = j * cols + i;
      sumC[k] += (tx * tx - ty * ty) / len2;
      sumS[k] += (2 * tx * ty) / len2;
      hits[k] += 1;
    }
  }
  // A cell where the lines agree keeps their angle fixed. A cell where they
  // cross at right angles cancels out and is left free.
  const axisC = new Float32Array(n);
  const axisS = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    axisC[k] = axisX[k] * axisX[k] - axisY[k] * axisY[k];
    axisS[k] = 2 * axisX[k] * axisY[k];
  }
  const vc = new Float32Array(axisC);
  const vs = new Float32Array(axisS);
  const fixed = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (!hits[k]) continue;
    const mc = sumC[k] / hits[k];
    const ms = sumS[k] / hits[k];
    const len = Math.hypot(mc, ms);
    if (len < 0.35) continue;
    vc[k] = mc / len;
    vs[k] = ms / len;
    fixed[k] = 1;
  }
  yield;

  // 4. Spread the lines' angles over the fish: each free cell becomes the
  //    average of its four neighbors, pulled a little toward the plain nose
  //    to tail direction, over and over (Gauss-Seidel with over-relaxation).
  //    Only cells near the fish take part.
  const free = [];
  for (let j = 1; j < rows - 1; j++) {
    for (let i = 1; i < cols - 1; i++) {
      const k = j * cols + i;
      if (!fixed[k] && sd[k] > -(FEATHER_OUT + 2 * U)) free.push(k);
    }
  }
  const list = Int32Array.from(free);
  const pull = AXIS_PULL;
  for (let pass = 0; pass < SPREAD_PASSES; pass++) {
    for (let q = 0; q < list.length; q++) {
      const k = list[q];
      const tc = (vc[k - 1] + vc[k + 1] + vc[k - cols] + vc[k + cols] + pull * axisC[k]) / (4 + pull);
      const ts = (vs[k - 1] + vs[k + 1] + vs[k - cols] + vs[k + cols] + pull * axisS[k]) / (4 + pull);
      vc[k] += SPREAD_OMEGA * (tc - vc[k]);
      vs[k] += SPREAD_OMEGA * (ts - vs[k]);
    }
    if (pass % 30 === 29) yield;
  }
  // 5. Back from doubled angles to directions 1 long. A small share of the
  //    plain direction settles the cells where the lines cancelled out.
  //    The sign is turned toward the tail, which is where the flow lines
  //    start tracing from (see traceFishLines).
  const dirX = new Float32Array(n);
  const dirY = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const c2 = vc[k] + 0.05 * axisC[k];
    const s2 = vs[k] + 0.05 * axisS[k];
    const half = Math.atan2(s2, c2) / 2;
    let x = Math.cos(half);
    let y = Math.sin(half);
    if (x * axisX[k] + y * axisY[k] < 0) {
      x = -x;
      y = -y;
    }
    dirX[k] = x;
    dirY[k] = y;
  }

  // 6. The eye's center and radius, in field cells, for its whirlpool.
  const eyeAt = { x: (eye.x - ox) / U - 0.5, y: (eye.y - oy) / U - 0.5, r: eye.r / U };
  return { cols, rows, dirX, dirY, weight, eye: eyeAt };
}

// The path data's pieces as flat [x0, y0, x1, y1, ...] arrays. It reads the
// absolute M, L and Z commands only, which is all the logo uses.
function parsePolygons(d) {
  const out = [];
  let cur = null;
  const tokens = d.match(/[MLZmlz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  let q = 0;
  while (q < tokens.length) {
    const t = tokens[q];
    if (t === 'M' || t === 'm') {
      cur = [];
      out.push(cur);
      q += 1;
    } else if (t === 'L' || t === 'l') {
      q += 1;
    } else if (t === 'Z' || t === 'z') {
      cur = null;
      q += 1;
    } else {
      if (!cur) {
        cur = [];
        out.push(cur);
      }
      cur.push(Number(t), Number(tokens[q + 1]));
      q += 2;
    }
  }
  return out.filter((p) => p.length >= 6);
}

// Fills the polygons with the evenodd rule into a W by H mask (1 for ink),
// one pixel per unit, with pixel (0, 0) at (ox, oy). A pixel is ink when its
// center is.
function fillEvenOdd(polys, W, H, ox, oy) {
  const ink = new Uint8Array(W * H);
  let xs = new Float64Array(256);
  for (let row = 0; row < H; row++) {
    const y = oy + row + 0.5;
    let n = 0;
    for (const p of polys) {
      const m = p.length / 2;
      for (let a = m - 1, b = 0; b < m; a = b++) {
        const y0 = p[a * 2 + 1];
        const y1 = p[b * 2 + 1];
        if ((y0 > y) === (y1 > y)) continue;
        if (n >= xs.length) {
          const bigger = new Float64Array(xs.length * 2);
          bigger.set(xs);
          xs = bigger;
        }
        const x0 = p[a * 2];
        xs[n++] = x0 + ((y - y0) / (y1 - y0)) * (p[b * 2] - x0);
      }
    }
    const hits = xs.subarray(0, n).sort();
    for (let q = 0; q + 1 < n; q += 2) {
      const from = Math.max(0, Math.ceil(hits[q] - ox - 0.5));
      const to = Math.min(W, Math.ceil(hits[q + 1] - ox - 0.5));
      for (let x = from; x < to; x++) ink[row * W + x] = 1;
    }
  }
  return ink;
}

// Points every step units along a closed polygon, as a flat array.
function resample(p, step) {
  const m = p.length / 2;
  const out = [];
  let carry = 0;
  for (let a = 0; a < m; a++) {
    const b = (a + 1) % m;
    const x0 = p[a * 2];
    const y0 = p[a * 2 + 1];
    const dx = p[b * 2] - x0;
    const dy = p[b * 2 + 1] - y0;
    const len = Math.hypot(dx, dy);
    let s = carry;
    while (s < len) {
      out.push(x0 + (dx * s) / len, y0 + (dy * s) / len);
      s += step;
    }
    carry = s - len;
  }
  return out;
}

// Signed area by the shoelace formula (the sign depends on which way it runs).
function polygonArea(p) {
  const m = p.length / 2;
  let sum = 0;
  for (let a = m - 1, b = 0; b < m; a = b++) sum += p[a * 2] * p[b * 2 + 1] - p[b * 2] * p[a * 2 + 1];
  return sum / 2;
}

// The average of a polygon's corners.
function polygonCenter(p) {
  let x = 0;
  let y = 0;
  for (let q = 0; q < p.length; q += 2) {
    x += p[q];
    y += p[q + 1];
  }
  return { x: (x * 2) / p.length, y: (y * 2) / p.length };
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

// 0 below a, 1 above b, and a smooth S curve between.
function smoothstep(a, b, v) {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// v moved into [0, size) by adding or taking whole sizes.
function wrap(v, size) {
  return ((v % size) + size) % size;
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

// 1 for fish, 0 for water, from the ink mask (1 for ink). Starting from
// every open pixel on the border, the outside fills through open pixels,
// and whatever it can't reach is fish, holes included.
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
function* solidify(ink, W, H, seal) {
  const n = W * H;
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
// marked node, by Felzenszwalb and Huttenlocher's two-pass method (one pass
// down the columns, one along the rows). A generator that yields between
// its two passes, and every SLICE_CELLS cells or so within each.
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
