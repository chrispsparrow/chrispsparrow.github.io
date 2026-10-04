// globe-view.js
// The 3D view: the same flight as the map, drawn on Cesium's globe with
// real terrain and aerial imagery. It shows every rocket's trail, a thin
// line from the focused rocket straight down to the ground, the launch
// rail, the ground station, a dashed line from the ground station to the
// focused rocket with the straight-line distance, and a marker in the sky
// at the focused rocket's apogee, drogue, main and landing, and at any
// event its board reported.
//
// The same honesty rules as the map apply:
//   - Only good GPS positions are drawn. Across a gap the trail is dashed.
//   - The rocket moves from one real data point to the next. Nothing is
//     smoothed or filled in between packets.
//   - The rocket icon always points straight up. No board sends
//     orientation data, so it never turns.
//   - With no GPS fix the icon turns grey and hollow at the last good
//     position, and the label says why and for how long.
//   - Event markers only appear once playback has reached the event, and
//     their labels say how each one was found.
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
// Camera. Cesium's own mouse and touch controls are made for spinning a
// whole globe, and up close they turn far too fast. They are switched off,
// and this file has its own: drag to orbit around what the camera looks
// at, the wheel or a pinch to zoom, and the right button or two fingers to
// slide the view (see "Controls" near the end).
//
// Rendering. The scene only redraws when something changes (Cesium's
// requestRenderMode), which saves battery. Every change here ends with
// scene.requestRender().
//
// Used by: map-view.js, which loads Cesium first and owns the buttons.
// Reads the store, never other views.

import { createScheduler, prefersReducedMotion, eventMarkerKind } from './dom.js';
import { distanceM, formatDistance, formatRounded10 } from '../geo.js';
import { rocketSvg, rocketBox, padSvg, PAD_SIZE, PAD_ANCHOR, towerSvg, TOWER_SIZE, TOWER_ANCHOR } from './icons.js';
import { rocketHudLine } from './hud-text.js';

// The fix-gap line: gold dashes on a dark line, so it reads as dashed
// against the sky and the ground alike. The pattern is 16 bits spread over
// DASH_PX screen pixels (a 1 is gold).
const GAP_DASH_PX = 14;
const GAP_DASH_BITS = 0b1111110000000000;
// The ground station line: longer teal dashes.
const GS_DASH_PX = 14;
const GS_DASH_BITS = 0b1111111110000000;
const GS_LINE_OPACITY = 0.95;
const GS_LINE_STALE_OPACITY = 0.4;
// How dark the space between dashes is.
const DASH_GAP_OPACITY = 0.5;
// Space (px) between an icon and its label, and how far under or over an
// icon a label sits when neither side has room.
const LABEL_GAP_PX = 8;
const LABEL_STACK_PX = 4;
// Padding (px) inside a label's dark backing.
const TAG_PAD_X = 6;
const TAG_PAD_Y = 3;
// Label outline width, in Cesium's own glyph units. 4 is about 1 px at
// this text size, and the most it can draw cleanly is just under 6.
const LABEL_OUTLINE = 4;
// Choosing a label's side: each px² of label off the view or under a
// panel counts this many times more than a px² on top of another label.
const HIDDEN_LABEL_COST = 10;
// A label that can't be shown without this share of it hidden or on top of
// something stays out of sight until it has room (the icon stays).
const LABEL_HIDE_SHARE = 0.25;
// Launch pads closer than this on screen (px) share one label.
const PAD_LABEL_MERGE_PX = 40;
// Event marker size (px).
const EVENT_MARK_PX = 14;
// Sonar ring sizes (px) around a rocket with a good fix, as on the map.
const RING_FOCUSED_PX = 76;
const RING_PX = 46;
// The bottom of the drop line (m). It is well under any ground on Earth,
// and the terrain hides the part below the surface.
const DROP_BOTTOM_M = -1000;
// What each event is called in its sky label.
const EVENT_WORDS = { apogee: 'Apogee', drogue: 'Drogue', main: 'Main', landed: 'Landing' };
// How long (ms) to wait for the label fonts before drawing without them.
const FONT_WAIT_MS = 3000;
// A ground station whose GPS position wanders keeps the ground height it
// had while it stays within this far (m) of where that height was looked
// up. A real move (from the demo position to its own) waits for its own.
const STATION_KEEP_M = 100;

export function createGlobeView(container, ctx, options) {
  const { Cesium: C, credits, dialogs, covers, onReady, onChange, onFail, onFollowOff } = options;
  const { store, config } = ctx;
  const prescan = ctx.prescan instanceof Map ? ctx.prescan : new Map();

  // ------------------------------------------------------------------
  // Colors and fonts, from the page's own design tokens (the CSS
  // variables at the top of flight-console.css).
  // ------------------------------------------------------------------
  const styles = getComputedStyle(container);
  const token = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  const rgba = (css, alpha = 1) => C.Color.fromCssColorString(css).withAlpha(alpha);
  const HUD = token('--fc-hud', '#4dff7a');
  const HUD_2 = token('--fc-hud-2', '#b4ffc6');
  const HUD_DARK = token('--fc-hud-outline', '#04140a');
  const CORAL = token('--fc-coral', '#e07a5f');
  const TEXT = token('--fc-text', '#e8e6df');
  const MUTED = token('--fc-muted', '#9aa3b5');
  const PAGE = token('--fc-bg', '#0a0f1a');
  const hudFamily = token('--fc-font-hud', '"Share Tech Mono", monospace');
  const textFamily = token('--fc-font-text', 'sans-serif');
  const hudFont = (px) => `${px}px ${hudFamily}`;
  const textFont = `600 12px ${textFamily}`;

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
  // Terrain hides what is behind or under it. The drop line relies on this
  // to end at the ground. Icons and labels are never hidden (see ALWAYS).
  scene.globe.depthTestAgainstTerrain = true;
  // The ground's color where there is no imagery.
  scene.globe.baseColor = rgba('#1a2233');
  scene.backgroundColor = rgba(PAGE);
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
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
  // What is drawn. Lines first, then icons, then labels, so labels end up
  // on top. Within the icons and labels, whatever was added last is drawn
  // on top.
  // ------------------------------------------------------------------
  const trails = scene.primitives.add(new C.PolylineCollection());     // rocket trails (they grow)
  const lines = scene.primitives.add(new C.PolylineCollection());      // the drop line and the ground station line
  const blend = { blendOption: C.BlendOption.TRANSLUCENT };
  const groundIcons = scene.primitives.add(new C.BillboardCollection(blend)); // launch rails and the ground station
  const eventIcons = scene.primitives.add(new C.BillboardCollection(blend));
  const rocketIcons = scene.primitives.add(new C.BillboardCollection(blend));
  const focusIcons = scene.primitives.add(new C.BillboardCollection(blend));  // the focused rocket, on top
  const labels = scene.primitives.add(new C.LabelCollection(blend));

  // Icons and labels keep one size on screen, shrink a little from far
  // away, and are never hidden behind terrain.
  const farScale = new C.NearFarScalar(config.GLOBE_ICON_NEAR_M, 1, config.GLOBE_ICON_FAR_M, config.GLOBE_ICON_FAR_SCALE);
  const ALWAYS = { scaleByDistance: farScale, disableDepthTestDistance: Number.POSITIVE_INFINITY };

  // The size Cesium draws an icon or label at, for a point this far from
  // the camera (the same math as its own scaleByDistance).
  function distanceScale(position) {
    const d2 = C.Cartesian3.distanceSquared(camera.positionWC, position);
    const near2 = farScale.near * farScale.near;
    const far2 = farScale.far * farScale.far;
    const t = Math.min(1, Math.max(0, (d2 - near2) / (far2 - near2))) ** 0.2;
    return farScale.nearValue + (farScale.farValue - farScale.nearValue) * t;
  }

  // In requestRenderMode a new icon image or a letter drawn for the first
  // time only shows a frame or two after it was asked for, so a few extra
  // frames are requested then.
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
  // Icons. The page's own SVG drawings (icons.js) are turned into small
  // canvases once, since Cesium draws images, not SVG. Each canvas is
  // drawn at the screen's pixel ratio so it stays sharp, with the spot
  // that sits on the position (the anchor) in its middle.
  // ------------------------------------------------------------------
  const iconScale = Math.ceil(pixelRatio);
  const icons = new Map(); // image id -> { canvas, width, height }

  // The grey, hollow look of a rocket with no GPS fix (the same rules as
  // the map's .fc-rkt--nofix styles).
  const HOLLOW_STYLE = `<style>.fc-rkt-halo{fill:${PAGE};fill-opacity:.92;stroke-width:3.6}` +
    `.fc-rkt-body{fill:none;stroke:${MUTED};stroke-width:1.5}.fc-rkt-fins,.fc-rkt-nozzle{display:none}` +
    `.fc-rkt-window{fill:none;stroke:${MUTED};stroke-width:1.2}</style>`;

  // Draws SVG markup into a canvas of w by h px, with the drawing's top
  // left corner at (x, y). before(g) can draw under it first.
  async function svgIcon(id, markup, [iconW, iconH], { width = iconW, height = iconH, x = 0, y = 0, style = '', before = null } = {}) {
    // A standalone SVG image needs its namespace, and its size in screen pixels.
    const svgText = markup
      .replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" ')
      .replace(/width="[\d.]+" height="[\d.]+"/, `width="${iconW * iconScale}" height="${iconH * iconScale}"`)
      .replace('>', `>${style}`);
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
    before?.(g);
    g.drawImage(image, x, y, iconW, iconH);
    icons.set(id, { canvas, width, height });
  }

  // Three still rings around a rocket with a good fix, like the map's
  // resting rings (they don't pulse here: the scene only redraws on new data).
  function drawRings(g, size, strength) {
    const c = size / 2;
    [[0.5, 0.95], [0.76, 0.6], [1, 0.3]].forEach(([scale, opacity]) => {
      const lineWidth = 2.5 * scale;
      const radius = (size / 2) * scale - lineWidth / 2;
      g.beginPath();
      g.arc(c, c, radius, 0, Math.PI * 2);
      g.lineWidth = lineWidth + 3 * scale;
      g.strokeStyle = `rgba(4, 8, 15, ${0.5 * opacity * strength})`;
      g.stroke();
      g.lineWidth = lineWidth;
      g.globalAlpha = opacity * strength;
      g.strokeStyle = config.TRACK_COLOR;
      g.stroke();
      g.globalAlpha = 1;
    });
  }

  function rocketIcon(id, px, { hollow, ring, strength }) {
    const box = rocketBox(px);
    if (hollow) return svgIcon(id, rocketSvg(px), box, { style: HOLLOW_STYLE });
    return svgIcon(id, rocketSvg(px), box, {
      width: ring, height: ring, x: (ring - box[0]) / 2, y: (ring - box[1]) / 2,
      before: (g) => drawRings(g, ring, strength),
    });
  }

  // An icon whose anchor isn't its middle gets empty room on one side, so
  // the anchor ends up in the middle of the canvas.
  function anchoredIcon(id, markup, size, anchor) {
    const width = 2 * Math.max(anchor[0], size[0] - anchor[0]);
    const height = 2 * Math.max(anchor[1], size[1] - anchor[1]);
    return svgIcon(id, markup, size, { width, height, x: width / 2 - anchor[0], y: height / 2 - anchor[1] });
  }

  // Event markers, drawn the way the altitude timeline draws them: a
  // filled dot for reported, a gold ring for detected, a dashed ring for
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
    rocketIcon('rocket-focus', config.ROCKET_ICON_FOCUSED_PX, { ring: RING_FOCUSED_PX, strength: 1 }),
    rocketIcon('rocket-focus-hollow', config.ROCKET_ICON_FOCUSED_PX, { hollow: true }),
    rocketIcon('rocket', config.ROCKET_ICON_PX, { ring: RING_PX, strength: 0.5 }),
    rocketIcon('rocket-hollow', config.ROCKET_ICON_PX, { hollow: true }),
    anchoredIcon('pad', padSvg(), PAD_SIZE, PAD_ANCHOR),
    anchoredIcon('tower', towerSvg(), TOWER_SIZE, TOWER_ANCHOR),
  ]).then(() => ['reported', 'detected', 'inferred'].forEach(eventIcon));

  // Cesium draws each letter once and keeps it, so the label fonts have to
  // be loaded before the first label is made.
  const fontsReady = Promise.race([
    Promise.all([
      document.fonts?.load?.(`400 48px ${hudFamily}`),
      document.fonts?.load?.(`600 48px ${textFamily}`),
    ]),
    new Promise((resolve) => { setTimeout(resolve, FONT_WAIT_MS); }),
  ]).catch(() => null);

  let assetsReady = false;
  Promise.all([iconsReady, fontsReady]).then(() => {
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
  // Labels. A tag is one or two lines of text on a dark backing, next to
  // an icon. Cesium draws one color per label, so a two-line tag is two
  // labels stacked: the first sits on top of the anchor line and the
  // second hangs under it. Both are padded to the same width, so their
  // backings read as one box.
  // ------------------------------------------------------------------
  const measureCanvas = document.createElement('canvas').getContext('2d');
  const widthCache = new Map();
  function textWidth(font, text) {
    let total = 0;
    measureCanvas.font = font;
    for (const ch of text) {
      const key = `${font}|${ch}`;
      let w = widthCache.get(key);
      if (w === undefined) {
        w = measureCanvas.measureText(ch).width;
        widthCache.set(key, w);
      }
      total += w;
    }
    return total;
  }
  const fontPx = (font) => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 12);

  // Cesium draws each letter once per font and per vertical anchor, and a
  // letter drawn for the first time only shows a frame or two later. So a
  // tag whose text has such a letter asks for those extra frames.
  const drawnGlyphs = new Set();
  function warmGlyphs(tag) {
    tag.labels.forEach((label, i) => {
      for (const ch of label.text) {
        const key = `${tag.fonts[i]}|${label.verticalOrigin}|${ch}`;
        if (drawnGlyphs.has(key)) continue;
        drawnGlyphs.add(key);
        pump();
      }
    });
  }

  const tags = new Set();

  // Makes a tag. lines is [{ font, color, alpha }], one per line.
  //   sides     where the tag may sit around its icon, usual side first
  //   icon      the icon's reach from the position: { left, right, up, down } px
  //   lift      how far (px) above the position the tag's middle sits beside the icon
  //   optional  true if the tag may hide when it has no clear place
  function makeTag(position, lines, { sides, icon, lift = 0, backing = HUD_DARK, optional = false, order = 0 }) {
    const two = lines.length === 2;
    const tag = {
      position, sides, icon, lift, optional, order, two,
      side: null, wanted: true, placed: true, shown: true, w: 0, texts: lines.map(() => ''),
      labels: lines.map((line, i) => labels.add({
        position,
        text: '',
        font: line.font,
        fillColor: rgba(line.color, line.alpha ?? 1),
        outlineColor: rgba(backing, line.alpha ?? 1),
        outlineWidth: LABEL_OUTLINE,
        style: C.LabelStyle.FILL_AND_OUTLINE,
        showBackground: true,
        backgroundColor: rgba(backing, 0.88 * (line.alpha ?? 1)),
        backgroundPadding: new C.Cartesian2(TAG_PAD_X, TAG_PAD_Y),
        horizontalOrigin: C.HorizontalOrigin.LEFT,
        verticalOrigin: !two ? C.VerticalOrigin.CENTER : i === 0 ? C.VerticalOrigin.BOTTOM : C.VerticalOrigin.TOP,
        ...ALWAYS,
      })),
      heights: lines.map((line) => Math.round(fontPx(line.font) * 1.05) + 2 * TAG_PAD_Y),
      fonts: lines.map((line) => line.font),
    };
    tags.add(tag);
    return tag;
  }

  // Sets a tag's text. Lines are padded with spaces to one width (the HUD
  // font gives every letter the same width).
  function setTagText(tag, texts) {
    if (texts.every((t, i) => t === tag.texts[i])) return;
    tag.texts = texts.slice();
    const widths = texts.map((t, i) => textWidth(tag.fonts[i], t));
    const widest = Math.max(...widths);
    tag.labels.forEach((label, i) => {
      const space = textWidth(tag.fonts[i], ' ');
      const pad = space > 0 ? Math.round((widest - widths[i]) / space) : 0;
      // A line with nothing to say stays empty, so it gets no backing.
      label.text = texts[i] ? texts[i] + ' '.repeat(Math.max(0, pad)) : '';
    });
    tag.w = widest > 0 ? widest + 2 * TAG_PAD_X : 0;
    warmGlyphs(tag);
  }

  // Shows a two-line tag as one line (its second line has nothing to say)
  // or as two again.
  function setTagLines(tag, two) {
    if (tag.two === two) return;
    tag.two = two;
    tag.labels[0].verticalOrigin = two ? C.VerticalOrigin.BOTTOM : C.VerticalOrigin.CENTER;
    tag.sideKey = null;
    warmGlyphs(tag);
  }

  function setTagPosition(tag, position) {
    tag.position = position;
    for (const label of tag.labels) label.position = position;
  }

  function removeTag(tag) {
    if (!tag) return;
    for (const label of tag.labels) labels.remove(label);
    tags.delete(tag);
  }

  // Where a tag's box would be on screen for each side, around screen
  // point p, at scale f.
  function tagBox(tag, side, p, f) {
    const w = tag.w * f;
    const h1 = tag.heights[0] * f;
    const h = h1 + (tag.two ? tag.heights[1] * f : 0);
    let left;
    let top;
    if (side === 'right' || side === 'left') {
      left = side === 'right' ? p.x + tag.icon.right + LABEL_GAP_PX : p.x - tag.icon.left - LABEL_GAP_PX - w;
      top = p.y - tag.lift - (tag.two ? h1 : h1 / 2);
    } else {
      left = p.x - w / 2;
      top = side === 'below' ? p.y + tag.icon.down + LABEL_STACK_PX : p.y - tag.icon.up - LABEL_STACK_PX - h;
    }
    return { left, top, right: left + w, bottom: top + h };
  }

  // Moves a tag's labels to a side. Their anchor line is the tag's middle
  // (one line) or the join between its two lines.
  function applySide(tag, side, f) {
    const HO = C.HorizontalOrigin;
    const h1 = tag.heights[0] * f;
    const h2 = tag.two ? tag.heights[1] * f : 0;
    let origin;
    let x;
    let y;
    if (side === 'right') { origin = HO.LEFT; x = tag.icon.right + LABEL_GAP_PX; y = -tag.lift; }
    else if (side === 'left') { origin = HO.RIGHT; x = -tag.icon.left - LABEL_GAP_PX; y = -tag.lift; }
    else if (side === 'below') { origin = HO.CENTER; x = 0; y = tag.icon.down + LABEL_STACK_PX + (tag.two ? h1 : h1 / 2); }
    else { origin = HO.CENTER; x = 0; y = -(tag.icon.up + LABEL_STACK_PX + (tag.two ? h2 : h1 / 2)); }
    const key = `${side}|${Math.round(x)}|${Math.round(y)}`;
    if (tag.sideKey === key) return;
    tag.sideKey = key;
    tag.side = side;
    for (const label of tag.labels) {
      label.horizontalOrigin = origin;
      label.pixelOffset = new C.Cartesian2(Math.round(x), Math.round(y));
    }
  }

  function showTag(tag, show) {
    tag.shown = show;
    for (const label of tag.labels) if (label.show !== show) label.show = show;
  }

  // How much of box b (px²) is off the view (closer than 4 px to its edge
  // counts as off) or under a panel, times hiddenCost, plus how much of it
  // sits on another label or icon.
  function labelCost(b, covered, taken, size, hiddenCost = HIDDEN_LABEL_COST) {
    const overlap = (a, c) => Math.max(0, Math.min(a.right, c.right) - Math.max(a.left, c.left)) *
      Math.max(0, Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top));
    const frame = { left: 4, top: 4, right: size.x - 4, bottom: size.y - 4 };
    return hiddenCost * ((b.right - b.left) * (b.bottom - b.top) - overlap(b, frame) +
      covered.reduce((sum, c) => sum + overlap(b, c), 0)) +
      taken.reduce((sum, t) => sum + overlap(b, t), 0);
  }

  // Runs before every drawn frame, once the camera is final for it: gives
  // every tag a side where it can be read. A tag goes on its usual side
  // unless that would run off the view, under a panel or into another tag
  // or icon, and another side wouldn't. The focused rocket's tag goes
  // first, then the other rockets, the ground station, the launch points,
  // the event markers and the distance label. Only the focused rocket's
  // tag and the ground station's always show. Any other tag with no clear
  // place stays out of sight until it has one.
  let covered = [];
  function placeTags() {
    if (destroyed || !tags.size) return;
    const size = { x: scene.canvas.clientWidth, y: scene.canvas.clientHeight };
    if (size.x < 1 || size.y < 1) return;
    // The panels and controls over the view, measured once for this frame.
    covered = covers();
    const taken = [];
    const ordered = [...tags].sort((a, b) => a.order - b.order);
    const at = new Map();

    // The icons themselves count as taken, so no tag sits on another icon.
    // (The distance label finds its own place along its line afterwards.)
    for (const tag of ordered) {
      if (tag.along) continue;
      const p = tag.wanted ? C.SceneTransforms.worldToWindowCoordinates(scene, tag.position) : undefined;
      at.set(tag, p);
      if (!p) continue;
      const f = distanceScale(tag.position);
      taken.push({ left: p.x - tag.icon.left * f, right: p.x + tag.icon.right * f, top: p.y - tag.icon.up * f, bottom: p.y + tag.icon.down * f });
    }

    const padSpots = [];
    for (const tag of ordered) {
      if (tag.along) continue;
      const p = at.get(tag);
      // Behind the camera, off the view, or nothing to say.
      if (!p || !tag.w || p.x < 0 || p.y < 0 || p.x > size.x || p.y > size.y) {
        showTag(tag, false);
        continue;
      }
      // Launch pads close together share one label.
      if (tag.pad) {
        if (padSpots.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < PAD_LABEL_MERGE_PX)) {
          showTag(tag, false);
          continue;
        }
        padSpots.push(p);
      }
      const f = distanceScale(tag.position);
      const boxes = Object.fromEntries(tag.sides.map((side) => [side, tagBox(tag, side, p, f)]));
      const scores = Object.fromEntries(tag.sides.map((side) => [side, labelCost(boxes[side], covered, taken, size)]));
      let side = tag.sides[0];
      if (scores[side] !== 0) {
        if (tag.side && scores[tag.side] === 0) side = tag.side;
        else {
          const best = tag.sides.reduce((a, b) => (scores[b] < scores[a] ? b : a));
          // A clearly better place only, so a tag doesn't flicker between two bad ones.
          side = !tag.side || !(tag.side in scores) || scores[best] < scores[tag.side] * 0.8 ? best : tag.side;
        }
      }
      const box = boxes[side];
      if (tag.optional) {
        const share = labelCost(box, covered, taken, size, 1) / Math.max(1, (box.right - box.left) * (box.bottom - box.top));
        // Out of sight once too much of it would be hidden, back once
        // nearly all of it would show (so it doesn't blink at the limit).
        tag.placed = share <= (tag.placed ? LABEL_HIDE_SHARE : 0.02);
        if (!tag.placed) {
          showTag(tag, false);
          continue;
        }
      }
      applySide(tag, side, f);
      showTag(tag, true);
      taken.push(box);
    }
  }
  const stopPlacing = scene.preRender.addEventListener(placeTags);

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
        track: null,      // the store's track array this trail was built from
        key: '',          // the height model, ground level and focus it was built with
        count: 0,         // track points looked at so far
        positions: [],    // one 3D position per track point, null if it has no height
        last: -1,         // index of the last point drawn
        pendingGap: false,
        run: null,        // the solid line being extended: { line, positions }
        lines: [],        // every line of the trail
        focused: null,
        icon: null, tag: null, pad: null, padTag: null,
        ground: null,     // the last ground height looked up for this rocket's pad
        old: false,       // the icon sits at an older point than the newest good position
        approx: false, waiting: false,
      };
      drawn.set(rocket.id, parts);
    }
    return parts;
  }

  function clearTrail(parts) {
    for (const line of parts.lines) trails.remove(line);
    parts.lines = [];
    parts.run = null;
    parts.positions = [];
    parts.count = 0;
    parts.last = -1;
    parts.pendingGap = false;
  }

  function removeRocket(parts) {
    clearTrail(parts);
    if (parts.icon) parts.iconHome.remove(parts.icon);
    if (parts.pad) groundIcons.remove(parts.pad);
    removeTag(parts.tag);
    removeTag(parts.padTag);
    parts.icon = null;
    parts.pad = null;
    parts.padAt = null;
    parts.tag = null;
    parts.padTag = null;
  }

  // The look of a rocket's trail: gold and thicker for the focused rocket,
  // its own color and thinner for the others, each with a dark outline.
  // (The outline width counts both sides and comes out of the line's width.)
  function trailLine(rocket, isFocused, positions) {
    const halo = rgba(config.HALO_COLOR, config.HALO_OPACITY);
    return trails.add({
      positions,
      width: isFocused ? 6 : 4,
      material: C.Material.fromType('PolylineOutline', {
        color: isFocused ? rgba(config.TRACK_COLOR, 0.95) : rgba(rocket.profile.color, 0.8),
        outlineColor: halo,
        outlineWidth: isFocused ? 2.5 : 2,
      }),
    });
  }

  // A dashed line across a gap: nobody measured the path in between.
  function gapLine(rocket, isFocused, from, to) {
    return trails.add({
      positions: [from, to],
      width: 2,
      material: C.Material.fromType('PolylineDash', {
        color: isFocused ? rgba(config.TRACK_COLOR, 0.95) : rgba(rocket.profile.color, 0.8),
        gapColor: rgba(config.HALO_COLOR, DASH_GAP_OPACITY),
        dashLength: GAP_DASH_PX,
        dashPattern: GAP_DASH_BITS,
      }),
    });
  }

  function drawRocket(rocket, isFocused) {
    const parts = partsFor(rocket);
    const model = heightModel(rocket, parts);
    const ground = rocket.derived?.groundRef;
    // Anything that changes where points go, or how the trail looks, means
    // building the trail again: a seek (the store hands out a new track), a
    // different height model, a ground level that moved (it settles while
    // the rocket sits on the pad and is frozen at liftoff), or a new focus.
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

    // Trail: new points since the last draw. A gap starts a dashed line
    // from the last point before it to the first point after it. As on
    // the map there are two kinds: the GPS had no fix (gapBefore), or no
    // position arrived for longer than LINK_STALE_S. A point with no
    // height known is left out, which also makes a gap.
    if (model.kind !== 'wait') {
      const track = rocket.track;
      // Hands a solid run's points to Cesium. A line needs two points, and
      // Cesium only notices new points when the list is handed over again.
      const finishRun = () => {
        const run = parts.run;
        if (!run || !run.grew || run.positions.length < 2) return;
        run.grew = false;
        if (run.line) run.line.positions = run.positions;
        else {
          run.line = trailLine(rocket, isFocused, run.positions);
          parts.lines.push(run.line);
        }
      };
      for (let i = parts.count; i < track.length; i++) {
        const p = track[i];
        const position = pointPosition(rocket, model, p);
        parts.positions.push(position);
        if (!position) {
          parts.pendingGap = true;
          continue;
        }
        const prev = parts.last >= 0 ? track[parts.last] : null;
        if (prev && (p.gapBefore || p.t - prev.t > config.LINK_STALE_S || parts.pendingGap)) {
          finishRun();
          parts.lines.push(gapLine(rocket, isFocused, parts.positions[parts.last], position));
          parts.run = null;
        }
        if (!parts.run) parts.run = { line: null, positions: [], grew: false };
        parts.run.positions.push(position);
        parts.run.grew = true;
        parts.pendingGap = false;
        parts.last = i;
      }
      parts.count = track.length;
      finishRun();
    }

    drawPad(rocket, parts, model);
    drawRocketIcon(rocket, parts, isFocused);
  }

  // The rocket icon at the last trail point that has a height. That is
  // usually its last good position: off-white with rings while the fix is
  // good, grey and hollow with no fix or when the newest position has no
  // height yet. It is a billboard with no rotation, so it always stands
  // straight up on screen.
  function drawRocketIcon(rocket, parts, isFocused) {
    const position = parts.last >= 0 ? parts.positions[parts.last] : null;
    if (!position) {
      if (parts.icon) parts.icon.show = false;
      if (parts.tag) parts.tag.wanted = false;
      return;
    }
    const hud = rocketHudLine(store, config, rocket);
    // The newest good position may have no height yet (a barometer that
    // went quiet), so the icon is still at an older point. It then looks
    // like any other old position: grey and hollow.
    parts.old = parts.last !== rocket.track.length - 1;
    const id = `rocket${isFocused ? '-focus' : ''}${hud.warn || parts.old ? '-hollow' : ''}`;
    const [w, h] = rocketBox(isFocused ? config.ROCKET_ICON_FOCUSED_PX : config.ROCKET_ICON_PX);
    if (!parts.icon) {
      parts.iconHome = isFocused ? focusIcons : rocketIcons;
      parts.icon = addIcon(parts.iconHome, id, position);
      // Other rockets get a smaller, dimmer tag. Both lines share one text
      // size, so their backings come out the same width.
      const alpha = isFocused ? 1 : 0.74;
      const font = hudFont(isFocused ? 12 : 11);
      parts.tag = makeTag(position, [{ font, color: HUD, alpha }, { font, color: HUD_2, alpha }], {
        sides: ['right', 'left', 'below', 'above'],
        icon: { left: w / 2, right: w / 2, up: h / 2, down: h / 2 },
        // Rockets flying close together can leave no room for every tag.
        // The focused rocket's always shows. Another rocket's steps aside
        // until it has room (its icon stays).
        optional: !isFocused,
        order: isFocused ? 0 : 1,
      });
    }
    parts.icon.show = true;
    parts.icon.position = position;
    setIcon(parts.icon, id);
    // The same words as the map's label: the name, then height above
    // ground and vertical speed, or why the position is old.
    const line2 = [hud.altKey, hud.alt].filter(Boolean).join(' ') + (hud.speed ? `  VS ${hud.speed}` : '');
    setTagText(parts.tag, [rocket.profile.callsign, line2]);
    setTagPosition(parts.tag, position);
    parts.tag.wanted = true;
    const line2Color = rgba(hud.warn ? CORAL : HUD_2, isFocused ? 1 : 0.74);
    if (!C.Color.equals(parts.tag.labels[1].fillColor, line2Color)) parts.tag.labels[1].fillColor = line2Color;
  }

  // The launch rail on the pad: the last good position before liftoff, on
  // the ground height looked up for it.
  function drawPad(rocket, parts, model) {
    const pad = rocket.padPosition;
    const height = !pad || model.kind === 'wait' ? null : model.kind === 'ground' ? model.base : pad.altMsl;
    if (!Number.isFinite(height)) {
      if (parts.pad) parts.pad.show = false;
      if (parts.padTag) parts.padTag.wanted = false;
      return;
    }
    const position = C.Cartesian3.fromDegrees(pad.lon, pad.lat, height);
    if (!parts.pad) {
      parts.pad = addIcon(groundIcons, 'pad', position);
      parts.padTag = makeTag(position, [{ font: hudFont(12), color: HUD }], {
        sides: ['left', 'right', 'below'],
        icon: { left: PAD_ANCHOR[0], right: PAD_SIZE[0] - PAD_ANCHOR[0], up: PAD_ANCHOR[1], down: PAD_SIZE[1] - PAD_ANCHOR[1] },
        lift: 10,
        optional: true,
        order: 3,
      });
      parts.padTag.pad = true;
      setTagText(parts.padTag, ['LAUNCH POINT']);
    }
    parts.pad.show = true;
    parts.pad.position = position;
    setTagPosition(parts.padTag, position);
    parts.padTag.wanted = true;
    parts.padAt = position;
  }

  // ------------------------------------------------------------------
  // Drawing: the ground station, its line to the focused rocket, the drop
  // line and the event markers
  // ------------------------------------------------------------------
  const station = { icon: null, tag: null, position: null, ground: null, groundSpot: null, approx: false };

  function drawStation() {
    const gs = store.getGroundStation();
    let height = null;
    station.approx = false;
    if (view.terrain === 'failed') {
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
      if (station.tag) station.tag.wanted = false;
      return;
    }
    const position = C.Cartesian3.fromDegrees(gs.lon, gs.lat, height);
    station.position = position;
    if (!station.icon) {
      station.icon = addIcon(groundIcons, 'tower', position);
      station.tag = makeTag(position, [{ font: hudFont(12), color: HUD }, { font: hudFont(12), color: HUD_2 }], {
        sides: ['right', 'left', 'below'],
        icon: { left: TOWER_ANCHOR[0], right: TOWER_SIZE[0] - TOWER_ANCHOR[0], up: TOWER_ANCHOR[1], down: TOWER_SIZE[1] - TOWER_ANCHOR[1] },
        lift: 14,
        order: 2,
      });
    }
    station.icon.show = true;
    station.icon.position = position;
    setTagPosition(station.tag, position);
    station.tag.wanted = true;
    // An honesty note, as on the map: the tower sits at a made-up spot
    // until the real ground station sends its own position.
    const demo = gs.source === 'config';
    setTagText(station.tag, ['GND STATION', demo ? 'DEMO POSITION' : '']);
    setTagLines(station.tag, demo);
  }

  const dash = (css, opacity, px, bits) => C.Material.fromType('PolylineDash', {
    color: rgba(css, opacity),
    gapColor: rgba(config.HALO_COLOR, DASH_GAP_OPACITY * opacity),
    dashLength: px,
    dashPattern: bits,
  });
  const link = { line: null, tag: null, stale: null };
  const drop = { line: null };

  // The dashed teal line from the ground station to the focused rocket,
  // through the air, labeled with the straight-line distance between them
  // (so it counts the rocket's height, unlike the map's ground distance).
  // With no fix right now it ends at the last good position, so it dims
  // and the label says "Last known".
  function drawLink(focused, target) {
    if (!station.position || !target) {
      if (link.line) link.line.show = false;
      if (link.tag) link.tag.wanted = false;
      return;
    }
    const stale = !store.hasFixNow(focused) || Boolean(drawn.get(focused.id)?.old);
    if (!link.line) {
      link.line = lines.add({ positions: [station.position, target], width: 2 });
      link.tag = makeTag(target, [{ font: textFont, color: TEXT }], {
        sides: ['center'],
        icon: { left: 0, right: 0, up: 0, down: 0 },
        backing: PAGE,
        optional: true,
        order: 5,
      });
      link.tag.labels[0].horizontalOrigin = C.HorizontalOrigin.CENTER;
      link.tag.along = true;
    }
    if (link.stale !== stale) {
      link.stale = stale;
      link.line.material = dash(config.GROUND_STATION_COLOR, stale ? GS_LINE_STALE_OPACITY : GS_LINE_OPACITY, GS_DASH_PX, GS_DASH_BITS);
      link.tag.labels[0].fillColor = rgba(stale ? MUTED : TEXT);
    }
    link.line.show = true;
    link.line.positions = [station.position, target];
    link.from = station.position;
    link.to = target;
    setTagText(link.tag, [`${stale ? 'Last known ' : ''}${formatDistance(C.Cartesian3.distance(station.position, target))} straight line`]);
    link.tag.wanted = true;
  }

  // A thin line from the focused rocket straight down. Its lower end is
  // far below any ground, and the terrain hides the part under the
  // surface, so the line ends where the ground is.
  function drawDropLine(target) {
    if (!target) {
      if (drop.line) drop.line.show = false;
      return;
    }
    const spot = C.Cartographic.fromCartesian(target);
    const positions = [target, C.Cartesian3.fromRadians(spot.longitude, spot.latitude, DROP_BOTTOM_M)];
    if (!drop.line) {
      drop.line = lines.add({
        positions,
        width: config.DROP_LINE_WIDTH_PX + 1,
        material: C.Material.fromType('PolylineOutline', {
          color: rgba(config.DROP_LINE_COLOR, 0.9),
          outlineColor: rgba(config.HALO_COLOR, config.HALO_OPACITY),
          outlineWidth: 1,
        }),
      });
    }
    drop.line.show = true;
    drop.line.positions = positions;
  }

  // Event markers in the sky, for the focused rocket: one at the trail
  // point of its apogee, drogue, main and landing, and of each event its
  // board reported, drawn by how the event was found, with a short label
  // like "Apogee detected · 3,000 m". They come
  // from the live store, so a marker only exists once playback has
  // reached its event. An event with no good position at its time (a GPS
  // gap) gets no marker, since there is no real place to put it.
  let marks = [];
  let marksKey = '';

  function drawEvents(focused) {
    const parts = focused ? drawn.get(focused.id) : null;
    const events = focused && parts ? focused.events.filter((e) => e.type in EVENT_WORDS || e.type === 'reported') : [];
    // Rebuilt when the list of events changes, or the trail under them
    // was rebuilt (parts.key). A board's own event is logged the moment it
    // arrives, and a closer GPS point can come in just after it, so the
    // markers are also placed again on each new point until the trail is
    // ALTITUDE_STALE_S past every event.
    const newest = focused?.track[focused.track.length - 1];
    const settling = events.some((e) => !newest || newest.t <= e.t + config.ALTITUDE_STALE_S) ? focused.track.length : 'settled';
    const key = `${focused?.id ?? ''}|${parts?.key ?? ''}|${events.length}|${parts?.track === focused?.track}|${settling}`;
    if (key !== marksKey || marks.some((m) => m.track !== focused?.track)) {
      marksKey = key;
      for (const m of marks) {
        eventIcons.remove(m.icon);
        removeTag(m.tag);
      }
      marks = [];
      for (const e of events) {
        // The marker goes on a real trail point, never between two.
        const i = nearestPoint(focused.track, parts.positions, e.t);
        if (i < 0) continue;
        const position = parts.positions[i];
        const kind = eventMarkerKind(e, focused.derived);
        const id = `event-${kind === 'estimated' ? 'inferred' : kind}`;
        const icon = addIcon(eventIcons, id, position);
        const tag = makeTag(position, [{ font: textFont, color: TEXT }], {
          sides: ['right', 'left', 'above', 'below'],
          icon: { left: EVENT_MARK_PX / 2, right: EVENT_MARK_PX / 2, up: EVENT_MARK_PX / 2, down: EVENT_MARK_PX / 2 },
          backing: PAGE,
          optional: true,
          order: 4,
        });
        setTagText(tag, [eventText(e, kind)]);
        marks.push({ icon, tag, track: focused.track });
      }
    }
  }

  // "Apogee detected · 3,000 m", with the event's own height. A board's
  // own event shows the board's words and no height, since the board
  // reported none. A landing has no height worth saying.
  function eventText(e, kind) {
    const said = e.type === 'reported' ? (/"(.*)"/.exec(e.message ?? '')?.[1] ?? null) : null;
    const name = e.type === 'reported' ? (said ? `"${said}"` : 'Board event') : EVENT_WORDS[e.type];
    const where = e.type !== 'landed' && Number.isFinite(e.aglM) ? ` · ${formatRounded10(e.aglM)} m` : '';
    return `${name} ${kind}${where}`;
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

  // The distance label sits on the ground station line: at the middle, or
  // the spot nearest the middle where it is clear of the panels and the
  // other labels. Runs before each frame, after placeTags' usual pass.
  function placeLinkLabel() {
    const tag = link.tag;
    if (destroyed || !tag) return;
    if (!tag.wanted || !link.from || !tag.w) {
      showTag(tag, false);
      return;
    }
    const size = { x: scene.canvas.clientWidth, y: scene.canvas.clientHeight };
    const others = [];
    for (const other of tags) {
      if (other === tag || !other.wanted) continue;
      const p = C.SceneTransforms.worldToWindowCoordinates(scene, other.position);
      if (!p) continue;
      const f = distanceScale(other.position);
      if (other.shown && other.side) others.push(tagBox(other, other.side, p, f));
      others.push({ left: p.x - other.icon.left * f, right: p.x + other.icon.right * f, top: p.y - other.icon.up * f, bottom: p.y + other.icon.down * f });
    }
    let found = null;
    for (let step = 0; step <= 20 && !found; step++) {
      for (const f of step === 0 ? [0.5] : [0.5 - step * 0.02, 0.5 + step * 0.02]) {
        const position = C.Cartesian3.lerp(link.from, link.to, f, new C.Cartesian3());
        const p = C.SceneTransforms.worldToWindowCoordinates(scene, position);
        if (!p) continue;
        const s = distanceScale(position);
        const w = tag.w * s;
        const h = tag.heights[0] * s;
        const box = { left: p.x - w / 2, right: p.x + w / 2, top: p.y - h / 2, bottom: p.y + h / 2 };
        if (labelCost(box, covered, others, size, 1) === 0) { found = position; break; }
      }
    }
    if (!found) {
      showTag(tag, false);
      return;
    }
    setTagPosition(tag, found);
    showTag(tag, true);
  }
  const stopPlacingLink = scene.preRender.addEventListener(placeLinkLabel);

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
  const frameOf = (position) => C.Transforms.eastNorthUpToFixedFrame(position);
  const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
  const PITCH_MIN = C.Math.toRadians(config.GLOBE_PITCH_MIN_DEG);
  const PITCH_MAX = C.Math.toRadians(config.GLOBE_PITCH_MAX_DEG);

  // The flight's highest point above ground (m), from the pre-scan (the
  // same number the altitude tape uses for its scale). 0 if there is none.
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
  // the ground there starts loading.
  const look = (() => {
    const gs = store.getGroundStation();
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
    look.range = clamp(look.range, config.GLOBE_ZOOM_MIN_M, config.GLOBE_ZOOM_MAX_M);
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
  }

  // Ends a glide at its goal (the view is about to be hidden).
  function finishGlide() {
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
    // over it (the altitude tape on the left, the readings on the right),
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
      moveTo({ pivot, ...startOrbit() }, { animate: false });
      // "Whole flight" was chosen before there was anything to frame.
      if (cameraMode === 'whole') frameEverything({ animate: false });
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
    const target = focusedTarget();
    drawLink(focused, target);
    drawDropLine(target);
    drawEvents(focused);
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
    if (parts.some((p) => p.waiting)) out.push('A rocket shows in 3D once its launch pad and the ground height there are known.');
    if (parts.some((p) => p.approx) || station.approx || view.terrain === 'failed') out.push('3D ground height is approximate.');
    if (view.imageryFailed) out.push('The 3D imagery didn\'t load, so the ground is plain.');
    return out;
  }

  // Tells map-view.js when the first picture is in, so its "Loading"
  // panel can go: the icons, fonts and terrain are loaded, no ground
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
      stopPlacing();
      stopPlacingLink();
      stopGlide();
      window.cancelAnimationFrame(pairFrame);
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
        tags.clear();
        icons.clear();
        spots.length = 0;
      }
    },
  };
}
