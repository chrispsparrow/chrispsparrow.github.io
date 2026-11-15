// globe-view.js
// The 3D view: the flight drawn on Cesium's globe with real terrain and
// aerial imagery. For each rocket it draws:
//   - the breadcrumbs (rocket.crumbs, from track.js): one small dot per
//     received fix, solid in its speed color when the fix is good and a
//     hollow grey ring when it is weak, joined by a thin line through the
//     good fixes' smoothed positions. The line breaks wherever packets were
//     missed (gapBefore). Dots and line have a thin dark outline.
//   - a faint ground shadow: the same line laid flat on the terrain
//   - the board marker, with one thin white ring that grows out of it each
//     time a packet arrives
//   - the launch point
// and for the focused rocket a small white diamond at apogee, drogue, main
// and landing, a crosshair at the recovery position once it has landed,
// and the radio link: a faint dashed line to Manta (the ground station)
// with a small white dot that travels along it for each packet. The names
// next to the markers are drawn by map-labels.js, which map-view.js shares
// with this view.
//
// The same honesty rules as the map apply:
//   - The dots are the raw fixes. Only the line is smoothed (a moving
//     average of the last few good fixes, worked out in track.js).
//   - A gap in the packets is left as a break in the line, never bridged.
//   - The board marker sits on the newest good fix (or, while no fix has
//     passed the quality gate yet, hollow on the newest weak one). It
//     always stands upright, since no board sends orientation data.
//   - With no GPS fix right now (or a newer fix that failed the quality
//     gate) the marker turns hollow at its last good position.
//   - Event markers only appear once playback has reached the event.
//
// Heights. Cesium places things by height above the ellipsoid (a smooth
// model of the Earth), and GPS reports height above mean sea level. The two
// differ by tens of meters, and this file never converts between them.
// Instead it asks Cesium World Terrain for the ground height at the launch
// pad, and draws every point at that height plus the detector's height
// above ground for the point. So the pad sits on the terrain and the path
// rises from it by exactly the heights the HUD shows. If a pad's ground
// height can't be looked up, or the rocket has no pad, each point goes at
// its GPS altitude instead. If Cesium World Terrain doesn't load, the
// ground is flat and heights above ground are measured from it. Either way
// a note says the heights are approximate. A rocket isn't drawn until its
// launch pad and the ground height there are known, or liftoff has come
// with no pad.
//
// No ground station. A store made with no ground station (a board on the
// bench) has no dish and no radio link, so neither is drawn. Until there
// is a position to look at, the camera then waits far out, looking straight
// down at the whole Earth, sized to fit the view (see idleCamera).
//
// A new source. map-view.js keeps one 3D view for the whole visit on
// Track a Rocket and swaps the store behind it (store-switch.js). A store
// change of type 'source' means: forget everything drawn and every ground
// height looked up, then fly (never jump) to the new site. While a saved
// flight is still downloading (ctx.session.loading), the camera flies
// toward the flight's launch point from the library.
//
// Camera. Cesium's own mouse and touch controls are made for spinning a
// whole globe, and up close they turn far too fast. They are switched off,
// and this file has its own: drag to orbit around what the camera looks
// at, the wheel or a pinch to zoom, and the right button or two fingers to
// slide the view (see "Controls" near the end). FOLLOW BOARD moves the
// camera like an operator on the ground (see "Follow camera").
//
// Look. The view sits on the page with no frame: the space around the
// Earth is the page's near-black, there are no stars, sun or moon, and the
// glow of the atmosphere is darkened and pulled toward grey. Close to the
// ground the glow is off, so the sky is the page's near-black too and the
// horizon fades into the page.
//
// Rendering. The scene only redraws when something changes (Cesium's
// requestRenderMode), which saves battery. Every change here ends with
// scene.requestRender(). The packet ring and the traveling dot ask for
// frames only while they move (under a second after each packet).
//
// Used by: map-view.js, which loads Cesium first and owns the buttons.
// Reads the store, never other views.

import { createScheduler, prefersReducedMotion } from './dom.js?v=2';
import { distanceM } from '../geo.js?v=2';
import { speedColor } from '../track.js?v=2';
import { eventCrumb, recoveryInfo, flightState, STATE } from '../flight-state.js?v=2';
import {
  boardSvg, BOARD_FOCUSED, BOARD_OTHER, startSvg, START_SIZE, dishSvg, DISH_SIZE, DISH_ANCHOR,
  diamondSvg, DIAMOND_SIZE, crosshairSvg, CROSSHAIR_SIZE,
  DOT_PX, DOT_OUTLINE_PX, WEAK_DOT_PX, WEAK_LINE_PX, WEAK_COLOR, LINE_PX, LINE_OUTLINE_PX,
  OTHER_LINE_PX, OTHER_DOT_PX, SHADOW_PX, SHADOW_ALPHA, SHADOW_EDGE_PX, SHADOW_EDGE_ALPHA, OFF_WHITE, NEAR_BLACK, WHITE,
  RING_PX, RING_MS, RING_LINE_PX, RING_FROM_SCALE,
  LINK_SOLID, LINK_PX, LINK_DASH_PX, LINK_TRAVEL_MS, LINK_DOT_PX,
} from './markers.js?v=2';
import { LABEL_NAMES, LABEL_PRIORITY, apogeeLabel } from './map-labels.js?v=2';

// The events that get a diamond. Liftoff has none, since the launch point
// marks it.
const EVENT_TYPES = ['apogee', 'drogue', 'main', 'landed'];
// The line is built in chunks of at most this many points. A finished
// chunk is never built again, so a long flight only rebuilds its newest
// chunk when a fix comes in.
const CHUNK_POINTS = 100;
// The newest chunk's ground shadow is laid again at most this often (ms).
// Laying a line on the terrain costs more than drawing it in the air.
const SHADOW_TAIL_MS = 1000;
// After a seek, every shadow is laid again once the data has been still
// for this long (ms), so dragging the timeline stays smooth.
const SHADOW_SETTLE_MS = 300;
// A ground station whose GPS position wanders keeps the ground height it
// had while it stays within this far (m) of where that height was looked
// up. A real move (from the demo position to its own) waits for its own.
const STATION_KEEP_M = 100;
// The radio link ends this far (m) above the dish's foot, so it doesn't
// dip into the ground right at the dish.
const LINK_DISH_RISE_M = 3;
// With no ground station and nothing to look at, the camera looks straight
// down at this spot from far enough out to fit the whole Earth in the view
// (see idleCamera), leaving IDLE_MARGIN of the view's smaller side free.
const WAIT_FAR_LAT = 25;
const WAIT_FAR_LON = -40;
const IDLE_MARGIN = 0.1;
// How long (s) the camera takes to fly from far away to a site. A flight
// with more to cover (from one side of the Earth to the other, or up from
// one site and down onto another) takes a little longer, up to FLY_IN_MAX_S.
// Flights up to FLY_IN_PATH long take FLY_IN_S. (Lengths are in the units
// flightPath() measures, see "Flights" below. From the whole Earth down to
// the California site is about 7, down to Komodo about 12, and from one of
// those sites to the other about 12.)
const FLY_IN_S = 2.6;
const FLY_IN_MAX_S = 3.6;
const FLY_IN_PATH = 9;
// How much a flight rises on its way to a far site, so the ground slides
// by at a pace the eye can follow. 1.4 is the value van Wijk and Nuij
// found looks best. Lower values rise less. A flight never rises past the
// whole-Earth view, so for a far site this comes down until it fits.
const FLY_RISE = 1.4;
// Once the camera is this many times higher than at either end of the
// flight, it looks straight down.
const FLY_TOP_DOWN = 20;
// A flight whose goal changes on the way (a saved flight's data arrives
// while the camera is still flying to its launch point) bends onto the new
// goal over this long (ms). With less time than that left, the camera
// lands first and then glides to the new goal.
const FLY_RETARGET_MS = 700;
// A flight's clock moves on at most this much (ms) per frame. When the page
// is busy for a moment (a saved flight's data being drawn), the camera
// carries on from where it was instead of jumping ahead to catch up.
const FLY_MAX_STEP_MS = 50;
// Flying out to the whole Earth, the flight bends onto a new fit for the
// whole Earth (the HUD changed size) as long as this much (ms) is left.
const FLY_IDLE_REFIT_MS = 150;
// A new site closer than this (m) to where the camera looks gets a short
// glide instead of a flight.
const GLIDE_MAX_M = 30000;
// While a saved flight downloads, the camera flies toward its launch point
// from this far (m), looking down this steeply (degrees).
const LOADING_RANGE_M = 6000;
const LOADING_PITCH_DEG = -30;
// The lowest and highest ground (m) a launch point's rough height is
// believed at while the flight downloads (the Dead Sea shore to well above
// any launch site).
const GROUND_GUESS_M = [-450, 6000];
// WHOLE FLIGHT keeps this much room (px) between the flight and the edge
// of the part of the view nothing covers. It checks its fit by projecting
// the points to the screen, up to this many times.
const WHOLE_FIT_STEPS = 10;
// At most this many points are projected for that check (the rest are
// skipped evenly).
const WHOLE_FIT_SAMPLE = 600;
// The atmosphere's glow around the Earth, seen from far away, pulled
// toward a dark grey so it stays a thin, dim rim against the page's
// near-black. Each is a shift from -1 to 1. Below SKY_GLOW_MIN_M (m above
// the ground) the glow is off, so the sky over the ground is the page's
// own near-black and the horizon meets the page.
const SKY_SATURATION_SHIFT = -0.55;
const SKY_BRIGHTNESS_SHIFT = -0.7;
const SKY_HUE_SHIFT = 0;
const SKY_GLOW_MIN_M = 100000;
// The haze over the ground far away, darker and greyer, so distant ground
// fades toward the near-black.
const GROUND_HAZE_SATURATION_SHIFT = -0.35;
const GROUND_HAZE_BRIGHTNESS_SHIFT = -0.55;
// Close to the ground, the ground fades into the page's near-black toward
// the horizon. On screen the fade starts this share of the view's height
// below the horizon, and the ground is solid near-black from the second
// share on.
const HORIZON_FADE_FROM = 0.11;
const HORIZON_FADE_TO = 0.006;
// Far ground usually sits higher than sea level, so it shows closer to the
// horizon than that works out. The fade never starts or ends farther away
// than these shares of the distance to the horizon.
const HORIZON_FADE_FROM_MAX = 0.1;
const HORIZON_FADE_TO_MAX = 0.38;
// Labels fade out once one screen pixel covers more than this many meters
// where the camera looks (zoomed far out).
const LABEL_FAR_M_PER_PX = 60;
// FOLLOW BOARD works like a camera operator on the ground (see "Follow
// camera" below). It keeps the board, the launch point, Manta when it is
// close and the path so far inside the free part of the view, and pulls
// back as the board climbs. These are its settings.
// The closest it comes on its own (m). Zooming by hand still goes closer.
const FOLLOW_RANGE_MIN_M = 1500;
// The farthest it pulls back to keep the launch point and the whole path
// in view (m). Past that it keeps the board and its newest
// FOLLOW_TAIL_POINTS path points instead.
const FOLLOW_RANGE_MAX_M = 15000;
const FOLLOW_TAIL_POINTS = 20;
// The camera leads the board by one fix (where it will be if it keeps
// going), unless that step is longer than this (m), which no flight does
// between two fixes.
const FOLLOW_LEAD_MAX_M = 800;
// Manta is kept in view while it is this close (m) to the launch point.
const FOLLOW_STATION_M = 3000;
// At most this many path points are used to work out the framing.
const FOLLOW_SAMPLE = 120;
// The framing keeps the board this far (px) inside the free part, so it
// stays clear while the camera is still catching up with a new fix.
const FOLLOW_ROOM_PX = 40;
// Changes smaller than this (px on screen) are ignored, so a board that
// wanders a few meters on the pad doesn't make the camera creep.
const FOLLOW_STILL_PX = 18;
// How fast the camera catches up: it closes most of the gap in about this
// share of the time between fixes, never slower than FOLLOW_SMOOTH_MAX_S
// or faster than FOLLOW_SMOOTH_MIN_S (s).
const FOLLOW_SMOOTH_SHARE = 0.7;
const FOLLOW_SMOOTH_MAX_S = 0.8;
const FOLLOW_SMOOTH_MIN_S = 0.12;
// Ticking FOLLOW BOARD (by hand or at liftoff) brings the camera over in
// a glide this long (ms).
const FOLLOW_GLIDE_MS = 900;
// The free part of the view is measured again this often (ms) while the
// camera follows, since the HUD's blocks change size.
const FOLLOW_FREE_MS = 300;
// After landing the camera settles on the board from this far (m),
// looking down at least this steeply (degrees), so the recovery crosshair
// and the DOGTOOTH label stand out on the ground.
const RECOVERY_RANGE_M = 1500;
const RECOVERY_PITCH_DEG = -35;

export function createGlobeView(container, ctx, options) {
  const { Cesium: C, credits, dialogs, covers, freeInsets, labels, onScale, onReady, onChange, onFail, onFollowOff } = options;
  const { store, config } = ctx;
  // What is on screen (live or a replay, and the replay's pre-scan). Read
  // fresh every time, since main.js changes it while this view lives on.
  const session = () => ctx.session ?? {};
  const prescan = () => {
    const scan = session().prescan ?? ctx.prescan;
    return scan instanceof Map ? scan : new Map();
  };

  // ------------------------------------------------------------------
  // Colors. The page's near-black comes from the theme
  // (css/flight-console-theme.css), worked out by the browser and handed
  // to Cesium as plain rgba(). The markers' colors are in markers.js.
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
      // map-view.js stacks above the HUD floating over the view.
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
  // Terrain hides what is behind or under it (the radio link included).
  // The breadcrumbs and markers are never hidden (see ALWAYS and NO_DEPTH).
  scene.globe.depthTestAgainstTerrain = true;
  // The ground's color where there is no imagery: the theme's raised near-black.
  scene.globe.baseColor = rgba(color('--fc-black-raised', '#1E1D24'));
  // The page's near-black all around the Earth, with no stars, sun or moon.
  scene.backgroundColor = rgba(PAGE);
  if (scene.skyBox) scene.skyBox.show = false;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  // The atmosphere's glow (the ring around the Earth from far away),
  // darkened and greyed. Close to the ground it is off, so the sky is the
  // page's near-black and the view has no edge against the page.
  const sky = scene.skyAtmosphere;
  if (sky) {
    sky.hueShift = SKY_HUE_SHIFT;
    sky.saturationShift = SKY_SATURATION_SHIFT;
    sky.brightnessShift = SKY_BRIGHTNESS_SHIFT;
  }
  // Close to the ground the sky is the page's near-black, so the far edge
  // of the ground would end in a hard, straight line. Instead the ground
  // fades to near-black with distance, so it melts into the page at the
  // horizon, far mountains included. The distances are worked out before
  // every frame from where they show on screen (HORIZON_FADE_FROM and
  // _TO). It is a material on the ground only, so the markers and the path
  // stay as they are. Far out, with the glow on, there is no fade.
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
      const lookValue = high ? fogLook : 0;
      if (fog.visualDensityScalar !== lookValue) fog.visualDensityScalar = lookValue;
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
    const hgt = Math.max(1, camera.positionCartographic.height);
    const pxPerRadian = (viewH / 2) / Math.tan(fovy / 2);
    const distanceAt = (px) => {
      const k = Math.sqrt(2 * hgt / R) + px / pxPerRadian;
      return R * k - Math.sqrt(Math.max(0, (R * k) ** 2 - 2 * R * hgt));
    };
    const horizon = Math.sqrt(2 * R * hgt + hgt * hgt);
    horizonFade.uniforms.fadeFrom = Math.min(distanceAt(viewH * HORIZON_FADE_FROM), horizon * HORIZON_FADE_FROM_MAX);
    horizonFade.uniforms.fadeTo = Math.min(distanceAt(viewH * HORIZON_FADE_TO), horizon * HORIZON_FADE_TO_MAX);
  }
  const stopPreRender = scene.preRender.addEventListener(() => {
    const high = camera.positionCartographic.height > SKY_GLOW_MIN_M;
    if (sky && sky.show !== high) sky.show = high;
    updateHorizonFade(high);
    hideBehindEarth();
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
  // What is drawn, in drawing order. Whatever is added later is drawn on
  // top. The ground shadows are ground primitives, laid on the terrain.
  // ------------------------------------------------------------------
  // The breadcrumb lines are drawn without the depth test, like the
  // markers, so terrain never cuts them and the dark outline (drawn first)
  // always sits under the colored line (drawn after it).
  const NO_DEPTH = { depthTest: { enabled: false }, depthMask: false };
  const blend = { blendOption: C.BlendOption.TRANSLUCENT };
  const linkLines = scene.primitives.add(new C.PrimitiveCollection());    // the radio link
  const haloLayer = scene.primitives.add(new C.PrimitiveCollection());    // the lines' dark outlines
  const lineLayer = scene.primitives.add(new C.PrimitiveCollection());    // the lines in their speed colors
  const dotLayer = scene.primitives.add(new C.PrimitiveCollection());     // two billboard collections per rocket: dot edges, then dot fills
  const groundIcons = scene.primitives.add(new C.BillboardCollection(blend)); // launch points and Manta's dish
  const eventIcons = scene.primitives.add(new C.BillboardCollection({ ...blend, scene })); // diamonds and the recovery crosshair
  const ringIcons = scene.primitives.add(new C.BillboardCollection(blend)); // the packet rings, under the boards
  const travelDots = scene.primitives.add(new C.PointPrimitiveCollection()); // the dot on the radio link
  const rocketIcons = scene.primitives.add(new C.BillboardCollection(blend));
  const focusIcons = scene.primitives.add(new C.BillboardCollection(blend));  // the focused board, on top
  // Everything above but the shadows, so it can all be hidden at once when
  // the site is on the far side of the Earth (see hideBehindEarth).
  const siteLayers = [linkLines, haloLayer, lineLayer, dotLayer, groundIcons, eventIcons, ringIcons, travelDots, rocketIcons, focusIcons];

  // Markers keep one size on screen at any distance, always stand upright
  // (a billboard faces the screen and never turns), and are never hidden
  // behind terrain.
  const ALWAYS = { disableDepthTestDistance: Number.POSITIVE_INFINITY };

  // The ground shadow needs Cesium's ground lines, which need a little
  // setup first and a graphics card that can do them. Until then, or
  // without them, there is no shadow.
  let shadowsReady = false;
  if (C.GroundPolylinePrimitive.isSupported(scene)) {
    C.GroundPolylinePrimitive.initializeTerrainHeights().then(() => {
      if (destroyed) return;
      shadowsReady = true;
      for (const parts of drawn.values()) markShadows(parts);
      scheduler.schedule();
    }, (err) => console.warn('Flight Console: the ground shadow could not start', err));
  }

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

  // The packet ring at its full size: a thin white circle with a faint
  // dark edge on each side. On screen it grows and fades (see "Packet
  // ring and radio dot").
  function ringIcon(id, size) {
    const canvas = document.createElement('canvas');
    canvas.width = size * iconScale;
    canvas.height = size * iconScale;
    const g = canvas.getContext('2d');
    g.scale(iconScale, iconScale);
    const c = size / 2;
    g.beginPath();
    g.arc(c, c, c - RING_LINE_PX / 2 - 1.5, 0, Math.PI * 2);
    g.lineWidth = RING_LINE_PX + 2.5;
    g.strokeStyle = rgba(NEAR_BLACK, 0.45).toCssColorString();
    g.stroke();
    g.lineWidth = RING_LINE_PX;
    g.strokeStyle = WHITE;
    g.stroke();
    icons.set(id, { canvas, width: size, height: size });
  }

  // The breadcrumb dots, in two parts drawn in two passes (see addCrumbs):
  //   - the fill: a white disc, tinted to its speed color when drawn (dot,
  //     and dot-other for other rockets), or a grey ring for a weak fix
  //     (dot-weak)
  //   - the edge: the same shape in near-black, a little bigger, with a
  //     hard edge (no soft pixels), so it can be drawn in the opaque pass
  //     (dot-edge, dot-other-edge, dot-weak-edge)
  const EDGE_GROWTH_PX = 1 / iconScale;
  function dotIcons() {
    const make = (id, diameter, paint, { hard = false } = {}) => {
      const size = Math.ceil(diameter + 2 * DOT_OUTLINE_PX + 2);
      const canvas = document.createElement('canvas');
      canvas.width = size * iconScale;
      canvas.height = size * iconScale;
      const g = canvas.getContext('2d');
      g.scale(iconScale, iconScale);
      g.beginPath();
      g.arc(size / 2, size / 2, diameter / 2, 0, Math.PI * 2);
      paint(g);
      if (hard) {
        // Every pixel fully on or fully off.
        const img = g.getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 3; i < img.data.length; i += 4) img.data[i] = img.data[i] >= 128 ? 255 : 0;
        g.putImageData(img, 0, 0);
      }
      icons.set(id, { canvas, width: size, height: size });
    };
    const fill = (color) => (g) => {
      g.fillStyle = color;
      g.fill();
    };
    const ring = (color, width) => (g) => {
      g.lineWidth = width;
      g.strokeStyle = color;
      g.stroke();
    };
    make('dot', DOT_PX, fill(WHITE));
    make('dot-other', OTHER_DOT_PX, fill(WHITE));
    make('dot-weak', WEAK_DOT_PX, ring(WEAK_COLOR, WEAK_LINE_PX));
    // (The opaque pass draws every pixel the image touches at all, which
    // makes a shape about EDGE_GROWTH_PX wider, so the edges are drawn
    // that much smaller to end up DOT_OUTLINE_PX wide.)
    const edge = 2 * DOT_OUTLINE_PX - EDGE_GROWTH_PX;
    make('dot-edge', DOT_PX + edge, fill(NEAR_BLACK), { hard: true });
    make('dot-other-edge', OTHER_DOT_PX + edge, fill(NEAR_BLACK), { hard: true });
    make('dot-weak-edge', WEAK_DOT_PX, ring(NEAR_BLACK, WEAK_LINE_PX + edge), { hard: true });
  }

  const iconsReady = Promise.all([
    svgIcon('board-focus', boardSvg(BOARD_FOCUSED), BOARD_FOCUSED),
    svgIcon('board-focus-hollow', boardSvg(BOARD_FOCUSED, { hollow: true }), BOARD_FOCUSED),
    svgIcon('board', boardSvg(BOARD_OTHER), BOARD_OTHER),
    svgIcon('board-hollow', boardSvg(BOARD_OTHER, { hollow: true }), BOARD_OTHER),
    svgIcon('start', startSvg(), [START_SIZE, START_SIZE]),
    anchoredIcon('dish', dishSvg(), DISH_SIZE, DISH_ANCHOR),
    svgIcon('diamond', diamondSvg(), [DIAMOND_SIZE, DIAMOND_SIZE]),
    svgIcon('crosshair', crosshairSvg(), [CROSSHAIR_SIZE, CROSSHAIR_SIZE]),
  ]).then(() => {
    ringIcon('ring', RING_PX);
    dotIcons();
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

  function addIcon(collection, id, position, extra = {}) {
    const icon = icons.get(id);
    const billboard = collection.add({ position, image: icon.canvas, imageId: id, width: icon.width, height: icon.height, ...ALWAYS, ...extra });
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
  // station), kept until the source changes, seeks included.
  // ------------------------------------------------------------------
  let terrain = null;
  let spots = []; // { lat, lon, state: 'pending' | 'ok' | 'failed', height }

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
      else if (view.terrain === 'failed') spot.state = 'failed';
    }
    return spot;
  }

  function lookUp(spot) {
    spot.state = 'pending';
    const list = spots;
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
      // A lookup from before a source change belongs to nobody now.
      if (!destroyed && list === spots) refresh();
    });
  }

  // How a rocket's points get their heights right now:
  //   { kind: 'wait' }            not known yet, so nothing is drawn
  //   { kind: 'ground', base }    the pad's ground height plus height above ground
  //   { kind: 'gps' }             approximate: each point's own GPS altitude
  // approx marks heights the map's notes own up to.
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
    const first = rocket.crumbs?.[0];
    if (first) groundAt(first.lat, first.lon);
    return { kind: 'wait' };
  }

  // Height above ground of one point (a crumb, or a crumb's smoothed line
  // position with the crumb's time), the way the detector measures it: the
  // altitude it used at that moment minus its ground level. null if the
  // detector had no altitude then.
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
  // so the path comes out the same whether it grew point by point or was
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

  // A point's place in 3D, or null when it has no height.
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
  const haloColor = rgba(NEAR_BLACK);
  const shadowColor = rgba(NEAR_BLACK, SHADOW_ALPHA);
  const shadowEdgeColor = rgba(OFF_WHITE, SHADOW_EDGE_ALPHA);
  const clearColor = new C.Color(0, 0, 0, 0);
  const colorCache = new Map(); // css -> C.Color
  const cesiumColor = (css) => {
    let c = colorCache.get(css);
    if (!c) {
      c = rgba(css);
      colorCache.set(css, c);
    }
    return c;
  };

  function partsFor(rocket) {
    let parts = drawn.get(rocket.id);
    if (!parts) {
      parts = {
        crumbs: null,     // the crumbs array the drawing was worked out from
        key: '',          // the height model, ground level and focus it was worked out with
        count: 0,         // crumbs looked at so far
        dotAt: [],        // one 3D position per crumb (null: not drawn)
        dots: null,       // the billboards with each drawn crumb's dot (its fill)
        edges: null,      // the billboards with each dot's dark edge, drawn first
        verts: [],        // the line's points: { position, color, breakBefore }
        chunks: [],       // the line's pieces: { start, end, final, halo, line, shadow, shadowEdge, shadowAt }
        lastGood: -1,     // index of the newest good crumb that has a position
        focused: null,
        icon: null, iconHome: null, ring: null, ringStart: null,
        pad: null, padAt: null,
        ground: null,     // the last ground height looked up for this rocket's pad
        lastPacketT: null, // the newest packet time seen, to spot new packets
        approx: false, waiting: false,
      };
      drawn.set(rocket.id, parts);
    }
    return parts;
  }

  // Removes the breadcrumbs (the dots, the line and its shadow).
  function clearCrumbs(parts) {
    for (const chunk of parts.chunks) removeChunk(chunk);
    parts.chunks = [];
    parts.verts = [];
    parts.dotAt = [];
    parts.lineBroken = false;
    if (parts.dots) dotLayer.remove(parts.dots);
    if (parts.edges) dotLayer.remove(parts.edges);
    parts.dots = null;
    parts.edges = null;
    parts.count = 0;
    parts.lastGood = -1;
  }

  function removeRocket(parts) {
    clearCrumbs(parts);
    if (parts.icon) parts.iconHome.remove(parts.icon);
    if (parts.ring) ringIcons.remove(parts.ring);
    if (parts.pad) groundIcons.remove(parts.pad);
    parts.icon = null;
    parts.ring = null;
    parts.ringStart = null;
    parts.pad = null;
    parts.padAt = null;
  }

  function drawRocket(rocket, isFocused) {
    const parts = partsFor(rocket);
    const model = heightModel(rocket, parts);
    const ground = rocket.derived?.groundRef;
    const crumbs = rocket.crumbs ?? [];
    // Anything that changes where points go, or how they look, means
    // working everything out again: a seek (the store hands out a new
    // crumbs list), a different height model, a ground level that moved
    // (it settles while the rocket sits on the pad and is frozen at
    // liftoff), or a new focus.
    const key = [model.kind, model.base ?? '', model.kind === 'ground' && Number.isFinite(ground) ? ground : '', isFocused].join('|');
    if (parts.crumbs !== crumbs || parts.key !== key || parts.count > crumbs.length) {
      if (parts.focused !== null && parts.focused !== isFocused) removeRocket(parts);
      else clearCrumbs(parts);
      parts.crumbs = crumbs;
      parts.key = key;
      // A whole new set of points: the shadows wait until things settle.
      parts.shadowWait = performance.now() + SHADOW_SETTLE_MS;
    }
    parts.focused = isFocused;
    parts.approx = model.kind !== 'wait' && model.approx;
    parts.waiting = model.kind === 'wait' && crumbs.some((c) => c.quality === 'good');

    if (model.kind !== 'wait') addCrumbs(rocket, parts, model, isFocused);
    syncLine(parts);
    syncShadows(parts);
    drawPad(rocket, parts, model);
    drawRocketIcon(rocket, parts, isFocused);
  }

  // One breadcrumb dot. The dots are billboards like the markers, so they
  // stack in drawing order with them (the board always sits on top of its
  // own dots). Each one shows a small canvas image (see dotIcons), tinted
  // by color when it has one, over its dark edge in the other collection.
  function addDot(parts, id, position, tint) {
    for (const [collection, image] of [[parts.edges, `${id}-edge`], [parts.dots, id]]) {
      const icon = icons.get(image);
      collection.add({ position, image: icon.canvas, imageId: image, width: icon.width, height: icon.height, color: image === id ? tint ?? undefined : undefined, ...ALWAYS });
    }
  }

  // The dots and the line's points for the crumbs since the last draw.
  // Dots use the raw fix. The line uses the smoothed position and only
  // takes good fixes. A crumb with no height breaks the line.
  function addCrumbs(rocket, parts, model, isFocused) {
    const crumbs = parts.crumbs;
    if (parts.count >= crumbs.length) return;
    // Two passes, so a run of dots that overlap on screen (a slow descent,
    // or the view zoomed out) reads as its speed colors with one thin dark
    // edge around the run, not as a dark band of outlines over fills. The
    // edges are opaque, so Cesium draws all of them before anything
    // see-through, and the fills (see-through at their soft rims) are
    // drawn after every edge. Dots far enough apart each keep their own
    // dark ring.
    if (!parts.dots) {
      parts.edges = dotLayer.add(new C.BillboardCollection({ blendOption: C.BlendOption.OPAQUE }));
      parts.dots = dotLayer.add(new C.BillboardCollection(blend));
    }
    const otherColor = cesiumColor(rocket.profile?.color ?? WHITE);
    const dotId = isFocused ? 'dot' : 'dot-other';
    // True when the next line point must start a new piece: the first
    // point, the one after a good fix with no height, and the first good
    // fix after missed packets. (gapBefore sits on the crumb right after
    // the gap, which can be a weak fix or an outlier the line skips, so it
    // is carried to the next good one.)
    let lineBroken = parts.verts.length === 0 || parts.lineBroken;
    for (let i = parts.count; i < crumbs.length; i++) {
      const c = crumbs[i];
      if (c.gapBefore) lineBroken = true;
      if (c.quality === 'outlier') {
        parts.dotAt.push(null);
        continue;
      }
      const position = pointPosition(rocket, model, c);
      parts.dotAt.push(position);
      if (c.quality === 'good') {
        if (position) {
          // The white dot image, tinted to the speed color, over its dark
          // edge (see addDot).
          addDot(parts, dotId, position, isFocused ? cesiumColor(speedColor(c.speedMps)) : otherColor);
          parts.lastGood = i;
        }
        const linePos = c.line ? pointPosition(rocket, model, { t: c.t, lat: c.line.lat, lon: c.line.lon, altMsl: c.line.altMsl }) : null;
        if (linePos) {
          parts.verts.push({
            position: linePos,
            color: isFocused ? cesiumColor(speedColor(c.speedMps)) : otherColor,
            breakBefore: lineBroken,
          });
          lineBroken = false;
        } else {
          lineBroken = true;
        }
      } else if (position) {
        // A weak fix: a hollow grey ring.
        addDot(parts, 'dot-weak', position, null);
      }
    }
    // Kept for the next draw, so a break at the end of this batch isn't
    // bridged by the first point of the next one.
    parts.lineBroken = lineBroken;
    parts.count = crumbs.length;
  }

  // The line, in chunks of at most CHUNK_POINTS points. A chunk ends where
  // the line breaks, or when it is full (the next one then starts on its
  // last point, so the two join). Only chunks that got new points are
  // built again.
  function syncLine(parts) {
    const verts = parts.verts;
    let chunk = parts.chunks[parts.chunks.length - 1] ?? null;
    let i = chunk ? chunk.end : 0;
    const dirty = new Set();
    for (; i < verts.length; i++) {
      const v = verts[i];
      if (!chunk || chunk.final || v.breakBefore) {
        if (chunk && !chunk.final) {
          chunk.final = true;
          dirty.add(chunk);
        }
        const start = !chunk || v.breakBefore ? i : i - 1;
        chunk = { start, end: i + 1, final: false, halo: null, line: null, shadow: null, shadowEdge: null, shadowAt: 0 };
        parts.chunks.push(chunk);
      } else {
        chunk.end = i + 1;
        if (chunk.end - chunk.start >= CHUNK_POINTS) chunk.final = true;
      }
      dirty.add(chunk);
    }
    for (const c of dirty) buildChunk(parts, c);
  }

  // The positions and colors of one chunk, with points that sit on top of
  // the one before left out (Cesium can't draw a line of zero length).
  function chunkPoints(parts, chunk) {
    const positions = [];
    const colors = [];
    for (let i = chunk.start; i < chunk.end; i++) {
      const v = parts.verts[i];
      const last = positions[positions.length - 1];
      if (last && C.Cartesian3.distanceSquared(last, v.position) < 0.01) continue;
      positions.push(v.position);
      colors.push(v.color);
    }
    return { positions, colors };
  }

  function buildChunk(parts, chunk) {
    removeChunk(chunk, { keepShadow: true });
    const { positions, colors } = chunkPoints(parts, chunk);
    if (positions.length < 2) return;
    const width = parts.focused ? LINE_PX : OTHER_LINE_PX;
    chunk.halo = haloLayer.add(linePrimitive(positions, positions.map(() => haloColor), width + 2 * LINE_OUTLINE_PX));
    chunk.line = lineLayer.add(linePrimitive(positions, colors, width));
    chunk.shadowDirty = true;
  }

  function linePrimitive(positions, colors, width) {
    return new C.Primitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.PolylineGeometry({ positions, colors, colorsPerVertex: true, width, arcType: C.ArcType.NONE }),
      }),
      appearance: new C.PolylineColorAppearance({ translucent: false, renderState: NO_DEPTH }),
      asynchronous: false,
    });
  }

  function removeChunk(chunk, { keepShadow = false } = {}) {
    if (chunk.halo) haloLayer.remove(chunk.halo);
    if (chunk.line) lineLayer.remove(chunk.line);
    chunk.halo = null;
    chunk.line = null;
    if (!keepShadow) removeShadow(chunk);
  }

  function removeShadow(chunk) {
    if (chunk.shadow) scene.groundPrimitives.remove(chunk.shadow);
    if (chunk.shadowEdge) scene.groundPrimitives.remove(chunk.shadowEdge);
    chunk.shadow = null;
    chunk.shadowEdge = null;
  }

  // The ground shadow: each chunk's line laid flat on the terrain, as a
  // faint light band with the dark shadow on top. A finished chunk is
  // laid once. The newest one is laid again at most
  // every SHADOW_TAIL_MS, and none is laid while a seek is still settling.
  function syncShadows(parts) {
    if (!shadowsReady) return;
    const now = performance.now();
    if (now < (parts.shadowWait ?? 0)) {
      later(parts.shadowWait - now + 20);
      return;
    }
    for (const chunk of parts.chunks) {
      if (!chunk.shadowDirty) continue;
      if (!chunk.final && now - chunk.shadowAt < SHADOW_TAIL_MS) {
        later(SHADOW_TAIL_MS - (now - chunk.shadowAt) + 20);
        continue;
      }
      chunk.shadowDirty = false;
      chunk.shadowAt = now;
      removeShadow(chunk);
      const { positions } = chunkPoints(parts, chunk);
      if (positions.length < 2) continue;
      const lay = (width, colorOf) => scene.groundPrimitives.add(new C.GroundPolylinePrimitive({
        geometryInstances: new C.GeometryInstance({
          geometry: new C.GroundPolylineGeometry({ positions, width }),
          attributes: { color: C.ColorGeometryInstanceAttribute.fromColor(colorOf) },
        }),
        appearance: new C.PolylineColorAppearance(),
        asynchronous: false,
      }));
      try {
        chunk.shadowEdge = lay(SHADOW_EDGE_PX, shadowEdgeColor);
        chunk.shadow = lay(SHADOW_PX, shadowColor);
        chunk.shadowEdge.show = chunk.shadow.show = !siteHidden;
      } catch (err) {
        // A shadow that can't be laid is left out. The path itself is fine.
        console.warn('Flight Console: a ground shadow could not be drawn', err);
      }
    }
  }

  function markShadows(parts) {
    for (const chunk of parts.chunks) chunk.shadowDirty = true;
  }

  // Asks for one more draw after ms (for the shadows' waits).
  let laterTimer = 0;
  function later(ms) {
    if (laterTimer) return;
    laterTimer = setTimeout(() => {
      laterTimer = 0;
      scheduler.schedule();
    }, Math.max(0, ms));
  }

  // The board marker at the newest good fix that has a position: the
  // board's blue while the fix is good right now, hollow when there is no
  // fix now or a newer fix failed the quality gate or has no height. A
  // board that has only sent weak fixes so far (too few satellites, as on
  // a bench indoors) still shows, hollow, at its newest weak fix, so its
  // label and radio link show too. It is a billboard with no rotation and
  // no scaling, so it always stands upright and keeps one size on screen.
  function drawRocketIcon(rocket, parts, isFocused) {
    let at = parts.lastGood;
    if (at < 0) {
      for (let i = parts.dotAt.length - 1; i >= 0; i--) {
        if (parts.dotAt[i]) { at = i; break; }
      }
    }
    const position = at >= 0 ? parts.dotAt[at] : null;
    if (!position) {
      if (parts.icon) parts.icon.show = false;
      if (parts.ring) parts.ring.show = false;
      return;
    }
    const newest = at === parts.crumbs.length - 1;
    const live = store.hasFixNow(rocket) && newest && at === parts.lastGood;
    const id = `board${isFocused ? '-focus' : ''}${live ? '' : '-hollow'}`;
    if (!parts.icon) {
      parts.iconHome = isFocused ? focusIcons : rocketIcons;
      parts.icon = addIcon(parts.iconHome, id, position);
      parts.ring = addIcon(ringIcons, 'ring', position, { show: false });
    }
    parts.icon.show = true;
    parts.icon.position = position;
    parts.ring.position = position;
    setIcon(parts.icon, id);
  }

  // The launch point: the last good position before liftoff, as a small
  // dot on the ground height looked up for it.
  function drawPad(rocket, parts, model) {
    const pad = rocket.padPosition;
    const height = !pad || model.kind === 'wait' ? null : model.kind === 'ground' ? model.base : pad.altMsl;
    if (!Number.isFinite(height)) {
      if (parts.pad) parts.pad.show = false;
      parts.padAt = null;
      return;
    }
    const position = C.Cartesian3.fromDegrees(pad.lon, pad.lat, height);
    if (!parts.pad) parts.pad = addIcon(groundIcons, 'start', position);
    parts.pad.show = true;
    parts.pad.position = position;
    parts.padAt = position;
  }

  // ------------------------------------------------------------------
  // Drawing: Manta (the ground station) and the radio link to the focused
  // board
  // ------------------------------------------------------------------
  const station = { icon: null, position: null, ground: null, groundSpot: null, approx: false };
  // The radio link's two ends ([board, Manta]) while it shows, else null.
  // It is drawn without the depth test, like the path, so the ground
  // between a landed board and Manta never hides it, and solid
  // (LINK_SOLID in markers.js), so it is drawn before the markers and the
  // board stays on top of it. It is built again only when an end moves.
  let linkEnds = null;
  let linkPrim = null;

  function setLink(from, to) {
    const same = linkEnds && from && to && C.Cartesian3.equals(linkEnds[0], from) && C.Cartesian3.equals(linkEnds[1], to);
    if (same || (!linkEnds && !(from && to))) return;
    if (linkPrim) linkLines.remove(linkPrim);
    linkPrim = null;
    linkEnds = from && to ? [C.Cartesian3.clone(from), C.Cartesian3.clone(to)] : null;
    if (!linkEnds || C.Cartesian3.distanceSquared(from, to) < 1) return;
    // Cesium's dash material skips the see-through gaps itself, so it can
    // be drawn as solid (in the opaque pass, before the markers).
    const material = C.Material.fromType('PolylineDash', {
      color: rgba(LINK_SOLID),
      gapColor: clearColor,
      dashLength: LINK_DASH_PX[0] + LINK_DASH_PX[1],
    });
    material.translucent = false;
    linkPrim = linkLines.add(new C.Primitive({
      geometryInstances: new C.GeometryInstance({
        geometry: new C.PolylineGeometry({ positions: linkEnds, width: LINK_PX, arcType: C.ArcType.NONE, vertexFormat: C.PolylineMaterialAppearance.VERTEX_FORMAT }),
      }),
      appearance: new C.PolylineMaterialAppearance({
        material,
        translucent: false,
        renderState: NO_DEPTH,
      }),
      asynchronous: false,
    }));
  }

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
      station.linkEnd = null;
      if (station.icon) station.icon.show = false;
      return;
    }
    // The dish. While the ground station is the demo placeholder, the KEY
    // says so.
    const position = C.Cartesian3.fromDegrees(gs.lon, gs.lat, height);
    station.position = position;
    station.linkEnd = C.Cartesian3.fromDegrees(gs.lon, gs.lat, height + LINK_DISH_RISE_M);
    if (!station.icon) station.icon = addIcon(groundIcons, 'dish', position);
    station.icon.show = true;
    station.icon.position = position;
  }

  // The radio link: a faint dashed line from the focused board to Manta.
  function drawLink(focused) {
    const parts = focused ? drawn.get(focused.id) : null;
    const from = parts?.icon?.show ? parts.icon.position : null;
    setLink(from, station.linkEnd);
  }

  // ------------------------------------------------------------------
  // Drawing: the focused rocket's event diamonds and its recovery
  // crosshair
  // ------------------------------------------------------------------
  let marks = [];     // { icon, type, aglM, position }
  let marksKey = '';
  let cross = null;   // the recovery crosshair billboard

  function drawEvents(focused) {
    const parts = focused ? drawn.get(focused.id) : null;
    const model = parts && !parts.waiting ? heightModel(focused, parts) : null;
    const events = focused && model && model.kind !== 'wait'
      ? EVENT_TYPES.map((type) => focused.events.find((e) => e.type === type)).filter(Boolean)
      : [];
    // Rebuilt when the events change, the positions under them were worked
    // out again (parts.key), or a closer fix came in after an event.
    const spotsList = events.map((e) => {
      const c = eventCrumb(focused, e);
      return c ? { e, c } : null;
    }).filter(Boolean);
    const key = `${focused?.id ?? ''}|${parts?.key ?? ''}|${spotsList.map(({ e, c }) => `${e.type}@${c.t}`).join(',')}|${parts?.crumbs === focused?.crumbs}`;
    if (key !== marksKey) {
      marksKey = key;
      for (const m of marks) eventIcons.remove(m.icon);
      marks = [];
      for (const { e, c } of spotsList) {
        const position = pointPosition(focused, model, c);
        if (!position) continue;
        marks.push({ icon: addIcon(eventIcons, 'diamond', position), type: e.type, aglM: e.aglM, position });
      }
    }
    // The recovery position: the average of the fixes after landing, on
    // the ground.
    const info = focused ? recoveryInfo(store, focused) : null;
    const where = info?.position;
    if (!where) {
      if (cross) cross.show = false;
      return;
    }
    const position = C.Cartesian3.fromDegrees(where.lon, where.lat, 0);
    if (!cross) cross = addIcon(eventIcons, 'crosshair', position, { heightReference: C.HeightReference.CLAMP_TO_GROUND });
    cross.show = true;
    cross.position = position;
  }

  // ------------------------------------------------------------------
  // Packet ring and radio dot. Each time a packet arrives for a board,
  // one thin white ring grows out of its marker and fades, and (for the
  // focused board, when there is a ground station) a small white dot runs
  // along the radio link from the board to Manta. A packet that comes
  // while they are still moving starts nothing new. While something
  // moves, a loop asks for one frame per screen refresh, and it stops as
  // soon as everything has finished. Viewers who ask for less motion get
  // neither.
  // ------------------------------------------------------------------
  const travel = travelDots.add({
    show: false,
    position: C.Cartesian3.ZERO,
    pixelSize: LINK_DOT_PX,
    color: rgba(WHITE),
    outlineColor: haloColor,
    outlineWidth: 1,
    ...ALWAYS,
  });
  let travelRun = null; // { from, to, start }
  let animFrame = 0;
  const ringColor = new C.Color(1, 1, 1, 1);

  // Packets that came in while this view watched (for the tests).
  let packetsSeen = 0;

  // A packet for this rocket arrived: start its ring and the radio dot.
  function packetArrived(rocket, parts, isFocused) {
    packetsSeen += 1;
    if (prefersReducedMotion() || !active) return;
    const now = performance.now();
    if (parts.ring && parts.icon?.show && (parts.ringStart === null || now - parts.ringStart >= RING_MS)) {
      parts.ringStart = now;
    }
    if (isFocused && linkEnds && (!travelRun || now - travelRun.start >= LINK_TRAVEL_MS)) {
      const [from, to] = linkEnds;
      travelRun = { from: C.Cartesian3.clone(from), to: C.Cartesian3.clone(to), start: now };
    }
    if (!animFrame) animFrame = window.requestAnimationFrame(animate);
  }

  function animate(now) {
    animFrame = 0;
    if (destroyed) return;
    let moving = false;
    for (const parts of drawn.values()) {
      if (!parts.ring || parts.ringStart === null) continue;
      const u = (now - parts.ringStart) / RING_MS;
      if (u >= 1 || !parts.icon?.show) {
        parts.ring.show = false;
        parts.ringStart = null;
        continue;
      }
      // Fast at first and slow at the end.
      const eased = 1 - (1 - Math.max(0, u)) ** 2.4;
      parts.ring.show = true;
      parts.ring.scale = RING_FROM_SCALE + (1 - RING_FROM_SCALE) * eased;
      ringColor.alpha = 1 - eased;
      parts.ring.color = ringColor;
      moving = true;
    }
    if (travelRun) {
      const u = (now - travelRun.start) / LINK_TRAVEL_MS;
      if (u >= 1 || !linkEnds) {
        travel.show = false;
        travelRun = null;
      } else {
        travel.show = true;
        travel.position = C.Cartesian3.lerp(travelRun.from, travelRun.to, Math.max(0, u), new C.Cartesian3());
        moving = true;
      }
    }
    scene.requestRender();
    if (moving) animFrame = window.requestAnimationFrame(animate);
  }

  function stopAnimations() {
    window.cancelAnimationFrame(animFrame);
    animFrame = 0;
    for (const parts of drawn.values()) {
      if (parts.ring) parts.ring.show = false;
      parts.ringStart = null;
    }
    travel.show = false;
    travelRun = null;
  }

  // ------------------------------------------------------------------
  // Labels: "DOGTOOTH", "MANTA", "LAUNCH POINT" and "APOGEE 3,012 M", drawn
  // by the label layer map-view.js shares. Their screen spots are worked
  // out after every frame, so they follow the camera.
  // ------------------------------------------------------------------
  const scratch2 = new C.Cartesian2();
  function screenOf(position) {
    if (!position) return null;
    const occluder = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, camera.positionWC);
    if (!occluder.isPointVisible(position)) return null;
    const p = scene.cartesianToCanvasCoordinates(position, scratch2);
    return p ? { x: p.x, y: p.y } : null;
  }

  // Meters one screen pixel covers where the camera looks.
  function metersPerPx() {
    const height = scene.canvas.clientHeight;
    const dist = C.Cartesian3.distance(camera.positionWC, look.pivot);
    return height > 0 ? (2 * dist * Math.tan(camera.frustum.fovy / 2)) / height : null;
  }

  function updateLabels() {
    if (!labels || !active) return;
    if (siteHidden || !assetsReady) {
      labels.update([]);
      return;
    }
    const items = [];
    const focused = store.getFocused();
    const parts = focused ? drawn.get(focused.id) : null;
    if (parts?.icon?.show) {
      const p = screenOf(parts.icon.position);
      if (p) items.push({ id: 'board', text: LABEL_NAMES.board, x: p.x, y: p.y, r: BOARD_FOCUSED[1] / 2 + 2, priority: LABEL_PRIORITY.board });
    }
    if (station.icon?.show) {
      const p = screenOf(station.position);
      // The dish stands above its foot, so the label points at its bowl.
      if (p) items.push({ id: 'station', text: LABEL_NAMES.station, x: p.x, y: p.y - DISH_ANCHOR[1] / 2, r: DISH_SIZE[0] / 2, priority: LABEL_PRIORITY.station });
    }
    if (parts?.pad?.show) {
      const p = screenOf(parts.padAt);
      if (p) items.push({ id: 'pad', text: LABEL_NAMES.pad, x: p.x, y: p.y, r: START_SIZE / 2, priority: LABEL_PRIORITY.pad });
    }
    const apogee = marks.find((m) => m.type === 'apogee');
    if (apogee) {
      const p = screenOf(apogee.position);
      if (p) items.push({ id: 'apogee', text: apogeeLabel(apogee.aglM), x: p.x, y: p.y, r: DIAMOND_SIZE / 2, priority: LABEL_PRIORITY.apogee });
    }
    const mpp = metersPerPx();
    labels.update(items, { far: !(mpp < LABEL_FAR_M_PER_PX), avoid: covers() });
  }

  // When the site is on the far side of the Earth (a far view, or a flight
  // to another site), the breadcrumbs and markers would show through the
  // globe, since terrain never hides them. So they are hidden then.
  let siteHidden = false;
  function hideBehindEarth() {
    const focused = store.getFocused();
    const parts = focused ? drawn.get(focused.id) : null;
    const anchor = parts?.icon?.show ? parts.icon.position : parts?.padAt ?? station.position;
    let hidden = false;
    if (anchor) {
      const occluder = new C.EllipsoidalOccluder(C.Ellipsoid.WGS84, camera.positionWC);
      hidden = !occluder.isPointVisible(anchor);
    }
    if (hidden === siteHidden) return;
    siteHidden = hidden;
    for (const layer of siteLayers) layer.show = !hidden;
    for (const parts2 of drawn.values()) {
      for (const chunk of parts2.chunks) {
        if (chunk.shadow) chunk.shadow.show = !hidden;
        if (chunk.shadowEdge) chunk.shadowEdge.show = !hidden;
      }
    }
  }

  const stopPostRender = scene.postRender.addEventListener(() => {
    updateLabels();
    const mpp = metersPerPx();
    onScale?.(Number.isFinite(mpp) ? mpp : null);
  });

  // ------------------------------------------------------------------
  // Camera. It always looks at one point (the pivot) from a heading, a
  // pitch and a distance. Everything that moves the camera changes those
  // four values in `look` and calls aim().
  //
  // Three ways the pivot is chosen:
  //   'follow'  FOLLOW BOARD: the board, the launch point and the path so
  //             far, framed in the free part of the view and followed
  //             smoothly (see "Follow camera").
  //   'whole'   framed so every point drawn so far fits the part of the
  //             view the HUD leaves free. It is framed again as the path
  //             grows, until the viewer zooms or slides the view.
  //   'free'    wherever the viewer left it.
  // ------------------------------------------------------------------
  let followOn = Boolean(options.follow);
  let cameraMode = followOn ? 'follow' : 'free';
  let started = false;         // the starting view has been set on real data
  let framed = null;           // what 'whole' last framed: { center, radius }
  let glide = null;            // a camera move in progress: { to, frame }
  let flying = false;          // a flight (to a new site, see "Flights") is on its way
  const frameOf = (position) => C.Transforms.eastNorthUpToFixedFrame(position);
  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
  const PITCH_MIN = C.Math.toRadians(config.GLOBE_PITCH_MIN_DEG);
  const PITCH_MAX = C.Math.toRadians(config.GLOBE_PITCH_MAX_DEG);
  const STRAIGHT_DOWN = -C.Math.PI_OVER_TWO;

  // The flight's highest point above ground (m), from the pre-scan (the
  // same number the timeline uses for its scale). 0 if there is none.
  function flightTop() {
    let top = 0;
    for (const [, scan] of prescan()) top = Math.max(top, scan.state?.maxAgl ?? 0);
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

  // The idle camera: far out over the middle of the Atlantic, looking
  // down at the whole Earth with north up. It is as far out as it takes
  // for the Earth to fit the free part of the view (the view minus the
  // band the controls and credits take at the bottom, from
  // options.idleBottom) with IDLE_MARGIN to spare, and it looks a touch
  // south of straight down, so the Earth's middle lands in the middle of
  // that free part.
  //   Cesium's field of view (frustum.fov) spans the view's wider side. A
  //   pixel at the middle of the view is 1 / f radians, with f worked out
  //   from the view's height and its vertical field of view. The Earth's
  //   outline is f * tan(a) px across its middle from distance d, where
  //   sin(a) = R / d. So for an outline radius r px, a = atan(r / f) and
  //   d = R / sin(a). Tilting the camera b = atan(s / f) moves the Earth's
  //   middle s px up the screen.
  function idleCamera() {
    const w = scene.canvas.clientWidth;
    const hgt = scene.canvas.clientHeight;
    const R = C.Ellipsoid.WGS84.maximumRadius;
    const surface = C.Cartesian3.fromDegrees(WAIT_FAR_LON, WAIT_FAR_LAT, 0);
    const up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(surface, new C.Cartesian3());
    const east = C.Cartesian3.normalize(C.Cartesian3.cross(C.Cartesian3.UNIT_Z, up, new C.Cartesian3()), new C.Cartesian3());
    const north = C.Cartesian3.cross(up, east, new C.Cartesian3());
    let distance = 20000000 + R;
    let tilt = 0;
    if (w > 0 && hgt > 0) {
      const bottom = Math.min(hgt * 0.4, Math.max(0, options.idleBottom?.() ?? 0));
      const freeH = hgt - bottom;
      const fov = camera.frustum.fov ?? C.Math.toRadians(60);
      const fovy = w > hgt ? 2 * Math.atan(Math.tan(fov / 2) * hgt / w) : fov;
      const f = (hgt / 2) / Math.tan(fovy / 2);
      const radius = (Math.min(w, freeH) / 2) * (1 - IDLE_MARGIN);
      distance = R / Math.sin(Math.atan(radius / f));
      tilt = Math.atan((hgt / 2 - freeH / 2) / f);
    }
    const along = (v, k) => C.Cartesian3.multiplyByScalar(v, k, new C.Cartesian3());
    const plus = (a, b) => C.Cartesian3.add(a, b, new C.Cartesian3());
    return {
      destination: plus(surface, along(up, distance - R)),
      direction: C.Cartesian3.normalize(plus(along(up, -Math.cos(tilt)), along(north, -Math.sin(tilt))), new C.Cartesian3()),
      up: C.Cartesian3.normalize(plus(along(north, Math.cos(tilt)), along(up, -Math.sin(tilt))), new C.Cartesian3()),
      look: { pivot: surface, heading: 0, pitch: STRAIGHT_DOWN, range: distance - R },
    };
  }

  // The idle look (for the camera's sums, like the scale bar).
  function idleLook() {
    return idleCamera().look;
  }

  // Puts the camera in the idle view at once.
  function aimIdle() {
    const v = idleCamera();
    Object.assign(look, v.look);
    camera.lookAtTransform(C.Matrix4.IDENTITY);
    // The camera's directions are set as they are. (camera.setView would
    // turn a view this close to straight down into a heading taken from
    // `up`, which points north, and so tilt the camera north instead of
    // south, pushing the Earth down into the controls.)
    C.Cartesian3.clone(v.destination, camera.position);
    C.Cartesian3.clone(v.direction, camera.direction);
    C.Cartesian3.clone(v.up, camera.up);
    C.Cartesian3.normalize(C.Cartesian3.cross(v.direction, v.up, camera.right), camera.right);
    scene.requestRender();
  }

  // The view size and bottom band the idle view was last fitted to.
  let idleKey = '';
  const idleKeyNow = () => `${scene.canvas.clientWidth}x${scene.canvas.clientHeight}|${Math.round(options.idleBottom?.() ?? 0)}`;

  // Flies out to the idle view (back to live with nothing connected).
  function flyOut() {
    if (glide) window.cancelAnimationFrame(glide.frame);
    glide = null;
    dropFlight();
    const v = idleCamera();
    if (prefersReducedMotion() || !active) {
      Object.assign(look, v.look);
      aimIdle();
      return;
    }
    // A flight on its way turns around from where the camera is.
    startFlight(poseOf(v.destination, v.direction, v.up), () => aim());
    Object.assign(look, v.look);
    // The HUD changes from a replay's to live's while the camera flies out,
    // and the whole-Earth view is fitted to it. So the flight checks the
    // fit on every frame (see flightStep).
    flight.idleKey = idleKeyNow();
  }

  // Where the camera looks from: { pivot, heading, pitch, range }. Until
  // there is real data to look at, it waits over the ground station, so
  // the ground there starts loading. With no ground station it waits far
  // out, looking straight down at the whole Earth (idle).
  let waitFar = !store.getGroundStation();
  const look = waitFar ? idleLook() : stationLook(store.getGroundStation());

  function stationLook(gs) {
    return { pivot: C.Cartesian3.fromDegrees(gs.lon, gs.lat, Number.isFinite(gs.altMsl) ? gs.altMsl : 0), ...startOrbit() };
  }

  // True while the camera should sit in the idle view.
  const idle = () => waitFar && !started;

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

  // Points the camera where `look` says, within the zoom and tilt limits.
  // The idle view has its own camera (aimIdle).
  function aim() {
    if (idle() && !glide && !flying) {
      aimIdle();
      return;
    }
    look.range = clamp(look.range, config.GLOBE_ZOOM_MIN_M, config.GLOBE_ZOOM_MAX_M);
    look.pitch = clamp(look.pitch, PITCH_MIN, PITCH_MAX);
    keepAboveGround();
    aimNow();
  }

  function aimNow() {
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
      if (u < 1) {
        aim();
        glide.frame = window.requestAnimationFrame(step);
      } else {
        glide = null;
        aim();
      }
    };
    glide = { to, frame: window.requestAnimationFrame(step) };
  }

  // Stops a glide where it is, and ends a flight at its goal. (Something
  // else moves the camera now, so a goal waiting for the flight to land is
  // dropped.)
  function stopGlide() {
    if (glide) window.cancelAnimationFrame(glide.frame);
    glide = null;
    if (flight) flight.next = null;
    endFlight();
  }

  // A flight to a new site, ending exactly where `to` looks from (see
  // "Flights" below). Anything the viewer does with the camera on the way
  // ends the flight at its goal. With less motion asked for, the camera
  // jumps there. A new goal while a flight is on its way bends the flight
  // onto it, so the camera never jumps.
  function flyIn(to) {
    if (glide) {
      window.cancelAnimationFrame(glide.frame);
      glide = null;
    }
    const goal = { ...to };
    goal.range = clamp(goal.range, config.GLOBE_ZOOM_MIN_M, config.GLOBE_ZOOM_MAX_M);
    goal.pitch = clamp(goal.pitch, PITCH_MIN, PITCH_MAX);
    if (prefersReducedMotion() || !active) {
      endFlight();
      Object.assign(look, goal);
      aimNow();
      return;
    }
    const landed = () => {
      aim();
      // FOLLOW BOARD takes over from here, with a glide.
      chase.needsGlide = true;
      scheduler.schedule();
    };
    if (flight && retarget(goal, landed)) {
      // (A flight out to the whole Earth that turns back to a site stops
      // fitting the whole Earth.)
      flight.idleKey = null;
      Object.assign(look, goal);
      return;
    }
    // A flight that is nearly down lands first, then glides to a new goal
    // near its own. A far one gets a new flight from where the camera is.
    if (flight && C.Cartesian3.distance(goal.pivot, look.pivot) < GLIDE_MAX_M) {
      flight.next = goal;
      return;
    }
    dropFlight();
    // The flight starts from the pose the camera has now, worked out with
    // the old `look`, so the goal goes into `look` after.
    startFlight(goal, landed);
    Object.assign(look, goal);
  }

  // Goes to a new look: a short glide when it is near what the camera
  // looks at now, a flight when it is far. While a flight is on its way,
  // the flight takes the new goal (`look` holds the flight's goal then,
  // not where the camera is).
  function goTo(to) {
    if (flying) {
      flyIn(to);
      return;
    }
    const near = !idle() && C.Cartesian3.distance(to.pivot, look.pivot) < GLIDE_MAX_M && look.pitch !== STRAIGHT_DOWN;
    if (near) moveTo(to, { animate: true });
    else flyIn(to);
  }

  // ------------------------------------------------------------------
  // Flights. A long camera move (from the whole Earth down to a site, from
  // one site to the far side of the world, or back out) is done here and
  // not with Cesium's camera.flyTo. Cesium's flight turns the camera from
  // where it looks at the start to where it looks at the end on its own
  // schedule, so on a long flight it looked out into space for a second or
  // more and the view went black.
  //
  // Here the camera always looks at a point on the Earth (the pivot), so
  // the Earth is in the middle of the view on every frame:
  //   - the pivot slides along the great circle from where the camera
  //     looks now to the new site, so the globe turns under the camera
  //   - the distance follows van Wijk and Nuij's "smooth and efficient
  //     zooming and panning" (2003): it rises just enough that the ground
  //     slides by at an even pace on screen, then comes down onto the site.
  //     It never rises past the whole-Earth view (idleCamera).
  //   - the heading and pitch turn from the start's to the goal's as the
  //     height changes, and high above both ends the camera looks straight
  //     down, north up.
  // A pose here is { pivot, heading, pitch, range }, like `look`, except the
  // pitch may go past straight down (to -180°). The idle view needs that: it
  // looks a touch south with north still up, which is a pitch just past -90°
  // with heading 0.
  // ------------------------------------------------------------------
  // The flight on its way: { from, path, clock, last, duration, frame,
  // landed, old, next, idleKey }. `clock` is how far into the flight it is
  // (ms) and `last` the frame time it was moved on at. `old` is the path it
  // is bending away from after a new goal, `next` a goal to glide to once
  // it has landed, and `idleKey` the HUD size a flight out to the whole
  // Earth is fitted to.
  let flight = null;

  // The pose of a camera at `position` looking along `direction` with
  // `up` on screen. The pivot is the point it looks at: `look.pivot` when
  // that is straight ahead, otherwise where the line of sight meets the
  // Earth.
  function poseOf(position, direction, up) {
    const ray = new C.Ray(position, direction);
    let dist = null;
    const toPivot = C.Cartesian3.subtract(look.pivot, position, new C.Cartesian3());
    const ahead = C.Cartesian3.dot(toPivot, direction);
    const aside = C.Cartesian3.magnitude(C.Cartesian3.cross(toPivot, direction, new C.Cartesian3()));
    if (ahead > 0 && aside < ahead * 0.001) dist = ahead;
    if (dist === null) {
      const hit = C.IntersectionTests.rayEllipsoid(ray, C.Ellipsoid.WGS84);
      if (hit && hit.start > 0) dist = hit.start;
    }
    // Looking past the Earth (only after a hand tilted the camera up): the
    // pivot goes as far ahead as the camera is high.
    if (dist === null) dist = Math.max(1000, C.Cartographic.fromCartesian(position).height);
    const pivot = C.Ray.getPoint(ray, dist, new C.Cartesian3());
    const { east, north, up: skyward } = localAxes(pivot);
    // The camera's direction is fwd·cos(pitch) + skyward·sin(pitch) and its
    // up is -fwd·sin(pitch) + skyward·cos(pitch), with fwd level.
    const pitch = Math.atan2(C.Cartesian3.dot(direction, skyward), C.Cartesian3.dot(up, skyward));
    const fwd = C.Cartesian3.subtract(
      C.Cartesian3.multiplyByScalar(direction, Math.cos(pitch), new C.Cartesian3()),
      C.Cartesian3.multiplyByScalar(up, Math.sin(pitch), new C.Cartesian3()),
      new C.Cartesian3());
    const heading = Math.atan2(C.Cartesian3.dot(fwd, east), C.Cartesian3.dot(fwd, north));
    return { pivot, heading, pitch, range: dist };
  }

  // East, north and up (unit vectors) on the ground at a point.
  function localAxes(point) {
    const up = C.Ellipsoid.WGS84.geodeticSurfaceNormal(point, new C.Cartesian3());
    const east = C.Cartesian3.normalize(C.Cartesian3.cross(C.Cartesian3.UNIT_Z, up, new C.Cartesian3()), new C.Cartesian3());
    const north = C.Cartesian3.cross(up, east, new C.Cartesian3());
    return { east, north, up };
  }

  // Puts the camera at a pose (set directly, like aimIdle, so a pitch past
  // straight down works).
  function placeCamera(pose) {
    const { east, north, up } = localAxes(pose.pivot);
    const fwd = C.Cartesian3.add(
      C.Cartesian3.multiplyByScalar(north, Math.cos(pose.heading), new C.Cartesian3()),
      C.Cartesian3.multiplyByScalar(east, Math.sin(pose.heading), new C.Cartesian3()),
      new C.Cartesian3());
    const mix = (a, ka, b, kb) => C.Cartesian3.add(
      C.Cartesian3.multiplyByScalar(a, ka, new C.Cartesian3()),
      C.Cartesian3.multiplyByScalar(b, kb, new C.Cartesian3()),
      new C.Cartesian3());
    const direction = C.Cartesian3.normalize(mix(fwd, Math.cos(pose.pitch), up, Math.sin(pose.pitch)), new C.Cartesian3());
    const cameraUp = C.Cartesian3.normalize(mix(fwd, -Math.sin(pose.pitch), up, Math.cos(pose.pitch)), new C.Cartesian3());
    camera.lookAtTransform(C.Matrix4.IDENTITY);
    C.Cartesian3.clone(mix(pose.pivot, 1, direction, -pose.range), camera.position);
    C.Cartesian3.clone(direction, camera.direction);
    C.Cartesian3.clone(cameraUp, camera.up);
    C.Cartesian3.normalize(C.Cartesian3.cross(direction, cameraUp, camera.right), camera.right);
    scene.requestRender();
  }

  // van Wijk and Nuij's path for a view `w0` wide moving `d` along the
  // ground to a view `w1` wide, with `rise` (their rho) saying how much it
  // rises on the way. Returns its length and, for progress s from 0 to 1,
  // the share of the way the middle of the view has moved (u) and the
  // view's width (w). Their equations, as written in their paper.
  function zoomPath(w0, w1, d, rise) {
    const r2 = rise * rise;
    if (!(d > 1e-6 * Math.max(w0, w1))) {
      // No way to go, only in or out.
      const k = Math.log(w1 / w0);
      return { length: Math.abs(k) / rise, top: Math.max(w0, w1), at: (s) => ({ u: s, w: w0 * Math.exp(k * s) }) };
    }
    const b0 = (w1 * w1 - w0 * w0 + r2 * r2 * d * d) / (2 * w0 * r2 * d);
    const b1 = (w1 * w1 - w0 * w0 - r2 * r2 * d * d) / (2 * w1 * r2 * d);
    const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
    const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
    const length = (r1 - r0) / rise;
    // The widest the view gets: in the middle when the path rises, at an
    // end when it doesn't.
    const top = r0 < 0 && r1 > 0 ? w0 * Math.cosh(r0) : Math.max(w0, w1);
    return {
      length,
      top,
      at(s) {
        const x = rise * s * length + r0;
        return {
          u: (w0 / (r2 * d)) * (Math.cosh(r0) * Math.tanh(x) - Math.sinh(r0)),
          w: (w0 * Math.cosh(r0)) / Math.cosh(x),
        };
      },
    };
  }

  // The path of a flight from one pose to another: its length and the pose
  // at progress s (0 to 1).
  function flightPath(from, to) {
    const a = C.Cartographic.fromCartesian(from.pivot);
    const b = C.Cartographic.fromCartesian(to.pivot);
    const unit = (c) => new C.Cartesian3(Math.cos(c.latitude) * Math.cos(c.longitude), Math.cos(c.latitude) * Math.sin(c.longitude), Math.sin(c.latitude));
    const va = unit(a);
    const vb = unit(b);
    const angle = Math.acos(clamp(C.Cartesian3.dot(va, vb), -1, 1));
    // A view's height on the ground is about k times the camera's distance.
    const k = 2 * Math.tan(camera.frustum.fovy / 2);
    const w0 = from.range * k;
    const w1 = to.range * k;
    const d = C.Ellipsoid.WGS84.maximumRadius * angle;
    // Never higher than the whole-Earth view, or than either end.
    const highest = Math.max(from.range, to.range, idleLook().range) * k;
    let rise = FLY_RISE;
    let zoom = zoomPath(w0, w1, d, rise);
    while (zoom.top > highest * 1.001 && rise > 0.2) {
      rise *= 0.85;
      zoom = zoomPath(w0, w1, d, rise);
    }
    const turn = C.Math.negativePiToPi(to.heading - from.heading);
    // How far apart the two ends are in height. Far apart (the whole Earth
    // down to a site), the camera turns and tilts as it comes down. Close
    // (one site to another), it turns along the way.
    const span = Math.log(to.range / from.range);
    const byHeight = clamp(Math.abs(span) / Math.log(10), 0, 1);
    const higherEnd = Math.max(from.range, to.range);
    return {
      length: zoom.length,
      at(s) {
        if (s <= 0) return from;
        if (s >= 1) return to;
        const { u, w } = zoom.at(s);
        const range = Math.min(w, highest) / k;
        // The pivot on the great circle between the two ends.
        let v;
        if (angle > 1e-9) {
          const sa = Math.sin((1 - u) * angle) / Math.sin(angle);
          const sb = Math.sin(u * angle) / Math.sin(angle);
          v = new C.Cartesian3(va.x * sa + vb.x * sb, va.y * sa + vb.y * sb, va.z * sa + vb.z * sb);
        } else v = va;
        const lat = Math.asin(clamp(v.z / C.Cartesian3.magnitude(v), -1, 1));
        const lon = Math.atan2(v.y, v.x);
        const pivot = C.Cartesian3.fromRadians(lon, lat, a.height + (b.height - a.height) * u);
        const climbed = span ? clamp(Math.log(range / from.range) / span, 0, 1) : s;
        const x = s + (climbed - s) * byHeight;
        let pitch = from.pitch + (to.pitch - from.pitch) * x;
        // High above both ends: straight down.
        const high = clamp(Math.log(range / higherEnd) / Math.log(FLY_TOP_DOWN), 0, 1);
        pitch += (STRAIGHT_DOWN - pitch) * high;
        return { pivot, heading: from.heading + turn * x, pitch, range };
      },
    };
  }

  // Starts a flight from where the camera is now to `goal` (a pose).
  // landed() runs when it ends, on its own or because something stopped it.
  function startFlight(goal, landed) {
    const from = poseOf(camera.positionWC, camera.directionWC, camera.upWC);
    const path = flightPath(from, goal);
    const duration = 1000 * clamp(FLY_IN_S * Math.sqrt(path.length / FLY_IN_PATH), FLY_IN_S, FLY_IN_MAX_S);
    flight = { from, path, clock: 0, last: performance.now(), duration, frame: 0, landed, old: null, next: null, idleKey: null };
    flying = true;
    flight.frame = window.requestAnimationFrame(flightStep);
    flightStep(performance.now());
  }

  // Bends the flight on its way onto a new goal, if at least `needs` ms are
  // left to do it in. True when it did.
  function retarget(goal, landed, needs = FLY_RETARGET_MS) {
    const left = flight.duration - flight.clock;
    if (left < needs) return false;
    // Still bending onto an earlier goal: the old path becomes the mix the
    // camera is on right now, so nothing jumps.
    let oldPath = flight.path;
    if (flight.old) {
      const prev = flight.old.path;
      const cur = flight.path;
      const k = blendAt(flight.old);
      oldPath = { at: (s) => mixPoses(prev.at(s), cur.at(s), k) };
    }
    flight.old = { path: oldPath, at: flight.clock, span: Math.min(FLY_RETARGET_MS, left) };
    flight.path = flightPath(flight.from, goal);
    flight.landed = landed;
    flight.next = null;
    return true;
  }

  // One frame of the flight: the flight's clock moves on, the time is eased
  // in and out, then the camera goes to the pose on the path (blended from
  // the old path while it bends onto a new goal).
  function flightStep(now) {
    if (destroyed || !flight) return;
    flight.clock += clamp(now - flight.last, 0, FLY_MAX_STEP_MS);
    flight.last = now;
    // Flying out to the whole Earth, and the HUD has changed size: aim for
    // the whole-Earth view that fits it now.
    if (flight.idleKey && flight.idleKey !== idleKeyNow()) {
      flight.idleKey = idleKeyNow();
      const v = idleCamera();
      Object.assign(look, v.look);
      retarget(poseOf(v.destination, v.direction, v.up), flight.landed, FLY_IDLE_REFIT_MS);
    }
    const t = clamp(flight.clock / flight.duration, 0, 1);
    if (t >= 1) {
      endFlight();
      return;
    }
    const s = t * t * (3 - 2 * t);
    let pose = flight.path.at(s);
    if (flight.old) {
      const blend = blendAt(flight.old);
      if (blend >= 1) flight.old = null;
      else pose = mixPoses(flight.old.path.at(s), pose, blend);
    }
    placeCamera(pose);
    flight.frame = window.requestAnimationFrame(flightStep);
  }

  // How far a flight has bent from its old path onto its new one (0 to 1,
  // eased in and out).
  function blendAt(old) {
    const b = clamp((flight.clock - old.at) / old.span, 0, 1);
    return b * b * (3 - 2 * b);
  }

  // Two poses mixed: k = 0 is the first, 1 the second.
  function mixPoses(p, q, k) {
    return {
      pivot: C.Cartesian3.lerp(p.pivot, q.pivot, k, new C.Cartesian3()),
      heading: p.heading + C.Math.negativePiToPi(q.heading - p.heading) * k,
      pitch: p.pitch + (q.pitch - p.pitch) * k,
      range: Math.exp(Math.log(p.range) + (Math.log(q.range) - Math.log(p.range)) * k),
    };
  }

  // Ends the flight at its goal (`look`), if one is on its way. A goal that
  // came too late to bend onto gets a short glide from there.
  function endFlight() {
    if (!flight) return;
    const { landed, next, frame } = flight;
    window.cancelAnimationFrame(frame);
    flight = null;
    flying = false;
    if (destroyed) return;
    landed();
    if (next) moveTo(next, { animate: true });
  }

  // Stops a flight where the camera is, without landing it (a new flight
  // starts from there).
  function dropFlight() {
    if (!flight) return;
    window.cancelAnimationFrame(flight.frame);
    flight = null;
    flying = false;
  }

  // Ends a glide or a flight at its goal (the view is about to be hidden).
  function finishGlide() {
    if (flight) {
      flight.next = null;
      endFlight();
    }
    if (!glide) return;
    const { to } = glide;
    stopGlide();
    Object.assign(look, to);
    aim();
  }

  // Where the focused board's marker is, as a copy. (A billboard hands out
  // its own position object and changes it in place when it moves, so
  // keeping that object would make an old position look like the new one.)
  const focusedTarget = () => {
    const parts = drawn.get(store.getFocusedId());
    return parts?.icon?.show ? C.Cartesian3.clone(parts.icon.position) : null;
  };
  const firstPad = () => {
    const focusedParts = drawn.get(store.getFocusedId());
    if (focusedParts?.pad?.show) return focusedParts.padAt;
    for (const parts of drawn.values()) if (parts.pad?.show) return parts.padAt;
    return null;
  };

  // Every point worth framing: every dot and line point, the pads, the
  // event markers and the ground station.
  function everything() {
    const points = [];
    for (const parts of drawn.values()) {
      for (const p of parts.dotAt) if (p) points.push(p);
      for (const v of parts.verts) points.push(v.position);
      if (parts.pad?.show) points.push(parts.padAt);
    }
    for (const m of marks) points.push(m.position);
    if (station.position) points.push(station.position);
    return points;
  }

  // The box (canvas px) of the points on screen with the camera where
  // `look` says right now, or null when one of them is behind the camera.
  function projectedBox(points) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of points) {
      const s = scene.cartesianToCanvasCoordinates(p, scratch2);
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) return null;
      x0 = Math.min(x0, s.x);
      x1 = Math.max(x1, s.x);
      y0 = Math.min(y0, s.y);
      y1 = Math.max(y1, s.y);
    }
    return { x0, x1, y0, y1 };
  }

  // WHOLE FLIGHT. The camera keeps its heading and a tilt that shows the
  // ground, and is placed so every point drawn so far lands inside the
  // free part of the view (freeInsets() from map-view.js: the view minus
  // the HUD, the controls, the timeline and some room). The fit is worked
  // out by trying: point the camera, project the points to the screen,
  // then move closer or farther and slide the view until the points' box
  // sits in the middle of the free part and just fits.
  function frameEverything({ animate }) {
    const all = everything();
    const width = scene.canvas.clientWidth;
    const height = scene.canvas.clientHeight;
    // Nothing to frame yet, or no view to measure (hidden behind the map).
    // updateCamera() frames as soon as there is.
    if (!all.length || width < 1 || height < 1) return;
    const step = Math.max(1, Math.ceil(all.length / WHOLE_FIT_SAMPLE));
    const points = all.filter((_, i) => i % step === 0 || i === all.length - 1);
    // The extreme points always count, whatever the sampling skipped.
    const sphere = C.BoundingSphere.fromPoints(all);
    sphere.radius = Math.max(sphere.radius, 150);
    const ins = freeInsets?.() ?? { top: 24, right: 24, bottom: 24, left: 24 };
    const free = { x0: ins.left, x1: width - ins.right, y0: ins.top, y1: height - ins.bottom };
    if (free.x1 - free.x0 < 40 || free.y1 - free.y0 < 40) {
      free.x0 = 0; free.x1 = width; free.y0 = 0; free.y1 = height;
    }
    const freeW = free.x1 - free.x0;
    const freeH = free.y1 - free.y0;
    const pitch = Math.min(C.Math.toRadians(config.GLOBE_START_PITCH_DEG), Math.max(C.Math.toRadians(-70), look.pitch));
    const tanV = Math.tan(camera.frustum.fovy / 2);
    const to = {
      pivot: C.Cartesian3.clone(sphere.center),
      heading: look.heading,
      pitch,
      range: clamp((sphere.radius / tanV) * 1.2, config.GLOBE_ZOOM_MIN_M, config.GLOBE_ZOOM_MAX_M),
    };
    const saved = { pivot: C.Cartesian3.clone(look.pivot), heading: look.heading, pitch: look.pitch, range: look.range };
    const extreme = all.length > points.length ? [...points, ...extremes(all)] : points;
    for (let i = 0; i < WHOLE_FIT_STEPS; i++) {
      Object.assign(look, to);
      aimNow();
      const box = projectedBox(extreme);
      if (!box) {
        to.range = clamp(to.range * 1.6, config.GLOBE_ZOOM_MIN_M, config.GLOBE_ZOOM_MAX_M);
        continue;
      }
      const scale = Math.max((box.x1 - box.x0) / freeW, (box.y1 - box.y0) / freeH, 0.05);
      const dx = (box.x0 + box.x1) / 2 - (free.x0 + free.x1) / 2;
      const dy = (box.y0 + box.y1) / 2 - (free.y0 + free.y1) / 2;
      const done = Math.abs(scale - 1) < 0.02 && Math.abs(dx) < 3 && Math.abs(dy) < 3 && box.x0 >= free.x0 - 1 && box.x1 <= free.x1 + 1 && box.y0 >= free.y0 - 1 && box.y1 <= free.y1 + 1;
      if (done) break;
      // Slide the pivot across the screen so the box's middle lands on the
      // free part's middle, then move closer or farther to fit.
      const mpp = (2 * C.Cartesian3.distance(camera.positionWC, to.pivot) * tanV) / height;
      const right = C.Cartesian3.multiplyByScalar(camera.rightWC, dx * mpp, new C.Cartesian3());
      const up = C.Cartesian3.multiplyByScalar(camera.upWC, -dy * mpp, new C.Cartesian3());
      to.pivot = C.Cartesian3.add(C.Cartesian3.add(to.pivot, right, new C.Cartesian3()), up, new C.Cartesian3());
      to.range = clamp(to.range * clamp(scale * 1.01, 0.4, 2.5), config.GLOBE_ZOOM_MIN_M, config.GLOBE_ZOOM_MAX_M);
    }
    Object.assign(look, saved);
    aimNow();
    framed = { center: C.Cartesian3.clone(sphere.center), radius: sphere.radius };
    moveTo(to, { animate });
  }

  // The points furthest out in each direction of the Earth-centered axes,
  // so a sampled fit check never misses the ends of the path.
  function extremes(points) {
    const out = [];
    for (const axis of ['x', 'y', 'z']) {
      let lo = points[0];
      let hi = points[0];
      for (const p of points) {
        if (p[axis] < lo[axis]) lo = p;
        if (p[axis] > hi[axis]) hi = p;
      }
      out.push(lo, hi);
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Follow camera (FOLLOW BOARD). It works like a camera operator on the
  // ground following a rocket:
  //   - It frames the board, the launch point, Manta (when it is close)
  //     and the path so far inside the free part of the view (the part
  //     the HUD leaves free, from freeInsets()), keeping the visitor's
  //     heading and tilt. As the board climbs, it pulls back so the
  //     picture still shows where the flight started. Past
  //     FOLLOW_RANGE_MAX_M it keeps only the board and its newest path.
  //   - The board itself always stays inside the free part, never under
  //     the HUD, the controls or the timeline. That is checked on every
  //     frame with the real camera, and the view is nudged if needed.
  //   - It moves smoothly. Fixes come about once a second and wander a
  //     little, so the camera eases toward each new framing instead of
  //     jumping, and it ignores changes under FOLLOW_STILL_PX.
  //   - After landing it settles on the board, a little steeper, so the
  //     recovery crosshair and the DOGTOOTH label are easy to see.
  //   - The visitor stays in charge. Turning or tilting the view keeps
  //     following from the new angle, and zooming makes the camera
  //     closer or farther than its own choice (chase.zoom). Sliding the
  //     view switches FOLLOW BOARD off (slideBy).
  // The sums are done in a flat east, north, up frame at the launch point
  // (fine over a few kilometers), with the same pinhole camera Cesium uses.
  // A loop runs once per screen refresh while the camera still moves, and
  // stops once it has caught up.
  // ------------------------------------------------------------------
  const chase = {
    frame: 0,          // the waiting animation frame, or 0
    last: 0,           // when the last step ran (ms)
    anchor: null,      // the frame's origin (world), and the two matrices
    toWorld: null,
    toLocal: null,
    board: null,       // the board, in the local frame
    boardWorld: null,  // the board, in world coordinates
    lead: null,        // where the board will be at the next fix if it keeps going (local)
    crumbs: null,      // the crumbs list the board was last seen in (a new one means a seek)
    want: [],          // local points to keep in view if possible
    tail: [],          // the newest path points (local), for a long flight
    key: '',           // what `want` was worked out from
    recovery: false,   // landed: settle on the board
    target: null,      // the framing the camera eases toward: { pivot (local), range }
    zoom: 1,           // the visitor's zoom on top of the camera's own range
    tiltTo: null,      // a pitch the camera eases to (radians), or null
    headTo: null,      // a heading it eases to (radians), or null
    glide: null,       // a glide in progress: { from: { pivot, range }, start, keep, nudge }
    needsGlide: true,  // the next step starts with a glide: true (a fresh start) or
                       // 'keep' (one that keeps the board in the free part all the way)
    fixAt: 0,          // when the board last moved (ms)
    fixGap: 1000,      // the usual time between board moves (ms)
    free: null,        // the free part of the view: { x0, x1, y0, y1 } in canvas px
    freeAt: 0,
    jumped: false,     // the board just jumped (a seek): the camera jumps with it
  };

  const vec = (x, y, z) => ({ x, y, z });
  const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
  const addScaled = (a, b, k) => vec(a.x + b.x * k, a.y + b.y * k, a.z + b.z * k);
  const toLocal = (world) => {
    const p = C.Matrix4.multiplyByPoint(chase.toLocal, world, new C.Cartesian3());
    return vec(p.x, p.y, p.z);
  };
  const toWorld = (local) => C.Matrix4.multiplyByPoint(chase.toWorld, new C.Cartesian3(local.x, local.y, local.z), new C.Cartesian3());

  // Starts the follow camera over: a new site, or FOLLOW BOARD ticked.
  function chaseReset() {
    window.cancelAnimationFrame(chase.frame);
    Object.assign(chase, {
      frame: 0, anchor: null, toWorld: null, toLocal: null, board: null, boardWorld: null, lead: null, crumbs: null,
      want: [], tail: [], key: '', recovery: false, target: null, zoom: 1,
      tiltTo: null, headTo: null, glide: null, needsGlide: true, free: null, freeAt: 0, jumped: false,
    });
  }

  // Brings the follow camera's points up to date after a draw: the board,
  // and the points it tries to keep in view.
  function chaseData(target) {
    const focused = store.getFocused();
    const parts = focused ? drawn.get(focused.id) : null;
    if (!parts) return;
    const origin = parts.padAt ?? target;
    if (!chase.anchor || C.Cartesian3.distance(chase.anchor, origin) > 1) {
      chase.anchor = C.Cartesian3.clone(origin);
      chase.toWorld = frameOf(chase.anchor);
      chase.toLocal = C.Matrix4.inverseTransformation(chase.toWorld, new C.Matrix4());
      chase.key = '';
      chase.target = null;
    }
    // How often the board moves, so the camera eases at a pace that suits
    // the playback speed. And where it will be at the next fix if it keeps
    // going the same way, so the camera can lead it like an operator leads
    // a rocket (a fast climb then doesn't step out of the frame).
    if (!chase.boardWorld || !C.Cartesian3.equals(chase.boardWorld, target)) {
      const now = performance.now();
      const gap = now - chase.fixAt;
      if (chase.boardWorld && gap > 0 && gap < 5000) chase.fixGap += (gap - chase.fixGap) * 0.3;
      // (Not across a seek, a long silence or a step no rocket makes in
      // one fix.)
      const before = chase.crumbs === parts.crumbs ? chase.board : null;
      const board = toLocal(target);
      const step = before ? Math.hypot(board.x - before.x, board.y - before.y, board.z - before.z) : Infinity;
      chase.lead = gap < 3 * chase.fixGap && step < FOLLOW_LEAD_MAX_M ? vec(2 * board.x - before.x, 2 * board.y - before.y, 2 * board.z - before.z) : board;
      // A seek, or a step no rocket makes between two fixes: the camera
      // jumps to the new framing (snapToGoal) instead of easing there.
      if (chase.boardWorld && step >= FOLLOW_LEAD_MAX_M) chase.jumped = true;
      chase.crumbs = parts.crumbs;
      chase.fixAt = now;
      chase.boardWorld = C.Cartesian3.clone(target);
    }
    chase.board = toLocal(target);
    chase.lead ??= chase.board;
    // Landed: settle on the board, a little steeper.
    const recovery = flightState(store, focused).state === STATE.RECOVERY;
    if (recovery && !chase.recovery) {
      const steep = C.Math.toRadians(RECOVERY_PITCH_DEG);
      if (look.pitch > steep) chase.tiltTo = steep;
      // A long way in from the flight's framing: a glide, not a rush,
      // that still keeps the board clear of the HUD on the way.
      chase.needsGlide = 'keep';
    }
    chase.recovery = recovery;
    // The points to keep in view: the launch point, Manta when it is
    // close, the event markers and the path (sampled, ends included).
    const key = `${parts.verts.length}|${parts.padAt ? 'pad' : ''}|${station.position ? 'gs' : ''}|${marks.length}`;
    if (key === chase.key) return;
    chase.key = key;
    const want = [];
    if (parts.padAt) want.push(toLocal(parts.padAt));
    if (station.position && C.Cartesian3.distance(station.position, origin) < FOLLOW_STATION_M) want.push(toLocal(station.position));
    for (const m of marks) want.push(toLocal(m.position));
    const verts = parts.verts;
    const step = Math.max(1, Math.ceil(verts.length / FOLLOW_SAMPLE));
    for (let i = 0; i < verts.length; i += step) want.push(toLocal(verts[i].position));
    if (verts.length) want.push(toLocal(verts[verts.length - 1].position));
    chase.want = want;
    chase.tail = verts.slice(-FOLLOW_TAIL_POINTS).map((v) => toLocal(v.position));
  }

  // The view's size and the camera's focal length (px), or null.
  function viewSize() {
    const w = scene.canvas.clientWidth;
    const hgt = scene.canvas.clientHeight;
    const fovy = camera.frustum.fovy;
    if (!(w > 40 && hgt > 40 && fovy > 0)) return null;
    return { w, h: hgt, f: (hgt / 2) / Math.tan(fovy / 2) };
  }

  // The free part of the view, in canvas px.
  function freeRect(size) {
    const ins = freeInsets?.() ?? { top: 24, right: 24, bottom: 24, left: 24 };
    const rect = { x0: ins.left, x1: size.w - ins.right, y0: ins.top, y1: size.h - ins.bottom };
    if (rect.x1 - rect.x0 < 40 || rect.y1 - rect.y0 < 40) return { x0: 0, x1: size.w, y0: 0, y1: size.h };
    return rect;
  }

  // A rectangle made smaller by px on each side, but never below 40 px.
  function shrink(rect, px) {
    const sx = Math.max(0, Math.min(px, (rect.x1 - rect.x0 - 40) / 2));
    const sy = Math.max(0, Math.min(px, (rect.y1 - rect.y0 - 40) / 2));
    return { x0: rect.x0 + sx, x1: rect.x1 - sx, y0: rect.y0 + sy, y1: rect.y1 - sy };
  }

  // The camera's three directions in the local frame for a heading and a
  // pitch: where it looks (d), its right (r) and its up (u). Heading 0
  // looks north, and a negative pitch looks down, as in cameraSpot().
  function axesFor(heading, pitch) {
    const d = vec(Math.sin(heading) * Math.cos(pitch), Math.cos(heading) * Math.cos(pitch), Math.sin(pitch));
    const r = vec(Math.cos(heading), -Math.sin(heading), 0);
    const u = vec(r.y * d.z - r.z * d.y, r.z * d.x - r.x * d.z, r.x * d.y - r.y * d.x);
    return { d, r, u };
  }

  // Where a local point lands on screen (canvas px) with the camera looking
  // at pivot from range away, or null when it is behind the camera.
  function projectLocal(q, pivot, range, ax, size) {
    const v = vec(q.x - pivot.x + ax.d.x * range, q.y - pivot.y + ax.d.y * range, q.z - pivot.z + ax.d.z * range);
    const z = dot3(v, ax.d);
    if (z < 1) return null;
    return { x: size.w / 2 + (size.f * dot3(v, ax.r)) / z, y: size.h / 2 - (size.f * dot3(v, ax.u)) / z, z };
  }

  function boxOf(points, pivot, range, ax, size) {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const q of points) {
      const s = projectLocal(q, pivot, range, ax, size);
      if (!s) return null;
      x0 = Math.min(x0, s.x); x1 = Math.max(x1, s.x);
      y0 = Math.min(y0, s.y); y1 = Math.max(y1, s.y);
    }
    return { x0, x1, y0, y1 };
  }

  // Slides the pivot across the screen by (dx, dy) px, measured at depth.
  const slidePivot = (pivot, ax, dx, dy, mpp) => addScaled(addScaled(pivot, ax.r, dx * mpp), ax.u, -dy * mpp);

  // The pivot and range that fit the points' box into rect, by trying:
  // project, slide the box's middle onto the rect's middle, move closer
  // or farther to fit, and again. With fit off it only slides.
  function fitBox(points, rect, ax, size, pivot, range, { fit = true, minRange = 1 } = {}) {
    const rw = rect.x1 - rect.x0;
    const rh = rect.y1 - rect.y0;
    for (let i = 0; i < 12; i++) {
      const box = boxOf(points, pivot, range, ax, size);
      if (!box) {
        range *= 1.6;
        continue;
      }
      const dx = (box.x0 + box.x1) / 2 - (rect.x0 + rect.x1) / 2;
      const dy = (box.y0 + box.y1) / 2 - (rect.y0 + rect.y1) / 2;
      const scale = fit ? Math.max((box.x1 - box.x0) / rw, (box.y1 - box.y0) / rh, 0.02) : 1;
      if (Math.abs(scale - 1) < 0.01 && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) break;
      pivot = slidePivot(pivot, ax, dx, dy, range / size.f);
      if (fit) range = Math.max(minRange, range * clamp(scale, 0.4, 2.5));
    }
    return { pivot, range };
  }

  // Slides the pivot so the board lands inside rect (it may already be).
  function keepInside(board, rect, ax, size, pivot, range) {
    for (let i = 0; i < 3; i++) {
      const s = projectLocal(board, pivot, range, ax, size);
      if (!s) return pivot;
      const dx = s.x < rect.x0 ? s.x - rect.x0 : s.x > rect.x1 ? s.x - rect.x1 : 0;
      const dy = s.y < rect.y0 ? s.y - rect.y0 : s.y > rect.y1 ? s.y - rect.y1 : 0;
      if (!dx && !dy) return pivot;
      pivot = slidePivot(pivot, ax, dx, dy, s.z / size.f);
    }
    return pivot;
  }

  // The framing the camera heads for right now: { pivot (local), range }.
  function chaseGoal(size) {
    const ax = axesFor(look.heading, look.pitch);
    const room = shrink(chase.free, FOLLOW_ROOM_PX);
    const board = chase.board;
    const centroid = (points) => {
      const sum = points.reduce((a, q) => vec(a.x + q.x, a.y + q.y, a.z + q.z), vec(0, 0, 0));
      return vec(sum.x / points.length, sum.y / points.length, sum.z / points.length);
    };
    let points;
    let minRange;
    if (chase.recovery) {
      points = [board];
      minRange = RECOVERY_RANGE_M;
    } else {
      points = [board, chase.lead, ...chase.want];
      minRange = FOLLOW_RANGE_MIN_M;
    }
    let fit = fitBox(points, room, ax, size, centroid(points), minRange, { minRange });
    if (!chase.recovery && fit.range > FOLLOW_RANGE_MAX_M) {
      // Too far to keep everything: the board and its newest path only.
      points = [board, chase.lead, ...chase.tail];
      fit = fitBox(points, room, ax, size, centroid(points), minRange, { minRange });
    }
    const range = clamp(Math.max(minRange, fit.range) * chase.zoom, config.GLOBE_ZOOM_MIN_M, config.GLOBE_ZOOM_MAX_M);
    let pivot = fit.pivot;
    // A different range (the visitor zoomed): centered again at it.
    if (Math.abs(range / fit.range - 1) > 0.001) pivot = fitBox(points, room, ax, size, pivot, range, { fit: false }).pivot;
    // Whatever else fits, the board must, and where it is headed if it can.
    if (!chase.recovery) pivot = keepInside(chase.lead, room, ax, size, pivot, range);
    pivot = keepInside(board, room, ax, size, pivot, range);
    return { pivot, range };
  }

  // Asks for the next step of the follow camera.
  function chaseKick() {
    if (chase.frame || destroyed || !active || cameraMode !== 'follow') return;
    chase.frame = window.requestAnimationFrame(chaseStep);
  }

  // One step of the follow camera, once per screen refresh while it moves.
  function chaseStep(now) {
    chase.frame = 0;
    if (destroyed || !active || cameraMode !== 'follow' || flying || !chase.board || !chase.toLocal) return;
    const size = viewSize();
    if (!size) return;
    stopGlide();
    if (!chase.free || now - chase.freeAt > FOLLOW_FREE_MS) {
      chase.free = freeRect(size);
      chase.freeAt = now;
    }
    const reduce = prefersReducedMotion();
    // (A long frame, while Cesium loads ground tiles, counts as two frames
    // at most, so the camera lags a little then instead of jumping.)
    const dt = chase.last ? clamp(now - chase.last, 0, 34) / 1000 : 1 / 60;
    chase.last = now;
    const tau = clamp((chase.fixGap / 1000) * FOLLOW_SMOOTH_SHARE, FOLLOW_SMOOTH_MIN_S, FOLLOW_SMOOTH_MAX_S);
    const k = reduce ? 1 : 1 - Math.exp(-dt / tau);
    // A heading or tilt asked for (RESET VIEW, landing) is eased in too,
    // at the pace of a glide.
    const kTurn = reduce ? 1 : 1 - Math.exp(-dt / (FOLLOW_GLIDE_MS / 3000));
    let turning = false;
    if (chase.headTo !== null) {
      const turn = C.Math.negativePiToPi(chase.headTo - look.heading);
      look.heading += turn * kTurn;
      if (Math.abs(turn) < 0.002 || reduce) { look.heading = chase.headTo; chase.headTo = null; } else turning = true;
    }
    if (chase.tiltTo !== null) {
      const tilt = chase.tiltTo - look.pitch;
      look.pitch += tilt * kTurn;
      if (Math.abs(tilt) < 0.002 || reduce) { look.pitch = chase.tiltTo; chase.tiltTo = null; } else turning = true;
    }
    const goal = chaseGoal(size);
    // Ignore small changes (a board wandering on the pad), unless the
    // board is about to leave the framing.
    const still = (a, b) => Math.hypot(a.pivot.x - b.pivot.x, a.pivot.y - b.pivot.y, a.pivot.z - b.pivot.z) / (b.range / size.f) < FOLLOW_STILL_PX && Math.abs(Math.log(a.range / b.range)) < 0.05;
    const ax = axesFor(look.heading, look.pitch);
    const boardIn = (t) => {
      const s = projectLocal(chase.board, t.pivot, t.range, ax, size);
      const room = shrink(chase.free, FOLLOW_ROOM_PX / 2);
      return s && s.x >= room.x0 && s.x <= room.x1 && s.y >= room.y0 && s.y <= room.y1;
    };
    if (!chase.target || chase.glide || chase.needsGlide || turning || !still(goal, chase.target) || !boardIn(chase.target)) chase.target = goal;
    const target = chase.target;
    const here = { pivot: toLocal(look.pivot), range: look.range };
    if (chase.needsGlide) {
      chase.glide = reduce ? null : { from: here, start: now, keep: chase.needsGlide === 'keep', nudge: vec(0, 0, 0) };
      chase.needsGlide = false;
    }
    let next;
    if (chase.glide) {
      // A glide of FOLLOW_GLIDE_MS onto the framing, which keeps moving
      // with the board on the way. (nudge: what keepBoardOnScreen added
      // on the way, fading out as the glide reaches its framing, which
      // keeps the board clear by itself.)
      const u = clamp((now - chase.glide.start) / FOLLOW_GLIDE_MS, 0, 1);
      const e = u * u * (3 - 2 * u);
      const { from, nudge } = chase.glide;
      next = {
        pivot: vec(
          from.pivot.x + (target.pivot.x - from.pivot.x) * e + nudge.x * (1 - e),
          from.pivot.y + (target.pivot.y - from.pivot.y) * e + nudge.y * (1 - e),
          from.pivot.z + (target.pivot.z - from.pivot.z) * e + nudge.z * (1 - e)),
        range: Math.exp(Math.log(from.range) + (Math.log(target.range) - Math.log(from.range)) * e),
      };
      chase.glide.e = e;
      if (u >= 1) chase.glide = null;
    } else {
      next = {
        pivot: vec(here.pivot.x + (target.pivot.x - here.pivot.x) * k, here.pivot.y + (target.pivot.y - here.pivot.y) * k, here.pivot.z + (target.pivot.z - here.pivot.z) * k),
        range: Math.exp(Math.log(here.range) + (Math.log(target.range) - Math.log(here.range)) * k),
      };
    }
    look.pivot = toWorld(next.pivot);
    look.range = next.range;
    aim();
    if (!chase.glide) keepBoardOnScreen(size);
    else if (chase.glide.keep) {
      // Carry a nudge into the glide, so its next step doesn't undo it.
      const before = toLocal(look.pivot);
      keepBoardOnScreen(size);
      const after = toLocal(look.pivot);
      const fade = Math.max(0.05, 1 - chase.glide.e);
      const n = chase.glide.nudge;
      chase.glide.nudge = vec(n.x + (after.x - before.x) / fade, n.y + (after.y - before.y) / fade, n.z + (after.z - before.z) / fade);
    }
    // Caught up: stop until the next fix, or the visitor moves the view.
    const left = Math.hypot(next.pivot.x - target.pivot.x, next.pivot.y - target.pivot.y, next.pivot.z - target.pivot.z) / (target.range / size.f);
    const settled = !chase.glide && !turning && left < 0.3 && Math.abs(Math.log(next.range / target.range)) < 0.0005;
    if (!settled) chase.frame = window.requestAnimationFrame(chaseStep);
    else chase.last = 0;
  }

  // The rule that always holds: with the real camera, the board is inside
  // the free part of the view. If the easing ever lags behind that far,
  // the view is nudged at once.
  // The nudge works in screen pixels, which is only right for a small
  // step. A board behind the camera or more than a view away (a seek that
  // jumped it kilometers, say) makes the camera jump to a fresh framing
  // instead (snapToGoal), once.
  function keepBoardOnScreen(size, { snapped = false } = {}) {
    // (A flight to a new site moves the camera itself.)
    if (flying || !chase.boardWorld) return;
    const rect = chase.free;
    for (let i = 0; i < 2; i++) {
      const s = scene.cartesianToCanvasCoordinates(chase.boardWorld, scratch2);
      const toBoard = C.Cartesian3.subtract(chase.boardWorld, camera.positionWC, new C.Cartesian3());
      const behind = C.Cartesian3.dot(toBoard, camera.directionWC) <= 0;
      if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y) || behind) {
        if (!snapped) snapToGoal(size);
        return;
      }
      const dx = s.x < rect.x0 ? s.x - rect.x0 - 2 : s.x > rect.x1 ? s.x - rect.x1 + 2 : 0;
      const dy = s.y < rect.y0 ? s.y - rect.y0 - 2 : s.y > rect.y1 ? s.y - rect.y1 + 2 : 0;
      if (!dx && !dy) return;
      if (Math.abs(dx) > size.w || Math.abs(dy) > size.h) {
        if (!snapped) snapToGoal(size);
        return;
      }
      const mpp = C.Cartesian3.distance(camera.positionWC, chase.boardWorld) / size.f;
      const right = C.Cartesian3.multiplyByScalar(camera.rightWC, dx * mpp, new C.Cartesian3());
      const up = C.Cartesian3.multiplyByScalar(camera.upWC, -dy * mpp, new C.Cartesian3());
      look.pivot = C.Cartesian3.add(C.Cartesian3.add(look.pivot, right, new C.Cartesian3()), up, new C.Cartesian3());
      aimNow();
    }
  }

  // Puts the camera straight on the follow camera's framing, with no
  // easing: after a seek, where the board can land kilometers from where
  // it was, and easing there would leave it out of the picture on the way.
  function snapToGoal(size) {
    chase.jumped = false;
    if (!chase.board || !chase.toLocal) return;
    stopGlide();
    chase.free = freeRect(size);
    chase.freeAt = performance.now();
    chase.glide = null;
    chase.needsGlide = false;
    if (chase.headTo !== null) { look.heading = chase.headTo; chase.headTo = null; }
    if (chase.tiltTo !== null) { look.pitch = chase.tiltTo; chase.tiltTo = null; }
    chase.target = chaseGoal(size);
    look.pivot = toWorld(chase.target.pivot);
    look.range = chase.target.range;
    aim();
    keepBoardOnScreen(size, { snapped: true });
  }

  // Runs after every draw: keeps the camera on what its mode says.
  function updateCamera() {
    const target = focusedTarget();
    if (!started) {
      // The first real position to look at: the focused board, or a pad.
      const first = target ?? firstPad();
      if (!first) return;
      started = true;
      const pad = firstPad();
      const pivot = cameraMode === 'follow' && target ? target : pad ? abovePad(pad) : first;
      // From far away it flies there. Near the site it glides (or starts
      // there, the first time the view opens over a ground station).
      if (cameraMode === 'whole') {
        moveTo({ pivot, ...startOrbit() }, { animate: false });
        frameEverything({ animate: false });
      } else if (fresh) {
        moveTo({ pivot, ...startOrbit() }, { animate: false });
      } else {
        goTo({ pivot, ...startOrbit() });
      }
      fresh = false;
      return;
    }
    // A flight to the site ends where it was headed. The follow camera
    // glides on from there once it has landed.
    if (flying) return;
    if (cameraMode === 'follow' && target) {
      chaseData(target);
      const size = viewSize();
      if (size && chase.jumped && chase.toLocal) snapToGoal(size);
      // A new fix the easing hasn't reached yet: if it landed outside the
      // free part, the view is nudged now, in the same frame.
      else if (size && chase.free && !chase.glide && !chase.needsGlide) keepBoardOnScreen(size);
      chaseKick();
    } else if (cameraMode === 'whole') {
      if (!framed) {
        frameEverything({ animate: true });
        return;
      }
      // Frame again once something drawn pokes out of what was framed, or
      // the board itself leaves the free part of the view.
      const points = everything();
      if (!points.length) return;
      const sphere = C.BoundingSphere.fromPoints(points);
      const reach = C.Cartesian3.distance(sphere.center, framed.center) + sphere.radius;
      const size = viewSize();
      const s = target && size && !glide ? screenOf(target) : null;
      const free = s ? freeRect(size) : null;
      const out = s && (s.x < free.x0 || s.x > free.x1 || s.y < free.y0 || s.y > free.y1);
      if (reach > framed.radius * 1.1 || out) frameEverything({ animate: true });
    }
  }
  // True until the first view is set on the view's first store. That one
  // starts in place over the ground station (or flies down from the idle
  // view). Later sources always fly or glide.
  let fresh = !waitFar;

  // Zooming or sliding the view in 'whole' means the viewer took over.
  // (Orbiting doesn't: everything stays framed from any side.)
  function leaveWhole() {
    if (cameraMode !== 'whole') return;
    cameraMode = 'free';
    framed = null;
    onChange();
  }

  // ------------------------------------------------------------------
  // A new source (store-switch.js): forget everything from the old store
  // and head for the new one's site.
  // ------------------------------------------------------------------
  function newSource() {
    stopAnimations();
    for (const parts of drawn.values()) removeRocket(parts);
    drawn.clear();
    for (const m of marks) eventIcons.remove(m.icon);
    marks = [];
    marksKey = '';
    if (cross) eventIcons.remove(cross);
    cross = null;
    if (station.icon) groundIcons.remove(station.icon);
    Object.assign(station, { icon: null, position: null, linkEnd: null, ground: null, groundSpot: null, approx: false });
    setLink(null, null);
    spots = [];
    labels?.update([]);
    notesText = '';
    started = false;
    framed = null;
    fresh = false;
    chaseReset();
    cameraMode = followOn ? 'follow' : 'free';
    const gs = store.getGroundStation();
    const s = session();
    const padPoint = s.loading ? s.entry?.summary?.padPoint : null;
    waitFar = !gs;
    if (Array.isArray(padPoint) && Number.isFinite(padPoint[0]) && Number.isFinite(padPoint[1])) {
      // A saved flight is downloading: head for its launch point now. The
      // ground there is only known roughly yet. Seen from far away the
      // globe is drawn from a few big flat pieces, and Cesium can report a
      // spot on the far side as 50 km under the sea, which put the camera
      // inside the Earth. So a height outside GROUND_GUESS_M counts as sea
      // level.
      const ground = scene.globe.getHeight(C.Cartographic.fromDegrees(padPoint[1], padPoint[0]));
      const guess = Number.isFinite(ground) && ground >= GROUND_GUESS_M[0] && ground <= GROUND_GUESS_M[1] ? ground : 0;
      waitFar = false;
      goTo({
        pivot: C.Cartesian3.fromDegrees(padPoint[1], padPoint[0], guess),
        heading: C.Math.toRadians(config.GLOBE_START_HEADING_DEG),
        pitch: C.Math.toRadians(LOADING_PITCH_DEG),
        range: LOADING_RANGE_M,
      });
    } else if (gs) {
      goTo(stationLook(gs));
    } else if (!store.getRockets().some((r) => r.crumbs?.length)) {
      // Nothing to look at (live, nothing connected): back out to the
      // whole Earth.
      flyOut();
    }
    scheduler.schedule();
    onChange();
  }

  // ------------------------------------------------------------------
  // Controls. One finger, or the left mouse button, orbits the camera
  // around the pivot. The wheel or a pinch zooms. Two fingers twisting
  // turn the view. The right mouse button, Shift with a drag, or two
  // fingers dragging slide the view over the ground. Sliding stops
  // following the board. With the mouse it does so at once. With two
  // fingers it only slides once FOLLOW BOARD is off, so a pinch can't
  // switch following off by accident. Turning, tilting and zooming keep
  // following, from the new angle and distance. The arrow keys move the camera
  // around the pivot, and + and - zoom. Nothing keeps moving after the
  // hand lets go. In the idle view (the whole Earth, nothing to look at)
  // the camera stays put.
  // ------------------------------------------------------------------
  const canvas = scene.canvas;
  const DRAG_RATE = C.Math.toRadians(config.GLOBE_ORBIT_DEG_PER_PX);
  const fingers = new Map();   // pointerId -> { x, y, slide }
  let pair = null;             // the last two-finger measurement: { gap, angle, x, y }
  let pairFrame = 0;           // the frame a two-finger update is waiting for

  // A drag to the right pulls the near side of the scene to the right. A
  // drag down pulls it down, so the camera rises.
  function orbitBy(dx, dy) {
    if (idle()) return;
    stopGlide();
    look.heading += dx * DRAG_RATE;
    look.pitch -= dy * DRAG_RATE;
    aim();
    handTurned();
  }

  function zoomBy(factor) {
    if (idle()) return;
    stopGlide();
    look.range *= factor;
    handZoomed(factor);
    leaveWhole();
    aim();
  }

  // While following, a hand on the camera changes the angle or distance
  // the follow camera works with, and it carries on from there.
  function handTurned() {
    if (cameraMode !== 'follow') return;
    chase.headTo = null;
    chase.tiltTo = null;
    chase.target = null;
    chaseKick();
  }

  function handZoomed(factor) {
    if (cameraMode !== 'follow') return;
    chase.zoom = clamp(chase.zoom * factor, 0.01, 100);
    chase.target = null;
    chaseKick();
  }

  // Slides the pivot over the ground, so the ground under the pointer
  // moves with it.
  function slideBy(dx, dy) {
    if (idle()) return;
    stopGlide();
    if (cameraMode === 'follow') {
      cameraMode = 'free';
      onFollowOff();
    }
    leaveWhole();
    const mpp = (2 * look.range * Math.tan(camera.frustum.fovy / 2)) / Math.max(1, canvas.clientHeight);
    const sideways = -dx * mpp;
    // A drag toward the viewer covers more ground the flatter the camera looks.
    const ahead = (dy * mpp) / Math.max(0.35, Math.sin(Math.abs(look.pitch)));
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
  // and (with FOLLOW BOARD off) their shared movement slides it.
  function twoFingers() {
    if (destroyed || fingers.size !== 2 || idle()) return;
    const now = measurePair();
    const last = pair;
    pair = now;
    if (!last) return;
    stopGlide();
    if (last.gap > 0 && now.gap > 0 && last.gap !== now.gap) {
      look.range *= last.gap / now.gap;
      handZoomed(last.gap / now.gap);
      leaveWhole();
    }
    look.heading -= C.Math.negativePiToPi(now.angle - last.angle);
    if (cameraMode === 'follow') {
      aim();
      handTurned();
    } else slideBy(now.x - last.x, now.y - last.y);
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
    if (e.altKey || e.ctrlKey || e.metaKey || idle()) return;
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
    if (e.key.length === 1) {
      leaveWhole();
      handZoomed(e.key === '+' || e.key === '=' ? 1 / config.GLOBE_KEY_ZOOM : config.GLOBE_KEY_ZOOM);
    } else handTurned();
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

  // A new view size (a turned phone, a resized window) fits the idle
  // Earth again, and the board while following it.
  const resizeObserver = 'ResizeObserver' in window
    ? new ResizeObserver(() => {
      if (destroyed || !active) return;
      // The follow camera fits the board into the new size.
      if (cameraMode === 'follow') {
        chase.free = null;
        chase.target = null;
        chaseKick();
      }
      if (idle() && !flying) {
        // Cesium updates the field of view on its next frame. The fit is
        // worked out after that.
        scene.requestRender();
        window.requestAnimationFrame(() => {
          if (!destroyed && idle() && !flying) aim();
        });
      }
    })
    : null;
  resizeObserver?.observe(container);

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
    drawLink(focused);
    // New packets: a ring for each board that got one, and the radio dot.
    for (const rocket of rockets) {
      const parts = drawn.get(rocket.id);
      if (!parts) continue;
      const t = rocket.lastPacketT;
      if (pendingPackets && Number.isFinite(t) && parts.lastPacketT !== null && t > parts.lastPacketT) {
        packetArrived(rocket, parts, focused?.id === rocket.id);
      }
      parts.lastPacketT = Number.isFinite(t) ? t : null;
    }
    pendingPackets = false;
    updateCamera();

    const text = notes().join('|');
    if (text !== notesText) {
      notesText = text;
      onChange();
    }
    scene.requestRender();
  }

  // The notes the map shows while the 3D view is on.
  let notesText = '';
  function notes() {
    const out = [];
    const parts = [...drawn.values()];
    if (parts.some((p) => p.waiting)) out.push('The board shows in 3D once the ground height at its launch point is known.');
    if (parts.some((p) => p.approx) || station.approx || view.terrain === 'failed') out.push('3D ground height is approximate.');
    if (view.imageryFailed) out.push('The 3D imagery didn\'t load, so the ground is plain.');
    return out;
  }

  // Tells map-view.js when the first picture is in, so its loading message
  // can go: the icons and terrain are loaded, no ground height is still
  // being looked up, and the ground in view has drawn. If that takes too
  // long, the view shows as it is.
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

  // Packets that came since the last draw (a 'samples' change that isn't
  // quiet). A seek's changes are quiet, so a seek starts no rings.
  let pendingPackets = false;
  const scheduler = createScheduler(draw, { maxFps: config.MAP_MAX_FPS });
  const unsubscribe = store.subscribe((change) => {
    if (change?.type === 'source') {
      newSource();
      return;
    }
    if (change?.type === 'samples' && !change.quiet) pendingPackets = true;
    scheduler.schedule();
  });
  scheduler.schedule();

  return {
    // The shared FOLLOW BOARD setting.
    setFollow(on) {
      if (destroyed) return;
      followOn = Boolean(on);
      if (on && cameraMode === 'follow') {
        // Already following: nothing to move.
      } else if (on) {
        // Glide over to the board's framing, from the visitor's angle,
        // at the camera's own distance.
        cameraMode = 'follow';
        framed = null;
        chase.zoom = 1;
        chase.target = null;
        chase.needsGlide = true;
        scheduler.schedule();
      } else if (cameraMode === 'follow') {
        // The camera stays where it is.
        cameraMode = 'free';
        window.cancelAnimationFrame(chase.frame);
        chase.frame = 0;
        chase.glide = null;
      }
      scene.requestRender();
    },
    // WHOLE FLIGHT: frame every point drawn so far, the pads and Manta.
    showWholeFlight() {
      if (destroyed) return;
      followOn = false;
      cameraMode = 'whole';
      finishGlide();
      frameEverything({ animate: true });
      scene.requestRender();
    },
    // RESET VIEW: back to the starting angle and distance, on the board
    // while following it, otherwise above the launch pad.
    resetView() {
      if (destroyed) return;
      framed = null;
      const target = focusedTarget();
      if (cameraMode === 'follow' && target) {
        // The follow camera eases back to the starting angle, at its own
        // distance.
        const start = startOrbit();
        chase.zoom = 1;
        chase.target = null;
        chase.headTo = start.heading;
        chase.tiltTo = start.pitch;
        chaseKick();
      } else {
        if (cameraMode === 'whole') cameraMode = 'free';
        const pad = firstPad();
        const spot = pad ? abovePad(pad) : target ?? station.position;
        if (spot) moveTo({ pivot: spot, ...startOrbit() }, { animate: true });
      }
      scene.requestRender();
    },
    cameraMode: () => cameraMode,
    // The HUD around the view changed size: while following, the board is
    // kept clear of it at once (map-view.js calls this before the frame is
    // painted), and the follow camera frames it again.
    coversChanged() {
      if (destroyed || !active || cameraMode !== 'follow' || !chase.boardWorld) return;
      const size = viewSize();
      if (!size) return;
      chase.free = freeRect(size);
      chase.freeAt = performance.now();
      chase.target = null;
      if (!chase.glide || chase.glide.keep) keepBoardOnScreen(size);
      chaseKick();
    },
    notes,
    // The HUD around the view changed size: the idle Earth fits itself to
    // the free part again.
    relayout() {
      if (destroyed || !active || !idle() || flying || glide) return;
      const key = idleKeyNow();
      if (key === idleKey) return;
      idleKey = key;
      aimIdle();
    },
    // For the tests: every point WHOLE FLIGHT frames, on screen right now
    // (canvas px), and the free part of the view it aims for.
    debugFit() {
      const all = everything();
      return {
        points: all.map((p) => screenOf(p) ?? scene.cartesianToCanvasCoordinates(p) ?? null).map((p) => (p ? { x: p.x, y: p.y } : null)),
        insets: freeInsets?.() ?? null,
        width: scene.canvas.clientWidth,
        height: scene.canvas.clientHeight,
        moving: Boolean(glide || flying),
      };
    },
    // For the tests: where the camera is and where the focused board shows
    // on screen (canvas px), with the free part of the view FOLLOW BOARD
    // keeps it in.
    debugCamera() {
      const target = focusedTarget();
      const size = viewSize();
      const s = target ? screenOf(target) : null;
      const p = camera.positionWC;
      const d = camera.directionWC;
      return {
        mode: cameraMode,
        board: s ? { x: s.x, y: s.y } : null,
        free: size ? freeRect(size) : null,
        width: scene.canvas.clientWidth,
        height: scene.canvas.clientHeight,
        camera: [p.x, p.y, p.z],
        dir: [d.x, d.y, d.z],
        up: [camera.upWC.x, camera.upWC.y, camera.upWC.z],
        idleBottom: options.idleBottom?.() ?? null,
        range: look.range,
        heading: look.heading,
        pitch: look.pitch,
        f: size?.f ?? null,
        moving: Boolean(glide || flying || chase.frame),
        flight: flight ? { length: flight.path.length, ms: flight.duration } : null,
      };
    },
    // For the tests: how many things are drawn, so a test can check that a
    // new source leaves nothing behind.
    debugCounts() {
      let dots = 0;
      let chunks = 0;
      let breaks = 0;
      for (const parts of drawn.values()) {
        dots += parts.dots?.length ?? 0;
        chunks += parts.chunks.length;
        // Places the line starts again after a gap (the first point not counted).
        breaks += parts.verts.filter((v, i) => i > 0 && v.breakBefore).length;
      }
      return {
        rockets: drawn.size, dots, chunks, breaks,
        halos: haloLayer.length, lines: lineLayer.length, dotSets: dotLayer.length,
        shadows: scene.groundPrimitives.length, links: linkLines.length,
        groundIcons: groundIcons.length, eventIcons: eventIcons.length, boards: rocketIcons.length + focusIcons.length,
        spots: spots.length, cameraMode, started,
        packets: packetsSeen,
        ringsMoving: [...drawn.values()].filter((p) => p.ringStart !== null).length,
        travelMoving: Boolean(travelRun),
      };
    },
    // Paused while the map is showing instead: nothing is drawn and
    // Cesium's own loop stops. Coming back catches up from the store.
    setActive(on) {
      if (destroyed || active === on) return;
      active = on;
      if (!on) {
        finishGlide();
        stopAnimations();
        window.cancelAnimationFrame(chase.frame);
        chase.frame = 0;
        chase.last = 0;
      }
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
      clearTimeout(laterTimer);
      resizeObserver?.disconnect();
      stopWatchingReady();
      stopPreRender();
      stopPostRender();
      stopGlide();
      stopAnimations();
      window.cancelAnimationFrame(pairFrame);
      window.cancelAnimationFrame(chase.frame);
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
        spots = [];
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
