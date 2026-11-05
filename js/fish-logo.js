'use strict';

/* ── FISH LOGO ───────────────────────────────────────────────
   The Dogtooth logo (the tuna and the DOGTOOTH SYSTEMS wordmark) is also a
   school of small baitfish, twice: in the home page hero and in the footer
   at the bottom of every page.

   Intro     (hero only) On page load the logo starts hidden. When the
             hero's ripple pulse reaches its widest ring, every fish appears
             on that ring (in the direction of its home from the logo's
             center) and swims in to its home spot, then the SVG logo fades
             in. The footer logo has no intro. It is just there, waiting.
   Idle      The crisp SVG logo shows. The fish canvas is hidden and no
             animation loop runs.
   Vibrate   Like an old TV with a crack in it: now and then a glitch spell
             of one to four blinks, where the logo swaps to fish, shivers
             (often with a thin band torn sideways), and swaps back. Blinks
             in a spell usually come right after each other, sometimes up to
             2 s apart, and the odd one lasts longer. Calm in between.
   Break     Touching the tuna or the wordmark with the cursor (or tapping
             it) swaps the whole logo to fish and bursts them away from that
             spot.
   School    The fish swim as a school (boids), flee the cursor, and stay out
             of the text and links, inside their area (the hero's corner
             bracket frame, or the whole footer).
   Re-form   When the cursor leaves the hero (or footer) or rests for 1.5 s,
             every fish swims back to its own home spot, the SVG logo fades
             back in over them, and everything stops again.

   The fish homes come from the same paths the two SVG layers draw, at their
   exact size and place, so swapping between the SVG and the fish doesn't
   move anything. The wordmark's letters are much thinner than the tuna, so
   its fish are smaller. Reduced motion turns all of this off and leaves the
   plain logo. */
(function () {
  /* ── Settings to tweak ─────────────────────────────────── */
  const FISH_LENGTH      = 10;            // px, snout to tail tips, for the tuna
  const WORDMARK_FISH_LENGTH = 5;         // px, smaller fish for DOGTOOTH and the two lines beside SYSTEMS
                                          // (6 to 7 px fish left the letters ragged on a 1440 px wide screen)
  const SYSTEMS_FISH_LENGTH  = 3.5;       // px, tiny fish for the thin SYSTEMS letters (their strokes are
                                          // only 2 to 3 px wide, too thin for bigger fish to stay readable)
  const ROW_SPACING      = 0.34;          // fish lengths between rows when packed into the logo
  const COLUMN_SPACING   = 1;             // fish lengths between fish in a row
  const FLEE_RADIUS      = 150;           // px, fish closer than this to the cursor swim away
  const FLEE_STRENGTH    = 2.5;           // how hard fish flee, compared with one schooling force
  const CRUISE_SPEED     = 70;            // px per second the schooling urges aim for (with all of them pulling
                                          // at once, a relaxed school averages about 60% of this)
  const VIBRATE_INTERVAL = [3500, 8000];  // ms, random calm between glitch spells
  const VIBRATE_GAP_MAX  = 2000;          // ms, longest wait between blinks inside a spell (rare; most are quick)
  const VIBRATE_STRENGTH = 0.8;           // px, how far a fish shivers off its home spot
  const REFORM_DELAY     = 1500;          // ms the cursor has to rest before the logo rebuilds
  const REFORM_DURATION  = 1300;          // ms for every fish to swim home
  const INTRO_DURATION   = 1500;          // ms for the page-load intro, from the ripple's ring to a whole logo
  const INTRO_STAGGER    = 400;           // ms, fish set off at random times within this, so they come in as a stream

  /* ── Finer settings ────────────────────────────────────── */
  const L = FISH_LENGTH;
  const HOME_JITTER_X = 0.12;   // fish lengths, random nudge of each home spot
  const HOME_JITTER_Y = 0.05;
  const END_REACH     = 0.3;    // fish lengths from a fish's center to each end, for the keep test
  const SHADES = [255, 249, 243, 237, 231, 225];  // the logo's white, a touch dimmer for some fish
  const BEND_STEPS = 15;        // tail positions drawn ahead of time (odd, so the middle one is straight)
  const MAX_BEND   = 0.08;      // fish lengths the tail tips swing sideways

  const MIN_SPEED  = CRUISE_SPEED * 0.45;  // nobody stops dead
  const MAX_SPEED  = CRUISE_SPEED * 1.6;   // top speed while schooling
  const FLEE_SPEED = CRUISE_SPEED * 3.5;   // top speed for a scared fish, for a moment
  const MAX_FORCE  = 240;                  // px/s², cap on any one schooling force
  const TURN_RATE  = 14;                   // how quickly the drawn body turns to its heading
  const FEAR_FADE  = 1.2;                  // per second, how fast the scared speed boost wears off

  const NEIGHBOR_RADIUS   = 3 * L;   // alignment and cohesion look this far
  const MAX_NEIGHBORS     = 20;      // a fish pays attention to about this many of its closest neighbors
  const CELL = NEIGHBOR_RADIUS / 2;  // spatial grid cell size
  const SEPARATION_RADIUS = 1.3 * L; // separation only cares about fish this close
  const W_SEPARATION = 1.7;
  const W_ALIGNMENT  = 1.0;
  const W_COHESION   = 0.8;
  const W_WANDER     = 0.35;
  const WANDER_TURN  = 1.6;          // how quickly each fish's wander direction drifts

  const EDGE_INSET  = 0.6 * L;       // fish centers stay this far inside the bracket frame
  const EDGE_MARGIN = 36;            // px, fish start turning this far from the frame
  const EDGE_FORCE  = 2500;          // px/s², push at the very edge
  const EDGE_LOOK   = 0.5;           // s, how far ahead a fish looks for the frame edge
  const W_EDGE_TURN = 2.5;           // how hard it turns back into the frame when it sees the edge coming
  const TEXT_PAD    = 6;             // px of extra room kept around the title and buttons
  const TEXT_MARGIN = 14;            // px, fish start turning this far from that room
  const MARGIN_SPREAD = 12;          // px, each fish turns at a slightly different distance, so no straight rows
  const TEXT_FORCE  = 2500;

  const BURST_FALLOFF    = 70;       // px, how fast the break burst weakens with distance
  const TEAR_DELAY       = 0.0012;   // s per px, far fish let go later so the logo tears open
  const STARTLE_RADIUS   = 36;       // px, fish this close to the cursor's path in one frame dart away at once
  const REFORM_MAX_SPEED = 650;      // px/s, long paths home may stretch past REFORM_DURATION (up to 15%) to stay under this
  const BLINK_SHORT      = [90, 170];  // ms, a normal glitch blink
  const BLINK_LONG       = [280, 550]; // ms, the odd longer one
  const BLINK_LONG_CHANCE = 0.2;       // share of blinks that are long
  const SPELL_BLINKS = [1, 2, 2, 2, 3, 3, 4];   // blinks per spell, picked at random (two is most common)
  const TEAR_CHANCE      = 0.65;       // share of blinks with a torn band
  const TEAR_SHIFT       = [4, 9];     // px a torn band jumps sideways
  const FADE_DURATION    = 300;      // ms, SVG logo fade-in once every fish is home
  const TOUCH_SLOP       = 3;        // px around the cursor that counts as touching the logo
  const MAX_DPR          = 3;

  const IDLE = 0, VIBRATE = 1, SCHOOL = 2, REFORM = 3, FADE = 4, INTRO = 5;
  const TAU = Math.PI * 2;

  /* ── Page checks ───────────────────────────────────────── */
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (motion.matches) return;
  if (!window.Path2D || !window.fetch || !window.DOMParser || !window.IntersectionObserver) return;


  /* ── Fish shape ────────────────────────────────────────── */
  /* One solid outline in fish lengths: snout at +0.5 pointing along +x and
     tail tips at -0.5. The body is 0.23 tall, the tail stalk thin, and the
     forked tail 0.40 tall. A bend pushes the back half sideways, more toward
     the tail, for the swimming wiggle. */
  function fishShape(bend) {
    const pts = [];                  // M x y | Q cx cy x y | L x y, in fish lengths
    const Y  = (px, py) => py + (px < 0 ? bend * 4 * px * px : 0);
    const M  = (px, py) => pts.push(0, px, Y(px, py));
    const Ln = (px, py) => pts.push(1, px, Y(px, py));
    const Q  = (cx, cy, px, py) => pts.push(2, cx, Y(cx, cy), px, Y(px, py));
    M(0.50, 0);                      // pointed snout
    Q(0.40, -0.09, 0.18, -0.115);    // head rising to the top of the back
    Q(-0.10, -0.115, -0.32, -0.03);  // back tapering into the tail stalk
    Ln(-0.35, -0.035);
    Q(-0.40, -0.13, -0.50, -0.20);   // upper tail lobe, front edge
    Q(-0.47, -0.07, -0.39, 0);       // upper lobe back edge, down into the fork
    Q(-0.47, 0.07, -0.50, 0.20);     // lower lobe back edge
    Q(-0.40, 0.13, -0.35, 0.035);    // lower lobe front edge
    Ln(-0.32, 0.03);
    Q(-0.10, 0.115, 0.18, 0.115);    // belly
    Q(0.40, 0.09, 0.50, 0);
    return Float64Array.from(pts);
  }
  /* Adds one fish outline, moved, turned, and sized by (a b c d e f), to a
     Path2D. No closePath: a fill closes every outline anyway, and closePath
     gets slower the bigger the path is. */
  function addFish(path, sh, a, b, c, d, e, f) {
    for (let k = 0; k < sh.length;) {
      const t = sh[k];
      if (t === 2) {
        const cx = sh[k + 1], cy = sh[k + 2], px = sh[k + 3], py = sh[k + 4];
        path.quadraticCurveTo(a * cx + c * cy + e, b * cx + d * cy + f, a * px + c * py + e, b * px + d * py + f);
        k += 5;
      } else {
        const px = sh[k + 1], py = sh[k + 2];
        if (t === 0) path.moveTo(a * px + c * py + e, b * px + d * py + f);
        else path.lineTo(a * px + c * py + e, b * px + d * py + f);
        k += 3;
      }
    }
  }
  const SHAPES = [];
  for (let k = 0; k < BEND_STEPS; k++) SHAPES.push(fishShape(MAX_BEND * (2 * k / (BEND_STEPS - 1) - 1)));
  const MID_BEND  = (BEND_STEPS - 1) / 2;
  const SHADE_CSS = SHADES.map(v => `rgb(${v},${v},${v})`);

  /* Seeded random numbers for the home spots, so the logo packs the same
     way every time and a rebuild doesn't reshuffle it. */
  function seeded(seed) {
    return function () {
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ── One fish logo ─────────────────────────────────────── */
  /* Everything below runs once per logo. cfg gives its pieces:
       root     where the cursor counts as "here" (the hero, the footer)
       area     the box the fish swim in (the bracket frame, the whole footer)
       logo     the logo wrapper; tuna and word are its two SVG layers
       avoid    the text and links the fish keep clear of
       intro    play the page-load intro from the hero's ripple
       shown    an extra "is it on screen" test, if any
       canvasClass, before   the canvas's class, and what it goes in front of */
  function fishLogo(cfg) {
    const { root, area, logo, tuna, word } = cfg;
    if (!root || !area || !logo || !tuna || !word) return;
    const avoidEls = cfg.avoid.filter(Boolean);

    /* The pieces of the logo, each packed with its own fish size. The two SVG
       layers share one box and viewBox. The wordmark SVG has two paths, one
       for DOGTOOTH and the lines and one for the SYSTEMS letters. */
    const PARTS = [
      { img: tuna, paths: 'path',          len: FISH_LENGTH,          shape: null, mask: null },
      { img: word, paths: 'path#dogtooth', len: WORDMARK_FISH_LENGTH, shape: null, mask: null },
      { img: word, paths: 'path#systems',  len: SYSTEMS_FISH_LENGTH,  shape: null, mask: null },
    ];

    const canvas = document.createElement('canvas');
    canvas.className = cfg.canvasClass;
    canvas.setAttribute('aria-hidden', 'true');
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    area.insertBefore(canvas, cfg.before || area.firstChild);
    /* An empty box exactly the size of the swim area. All fish positions
       are measured in its pixels. During the hero's intro the canvas widens
       past it, so the fish can start on the ripple's ring. */
    const box = document.createElement('div');
    box.setAttribute('aria-hidden', 'true');
    box.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;visibility:hidden;pointer-events:none';
    area.insertBefore(box, canvas);

    /* Hide the hero logo for the intro. Only this script hides it, so if the
       script never runs, the plain logo shows as usual. */
    if (cfg.intro) logo.style.opacity = '0';

    /* ── State ─────────────────────────────────────────────── */
    let state = cfg.intro ? INTRO : IDLE;
    let introPhase = 'wait';   // 'wait' for the ripple, then 'swim'
    let ringX = 0, ringY = 0, ringR = 0, ringKnown = false;   // the ripple's widest ring, in frame pixels
    let OX = 0, OY = 0, CW = 1, CH = 1;   // the frame's spot inside the canvas, and the canvas size
    let canvasWide = false, heroL = 0, heroR = 0;   // canvas widened for the intro; the hero's sides in frame pixels
    let enabled = true, ready = false, introDone = false, inView = false;
    let built = null;       // the layout the homes were built for
    let cssW = 0, cssH = 0, kx = 1, ky = 1;
    let minX = 0, maxX = 0, minY = 0, maxY = 0;

    let N = 0;
    let hx, hy, x, y, vx, vy, ax, ay, ang, phase, wig, fear, wand, bx, by, rel, held, shade, flen, mj;
    let vax, vay, vfx, vfy, vpx, vpy, tear;        // shiver, and each fish's sideways jump in a torn band
    let vibDur = 0.15, spellLeft = 0;              // this blink's length (s), blinks left in the spell
    let wpX, wpY, wpTX, wpTY, wpCum, wpN, rdur, rdel;    // re-form paths
    let order, shadeStart;                         // fish grouped by shade for drawing
    let gCols = 0, gRows = 0, gCount, gStart, gItems, gCell;  // spatial grid

    const avoid = new Float32Array(4 * avoidEls.length);  // text boxes: left, top, right, bottom
    let avoidCount = 0;

    let raf = 0, lastNow = 0, simTime = 0;   // simTime only moves while the loop runs
    let vibTimer = 0, fadeTimer = 0, vibT0 = 0, reformT0 = 0;

    const ptr = { kind: 'mouse', cx: 0, cy: 0, inWindow: false, touchId: null, down: false, captured: false };
    let lastMove = 0;                        // simTime of the last cursor move in the hero, or finger lift
    let predActive = false, predX = 0, predY = 0;
    let lastPredX = 0, lastPredY = 0, lastPredOk = false;   // the cursor one frame ago, for the startle
    let checkRaf = 0, lastCheckX = NaN, lastCheckY = NaN;

    /* Results come back through these small arrays rather than plain
       variables, which would make a new number object on every write and keep
       the garbage collector busy. */
    const SV = new Float64Array(2);          // steer() result: x, y
    const CP = new Float64Array(2);          // toCanvas() result: x, y
    const PP = new Float64Array(4);          // pathPoint() result: x, y, dx, dy

    /* ── Layout ────────────────────────────────────────────── */
    /* Everything is in the bracket frame's own CSS pixels. The hero content
       can be moved by the cursor parallax and scaled by the scroll fade, so
       positions are taken relative to the frame box and divided by its
       current scale. */
    function measure() {
      const cs = getComputedStyle(box);
      const w = parseFloat(cs.width), h = parseFloat(cs.height);
      if (!(w > 0 && h > 0)) return null;
      const cr = box.getBoundingClientRect();
      const s = cr.width / w || 1;
      const tr = tuna.getBoundingClientRect();
      if (!tr.width) return null;
      return {
        w, h,
        bx: (tr.left - cr.left) / s, by: (tr.top - cr.top) / s,
        bw: tr.width / s, bh: tr.height / s,
        dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR),
      };
    }
    function sameLayout(a, b) {
      if (!b) return false;
      const near = (p, q) => Math.abs(p - q) < 0.05;
      return near(a.w, b.w) && near(a.h, b.h) && near(a.bx, b.bx) && near(a.by, b.by) &&
             near(a.bw, b.bw) && near(a.bh, b.bh) && a.dpr === b.dpr;
    }
    /* Only called while idle. Rebuilds the homes if anything moved. */
    function syncLayout() {
      const m = measure();
      if (!m) return false;
      if (!sameLayout(m, built)) rebuild(m);
      return N > 0;
    }
    function toCanvas(clientX, clientY) {
      const r = box.getBoundingClientRect();
      const s = r.width / cssW || 1;
      CP[0] = (clientX - r.left) / s;
      CP[1] = (clientY - r.top) / s;
    }
    /* The title and the buttons count as one block, gap included, so fish
       never get stuck single file in the narrow gap between them. */
    function measureAvoid() {
      const cr = box.getBoundingClientRect();
      const s = cr.width / cssW || 1;
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      for (const el of avoidEls) {
        const e = el.getBoundingClientRect();
        if (!e.width) continue;
        l = Math.min(l, e.left); t = Math.min(t, e.top); r = Math.max(r, e.right); b = Math.max(b, e.bottom);
      }
      avoidCount = l < r ? 1 : 0;
      if (!avoidCount) return;
      avoid[0] = (l - cr.left) / s - TEXT_PAD;
      avoid[1] = (t - cr.top)  / s - TEXT_PAD;
      avoid[2] = (r - cr.left) / s + TEXT_PAD;
      avoid[3] = (b - cr.top)  / s + TEXT_PAD;
    }

    /* ── Logo masks and home spots ─────────────────────────── */
    /* Draw each logo layer once on an offscreen canvas at its exact on-screen
       size and place, from the same path data its SVG uses. */
    function buildMask(shape, m) {
      const [vbX, vbY, vbW, vbH] = shape.vb;
      const k = Math.max(2, m.dpr);    // mask pixels per CSS pixel
      const w = Math.max(1, Math.ceil(m.bw * k)), h = Math.max(1, Math.ceil(m.bh * k));
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      const c = off.getContext('2d', { willReadFrequently: true });
      const s = Math.min(m.bw / vbW, m.bh / vbH);   // the SVG default, xMidYMid meet
      const ox = (m.bw - vbW * s) / 2 - vbX * s;
      const oy = (m.bh - vbH * s) / 2 - vbY * s;
      c.setTransform(k * s, 0, 0, k * s, k * ox, k * oy);
      c.fillStyle = '#fff';
      for (const p of shape.paths) c.fill(p.path, p.rule);
      const data = c.getImageData(0, 0, w, h).data;
      const alpha = new Uint8Array(w * h);
      for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3];
      return { x: m.bx, y: m.by, k, w, h, alpha };
    }
    function filled(mask, px, py) {
      const mx = Math.floor((px - mask.x) * mask.k), my = Math.floor((py - mask.y) * mask.k);
      return mx >= 0 && my >= 0 && mx < mask.w && my < mask.h && mask.alpha[my * mask.w + mx] >= 128;
    }
    function onLogo(px, py) {
      for (const part of PARTS) if (part.mask && filled(part.mask, px, py)) return true;
      return false;
    }
    /* The tuna and the wordmark count as one shape: touching either one breaks
       the whole logo. */
    function touchesLogo(px, py) {
      if (onLogo(px, py)) return true;
      for (let k = 0; k < 8; k++) {
        const a = k * TAU / 8;
        if (onLogo(px + Math.cos(a) * TOUCH_SLOP, py + Math.sin(a) * TOUCH_SLOP)) return true;
      }
      return false;
    }

    /* Brick pattern over each layer: rows ROW_SPACING apart, fish
       COLUMN_SPACING apart (both in that layer's fish lengths), every other row
       shifted by half a fish, plus a little jitter. A fish is kept only if its
       center is on the layer and at least one of its ends is too, so the eye,
       mouth, teeth, stripes, and the holes in the letters stay open. At home
       every fish faces left, the way the tuna faces, so its ends are left and
       right of its center. */
    function buildHomes(mask, len, seed, list) {
      const rand = seeded(seed);
      const rowH = ROW_SPACING * len, colW = COLUMN_SPACING * len, reach = END_REACH * len;
      const x0 = mask.x, x1 = mask.x + mask.w / mask.k;
      const y0 = mask.y, y1 = mask.y + mask.h / mask.k;
      for (let row = 0, py = y0 + rowH / 2; py < y1; row++, py += rowH) {
        for (let px = x0 + (row % 2 ? colW / 2 : 0); px < x1; px += colW) {
          const fx = px + (rand() - 0.5) * 2 * HOME_JITTER_X * len;
          const fy = py + (rand() - 0.5) * 2 * HOME_JITTER_Y * len;
          if (!filled(mask, fx, fy)) continue;
          if (!filled(mask, fx - reach, fy) && !filled(mask, fx + reach, fy)) continue;
          list.push(fx, fy, rand(), len);
        }
      }
    }

    function alloc(n) {
      const F = () => new Float32Array(n);
      hx = F(); hy = F(); x = F(); y = F(); vx = F(); vy = F(); ax = F(); ay = F();
      ang = F(); phase = F(); wig = F(); fear = F(); wand = F(); bx = F(); by = F(); mj = F();
      vax = F(); vay = F(); vfx = F(); vfy = F(); vpx = F(); vpy = F(); rdur = F(); rdel = F(); tear = F();
      rel = new Float64Array(n);
      held = new Uint8Array(n); shade = new Uint8Array(n); flen = F();
      wpX = new Float32Array(n * 4); wpY = new Float32Array(n * 4);
      wpTX = new Float32Array(n * 4); wpTY = new Float32Array(n * 4);
      wpCum = new Float32Array(n * 4); wpN = new Uint8Array(n);
      order = new Int32Array(n); gItems = new Int32Array(n); gCell = new Int32Array(n);
      for (let i = 0; i < n; i++) { phase[i] = Math.random() * TAU; mj[i] = (Math.random() - 0.5) * MARGIN_SPREAD; }
    }

    function rebuild(m) {
      built = m;
      cssW = m.w; cssH = m.h;
      placeCanvas(m.dpr, false);

      const list = [];
      PARTS.forEach((part, p) => {
        part.mask = buildMask(part.shape, m);
        buildHomes(part.mask, part.len, 20261104 + p, list);
      });
      N = list.length / 4;
      alloc(N);

      const counts = new Int32Array(SHADES.length);
      for (let i = 0; i < N; i++) {
        hx[i] = list[i * 4];
        hy[i] = list[i * 4 + 1];
        shade[i] = Math.min(SHADES.length - 1, Math.floor(list[i * 4 + 2] * SHADES.length));
        flen[i] = list[i * 4 + 3];
        counts[shade[i]]++;
      }
      shadeStart = new Int32Array(SHADES.length + 1);
      for (let s = 0; s < SHADES.length; s++) shadeStart[s + 1] = shadeStart[s] + counts[s];
      const next = shadeStart.slice(0, SHADES.length);
      for (let i = 0; i < N; i++) order[next[shade[i]]++] = i;

      minX = EDGE_INSET; maxX = cssW - EDGE_INSET;
      minY = EDGE_INSET; maxY = cssH - EDGE_INSET;
      gCols = Math.max(1, Math.ceil(cssW / CELL));
      gRows = Math.max(1, Math.ceil(cssH / CELL));
      gCount = new Int32Array(gCols * gRows);
      gStart = new Int32Array(gCols * gRows + 1);

      placeHome();
      lastCheckX = NaN;          // old canvas coordinates mean nothing now
      canvas.dataset.fish = String(N);
    }

    /* Moving the window to a screen with a different pixel density doesn't
       always fire a resize. While the fish are out, keep the canvas sharp by
       resizing its pixels in place. (While idle, the next swap rebuilds.) */
    function matchDpr() {
      const d = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      if (!built || d === built.dpr) return;
      built.dpr = d;
      sizeCanvas(d);
    }
    /* Normally the canvas is exactly the bracket frame. For the intro it
       widens to also take in the ripple's ring (kept inside the hero, plus
       room for the cursor parallax), then shrinks back once the logo is whole,
       because a bigger canvas costs the GPU more on every frame. */
    function placeCanvas(dpr, wide) {
      if (!wide) { OX = 0; OY = 0; CW = cssW; CH = cssH; }
      else {
        const br = box.getBoundingClientRect(), hr = root.getBoundingClientRect();
        const s = br.width / cssW || 1, pad = 40, m = 2 * L;
        heroL = (hr.left - br.left) / s;
        heroR = heroL + hr.width / s;
        const ht = (hr.top - br.top) / s, hb = ht + hr.height / s;
        const l = Math.max(heroL - pad, Math.min(0, ringX - ringR - m));
        const t = Math.max(ht - pad, Math.min(0, ringY - ringR - m));
        const r = Math.min(heroR + pad, Math.max(cssW, ringX + ringR + m));
        const b = Math.min(hb + pad, Math.max(cssH, ringY + ringR + m));
        OX = -l; OY = -t; CW = r - l; CH = b - t;
      }
      canvasWide = wide;
      canvas.style.left = -OX + 'px';
      canvas.style.top = -OY + 'px';
      canvas.style.width = CW + 'px';
      canvas.style.height = CH + 'px';
      sizeCanvas(dpr);
    }
    function sizeCanvas(dpr) {
      canvas.width  = Math.max(1, Math.round(CW * dpr));
      canvas.height = Math.max(1, Math.round(CH * dpr));
      kx = canvas.width / CW;
      ky = canvas.height / CH;
    }

    function placeHome() {
      for (let i = 0; i < N; i++) {
        x[i] = hx[i]; y[i] = hy[i];
        vx[i] = 0; vy[i] = 0;
        ang[i] = Math.PI; wig[i] = 0; fear[i] = 0; held[i] = 0;
      }
    }

    /* ── Drawing ───────────────────────────────────────────── */
    /* Every fish of one shade is added (moved, turned, and sized) into one
       combined Path2D, and each shade is filled once. Hundreds of separate
       small fills per frame cost the GPU far more than a handful of big ones. */
    function draw() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (let s = 0; s < SHADE_CSS.length; s++) {
        const end = shadeStart[s + 1];
        if (end === shadeStart[s]) continue;
        const batch = new Path2D();
        for (let k = shadeStart[s]; k < end; k++) {
          const i = order[k];
          const c = Math.cos(ang[i]) * flen[i], sn = Math.sin(ang[i]) * flen[i];
          addFish(batch, SHAPES[Math.round(MID_BEND + Math.sin(phase[i]) * wig[i] * MID_BEND)],
                  kx * c, ky * sn, -kx * sn, ky * c, kx * (x[i] + OX), ky * (y[i] + OY));
        }
        ctx.fillStyle = SHADE_CSS[s];
        ctx.fill(batch);
      }
    }

    /* Swaps happen inside one task, so the browser paints them in one frame.
       The whole SVG logo (both layers) hides and shows together. */
    function hideSvg() {
      logo.style.transition = 'none';
      logo.style.opacity = '0';
    }
    /* Shows the canvas at full strength, also cancelling the fade-out that
       startFade() may have begun if the logo is broken again mid-fade. */
    function showCanvas() {
      canvas.style.transition = '';
      canvas.style.opacity = '';
      canvas.style.visibility = 'visible';
    }
    function showFish() {
      draw();
      showCanvas();
      hideSvg();
    }
    function showSvg() {
      logo.style.transition = 'none';
      logo.style.opacity = '';
      canvas.style.visibility = '';
      canvas.style.transition = '';
      canvas.style.opacity = '';
    }

    /* ── Loop and run state ────────────────────────────────── */
    function startLoop() {
      if (raf) return;
      lastNow = performance.now();
      lastPredOk = false;        // after a pause the cursor may have jumped; no startle from that
      raf = requestAnimationFrame(tick);
    }
    function stopLoop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
    function tick(now) {
      raf = 0;
      // physics steps are capped so a slow frame can't make fish jump; the intro's
      // paths are scripted, so it may take bigger steps and still end on time
      const dt = Math.min(Math.max((now - lastNow) / 1000, 0), state === INTRO ? 0.1 : 1 / 30);
      lastNow = now;
      simTime += dt;
      if (state === VIBRATE) stepVibrate();
      else if (state === SCHOOL) stepSchool(dt);
      else if (state === REFORM || (state === INTRO && introPhase === 'swim')) {
        stepReform(dt);
        if (state === INTRO) checkIntroTouch();
      }
      if (state === VIBRATE || state === SCHOOL || state === REFORM || (state === INTRO && introPhase === 'swim')) {
        matchDpr();
        draw();
        raf = requestAnimationFrame(tick);
      }
    }

    /* Any extra "is it on screen" test the logo has (the hero's scroll fade). */
    function frameShown() {
      return !cfg.shown || cfg.shown();
    }
    function canRun() {
      return enabled && ready && N > 0 && introDone && inView && !document.hidden && frameShown();
    }
    function updateRunState() {
      if (!canRun()) {
        clearTimeout(vibTimer); vibTimer = 0;
        if (state === VIBRATE) { placeHome(); toIdle(); }
        stopLoop();                       // a broken logo just freezes until the hero is back
        return;
      }
      if (state === IDLE) { if (!vibTimer) scheduleVibrate(); }
      else if (state === INTRO && introPhase === 'wait') maybeStartIntro();
      else if (state !== FADE) startLoop();
    }
    const pick = ([lo, hi]) => lo + Math.random() * (hi - lo);
    /* Glitch timing: inside a spell the next blink usually comes right away
       (the cube makes short waits common and 2 s waits rare); after the last
       blink of a spell comes a calm stretch. */
    function scheduleVibrate() {
      clearTimeout(vibTimer); vibTimer = 0;
      if (state !== IDLE || !canRun()) return;
      let wait;
      if (spellLeft > 0) {
        const r = Math.random();
        wait = 50 + (VIBRATE_GAP_MAX - 50) * r * r * r;
      } else {
        spellLeft = SPELL_BLINKS[Math.floor(Math.random() * SPELL_BLINKS.length)];
        wait = pick(VIBRATE_INTERVAL);
      }
      vibTimer = setTimeout(() => { vibTimer = 0; startVibrate(); }, wait);
    }
    function toIdle() {
      stopLoop();
      clearTimeout(fadeTimer); fadeTimer = 0;
      state = IDLE;
      showSvg();
      if (canvasWide && built) placeCanvas(built.dpr, false);
      scheduleVibrate();
    }
    function resetToIdle() {
      clearTimeout(vibTimer); vibTimer = 0;
      if (N) placeHome();
      toIdle();
    }

    /* ── Vibrate ───────────────────────────────────────────── */
    function startVibrate() {
      if (state !== IDLE || !canRun() || !syncLayout()) return;
      placeHome();
      spellLeft = Math.max(0, spellLeft - 1);
      vibDur = (Math.random() < BLINK_LONG_CHANCE ? pick(BLINK_LONG) : pick(BLINK_SHORT)) / 1000;
      // a crack: one or two thin horizontal bands of the logo jump sideways for this blink
      tear.fill(0);
      if (Math.random() < TEAR_CHANCE) {
        const bands = Math.random() < 0.35 ? 2 : 1;
        for (let b = 0; b < bands; b++) {
          const h = 4 + Math.random() * 10;
          const top = built.by + Math.random() * (built.bh - h);
          const shift = pick(TEAR_SHIFT) * (Math.random() < 0.5 ? -1 : 1);
          for (let i = 0; i < N; i++) if (hy[i] >= top && hy[i] < top + h) tear[i] = shift;
        }
      }
      for (let i = 0; i < N; i++) {
        const a = VIBRATE_STRENGTH * (0.5 + 0.5 * Math.random());
        vax[i] = a; vay[i] = a * 0.6;
        vfx[i] = TAU * (8 + 6 * Math.random());
        vfy[i] = TAU * (8 + 6 * Math.random());
        vpx[i] = Math.random() * TAU;
        vpy[i] = Math.random() * TAU;
      }
      state = VIBRATE;
      vibT0 = simTime;
      showFish();
      startLoop();
    }
    /* Each fish jitters around its home on its own rhythm, and a torn band
       sits shifted sideways. The shiver eases in and out, and the last frame
       snaps back exactly onto the homes before the SVG returns. */
    function stepVibrate() {
      const s = simTime - vibT0, t = s / vibDur;
      if (t >= 1) { placeHome(); toIdle(); return; }
      const env = Math.sin(Math.PI * t);
      for (let i = 0; i < N; i++) {
        x[i] = hx[i] + tear[i] + vax[i] * env * Math.sin(vfx[i] * s + vpx[i]);
        y[i] = hy[i] + vay[i] * env * Math.sin(vfy[i] * s + vpy[i]);
        ang[i] = Math.PI + 0.07 * env * Math.sin(vfy[i] * 0.7 * s + vpx[i]);
        phase[i] = vpy[i] + vfx[i] * 0.4 * s;
        wig[i] = 0.7 * env;
      }
    }

    /* ── Break ─────────────────────────────────────────────── */
    /* Every fish gets a burst straight away from the touch point, strongest
       right there. Fish still sitting in the logo let go later the farther
       they are from it, so the logo tears open where it was touched first. */
    function breakLogo(px, py) {
      if (state === SCHOOL) return;
      if (state === IDLE) {
        if (!syncLayout()) return;
        placeHome();
      }
      const from = state;
      clearTimeout(vibTimer); vibTimer = 0;
      spellLeft = 0;
      clearTimeout(fadeTimer); fadeTimer = 0;
      measureAvoid();
      for (let i = 0; i < N; i++) {
        const dx = x[i] - px, dy = y[i] - py;
        const d = Math.hypot(dx, dy);
        const k = Math.exp(-d / BURST_FALLOFF);
        const speed = CRUISE_SPEED + (FLEE_SPEED - CRUISE_SPEED) * k;
        const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * (0.7 + 1.3 * (1 - k));   // far fish scatter more
        bx[i] = Math.cos(a) * speed;
        by[i] = Math.sin(a) * speed;
        fear[i] = Math.max(fear[i], k);
        wand[i] = (Math.random() - 0.5) * 0.8;
        const swimming = (from === REFORM || from === INTRO) && (x[i] !== hx[i] || y[i] !== hy[i]);
        if (swimming) {
          held[i] = 0;
          vx[i] += bx[i]; vy[i] += by[i];
        } else {
          held[i] = 1;
          rel[i] = simTime + d * TEAR_DELAY;
          vx[i] = 0; vy[i] = 0;
        }
      }
      state = SCHOOL;
      lastMove = simTime;
      lastCheckX = NaN;          // the next hover check starts fresh after the re-form
      lastPredOk = false;
      predX = px; predY = py; predActive = true;
      if (from === IDLE) showFish();
      else {
        hideSvg();
        showCanvas();
      }
      startLoop();
    }

    /* ── School ────────────────────────────────────────────── */
    /* Spatial grid: fish are sorted into square cells half a neighbor radius
       wide, so each fish only checks the 5 x 5 block of cells around it
       instead of all the other fish. The block is checked nearest cells
       first, and a fish stops looking once it has found MAX_NEIGHBORS fish
       in range, like real schooling fish that only watch their closest
       neighbors. That keeps the cost flat even when the school is packed
       tight, right after the logo breaks. */
    const CELL_ORDER = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) CELL_ORDER.push([dx, dy]);
    CELL_ORDER.sort((a, b) => (a[0] * a[0] + a[1] * a[1]) - (b[0] * b[0] + b[1] * b[1]));
    const CELL_DX = Int8Array.from(CELL_ORDER, c => c[0]), CELL_DY = Int8Array.from(CELL_ORDER, c => c[1]);

    function fillGrid() {
      gCount.fill(0);
      const inv = 1 / CELL;
      for (let i = 0; i < N; i++) {
        let cx = (x[i] * inv) | 0, cy = (y[i] * inv) | 0;
        if (cx < 0) cx = 0; else if (cx >= gCols) cx = gCols - 1;
        if (cy < 0) cy = 0; else if (cy >= gRows) cy = gRows - 1;
        const c = cy * gCols + cx;
        gCell[i] = c;
        gCount[c]++;
      }
      gStart[0] = 0;
      for (let c = 0; c < gCount.length; c++) gStart[c + 1] = gStart[c] + gCount[c];
      for (let c = 0; c < gCount.length; c++) gCount[c] = gStart[c];   // reuse as write positions
      for (let i = 0; i < N; i++) gItems[gCount[gCell[i]]++] = i;
    }

    /* Steering: turns a wish ("swim this way at this speed") into a push on
       the current velocity, capped so no single urge can yank a fish around. */
    function steer(dx, dy, speed, vxi, vyi, cap) {
      const m = Math.sqrt(dx * dx + dy * dy);
      if (m < 1e-9) { SV[0] = 0; SV[1] = 0; return; }
      let sx = dx / m * speed - vxi, sy = dy / m * speed - vyi;
      const f = Math.sqrt(sx * sx + sy * sy);
      if (f > cap) { sx *= cap / f; sy *= cap / f; }
      SV[0] = sx; SV[1] = sy;
    }

    function edgeNear(d, margin) {
      return d >= margin ? 0 : 1 - Math.max(d, 0) / margin;
    }

    /* The cursor counts as in the logo's area (the hero or the footer) only
       if that area is what's under it. The hero is sticky, so its box always
       fills the window, even while the next section slides over it. The
       fixed nav sits on top of the page, so the nav counts too while the
       area is under it. */
    const nav = document.getElementById('nav');
    function rootUnder(cx, cy, allowNav) {
      const stack = document.elementsFromPoint(cx, cy);
      for (const el of stack) {
        if (allowNav && nav && nav.contains(el)) continue;
        return root.contains(el);
      }
      return false;
    }
    function updatePredator() {
      toCanvas(ptr.cx, ptr.cy);
      predX = CP[0]; predY = CP[1];
      if (ptr.kind === 'touch') { predActive = ptr.down; return; }
      predActive = ptr.inWindow && rootUnder(ptr.cx, ptr.cy, true);
    }

    function stepSchool(dt) {
      updatePredator();
      const rested = simTime - lastMove > REFORM_DELAY / 1000;
      if (ptr.kind === 'touch' ? (!ptr.down && rested) : (!predActive || rested)) {
        startReform();
        return;
      }

      measureAvoid();   // every frame: the title and buttons may still be sliding in
      fillGrid();
      const NR2 = NEIGHBOR_RADIUS * NEIGHBOR_RADIUS;
      const SR2 = SEPARATION_RADIUS * SEPARATION_RADIUS;
      const FR2 = FLEE_RADIUS * FLEE_RADIUS;

      for (let i = 0; i < N; i++) {
        if (held[i]) { ax[i] = 0; ay[i] = 0; continue; }
        const xi = x[i], yi = y[i], vxi = vx[i], vyi = vy[i];
        const sp = Math.sqrt(vxi * vxi + vyi * vyi);

        let sepX = 0, sepY = 0, aliX = 0, aliY = 0, cohX = 0, cohY = 0, n = 0;
        const c = gCell[i], gx = c % gCols, gy = (c - gx) / gCols;
        scan: for (let o = 0; o < CELL_DX.length; o++) {
          const cx = gx + CELL_DX[o], cy = gy + CELL_DY[o];
          if (cx < 0 || cy < 0 || cx >= gCols || cy >= gRows) continue;
          const cell = cy * gCols + cx;
          for (let k = gStart[cell], e = gStart[cell + 1]; k < e; k++) {
            const j = gItems[k];
            if (j === i) continue;
            const dx = x[j] - xi, dy = y[j] - yi, d2 = dx * dx + dy * dy;
            if (d2 >= NR2) continue;
            aliX += vx[j]; aliY += vy[j];
            cohX += dx; cohY += dy;
            if (d2 < SR2 && d2 > 1e-6) { sepX -= dx / d2; sepY -= dy / d2; }
            if (++n >= MAX_NEIGHBORS) break scan;
          }
        }

        let fx = 0, fy = 0;

        /* Separation: fish that are too close push apart, harder the closer
           they are, so the school never squashes into one clump. */
        if (sepX || sepY) {
          steer(sepX, sepY, MAX_SPEED, vxi, vyi, MAX_FORCE);
          fx += SV[0] * W_SEPARATION; fy += SV[1] * W_SEPARATION;
        }
        if (n) {
          /* Alignment: each fish turns to swim the same way as the fish
             around it. This is what makes them move together as a school. */
          if (aliX || aliY) {
            steer(aliX, aliY, CRUISE_SPEED, vxi, vyi, MAX_FORCE);
            fx += SV[0] * W_ALIGNMENT; fy += SV[1] * W_ALIGNMENT;
          }
          /* Cohesion: each fish drifts toward the middle of its neighbors,
             so stragglers rejoin the group instead of wandering off alone. */
          const cd = Math.sqrt(cohX * cohX + cohY * cohY) / n;   // how far off the middle it is
          steer(cohX, cohY, Math.min(CRUISE_SPEED, cd * 3), vxi, vyi, MAX_FORCE);
          fx += SV[0] * W_COHESION; fy += SV[1] * W_COHESION;
        }

        /* Wander: each fish has its own slowly drifting turn, so the school
           keeps cruising around even when the cursor sits still. */
        let w = wand[i] + (Math.random() - 0.5) * WANDER_TURN * Math.sqrt(dt) * 2;
        w -= w * 0.4 * dt;
        w = w > 1 ? 1 : w < -1 ? -1 : w;
        wand[i] = w;
        const head = (sp > 1e-3 ? Math.atan2(vyi, vxi) : ang[i]) + w;
        steer(Math.cos(head), Math.sin(head), CRUISE_SPEED, vxi, vyi, MAX_FORCE);
        fx += SV[0] * W_WANDER; fy += SV[1] * W_WANDER;

        /* Flee: inside FLEE_RADIUS a fish steers straight away from the cursor,
           harder the closer it is, like bait dodging a predator. That bends
           and splits the school around the cursor. Being scared also lets a
           fish swim faster than usual for a moment. */
        let close = 0;
        if (predActive) {
          const dx = xi - predX, dy = yi - predY, d2 = dx * dx + dy * dy;
          if (d2 < FR2) {
            close = 1 - Math.sqrt(d2) / FLEE_RADIUS;
            steer(dx, dy, FLEE_SPEED, vxi, vyi, MAX_FORCE);
            fx += SV[0] * FLEE_STRENGTH * close; fy += SV[1] * FLEE_STRENGTH * close;
          }
        }
        const f0 = fear[i] - FEAR_FADE * dt;
        fear[i] = close > f0 ? close : f0 > 0 ? f0 : 0;

        /* Cruise: a slow fish speeds back up along its heading. */
        if (sp < CRUISE_SPEED && sp > 1e-3) {
          const g = (CRUISE_SPEED - sp) * 3;
          fx += vxi / sp * g; fy += vyi / sp * g;
        }

        /* Text: near the title or buttons, any urge that points at them is
           faded out and a push sends the fish back out, so fish never swim
           over the words or the buttons. */
        const tm = TEXT_MARGIN + mj[i] * 0.5, em = EDGE_MARGIN + mj[i];
        for (let r = 0; r < avoidCount; r++) {
          const o = r * 4, l = avoid[o], t = avoid[o + 1], rr = avoid[o + 2], b = avoid[o + 3];
          const qx = xi < l ? l : xi > rr ? rr : xi;
          const qy = yi < t ? t : yi > b ? b : yi;
          let nx = xi - qx, ny = yi - qy, q;
          const d = Math.sqrt(nx * nx + ny * ny);
          if (d < 1e-6) {
            const el = xi - l, er = rr - xi, et = yi - t, eb = b - yi, mn = Math.min(el, er, et, eb);
            if (mn === el) { nx = -1; ny = 0; } else if (mn === er) { nx = 1; ny = 0; }
            else if (mn === et) { nx = 0; ny = -1; } else { nx = 0; ny = 1; }
            q = 1;
          } else if (d < tm) {
            nx /= d; ny /= d;
            q = 1 - d / tm;
          } else continue;
          const into = -(fx * nx + fy * ny);
          if (into > 0) { fx += into * nx * q; fy += into * ny * q; }
          fx += nx * q * q * TEXT_FORCE; fy += ny * q * q * TEXT_FORCE;
        }

        /* Looking ahead: a fish checks where it will be in EDGE_LOOK seconds.
           If that spot is near the frame or the text, it turns away now, so it
           never ends up sliding along an edge or the title in a line. */
        {
          const lx = xi + vxi * EDGE_LOOK, ly = yi + vyi * EDGE_LOOK;
          const back = Math.max(sp, MIN_SPEED) * 0.5;
          let rx = vxi, ry = vyi, turn = false;
          if (lx < minX + em) { rx = Math.max(Math.abs(vxi), back); turn = true; }
          else if (lx > maxX - em) { rx = -Math.max(Math.abs(vxi), back); turn = true; }
          if (ly < minY + em) { ry = Math.max(Math.abs(vyi), back); turn = true; }
          else if (ly > maxY - em) { ry = -Math.max(Math.abs(vyi), back); turn = true; }
          if (avoidCount && lx > avoid[0] - tm && lx < avoid[2] + tm && ly > avoid[1] - tm && ly < avoid[3] + tm) {
            // heading into the text block: turn away through the side it is coming from
            if (xi < avoid[0]) { rx = -Math.max(Math.abs(vxi), back); turn = true; }
            else if (xi > avoid[2]) { rx = Math.max(Math.abs(vxi), back); turn = true; }
            if (yi < avoid[1]) { ry = -Math.max(Math.abs(vyi), back); turn = true; }
            else if (yi > avoid[3]) { ry = Math.max(Math.abs(vyi), back); turn = true; }
          }
          if (turn) {
            steer(rx, ry, CRUISE_SPEED, vxi, vyi, MAX_FORCE);
            fx += SV[0] * W_EDGE_TURN; fy += SV[1] * W_EDGE_TURN;
          }
        }

        /* Edges: close to the bracket frame, urges that point out are faded
           away and a push turns the fish back in. The push grows quickly near
           the edge, so fish curve away before they reach it and never pile up
           or line up along it. */
        let q;
        if ((q = edgeNear(xi - minX, em)) > 0) { if (fx < 0) fx *= 1 - q; fx += q * q * EDGE_FORCE; }
        if ((q = edgeNear(maxX - xi, em)) > 0) { if (fx > 0) fx *= 1 - q; fx -= q * q * EDGE_FORCE; }
        if ((q = edgeNear(yi - minY, em)) > 0) { if (fy < 0) fy *= 1 - q; fy += q * q * EDGE_FORCE; }
        if ((q = edgeNear(maxY - yi, em)) > 0) { if (fy > 0) fy *= 1 - q; fy -= q * q * EDGE_FORCE; }

        ax[i] = fx; ay[i] = fy;
      }

      // the cursor's path since the last frame
      const sx0 = lastPredX, sy0 = lastPredY, sdx = predX - lastPredX, sdy = predY - lastPredY;
      const sl2 = sdx * sdx + sdy * sdy;
      const sweep = predActive && lastPredOk && sl2 > 9;
      lastPredX = predX; lastPredY = predY; lastPredOk = predActive;

      for (let i = 0; i < N; i++) {
        if (held[i]) {
          if (simTime < rel[i]) continue;
          held[i] = 0;                          // let go: dart off on the burst
          vx[i] = bx[i]; vy[i] = by[i];
          if (fear[i] > 0.3) ang[i] = Math.atan2(by[i], bx[i]);   // fish near the touch flick around at once
        }
        let nvx = vx[i] + ax[i] * dt, nvy = vy[i] + ay[i] * dt;
        /* Startle: a fish right in the cursor's path this frame darts sideways
           out of it at full flee speed, so even a fast sweep splits the school
           where it passes instead of a moment later. */
        if (sweep) {
          const t = Math.max(0, Math.min(1, ((x[i] - sx0) * sdx + (y[i] - sy0) * sdy) / sl2));
          const ox = x[i] - (sx0 + sdx * t), oy = y[i] - (sy0 + sdy * t);
          const od2 = ox * ox + oy * oy;
          if (od2 < STARTLE_RADIUS * STARTLE_RADIUS) {
            let od = Math.sqrt(od2), ux = ox, uy = oy;
            if (od < 0.5) { const sl = Math.sqrt(sl2); ux = -sdy / sl; uy = sdx / sl; od = 1; }
            nvx = ux / od * FLEE_SPEED; nvy = uy / od * FLEE_SPEED;
            fear[i] = 1;
            // never dart into the text block or out through the frame: bounce off them instead
            if (avoidCount) {
              const qx = x[i] < avoid[0] ? avoid[0] : x[i] > avoid[2] ? avoid[2] : x[i];
              const qy = y[i] < avoid[1] ? avoid[1] : y[i] > avoid[3] ? avoid[3] : y[i];
              let nx = x[i] - qx, ny = y[i] - qy;
              const d = Math.sqrt(nx * nx + ny * ny);
              if (d > 1e-6 && d < 60) {
                nx /= d; ny /= d;
                const into = -(nvx * nx + nvy * ny);
                if (into > 0) { nvx += 2 * into * nx; nvy += 2 * into * ny; }
              }
            }
            if ((x[i] - minX < 60 && nvx < 0) || (maxX - x[i] < 60 && nvx > 0)) nvx = -nvx;
            if ((y[i] - minY < 60 && nvy < 0) || (maxY - y[i] < 60 && nvy > 0)) nvy = -nvy;
          }
        }
        let sp = Math.sqrt(nvx * nvx + nvy * nvy);
        const top = MAX_SPEED + (FLEE_SPEED - MAX_SPEED) * fear[i];
        if (sp > top) { nvx *= top / sp; nvy *= top / sp; sp = top; }
        else if (sp > CRUISE_SPEED && fear[i] < 0.01) {
          const f = Math.max(CRUISE_SPEED / sp, 1 - 0.9 * dt);   // calm down after a scare
          nvx *= f; nvy *= f; sp *= f;
        }
        if (sp < MIN_SPEED) {
          if (sp > 1e-3) { nvx *= MIN_SPEED / sp; nvy *= MIN_SPEED / sp; }
          else { nvx = Math.cos(ang[i]) * MIN_SPEED; nvy = Math.sin(ang[i]) * MIN_SPEED; }
          sp = MIN_SPEED;
        }
        let nx = x[i] + nvx * dt, ny = y[i] + nvy * dt;
        /* Last resort if a fast fish overshoots: stop it at the frame and turn
           it back in. The edge push above normally keeps this from happening. */
        /* A fish still outside the frame (broken mid-intro) is not snapped in;
           the edge push brings it in. */
        if (nx < minX) { if (x[i] >= minX) { nx = minX; if (nvx < 0) nvx = -nvx * 0.3; } }
        else if (nx > maxX) { if (x[i] <= maxX) { nx = maxX; if (nvx > 0) nvx = -nvx * 0.3; } }
        if (ny < minY) { if (y[i] >= minY) { ny = minY; if (nvy < 0) nvy = -nvy * 0.3; } }
        else if (ny > maxY) { if (y[i] <= maxY) { ny = maxY; if (nvy > 0) nvy = -nvy * 0.3; } }
        x[i] = nx; y[i] = ny; vx[i] = nvx; vy[i] = nvy;

        /* The body turns smoothly toward the heading, and the tail beats
           faster and wider the faster the fish swims. */
        let da = Math.atan2(nvy, nvx) - ang[i];
        da -= TAU * Math.round(da / TAU);
        ang[i] += da * Math.min(1, TURN_RATE * dt);
        phase[i] += dt * (7 + 0.16 * sp);
        wig[i] = Math.min(1, 0.45 + sp / FLEE_SPEED);
      }
    }

    /* ── Re-form ───────────────────────────────────────────── */
    function segmentHitsBox(x0, y0, x1, y1, l, t, r, b) {
      let t0 = 0, t1 = 1;
      const dx = x1 - x0, dy = y1 - y0;
      const ps = [-dx, dx, -dy, dy], qs = [x0 - l, r - x0, y0 - t, b - y0];
      for (let k = 0; k < 4; k++) {
        const p = ps[k], q = qs[k];
        if (p === 0) { if (q < 0) return false; continue; }
        const u = q / p;
        if (p < 0) { if (u > t1) return false; if (u > t0) t0 = u; }
        else { if (u < t0) return false; if (u < t1) t1 = u; }
      }
      return true;
    }

    /* Each fish gets its own path home: from where it is (leaving along its
       current heading), up a side lane past the title and buttons if they
       are in the way, into its home spot from the tail side so it arrives
       facing the way the tuna faces. Far fish take a little longer than near
       ones, and everyone is home within REFORM_DURATION. */
    function startReform() {
      state = REFORM;
      buildPaths(REFORM_DURATION / 1000, 0);
    }

    /* Paths for every fish from where it is now to its home. With a stagger
       (the intro), each fish also gets its own start delay. */
    function buildPaths(total, stagger) {
      reformT0 = simTime;
      predActive = false;
      measureAvoid();

      let ul = Infinity, ut = Infinity, ur = -Infinity, ub = -Infinity;
      for (let r = 0; r < avoidCount; r++) {
        ul = Math.min(ul, avoid[r * 4]);     ut = Math.min(ut, avoid[r * 4 + 1]);
        ur = Math.max(ur, avoid[r * 4 + 2]); ub = Math.max(ub, avoid[r * 4 + 3]);
      }
      // side lanes between the frame and the text; each fish gets its own spot across the lane.
      // Intro fish may swing outside the frame, so where a lane inside it is too narrow (phones,
      // where the title fills the frame) their lane runs out to the edge of the hero instead.
      let lo = minX, hi = maxX;
      if (stagger) {
        if (Math.max(minX, ul) - minX < 30) lo = Math.min(minX, heroL + 4);
        if (maxX - Math.min(maxX, ur) < 30) hi = Math.max(maxX, heroR - 4);
      }
      const laneLw = Math.max(0, Math.max(lo, ul) - lo - 32), laneRw = Math.max(0, hi - Math.min(hi, ur) - 32);
      const laneL = (lo + Math.max(lo, ul)) / 2, laneR = (Math.min(hi, ur) + hi) / 2;

      let far = 1;
      for (let i = 0; i < N; i++) far = Math.max(far, Math.hypot(hx[i] - x[i], hy[i] - y[i]));

      for (let i = 0; i < N; i++) {
        held[i] = 0;
        const o = i * 4, sx = x[i], sy = y[i], ex = hx[i], ey = hy[i];
        let n = 0;
        wpX[o] = sx; wpY[o] = sy; n = 1;
        if (avoidCount && sy > ut && segmentHitsBox(sx, sy, ex, ey, ul, ut, ur, ub)) {
          const left = sx < (ul + ur) / 2;
          const lane = (left ? laneL : laneR) + (Math.random() - 0.5) * (left ? laneLw : laneRw);
          // first sideways into the lane (below the text, or at the fish's own height
          // if it is beside the text), then up past the title, as a loose band, not single file
          wpX[o + n] = lane; wpY[o + n] = (sy > ub ? ub : sy) + Math.random() * 8; n++;
          wpX[o + n] = lane; wpY[o + n] = ut - Math.random() * 8; n++;
        }
        wpX[o + n] = ex; wpY[o + n] = ey; n++;
        wpN[i] = n;

        wpCum[o] = 0;
        for (let k = 1; k < n; k++) {
          wpCum[o + k] = wpCum[o + k - 1] + Math.hypot(wpX[o + k] - wpX[o + k - 1], wpY[o + k] - wpY[o + k - 1]);
        }
        // tangents: current heading at the start, smooth through the lane, facing left at home
        const sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
        if (sp > 1) { wpTX[o] = vx[i] / sp; wpTY[o] = vy[i] / sp; }
        else { wpTX[o] = Math.cos(ang[i]); wpTY[o] = Math.sin(ang[i]); }
        for (let k = 1; k < n - 1; k++) {
          const tx = wpX[o + k + 1] - wpX[o + k - 1], ty = wpY[o + k + 1] - wpY[o + k - 1];
          const tl = Math.sqrt(tx * tx + ty * ty) || 1;
          wpTX[o + k] = tx / tl; wpTY[o + k] = ty / tl;
        }
        wpTX[o + n - 1] = -1; wpTY[o + n - 1] = 0;

        // nearer fish tend to land first, with some spread, so the logo fills in as they arrive;
        // a long path gets more time (up to 15% over) so nobody streaks across the frame
        const len = wpCum[o + n - 1];
        if (stagger) {
          rdel[i] = Math.random() * stagger;
          const win = total - rdel[i];
          rdur[i] = Math.min(Math.max(win * (0.85 + 0.15 * Math.random()), len * 1.4 / REFORM_MAX_SPEED), win);   // all home by INTRO_DURATION
        } else {
          rdel[i] = 0;
          const base = total * (0.6 + 0.25 * Math.min(1, len / far) + 0.15 * Math.random());
          rdur[i] = Math.min(Math.max(base, len * 1.4 / REFORM_MAX_SPEED), total * 1.15);
        }
      }
    }

    /* Point and direction at fraction e of fish i's path (Hermite curves
       between the path points). */
    function pathPoint(i, e) {
      const o = i * 4, n = wpN[i], len = wpCum[o + n - 1];
      if (len < 1e-6) { PP[0] = wpX[o + n - 1]; PP[1] = wpY[o + n - 1]; PP[2] = -1; PP[3] = 0; return; }
      const s = e * len;
      let k = 0;
      while (k < n - 2 && s > wpCum[o + k + 1]) k++;
      const seg = Math.max(wpCum[o + k + 1] - wpCum[o + k], 1e-6);
      const u = Math.min(1, Math.max(0, (s - wpCum[o + k]) / seg));
      const u2 = u * u, u3 = u2 * u;
      const m0 = 0.9 * (k === 0 ? Math.min(seg, 60) : seg), m1 = 0.9 * (k === n - 2 ? Math.min(seg, 40) : seg);
      const p0x = wpX[o + k], p0y = wpY[o + k], p1x = wpX[o + k + 1], p1y = wpY[o + k + 1];
      const t0x = wpTX[o + k] * m0, t0y = wpTY[o + k] * m0;
      const t1x = wpTX[o + k + 1] * m1, t1y = wpTY[o + k + 1] * m1;
      const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
      PP[0] = h00 * p0x + h10 * t0x + h01 * p1x + h11 * t1x;
      PP[1] = h00 * p0y + h10 * t0y + h01 * p1y + h11 * t1y;
      const d00 = 6 * u2 - 6 * u, d10 = 3 * u2 - 4 * u + 1, d01 = -6 * u2 + 6 * u, d11 = 3 * u2 - 2 * u;
      PP[2] = d00 * p0x + d10 * t0x + d01 * p1x + d11 * t1x;
      PP[3] = d00 * p0y + d10 * t0y + d01 * p1y + d11 * t1y;
    }

    function stepReform(dt) {
      const t = simTime - reformT0;
      const intro = state === INTRO;
      let done = true;
      for (let i = 0; i < N; i++) {
        const ti = t - rdel[i];
        if (ti < 0) {                         // intro fish waiting its turn on the ring
          done = false;
          phase[i] += dt * 9;
          wig[i] = 0.5;
          continue;
        }
        const tau = ti >= rdur[i] ? 1 : ti / rdur[i];
        if (tau < 1) done = false;
        const e = tau + tau * tau - tau * tau * tau;   // leaves at speed, slows to a stop at home
        pathPoint(i, e);
        let px = PP[0], py = PP[1];
        if (!intro) {                         // intro fish start outside the frame
          if (px < minX) px = minX; else if (px > maxX) px = maxX;
          if (py < minY) py = minY; else if (py > maxY) py = maxY;
        }
        if (dt > 0) { vx[i] = (px - x[i]) / dt; vy[i] = (py - y[i]) / dt; }
        x[i] = px; y[i] = py;
        // face along the path, then turn to face the way the tuna faces at the end
        const head = Math.atan2(PP[3], PP[2]);
        const turn = tau <= 0.6 ? 0 : (tau - 0.6) / 0.4;
        let da = Math.PI - head;
        da -= TAU * Math.round(da / TAU);
        let want = head + da * turn * turn * (3 - 2 * turn) - ang[i];
        want -= TAU * Math.round(want / TAU);
        const most = 14 * dt;                // turn at most 14 rad/s, so the body never flips in one frame
        ang[i] += want > most ? most : want < -most ? -most : want;
        const sp = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
        phase[i] += dt * (7 + 0.16 * sp);
        wig[i] = Math.min(1, 0.45 + sp / FLEE_SPEED) * (1 - tau);
      }
      if (done) { placeHome(); startFade(); }
    }

    /* All home: the crisp SVG logo fades in over the fish, then the canvas hides. */
    function startFade() {
      state = FADE;
      stopLoop();
      draw();
      logo.style.transition = `opacity ${FADE_DURATION}ms ease`;
      logo.style.opacity = '';          // back to its own opacity (the footer logo is a little dimmed)
      /* The fish fade out under it, slowly at first, so the few snouts and
         tails that poke past the logo's outline don't vanish in one frame. */
      canvas.style.transition = `opacity ${FADE_DURATION}ms cubic-bezier(0.7, 0, 1, 1)`;
      canvas.style.opacity = '0';
      fadeTimer = setTimeout(() => { fadeTimer = 0; if (state === FADE) toIdle(); }, FADE_DURATION + 30);
    }

    /* ── Input ─────────────────────────────────────────────── */
    /* Mouse or pen. Hover hits are tested once per frame against the logo
       masks, including the points between the last check and now, so a quick
       flick across the logo still counts. */
    function checkPointer() {
      checkRaf = 0;
      if (!canRun() || state === SCHOOL || ptr.kind !== 'mouse' || !ptr.inWindow) { lastCheckX = NaN; return; }
      toCanvas(ptr.cx, ptr.cy);
      const px = CP[0], py = CP[1];
      if (state === INTRO) {
        if (introPhase === 'swim' && touchesFish(px, py, 6) && rootUnder(ptr.cx, ptr.cy, false)) breakLogo(px, py);
        lastCheckX = px; lastCheckY = py;
        return;
      }
      let hit = false, hitX = px, hitY = py;
      if (lastCheckX === lastCheckX) {
        const dx = px - lastCheckX, dy = py - lastCheckY;
        const steps = Math.min(60, Math.floor(Math.hypot(dx, dy) / 3));
        for (let s = 1; s <= steps && !hit; s++) {
          const qx = lastCheckX + dx * s / (steps + 1), qy = lastCheckY + dy * s / (steps + 1);
          if (touchesLogo(qx, qy)) { hit = true; hitX = qx; hitY = qy; }
        }
      }
      if (!hit && touchesLogo(px, py)) hit = true;
      lastCheckX = px; lastCheckY = py;
      // only if the hero is what's under the cursor (not the next section or the nav)
      if (hit && rootUnder(ptr.cx, ptr.cy, false)) breakLogo(hitX, hitY);
    }

    document.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      ptr.kind = 'mouse';
      ptr.cx = e.clientX; ptr.cy = e.clientY;
      ptr.inWindow = true;
      if (state === SCHOOL) {
        if (rootUnder(e.clientX, e.clientY, true)) lastMove = simTime;
      } else if (!checkRaf) {
        checkRaf = requestAnimationFrame(checkPointer);
      }
    }, { passive: true });
    document.addEventListener('mouseout', (e) => {
      if (!e.relatedTarget) { ptr.inWindow = false; lastCheckX = NaN; }
    });
    window.addEventListener('blur', () => { ptr.inWindow = false; lastCheckX = NaN; });

    /* Touch. A tap on the logo breaks it, and that finger then herds the fish
       (it doesn't scroll the page) until it lifts. Lifting starts the re-form
       timer. While the fish are out, a new touch elsewhere in the hero also
       scares them but still scrolls the page as usual. Only the logo has
       listeners that can stop a scroll, so a scroll that starts anywhere else
       on the hero never has to wait for this script. */
    function findTouch(list, id) {
      for (let k = 0; k < list.length; k++) if (list[k].identifier === id) return list[k];
      return null;
    }
    function startTouch(t, captured) {
      ptr.kind = 'touch';
      ptr.touchId = t.identifier;
      ptr.down = true;
      ptr.captured = captured;
      ptr.cx = t.clientX; ptr.cy = t.clientY;
      lastMove = simTime;
    }
    logo.addEventListener('touchstart', (e) => {
      if (!canRun() || ptr.touchId !== null || state === SCHOOL || state === INTRO) return;
      const t = e.changedTouches[0];
      toCanvas(t.clientX, t.clientY);
      if (!touchesLogo(CP[0], CP[1])) return;
      e.preventDefault();               // this finger herds the fish instead of scrolling
      startTouch(t, true);
      breakLogo(CP[0], CP[1]);
    }, { passive: false });
    logo.addEventListener('touchmove', (e) => {
      if (ptr.captured && e.cancelable && findTouch(e.changedTouches, ptr.touchId)) e.preventDefault();
    }, { passive: false });
    root.addEventListener('touchstart', (e) => {
      if (!canRun() || ptr.touchId !== null) return;
      const t = e.changedTouches[0];
      if (state === INTRO && introPhase === 'swim') {
        // a finger landing on the incoming fish breaks the logo like a normal break
        toCanvas(t.clientX, t.clientY);
        if (!touchesFish(CP[0], CP[1], 14)) return;
        startTouch(t, false);
        breakLogo(CP[0], CP[1]);
        return;
      }
      if (state !== SCHOOL) return;
      startTouch(t, false);
    }, { passive: true });
    root.addEventListener('touchmove', (e) => {
      if (ptr.touchId === null) return;
      const t = findTouch(e.changedTouches, ptr.touchId);
      if (!t) return;
      ptr.cx = t.clientX; ptr.cy = t.clientY;
      lastMove = simTime;
    }, { passive: true });
    const endTouch = (e) => {
      if (ptr.touchId === null || !findTouch(e.changedTouches, ptr.touchId)) return;
      ptr.touchId = null;
      ptr.down = false;
      ptr.captured = false;
      lastMove = simTime;
    };
    root.addEventListener('touchend', endTouch);
    root.addEventListener('touchcancel', endTouch);

    /* ── Pausing, resizing, reduced motion ─────────────────── */
    new IntersectionObserver((entries) => {
      inView = entries[entries.length - 1].isIntersecting;
      updateRunState();
    }, { threshold: 0 }).observe(root);
    document.addEventListener('visibilitychange', updateRunState);

    let shown = true, scrollRaf = 0;
    window.addEventListener('scroll', () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        const s = frameShown();
        if (s !== shown) { shown = s; updateRunState(); }
      });
    }, { passive: true });

    /* Rebuild the homes whenever the frame, logo, title, or buttons change
       size (a window resize, fonts loading, a zoom). A broken logo snaps back
       to the SVG first. */
    let layoutRaf = 0;
    function onLayout() {
      if (layoutRaf) return;
      layoutRaf = requestAnimationFrame(() => {
        layoutRaf = 0;
        if (!ready) return;
        const m = measure();
        if (!m || sameLayout(m, built)) return;
        if (state === INTRO && introPhase === 'wait') { rebuild(m); return; }   // fonts loading before the intro
        resetToIdle();
        rebuild(m);
        updateRunState();
      });
    }
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(onLayout);
      ro.observe(area); ro.observe(logo);
      avoidEls.forEach(el => ro.observe(el));
    }
    window.addEventListener('resize', onLayout);

    const onMotion = () => {
      enabled = !motion.matches;
      if (!enabled) resetToIdle();
      updateRunState();
    };
    if (motion.addEventListener) motion.addEventListener('change', onMotion);
    else if (motion.addListener) motion.addListener(onMotion);

    /* ── Start ─────────────────────────────────────────────── */
    /* Nothing runs until the intro has handed off. Coming back from a project
       page skips the intro before this file loads, so check the page too. */
    const wrap = document.getElementById('site-wrap');
    introDone = !wrap || wrap.classList.contains('revealing') || wrap.classList.contains('revealed');
    if (!introDone) {
      document.addEventListener('intro-done', () => { introDone = true; updateRunState(); }, { once: true });
    }

    const svgText = new Map();   // one fetch per SVG file
    function loadShape(part) {
      const url = part.img.currentSrc || part.img.src;
      if (!svgText.has(url)) {
        svgText.set(url, fetch(url).then(r => (r.ok ? r.text() : Promise.reject(new Error(r.status)))));
      }
      return svgText.get(url)
        .then((text) => {
          const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
          const vb = (doc.documentElement.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
          const paths = Array.from(doc.querySelectorAll(part.paths)).map(el => ({
            path: new Path2D(el.getAttribute('d') || ''),
            rule: el.getAttribute('fill-rule') === 'evenodd' ? 'evenodd' : 'nonzero',
          }));
          if (vb.length === 4 && vb.every(isFinite) && vb[2] > 0 && vb[3] > 0 && paths.length) part.shape = { vb, paths };
        })
        .catch(() => { part.shape = null; });
    }
    const loaded = img => (img.complete && img.naturalWidth)
      ? Promise.resolve()
      : new Promise((res) => {
          img.addEventListener('load', res, { once: true });
          img.addEventListener('error', res, { once: true });
        });

    Promise.all(PARTS.map(loadShape).concat([loaded(tuna), loaded(word)])).then(() => {
      if (!PARTS.every(part => part.shape)) { skipIntro(); return; }
      ready = true;
      syncLayout();
      updateRunState();
    }, skipIntro);
    // if the logo data is slow to arrive, show the plain logo rather than nothing
    setTimeout(() => { if (!ready) skipIntro(); }, 5000);

    /* ── Intro ─────────────────────────────────────────────── */
    /* Wait for the ripple's outer ring to finish spreading, note the circle it
       ended at, then send the fish in from it. */
    const ring = cfg.intro ? document.querySelector('#hero-ripple .pulse-ring.r1') : null;
    let ringDone = !ring, ringFallback = 0;
    if (ring) {
      ring.addEventListener('animationend', (e) => {
        if (e.animationName !== 'heroRing' || ringDone) return;
        ringDone = true;
        readRing();
        maybeStartIntro();
      });
    }
    function readRing() {
      if (!ring) return;
      const r = ring.getBoundingClientRect(), br = box.getBoundingClientRect();
      const s = cssW ? br.width / cssW : 1;
      if (!(r.width > 200)) return;          // not spread out: use the default circle
      ringX = (r.left + r.width / 2 - br.left) / s;
      ringY = (r.top + r.height / 2 - br.top) / s;
      ringR = r.width / 2 / s;
      ringKnown = true;
    }
    function skipIntro() {
      if (state !== INTRO) return;
      stopLoop();
      state = IDLE;
      showSvg();
      scheduleVibrate();
    }
    function maybeStartIntro() {
      if (state !== INTRO || introPhase !== 'wait' || !canRun()) return;
      if (!ringDone) {
        // the ring normally ends 2.2 s into its pulse; if that event never comes, go anyway
        if (!ringFallback) ringFallback = setTimeout(() => { ringDone = true; readRing(); maybeStartIntro(); }, 3500);
        return;
      }
      clearTimeout(ringFallback);
      startIntro();
    }
    function startIntro() {
      if (!syncLayout()) { skipIntro(); return; }
      placeHome();
      if (!ringKnown) {                      // no ripple to measure: a circle around the hero's middle
        const br = box.getBoundingClientRect(), hr = root.getBoundingClientRect();
        const s = br.width / cssW || 1;
        ringX = (hr.left + hr.width / 2 - br.left) / s;
        ringY = (hr.top + hr.height / 2 - br.top) / s;
        ringR = Math.max(cssW, cssH) * 0.65;
      }
      // the wide intro canvas draws at no more than 1.25x pixel density: it is
      // big, the fish are small and fast, and full density comes back after
      placeCanvas(Math.min(built.dpr, 1.25), true);
      const lx = built.bx + built.bw / 2, ly = built.by + built.bh / 2;   // the logo's center
      for (let i = 0; i < N; i++) {
        // the point on the ring in the direction of this fish's home from the logo's center
        let a = Math.atan2(hy[i] - ly, hx[i] - lx);
        if (!(hx[i] !== lx || hy[i] !== ly)) a = Math.random() * TAU;
        a += (Math.random() - 0.5) * 0.12;
        const r = ringR + (Math.random() - 0.5) * 16;
        x[i] = ringX + Math.cos(a) * r;
        y[i] = ringY + Math.sin(a) * r;
        // face in toward home, which also starts its path heading that way
        const dx = hx[i] - x[i], dy = hy[i] - y[i], d = Math.sqrt(dx * dx + dy * dy) || 1;
        vx[i] = dx / d * CRUISE_SPEED; vy[i] = dy / d * CRUISE_SPEED;
        ang[i] = Math.atan2(dy, dx);
      }
      introPhase = 'swim';
      buildPaths(INTRO_DURATION / 1000, INTRO_STAGGER / 1000);
      showFish();
      startLoop();
    }
    /* Every frame of the intro: if the cursor is on an incoming fish (moving
       or not), the logo breaks like a normal break. */
    function checkIntroTouch() {
      if (ptr.kind !== 'mouse' || !ptr.inWindow) return;
      toCanvas(ptr.cx, ptr.cy);
      const px = CP[0], py = CP[1];
      if (touchesFish(px, py, 8) && rootUnder(ptr.cx, ptr.cy, false)) breakLogo(px, py);
    }
    /* Is any fish within r px of this point? */
    function touchesFish(px, py, r) {
      const r2 = r * r;
      for (let i = 0; i < N; i++) {
        const dx = x[i] - px, dy = y[i] - py;
        if (dx * dx + dy * dy < r2) return true;
      }
      return false;
    }
  } // end of fishLogo

  /* ── The two logos ─────────────────────────────────────── */
  const hero  = document.getElementById('hero');
  const frame = hero && hero.querySelector('.hero-frame');
  const heroLogo = frame && frame.querySelector('.hero-logo');
  fishLogo({
    root: hero, area: frame, logo: heroLogo,
    tuna: heroLogo && heroLogo.querySelector('.hero-logo-tuna'),
    word: heroLogo && heroLogo.querySelector('.hero-logo-word'),
    avoid: frame ? [frame.querySelector('.hero-title'), frame.querySelector('.hero-cta')] : [],
    intro: true,
    // the scroll fade in main.js takes the frame to opacity 0 once the next
    // section covers the sticky hero, which counts as off screen too
    shown: () => !(parseFloat(frame.style.opacity) < 0.03),
    canvasClass: 'hero-school', before: heroLogo,
  });

  const footer = document.querySelector('footer');
  const footLogo = footer && footer.querySelector('.footer-logo');
  fishLogo({
    root: footer, area: footer, logo: footLogo,
    tuna: footLogo && footLogo.querySelector('.footer-logo-tuna'),
    word: footLogo && footLogo.querySelector('.footer-logo-word'),
    avoid: footer ? [footer.querySelector('.footer-lockup'), footer.querySelector('.footer-links'), footer.querySelector('.footer-social')] : [],
    intro: false,
    canvasClass: 'footer-school', before: footer && footer.firstElementChild,
  });
})();
