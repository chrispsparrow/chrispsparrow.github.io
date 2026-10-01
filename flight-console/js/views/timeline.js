// timeline.js
// The altitude timeline under the map, with the playback controls under it.
//
// The strip shows the focused rocket's altitude above ground over the whole
// recording: gold up to the playhead and muted after it, with the other
// rockets as thin lines in their own colors. Readings with no altitude (a
// GPS fix gap) and stretches with no readings at all for longer than
// LINK_STALE_S (a radio silence) leave a break in the curve, never a
// filled-in value. Event
// markers sit on the curve, shaped by how each event was found (a filled
// dot for reported, a gold ring for detected, a dashed ring for inferred or
// estimated). Clicking a marker jumps playback to that event.
//
// Click or drag anywhere on the strip to seek. With keyboard focus the
// strip is a slider: the arrow keys move the playhead, Shift or Page Up and
// Page Down move it further, and Home and End go to the start and end.
//
// The curve and markers come from the whole-flight pre-scan (ctx.prescan),
// so they show before playback reaches them. They only move the playback.
// They never put events in the mission timeline early.
//
// Used by: main.js. Talks to the player and reads the store, never other views.

import { h, svg, setText, setChildren, createScheduler, eventMarkerKind, markerClass, MARKER_KIND_TEXT } from './dom.js';
import { uiIcon, iconNode } from './icons.js';
import { formatClock, formatFlightSeconds, formatNumber, formatRounded10 } from '../geo.js';
import { FLIGHT_EVENT_TYPES, EVENT_LABELS } from '../detector.js';

// Room (px) around the plot inside the strip: above for the apogee label,
// below for the time labels, and at the sides for the end markers.
const PAD_TOP = 16;
const PAD_BOTTOM = 26;
const PAD_X = 18;
const PAD_X_NARROW = 12;
// Strips narrower than this (px) use the smaller side room and marker gap.
const NARROW_PX = 520;
// The height scale goes this much above the highest curve.
const HEADROOM = 1.12;
// Time labels along the bottom: the first step (s) that keeps them this far
// apart (px).
const TICK_STEPS_S = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
const MIN_TICK_GAP_PX = 96;
const MIN_TICK_GAP_NARROW_PX = 72;
// Markers closer than this (px) are spread apart so each stays clickable.
const MARKER_GAP_PX = 18;
const MARKER_GAP_NARROW_PX = 15;
// Events that get a short label next to their marker.
const LABELED = new Set(['apogee', 'main']);
// A touch has to move this far (px) sideways before it starts dragging, so a
// tap seeks once and a vertical swipe still scrolls the page.
const DRAG_START_PX = 6;
// How long (ms) a marker's tooltip stays after the pointer leaves, so it
// can be moved onto the tooltip itself.
const TIP_HIDE_MS = 120;

let instances = 0;

export function createTimeline(root, ctx) {
  const { store, player, config } = ctx;
  const prescan = ctx.prescan instanceof Map ? ctx.prescan : new Map();
  const n = ++instances;
  const ids = {
    title: `fc-tl-title-${n}`,
    summary: `fc-tl-summary-${n}`,
    hint: `fc-tl-hint-${n}`,
    clip: `fc-tl-clip-${n}`,
    fill: `fc-tl-fill-${n}`,
  };

  // ------------------------------------------------------------------
  // Elements
  // ------------------------------------------------------------------
  const key = h('ul', { class: 'fc-tl-key', 'aria-label': 'Rockets on the timeline', hidden: true });
  const legend = h('ul', { class: 'fc-tl-legend', 'aria-label': 'What the marker shapes mean' },
    legendItem('reported', 'Reported'),
    legendItem('detected', 'Detected'),
    legendItem('inferred', 'Inferred or estimated'));

  const plot = svg('svg', { class: 'fc-tl-svg', 'aria-hidden': 'true', focusable: 'false' });
  const track = h('div', {
    class: 'fc-tl-track',
    role: 'slider',
    tabindex: '0',
    'aria-orientation': 'horizontal',
    'aria-valuemin': '0',
    'aria-describedby': `${ids.summary} ${ids.hint}`,
  }, plot);
  const marks = h('div', { class: 'fc-tl-marks' });
  const hoverTime = h('span', { class: 'fc-tl-hover-time' });
  const hoverAlt = h('span', { class: 'fc-tl-hover-alt' });
  const hover = h('div', { class: 'fc-tl-hover', 'aria-hidden': 'true', hidden: true }, hoverTime, hoverAlt);
  // The tooltip repeats what each marker's name and description already
  // say, so screen readers skip it.
  const tip = h('div', { class: 'fc-tl-tip', 'aria-hidden': 'true', hidden: true });
  const empty = h('p', { class: 'fc-tl-empty', hidden: true }, 'No altitude data for this rocket yet.');
  const strip = h('div', { class: 'fc-tl-strip' }, track, marks, hover, tip, empty);

  const summary = h('p', { class: 'sr-only', id: ids.summary });
  const step = config.TIMELINE_KEY_STEP_S;
  const bigStep = config.TIMELINE_KEY_BIG_STEP_S;
  const hint = h('p', { class: 'sr-only', id: ids.hint },
    `Click or drag to move through the flight. The arrow keys move ${seconds(step)}, ` +
    `and Shift with an arrow key, or Page Up and Page Down, move ${seconds(bigStep)}. ` +
    'Home and End go to the start and end.');

  const playButton = h('button', { type: 'button', class: 'fc-btn fc-btn--gold fc-tl-play', onclick: onPlay });
  const speedButtons = player.getState().speeds.map((x) =>
    h('button', { type: 'button', class: 'fc-btn', 'aria-pressed': 'false', onclick: () => player.setSpeed(x) }, `${x}x`));
  const timeNow = h('span', { class: 'fc-tl-time-now' });
  const timeTotal = h('span', { class: 'fc-tl-time-total' });
  const time = h('p', { class: 'fc-tl-time', 'aria-live': 'off' }, timeNow, ' ', timeTotal);

  setChildren(root, h('section', { class: 'fc-panel fc-tl', 'aria-labelledby': ids.title },
    h('div', { class: 'fc-panel-head fc-tl-head' },
      h('div', { class: 'fc-tl-titles' },
        h('h2', { class: 'fc-panel-title', id: ids.title }, 'Altitude timeline'),
        key),
      legend),
    summary,
    strip,
    hint,
    h('div', { class: 'fc-tl-controls' },
      playButton,
      h('div', { class: 'fc-seg', role: 'group', 'aria-label': 'Playback speed' }, speedButtons),
      time)));

  function legendItem(kind, text) {
    return h('li', {}, h('span', { class: markerClass(kind), 'aria-hidden': 'true' }), text);
  }

  // ------------------------------------------------------------------
  // Geometry: rebuilt when the strip changes size, the focus changes or
  // the recording loads. Holds the scales and the parts each frame moves.
  // ------------------------------------------------------------------
  let geo = null;

  function rebuild() {
    // The old markers are about to go, so forget them.
    tipState.hover = null;
    tipState.focus = null;
    tipState.dismissed = null;
    tipState.overTip = false;
    tipHide();
    hideHover();
    const s = player.getState();
    const W = track.clientWidth;
    const H = track.clientHeight;
    const rocket = store.getFocused();
    const scan = rocket ? prescan.get(rocket.id) : null;
    const profile = withSilences(scan?.profile ?? [], config.LINK_STALE_S);
    const hasCurve = profile.some((p) => Number.isFinite(p.agl));
    renderKey(rocket);
    renderSummary(profile);
    track.setAttribute('aria-label', `Altitude timeline for ${rocket?.profile?.name ?? 'this flight'}`);
    empty.hidden = hasCurve;

    if (!(W > 0 && H > 0) || !Number.isFinite(s.t0) || !Number.isFinite(s.tEnd)) {
      geo = null;
      setChildren(plot);
      setChildren(marks);
      renderFrame();
      return;
    }

    const narrow = W < NARROW_PX;
    const padX = narrow ? PAD_X_NARROW : PAD_X;
    const left = padX;
    const right = W - padX;
    const top = PAD_TOP;
    const bottom = H - PAD_BOTTOM;
    const span = Math.max(s.tEnd - s.t0, 1e-6);

    // Height scale: 0 up to the highest point of any rocket, with headroom.
    // A rocket that ends up a little below its pad pulls the bottom down.
    let maxAll = 0;
    let minAll = 0;
    for (const [, r] of prescan) {
      for (const p of r.profile) {
        if (!Number.isFinite(p.agl)) continue;
        if (p.agl > maxAll) maxAll = p.agl;
        if (p.agl < minAll) minAll = p.agl;
      }
    }
    const yMax = maxAll > 0 ? maxAll * HEADROOM : 1;
    const yMin = minAll;
    const x = (t) => left + ((t - s.t0) / span) * (right - left);
    const y = (agl) => bottom - ((agl - yMin) / (yMax - yMin)) * (bottom - top);
    const base = y(0);

    plot.setAttribute('width', W);
    plot.setAttribute('height', H);
    plot.setAttribute('viewBox', `0 0 ${W} ${H}`);

    // Time labels and faint grid lines, in recording time like the clock
    // under the strip.
    const pxPerS = (right - left) / span;
    const minGap = narrow ? MIN_TICK_GAP_NARROW_PX : MIN_TICK_GAP_PX;
    const tickStep = TICK_STEPS_S.find((v) => v * pxPerS >= minGap) ?? TICK_STEPS_S[TICK_STEPS_S.length - 1];
    const grid = [];
    const ticks = [];
    for (let k = 0; k * tickStep <= span + 1e-9; k++) {
      const px = x(s.t0 + k * tickStep);
      if (k > 0) grid.push(svg('line', { x1: r1(px), x2: r1(px), y1: top, y2: base }));
      ticks.push(svg('line', { x1: r1(px), x2: r1(px), y1: base, y2: base + 4 }));
      // The labels at the two ends line up with the strip's edges.
      const anchor = px > W - 22 ? 'end' : px < 22 ? 'start' : 'middle';
      const tx = anchor === 'end' ? Math.min(px + 2, W - 4) : anchor === 'start' ? Math.max(px - 4, 4) : px;
      ticks.push(svg('text', { x: r1(tx), y: H - 8, 'text-anchor': anchor }, formatClock(k * tickStep)));
    }

    // The focused rocket's curve, split at every gap.
    const segs = segments(profile, x, (agl) => y(Math.max(agl, yMin)));
    const lineD = linePath(segs);
    const areaD = areaPath(segs, base);
    // A faint coral band where the curve breaks, so the gap reads as missing
    // data rather than a drawing glitch.
    const gaps = [];
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1][segs[i - 1].length - 1].x;
      const b = segs[i][0].x;
      if (b > a) gaps.push(svg('rect', { x: r1(a), y: top, width: r1(b - a), height: r1(base - top) }));
    }

    // Other rockets: thin lines in their colors, under the focused curve.
    const others = [];
    for (const r of store.getRockets()) {
      if (r.id === rocket?.id) continue;
      const other = withSilences(prescan.get(r.id)?.profile ?? [], config.LINK_STALE_S);
      const d = linePath(segments(other, x, (agl) => y(Math.max(agl, yMin))));
      if (d) others.push(svg('path', { d, stroke: r.profile.color }));
    }

    // A dashed line at the focused rocket's highest point.
    const peak = profile.reduce((m, p) => (Number.isFinite(p.agl) && p.agl > m ? p.agl : m), -Infinity);
    const peakY = Number.isFinite(peak) && peak > 0 ? y(peak) : null;

    // Event markers, in time order, spread apart where they crowd.
    const placed = markerEvents(scan).map((e) => ({ e, x: x(e.t), y: y(Math.max(aglAt(profile, e.t, { interpolate: true }) ?? 0, yMin)) }));
    placed.sort((a, b) => a.x - b.x);
    spread(placed, narrow ? MARKER_GAP_NARROW_PX : MARKER_GAP_PX, left, right);

    const clipRect = svg('rect', { x: 0, y: 0, width: 0, height: H });
    const head = svg('g', { class: 'fc-tl-playhead' },
      svg('line', { x1: 0, x2: 0, y1: 5, y2: base }),
      svg('rect', { class: 'fc-tl-playhead-grip', x: -4.5, y: 1, width: 9, height: 12, rx: 3 }));
    const nowDot = svg('circle', { class: 'fc-tl-now', r: 4.5, cx: 0, cy: 0 });
    const hoverLine = svg('line', { class: 'fc-tl-hover-line', x1: 0, x2: 0, y1: top, y2: base, visibility: 'hidden' });

    setChildren(plot,
      svg('defs', {},
        svg('clipPath', { id: ids.clip }, clipRect),
        svg('linearGradient', { id: ids.fill, x1: 0, y1: 0, x2: 0, y2: 1 },
          svg('stop', { offset: '0', class: 'fc-tl-fill-top' }),
          svg('stop', { offset: '1', class: 'fc-tl-fill-bottom' }))),
      svg('g', { class: 'fc-tl-grid' }, grid),
      svg('g', { class: 'fc-tl-gaps' }, gaps),
      peakY !== null ? svg('line', { class: 'fc-tl-peak', x1: left, x2: right, y1: r1(peakY), y2: r1(peakY) }) : null,
      svg('g', { class: 'fc-tl-others' }, others),
      areaD ? svg('path', { class: 'fc-tl-area-rest', d: areaD }) : null,
      lineD ? svg('path', { class: 'fc-tl-line-rest', d: lineD }) : null,
      svg('g', { 'clip-path': `url(#${ids.clip})` },
        areaD ? svg('path', { class: 'fc-tl-area-played', d: areaD, fill: `url(#${ids.fill})` }) : null,
        lineD ? svg('path', { class: 'fc-tl-line-played', d: lineD }) : null),
      // A faint line from each raised marker down to the time axis.
      svg('g', { class: 'fc-tl-stems' }, placed.filter((m) => m.y + 12 < base)
        .map((m) => svg('line', { x1: r1(m.x), x2: r1(m.x), y1: r1(m.y + 8), y2: base }))),
      svg('line', { class: 'fc-tl-base', x1: left - 4, x2: right + 4, y1: r1(base), y2: r1(base) }),
      svg('g', { class: 'fc-tl-ticks' }, ticks),
      hoverLine,
      head,
      nowDot);

    // Marker buttons and labels sit over the strip, next to the slider
    // (never inside it), so each one is its own control.
    const markers = placed.map((m, i) => buildMarker(m, i, scan.state, profile));
    const peakLabel = peakY !== null
      ? h('span', { class: 'fc-tl-peak-label', style: { left: `${left}px`, top: `${r1(peakY)}px` } }, `${formatNumber(peak, 0)} m`)
      : null;
    setChildren(marks, peakLabel, markers.map((m) => [m.button, m.label]));
    for (const m of markers) placeLabel(m, markers, W, bottom);
    if (peakLabel) placePeakLabel(peakLabel, markers, right);
    // Where the peak label ended up, so the playhead can fade it while it
    // passes behind it (measured once here, not every frame).
    const peakBox = peakLabel ? { el: peakLabel, left: peakLabel.offsetLeft, right: peakLabel.offsetLeft + peakLabel.offsetWidth, under: false } : null;

    geo = { t0: s.t0, tEnd: s.tEnd, W, H, left, right, x, y, yMin, profile, scan, clipRect, head, nowDot, hoverLine, markers, peakBox, timeAt: null };
    geo.timeAt = (clientX) => {
      const box = track.getBoundingClientRect();
      const f = (clientX - box.left - left) / (right - left);
      return s.t0 + Math.min(1, Math.max(0, f)) * span;
    };
    renderFrame();
  }

  // The focused rocket's flight events and board-reported events. GPS fix
  // lost and back are left out: the break in the curve already shows them.
  function markerEvents(scan) {
    if (!scan) return [];
    return scan.events.filter((e) => (FLIGHT_EVENT_TYPES.includes(e.type) || e.type === 'reported') && Number.isFinite(e.t));
  }

  function buildMarker(m, index, state, profile) {
    const { e } = m;
    const kind = eventMarkerKind(e, state);
    const how = MARKER_KIND_TEXT[kind];
    const when = Number.isFinite(e.flightT) ? formatFlightSeconds(e.flightT) : null;
    // A board event's own text, like "drogue_fired", from its message.
    const said = e.type === 'reported' ? (/"(.*)"/.exec(e.message ?? '')?.[1] ?? null) : null;
    const name = e.type === 'reported'
      ? (said ? `Board event "${said}"` : 'Board event')
      : (EVENT_LABELS[e.type] ?? e.label ?? e.type);
    // Height: the event's own, or the curve's there. A liftoff without its
    // own height is left out (its time is often estimated in a gap).
    const agl = Number.isFinite(e.aglM) ? e.aglM : e.type === 'liftoff' ? null : aglAt(profile, e.t, { interpolate: false });
    const height = Number.isFinite(agl) ? `about ${formatRounded10(agl)} m above ground` : null;

    const accessible = ['Jump to ' + lowerFirst(name), how, when].filter(Boolean).join(', ');
    const descId = `fc-tl-mark-${n}-${index}`;
    const desc = height ? h('span', { id: descId, hidden: true }, `${upperFirst(height)}.`) : null;
    const button = h('button', {
      type: 'button',
      class: 'fc-tl-mark',
      style: { left: `${r1(m.x)}px`, top: `${r1(m.y)}px` },
      'aria-label': accessible,
      'aria-describedby': desc ? descId : null,
      dataset: { type: e.type },
      onclick: () => jumpTo(marker),
    }, h('span', { class: markerClass(kind), 'aria-hidden': 'true' }), desc);
    const label = LABELED.has(e.type) ? h('span', { class: 'fc-tl-mark-label', 'aria-hidden': 'true' }, EVENT_LABELS[e.type]) : null;
    const marker = {
      e, x: m.x, y: m.y, button, label,
      reachedAt: Number.isFinite(e.confirmedT) ? e.confirmedT : e.t,
      reached: null,
      tipParts: [h('strong', {}, name), [how, when, height].filter(Boolean).map((part) => `, ${part}`).join('')],
    };
    button.addEventListener('pointerenter', () => { tipState.hover = marker; tipUpdate(); });
    button.addEventListener('pointerleave', () => {
      if (tipState.hover === marker) tipState.hover = null;
      if (tipState.dismissed === marker) tipState.dismissed = null;
      tipUpdateSoon();
    });
    // Only keyboard focus opens the tooltip. A tap or click shows it
    // through hover instead, so it doesn't stay stuck open on a phone.
    button.addEventListener('focus', () => {
      if (!button.matches(':focus-visible')) return;
      tipState.focus = marker;
      tipUpdate();
    });
    button.addEventListener('blur', () => {
      if (tipState.focus === marker) tipState.focus = null;
      if (tipState.dismissed === marker) tipState.dismissed = null;
      tipUpdate();
    });
    return marker;
  }

  // Apogee and Main labels sit just above their marker, on the right side
  // unless another marker crowds it there (drogue right after apogee) or
  // the strip ends. They always stay inside the strip.
  function placeLabel(m, markers, W, bottom) {
    if (!m.label) return;
    const w = m.label.offsetWidth;
    const lh = m.label.offsetHeight;
    const rightLeft = m.x + 9;
    const leftLeft = m.x - 9 - w;
    const crowdedRight = markers.some((o) => o !== m && o.x > m.x && o.x - 13 < rightLeft + w && Math.abs(o.y - m.y) < lh + 14);
    let left = rightLeft;
    if ((crowdedRight && leftLeft >= 4) || rightLeft + w > W - 4) left = leftLeft;
    left = Math.min(Math.max(4, left), W - 4 - w);
    const top = Math.min(Math.max(3, m.y - 7 - lh), bottom - lh);
    m.label.style.left = `${r1(left)}px`;
    m.label.style.top = `${r1(top)}px`;
  }

  // The highest point's label starts at the left end of its dashed line,
  // and moves to the right end if a marker or label is in the way there
  // (on narrow strips apogee is close to the left edge).
  function placePeakLabel(label, markers, right) {
    // The label is centered on its line with a CSS transform.
    const box = rectOf(label);
    const half = label.offsetHeight / 2;
    box.top -= half;
    box.bottom -= half;
    const blocked = markers.some((m) => overlaps(box, { left: m.x - 9, right: m.x + 9, top: m.y - 9, bottom: m.y + 9 }) ||
      (m.label && overlaps(box, rectOf(m.label))));
    if (!blocked) return;
    label.style.left = 'auto';
    label.style.right = `${r1(track.clientWidth - right)}px`;
    label.classList.add('is-right');
  }

  function renderKey(rocket) {
    const rockets = store.getRockets();
    key.hidden = rockets.length < 2;
    if (key.hidden) { setChildren(key); return; }
    setChildren(key, rockets.map((r) => {
      const focused = r.id === rocket?.id;
      return h('li', { class: focused ? 'is-focused' : null },
        h('span', { class: 'fc-tl-swatch', style: { '--swatch': focused ? 'var(--fc-gold)' : r.profile.color }, 'aria-hidden': 'true' }),
        r.profile.name,
        focused ? h('span', { class: 'sr-only' }, ', shown in gold') : null);
    }));
  }

  function renderSummary(profile) {
    const peak = profile.reduce((m, p) => (Number.isFinite(p.agl) && p.agl > m ? p.agl : m), -Infinity);
    setText(summary, Number.isFinite(peak)
      ? `The curve shows altitude above ground over the whole recording, up to about ${formatRounded10(peak)} m. The event buttons after it jump to each event.`
      : 'No altitude data for this rocket yet.');
  }

  // ------------------------------------------------------------------
  // Every frame: the controls, the playhead, the played part of the curve,
  // and which markers the playhead has reached.
  // ------------------------------------------------------------------
  let playState = null;

  function renderFrame() {
    const s = player.getState();
    const hasData = s.sampleCount > 0 && Number.isFinite(s.t0);
    // The recording loaded or changed: redraw the curve on the next frame.
    // (A strip with no size waits for the resize observer instead.)
    // (The width is only read when a rebuild might be needed, never every frame.)
    if (hasData && (!geo || geo.t0 !== s.t0 || geo.tEnd !== s.tEnd) && track.clientWidth > 0) rebuildScheduler.schedule();

    // Play button and speeds.
    const mode = !hasData ? 'none' : s.ended ? 'replay' : s.playing ? 'pause' : 'play';
    if (mode !== playState) {
      playState = mode;
      const icon = mode === 'pause' ? 'pause' : mode === 'replay' ? 'replay' : 'play';
      const text = mode === 'pause' ? 'Pause' : mode === 'replay' ? 'Replay' : 'Play';
      setChildren(playButton, iconNode(uiIcon(icon, 18)), h('span', {}, text));
      playButton.disabled = !hasData;
    }
    speedButtons.forEach((b, i) => {
      const pressed = String(s.speeds[i] === s.speed);
      if (b.getAttribute('aria-pressed') !== pressed) b.setAttribute('aria-pressed', pressed);
      b.disabled = !hasData;
    });

    // Time and the slider's values.
    if (!hasData) {
      setText(timeNow, 'No data');
      setText(timeTotal, '');
      track.setAttribute('aria-disabled', 'true');
      return;
    }
    track.removeAttribute('aria-disabled');
    const elapsed = formatClock(s.time - s.t0);
    const total = formatClock(s.tEnd - s.t0);
    setText(timeNow, elapsed);
    setText(timeTotal, `of ${total}`);
    setAttr(track, 'aria-valuemax', String(Math.floor(s.tEnd - s.t0 + 1e-9)));
    setAttr(track, 'aria-valuenow', String(Math.floor(s.time - s.t0 + 1e-9)));
    setAttr(track, 'aria-valuetext', valueText(s, elapsed, total));

    if (!geo) return;
    // While dragging, the playhead follows the pointer right away. The seek
    // itself is limited to SCRUB_SEEKS_PER_S.
    const t = drag?.started && Number.isFinite(scrubT) ? scrubT : s.time;
    const px = geo.x(t);
    geo.clipRect.setAttribute('width', r1(Math.max(0, px)));
    geo.head.setAttribute('transform', `translate(${r1(px)} 0)`);
    const agl = aglAt(geo.profile, t, { interpolate: true, inGap: false });
    if (Number.isFinite(agl)) {
      geo.nowDot.setAttribute('cx', r1(px));
      geo.nowDot.setAttribute('cy', r1(geo.y(Math.max(agl, geo.yMin))));
      geo.nowDot.removeAttribute('visibility');
    } else {
      geo.nowDot.setAttribute('visibility', 'hidden');
    }
    const pb = geo.peakBox;
    if (pb) {
      const under = px > pb.left - 6 && px < pb.right + 6;
      if (under !== pb.under) { pb.under = under; pb.el.classList.toggle('is-under-head', under); }
    }
    for (const m of geo.markers) {
      const reached = s.time >= m.reachedAt - 1e-6;
      if (reached === m.reached) continue;
      m.reached = reached;
      m.button.classList.toggle('is-reached', reached);
      m.label?.classList.toggle('is-reached', reached);
    }
  }

  // "1:29 of 4:05, T+57 s, 2,450 m above ground", from the live store so
  // it matches the rest of the console (no altitude when it is old).
  function valueText(s, elapsed, total) {
    const parts = [`${elapsed} of ${total}`];
    const rocket = store.getFocused();
    const d = rocket?.derived;
    if (d && Number.isFinite(d.liftoffT)) parts.push(formatFlightSeconds(s.time - d.liftoffT));
    else if (d?.phase === 'pad') parts.push('on the pad');
    if (d && Number.isFinite(d.agl) && !store.altitudeIsOld(rocket)) parts.push(`${formatNumber(d.agl, 0)} m above ground`);
    return parts.join(', ');
  }

  function onPlay() {
    const s = player.getState();
    if (s.ended) player.replay();
    else player.toggle();
  }

  // ------------------------------------------------------------------
  // Seeking with the pointer. A mouse press seeks at once and dragging
  // keeps seeking. A touch waits to see whether it moves sideways (drag) or
  // not at all (tap). touch-action: pan-y in the CSS hands vertical swipes
  // to the page, which cancels the pointer here.
  // ------------------------------------------------------------------
  let drag = null;       // { id, startX, started }
  let scrubT = null;     // where the playhead is drawn while dragging
  let pendingSeek = null;
  const seekScheduler = createScheduler(() => {
    if (pendingSeek !== null) player.seek(pendingSeek);
    pendingSeek = null;
  }, { maxFps: config.SCRUB_SEEKS_PER_S });

  function startScrub(clientX) {
    drag.started = true;
    player.beginScrub();
    moveScrub(clientX);
    seekScheduler.flush();
  }
  function moveScrub(clientX) {
    scrubT = geo.timeAt(clientX);
    pendingSeek = scrubT;
    seekScheduler.schedule();
    frameScheduler.schedule();
  }
  function finishDrag() {
    if (!drag) return;
    const started = drag.started;
    drag = null;
    if (started) {
      seekScheduler.flush();
      scrubT = null;
      player.endScrub();
    }
    frameScheduler.schedule();
  }

  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !geo || drag || player.getState().sampleCount === 0) return;
    drag = { id: e.pointerId, startX: e.clientX, started: false };
    try { track.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
    if (e.pointerType !== 'touch') startScrub(e.clientX);
  });
  track.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id && geo) {
      if (drag.started) moveScrub(e.clientX);
      else if (Math.abs(e.clientX - drag.startX) >= DRAG_START_PX) startScrub(e.clientX);
    }
    if (e.pointerType !== 'touch') showHover(e.clientX);
  });
  track.addEventListener('pointerup', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    // A tap that never moved: one seek.
    if (!drag.started && geo) player.seek(geo.timeAt(e.clientX));
    finishDrag();
  });
  track.addEventListener('pointercancel', finishDrag);
  track.addEventListener('lostpointercapture', finishDrag);
  track.addEventListener('pointerleave', (e) => { if (!drag || e.pointerId !== drag.id) hideHover(); });

  // ------------------------------------------------------------------
  // Keyboard
  // ------------------------------------------------------------------
  track.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const s = player.getState();
    if (!s.sampleCount || !Number.isFinite(s.time)) return;
    let target;
    switch (e.key) {
      case 'ArrowRight': case 'ArrowUp': target = s.time + (e.shiftKey ? bigStep : step); break;
      case 'ArrowLeft': case 'ArrowDown': target = s.time - (e.shiftKey ? bigStep : step); break;
      case 'PageUp': target = s.time + bigStep; break;
      case 'PageDown': target = s.time - bigStep; break;
      case 'Home': target = s.t0; break;
      case 'End': target = s.tEnd; break;
      default: return;
    }
    e.preventDefault();
    player.seek(target);
  });

  // ------------------------------------------------------------------
  // Hover readout: a thin line and a small chip with the flight time and
  // the altitude reading at the pointer (mouse and pen only).
  // ------------------------------------------------------------------
  function showHover(clientX) {
    if (!geo) return;
    const t = geo.timeAt(clientX);
    const px = geo.x(t);
    const liftoffT = geo.scan?.state?.liftoffT;
    setText(hoverTime, Number.isFinite(liftoffT) ? formatFlightSeconds(t - liftoffT) : formatClock(t - geo.t0));
    const i = lastAtOrBefore(geo.profile, t);
    const p = i >= 0 ? geo.profile[i] : null;
    setText(hoverAlt, !p ? '' : Number.isFinite(p.agl) ? `${formatNumber(p.agl, 0)} m` : 'No altitude reading');
    hoverAlt.hidden = !p;
    hover.hidden = false;
    const w = hover.offsetWidth;
    hover.style.left = `${r1(Math.min(Math.max(2, px - w / 2), geo.W - w - 2))}px`;
    geo.hoverLine.setAttribute('x1', r1(px));
    geo.hoverLine.setAttribute('x2', r1(px));
    geo.hoverLine.removeAttribute('visibility');
  }
  function hideHover() {
    hover.hidden = true;
    geo?.hoverLine.setAttribute('visibility', 'hidden');
  }

  // ------------------------------------------------------------------
  // Marker tooltips: shown on hover and keyboard focus, hidden with
  // Escape until the pointer or focus leaves that marker. The pointer can
  // move onto the tooltip without it closing.
  // ------------------------------------------------------------------
  const tipState = { hover: null, focus: null, overTip: false, dismissed: null, shown: null, timer: null };
  function onEscape(e) {
    if (e.key !== 'Escape' || tip.hidden) return;
    tipState.dismissed = tipState.shown;
    tipHide();
  }
  document.addEventListener('keydown', onEscape);
  tip.addEventListener('pointerenter', () => { tipState.overTip = true; tipUpdate(); });
  tip.addEventListener('pointerleave', () => { tipState.overTip = false; tipUpdateSoon(); });
  // The tooltip covers part of the strip while it is open, so a click on
  // it does what its marker does.
  tip.addEventListener('click', () => {
    if (tipState.shown) jumpTo(tipState.shown);
  });

  // Jumps to a marker's event. Its tooltip closes (like Escape) until the
  // pointer or focus leaves the marker, so it can't sit over the next
  // marker someone reaches for.
  function jumpTo(marker) {
    player.seek(marker.e.confirmedT ?? marker.e.t);
    tipState.dismissed = marker;
    tipState.overTip = false;
    tipHide();
  }

  function tipUpdateSoon() {
    clearTimeout(tipState.timer);
    tipState.timer = setTimeout(tipUpdate, TIP_HIDE_MS);
  }
  function tipUpdate() {
    clearTimeout(tipState.timer);
    const m = tipState.hover ?? (tipState.overTip ? tipState.shown : null) ?? tipState.focus;
    if (!m || m === tipState.dismissed) { tipHide(); return; }
    if (tipState.shown !== m) {
      setChildren(tip, m.tipParts);
      tipState.shown = m;
    }
    tip.hidden = false;
    hideHover();
    const w = tip.offsetWidth;
    const th = tip.offsetHeight;
    const W = geo?.W ?? strip.clientWidth;
    tip.style.left = `${r1(Math.min(Math.max(0, m.x - w / 2), W - w))}px`;
    // Above the marker when that stays inside the strip, otherwise below
    // it, so it never covers the panel's title.
    const above = m.y - 14 - th;
    tip.style.top = `${r1(above >= 0 ? above : m.y + 14)}px`;
  }
  function tipHide() {
    clearTimeout(tipState.timer);
    tip.hidden = true;
    tipState.shown = null;
  }

  // ------------------------------------------------------------------
  // Subscriptions
  // ------------------------------------------------------------------
  const frameScheduler = createScheduler(renderFrame, { maxFps: config.CONTROLS_MAX_FPS });
  const rebuildScheduler = createScheduler(rebuild, { maxFps: 30 });
  const unsubscribePlayer = player.subscribe(() => frameScheduler.schedule());
  const unsubscribeStore = store.subscribe((change) => {
    if (change.type === 'focus' || change.type === 'rockets') rebuildScheduler.schedule();
  });
  let lastSize = '';
  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
      const size = `${track.clientWidth}x${track.clientHeight}`;
      if (size === lastSize) return;
      lastSize = size;
      rebuildScheduler.schedule();
    })
    : null;
  resizeObserver?.observe(track);
  rebuild();

  return {
    destroy() {
      unsubscribePlayer();
      unsubscribeStore();
      resizeObserver?.disconnect();
      frameScheduler.cancel();
      rebuildScheduler.cancel();
      seekScheduler.cancel();
      clearTimeout(tipState.timer);
      document.removeEventListener('keydown', onEscape);
      drag = null;
    },
  };
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

// Rounds to 0.1 px for SVG attributes.
function r1(v) {
  return Math.round(v * 10) / 10;
}

function seconds(v) {
  return `${v} second${v === 1 ? '' : 's'}`;
}

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function upperFirst(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// An element's box inside its positioned parent, from its own style.
function rectOf(el) {
  const left = el.offsetLeft;
  const top = el.offsetTop;
  return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight };
}

function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function setAttr(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

// A copy of a profile with a gap marked ({ t, agl: null }) wherever no
// reading at all came in for longer than maxGapS, so a radio silence breaks
// the curve like a GPS fix gap does, and nothing is drawn or read across it.
function withSilences(profile, maxGapS) {
  if (!Number.isFinite(maxGapS) || profile.length < 2) return profile;
  const out = [];
  for (let i = 0; i < profile.length; i++) {
    const p = profile[i];
    const prev = profile[i - 1];
    if (prev && Number.isFinite(prev.agl) && p.t - prev.t > maxGapS) out.push({ t: prev.t + maxGapS, agl: null });
    out.push(p);
  }
  return out;
}

// Splits a profile into runs of readings with an altitude, as {x, y} points.
function segments(profile, x, y) {
  const out = [];
  let run = null;
  for (const p of profile) {
    if (!Number.isFinite(p.agl) || !Number.isFinite(p.t)) { run = null; continue; }
    if (!run) { run = []; out.push(run); }
    run.push({ x: x(p.t), y: y(p.agl) });
  }
  return out;
}

// One path for every run. A run of a single reading draws as a dot (the
// round line cap of a tiny step).
function linePath(segs) {
  return segs.map((run) => `M${run.map((p) => `${r1(p.x)} ${r1(p.y)}`).join('L')}${run.length === 1 ? 'h0.01' : ''}`).join('');
}

// The area under each run, closed down to the ground line.
function areaPath(segs, base) {
  return segs.filter((run) => run.length > 1)
    .map((run) => `M${r1(run[0].x)} ${r1(base)}L${run.map((p) => `${r1(p.x)} ${r1(p.y)}`).join('L')}L${r1(run[run.length - 1].x)} ${r1(base)}Z`)
    .join('');
}

// Index of the last profile point at or before t, or -1.
function lastAtOrBefore(profile, t) {
  let lo = 0;
  let hi = profile.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (profile[mid].t <= t + 1e-9) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// Altitude above ground at time t from a profile.
//   interpolate  between the two readings around t (only within a run)
//   inGap        inside a gap, use the nearest reading in time (true) or
//                return null (false)
function aglAt(profile, t, { interpolate = false, inGap = true } = {}) {
  if (!profile.length) return null;
  const i = lastAtOrBefore(profile, t);
  const a = i >= 0 ? profile[i] : null;
  const b = profile[i + 1] ?? null;
  if (a && Number.isFinite(a.agl)) {
    if (Math.abs(a.t - t) < 1e-9) return a.agl;
    if (b && Number.isFinite(b.agl)) {
      if (!interpolate) return a.agl;
      return a.agl + ((t - a.t) / (b.t - a.t)) * (b.agl - a.agl);
    }
    if (!b && !inGap) return null;
  }
  if (!inGap) return null;
  // In a gap, or outside the readings: the nearest reading in time.
  let best = null;
  for (const p of profile) {
    if (!Number.isFinite(p.agl)) continue;
    if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
  }
  return best ? best.agl : null;
}

// Spreads markers sitting closer than gap (px) to each other, evenly around
// the middle of each crowded group, inside lo..hi.
function spread(points, gap, lo, hi) {
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    let i = 0;
    while (i < points.length) {
      let j = i;
      while (j + 1 < points.length && points[j + 1].x - points[j].x < gap - 0.01 && Math.abs(points[j + 1].y - points[j].y) < gap) j++;
      if (j > i) {
        const count = j - i + 1;
        const mid = (points[i].x + points[j].x) / 2;
        const start = Math.min(Math.max(mid - ((count - 1) * gap) / 2, lo), hi - (count - 1) * gap);
        for (let k = 0; k < count; k++) points[i + k].x = start + k * gap;
        moved = true;
      }
      i = j + 1;
    }
    if (!moved) break;
  }
}
