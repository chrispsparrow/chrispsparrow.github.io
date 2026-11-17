// hero-currents.js
// The moving ocean currents behind the landing's hero at /flight-console/,
// drawn on Canvas 2D in the style of earth.nullschool.net and colored like
// a thermal camera. The currents are made up, not real data. Thousands of
// warm white streaks ride a flow field over a soft "ironbow" speed color:
// near-black where the water is still, then purple and red, up to pale
// yellow in the fastest jets.
//
// Two Dogtooth tuna swim slowly through the water, both facing right. They
// are camouflaged: nothing is filled or outlined, and the speed colors
// under a fish are the ocean's. A fish shows as a finer texture than the
// currents around it (more streaks, thinner and slower, with short trails),
// with a crisp edge traced by streaks that run along the outline, and its
// anatomy mapped from the logo's line art: the teeth in short zigzag
// streaks, a whirlpool with a calm middle at the eye, streaks curving round
// the gill arcs, fanning back from the pectoral fin's base and running up
// into the fins' points, the finlets, one strong stripe along the body and
// the flow splitting into the forked tail. Streaks on those lines are drawn
// a little brighter. FISH_VISIBILITY sets how easy the fish are to find,
// from hidden to obvious.
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
//                   particles, budget, fishStreaks, width, height, dpr,
//                   still, cut, fish } (for tests). ms is the time the
//                   frame's work took, particles the open ocean's streaks,
//                   budget all the streaks and fishStreaks the fish's share
//                   of them, cut is true once the slow start check has cut
//                   the streaks, and fish lists each fish's box in CSS px.
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
//        gives the solid outline, and the distance to it (inside and out)
//        gives a weight that is 0 just outside the fish and 1 just inside
//        it, so the edge is crisp. The logo's inside lines are where ink
//        meets a gap within the solid fish.
//     2. Every line in the logo gives its direction to the grid cells it
//        crosses. In a thin band inside the outline the water runs along
//        the outline. In the fins it runs into their points, it fans back
//        from the pectoral fin's base, and past the tail stalk it splits
//        toward the two lobes (the regions are mapped by hand, see
//        TUNA_FINS). A line has no forward, so it is kept as a doubled
//        angle.
//     3. Those directions are spread over the rest of the fish by averaging
//        each cell with its neighbors many times, with a gentle pull toward
//        the plain nose to tail direction where no line is near.
//     4. A glow map says how much brighter the streaks are along the
//        logo's inside lines and the outline (most at the teeth and the
//        finlets), and a pace map slows the teeth's streaks.
//   Both fish share that one field (it is the same at every size). For
//   each fish size, flow lines are traced through it a fine gap apart: two
//   that follow the outline, the lateral stripe, lines seeded all over the
//   body, and arms that wind in to the eye (see traceFishLines).
//   The fish take their streaks from the same budget as the ocean, about
//   FISH_DENSITY times as many per area, so the page draws no more streaks
//   than before (see balanceStreaks). They run along the fish's lines and
//   never leave it (see stepFish), thinner and slower than the ocean's, and
//   take their opacity from the ocean's speed right where they are, so they
//   match the water around them. Where a fish is, the ocean's streaks are
//   drawn fainter by the fish's pull (see coverAt) and not at all deep
//   inside, but they carry on through, so the water behind a fish isn't
//   left emptier. FISH_VISIBILITY moves the density, pace, width and glow
//   from the ocean's toward the fish's settings (see setFishLook).
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
//   window changes size (10 to 50 ms a fish). The fish's streaks come out
//   of the same budget as the ocean's, so the total stays the same.
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
// (plain to see). The fish are always in the ocean's own colors, with no
// fill and no drawn outline: they show as a finer, denser texture than the
// currents around them, with a crisp edge and the logo's lines traced in
// slightly brighter streaks. At 0.75 someone looking at the water finds
// both tuna within a few seconds. Phones add PHONE_FISH_VISIBILITY. See
// setFishLook() for what changes along the way.
const FISH_VISIBILITY = 0.75;
// How fast the big fish swims, in window widths a second. 1 / 48 crosses
// the window in 48 seconds. The small one swims a little slower
// (SMALL_FISH_DRIFT).
const DRIFT_SPEED = 1 / 48;

// ------------------------------------------------------------------
// The fish
// ------------------------------------------------------------------

// Phones add this to FISH_VISIBILITY (up to 1, and not when it is 0). Their
// fish are smaller, so they need a little more to be found as easily.
const PHONE_FISH_VISIBILITY = 0.2;
// What FISH_VISIBILITY changes inside a fish. Each moves in a straight line
// from the open ocean's value at 0 to this at 1 (see setFishLook). Together
// they make the fish a finer texture than the currents around it: more
// streaks, thinner and slower, so their trails are short. Each streak
// leaves less light, so the fish is only a little brighter than the water
// around it (measured at 1 to 2 times, more where the outline and the
// stripe are).
const FISH_DENSITY = 3;  // streaks per area, times the open ocean's
const FISH_PACE = 0.45;  // their speed, as a share of the ocean's speed there
const FISH_LINE_WIDTH = 0.5;  // CSS px (the ocean's are LINE_WIDTH)
const FISH_GLOW = 0.8;  // streaks right on one of the fish's lines are drawn up to 1 + this times as bright
// A phone's fish are small, so their streaks are never thinner or slower
// than this (their texture is still finer than the water around them).
const PHONE_FISH_LINE_WIDTH = 0.8;
const PHONE_FISH_PACE = 0.85;
// From this FISH_VISIBILITY up, a fish's own streaks take the place of the
// ocean's inside it completely. Below it the two share.
const FISH_SWAP_FULL = 0.2;
// The fish's streaks never move slower than this (CSS px a second at 1920
// by 1080, before FISH_PACE), so they still draw the fish in calm water.
// They are drawn a little fainter when this speeds them up (see fishShade).
const FISH_SPEED_FLOOR = 70;
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
const FIELD_PAD = 8;         // cells of room around the tuna's box
const FEATHER_IN = 8;        // the fish's pull on the water reaches full strength this far inside the outline (logo units)
const FEATHER_OUT = 2;       // and starts this far outside it, so the outline is crisp
const EDGE_BAND = 14;        // in a band this deep inside the outline (logo units) the water runs along the outline
const FISH_SEAL = 5.5;       // channels in the logo narrower than twice this fill in, see solidify()
const MIN_LINE_AREA = 40;    // logo pieces smaller than this (specks) don't count as lines
const LINE_STEP = 2;         // logo units between the points read along each line
const LINE_REACH = 5;        // a line's direction at a point comes from the points this many steps either side
const AXIS_PULL = 0.015;     // how strongly the plain nose to tail direction pulls where no line is near
const SPREAD_PASSES = 180;   // averaging passes that spread the lines' directions over the fish
const SPREAD_OMEGA = 1.7;    // over-relaxation, which makes those passes settle faster (1 to 1.9)
// How much brighter the streaks are along the fish's lines, from 0 to 1
// (times FISH_GLOW):
const ART_GLOW = 0.6;  // on the logo's own inside lines: the gill arcs, the stripe's edges, the slits in the fins and tail
const ART_REACH = 1.8;  // field cells those lines glow out to either side
const EDGE_GLOW = 0.45;  // along the outline, so it reads crisp without being drawn
const EDGE_GLOW_DEPTH = 16;  // logo units in from the outline that glow
const TEETH_GLOW = 1;        // along the outline at the open mouth, the teeth
const FINLET_GLOW = 0.8;     // along the outline at the finlets
const EYE_GLOW = 1;          // the eye's whirlpool
const STRIPE_GLOW = 1;       // the lateral stripe
const TEETH_PACE = 0.55;     // the teeth's streaks move this much slower again, so they are short and sharp
// The tuna inside its SVG (the path's box) and three spots on it, all in
// the SVG's own units, where the fish faces left.
const TUNA_BOX = { x: 77, y: 16, w: 1251, h: 524 };
const TUNA_NOSE = { x: 79, y: 254 };
const TUNA_TAIL = { x: 1170, y: 287 };   // the narrowest point of the tail stalk
const TUNA_EYE = { x: 266, y: 247, r: 30 };
// The tuna's anatomy, mapped by hand from the logo, in the SVG's own units
// (see fishFieldSteps). The fins: streaks run from the base (two points
// where the fin meets the body) up into the point.
const TUNA_FINS = [
  { base: [[458, 134], [555, 128]], tip: [578, 16] },    // first dorsal fin
  { base: [[758, 160], [862, 184]], tip: [874, 74] },    // second dorsal fin
  { base: [[505, 490], [612, 485]], tip: [669, 539] },   // pelvic fin
  { base: [[800, 450], [905, 437]], tip: [964, 512] },   // anal fin
];
// The pectoral fin, just behind the gills: streaks fan back from its base.
const TUNA_PECTORAL = { base: [[548, 295], [622, 366]], tip: [814, 289] };
// The forked tail: past the stalk the flow splits toward the two lobes,
// above and below the fork.
const TUNA_LOBES = { stalkX: 1165, forkY: 288, upper: [1325, 81], lower: [1327, 512] };
// The lateral stripe: one strong line along the body, from the pectoral
// fin's point back to the tail stalk.
const TUNA_STRIPE = [[700, 292], [814, 290], [920, 294], [1033, 299], [1100, 296], [1170, 290]];
// Where the outline is the teeth (the open mouth) and where it is the rows
// of finlets, as boxes [x0, y0, x1, y1].
const TUNA_TEETH = [82, 262, 335, 475];
const TUNA_FINLETS = [[550, 80, 750, 156], [860, 175, 1130, 272], [880, 312, 1130, 440]];
const DEFAULT_FISH_SRC = new URL('../../assets/dogtooth_kicad_silkscreen_files/01_primary_full_logo_kicad_white_tuna.svg', import.meta.url).href;
const FISH_WAIT_MS = 1500;   // start without the fish if they take longer than this to load

// The fish's own streaks and flow lines, see traceFishLines() and stepFish().
const FISH_MARGIN = 0.06;         // a fish's patch reaches this share of its width past the tuna on every side
const FISH_GRID_PX = 2;           // CSS px between the nodes of a fish's weight grid (how strongly it hides the ocean's streaks), close enough to keep the outline crisp
const FLOW_GAP = 0.8;             // the fish's flow lines sit this share of its streaks' typical spacing apart
const FLOW_STEP = 1;              // CSS px between the points along a flow line
const FLOW_SEED_WEIGHT = 0.3;     // a flow line only starts where the fish's weight is at least this
const FLOW_END_WEIGHT = 0.02;     // and ends where the weight drops below this
const FLOW_MIN_GAPS = 2;          // flow lines shorter than this many gaps are dropped
const FLOW_MAX_WIDTHS = 2.5;      // and none is longer than this many fish widths
const EDGE_LINES = [0.3, 1.2];    // the outline's own flow lines, this many gaps inside it
const EDGE_BIAS = 2;              // they get this many times their share of the streaks, so the outline reads even in calm water
const STRIPE_BIAS = 3;            // the stripe gets this many times its share of the streaks, so it runs as one strong line
const EYE_BIAS = 1.5;             // and the eye's whirlpool this many
const EYE_REACH = 2.1;            // the eye's whirlpool reaches this many eye radii from its center
const EYE_CALM = 0.6;             // and leaves this many eye radii in its middle calm (no streaks)
const EYE_TURNS = 1.25;           // how many times round each arm of the whirlpool winds on its way in
const FISH_RESTART_FADE = 1.5;    // a fish streak that starts its line again fades in over this many gaps
const FISH_SPEED_MEMORY = 0.5;    // seconds a fish streak's running average speed looks back, see stepFish
const BUNCH_MIN = 0.35;           // and the most its opacity is turned down
const BUNCH_MAX = 2.5;            // or up by it

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
  // What FISH_VISIBILITY sets inside the fish (see FISH_DENSITY and the
  // settings after it). Phones add PHONE_FISH_VISIBILITY, so these are set
  // again by setFishLook() when the window changes size.
  //   fishSwap     the share of the streaks inside a fish that are the
  //                fish's own (the rest are the ocean's, drawn fainter)
  //   fishDensity  the fish's streaks per area, times the open ocean's
  //   fishPace     their speed, as a share of the ocean's
  //   fishWidth    their line width, CSS px
  //   fishGlow     how much brighter they get on the fish's lines
  let fishSwap = 0;
  let fishDensity = 1;
  let fishPace = 1;
  let fishWidth = LINE_WIDTH;
  let fishGlow = 0;
  function setFishLook(onPhone) {
    const v = fishVis > 0 ? Math.min(1, fishVis + (onPhone ? PHONE_FISH_VISIBILITY : 0)) : 0;
    fishSwap = Math.min(1, v / FISH_SWAP_FULL);
    fishDensity = 1 + (FISH_DENSITY - 1) * v;
    fishPace = 1 + (FISH_PACE - 1) * v;
    fishWidth = LINE_WIDTH + (FISH_LINE_WIDTH - LINE_WIDTH) * v;
    fishGlow = FISH_GLOW * v;
    if (onPhone) {
      fishPace = Math.max(fishPace, PHONE_FISH_PACE);
      fishWidth = Math.max(fishWidth, PHONE_FISH_LINE_WIDTH);
    }
  }
  // The anatomy weight (0 outside a fish, 1 just inside its outline) turned
  // into the fish's pull: the share of the streaks there that are the
  // fish's own.
  const pullOf = (weight) => Math.min(1, weight) * fishSwap;

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

  // Streaks. streakBudget is how many there are in all. The fish take
  // theirs from it (see balanceStreaks) and the open ocean gets the rest,
  // count.
  let streakBudget = 0;
  let count = 0;
  let particleShare = 1;   // what the slow start check left of the full count
  let px = new Float32Array(0);
  let py = new Float32Array(0);
  let age = new Float32Array(0);
  let life = new Float32Array(0);
  const segs = [];
  const segCount = new Int32Array(ALPHA_LEVELS);
  // The fish's streaks are drawn in their own batches, at fishWidth.
  const fsegs = [];
  const fsegCount = new Int32Array(ALPHA_LEVELS);
  for (let l = 0; l < ALPHA_LEVELS; l++) fsegs.push(new Float32Array(1024));
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
    balanceStreaks();
  }

  // The fish take their streaks from the budget, and the open ocean gets
  // the rest, so a page with fish draws no more streaks than one without.
  function balanceStreaks() {
    let fishN = 0;
    for (const f of fishes) fishN += f.streaks?.n ?? 0;
    count = Math.max(Math.min(streakBudget, MIN_PARTICLES), streakBudget - fishN);
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
    // The gap between the fish's flow lines comes from how far apart its
    // streaks are on average: fishDensity times as many per area as the
    // open ocean's.
    const gap = clamp(FLOW_GAP / Math.sqrt((streakBudget / (cssW * cssH)) * fishDensity), 2.5, 14);
    f.lines = traceFishLines(field, w, margin, gap, seed);
    // The lines carry the anatomy weight at every point. The streaks want
    // the pull. It reaches full strength at half the weight, so the
    // outline's own streaks are as bright as the rest.
    const pts = f.lines.pts;
    const stride = f.lines.stride;
    for (let o = 4; o < pts.length; o += stride) pts[o] = pullOf(Math.min(1, pts[o] * 2));
    sizeFishStreaks(f);
    return f;
  }

  // The grid a fish carries over its patch, a node every FISH_GRID_PX or so,
  // with how strongly the fish hides the ocean's streaks at every node (the
  // pull, see pullOf). Built once per fish size.
  function buildFishGrid(f) {
    const cols = Math.max(3, Math.ceil(f.spanW / FISH_GRID_PX) + 1);
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

  // Gives fish f fishDensity times as many streaks as the open ocean has in
  // the same area (its lines, a gap apart, cover about total times gap).
  // Called again when the slow start check cuts the streaks.
  function sizeFishStreaks(f) {
    const L = f.lines;
    const n = fishVis > 0 && L.count > 0 ? Math.round((streakBudget / (cssW * cssH)) * L.total * L.gap * fishDensity) : 0;
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

  // A new streak somewhere in fish f: on a line picked by its length times
  // its bias (so long lines get more, and the stripe and the eye more
  // again), anywhere along it, and up to the line's spread to one side of
  // it. "anyAge" as in respawn().
  function respawnFishStreak(f, i, anyAge) {
    const L = f.lines;
    const S = f.streaks;
    const want = random() * L.cum[L.count - 1];
    let lo = 0;
    let hi = L.count - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (L.cum[mid] < want) lo = mid + 1;
      else hi = mid;
    }
    S.line[i] = lo;
    S.pos[i] = random() * (L.lens[lo] - 1);
    S.off[i] = (random() - 0.5) * L.gap * L.spread[lo];
    S.life[i] = LIFE_MIN + random() * (LIFE_MAX - LIFE_MIN);
    S.age[i] = anyAge ? random() * S.life[i] : 0;
    S.run[i] = Infinity;
    S.vavg[i] = 0;   // set by its first step
  }

  // Where a fish streak is: line, how far along it (pos, in points, at most
  // the line's length less one) and its side offset (off, CSS px). Writes
  // the point (CSS px from the patch's corner) to lpX, lpY, the fish's pull
  // there (see pullOf) to lpW, its glow (0 to 1, see FISH_GLOW) to lpG and
  // its pace (1, or less at the teeth) to lpP.
  let lpX = 0;
  let lpY = 0;
  let lpW = 0;
  let lpG = 0;
  let lpP = 1;
  function linePoint(L, line, pos, off) {
    const q = pos | 0;
    const t = pos - q;
    const S = L.stride;
    const a = (L.starts[line] + q) * S;
    const b = a + S;
    const p = L.pts;
    const nx = p[a + 2] + t * (p[b + 2] - p[a + 2]);
    const ny = p[a + 3] + t * (p[b + 3] - p[a + 3]);
    lpX = p[a] + t * (p[b] - p[a]) + off * nx;
    lpY = p[a + 1] + t * (p[b + 1] - p[a + 1]) + off * ny;
    lpW = p[a + 4] + t * (p[b + 4] - p[a + 4]);
    lpG = p[a + 5] + t * (p[b + 5] - p[a + 5]);
    lpP = p[a + 6] + t * (p[b + 6] - p[a + 6]);
  }

  // How far a fish streak at (x, y) on screen moves in a step of k seconds
  // (times SPEED), in points along its line: the ocean's speed there, or
  // the fish's floor speed if that is faster, times its pace (fishPace,
  // and pace, the line's own there). Also leaves the ocean's own speed in
  // fishOcean, which sets the streak's opacity like any other, the speed
  // before the pace in fishSpeed, and in fishShade how much fainter it is
  // drawn when the floor speeds it up (a longer streak at the same opacity
  // would be a brighter one).
  let fishOcean = 0;
  let fishSpeed = 0;
  let fishShade = 1;
  function fishStep(x, y, k, floor, pace) {
    sampleOcean(x, y);
    fishOcean = Math.sqrt(su * su + sv * sv);
    if (fishOcean >= floor) {
      fishSpeed = fishOcean;
      fishShade = 1;
    } else {
      fishSpeed = floor;
      fishShade = Math.sqrt(Math.max(fishOcean, floor * 0.1) / floor);
    }
    return (fishSpeed * fishPace * pace * k) / FLOW_STEP;
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
    const floor = FISH_SPEED_FLOOR * unit;
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
        const step = fishStep(x0 + left, y0 + f.top, k, floor, lpP);
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
        let factor = (a < BIRTH_S ? a / BIRTH_S : 1) * (restart < 1 ? restart : 1) * lpW * bunch * fishShade * (1 + fishGlow * lpG);
        if (sy < topClear || sy > bottomClear) factor *= bandKeep(sy, NAV_STREAK_KEEP, BOTTOM_STREAK_KEEP);
        pushSegment(levelFor(fishOcean * invHot, factor), sx, sy, lpX + left, lpY + f.top, fsegs, fsegCount);
      }
    }
  }

  // The fish streaks for the still frame: each traced forward STILL_STEPS
  // steps, fading toward its tail, like drawStill() does for the ocean.
  function stillFish(k, invHot, fadePerStep) {
    if (fishVis === 0) return;
    const floor = FISH_SPEED_FLOOR * unit;
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
          pos += fishStep(x + left, y + f.top, k, floor, lpP);
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
          let fade = Math.pow(fadePerStep, STILL_STEPS - 1 - s) * lpW * fishShade * (1 + fishGlow * lpG);
          if (sy < topClear || sy > bottomClear) fade *= bandKeep(sy, NAV_STREAK_KEEP, BOTTOM_STREAK_KEEP);
          pushSegment(levelFor(fishOcean * invHot, fade), x + left, sy, lpX + left, lpY + f.top, fsegs, fsegCount);
          x = lpX;
          y = lpY;
        }
      }
    }
  }

  // ---------- Streaks ----------

  // Room for the whole budget in the ocean. placeFish() then hands the fish
  // their share (balanceStreaks).
  function setupParticles() {
    streakBudget = particleCountFor(cssW, cssH, unit);
    count = streakBudget;
    px = new Float32Array(streakBudget);
    py = new Float32Array(streakBudget);
    age = new Float32Array(streakBudget);
    life = new Float32Array(streakBudget);
    // Room for every streak's piece in every batch. pushSegment() makes
    // more room if the still frame needs it.
    for (let l = 0; l < ALPHA_LEVELS; l++) segs[l] = new Float32Array(streakBudget * 4);
    for (let i = 0; i < streakBudget; i++) respawn(i, true);
  }

  // A new streak somewhere in the open water. "anyAge" gives it a random
  // age, so a whole batch of new streaks doesn't die all at once. The fish
  // have their own streaks, so a spot well inside one is passed over (a
  // few tries, then it takes what it has).
  function respawn(i, anyAge) {
    const avoid = fishVis > 0 && fishes.length > 0;
    for (let tries = 0; tries < 4; tries++) {
      px[i] = random() * cssW;
      py[i] = random() * cssH;
      if (!avoid || coverAt(px[i], py[i]) < 0.5) break;
    }
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

  // Queues one piece of streak in its opacity batch: the ocean's (segs),
  // or the fish's (fsegs).
  function pushSegment(level, x0, y0, x1, y1, store = segs, counts = segCount) {
    if (level < 0) return;
    let a = store[level];
    const c = counts[level];
    if (c + 4 > a.length) {
      const bigger = new Float32Array(a.length * 2);
      bigger.set(a);
      store[level] = bigger;
      a = bigger;
    }
    a[c] = x0;
    a[c + 1] = y0;
    a[c + 2] = x1;
    a[c + 3] = y1;
    counts[level] = c + 4;
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
    fsegCount.fill(0);
    for (let i = 0; i < count; i++) {
      const a = age[i] + dt;
      if (a > life[i]) {
        respawn(i, false);
        continue;
      }
      age[i] = a;
      const x = px[i];
      const y = py[i];
      // Inside a fish an ocean streak isn't drawn at all, but it keeps
      // going, so it comes out the far side and the water behind the fish
      // isn't left emptier.
      const cover = hiding ? coverAt(x, y) : 0;
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
      if (cover > 0.98) continue;
      factor *= 1 - cover;
      pushSegment(levelFor(s, factor), x, y, nx, ny);
    }
  }

  // Strokes the queued pieces, one path per opacity batch: the ocean's at
  // LINE_WIDTH, then the fish's at fishWidth.
  function drawSegments() {
    tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    tctx.globalCompositeOperation = 'source-over';
    tctx.lineCap = 'butt';
    strokeBatches(segs, segCount, LINE_WIDTH);
    strokeBatches(fsegs, fsegCount, fishWidth);
  }

  function strokeBatches(store, counts, width) {
    tctx.lineWidth = width;
    for (let l = 0; l < ALPHA_LEVELS; l++) {
      const n = counts[l];
      if (!n) continue;
      const a = store[l];
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
    fsegCount.fill(0);
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
    if (average > budget && streakBudget > MIN_PARTICLES) {
      const keep = clamp((budget / average) * 0.9, 0.2, 0.95);
      particleShare *= keep;
      cutParticles(Math.max(MIN_PARTICLES, Math.round(streakBudget * keep)));
      cut = true;
    }
    checksLeft -= 1;
    checkAt = animT + SLOW_CHECK_S;
    costSum = 0;
    costFrames = 0;
  }

  // Cuts the budget to n streaks: the fish get their share of it again, and
  // the ocean keeps its first streaks up to the rest.
  function cutParticles(n) {
    if (n >= streakBudget) return;
    streakBudget = n;
    px = px.slice(0, n);
    py = py.slice(0, n);
    age = age.slice(0, n);
    life = life.slice(0, n);
    for (const f of fishes) sizeFishStreaks(f);
    balanceStreaks();
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
        frame: frameNo, ms, particles: count, budget: streakBudget,
        fishStreaks: fishes.reduce((sum, f) => sum + (f.streaks?.n ?? 0), 0),
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
//   1. The outline's own lines: the outline traced EDGE_LINES gaps inside
//      it (contours of the signed distance), each cut at the nose and the
//      tail into an upper and a lower half that run nose to tail. They draw
//      the silhouette crisply, teeth, fins and finlets included.
//   2. The lateral stripe, one line from the pectoral fin's point to the
//      tail stalk, which gets extra streaks (STRIPE_BIAS).
//   3. Seeds are tried all over the fish in a shuffled order. A seed that
//      is inside the fish and at least a gap from every line so far starts
//      a new line, traced both ways from it one FLOW_STEP at a time (a
//      midpoint step, so it bends smoothly). The field's lines have no
//      forward, so each step keeps going the way the last one went. It
//      stops where the fish fades out, at the eye, or when it comes within
//      half a gap of another line (so lines that squeeze together end
//      instead of piling up). The finished line runs into the point of the
//      fin it is in (or the tail lobe, or out from the pectoral fin's
//      base), or else nose to tail, or downward where it runs straight
//      across the fish, as on the gill arcs.
//   4. The eye gets its own lines: a few arms that wind inward like water
//      going down a drain, leaving its middle calm.
// Returns { pts, stride, starts, lens, cum, spread, count, total, gap }:
//   pts     every point of every line, stride numbers each: x, y, the side
//           direction (nx, ny, 1 long), the fish's weight there, its glow
//           (0 to 1) and its pace (1, or less at the teeth)
//   starts  where each line's first point is in pts (in points)
//   lens    how many points each line has
//   cum     each line's length times its bias, added up to and including it
//           (for picking a line for a new streak)
//   spread  how far to one side of each line its streaks may sit, in gaps
//   count, total   how many lines and how long they are in all (CSS px)
// Exported for tests.
export function traceFishLines(F, w, margin, gap, seed = 1) {
  const random = mulberry32((seed * 7919) ^ 0x5bd1e995);
  const scale = w / TUNA_BOX.w;          // CSS px per logo unit
  const unitPx = FIELD_UNIT * scale;     // CSS px per field cell
  const fieldPad = FIELD_PAD * unitPx;
  const spanW = w + 2 * margin;
  const spanH = (w * TUNA_BOX.h) / TUNA_BOX.w + 2 * margin;
  const h = FLOW_STEP;
  // Patch px to field cells (cell centers are at whole numbers), and back.
  const toCell = (v) => (v - margin + fieldPad) / unitPx - 0.5;
  const fromCell = (c) => (c + 0.5) * unitPx - fieldPad + margin;

  // The eye and the plain nose to tail direction, in patch px. The field is
  // mirrored, so a logo x becomes (box right edge) - x.
  const eyeX = fromCell(F.eye.x);
  const eyeY = fromCell(F.eye.y);
  const eyeR = F.eye.r * unitPx;
  const eyeReach = eyeR * EYE_REACH;
  const noseX = (TUNA_BOX.x + TUNA_BOX.w - TUNA_NOSE.x) * scale + margin;
  const noseY = (TUNA_NOSE.y - TUNA_BOX.y) * scale + margin;
  const tailX = (TUNA_BOX.x + TUNA_BOX.w - TUNA_TAIL.x) * scale + margin;
  const tailY = (TUNA_TAIL.y - TUNA_BOX.y) * scale + margin;
  const axisLen = Math.hypot(tailX - noseX, tailY - noseY);
  const axisX = (tailX - noseX) / axisLen;
  const axisY = (tailY - noseY) / axisLen;

  // A field grid read smoothly between cells (0 outside the field).
  function sample(grid, x, y) {
    const gx = toCell(x);
    const gy = toCell(y);
    if (gx < 0 || gy < 0 || gx >= F.cols - 1 || gy >= F.rows - 1) return 0;
    const i = gx | 0;
    const j = gy | 0;
    const fx = gx - i;
    const fy = gy - j;
    const k = j * F.cols + i;
    return (grid[k] * (1 - fx) + grid[k + 1] * fx) * (1 - fy) + (grid[k + F.cols] * (1 - fx) + grid[k + F.cols + 1] * fx) * fy;
  }
  const weightAt = (x, y) => sample(F.weight, x, y);
  const zoneAt = (x, y) => {
    const i = Math.round(toCell(x));
    const j = Math.round(toCell(y));
    return i < 0 || j < 0 || i >= F.cols || j >= F.rows ? 0 : F.zone[j * F.cols + i];
  };

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

  // The lines so far: { xy (patch px, flat), bias, spread }.
  const lines = [];
  // Adds a line that was worked out whole (the outline's and the stripe),
  // one point every FLOW_STEP, and marks it so the seeded lines keep clear.
  function addWhole(xy, bias, spread) {
    const pts = resampleOpen(xy, h);
    if (pts.length < 4 || ((pts.length / 2) - 1) * h < FLOW_MIN_GAPS * gap) return;
    const id = lines.length;
    for (let q = 0; q < pts.length; q += 2) mark(pts[q], pts[q + 1], id, q / 2);
    lines.push({ xy: pts, bias, spread });
  }
  const along = (x, y) => x * axisX + y * axisY;

  // 1. The outline's own lines.
  for (const inset of EDGE_LINES) {
    const level = (inset * gap) / scale;   // logo units inside the outline
    for (const loop of contourLoops(F.sd, F.cols, F.rows, level)) {
      const xy = new Float32Array(loop.pts.length);
      for (let q = 0; q < xy.length; q++) xy[q] = fromCell(loop.pts[q]);
      // On a small fish the deeper one can cross the eye. It is cut there,
      // so the whirlpool keeps its space and its calm middle.
      for (const half of loop.closed ? splitLoop(xy, along) : [orientOpen(xy, along)]) {
        for (const piece of cutWhere(half, inEye)) addWhole(piece, EDGE_BIAS, 0.12);
      }
    }
  }

  // 2. The lateral stripe.
  if (F.stripe) {
    const xy = new Float32Array(F.stripe.length);
    for (let q = 0; q < xy.length; q++) xy[q] = fromCell(F.stripe[q]);
    addWhole(orientOpen(xy, along), STRIPE_BIAS, 0.08);
  }

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

  // 3. The seeds: a jittered grid half a gap apart, shuffled.
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
  const tips = F.tips.map((t) => (t ? { x: fromCell(t.x), y: fromCell(t.y) } : null));
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
    // Into the point of the fin (or lobe) it is in, or nose to tail, or
    // downward where it runs across the fish.
    const mid = (n >> 1) * 2;
    const tip = tips[zoneAt(xy[mid], xy[mid + 1])];
    let flip;
    if (tip) {
      flip = Math.hypot(xy[0] - tip.x, xy[1] - tip.y) < Math.hypot(xy[n * 2 - 2] - tip.x, xy[n * 2 - 1] - tip.y);
    } else {
      const netX = xy[n * 2 - 2] - xy[0];
      const netY = xy[n * 2 - 1] - xy[1];
      let score = netX * axisX + netY * axisY;
      if (Math.abs(score) < 0.2 * Math.hypot(netX, netY)) score = netY;
      flip = score < 0;
    }
    lines.push({ xy: flip ? reversePoints(xy) : xy, bias: 1, spread: 0.6 });
  }

  // 4. The eye's whirlpool: arms that wind in from the edge of its reach,
  //    about a gap apart, turning the way that runs toward the tail along
  //    the top of the eye, and stopping short of a calm middle.
  const eyeFrom = lines.length;
  const inner = Math.max(1, eyeR * EYE_CALM);
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
    if (xy.length >= 6) lines.push({ xy: Float32Array.from(xy), bias: EYE_BIAS, spread: 0.15 });
  }

  // The flat arrays the streaks read.
  const stride = 7;
  let points = 0;
  for (const L of lines) points += L.xy.length / 2;
  const pts = new Float32Array(points * stride);
  const starts = new Int32Array(lines.length);
  const lens = new Int32Array(lines.length);
  const cum = new Float32Array(lines.length);
  const spread = new Float32Array(lines.length);
  let at = 0;
  let total = 0;
  let picked = 0;
  lines.forEach((L, l) => {
    const xy = L.xy;
    const m = xy.length / 2;
    const eye = l >= eyeFrom;
    starts[l] = at;
    lens[l] = m;
    spread[l] = L.spread;
    for (let q = 0; q < m; q++) {
      const a = Math.max(0, q - 2);
      const b = Math.min(m - 1, q + 2);
      const tx = xy[b * 2] - xy[a * 2];
      const ty = xy[b * 2 + 1] - xy[a * 2 + 1];
      const len = Math.hypot(tx, ty) || 1;
      const x = xy[q * 2];
      const y = xy[q * 2 + 1];
      const o = (at + q) * stride;
      pts[o] = x;
      pts[o + 1] = y;
      pts[o + 2] = -ty / len;
      pts[o + 3] = tx / len;
      pts[o + 4] = eye ? 1 : weightAt(x, y);
      pts[o + 5] = eye ? EYE_GLOW : L.bias === STRIPE_BIAS ? STRIPE_GLOW : sample(F.glow, x, y);
      pts[o + 6] = eye ? 1 : Math.max(0.2, sample(F.pace, x, y));
    }
    at += m;
    total += (m - 1) * h;
    picked += (m - 1) * h * L.bias;
    cum[l] = picked;
  });
  return { pts, stride, starts, lens, cum, spread, count: lines.length, total, gap };
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
//   sd          the signed distance to the outline, in logo units, positive
//               inside (from distance maps at two logo units a pixel)
//   weight      how strongly the fish shows there: 0 outside, 1 a little
//               way in, with a short, crisp edge (FEATHER_OUT, FEATHER_IN)
//   dirX, dirY  the line the water inside the fish follows there (1 long),
//               turned toward the tail where it can be
//   glow        how much brighter its streaks are drawn there (0 to 1)
//   pace        how fast its streaks move there, as a share (1, or
//               TEETH_PACE at the teeth)
//   zone        which part of the fish a cell is in, for the flow lines'
//               direction: 0 the body, 1 to 4 the fins (TUNA_FINS), 5 the
//               pectoral fin, 6 and 7 the upper and lower tail lobes
//   tips        the point each zone's lines run into, in field cells
//   stripe      the lateral stripe, as a flat list of points in field cells
//   eye         the eye's center and radius, in field cells
// The directions come from four things, in rising order of say:
//   - every line in the logo (the outline, the gill arcs, the mouth, the
//     stripe's edges, the slits in the fins) gives its direction to the
//     cells it crosses,
//   - in a band EDGE_BAND deep inside the outline, the water runs along the
//     outline,
//   - in the fins it runs into their points, past the pectoral fin's base it
//     fans out back toward the fin's point, and past the tail stalk it
//     splits toward the two lobes,
// and these are spread over the rest of the fish (see step 6).
// A generator: it yields between its big steps so runInSlices() can spread
// the work over several tasks, and returns the field.
function* fishFieldSteps(d) {
  const U = FIELD_UNIT;
  const pad = FIELD_PAD * U;
  const flipAt = 2 * TUNA_BOX.x + TUNA_BOX.w;   // x becomes flipAt - x, which mirrors the fish in its own box
  const mx = (x) => flipAt - x;
  const ox = TUNA_BOX.x - pad;                  // the field's corner, in logo units
  const oy = TUNA_BOX.y - pad;
  const polys = parsePolygons(d).map((p) => {
    const m = new Float64Array(p.length);
    for (let q = 0; q < p.length; q += 2) {
      m[q] = mx(p[q]);
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

  // 2. The field's grid, and the logo's inside lines: a cell is on one when
  //    an ink pixel in it sits next to a gap, or a gap pixel next to ink,
  //    both inside the fish (the outline itself doesn't count, and nor does
  //    the eye's ring, which gets a whirlpool).
  const cols = Math.ceil(W / U);
  const rows = Math.ceil(H / U);
  const n = cols * rows;
  const eye = { x: mx(TUNA_EYE.x), y: TUNA_EYE.y, r: TUNA_EYE.r };
  const artCell = new Uint8Array(n);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const q = y * W + x;
      if (!solid[q]) continue;
      const v = ink[q];
      if ((solid[q - 1] && ink[q - 1] !== v) || (solid[q + 1] && ink[q + 1] !== v) || (solid[q - W] && ink[q - W] !== v) || (solid[q + W] && ink[q + W] !== v)) {
        artCell[((y / U) | 0) * cols + ((x / U) | 0)] = 1;
      }
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (Math.hypot(ox + (i + 0.5) * U - eye.x, oy + (j + 0.5) * U - eye.y) < eye.r * 1.5) artCell[j * cols + i] = 0;
    }
  }
  yield;

  // 3. The signed distance to the outline, from distance maps at two logo
  //    units a pixel (the fish shrunk by half, a pixel being fish when at
  //    least two of its four are). A cell's is the average of the four
  //    pixels around its middle, which puts the outline between cells
  //    smoothly.
  const W2 = Math.ceil(W / 2);
  const H2 = Math.ceil(H / 2);
  const solid2 = new Uint8Array(W2 * H2);
  const water2 = new Uint8Array(W2 * H2);
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      let c = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const px = Math.min(W - 1, x * 2 + dx);
          const py = Math.min(H - 1, y * 2 + dy);
          c += solid[py * W + px];
        }
      }
      const fish = c >= 2 ? 1 : 0;
      solid2[y * W2 + x] = fish;
      water2[y * W2 + x] = 1 - fish;
    }
  }
  const toWater = yield* distanceSquaredSteps(water2, W2, H2);
  const toFish = yield* distanceSquaredSteps(solid2, W2, H2);
  const sdAt = (q) => 2 * (solid2[q] ? Math.sqrt(toWater[q]) - 0.5 : -(Math.sqrt(toFish[q]) - 0.5));
  const sd = new Float32Array(n);
  const weight = new Float32Array(n);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const cx = clamp(Math.round(((i + 0.5) * U) / 2), 1, W2 - 1);
      const cy = clamp(Math.round(((j + 0.5) * U) / 2), 1, H2 - 1);
      sd[k] = (sdAt(cy * W2 + cx) + sdAt(cy * W2 + cx - 1) + sdAt((cy - 1) * W2 + cx) + sdAt((cy - 1) * W2 + cx - 1)) / 4;
      weight[k] = smoothstep(-FEATHER_OUT, FEATHER_IN, sd[k]);
    }
  }
  yield;

  // The plain nose to tail direction at a point: toward a spot far behind
  // the tail, on the line from the nose through the tail stalk.
  const nose = { x: mx(TUNA_NOSE.x), y: TUNA_NOSE.y };
  const tail = { x: mx(TUNA_TAIL.x), y: TUNA_TAIL.y };
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

  // 4. The lines. Each piece of the logo (except the specks and the eye,
  //    which gets its own whirlpool) is walked in LINE_STEP steps. The
  //    direction at each point comes from the points LINE_REACH steps either
  //    side (the logo's outlines are traced pixel by pixel, so neighbors
  //    alone would zigzag). A line has no "forward" yet, so it is kept as
  //    a doubled angle, (cos 2a, sin 2a), which is the same for a and for
  //    a turned around. Each point adds that to the cell it falls in.
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
  const fix = (k, x, y) => {
    const len = Math.hypot(x, y);
    if (len < 1e-9) return;
    x /= len;
    y /= len;
    vc[k] = x * x - y * y;
    vs[k] = 2 * x * y;
    fixed[k] = 1;
  };
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
  // In the band along the inside of the outline, the water runs along it:
  // across the signed distance's slope.
  for (let j = 1; j < rows - 1; j++) {
    for (let i = 1; i < cols - 1; i++) {
      const k = j * cols + i;
      if (sd[k] < 0 || sd[k] > EDGE_BAND) continue;
      fix(k, -(sd[k + cols] - sd[k - cols]), sd[k + 1] - sd[k - 1]);
    }
  }
  yield;

  // 5. The fins, the pectoral fin and the tail, from TUNA_FINS,
  //    TUNA_PECTORAL and TUNA_LOBES (mirrored like the fish).
  const zone = new Uint8Array(n);
  const tips = [null];
  const toCell = (x, y) => ({ x: (x - ox) / U - 0.5, y: (y - oy) / U - 0.5 });
  const fins = TUNA_FINS.map((f) => ({ a: [mx(f.base[0][0]), f.base[0][1]], b: [mx(f.base[1][0]), f.base[1][1]], tip: [mx(f.tip[0]), f.tip[1]] }));
  for (const f of fins) tips.push(toCell(f.tip[0], f.tip[1]));
  const pec = { a: [mx(TUNA_PECTORAL.base[0][0]), TUNA_PECTORAL.base[0][1]], b: [mx(TUNA_PECTORAL.base[1][0]), TUNA_PECTORAL.base[1][1]], tip: [mx(TUNA_PECTORAL.tip[0]), TUNA_PECTORAL.tip[1]] };
  tips.push(toCell(pec.tip[0], pec.tip[1]));
  const lobe = {
    stalkX: mx(TUNA_LOBES.stalkX), forkY: TUNA_LOBES.forkY,
    upper: [mx(TUNA_LOBES.upper[0]), TUNA_LOBES.upper[1]], lower: [mx(TUNA_LOBES.lower[0]), TUNA_LOBES.lower[1]],
  };
  tips.push(toCell(lobe.upper[0], lobe.upper[1]), toCell(lobe.lower[0], lobe.lower[1]));
  const pecBase = [(pec.a[0] + pec.b[0]) / 2, (pec.a[1] + pec.b[1]) / 2];
  // Each triangle's box (with room for the test's 3 units), to skip the
  // test far from it.
  const boxOf = (t) => [Math.min(t.a[0], t.b[0], t.tip[0]) - 4, Math.min(t.a[1], t.b[1], t.tip[1]) - 4, Math.max(t.a[0], t.b[0], t.tip[0]) + 4, Math.max(t.a[1], t.b[1], t.tip[1]) + 4];
  const near = (b, X, Y) => X >= b[0] && Y >= b[1] && X <= b[2] && Y <= b[3];
  for (const f of fins) f.box = boxOf(f);
  pec.box = boxOf(pec);
  for (let j = 1; j < rows - 1; j++) {
    for (let i = 1; i < cols - 1; i++) {
      const k = j * cols + i;
      if (sd[k] < -FEATHER_OUT) continue;
      const X = ox + (i + 0.5) * U;
      const Y = oy + (j + 0.5) * U;
      // A fin: into its point.
      let done = false;
      for (let q = 0; q < fins.length && !done; q++) {
        const f = fins[q];
        if (!near(f.box, X, Y) || triangleInside(X, Y, f.a, f.b, f.tip) < -3) continue;
        zone[k] = q + 1;
        fix(k, f.tip[0] - X, f.tip[1] - Y);
        done = true;
      }
      if (done) continue;
      // The pectoral fin: out from the middle of its base.
      if (near(pec.box, X, Y) && triangleInside(X, Y, pec.a, pec.b, pec.tip) >= -3) {
        zone[k] = 5;
        const dx = X - pecBase[0];
        const dy = Y - pecBase[1];
        if (Math.hypot(dx, dy) > 10) fix(k, dx, dy);
        else fix(k, pec.tip[0] - pecBase[0], pec.tip[1] - pecBase[1]);
        continue;
      }
      // The tail, past the stalk: toward the lobe on its side of the fork,
      // the two mixed across the fork so the flow parts smoothly.
      const past = mx(X) - TUNA_LOBES.stalkX;   // logo units past the stalk, in the SVG's own direction
      if (past > 0) {
        zone[k] = Y < lobe.forkY ? 6 : 7;
        const ux = lobe.upper[0] - X;
        const uy = lobe.upper[1] - Y;
        const lx = lobe.lower[0] - X;
        const ly = lobe.lower[1] - Y;
        const ul = Math.hypot(ux, uy) || 1;
        const ll = Math.hypot(lx, ly) || 1;
        // Both point back toward the tail, so right at the fork their mix
        // runs straight back.
        const t = smoothstep(lobe.forkY - 12, lobe.forkY + 12, Y);
        fix(k, (ux / ul) * (1 - t) + (lx / ll) * t, (uy / ul) * (1 - t) + (ly / ll) * t);
      }
    }
  }
  yield;

  // 6. Spread the fixed angles over the fish: each free cell becomes the
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
  // 7. Back from doubled angles to directions 1 long. A small share of the
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

  // 8. Where the streaks glow, and how fast they move. The logo's inside
  //    lines glow out to ART_REACH cells. Along the outline, a little
  //    everywhere, more at the teeth and the finlets. The teeth's streaks
  //    are slower.
  const toArt = runNow(distanceSquaredSteps(artCell, cols, rows));
  const glow = new Float32Array(n);
  const pace = new Float32Array(n);
  const box = (b, X, Y) => X >= mx(b[2]) && X <= mx(b[0]) && Y >= b[1] && Y <= b[3];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i;
      const X = ox + (i + 0.5) * U;
      const Y = oy + (j + 0.5) * U;
      const teeth = box(TUNA_TEETH, X, Y);
      pace[k] = teeth ? TEETH_PACE : 1;
      if (sd[k] < -FEATHER_OUT) continue;
      let g = ART_GLOW * clamp(1 - Math.sqrt(toArt[k]) / ART_REACH, 0, 1);
      if (sd[k] <= EDGE_GLOW_DEPTH) {
        const edge = teeth ? TEETH_GLOW : TUNA_FINLETS.some((b) => box(b, X, Y)) ? FINLET_GLOW : EDGE_GLOW;
        g = Math.max(g, edge * (1 - Math.max(0, sd[k]) / EDGE_GLOW_DEPTH));
      }
      glow[k] = g;
    }
  }

  // 9. The stripe, the eye and the tips, in field cells.
  const stripe = new Float32Array(TUNA_STRIPE.length * 2);
  TUNA_STRIPE.forEach(([x, y], q) => {
    const c = toCell(mx(x), y);
    stripe[q * 2] = c.x;
    stripe[q * 2 + 1] = c.y;
  });
  const eyeAt = { x: (eye.x - ox) / U - 0.5, y: (eye.y - oy) / U - 0.5, r: eye.r / U };
  return { cols, rows, dirX, dirY, weight, sd, glow, pace, zone, tips, stripe, eye: eyeAt };
}

// How far (logo units) the point (x, y) is inside the triangle a, b, c:
// the least of its distances to the three sides, positive inside.
function triangleInside(x, y, a, b, c) {
  const side = (p, q, r) => {
    const ex = q[0] - p[0];
    const ey = q[1] - p[1];
    const len = Math.hypot(ex, ey) || 1;
    const d = ((x - p[0]) * ey - (y - p[1]) * ex) / len;
    const ref = (r[0] - p[0]) * ey - (r[1] - p[1]) * ex;
    return ref < 0 ? -d : d;
  };
  return Math.min(side(a, b, c), side(b, c, a), side(c, a, b));
}

// The lines where a grid of values (cols by rows, one per cell, cell
// centers at whole numbers) crosses level, by marching squares. Returns
// [{ pts, closed }], pts a flat list of points in cell units. Each crossing
// sits on a grid edge (horizontal edges first, then vertical ones), and
// each edge joins at most two others, so plain arrays hold it all.
function contourLoops(v, cols, rows, level) {
  const across = cols * rows;
  const ex = new Float32Array(2 * across);
  const ey = new Float32Array(2 * across);
  const link = new Int32Array(4 * across).fill(-1);   // two links per edge
  const has = new Uint8Array(2 * across);
  const used = [];
  const cross = (id, x0, y0, a, x1, y1, b) => {
    if (!has[id]) {
      has[id] = 1;
      const t = a / (a - b);
      ex[id] = x0 + (x1 - x0) * t;
      ey[id] = y0 + (y1 - y0) * t;
      used.push(id);
    }
    return id;
  };
  const join = (a, b) => {
    link[link[a * 2] === -1 ? a * 2 : a * 2 + 1] = b;
    link[link[b * 2] === -1 ? b * 2 : b * 2 + 1] = a;
  };
  const e = [0, 0, 0, 0];
  for (let j = 0; j < rows - 1; j++) {
    const row = j * cols;
    for (let i = 0; i < cols - 1; i++) {
      const a = v[row + i] - level;
      const b = v[row + i + 1] - level;
      const c = v[row + cols + i + 1] - level;
      const d = v[row + cols + i] - level;
      const ia = a > 0;
      const ib = b > 0;
      const ic = c > 0;
      const id = d > 0;
      if (ia === ib && ib === ic && ic === id) continue;
      let m = 0;
      if (ia !== ib) e[m++] = cross(row + i, i, j, a, i + 1, j, b);                       // top
      if (ib !== ic) e[m++] = cross(across + row + i + 1, i + 1, j, b, i + 1, j + 1, c);   // right
      if (id !== ic) e[m++] = cross(row + cols + i, i, j + 1, d, i + 1, j + 1, c);        // bottom
      if (ia !== id) e[m++] = cross(across + row + i, i, j, a, i, j + 1, d);              // left
      if (m === 2) join(e[0], e[1]);
      else if (m === 4) {
        // A saddle: the middle decides which corners join up.
        if (((a + b + c + d) / 4 > 0) === ia) {
          join(e[0], e[1]);
          join(e[2], e[3]);
        } else {
          join(e[0], e[3]);
          join(e[1], e[2]);
        }
      }
    }
  }
  const seen = new Uint8Array(2 * across);
  const walk = (start) => {
    const pts = [];
    let prev = -1;
    let cur = start;
    while (cur !== -1 && !seen[cur]) {
      seen[cur] = 1;
      pts.push(ex[cur], ey[cur]);
      const go = link[cur * 2] !== prev ? link[cur * 2] : link[cur * 2 + 1];
      prev = cur;
      cur = go;
    }
    return pts;
  };
  const out = [];
  for (const id of used) {
    if (!seen[id] && (link[id * 2] === -1 || link[id * 2 + 1] === -1)) out.push({ pts: walk(id), closed: false });
  }
  for (const id of used) if (!seen[id]) out.push({ pts: walk(id), closed: true });
  return out.filter((c) => c.pts.length >= 6);
}

// A closed line cut where along() is least (the nose end) and most (the
// tail end) into two halves, each running from the nose end to the tail end.
function splitLoop(xy, along) {
  const m = xy.length / 2;
  let lo = 0;
  let hi = 0;
  for (let q = 1; q < m; q++) {
    const a = along(xy[q * 2], xy[q * 2 + 1]);
    if (a < along(xy[lo * 2], xy[lo * 2 + 1])) lo = q;
    if (a > along(xy[hi * 2], xy[hi * 2 + 1])) hi = q;
  }
  const take = (dir) => {
    const out = [];
    for (let q = lo; ; q = (q + dir + m) % m) {
      out.push(xy[q * 2], xy[q * 2 + 1]);
      if (q === hi) break;
    }
    return Float32Array.from(out);
  };
  return [take(1), take(-1)];
}

// The pieces of a line (flat x, y list) left after cutting out the points
// where skip(x, y) is true.
function cutWhere(xy, skip) {
  const out = [];
  let cur = [];
  for (let q = 0; q < xy.length; q += 2) {
    if (skip(xy[q], xy[q + 1])) {
      if (cur.length >= 4) out.push(Float32Array.from(cur));
      cur = [];
    } else cur.push(xy[q], xy[q + 1]);
  }
  if (cur.length >= 4) out.push(Float32Array.from(cur));
  return out;
}

// An open line turned, if needed, to run from the nose end to the tail end.
function orientOpen(xy, along) {
  const m = xy.length / 2;
  return along(xy[0], xy[1]) <= along(xy[m * 2 - 2], xy[m * 2 - 1]) ? xy : reversePoints(xy);
}

// Points every step along an open line, as a flat array.
function resampleOpen(xy, step) {
  const m = xy.length / 2;
  if (m < 2) return Float32Array.from(xy);
  const out = [xy[0], xy[1]];
  let carry = step;
  for (let a = 0; a < m - 1; a++) {
    const x0 = xy[a * 2];
    const y0 = xy[a * 2 + 1];
    const dx = xy[a * 2 + 2] - x0;
    const dy = xy[a * 2 + 3] - y0;
    const len = Math.hypot(dx, dy);
    let s = carry;
    while (s <= len) {
      out.push(x0 + (dx * s) / len, y0 + (dy * s) / len);
      s += step;
    }
    carry = s - len;
  }
  return Float32Array.from(out);
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
