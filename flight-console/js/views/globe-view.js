// globe-view.js
// The 3D view: the same flight as the map, drawn on Cesium's globe with
// real terrain and aerial imagery. It shows a board marker for every
// rocket with pulse rings while its GPS fix is good, a thin orange trail
// that fades out behind the marker like a comet's tail, the start point
// (the launch point in a replay), the ground station's dish, and a marker in the sky
// at the focused rocket's apogee, drogue, main and landing, and at any
// event its board reported. Nothing in the view is text: the readings
// panel says what the old labels said.
//
// The same honesty rules as the map apply:
//   - Only good GPS positions are drawn. A gap in them is left as a break
//     in the trail, never bridged.
//   - The marker moves from one real data point to the next. Nothing is
//     smoothed or filled in between packets.
//   - The board marker always stands upright. No board sends orientation
//     data, so it never turns.
//   - With no GPS fix the marker turns hollow at the last good position
//     and its rings stop.
//   - Event markers only appear once playback has reached the event.
//
// Heights. Cesium places things by height above the ellipsoid (a smooth
// model of the Earth), and GPS reports height above mean sea level. The two
// differ by tens of meters, and this file never converts between them.
// Instead it asks Cesium World Terrain for the ground height at the launch
// pad, and draws every point at that height plus the detector's height
// above ground for the point. So the pad sits on the terrain and the trail
// rises from it by exactly the heights the readings panel shows. If a
// pad's ground height can't be looked up, or the rocket has no pad, each
// point goes at its GPS altitude instead. If Cesium World Terrain doesn't
// load, the ground is flat and heights above ground are measured from it.
// Either way a note says the heights are approximate. A rocket isn't drawn
// until its launch pad and the ground height there are known, or liftoff
// has come with no pad.
//
// No ground station. A store made with no ground station (a board on the
// bench) has no dish and no line to it, so neither is drawn. Until there
// is a position to look at, the camera then waits far out, looking down at
// the whole Earth, instead of over a ground station.
//
// Camera. Cesium's own mouse and touch controls are made for spinning a
// whole globe, and up close they turn far too fast. They are switched off,
// and this file has its own: drag to orbit around what the camera looks
// at, the wheel or a pinch to zoom, and the right button or two fingers to
// slide the view (see "Controls" near the end).
//
// Look. The view sits on the page with no frame: the space around the
// Earth is the page's navy, there are no stars, sun or moon, and the glow of
// the atmosphere is darkened and tinted toward the navy. Close to the
// ground the glow is off, so the sky is the page's navy too and the horizon
// meets the page. The globe fades into the page instead of sitting in a
// box. The markers come from markers.js: the board in its own blue with an
// off-white outline, an off-white start dot and an off-white dish. Orange
// is kept for the focused rocket's trail, its rings and the event markers.
//
// Rendering. The scene only redraws when something changes (Cesium's
// requestRenderMode), which saves battery. Every change here ends with
// scene.requestRender(). The one exception is the pulse rings, which ask
// for a frame at most RING_PULSE_FPS times a second while they show (see
// "Pulse rings").
//
// Starting far out. With no ground station the camera first waits looking
// at the whole Earth. When the first position comes in, it flies down to it
// (or jumps there, for visitors who ask for less motion).
//
// Used by: map-view.js, which loads Cesium first and owns the buttons.
// Reads the store, never other views.

import { createScheduler, prefersReducedMotion, eventMarkerKind } from './dom.js';
import { distanceM } from '../geo.js';
import {
  boardSvg, BOARD_FOCUSED, BOARD_OTHER, startSvg, START_SIZE, dishSvg, DISH_SIZE, DISH_ANCHOR,
  TRAIL_WINDOW_S, TRAIL_WIDTH_PX, TRAIL_OTHER_WIDTH_PX, RING_PULSE_MS, RING_PULSE_FPS,
} from './markers.js';
import { FLIGHT_WORDS } from './hud-text.js?v=3';

// The trail is this opaque right behind the marker. Toward its far end
// (TRAIL_WINDOW_S in markers.js) it fades to nothing, along this power of
// the share of the window left, so the tail thins out quickly.
const TRAIL_ALPHA = 0.95;
const TRAIL_FADE_POWER = 1.6;
// Event marker size (px).
const EVENT_MARK_PX = 14;
// Pulse ring sizes (px) around a board with a good fix, as on the map.
const RING_FOCUSED_PX = 76;
const RING_PX = 46;
// Each pulse starts at this share of the ring's full size.
const RING_FROM_SCALE = 0.3;
// The three still rings for viewers who ask for less motion, as on the
// map: [share of full size, opacity].
const RING_STILL = [[0.5, 0.95], [0.76, 0.6], [1, 0.3]];
// The events that get a marker in the sky, besides any event the board
// reported itself. Liftoff has none, since the start point marks it.
const EVENT_TYPES = new Set(['apogee', 'drogue', 'main', 'landed']);
// A ground station whose GPS position wanders keeps the ground height it
// had while it stays within this far (m) of where that height was looked
// up. A real move (from the demo position to its own) waits for its own.
const STATION_KEEP_M = 100;
// With no ground station, the camera waits here before the first position:
// looking straight down from this far (m) above this spot, which shows the
// whole Earth.
const WAIT_FAR_LAT = 25;
const WAIT_FAR_LON = -40;
const WAIT_FAR_RANGE_M = 20000000;
// How long (s) the camera takes to fly down from there to the first
// position.
const FLY_IN_S = 2.6;
// The atmosphere's glow around the Earth, seen from far away, pulled
// toward the page's navy: the same blue with much less light, so the rim
// stays a thin dark blue. Each is a shift from -1 to 1. Below
// SKY_GLOW_MIN_M (m above the ground) the glow is off, so the sky over the
// ground is the page's own navy and the horizon meets the page.
const SKY_SATURATION_SHIFT = 0.05;
const SKY_BRIGHTNESS_SHIFT = -0.66;
const SKY_HUE_SHIFT = 0;
const SKY_GLOW_MIN_M = 100000;
// The haze over the ground far away, darker and greyer, so distant ground
// fades toward the navy.
const GROUND_HAZE_SATURATION_SHIFT = -0.2;
const GROUND_HAZE_BRIGHTNESS_SHIFT = -0.5;
// Close to the ground, the ground fades into the page's navy toward the
// horizon. On screen the fade starts this share of the view's height below
// the horizon, and the ground is solid navy from the second share on.
const HORIZON_FADE_FROM = 0.11;
const HORIZON_FADE_TO = 0.006;
// Far ground usually sits higher than sea level, so it shows closer to the
// horizon than that works out. The fade never starts or ends farther away
// than these shares of the distance to the horizon.
const HORIZON_FADE_FROM_MAX = 0.1;
const HORIZON_FADE_TO_MAX = 0.38;

export function createGlobeView(container, ctx, options) {
  const { Cesium: C, credits, dialogs, covers, onReady, onChange, onFail, onFollowOff } = options;
  const { store, config } = ctx;
  // What to call the thing being tracked (a rocket, or a board on a desk).
  const words = ctx.words ?? FLIGHT_WORDS;
  const prescan = ctx.prescan instanceof Map ? ctx.prescan : new Map();

  // ------------------------------------------------------------------
  // Colors from the Flight Console theme (css/flight-console-theme.css):
  // the page's navy around the Earth. Each color is worked out by the
  // browser (a theme shade can be a color-mix()) and handed to Cesium as
  // plain rgba(). The markers' own colors are in markers.js, and the
  // lines' and rings' in config.js and markers.js.
  // ------------------------------------------------------------------
  const rgba = (css, alpha = 1) => C.Color.fromCssColorString(css).withAlpha(alpha);
  const color = (name, fallback) => cssColor(container, name, fallback);
  const PAGE = color('--fc-black', '#07060D');             // the space around the Earth

  // ------------------------------------------------------------------
  // The viewer. Every built-in widget is off. Cesium's logo and data
  // credits stay (they are required) and go in the box map-view.js made.
  // ------------------------------------------------------------------
  C.Ion.defaultAccessToken = config.CESIUM_ION_TOKEN;
  const view = { imageryFailed: false, terrain: 'loading' }; // terrain: 'loading', 'ok' or 'failed'
  let destroyed = false;
  let active = true;

  // Cesium ion's default aerial imagery. If ion turns the token down, the
  // layer is taken off so the ground still draws, in a plain color.
  const imagery = C.ImageryLayer.fromWorldImagery();
  imagery.errorEvent.addEventListener((err) => {
    if (destroyed) return;
    console.warn('Flight Console: the 3D imagery did not load', err);
    view.imageryFailed = true;
    viewer?.imageryLayers.remove(imagery);
    viewer?.scene.requestRender();
    onChange();
  });
  imagery.readyEvent.addEventListener(() => {
    if (!destroyed) viewer?.scene.requestRender();
  });

  // Cesium adds its credit styles to the page's <head>. They are noted
  // here so destroy() can take them out again.
  const headBefore = new Set(document.head.children);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, config.GLOBE_MAX_PIXEL_RATIO);
  let viewer = null;
  try {
    viewer = new C.Viewer(container, {
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      vrButton: false,
      projectionPicker: false,
      infoBox: false,
      selectionIndicator: false,
      scene3DOnly: true,
      skyBox: false,
      baseLayer: imagery,
      creditContainer: credits,
      // Cesium's "Data attribution" dialog opens in this box, which
      // map-view.js stacks above the panels floating over the view.
      creditViewport: dialogs,
      // Redraw only when something changes, never just because time passed.
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      // A render error is reported to map-view.js, which shows its own message.
      showRenderLoopErrors: false,
      // Smoothing the edges costs the most on sharp phone screens, where
      // it shows the least.
      msaaSamples: pixelRatio > 1 ? 1 : 4,
      // A click in the view keeps keyboard focus on it, for the arrow keys.
      blurActiveElementOnCanvasFocus: false,
    });
  } catch (err) {
    // Usually WebGL isn't available. Leave nothing half-built behind.
    destroyed = true;
    container.replaceChildren();
    credits.replaceChildren();
    throw err;
  }
  const headAdded = [...document.head.children].filter((el) => !headBefore.has(el) && el.tagName === 'STYLE');

  const scene = viewer.scene;
  const camera = viewer.camera;
  const controller = scene.screenSpaceCameraController;
  // Sharp on high-resolution screens, up to GLOBE_MAX_PIXEL_RATIO.
  viewer.useBrowserRecommendedResolution = false;
  viewer.resolutionScale = pixelRatio / (window.devicePixelRatio || 1);
  // Terrain hides what is behind or under it, the trails and the ground
  // station line included. Markers are never hidden (see ALWAYS).
  scene.globe.depthTestAgainstTerrain = true;
  // The ground's color where there is no imagery: the theme's raised navy.
  scene.globe.baseColor = rgba(color('--fc-black-raised', '#1E1D24'));
  // The page's navy all around the Earth, with no stars, sun or moon.
  scene.backgroundColor = rgba(PAGE);
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  // The atmosphere's glow (the ring around the Earth from far away),
  // darkened and tinted toward the navy. Close to the ground it is off, so
  // the sky is the page's navy and the view has no edge against the page.
  const sky = scene.skyAtmosphere;
  if (sky) {
    sky.hueShift = SKY_HUE_SHIFT;
    sky.saturationShift = SKY_SATURATION_SHIFT;
    sky.brightnessShift = SKY_BRIGHTNESS_SHIFT;
  }
  // Close to the ground the sky is the page's navy, so the far edge of the
  // ground would end in a hard, straight line. Instead the ground fades to
  // the navy with distance, so it melts into the page at the horizon, far
  // mountains included. The distances are worked out before every frame
  // from where they show on screen (HORIZON_FADE_FROM and _TO). It is a
  // material on the ground only, so the markers and the trails stay as
  // they are. Far out, with the glow on, there is no fade.
  const horizonFade = new C.Material({
    fabric: {
      type: 'FcHorizonFade',
      uniforms: { fadeColor: rgba(PAGE), fadeFrom: 1e9, fadeTo: 2e9 },
      source: `czm_material czm_getMaterial(czm_materialInput materialInput) {
        czm_material material = czm_getDefaultMaterial(materialInput);
        material.diffuse = fadeColor.rgb;
        material.alpha = smoothstep(fadeFrom, fadeTo, length(materialInput.positionToEyeEC));
        return material;
      }`,
    },
  });
  // Cesium's own haze and fog would lighten the far ground again after the
  // fade, so close to the ground they are off. (The fog's density stays,
  // so it still skips drawing ground hidden in it.)
  const fog = scene.fog;
  const fogLook = fog?.visualDensityScalar;
  function updateHorizonFade(high) {
    const globe = scene.globe;
    if (fog && Number.isFinite(fogLook)) {
      const look = high ? fogLook : 0;
      if (fog.visualDensityScalar !== look) fog.visualDensityScalar = look;
    }
    if (high) {
      if (globe.material) globe.material = undefined;
      return;
    }
    if (globe.material !== horizonFade) globe.material = horizonFade;
    const viewH = scene.canvas.clientHeight;
    const fovy = camera.frustum.fovy;
    if (!(viewH > 0) || !(fovy > 0)) return;
    // Sea-level ground at distance d (m) shows h/d + d/2R radians below
    // level, and the horizon sqrt(2h/R) below level, for a camera h m up.
    // So the ground a radians below the horizon is at the nearer root of
    // d² - 2Rk·d + 2Rh = 0, with k = sqrt(2h/R) + a. (fovy is the view's
    // height in radians.)
    const R = globe.ellipsoid.maximumRadius;
    const h = Math.max(1, camera.positionCartographic.height);
    const pxPerRadian = (viewH / 2) / Math.tan(fovy / 2);
    const distanceAt = (px) => {
      const k = Math.sqrt(2 * h / R) + px / pxPerRadian;
      return R * k - Math.sqrt(Math.max(0, (R * k) ** 2 - 2 * R * h));
    };
    const horizon = Math.sqrt(2 * R * h + h * h);
    horizonFade.uniforms.fadeFrom = Math.min(distanceAt(viewH * HORIZON_FADE_FROM), horizon * HORIZON_FADE_FROM_MAX);
    horizonFade.uniforms.fadeTo = Math.min(distanceAt(viewH * HORIZON_FADE_TO), horizon * HORIZON_FADE_TO_MAX);
  }
  const stopSkySwitch = scene.preRender.addEventListener(() => {
    const high = camera.positionCartographic.height > SKY_GLOW_MIN_M;
    if (sky && sky.show !== high) sky.show = high;
    updateHorizonFade(high);
  });
  // The same for the haze over the ground far away.
  const haze = scene.atmosphere;
  if (haze) {
    haze.saturationShift = GROUND_HAZE_SATURATION_SHIFT;
    haze.brightnessShift = GROUND_HAZE_BRIGHTNESS_SHIFT;
  }
  // Cesium's own camera controls are off (see "Controls" near the end for
  // the ones used instead). Its check that keeps the camera above the
  // terrain is off too. It would move the camera behind this file's back,
  // and keepAboveGround() does that job here.
  controller.enableInputs = false;
  controller.enableCollisionDetection = false;
  // Nothing in this view can be clicked or picked.
  viewer.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_CLICK);
  viewer.screenSpaceEventHandler.removeInputAction(C.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
  scene.renderError.addEventListener((_scene, err) => {
    if (!destroyed) onFail(err);
  });
  // The browser can take the WebGL context away (a phone left in the
  // background, a graphics driver restart). Cesium has no way back from
  // that and raises no error, so the view is reported as stopped. The next
  // click on "3D" starts a fresh one.
  const onContextLost = () => {
    if (!destroyed) onFail(new Error('The WebGL context was lost'));
  };
  scene.canvas.addEventListener('webglcontextlost', onContextLost);

  // ------------------------------------------------------------------
  // What is drawn. Lines first, then markers. Within the markers, whatever
  // was added last is drawn on top.
  // ------------------------------------------------------------------
  const trails = scene.primitives.add(new C.PolylineCollection());     // the fading trails
  const blend = { blendOption: C.BlendOption.TRANSLUCENT };
  // The pulse rings fade out as they grow, so most of their pixels are see
  // through. A TRANSLUCENT collection draws in Cesium's opaque pass and
  // writes depth for every pixel it draws, faint ones included, and every
  // marker sits on the near plane (see ALWAYS). The trail draws later, in
  // the translucent pass, so it would vanish under each ring and leave
  // holes right behind the board. With OPAQUE_AND_TRANSLUCENT only the
  // solid ring pixels write depth (and they cover the trail anyway). The
  // faint ones blend with the trail and leave it whole.
  const ringBlend = { blendOption: C.BlendOption.OPAQUE_AND_TRANSLUCENT };
  const groundIcons = scene.primitives.add(new C.BillboardCollection(blend)); // start points and the ground station
  const eventIcons = scene.primitives.add(new C.BillboardCollection(blend));
  const ringIcons = scene.primitives.add(new C.BillboardCollection(ringBlend)); // the pulse rings, under the boards
  const rocketIcons = scene.primitives.add(new C.BillboardCollection(blend));
  const focusIcons = scene.primitives.add(new C.BillboardCollection(blend));  // the focused board, on top

  // Markers keep one size on screen at any distance, always stand upright
  // (a billboard faces the screen and never turns), and are never hidden
  // behind terrain.
  const ALWAYS = { disableDepthTestDistance: Number.POSITIVE_INFINITY };

  // In requestRenderMode a new icon image only shows a frame or two after
  // it was asked for, so a few extra frames are requested then.
  let pumpLeft = 0;
  function pump(frames = 3) {
    const running = pumpLeft > 0;
    pumpLeft = Math.max(pumpLeft, frames);
    if (running) return;
    const step = () => {
      if (destroyed) return;
      scene.requestRender();
      pumpLeft -= 1;
      if (pumpLeft > 0) window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  }

  // ------------------------------------------------------------------
  // Icons. The SVG markers (markers.js) are turned into small canvases
  // once, since Cesium draws images, not SVG. Each canvas is drawn at the
  // screen's pixel ratio so it stays sharp, with the spot that sits on the
  // position (the anchor) in its middle.
  // ------------------------------------------------------------------
  const iconScale = Math.ceil(pixelRatio);
  const icons = new Map(); // image id -> { canvas, width, height }

  // Draws SVG markup into a canvas of width by height px, with the
  // drawing's top left corner at (x, y).
  async function svgIcon(id, markup, [iconW, iconH], { width = iconW, height = iconH, x = 0, y = 0 } = {}) {
    // A standalone SVG image needs its namespace, and its size in screen pixels.
    const svgText = markup
      .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
      .replace(/width="[\d.]+" height="[\d.]+"/, `width="${iconW * iconScale}" height="${iconH * iconScale}"`);
    // (The load event is used, not image.decode(), which some browsers
    // refuse for SVG images.)
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error(`The ${id} icon could not be drawn`));
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width * iconScale;
    canvas.height = height * iconScale;
    const g = canvas.getContext('2d');
    g.scale(iconScale, iconScale);
    g.drawImage(image, x, y, iconW, iconH);
    icons.set(id, { canvas, width, height });
  }

  // An icon whose anchor isn't its middle gets empty room on one side, so
  // the anchor ends up in the middle of the canvas.
  function anchoredIcon(id, markup, size, anchor) {
    const width = 2 * Math.max(anchor[0], size[0] - anchor[0]);
    const height = 2 * Math.max(anchor[1], size[1] - anchor[1]);
    return svgIcon(id, markup, size, { width, height, x: width / 2 - anchor[0], y: height / 2 - anchor[1] });
  }

  // One pulse ring at its full size: an orange circle with a faint dark
  // edge on each side, like the map's rings. Each ring on screen is a
  // copy that grows and fades (see "Pulse rings").
  function ringIcon(id, size) {
    const canvas = document.createElement('canvas');
    canvas.width = size * iconScale;
    canvas.height = size * iconScale;
    const g = canvas.getContext('2d');
    g.scale(iconScale, iconScale);
    const lineWidth = 2.5;
    const c = size / 2;
    g.beginPath();
    g.arc(c, c, c - lineWidth / 2 - 1.5, 0, Math.PI * 2);
    g.lineWidth = lineWidth + 3;
    g.strokeStyle = rgba(config.HALO_COLOR, 0.5).toCssColorString();
    g.stroke();
    g.lineWidth = lineWidth;
    g.strokeStyle = config.TRACK_COLOR;
    g.stroke();
    icons.set(id, { canvas, width: size, height: size });
  }

  // Event markers, drawn the way the altitude timeline draws them: a
  // filled dot for reported, an orange ring for detected, a dashed ring for
  // inferred or estimated.
  function eventIcon(kind) {
    const size = EVENT_MARK_PX + 4; // room for the dark edge
    const canvas = document.createElement('canvas');
    canvas.width = size * iconScale;
    canvas.height = size * iconScale;
    const g = canvas.getContext('2d');
    g.scale(iconScale, iconScale);
    const c = size / 2;
    const r = EVENT_MARK_PX / 2;
    g.beginPath();
    g.arc(c, c, r + 1, 0, Math.PI * 2);
    g.fillStyle = config.HALO_COLOR;
    g.globalAlpha = config.HALO_OPACITY;
    g.fill();
    g.globalAlpha = 1;
    g.beginPath();
    g.arc(c, c, r - 1.25, 0, Math.PI * 2);
    g.fillStyle = kind === 'reported' ? config.TRACK_COLOR : PAGE;
    g.fill();
    if (kind === 'inferred') g.setLineDash([3, 2.4]);
    g.lineWidth = kind === 'detected' ? 2.5 : 2;
    g.strokeStyle = config.TRACK_COLOR;
    g.stroke();
    icons.set(`event-${kind}`, { canvas, width: size, height: size });
  }

  const iconsReady = Promise.all([
    svgIcon('board-focus', boardSvg(BOARD_FOCUSED), BOARD_FOCUSED),
    svgIcon('board-focus-hollow', boardSvg(BOARD_FOCUSED, { hollow: true }), BOARD_FOCUSED),
    svgIcon('board', boardSvg(BOARD_OTHER), BOARD_OTHER),
    svgIcon('board-hollow', boardSvg(BOARD_OTHER, { hollow: true }), BOARD_OTHER),
    svgIcon('start', startSvg(), [START_SIZE, START_SIZE]),
    anchoredIcon('dish', dishSvg(), DISH_SIZE, DISH_ANCHOR),
  ]).then(() => {
    ['reported', 'detected', 'inferred'].forEach(eventIcon);
    ringIcon('ring-focus', RING_FOCUSED_PX);
    ringIcon('ring', RING_PX);
  });

  let assetsReady = false;
  iconsReady.then(() => {
    if (destroyed) return;
    assetsReady = true;
    scheduler.schedule();
  }, (err) => {
    if (!destroyed) onFail(err);
  });

  const imageOf = new WeakMap(); // billboard -> the id of the image it shows

  function addIcon(collection, id, position) {
    const icon = icons.get(id);
    const billboard = collection.add({ position, image: icon.canvas, imageId: id, width: icon.width, height: icon.height, ...ALWAYS });
    imageOf.set(billboard, id);
    // A new image shows a frame or two after it is first asked for.
    pump();
    return billboard;
  }

  function setIcon(billboard, id) {
    if (imageOf.get(billboard) === id) return;
    const icon = icons.get(id);
    billboard.setImage(id, icon.canvas);
    billboard.width = icon.width;
    billboard.height = icon.height;
    imageOf.set(billboard, id);
    pump();
  }

  // ------------------------------------------------------------------
  // Ground heights. One lookup per spot (a launch pad, the ground
  // station), kept for the whole flight, seeks included.
  // ------------------------------------------------------------------
  let terrain = null;
  const spots = []; // { lat, lon, state: 'pending' | 'ok' | 'failed', height }

  // No terrain at all: the ground is drawn flat, and heights are measured
  // from it (see heightModel). Nothing waits on a ground height any more.
  function terrainFailed(err) {
    console.warn('Flight Console: Cesium World Terrain did not load', err);
    view.terrain = 'failed';
    for (const spot of spots) {
      if (spot.state === 'pending') spot.state = 'failed';
    }
    refresh();
  }

  C.createWorldTerrainAsync().then((provider) => {
    clearTimeout(terrainTimer);
    if (destroyed) return;
    // It may arrive after the time limit below. Then the flat ground gives
    // way to the real one, and the ground heights are looked up after all.
    terrain = provider;
    viewer.terrainProvider = provider;
    view.terrain = 'ok';
    for (const spot of spots) {
      if (spot.state !== 'ok') lookUp(spot);
    }
    refresh();
  }, (err) => {
    clearTimeout(terrainTimer);
    // (If the time limit already ran out, this has been dealt with.)
    if (!destroyed && view.terrain !== 'failed') terrainFailed(err);
  });
  // Cesium puts no time limit on its own requests, so a stalled one would
  // keep every rocket waiting for a ground height. After this long the
  // view carries on without terrain.
  const terrainTimer = setTimeout(() => {
    if (!destroyed && view.terrain === 'loading') terrainFailed(new Error('Cesium World Terrain took too long to load'));
  }, config.TERRAIN_SAMPLE_TIMEOUT_MS);

  function groundAt(lat, lon) {
    let spot = spots.find((s) => distanceM(s.lat, s.lon, lat, lon) <= config.PAD_RESAMPLE_M);
    if (!spot) {
      spot = { lat, lon, state: 'pending', height: null };
      spots.push(spot);
      if (terrain) lookUp(spot);
    }
    return spot;
  }

  function lookUp(spot) {
    spot.state = 'pending';
    // Starts as "not a number", so a lookup that quietly finds nothing
    // can't be mistaken for a height of 0.
    const point = C.Cartographic.fromDegrees(spot.lon, spot.lat, NaN);
    const timeout = new Promise((_, reject) => { setTimeout(() => reject(new Error('The ground height lookup took too long')), config.TERRAIN_SAMPLE_TIMEOUT_MS); });
    Promise.race([C.sampleTerrainMostDetailed(terrain, [point]), timeout]).then(() => {
      if (Number.isFinite(point.height)) {
        spot.state = 'ok';
        spot.height = point.height;
      } else {
        spot.state = 'failed';
      }
    }, (err) => {
      console.warn('Flight Console: the ground height lookup failed', err);
      spot.state = 'failed';
    }).then(() => {
      if (!destroyed) refresh();
    });
  }

  // How a rocket's points get their heights right now:
  //   { kind: 'wait' }            not known yet, so nothing is drawn
  //   { kind: 'ground', base }    the pad's ground height plus height above ground
  //   { kind: 'gps' }             approximate: each point's own GPS altitude
  // approx marks heights the note under the controls owns up to.
  function heightModel(rocket, parts) {
    const d = rocket.derived;
    const pad = rocket.padPosition;
    // Once liftoff is known, the store never finds a pad position later.
    // So a rocket with no pad by then has no pad at all: the data started
    // in flight, or the GPS only got its first fix after launch.
    const noPad = !pad && Number.isFinite(d?.liftoffT);
    if (view.terrain === 'failed') {
      // The ground is flat at height 0, so heights above ground go on that.
      if (pad || noPad) return { kind: 'ground', base: 0, approx: true };
      return { kind: 'wait' };
    }
    if (pad) {
      const spot = groundAt(pad.lat, pad.lon);
      if (spot.state === 'ok') {
        parts.ground = spot.height;
        return { kind: 'ground', base: spot.height, approx: false };
      }
      // A pad whose GPS position wandered onto a new spot keeps the ground
      // height already looked up for it, while the new lookup runs and if
      // it fails.
      if (Number.isFinite(parts.ground)) return { kind: 'ground', base: parts.ground, approx: false };
      return spot.state === 'failed' ? { kind: 'gps', approx: true } : { kind: 'wait' };
    }
    // No pad, so no ground height to stand on.
    if (noPad) return { kind: 'gps', approx: true };
    // Still waiting to see a pad. Its ground height is looked up now, from
    // where the rocket is sitting, so it is ready when the pad is confirmed.
    const first = rocket.track[0];
    if (first) groundAt(first.lat, first.lon);
    return { kind: 'wait' };
  }

  // Height above ground of one track point, the way the detector measures
  // it: the altitude it used at that moment minus its ground level. null
  // if the detector had no altitude then.
  function aglOf(rocket, p) {
    const d = rocket.derived;
    const ground = d?.groundRef;
    if (!Number.isFinite(ground)) return null;
    if (d.altSource === 'barometer') {
      // A board whose GPS spoke before its barometer was measured by GPS
      // altitude at first. Those early readings don't belong on the
      // barometer's ground level, so points from before the first
      // barometer reading have no height here.
      const since = firstBaroTime(rocket);
      if (since === null || p.t < since - 1e-9) return null;
      const alt = altitudeAt(rocket.altSeries, p.t);
      return alt === null ? null : alt - ground;
    }
    return Number.isFinite(p.altMsl) ? p.altMsl - ground : null;
  }

  // When a rocket's barometer first gave an altitude, or null if it hasn't
  // yet. Kept per sample list, since a seek starts a new list.
  const baroSince = new WeakMap();
  function firstBaroTime(rocket) {
    let t = baroSince.get(rocket.samples);
    if (t === undefined) {
      t = rocket.samples.find((s) => Number.isFinite(s.baro?.altM))?.t ?? null;
      if (t !== null) baroSince.set(rocket.samples, t);
    }
    return t;
  }

  // The altitude reading the detector had at time t: the last one at or
  // before it, if it is no older than ALTITUDE_STALE_S. Never a later one,
  // so a trail comes out the same whether it grew point by point or was
  // built again in one go after a seek.
  function altitudeAt(series, t) {
    let lo = 0;
    let hi = series.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (series[mid].t <= t + 1e-9) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const before = found >= 0 ? series[found] : null;
    return before && before.alt !== null && t - before.t <= config.ALTITUDE_STALE_S ? before.alt : null;
  }

  function pointPosition(rocket, model, p) {
    let height;
    if (model.kind === 'gps') height = p.altMsl;
    else {
      const agl = aglOf(rocket, p);
      height = agl === null ? null : model.base + agl;
    }
    return Number.isFinite(height) ? C.Cartesian3.fromDegrees(p.lon, p.lat, height) : null;
  }

  // ------------------------------------------------------------------
  // Drawing: one rocket
  // ------------------------------------------------------------------
  const drawn = new Map(); // rocketId -> everything drawn for that rocket

  function partsFor(rocket) {
    let parts = drawn.get(rocket.id);
    if (!parts) {
      parts = {
        track: null,      // the store's track array the positions were worked out from
        key: '',          // the height model, ground level and focus they were worked out with
        count: 0,         // track points looked at so far
        positions: [],    // one 3D position per track point, null if it has no height
        last: -1,         // index of the last point that has a position
        tail: [],         // the trail's lines, one per unbroken stretch in its window
        tailKey: '',      // what the trail was last built for
        focused: null,
        icon: null, iconHome: null, rings: [], ringStrength: 1, pad: null, padAt: null,
        ground: null,     // the last ground height looked up for this rocket's pad
        old: false,       // the marker sits at an older point than the newest good position
        approx: false, waiting: false,
      };
      drawn.set(rocket.id, parts);
    }
    return parts;
  }

  function clearTrail(parts) {
    for (const line of parts.tail) trails.remove(line);
    parts.tail = [];
    parts.tailKey = '';
    parts.positions = [];
    parts.count = 0;
    parts.last = -1;
  }

  function removeRocket(parts) {
    clearTrail(parts);
    if (parts.icon) parts.iconHome.remove(parts.icon);
    for (const ring of parts.rings) ringIcons.remove(ring);
    if (parts.pad) groundIcons.remove(parts.pad);
    parts.icon = null;
    parts.rings = [];
    parts.pad = null;
    parts.padAt = null;
  }

  // The trail's look: one color whose opacity follows the line, from
  // fadeFrom at its first point to fadeTo at its last. Both are shares of
  // the trail's window (0 at its far end, 1 at the marker), so the tail
  // fades out behind the marker like a comet's. Cesium hands a polyline's
  // material its place along the line in st.s: 0 at the first point and 1
  // at the last, in equal steps from point to point. A board sends at a
  // steady rate, so that is close to time.
  function trailMaterial(css) {
    return new C.Material({
      fabric: {
        uniforms: { trailColor: rgba(css, TRAIL_ALPHA), fadeFrom: 0, fadeTo: 1, fadePower: TRAIL_FADE_POWER },
        source: `czm_material czm_getMaterial(czm_materialInput materialInput) {
          czm_material material = czm_getDefaultMaterial(materialInput);
          float share = clamp(mix(fadeFrom, fadeTo, materialInput.st.s), 0.0, 1.0);
          material.diffuse = trailColor.rgb;
          material.alpha = trailColor.a * pow(share, fadePower);
          return material;
        }`,
      },
      translucent: true,
    });
  }

  function drawRocket(rocket, isFocused) {
    const parts = partsFor(rocket);
    const model = heightModel(rocket, parts);
    const ground = rocket.derived?.groundRef;
    // Anything that changes where points go, or how the trail looks, means
    // working the positions out again: a seek (the store hands out a new
    // track), a different height model, a ground level that moved (it
    // settles while the rocket sits on the pad and is frozen at liftoff),
    // or a new focus.
    const key = [model.kind, model.base ?? '', model.kind === 'ground' && Number.isFinite(ground) ? ground : '', isFocused].join('|');
    if (parts.track !== rocket.track || parts.key !== key || parts.count > rocket.track.length) {
      if (parts.focused !== null && parts.focused !== isFocused) removeRocket(parts);
      else clearTrail(parts);
      parts.track = rocket.track;
      parts.key = key;
    }
    parts.focused = isFocused;
    parts.approx = model.kind !== 'wait' && model.approx;
    parts.waiting = model.kind === 'wait' && Boolean(rocket.lastGoodFix);

    // Positions for the new points since the last draw. A point with no
    // height known gets none, which breaks the trail there.
    if (model.kind !== 'wait') {
      const track = rocket.track;
      for (let i = parts.count; i < track.length; i++) {
        const position = pointPosition(rocket, model, track[i]);
        parts.positions.push(position);
        if (position) parts.last = i;
      }
      parts.count = track.length;
    }

    drawTrail(rocket, parts, isFocused);
    drawPad(rocket, parts, model);
    drawRocketIcon(rocket, parts, isFocused);
  }

  // The trail: the positions from the last TRAIL_WINDOW_S seconds up to
  // the marker, as thin solid lines that fade out toward the far end. It
  // breaks wherever the positions do, as on the map: the GPS had no fix
  // (gapBefore), no position came for longer than LINK_STALE_S, or a point
  // has no height. Nobody measured the path across a break, so nothing is
  // drawn there.
  function drawTrail(rocket, parts, isFocused) {
    const tailKey = `${parts.last}|${parts.count}`;
    if (tailKey === parts.tailKey) return;
    parts.tailKey = tailKey;
    const track = rocket.track;
    const end = parts.last;
    const runs = [];
    const span = TRAIL_WINDOW_S;
    const tEnd = end >= 0 ? track[end].t : 0;
    if (end >= 0) {
      let first = end;
      while (first > 0 && track[first - 1].t >= tEnd - span) first -= 1;
      let run = null;
      for (let i = first; i <= end; i++) {
        const p = track[i];
        const position = parts.positions[i];
        if (!position) {
          run = null;
          continue;
        }
        if (run && (p.gapBefore || p.t - run.lastT > config.LINK_STALE_S)) run = null;
        if (!run) {
          run = { positions: [], firstT: p.t, lastT: p.t };
          runs.push(run);
        }
        run.positions.push(position);
        run.lastT = p.t;
      }
    }
    const share = (t) => Math.min(1, Math.max(0, 1 - (tEnd - t) / span));
    const shown = runs.filter((run) => run.positions.length >= 2);
    shown.forEach((run, k) => {
      let line = parts.tail[k];
      if (!line) {
        line = trails.add({
          positions: run.positions,
          width: isFocused ? TRAIL_WIDTH_PX : TRAIL_OTHER_WIDTH_PX,
          material: trailMaterial(isFocused ? config.TRACK_COLOR : rocket.profile.color),
        });
        parts.tail.push(line);
      } else {
        line.positions = run.positions;
        line.show = true;
      }
      line.material.uniforms.fadeFrom = share(run.firstT);
      line.material.uniforms.fadeTo = share(run.lastT);
    });
    for (let k = shown.length; k < parts.tail.length; k++) parts.tail[k].show = false;
  }

  // The board marker at the last trail point that has a height. That is
  // usually its last good position: the board's blue with pulse rings
  // while the fix is good, hollow with no rings when there is no fix right
  // now or the newest position has no height yet (a barometer that went
  // quiet). It is a billboard with no rotation and no scaling, so it always
  // stands upright and keeps one size on screen.
  function drawRocketIcon(rocket, parts, isFocused) {
    const position = parts.last >= 0 ? parts.positions[parts.last] : null;
    if (!position) {
      if (parts.icon) parts.icon.show = false;
      for (const ring of parts.rings) ring.show = false;
      return;
    }
    parts.old = parts.last !== rocket.track.length - 1;
    const live = store.hasFixNow(rocket) && !parts.old;
    const id = `board${isFocused ? '-focus' : ''}${live ? '' : '-hollow'}`;
    if (!parts.icon) {
      parts.iconHome = isFocused ? focusIcons : rocketIcons;
      parts.icon = addIcon(parts.iconHome, id, position);
      const ringId = isFocused ? 'ring-focus' : 'ring';
      parts.rings = [0, 1, 2].map(() => addIcon(ringIcons, ringId, position));
      // Other rockets' rings are half as strong, as on the map.
      parts.ringStrength = isFocused ? 1 : 0.5;
    }
    parts.icon.show = true;
    parts.icon.position = position;
    setIcon(parts.icon, id);
    for (const ring of parts.rings) {
      ring.show = live;
      ring.position = position;
    }
  }

  // The start point (the launch point in a replay): the last good position
  // before liftoff, as a small dot on the ground height looked up for it.
  function drawPad(rocket, parts, model) {
    const pad = rocket.padPosition;
    const height = !pad || model.kind === 'wait' ? null : model.kind === 'ground' ? model.base : pad.altMsl;
    if (!Number.isFinite(height)) {
      if (parts.pad) parts.pad.show = false;
      return;
    }
    const position = C.Cartesian3.fromDegrees(pad.lon, pad.lat, height);
    if (!parts.pad) parts.pad = addIcon(groundIcons, 'start', position);
    parts.pad.show = true;
    parts.pad.position = position;
    parts.padAt = position;
  }

  // ------------------------------------------------------------------
  // Pulse rings. Three orange rings around each board with a good fix
  // grow and fade outward, a third of a pulse apart, like the map's. The
  // scene only redraws when something changes, so while rings show, a
  // loop asks for a frame at most RING_PULSE_FPS times a second. It rests
  // while the view is off screen or paused behind the map, and stops when
  // no ring shows. Viewers who ask for less motion get three still rings
  // and no loop.
  // ------------------------------------------------------------------
  let pulseFrame = 0;
  let pulseDrawn = -Infinity;
  const ringColor = new C.Color(1, 1, 1, 1);

  function ringsShowing() {
    for (const parts of drawn.values()) if (parts.rings[0]?.show) return true;
    return false;
  }

  function setRings(now) {
    const still = prefersReducedMotion();
    for (const parts of drawn.values()) {
      if (!parts.rings[0]?.show) continue;
      parts.rings.forEach((ring, k) => {
        let scale;
        let alpha;
        if (still) [scale, alpha] = RING_STILL[k];
        else {
          // Where this ring is in its pulse, 0 to 1, with ring k a third
          // of a pulse behind ring k - 1. Fast at first and slow at the
          // end, close to the map's cubic-bezier(0.25, 0.6, 0.4, 1).
          const u = (((now / RING_PULSE_MS - k / 3) % 1) + 1) % 1;
          const eased = 1 - (1 - u) ** 2.4;
          scale = RING_FROM_SCALE + (1 - RING_FROM_SCALE) * eased;
          alpha = 1 - eased;
        }
        ring.scale = scale;
        ringColor.alpha = alpha * parts.ringStrength;
        ring.color = ringColor;
      });
    }
  }

  // True when some of the view is on screen (the console's other panel
  // slides it out of sight).
  function onScreen() {
    const r = scene.canvas.getBoundingClientRect();
    return r.width > 0 && r.right > 0 && r.left < window.innerWidth && r.bottom > 0 && r.top < window.innerHeight;
  }

  function pulse(now) {
    pulseFrame = 0;
    if (destroyed || !active || prefersReducedMotion() || !ringsShowing()) return;
    pulseFrame = window.requestAnimationFrame(pulse);
    if (now - pulseDrawn < 1000 / RING_PULSE_FPS - 4 || !onScreen()) return;
    pulseDrawn = now;
    setRings(now);
    scene.requestRender();
  }

  // Runs after every draw: sets the rings for this moment, and starts the
  // loop if it isn't running.
  function startPulse() {
    setRings(performance.now());
    if (!pulseFrame && !destroyed && active && !prefersReducedMotion() && ringsShowing()) {
      pulseFrame = window.requestAnimationFrame(pulse);
    }
  }

  // ------------------------------------------------------------------
  // Drawing: the ground station, its line to the focused rocket and the
  // event markers
  // ------------------------------------------------------------------
  const station = { icon: null, position: null, ground: null, groundSpot: null, approx: false };

  function drawStation() {
    const gs = store.getGroundStation();
    let height = null;
    station.approx = false;
    if (!gs) {
      // No ground station at all: nothing to draw.
    } else if (view.terrain === 'failed') {
      height = 0;
    } else {
      const spot = groundAt(gs.lat, gs.lon);
      if (spot.state === 'ok') {
        height = spot.height;
        station.ground = spot.height;
        station.groundSpot = spot;
      } else if (Number.isFinite(station.ground) && distanceM(station.groundSpot.lat, station.groundSpot.lon, gs.lat, gs.lon) <= STATION_KEEP_M) {
        // A new spot close by is still being looked up, or its lookup
        // failed: keep the ground height the station already had there.
        height = station.ground;
      } else if (spot.state === 'failed') {
        // Its own altitude if it sent one, otherwise the ground height at
        // a launch pad. With neither, it isn't drawn.
        const padGround = [...drawn.values()].map((parts) => parts.ground).find(Number.isFinite);
        height = Number.isFinite(gs.altMsl) ? gs.altMsl : padGround ?? null;
        station.approx = true;
      }
    }
    if (height === null) {
      station.position = null;
      if (station.icon) station.icon.show = false;
      return;
    }
    // The dish. While the ground station is the demo placeholder, the KEY
    // and the readings panel say so.
    const position = C.Cartesian3.fromDegrees(gs.lon, gs.lat, height);
    station.position = position;
    if (!station.icon) station.icon = addIcon(groundIcons, 'dish', position);
    station.icon.show = true;
    station.icon.position = position;
  }

  // Event markers in the sky, for the focused rocket: one at the trail
  // point of its apogee, drogue, main and landing, and of each event its
  // board reported, drawn by how the event was found. They come from the
  // live store, so a marker only exists once playback has reached its
  // event. An event with no good position at its time (a GPS gap) gets no
  // marker, since there is no real place to put it.
  let marks = [];
  let marksKey = '';

  function drawEvents(focused) {
    const parts = focused ? drawn.get(focused.id) : null;
    const events = focused && parts ? focused.events.filter((e) => EVENT_TYPES.has(e.type) || e.type === 'reported') : [];
    // Rebuilt when the list of events changes, or the positions under them
    // were worked out again (parts.key). A board's own event is logged the
    // moment it arrives, and a closer GPS point can come in just after it,
    // so the markers are also placed again on each new point until the
    // trail is ALTITUDE_STALE_S past every event.
    const newest = focused?.track[focused.track.length - 1];
    const settling = events.some((e) => !newest || newest.t <= e.t + config.ALTITUDE_STALE_S) ? focused.track.length : 'settled';
    const key = `${focused?.id ?? ''}|${parts?.key ?? ''}|${events.length}|${parts?.track === focused?.track}|${settling}`;
    if (key !== marksKey || marks.some((m) => m.track !== focused?.track)) {
      marksKey = key;
      for (const m of marks) eventIcons.remove(m.icon);
      marks = [];
      for (const e of events) {
        // The marker goes on a real trail point, never between two.
        const i = nearestPoint(focused.track, parts.positions, e.t);
        if (i < 0) continue;
        const kind = eventMarkerKind(e, focused.derived);
        const icon = addIcon(eventIcons, `event-${kind === 'estimated' ? 'inferred' : kind}`, parts.positions[i]);
        marks.push({ icon, track: focused.track });
      }
    }
  }

  // Index of the drawn track point closest in time to t, no further away
  // than ALTITUDE_STALE_S (a board that times events from its barometer
  // sends GPS positions at other moments). -1 if there is none.
  function nearestPoint(track, positions, t) {
    let best = -1;
    let bestGap = config.ALTITUDE_STALE_S + 1e-6;
    for (let i = 0; i < track.length && i < positions.length; i++) {
      const gap = Math.abs(track[i].t - t);
      if (positions[i] && gap < bestGap) { best = i; bestGap = gap; }
      if (track[i].t > t + config.ALTITUDE_STALE_S) break;
    }
    return best;
  }

  // ------------------------------------------------------------------
  // Camera. It always looks at one point (the pivot) from a heading, a
  // pitch and a distance. Everything that moves the camera changes those
  // four values in `look` and calls aim().
  //
  // Three ways the pivot is chosen:
  //   'follow'  the focused rocket. The camera steps with it, one data
  //             point at a time, and keeps the viewer's angle and distance.
  //   'whole'   the middle of everything drawn so far, from far enough
  //             back to fit it all. It is framed again as the trail grows,
  //             until the viewer zooms or slides the view.
  //   'free'    wherever the viewer left it.
  // ------------------------------------------------------------------
  let cameraMode = options.follow ? 'follow' : 'free';
  let started = false;         // the starting view has been set on real data
  let framed = null;           // what 'whole' last framed: { center, radius }
  let glide = null;            // a camera move in progress: { to, frame }
  let flying = false;          // the fly-in from the far view is running
  const frameOf = (position) => C.Transforms.eastNorthUpToFixedFrame(position);
  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
  const PITCH_MIN = C.Math.toRadians(config.GLOBE_PITCH_MIN_DEG);
  const PITCH_MAX = C.Math.toRadians(config.GLOBE_PITCH_MAX_DEG);

  // The flight's highest point above ground (m), from the pre-scan (the
  // same number the timeline uses for its scale). 0 if there is none.
  function flightTop() {
    let top = 0;
    for (const [, scan] of prescan) top = Math.max(top, scan.state?.maxAgl ?? 0);
    return top;
  }

  // The starting angle: from the side, tilted down a little, far enough
  // back for the whole climb.
  function startOrbit() {
    return {
      heading: C.Math.toRadians(config.GLOBE_START_HEADING_DEG),
      pitch: C.Math.toRadians(config.GLOBE_START_PITCH_DEG),
      range: Math.min(config.GLOBE_START_RANGE_MAX_M, Math.max(config.GLOBE_START_RANGE_MIN_M, flightTop() * config.GLOBE_START_RANGE_PER_APOGEE)),
    };
  }

  // The spot the starting view aims at when it isn't following a rocket:
  // straight above a launch pad, half as high as the flight goes, so the
  // pad and the highest point both fit.
  function abovePad(position) {
    const c = C.Cartographic.fromCartesian(position);
    return C.Cartesian3.fromRadians(c.longitude, c.latitude, c.height + flightTop() / 2);
  }

  // Where the camera looks from: { pivot, heading, pitch, range }. Until
  // there is real data to look at, it waits over the ground station, so
  // the ground there starts loading. With no ground station it waits far
  // out over the Atlantic, looking straight down at the whole Earth, and
  // the zoom limit lets it stay that far out until the first real view
  // (see aim).
  const waitFar = !store.getGroundStation();
  const look = (() => {
    const gs = store.getGroundStation();
    if (!gs) return { pivot: C.Cartesian3.fromDegrees(WAIT_FAR_LON, WAIT_FAR_LAT, 0), heading: 0, pitch: PITCH_MIN, range: WAIT_FAR_RANGE_M };
    return { pivot: C.Cartesian3.fromDegrees(gs.lon, gs.lat, Number.isFinite(gs.altMsl) ? gs.altMsl : 0), ...startOrbit() };
  })();

  // Where the camera itself is, for a pivot, heading, pitch and distance.
  // (Heading 0 looks north, so the camera is south of the pivot. A
  // negative pitch looks down, so the camera is above it.)
  function cameraSpot(o) {
    const flat = Math.cos(o.pitch) * o.range;
    const local = new C.Cartesian3(-Math.sin(o.heading) * flat, -Math.cos(o.heading) * flat, -Math.sin(o.pitch) * o.range);
    return C.Matrix4.multiplyByPoint(frameOf(o.pivot), local, new C.Cartesian3());
  }

  // Tilts the camera down just enough to stay above the ground, so an
  // orbit or a zoom can't take it under a hill.
  function keepAboveGround() {
    const pivotHeight = C.Cartographic.fromCartesian(look.pivot).height;
    for (let pass = 0; pass < 3; pass++) {
      const spot = C.Cartographic.fromCartesian(cameraSpot(look));
      const ground = scene.globe.getHeight(spot);
      // No ground drawn under the camera yet: nothing to keep clear of.
      if (!Number.isFinite(ground)) return;
      const lowest = ground + config.GLOBE_GROUND_CLEARANCE_M;
      if (spot.height >= lowest) return;
      // The pitch that puts the camera that high: sin(-pitch) is the rise
      // over the distance. A touch more each pass, since the ground under
      // the camera changes as it tilts.
      const rise = (lowest - pivotHeight) / look.range;
      if (rise >= 1) {
        look.pitch = PITCH_MIN;
        return;
      }
      look.pitch = Math.max(PITCH_MIN, Math.min(look.pitch, -Math.asin(clamp(rise, -1, 1))) - 0.003);
    }
  }

  // Points the camera where `look` says.
  function aim() {
    look.range = clamp(look.range, config.GLOBE_ZOOM_MIN_M, waitFar && !started ? WAIT_FAR_RANGE_M : config.GLOBE_ZOOM_MAX_M);
    look.pitch = clamp(look.pitch, PITCH_MIN, PITCH_MAX);
    keepAboveGround();
    camera.lookAtTransform(frameOf(look.pivot), new C.HeadingPitchRange(look.heading, look.pitch, look.range));
    scene.requestRender();
  }

  // Moves the camera to a new look in a short glide, or at once when the
  // viewer has asked for less motion.
  function moveTo(to, { animate }) {
    stopGlide();
    if (!animate || prefersReducedMotion()) {
      Object.assign(look, to);
      aim();
      return;
    }
    const from = { pivot: C.Cartesian3.clone(look.pivot), heading: look.heading, pitch: look.pitch, range: look.range };
    // The short way round.
    const turn = C.Math.negativePiToPi(to.heading - from.heading);
    const began = performance.now();
    const step = (now) => {
      if (destroyed || !glide) return;
      const u = clamp((now - began) / config.GLOBE_MOVE_MS, 0, 1);
      const eased = u * u * (3 - 2 * u);
      look.pivot = C.Cartesian3.lerp(from.pivot, glide.to.pivot, eased, new C.Cartesian3());
      look.heading = from.heading + turn * eased;
      look.pitch = from.pitch + (glide.to.pitch - from.pitch) * eased;
      look.range = Math.exp(Math.log(from.range) + (Math.log(glide.to.range) - Math.log(from.range)) * eased);
      aim();
      if (u < 1) glide.frame = window.requestAnimationFrame(step);
      else glide = null;
    };
    glide = { to, frame: window.requestAnimationFrame(step) };
  }

  function stopGlide() {
    if (glide) window.cancelAnimationFrame(glide.frame);
    glide = null;
    if (flying) camera.cancelFlight();
  }

  // The first position after the far view: Cesium's own flight down to it,
  // ending exactly where `to` looks from. Anything the viewer does with the
  // camera on the way ends the flight at its goal.
  function flyIn(to) {
    stopGlide();
    Object.assign(look, to);
    look.range = clamp(look.range, config.GLOBE_ZOOM_MIN_M, config.GLOBE_ZOOM_MAX_M);
    look.pitch = clamp(look.pitch, PITCH_MIN, PITCH_MAX);
    if (prefersReducedMotion()) {
      aim();
      return;
    }
    const landed = () => {
      if (!flying) return;
      flying = false;
      if (!destroyed) aim();
    };
    camera.lookAtTransform(C.Matrix4.IDENTITY);
    flying = true;
    camera.flyTo({
      destination: cameraSpot(look),
      orientation: { heading: look.heading, pitch: look.pitch, roll: 0 },
      duration: FLY_IN_S,
      complete: landed,
      cancel: landed,
    });
    scene.requestRender();
  }

  // Ends a glide at its goal (the view is about to be hidden).
  function finishGlide() {
    // A fly-in ends at its goal when it is cancelled.
    if (flying) camera.cancelFlight();
    if (!glide) return;
    const { to } = glide;
    stopGlide();
    Object.assign(look, to);
    aim();
  }

  const focusedTarget = () => {
    const parts = drawn.get(store.getFocusedId());
    return parts && parts.last >= 0 ? parts.positions[parts.last] : null;
  };
  const firstPad = () => {
    const focusedParts = drawn.get(store.getFocusedId());
    if (focusedParts?.pad?.show) return focusedParts.padAt;
    for (const parts of drawn.values()) if (parts.pad?.show) return parts.padAt;
    return null;
  };

  // Every point worth framing: the trails, the pads and the ground station.
  function everything() {
    const points = [];
    for (const parts of drawn.values()) {
      for (const p of parts.positions) if (p) points.push(p);
      if (parts.pad?.show) points.push(parts.padAt);
    }
    if (station.position) points.push(station.position);
    return points;
  }

  function frameEverything({ animate }) {
    const points = everything();
    // Nothing to frame yet, or no view to measure (hidden behind the map).
    // updateCamera() frames as soon as there is.
    if (!points.length || scene.canvas.clientWidth < 1 || scene.canvas.clientHeight < 1) return;
    const sphere = C.BoundingSphere.fromPoints(points);
    sphere.radius = Math.max(sphere.radius, 150);
    // Keep the side the viewer is looking from, never flatter than the
    // starting tilt, so the ground stays in view.
    const pitch = Math.min(C.Math.toRadians(config.GLOBE_START_PITCH_DEG), Math.max(C.Math.toRadians(-70), look.pitch));
    // Fit it in the part of the view between the tall panels that float
    // over it (like the readings panel on the right),
    // not under them.
    const width = scene.canvas.clientWidth;
    const height = scene.canvas.clientHeight;
    let leftInset = 0;
    let rightInset = 0;
    for (const c of covers()) {
      if (c.bottom - c.top < height / 3) continue;
      if (c.left < width * 0.25) leftInset = Math.max(leftInset, c.right);
      else if (c.right > width * 0.75) rightInset = Math.max(rightInset, width - c.left);
    }
    const free = Math.max(0.3, (width - leftInset - rightInset) / Math.max(1, width));
    const tanV = Math.tan(camera.frustum.fovy / 2);
    const tanH = tanV * camera.frustum.aspectRatio;
    const range = (sphere.radius / Math.min(tanV, tanH * free)) * config.GLOBE_FIT_MARGIN;
    framed = { center: C.Cartesian3.clone(sphere.center), radius: sphere.radius };
    // The camera aims a little to one side of the middle, so the middle
    // of what is framed lands in the middle of the free part.
    const metersPerPx = (2 * range * tanH) / Math.max(1, width);
    const shift = ((rightInset - leftInset) / 2) * metersPerPx;
    const local = new C.Cartesian3(Math.cos(look.heading) * shift, -Math.sin(look.heading) * shift, 0);
    const pivot = C.Matrix4.multiplyByPoint(frameOf(sphere.center), local, new C.Cartesian3());
    moveTo({ pivot, heading: look.heading, pitch, range }, { animate });
  }

  // Runs after every draw: keeps the camera on what its mode says.
  function updateCamera() {
    const target = focusedTarget();
    if (!started) {
      // The first real position to look at: the focused rocket, or a pad.
      const first = target ?? firstPad();
      if (!first) return;
      started = true;
      const pad = firstPad();
      const pivot = cameraMode === 'follow' && target ? target : pad ? abovePad(pad) : first;
      // From the far view it flies down. Over a ground station it is
      // already close, so it starts there.
      if (waitFar && cameraMode !== 'whole') flyIn({ pivot, ...startOrbit() });
      else moveTo({ pivot, ...startOrbit() }, { animate: false });
      // "Whole flight" was chosen before there was anything to frame.
      if (cameraMode === 'whole') frameEverything({ animate: false });
      return;
    }
    // The fly-in ends on the newest point.
    if (flying) {
      if (cameraMode === 'follow' && target) look.pivot = target;
      return;
    }
    if (cameraMode === 'follow' && target) {
      // The camera steps with the rocket, one data point at a time, and
      // keeps the viewer's angle and distance. A glide on its way to the
      // rocket ends on the new point.
      if (glide) glide.to.pivot = target;
      else if (!C.Cartesian3.equals(target, look.pivot)) {
        look.pivot = target;
        aim();
      }
    } else if (cameraMode === 'whole') {
      if (!framed) {
        frameEverything({ animate: true });
        return;
      }
      // Frame again once something drawn pokes out of what was framed.
      const points = everything();
      if (!points.length) return;
      const sphere = C.BoundingSphere.fromPoints(points);
      const reach = C.Cartesian3.distance(sphere.center, framed.center) + sphere.radius;
      if (reach > framed.radius * (1 + (config.GLOBE_FIT_MARGIN - 1) * 0.7)) frameEverything({ animate: true });
    }
  }

  // Zooming or sliding the view in 'whole' means the viewer took over.
  // (Orbiting doesn't: everything stays framed from any side.)
  function leaveWhole() {
    if (cameraMode !== 'whole') return;
    cameraMode = 'free';
    framed = null;
    onChange();
  }

  // ------------------------------------------------------------------
  // Controls. One finger, or the left mouse button, orbits the camera
  // around the pivot. The wheel or a pinch zooms. Two fingers twisting
  // turn the view. The right mouse button, Shift with a drag, or two
  // fingers dragging slide the view over the ground. Sliding stops
  // following the rocket. With the mouse it does so at once. With two
  // fingers it only slides once "Follow rocket" is off, so a pinch can't
  // switch following off by accident. The arrow keys move the camera
  // around the pivot, and + and - zoom. Nothing keeps moving after the
  // hand lets go.
  // ------------------------------------------------------------------
  const canvas = scene.canvas;
  const DRAG_RATE = C.Math.toRadians(config.GLOBE_ORBIT_DEG_PER_PX);
  const fingers = new Map();   // pointerId -> { x, y, slide }
  let pair = null;             // the last two-finger measurement: { gap, angle, x, y }
  let pairFrame = 0;           // the frame a two-finger update is waiting for

  // A drag to the right pulls the near side of the scene to the right. A
  // drag down pulls it down, so the camera rises.
  function orbitBy(dx, dy) {
    stopGlide();
    look.heading += dx * DRAG_RATE;
    look.pitch -= dy * DRAG_RATE;
    aim();
  }

  function zoomBy(factor) {
    stopGlide();
    look.range *= factor;
    leaveWhole();
    aim();
  }

  // Slides the pivot over the ground, so the ground under the pointer
  // moves with it.
  function slideBy(dx, dy) {
    stopGlide();
    if (cameraMode === 'follow') {
      cameraMode = 'free';
      onFollowOff();
    }
    leaveWhole();
    const metersPerPx = (2 * look.range * Math.tan(camera.frustum.fovy / 2)) / Math.max(1, canvas.clientHeight);
    const sideways = -dx * metersPerPx;
    // A drag toward the viewer covers more ground the flatter the camera looks.
    const ahead = (dy * metersPerPx) / Math.max(0.35, Math.sin(Math.abs(look.pitch)));
    const local = new C.Cartesian3(
      Math.cos(look.heading) * sideways + Math.sin(look.heading) * ahead,
      -Math.sin(look.heading) * sideways + Math.cos(look.heading) * ahead,
      0);
    look.pivot = C.Matrix4.multiplyByPoint(frameOf(look.pivot), local, new C.Cartesian3());
    aim();
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button > 2) return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    // The right or middle mouse button, or Shift, slides instead of orbiting.
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY, slide: e.pointerType === 'mouse' && (e.button !== 0 || e.shiftKey) });
    // A second finger starts a two-finger gesture from where both are now.
    pair = fingers.size === 2 ? measurePair() : null;
    container.classList.add('is-dragging');
    // Keyboard focus comes to the view, so the arrow keys work after a click.
    if (document.activeElement !== container) container.focus({ preventScroll: true });
  }

  function onPointerMove(e) {
    const finger = fingers.get(e.pointerId);
    if (!finger) return;
    const dx = e.clientX - finger.x;
    const dy = e.clientY - finger.y;
    finger.x = e.clientX;
    finger.y = e.clientY;
    if (fingers.size === 1) {
      if (finger.slide) slideBy(dx, dy);
      else orbitBy(dx, dy);
    } else if (fingers.size === 2 && !pairFrame) {
      // The browser reports each finger in turn. Both are read together,
      // once a frame, so one finger's half of a move isn't taken for a pinch.
      pairFrame = window.requestAnimationFrame(() => {
        pairFrame = 0;
        twoFingers();
      });
    }
  }

  // Where two fingers are: how far apart, at what angle, and their middle.
  function measurePair() {
    const [a, b] = [...fingers.values()];
    return { gap: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  // Two fingers: the gap between them zooms, their twist turns the view,
  // and (with "Follow rocket" off) their shared movement slides it.
  function twoFingers() {
    if (destroyed || fingers.size !== 2) return;
    const now = measurePair();
    const last = pair;
    pair = now;
    if (!last) return;
    stopGlide();
    if (last.gap > 0 && now.gap > 0 && last.gap !== now.gap) {
      look.range *= last.gap / now.gap;
      leaveWhole();
    }
    look.heading -= C.Math.negativePiToPi(now.angle - last.angle);
    if (cameraMode === 'follow') aim();
    else slideBy(now.x - last.x, now.y - last.y);
  }

  function onPointerEnd(e) {
    if (!fingers.delete(e.pointerId)) return;
    pair = null;
    if (!fingers.size) container.classList.remove('is-dragging');
  }

  function onWheel(e) {
    // Wheels that count in lines or pages are turned into pixels. One
    // notch of a mouse wheel is about 100.
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 300 : 1;
    const delta = clamp(e.deltaY * unit, -300, 300);
    // A pinch on a trackpad arrives as a wheel with Ctrl held, in much
    // smaller steps.
    const step = e.ctrlKey ? clamp(delta * 0.01, -0.3, 0.3) : (delta / 100) * Math.log(config.GLOBE_ZOOM_PER_NOTCH);
    zoomBy(Math.exp(step));
  }

  function onKeyDown(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const turn = C.Math.toRadians(config.GLOBE_KEY_TURN_DEG);
    if (e.key === 'ArrowLeft') look.heading += turn;
    else if (e.key === 'ArrowRight') look.heading -= turn;
    else if (e.key === 'ArrowUp') look.pitch -= turn / 2;
    else if (e.key === 'ArrowDown') look.pitch += turn / 2;
    else if (e.key === '+' || e.key === '=') look.range /= config.GLOBE_KEY_ZOOM;
    else if (e.key === '-' || e.key === '_') look.range *= config.GLOBE_KEY_ZOOM;
    else return;
    e.preventDefault();
    stopGlide();
    if (e.key.length === 1) leaveWhole();
    aim();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);
  canvas.addEventListener('lostpointercapture', onPointerEnd);
  canvas.addEventListener('wheel', onWheel, { passive: true });
  container.addEventListener('keydown', onKeyDown);
  aim();

  // ------------------------------------------------------------------
  // One pass over everything
  // ------------------------------------------------------------------
  function draw() {
    if (destroyed || !active || !assetsReady) return;
    const rockets = store.getRockets();
    const focused = store.getFocused();

    // A rocket the store no longer has (a new flight) goes away.
    for (const [id, parts] of drawn) {
      if (!rockets.some((r) => r.id === id)) {
        removeRocket(parts);
        drawn.delete(id);
      }
    }
    drawStation();
    for (const rocket of rockets) drawRocket(rocket, focused?.id === rocket.id);
    drawEvents(focused);
    startPulse();
    updateCamera();

    const text = notes().join('|');
    if (text !== notesText) {
      notesText = text;
      onChange();
    }
    scene.requestRender();
  }

  // The notes shown under the map controls while the 3D view is on.
  let notesText = '';
  function notes() {
    const out = [];
    const parts = [...drawn.values()];
    if (parts.some((p) => p.waiting)) out.push(words.waiting);
    if (parts.some((p) => p.approx) || station.approx || view.terrain === 'failed') out.push('3D ground height is approximate.');
    if (view.imageryFailed) out.push('The 3D imagery didn\'t load, so the ground is plain.');
    return out;
  }

  // Tells map-view.js when the first picture is in, so its "Loading"
  // panel can go: the icons and terrain are loaded, no ground
  // height is still being looked up, and the ground in view has drawn. If
  // that takes too long, the view shows as it is.
  let announced = false;
  function announceReady() {
    if (announced || destroyed) return;
    announced = true;
    clearTimeout(readyTimer);
    stopWatchingReady();
    onReady();
  }
  const stopWatchingReady = scene.postRender.addEventListener(() => {
    if (assetsReady && view.terrain !== 'loading' && !spots.some((s) => s.state === 'pending') && scene.globe.tilesLoaded) announceReady();
  });
  const readyTimer = setTimeout(announceReady, config.GLOBE_READY_TIMEOUT_MS);

  // Draws again after something outside the store changed (the terrain
  // arrived, a ground height came back).
  function refresh() {
    scheduler.schedule();
    onChange();
  }

  const scheduler = createScheduler(draw, { maxFps: config.MAP_MAX_FPS });
  const unsubscribe = store.subscribe(() => scheduler.schedule());
  scheduler.schedule();

  return {
    // The shared "Follow rocket" setting.
    setFollow(on) {
      if (destroyed) return;
      if (on) {
        cameraMode = 'follow';
        framed = null;
        // Glide over to the rocket, keeping the viewer's angle and distance.
        const target = focusedTarget();
        if (target && started) moveTo({ pivot: target, heading: look.heading, pitch: look.pitch, range: look.range }, { animate: true });
      } else if (cameraMode === 'follow') {
        // The camera stays where it is, around the rocket's last point.
        cameraMode = 'free';
      }
      scene.requestRender();
    },
    // "Whole flight": frame the trails, the pads and the ground station.
    showWholeFlight() {
      if (destroyed) return;
      cameraMode = 'whole';
      frameEverything({ animate: true });
      scene.requestRender();
    },
    // "Reset view": back to the starting angle and distance, on the rocket
    // while following it, otherwise above the launch pad.
    resetView() {
      if (destroyed) return;
      framed = null;
      const target = focusedTarget();
      if (cameraMode === 'follow' && target) moveTo({ pivot: target, ...startOrbit() }, { animate: true });
      else {
        if (cameraMode === 'whole') cameraMode = 'free';
        const pad = firstPad();
        const spot = pad ? abovePad(pad) : target ?? station.position;
        if (spot) moveTo({ pivot: spot, ...startOrbit() }, { animate: true });
      }
      scene.requestRender();
    },
    cameraMode: () => cameraMode,
    notes,
    // Paused while the map is showing instead: nothing is drawn and
    // Cesium's own loop stops. Coming back catches up from the store.
    setActive(on) {
      if (destroyed || active === on) return;
      active = on;
      if (!on) finishGlide();
      viewer.useDefaultRenderLoop = on;
      if (on) scheduler.flush();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      unsubscribe();
      scheduler.cancel();
      clearTimeout(readyTimer);
      clearTimeout(terrainTimer);
      stopWatchingReady();
      stopSkySwitch();
      stopGlide();
      window.cancelAnimationFrame(pairFrame);
      window.cancelAnimationFrame(pulseFrame);
      scene.canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerEnd);
      canvas.removeEventListener('pointercancel', onPointerEnd);
      canvas.removeEventListener('lostpointercapture', onPointerEnd);
      canvas.removeEventListener('wheel', onWheel);
      container.removeEventListener('keydown', onKeyDown);
      container.classList.remove('is-dragging');
      // Cesium frees its own buffers and textures but leaves the WebGL
      // context for the browser to collect later. Browsers only allow a
      // few contexts at once, so it is let go here.
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      try {
        viewer.destroy();
      } finally {
        gl?.getExtension('WEBGL_lose_context')?.loseContext();
        for (const el of headAdded) el.remove();
        container.replaceChildren();
        credits.replaceChildren();
        drawn.clear();
        icons.clear();
        spots.length = 0;
      }
    },
  };
}

// A CSS color variable as an rgba() string Cesium can read. The browser
// works it out: a probe element takes the color, and a 1 by 1 canvas turns
// whatever the browser computed (a color-mix() included) into plain
// numbers. fallback is used if the variable is missing.
let probeCanvas = null;
function cssColor(el, name, fallback) {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  probe.style.color = `var(${name}, ${fallback})`;
  el.append(probe);
  const css = getComputedStyle(probe).color;
  probe.remove();
  probeCanvas ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!probeCanvas) return fallback;
  probeCanvas.canvas.width = 1;
  probeCanvas.canvas.height = 1;
  probeCanvas.clearRect(0, 0, 1, 1);
  probeCanvas.fillStyle = css;
  probeCanvas.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probeCanvas.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`;
}
