// alt-tape.js
// The altitude tape: a narrow scale on the left edge of the map, from the
// ground (0 m) at the bottom to the focused rocket's highest point of the
// whole flight at the top. A gold marker with a value chip shows the
// altitude above ground now, and a short gold line marks the highest point
// reached so far. When the altitude is old (no fix right now, or the rocket
// went quiet), the marker turns grey and hollow and the chip says it's the
// last known value. Before the first altitude there is no marker.
//
// The scale comes from the whole-flight pre-scan (ctx.prescan), so it never
// changes while the flight plays. Without a pre-scan height the tape draws
// nothing, and its empty mount hides itself.
//
// On phones the same elements turn sideways into a thin strip under the
// readings. Only the CSS changes: every position is a fraction from 0 to 1
// in a CSS variable (--p for now, --high for the highest so far, --at for
// each tick), used as "bottom" on the map and as "left" on phones.
// Used by: main.js. Reads the store and ctx.prescan, never other views.

import { h, setText, setChildren, createScheduler } from './dom.js';
import { formatNumber, formatAge, MISSING } from '../geo.js';

export function createAltTape(root, ctx) {
  const { store, config } = ctx;
  let tape = null;   // the elements of the tape on screen, or null
  // Sizes for the covered-label check, measured only when they can change
  // (a new tape, a resize, or the chip gaining or losing its "Last known"
  // line), never on every update.
  const resizeObserver = 'ResizeObserver' in window ? new ResizeObserver(() => { if (tape) tape.dims = null; scheduler.schedule(); }) : null;

  function render() {
    const rocket = store.getFocused();
    const max = rocket ? ctx.prescan?.get(rocket.id)?.state?.maxAgl : null;
    if (!rocket || !Number.isFinite(max) || max <= 0) {
      if (tape) root.replaceChildren();
      tape = null;
      return;
    }
    if (!tape || tape.id !== rocket.id || tape.max !== max) tape = build(rocket.id, max);
    update(rocket, tape);
  }

  // The scale, ticks, marker and chip for one rocket's height range.
  function build(id, max) {
    const ticks = ticksFor(max).map((tick) => h('div', {
      class: `fc-tape-tick fc-tape-tick--${tick.kind}`,
      style: { '--at': String(tick.v / max) },
    }, tick.kind === 'minor' ? null : h('span', { class: 'fc-tape-tick-label' },
      formatNumber(tick.v, 0),
      tick.kind === 'max' ? h('span', { class: 'fc-tape-tick-unit' }, ' m') : null)));

    const value = h('span', {});
    const chip = h('span', { class: 'fc-tape-chip' },
      h('span', { class: 'fc-tape-value' }, value, h('span', { class: 'fc-tape-unit' }, ' m')),
      h('span', { class: 'fc-tape-last' }, 'Last known'));
    const marker = h('div', { class: 'fc-tape-marker', hidden: true }, chip);
    const high = h('div', { class: 'fc-tape-high', hidden: true });

    // A meter's parts are hidden from screen readers. It reads its own
    // value text instead (kept up to date in update()).
    const el = h('div', {
      class: 'fc-tape fc-float',
      role: 'meter',
      'aria-label': 'Altitude tape',
      'aria-valuemin': '0',
      'aria-valuemax': String(Math.round(max)),
      title: 'Altitude above ground. The gold marker is the altitude now, and the short gold line is the highest point so far.',
    },
    // Only shown on phones, where the strip sits on its own under the readings.
    h('div', { class: 'fc-tape-caption', 'aria-hidden': 'true' },
      h('span', {}, 'Altitude above ground'),
      h('span', { class: 'fc-tape-key' }, h('span', { class: 'fc-tape-key-mark' }), 'Highest so far')),
    h('div', { class: 'fc-tape-scale', 'aria-hidden': 'true' },
      h('div', { class: 'fc-tape-track' }, h('div', { class: 'fc-tape-reach' }), h('div', { class: 'fc-tape-fill' })),
      ticks,
      high,
      marker));
    setChildren(root, el);
    const scale = el.querySelector('.fc-tape-scale');
    resizeObserver?.disconnect();
    resizeObserver?.observe(scale);
    const labels = [...el.querySelectorAll('.fc-tape-tick')]
      .map((tick) => ({ el: tick.querySelector('.fc-tape-tick-label'), at: Number(tick.style.getPropertyValue('--at')) }))
      .filter((l) => l.el);
    return { id, max, el, scale, value, chip, marker, high, labels, dims: null, old: null };
  }

  function update(rocket, t) {
    const d = rocket.derived;
    const agl = d?.agl;
    const hasAgl = Number.isFinite(agl);
    const old = hasAgl && store.altitudeIsOld(rocket);
    const highest = d?.maxAgl;
    const hasHigh = Number.isFinite(highest);
    const fraction = (m) => Math.min(1, Math.max(0, m / t.max));

    t.marker.hidden = !hasAgl;
    t.high.hidden = !hasHigh;
    setVar(t.el, '--p', hasAgl ? fraction(agl).toFixed(4) : '0');
    setVar(t.el, '--high', hasHigh ? fraction(highest).toFixed(4) : '0');
    if (t.el.classList.contains('is-old') !== old) t.el.classList.toggle('is-old', old);
    // The chip's height changes with its "Last known" line.
    if (t.old !== old) { t.old = old; t.dims = null; }
    // The chip shows the altitude as it is. Only the marker stays on the scale.
    setText(t.value, hasAgl ? formatNumber(agl, 0) : MISSING);

    let text = 'No altitude yet';
    if (hasAgl) {
      text = `${formatNumber(agl, 0)} m above ground`;
      if (old) text = `Last known ${text}, ${formatAge(store.ageOf(d.altitudeT))}`;
      if (hasHigh) text += `, highest so far ${formatNumber(highest, 0)} m`;
    }
    setAttr(t.el, 'aria-valuenow', hasAgl ? String(Math.round(fraction(agl) * t.max)) : null);
    setAttr(t.el, 'aria-valuetext', text);
    hideCoveredLabels(t, hasAgl ? fraction(agl) : null);
  }

  // A tick label the value chip sits on top of is hidden while it's covered,
  // so "2,000" never peeks out from under "1,950 m". Only the upright tape
  // on the map needs this: on the sideways strip the chip rides above the
  // labels. Worked out from the chip's position, not by measuring it.
  function hideCoveredLabels(t, p) {
    if (!t.dims) {
      const vertical = t.scale.clientHeight > t.scale.clientWidth;
      t.dims = { vertical, len: t.scale.clientHeight, chip: t.chip.offsetHeight, label: t.labels[0]?.el.offsetHeight ?? 0 };
    }
    const { vertical, len, chip, label } = t.dims;
    for (const l of t.labels) {
      const covered = vertical && p !== null && Math.abs(l.at - p) * len < (chip + label) / 2 + 2;
      if (l.el.classList.contains('is-covered') !== covered) l.el.classList.toggle('is-covered', covered);
    }
  }

  const scheduler = createScheduler(render, { maxFps: config.STATS_MAX_FPS });
  const unsubscribe = store.subscribe((change) => {
    if (change.type === 'focus' || change.type === 'clear' || change.type === 'reset' || change.type === 'rockets') scheduler.flush();
    else scheduler.schedule();
  });
  render();

  return {
    destroy() {
      unsubscribe();
      scheduler.cancel();
      resizeObserver?.disconnect();
    },
  };
}

// The scale's ticks: 0, round numbers in between (every other one labeled,
// the rest short and unlabeled), and the rocket's highest point at the top.
// Round numbers too close to the top are left out so labels never collide.
function ticksFor(max) {
  const step = niceStep(max / 4);
  const ticks = [{ v: 0, kind: 'min' }];
  for (let i = 1; (i * step) / 2 < max - step * 0.3; i += 1) {
    ticks.push({ v: (i * step) / 2, kind: i % 2 === 0 ? 'major' : 'minor' });
  }
  ticks.push({ v: max, kind: 'max' });
  return ticks;
}

// The smallest of 1, 2, 2.5 or 5 times a power of ten that is at least raw.
function niceStep(raw) {
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5]) if (m * power >= raw) return m * power;
  return 10 * power;
}

// Writes a CSS variable or attribute only when it changed (null removes the
// attribute), so ten updates a second don't redo style work for nothing.
function setVar(el, name, value) {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

function setAttr(el, name, value) {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}
