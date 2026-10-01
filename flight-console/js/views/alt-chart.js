// alt-chart.js
// Altitude above ground against flight time, one line per rocket in its
// color, each measured from its own liftoff. The focused rocket's line is
// thicker, with dashed vertical lines and short labels at its events, drawn
// by the small Chart.js plugin below (no extra library). An amber line marks
// the current time. Readings with no altitude leave a break in the line,
// never a filled-in value. If Chart.js didn't load, the panel says so and
// lists each rocket's highest altitude as text.
// Used by: main.js. Reads the store, never other views.

import { h, setText, setChildren, createScheduler } from './dom.js';
import { formatNumber, formatFlightSeconds, MISSING } from '../geo.js';
import { FLIGHT_EVENT_TYPES, EVENT_LABELS } from '../detector.js';

const TEXT = '#F4F2ED';
const LABEL = '#D2CEC5';
const GRID = 'rgba(244, 242, 237, 0.10)';
const CURSOR = '#FFB547';

// Draws the focused rocket's event lines and the current-time cursor.
// Options come from chart.options.plugins.fcMarkers:
//   { markers: [{ x, label, color }], cursorX }
const markerPlugin = {
  id: 'fcMarkers',
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea || !scales.x) return;
    const { top, bottom, left, right } = chartArea;
    ctx.save();
    ctx.font = '600 12px "Funnel Sans", system-ui, sans-serif';
    ctx.textBaseline = 'top';
    (opts.markers ?? []).forEach((m, i) => {
      const px = scales.x.getPixelForValue(m.x);
      if (!Number.isFinite(px) || px < left - 1 || px > right + 1) return;
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(px, top);
      ctx.lineTo(px, bottom);
      ctx.stroke();
      ctx.setLineDash([]);
      // Labels step down in three rows so close events don't overlap.
      const y = top + 4 + (i % 3) * 15;
      const width = ctx.measureText(m.label).width;
      const x = Math.min(px + 4, right - width - 2);
      ctx.fillStyle = 'rgba(13, 16, 20, 0.85)';
      ctx.fillRect(x - 2, y - 1, width + 4, 15);
      ctx.fillStyle = TEXT;
      ctx.fillText(m.label, x, y);
    });
    if (Number.isFinite(opts.cursorX)) {
      const px = scales.x.getPixelForValue(opts.cursorX);
      if (px >= left - 1 && px <= right + 1) {
        ctx.strokeStyle = CURSOR;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px, top);
        ctx.lineTo(px, bottom);
        ctx.stroke();
      }
    }
    ctx.restore();
  },
};

export function createAltChart(root, ctx) {
  const { store, config, libs } = ctx;
  const canvas = h('canvas', { role: 'img', 'aria-label': 'Altitude above ground against flight time for each rocket' });
  const overlay = h('div', { class: 'fc-chart-overlay' }, 'Loading the chart...');
  const wrap = h('div', { class: 'fc-chart-wrap' }, canvas, overlay);
  const summary = h('p', { class: 'sr-only', 'aria-live': 'off' });
  setChildren(root, h('section', { class: 'fc-panel', 'aria-labelledby': 'fc-chart-title' },
    h('div', { class: 'fc-panel-head' }, h('h2', { class: 'fc-panel-title', id: 'fc-chart-title' }, 'Altitude above ground')),
    wrap,
    summary));

  let chart = null;
  let mode = 'loading'; // 'loading', 'chart' or 'fallback'
  let destroyed = false;
  const series = new Map(); // rocketId -> { dataset, source, key, drawn }

  function tryStart(Chart) {
    try {
      start(Chart);
    } catch (err) {
      console.error('Flight Console: the chart failed to start', err);
      showFallback();
    }
  }

  libs.chart.ready.then((Chart) => {
    if (destroyed) return;
    if (Chart) { tryStart(Chart); return; }
    showFallback();
    // If Chart.js turns up after all, switch to the real chart.
    libs.chart.late.then((late) => {
      if (destroyed || !late || mode !== 'fallback') return;
      setChildren(wrap, canvas, overlay);
      fallbackList = null;
      tryStart(late);
    });
  });

  function start(Chart) {
    chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { datasets: [] },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        normalized: true,
        spanGaps: false,
        interaction: { mode: 'nearest', intersect: false, axis: 'x' },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: 'Flight time (s)', color: LABEL, font: { family: 'Funnel Sans', size: 13 } },
            ticks: { color: LABEL, font: { family: 'Funnel Sans', size: 12 } },
            grid: { color: GRID },
          },
          y: {
            title: { display: true, text: 'Altitude above ground (m)', color: LABEL, font: { family: 'Funnel Sans', size: 13 } },
            ticks: { color: LABEL, font: { family: 'Funnel Sans', size: 12 } },
            grid: { color: GRID },
          },
        },
        plugins: {
          legend: { labels: { color: TEXT, font: { family: 'Funnel Sans', size: 13 }, boxWidth: 14 } },
          tooltip: {
            titleFont: { family: 'Funnel Sans', size: 13, weight: '600' },
            bodyFont: { family: 'Funnel Sans', size: 13 },
            callbacks: {
              title: (items) => (items.length ? formatFlightSeconds(items[0].parsed.x) : ''),
              label: (item) => `${item.dataset.label}, ${formatNumber(item.parsed.y, 0)} m above ground`,
            },
          },
          fcMarkers: { markers: [], cursorX: null },
        },
      },
      plugins: [markerPlugin],
    });
    mode = 'chart';
    draw();
  }

  // ------------------------------------------------------------------
  // Chart data
  // ------------------------------------------------------------------
  function pointsFor(rocket, from, to) {
    const d = rocket.derived;
    const out = [];
    for (let i = from; i < to; i++) {
      const p = rocket.altSeries[i];
      if (p.t < d.liftoffT - config.CHART_PAD_S) continue;
      out.push({ x: p.t - d.liftoffT, y: p.alt === null ? null : p.alt - d.groundRef });
    }
    return out;
  }

  function draw() {
    if (mode === 'fallback') { drawFallback(); return; }
    if (mode !== 'chart') return;
    const rockets = store.getRockets();
    const focused = store.getFocused();

    // One dataset per rocket, in rocket order.
    const ids = rockets.map((r) => r.id).join('|');
    if (chart.$fcIds !== ids) {
      chart.$fcIds = ids;
      series.clear();
      chart.data.datasets = rockets.map((r) => {
        const dataset = {
          label: r.profile.name,
          data: [],
          borderColor: r.profile.color,
          backgroundColor: r.profile.color,
          borderWidth: 1.5,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0,
          spanGaps: false,
        };
        series.set(r.id, { dataset, source: null, key: null, drawn: 0 });
        return dataset;
      });
    }

    let anyLiftoff = false;
    for (const rocket of rockets) {
      const s = series.get(rocket.id);
      if (!s) continue;
      const d = rocket.derived;
      const isFocused = focused?.id === rocket.id;
      s.dataset.borderWidth = isFocused ? 3.5 : 1.5;
      s.dataset.order = isFocused ? 0 : 1; // lower order is drawn on top
      if (!d || d.liftoffT === null) {
        s.dataset.data = [];
        s.source = null;
        s.key = null;
        s.drawn = 0;
        continue;
      }
      anyLiftoff = true;
      const key = `${d.liftoffT}|${d.groundRef}`;
      if (s.source !== rocket.altSeries || s.key !== key || s.drawn > rocket.altSeries.length) {
        s.dataset.data = pointsFor(rocket, 0, rocket.altSeries.length);
        s.source = rocket.altSeries;
        s.key = key;
      } else if (s.drawn < rocket.altSeries.length) {
        s.dataset.data.push(...pointsFor(rocket, s.drawn, rocket.altSeries.length));
      }
      s.drawn = rocket.altSeries.length;
    }

    // Event lines and cursor for the focused rocket.
    const fd = focused?.derived;
    const opts = chart.options.plugins.fcMarkers;
    if (fd && fd.liftoffT !== null) {
      opts.markers = focused.events
        .filter((e) => FLIGHT_EVENT_TYPES.includes(e.type))
        .map((e) => ({ x: e.t - fd.liftoffT, label: EVENT_LABELS[e.type], color: focused.profile.color }));
      const now = store.getNow();
      opts.cursorX = Number.isFinite(now) ? now - fd.liftoffT : null;
    } else {
      opts.markers = [];
      opts.cursorX = null;
    }

    overlay.hidden = anyLiftoff;
    if (!anyLiftoff) setText(overlay, 'Waiting for liftoff. Each rocket\'s line starts at its own liftoff.');
    chart.update('none');
    setText(summary, describe(rockets));
  }

  // Text version of the chart for screen readers and the no-chart fallback.
  function describe(rockets) {
    return rockets.map((r) => `${r.profile.name}: highest so far ${Number.isFinite(r.derived?.maxAgl) ? `${formatNumber(r.derived.maxAgl, 0)} m` : MISSING} above ground.`).join(' ');
  }

  // ------------------------------------------------------------------
  // No chart
  // ------------------------------------------------------------------
  let fallbackList = null;
  function showFallback() {
    mode = 'fallback';
    fallbackList = h('ul', {});
    setChildren(wrap, h('div', { class: 'fc-chart-fallback' },
      h('p', {}, 'Chart needs internet. Here is each rocket\'s highest altitude so far instead.'),
      fallbackList));
    drawFallback();
  }

  // Rows are built once per set of rockets. Only their text changes after
  // that, so the numbers can be selected and copied during playback.
  const fallbackRows = new Map();
  function drawFallback() {
    if (!fallbackList) return;
    const rockets = store.getRockets();
    const ids = rockets.map((r) => r.id).join('|');
    if (fallbackList.dataset.ids !== ids) {
      fallbackList.dataset.ids = ids;
      fallbackRows.clear();
      setChildren(fallbackList, rockets.map((r) => {
        const text = h('span', {});
        fallbackRows.set(r.id, text);
        return h('li', {}, h('span', { class: 'fc-dot', style: { '--dot': r.profile.color }, 'aria-hidden': 'true' }), text);
      }));
    }
    for (const r of rockets) {
      setText(fallbackRows.get(r.id), `${r.profile.name}: ${Number.isFinite(r.derived?.maxAgl) ? `${formatNumber(r.derived.maxAgl, 0)} m above ground` : MISSING}`);
    }
  }

  const scheduler = createScheduler(draw, { maxFps: config.CHART_MAX_FPS });
  const unsubscribe = store.subscribe((change) => {
    if (change.type === 'reset' || change.type === 'clear') {
      for (const s of series.values()) { s.source = null; s.drawn = 0; }
    }
    scheduler.schedule();
  });

  return {
    destroy() {
      destroyed = true;
      unsubscribe();
      scheduler.cancel();
      chart?.destroy();
      chart = null;
    },
  };
}
