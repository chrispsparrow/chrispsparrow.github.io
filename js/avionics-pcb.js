/* Avionics GPS and radio PCB page.
   1. Fades each slide's content in and out as it passes the middle of the window.
   2. Draws the 3D board with Three.js on a fixed canvas behind the slides. The board
      shows on the first and last slides only, and moves up and down with those
      slides, so the title and the links never slide over it.
   3. The first and last slides each stay pinned for one screen of scrolling. Over the
      first one the board turns a full 180 degrees about its horizontal axis, tipping
      backward (its top edge goes away from you), so it ends up showing its back. It
      comes back on the last slide still showing its back, and over that slide's
      pinned screen it keeps turning the same way for another 180 degrees, back to its
      front. On a computer you can also drag it.
   The model and its lighting come from js/board-look.js, shared with the home page
   card. Three.js comes from the jsDelivr CDN through the import map in the page. If
   the CDN or the model fails, the bare board photo takes the board's place. */
import { BOARD_MODEL, applyLookToThree } from './board-look.js';

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const TOUCH   = window.matchMedia('(hover: none)').matches;
const TILT    = 0.75;         /* radians the board leans back at the top of the page (pi/2 would face you square on) */
const YAW     = -0.3;         /* a small turn within its own plane, so the first view has some depth */
const FLIP    = -1;           /* the scroll turns it backward. +1 would tip it forward instead */
const FADE    = 0.4;          /* share of the window height a slide takes to fade in or out */
const BAND    = 0.22;         /* share of the window height trimmed off each end of a slide for its "fully on" band */
const DRIFT   = 24;           /* px a slide's content drifts while it fades */

const stage    = document.getElementById('board-stage');
const canvas   = document.getElementById('board-canvas');
const note     = stage.querySelector('.board-note');
const nav      = document.getElementById('nav');
const slides   = Array.from(document.querySelectorAll('.slide'));
const inners   = slides.map(s => s.querySelector('.slide-inner'));
const pinned   = slides.map(s => s.classList.contains('slide-pinned'));   /* two screens tall, content pinned for one */
const heroSlide  = document.querySelector('.slide-hero');
const heroInner  = heroSlide ? heroSlide.querySelector('.slide-inner') : null;   /* the pinned part, one screen tall */
const heroTitle  = heroSlide ? heroSlide.querySelector('h1') : null;
const closeSlide = document.querySelector('.slide-close');
const closeInner = closeSlide ? closeSlide.querySelector('.slide-inner') : null;
const closeLinks = closeSlide ? closeSlide.querySelector('.close-links') : null;
const footer     = document.querySelector('footer');

if (REDUCED) document.documentElement.classList.add('av-reduced');

const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
/* Distance from the top of the document, ignoring transforms (the fades move things) */
function docTop(el) { let y = 0; while (el) { y += el.offsetTop; el = el.offsetParent; } return y; }

/* ── How far a slide is from the middle of the window ───────
   0 while the middle of the window is inside the band, otherwise the distance
   to the band as a share of the window height. Negative means the band is
   still below the middle, positive means it has gone above. */
function bandOffset(top, bottom) {
  const vh = window.innerHeight || 1, mid = vh / 2;
  if (mid < top) return (mid - top) / vh;
  if (mid > bottom) return (mid - bottom) / vh;
  return 0;
}
function offset(rect, padTop, padBottom = padTop) {
  const vh = window.innerHeight || 1;
  const room = Math.max(0, (rect.height - 0.1 * vh) / 2);
  return bandOffset(rect.top + Math.min(padTop * vh, room), rect.bottom - Math.min(padBottom * vh, room));
}
/* A slide's content counts as on while the middle of the window is inside the
   slide's band. A slide taller than the window (phones) also counts as on while
   the middle is close to the content itself, so its text stays readable until it
   has nearly left the top of the screen. */
function slideOffset(slideRect, innerRect, last) {
  const vh = window.innerHeight || 1;
  /* The last slide has nothing after it but the footer, so it never fades upward */
  const dS = last ? bandOffset(slideRect.top + Math.min(BAND * vh, slideRect.height / 2), Infinity)
                  : offset(slideRect, BAND);
  if (slideRect.height <= vh * 1.05) return dS;
  const dC = bandOffset(innerRect.top - 0.1 * vh, innerRect.bottom + 0.1 * vh);
  return Math.abs(dC) < Math.abs(dS) ? dC : dS;
}
/* Fully on inside the band, then a quick fade, so neighbors overlap only a little */
const fade = (d) => Math.pow(1 - clamp(Math.abs(d) / FADE, 0, 1), 1.6);

/* ── Slide fades ────────────────────────────────────────── */
let slideFrame = false;
function updateSlides() {
  slideFrame = false;
  /* Measure everything first, then write, so the browser lays out once. The first
     and last slides are two screens tall but their content is pinned, so they fade
     by the pinned part, the way a one-screen slide would. */
  const ds = slides.map((s, i) => {
    const inner = inners[i].getBoundingClientRect();
    return slideOffset(pinned[i] ? inner : s.getBoundingClientRect(), inner, i === slides.length - 1);
  });
  for (let i = 0; i < slides.length; i++) {
    const op = fade(ds[i]);
    const el = inners[i];
    el.style.opacity = op.toFixed(3);
    if (op <= 0 || op >= 1) {
      /* Settled: no transform and no compositor layer for it */
      el.style.transform = '';
      el.style.willChange = '';
    } else {
      el.style.transform = `translate3d(0, ${(-clamp(ds[i] / FADE, -1, 1) * DRIFT).toFixed(1)}px, 0)`;
      el.style.willChange = 'opacity, transform';
    }
  }
}
function queueSlides() {
  if (!slideFrame) { slideFrame = true; requestAnimationFrame(updateSlides); }
}
if (REDUCED) {
  /* Plain fades on a class, no movement. Everything shows if the observer is missing. */
  if ('IntersectionObserver' in window) {
    /* On while any part of the content is inside the middle 70% of the window.
       A threshold of 0 (not a share) keeps content taller than the window visible too. */
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(en => en.target.classList.toggle('in', en.isIntersecting));
    }, { threshold: 0, rootMargin: '-15% 0px -15% 0px' });
    inners.forEach(el => obs.observe(el));
  } else {
    inners.forEach(el => el.classList.add('in'));
  }
} else {
  window.addEventListener('scroll', queueSlides, { passive: true });
  window.addEventListener('resize', queueSlides);
  updateSlides();
}

/* ── The space the board gets on the first and last slides ──
   From just under the nav to a gap above the hero title (or the close links, if a
   window ever puts them higher), measured from the page itself, so a title that
   wraps or a font that loads late still never touches it. */
let pivot = null;            /* where the 3D board's middle sits on screen, once it is fitted */
function measureBand() {
  const navBottom = nav ? nav.offsetHeight : 72;
  const top = navBottom + 12;
  const winH = window.innerHeight || 1;
  /* Where the title and the links sit in their pinned parts, which are at the top of
     the window whenever the board is showing on their slide */
  const titleTop = heroTitle ? docTop(heroTitle) - docTop(heroInner || heroSlide) : winH * 0.75;
  const linksTop = closeLinks ? docTop(closeLinks) - docTop(closeInner || closeSlide) : Infinity;
  const gap = clamp(0.07 * winH, 36, 80);           /* the space between the board and the text under it */
  const bottom = Math.max(top + 40, Math.min(titleTop, linksTop) - gap);
  const band = { top, bottom, mid: (top + bottom) / 2, height: bottom - top };
  stage.style.setProperty('--band-top', `${top}px`);
  stage.style.setProperty('--band-bottom', `${Math.max(0, winH - bottom)}px`);
  stage.style.setProperty('--band-mid', `${pivot === null ? band.mid : pivot}px`);
  return band;
}

/* ── Where the board should be, from the scroll position ─── */
/* How far through its pinned screen a pinned slide is: 0 until the slide's top
   reaches the top of the window, 1 once that screen of scrolling is used up. 0 if
   the slide is not pinned at all. */
function pinProgress(slide, inner) {
  const run = slide && inner ? slide.offsetHeight - inner.offsetHeight : 0;
  return run > 1 ? clamp(-slide.getBoundingClientRect().top / run, 0, 1) : 0;
}
function boardState() {
  const vh = window.innerHeight || 1;
  /* The pinned parts of the first and last slides: at the top of the window while
     they are pinned, then moving up as their slide scrolls away */
  const hero = heroInner ? heroInner.getBoundingClientRect() : null;
  const close = closeInner ? closeInner.getBoundingClientRect() : null;
  /* On the last slide the board comes back a little late, once the photos above
     have mostly gone, and is fully gone by the time the footer has risen a quarter
     of the way up the window, so it never sits behind the links. */
  const footerIn = footer ? clamp((vh - footer.getBoundingClientRect().top) / (0.25 * vh), 0, 1) : 0;
  const heroVis = hero ? fade(offset(hero, BAND)) : 0;
  const closeVis = close ? fade(bandOffset(close.top + 0.35 * vh, Infinity)) * (1 - footerIn) : 0;
  /* The board rides along with whichever of the two slides it belongs to */
  const shift = heroVis >= closeVis ? (hero ? Math.min(0, hero.top) : 0) : (close ? close.top : 0);
  /* The turn, counted in half turns. It goes from 0 to 1 across the first slide's
     pinned screen, so the board ends up showing its back, stays at 1 through the
     middle slides, then goes from 1 to 2 across the last slide's pinned screen, back
     to its front. With reduced motion nothing is pinned and the board always shows
     its front. */
  const halfTurns = REDUCED ? 0 : pinProgress(heroSlide, heroInner) + pinProgress(closeSlide, closeInner);
  const opacity = Math.max(heroVis, closeVis);
  const side = opacity <= 0.005 ? 'none' : (heroVis >= closeVis ? 'hero' : 'close');
  return { opacity, shift, halfTurns, side };
}

function applyStage(st) {
  stage.style.opacity = st.opacity.toFixed(3);
  const s = REDUCED ? 1 : 0.6 + 0.4 * st.opacity;   /* shrinks toward its own middle as it fades */
  stage.style.transform = `translate3d(0, ${st.shift.toFixed(1)}px, 0) scale(${s.toFixed(3)})`;
  /* Only take the mouse while the board is really there, so it never blocks the slides */
  stage.style.pointerEvents = (st.opacity > 0.5 && !TOUCH && stage.classList.contains('loaded')) ? 'auto' : 'none';
}

/* The stage (and its loading line) follows the scroll from the start, before the
   model has arrived. Once the board is running its own scroll handler takes over. */
let stageFrame = false;
function queueStage() {
  if (stageFrame) return;
  stageFrame = true;
  requestAnimationFrame(() => { stageFrame = false; applyStage(boardState()); });
}
measureBand();
applyStage(boardState());
window.addEventListener('scroll', queueStage, { passive: true });
window.addEventListener('resize', () => { measureBand(); queueStage(); });
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { measureBand(); queueStage(); });

/* The photo does not turn, so the first and last slides stop pinning, the same as
   with reduced motion. If the page has already scrolled, the same content stays in
   view. Browsers with scroll anchoring have already kept it there by the time it is
   measured again, so the correction is then zero. */
function unpin() {
  const anchor = slides.find(s => s.getBoundingClientRect().bottom > 0);
  const before = anchor ? anchor.getBoundingClientRect().top : 0;
  document.documentElement.classList.add('av-static');
  if (anchor && window.scrollY > 0) {
    const moved = anchor.getBoundingClientRect().top - before;
    if (Math.abs(moved) > 1) window.scrollBy(0, moved);
  }
}

function showFallback() {
  const img = stage.querySelector('.board-fallback img');
  if (img && !img.getAttribute('src')) img.setAttribute('src', img.dataset.src);
  const sr = document.querySelector('.hero-sr');
  if (sr) sr.textContent = 'A photo of the bare board sits above this title.';
  unpin();
  stage.classList.add('fallback');
  stage.classList.remove('draggable');
  note.classList.add('hidden');
  measureBand();
  applyStage(boardState());
}

/* ── The 3D board ───────────────────────────────────────── */
async function initBoard() {
  let THREE, GLTFLoader, MeshoptDecoder;
  try {
    [THREE, { GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
      import('three'),
      import('three/addons/loaders/GLTFLoader.js'),
      import('three/addons/libs/meshopt_decoder.module.js'),
    ]);
  } catch (err) {
    console.warn('Three.js did not load, showing the photo instead.', err);
    showFallback();
    return;
  }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (err) {
    console.warn('WebGL is not available, showing the photo instead.', err);
    showFallback();
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  /* Skip the shader log check, the way model-viewer does on the home page. It costs
     time on every shader build, and on Windows the graphics driver fills the log with
     harmless notes that would otherwise show up as console warnings. */
  renderer.debug.checkShaderErrors = false;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(28, 1, 0.01, 50);
  scene.add(camera);
  /* The same studio light, tone mapping and exposure as the home page card. It is
     image-based light from all around, so the back of the board is lit just like
     the front when it comes around. model-viewer keeps its board flat under the
     room's top light and moves the camera around it. Here the board itself leans
     toward the camera by TILT, so the room is leaned with it, and the board gets the
     same light (and the same blue) as on the home page. */
  applyLookToThree(THREE, renderer, scene);
  scene.environmentRotation.set(TILT, 0, 0);

  /* turn:  left and right drag, about the screen's up and down axis (outermost)
     flip:  the scroll flip plus up and down drag, about the screen's horizontal axis
     base:  the board's own turn within its plane                                  */
  const turn = new THREE.Group();
  const flip = new THREE.Group();
  const base = new THREE.Group();
  turn.add(flip); flip.add(base); scene.add(turn);

  /* Load the model */
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  let model;
  try {
    const gltf = await new Promise((resolve, reject) => loader.load(BOARD_MODEL, resolve, undefined, reject));
    model = gltf.scene;
  } catch (err) {
    console.warn('The board model did not load, showing the photo instead.', err);
    showFallback();
    return;
  }
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = 1 / Math.max(size.x, size.y, size.z);
  model.position.copy(center).multiplyScalar(-scale);
  model.scale.setScalar(scale);
  base.add(model);
  base.rotation.y = YAW;

  /* The shape the fit works from, measured over every vertex once, in the frame the
     turn works in (after the board's own small turn, YAW). The scroll turns the board
     about the screen's horizontal (x) axis, all the way round, and on a computer the
     drag can also turn it about the up and down axis. The model is first centered
     along x, so the board sits in the middle of the screen (a shift along the turning
     axis does not change the turn). For each vertex only two numbers matter:
       ax     how far it sits along the turning axis
       rho    how far it sits from that axis (the radius of the circle it sweeps)
     Every bound below grows with both, so only the vertices that no other vertex
     beats on both counts are kept (usually a few dozen). */
  const shape = (() => {
    scene.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const all = [];
    model.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
      const pos = o.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        all.push(v.x, v.y, v.z);
      }
    });
    let xmin = Infinity, xmax = -Infinity;
    for (let i = 0; i < all.length; i += 3) { xmin = Math.min(xmin, all[i]); xmax = Math.max(xmax, all[i]); }
    const cx = (xmin + xmax) / 2;
    base.position.x = -cx;
    const pairs = [];
    let R2 = 0;
    for (let i = 0; i < all.length; i += 3) {
      const x = all[i] - cx, y = all[i + 1], z = all[i + 2];
      R2 = Math.max(R2, x * x + y * y + z * z);
      pairs.push([Math.abs(x), Math.hypot(y, z)]);
    }
    pairs.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
    const front = [];
    let best = -Infinity;
    for (const p of pairs) if (p[1] > best) { front.push(p); best = p[1]; }
    return { R: Math.sqrt(R2), front };
  })();

  /* Fit the board inside the band between the nav and the title. The bound holds for
     every angle of the turn and every drag, so the board never touches the title, at
     any window size, while it turns over or while you drag it. A vertex sweeps a circle
     of radius rho as the board turns, so on screen it can reach rho / sqrt(d^2 - rho^2)
     (in focal lengths) above or below the middle, at distance d. On a computer the free
     left and right drag can also swing it nearer, as near as sqrt(ax^2 + z^2), which
     is checked along the circle. The camera's view is shifted so the band's middle (or
     a little lower, when there is room to spare) is the picture's middle. */
  function fitCamera() {
    const w = canvas.clientWidth || window.innerWidth || 1, h = canvas.clientHeight || window.innerHeight || 1;
    renderer.setSize(w, h, false);
    const band = measureBand();
    camera.aspect = w / h;
    const f = (h / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);   /* focal length in px */
    const halfW = w / 2 - Math.max(16, 0.04 * w);
    const F = shape.front;
    const K = 24;                                 /* points checked along each circle (computer) */

    /* Height above (or below) the middle the board can reach on screen at distance d */
    const reachUp = (d) => {
      let up = 0;
      for (const [ax, rho] of F) {
        if (TOUCH) {
          up = Math.max(up, f * rho / Math.sqrt(d * d - rho * rho));
        } else {
          for (let k = 0; k <= K; k++) {
            const zp = rho * k / K, yp = Math.sqrt(Math.max(0, rho * rho - zp * zp));
            up = Math.max(up, f * yp / (d - Math.hypot(ax, zp)));
          }
        }
      }
      return up;
    };
    /* Distance needed so the board also fits the width */
    let dSide = 0;
    for (const [ax, rho] of F) {
      dSide = Math.max(dSide, TOUCH ? rho + f * ax / halfW                          /* nearest it gets: rho */
                                    : Math.hypot(ax, rho) * Math.sqrt(1 + (f / halfW) ** 2));   /* free turn: a cylinder */
    }
    let lo = Math.max(shape.R * 1.05, dSide), hi = shape.R * 400;
    for (let it = 0; it < 40; it++) {
      const d = (lo + hi) / 2;
      if (2 * reachUp(d) <= band.height) hi = d; else lo = d;
    }
    const d = hi * 1.02;                          /* a little extra for the steps along the circles */
    const up = reachUp(d);
    /* When there is room to spare (phones, where the width sets the size), more of it
       goes above the board, so the board stays with its title instead of floating up */
    const spare = Math.max(0, band.height - 2 * up);
    const pivotY = band.top + spare * 0.65 + up;
    camera.position.set(0, 0, d);
    camera.lookAt(0, 0, 0);
    camera.near = Math.max(0.001, d - 2 * shape.R);
    camera.far = d + 2 * shape.R;
    camera.setViewOffset(w, h, 0, h / 2 - pivotY, w, h);
    camera.updateProjectionMatrix();
    pivot = pivotY;                                          /* the board shrinks toward this point as it fades */
    stage.style.setProperty('--band-mid', `${pivotY}px`);
  }
  fitCamera();

  /* Rotation: the scroll sets the flip, dragging adds to it */
  let flipA = 0, flipTarget = 0;
  let dragYaw = 0, dragYawTarget = 0, dragPitch = 0, dragPitchTarget = 0;
  let needsRender = true, running = false;
  const EASE = REDUCED ? 1 : 0.1;

  /* Draw loop: eases toward the targets and draws only while something changes
     and the board is visible, then goes to sleep until the next kick. */
  function frame() {
    const visible = parseFloat(stage.style.opacity || '0') > 0.005;
    const d1 = flipTarget - flipA, d2 = dragYawTarget - dragYaw, d3 = dragPitchTarget - dragPitch;
    const moving = Math.abs(d1) > 0.0005 || Math.abs(d2) > 0.0005 || Math.abs(d3) > 0.0005;
    if (!visible || (!moving && !needsRender)) { running = false; return; }
    flipA += d1 * EASE; dragYaw += d2 * EASE; dragPitch += d3 * EASE;
    if (!moving) { flipA = flipTarget; dragYaw = dragYawTarget; dragPitch = dragPitchTarget; }
    turn.rotation.y = dragYaw;
    flip.rotation.x = TILT + FLIP * flipA + dragPitch;
    renderer.render(scene, camera);
    needsRender = false;
    requestAnimationFrame(frame);
  }
  function kick() {
    needsRender = true;
    if (!running) { running = true; requestAnimationFrame(frame); }
  }

  let lastSide = 'none';
  function syncScroll() {
    const st = boardState();
    /* 180 degrees across each pinned screen, always the same way round, so by the end
       of the page it has made one full turn and sits the way it started */
    flipTarget = st.halfTurns * Math.PI;
    /* Hidden, or a jump straight between the first and last slide (Home and End keys):
       catch up with the scroll at once and let go of any drag, so the last slide starts
       on the back the way it is meant to and the board never whirls around */
    if (st.side === 'none' || (lastSide !== 'none' && st.side !== lastSide)) {
      flipA = flipTarget;
      dragYaw = dragYawTarget = 0;
      dragPitch = dragPitchTarget = 0;
    }
    lastSide = st.side;
    applyStage(st);
    kick();
  }
  window.addEventListener('scroll', syncScroll, { passive: true });
  /* Refit at most once a frame while the window is being resized */
  let fitQueued = false;
  const queueFit = () => {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => { fitQueued = false; fitCamera(); syncScroll(); });
  };
  window.addEventListener('resize', queueFit);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(queueFit);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });

  if (!TOUCH) {
    stage.classList.add('draggable');
    let dragging = false, lastX = 0, lastY = 0;
    /* The left-button mouse-down default would start a text selection across the page */
    canvas.addEventListener('mousedown', (e) => { if (e.button === 0) e.preventDefault(); });
    canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.button !== 0) return;
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      stage.classList.add('dragging');
      canvas.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dragYawTarget += (e.clientX - lastX) * 0.009;
      /* The board follows the mouse: dragging down pulls its near face down. The fit
         covers every angle, so the drag can turn it as far as you like. */
      dragPitchTarget += (e.clientY - lastY) * 0.009;
      lastX = e.clientX; lastY = e.clientY;
      kick();
    });
    const stop = () => { dragging = false; stage.classList.remove('dragging'); };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('lostpointercapture', stop);
  }

  /* First draw, then let the canvas fade in over the loading line */
  stage.classList.add('loaded');
  note.classList.add('hidden');
  syncScroll();
}

initBoard();
