// charts.js: the time graphs and the position trace, drawn on <canvas>.
// Both redraw from scratch each time. With 10 minutes of readings at about
// one per second, that is only a few hundred points per graph.

// 1, 2 or 5 times a power of ten, at or above `raw`.
export function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

// Colors and the font come from the page's CSS variables, so the graphs
// always match the panels around them.
export function readTheme(el = document.body) {
  const s = getComputedStyle(el);
  const v = (name) => s.getPropertyValue(name).trim();
  return {
    panel: v('--bc-panel'),
    grid: v('--bc-divider'),
    text: v('--bc-text'),
    text2: v('--bc-text-2'),
    muted: v('--bc-muted'),
    gold: v('--bc-gold'),
    sent: v('--bc-sent'),
    err: v('--bc-err'),
    font: v('--font-text') || 'system-ui, sans-serif',
  };
}

// Sizes the canvas to its box on screen at the screen's pixel density.
function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx, w: rect.width, h: rect.height };
}

// Index of the point closest in time to t, in a list sorted by time.
// Points with a null value (the breaks at each new connection) are skipped.
export function nearestIndex(points, t) {
  let lo = 0;
  let hi = points.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1; else hi = mid;
  }
  let best = -1;
  let bestDt = Infinity;
  for (let i = Math.max(0, lo - 2); i <= Math.min(points.length - 1, lo + 2); i++) {
    if (points[i].v === null) continue;
    const dt = Math.abs(points[i].t - t);
    if (dt < bestDt) { best = i; bestDt = dt; }
  }
  return best;
}

const TIME_STEPS = [5, 10, 15, 30, 60, 120, 300, 600].map((s) => s * 1000);
const fmtMinutes = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtSeconds = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
export const formatClock = (t) => fmtSeconds.format(t);

// One time graph. `series` is a list of { key, color }. The page hands it
// the points ({ t, v }) for each key and the time span to show.
export class TimeChart {
  constructor(canvas, { series, theme, integer = false, floorZero = true, minSpan = 1, gapMs = 6000, onHover, onKey }) {
    this.canvas = canvas;
    this.series = series;
    this.theme = theme;
    this.integer = integer;
    this.floorZero = floorZero;
    this.minSpan = minSpan;
    this.gapMs = gapMs;
    this.data = {};
    this.t0 = 0;
    this.t1 = 1;
    this.plot = null;

    // Pointing at the graph picks a time. Every graph shows that same time.
    canvas.addEventListener('pointermove', (e) => {
      if (!this.plot) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const { left, right } = this.plot;
      const t = this.t0 + ((Math.min(Math.max(x, left), right) - left) / (right - left)) * (this.t1 - this.t0);
      onHover?.(this.snap(t));
    });
    canvas.addEventListener('pointerleave', () => onHover?.(null));
    canvas.addEventListener('keydown', (e) => onKey?.(e, this));
  }

  setData(data, t0, t1) {
    this.data = data;
    this.t0 = t0;
    this.t1 = t1;
  }

  // The time of the reading closest to t, from the first series that has one.
  snap(t) {
    for (const s of this.series) {
      const pts = this.data[s.key] || [];
      const i = nearestIndex(pts, t);
      if (i >= 0 && Math.abs(pts[i].t - t) <= this.gapMs) return pts[i].t;
    }
    return t;
  }

  // The point of one series at time t, or null if there's no reading close by.
  pointAt(key, t) {
    const pts = this.data[key] || [];
    const i = nearestIndex(pts, t);
    if (i < 0 || Math.abs(pts[i].t - t) > this.gapMs) return null;
    return pts[i];
  }

  // Times of the readings in view, for moving through them with the keys.
  times() {
    const pts = this.data[this.series[0].key] || [];
    return pts.filter((p) => p.v !== null && p.t >= this.t0 && p.t <= this.t1).map((p) => p.t);
  }

  draw(hoverT = null) {
    const { ctx, w, h } = fitCanvas(this.canvas);
    const th = this.theme;
    const { t0, t1 } = this;
    ctx.font = `12px ${th.font}`;

    // Value range over what's in view.
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of this.series) {
      for (const p of this.data[s.key] || []) {
        if (p.v === null || p.t < t0 || p.t > t1) continue;
        if (p.v < lo) lo = p.v;
        if (p.v > hi) hi = p.v;
      }
    }
    const empty = lo === Infinity;
    if (empty) { lo = 0; hi = this.minSpan; }
    if (this.floorZero && lo >= 0) lo = 0;
    if (hi - lo < this.minSpan) {
      if (this.floorZero && lo === 0) hi = lo + this.minSpan;
      else { const mid = (hi + lo) / 2; lo = mid - this.minSpan / 2; hi = mid + this.minSpan / 2; }
    }
    let step = niceStep((hi - lo) / 3);
    if (this.integer) step = Math.max(1, Math.round(step));
    const yLo = Math.floor(lo / step) * step;
    let yHi = Math.ceil(hi / step) * step;
    if (yHi <= yLo) yHi = yLo + step;
    const decimals = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step)));
    const ticks = [];
    for (let v = yLo; v <= yHi + step / 1000; v += step) ticks.push(Number(v.toFixed(decimals)));

    if (empty) {
      this.plot = null;
      ctx.fillStyle = th.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `14px ${th.font}`;
      ctx.fillText('No data yet', w / 2, h / 2);
      return;
    }

    const labelW = Math.max(...ticks.map((v) => ctx.measureText(v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })).width));
    const left = Math.ceil(labelW) + 10;
    const right = w - 8;
    const top = 8;
    const bottom = h - 22;
    this.plot = { left, right, top, bottom };
    const xOf = (t) => left + ((t - t0) / (t1 - t0)) * (right - left);
    const yOf = (v) => bottom - ((v - yLo) / (yHi - yLo)) * (bottom - top);

    // Grid lines and value labels: thin and quiet.
    ctx.lineWidth = 1;
    ctx.strokeStyle = th.grid;
    ctx.fillStyle = th.muted;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of ticks) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
      ctx.fillText(v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }), left - 6, y);
    }

    // Clock times along the bottom, spaced at least 96 px apart.
    const span = t1 - t0;
    const tStep = TIME_STEPS.find((s) => (span / s) * 96 <= right - left) || TIME_STEPS[TIME_STEPS.length - 1];
    const fmt = tStep < 60000 ? fmtSeconds : fmtMinutes;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let t = Math.ceil(t0 / tStep) * tStep; t <= t1; t += tStep) {
      const x = xOf(t);
      const text = fmt.format(t);
      const half = ctx.measureText(text).width / 2;
      if (x - half < 0 || x + half > w) continue;
      ctx.fillText(text, x, bottom + 6);
    }

    // The lines. They break at each new connection and across long gaps.
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top - 6, right - left + 6, bottom - top + 12);
    ctx.clip();
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const s of this.series) {
      const pts = this.data[s.key] || [];
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      let run = [];
      const flush = () => {
        if (run.length === 1) {
          ctx.beginPath();
          ctx.arc(xOf(run[0].t), yOf(run[0].v), 2, 0, Math.PI * 2);
          ctx.fill();
        } else if (run.length > 1) {
          ctx.beginPath();
          run.forEach((p, i) => (i ? ctx.lineTo(xOf(p.t), yOf(p.v)) : ctx.moveTo(xOf(p.t), yOf(p.v))));
          ctx.stroke();
        }
        run = [];
      };
      let prev = null;
      for (const p of pts) {
        if (p.v === null || (prev && p.t - prev.t > this.gapMs)) flush();
        if (p.v !== null && p.t >= t0 - this.gapMs) run.push(p);
        prev = p.v === null ? null : p;
      }
      flush();
    }
    ctx.restore();

    // A dot on the newest reading, or on the readings at the picked time.
    const dot = (p, color) => {
      const x = xOf(p.t);
      const y = yOf(p.v);
      ctx.beginPath();
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = th.panel;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    };
    if (hoverT !== null && hoverT >= t0 && hoverT <= t1) {
      const x = Math.round(xOf(hoverT)) + 0.5;
      ctx.strokeStyle = th.text2;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, top - 4);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.globalAlpha = 1;
      for (const s of this.series) {
        const p = this.pointAt(s.key, hoverT);
        if (p) dot(p, s.color);
      }
    } else {
      for (const s of this.series) {
        const pts = this.data[s.key] || [];
        for (let i = pts.length - 1; i >= 0; i--) {
          if (pts[i].v === null) break;
          if (pts[i].t >= t0) { dot(pts[i], s.color); break; }
        }
      }
    }
  }
}

// Meters per degree near a latitude. Plenty close for a trace a few
// hundred meters across.
function metersPerDegree(lat) {
  const r = (lat * Math.PI) / 180;
  return { x: 111320 * Math.cos(r), y: 110574 };
}

// The position trace: where the board has been, in meters around its
// middle, north up, with a scale bar.
export class TrackPlot {
  constructor(canvas, { theme, minSpan = 10 }) {
    this.canvas = canvas;
    this.theme = theme;
    this.minSpan = minSpan;
    this.points = [];
  }

  setData(points) {
    this.points = points.filter((p) => p.lat !== null);
  }

  // Width east to west and height north to south of the trace, in meters.
  extent() {
    const pts = this.points;
    if (!pts.length) return null;
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const p of pts) {
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
    }
    const k = metersPerDegree((minLat + maxLat) / 2);
    return {
      minLat, maxLat, minLon, maxLon,
      eastWest: (maxLon - minLon) * k.x,
      northSouth: (maxLat - minLat) * k.y,
      k,
    };
  }

  draw(hoverT = null) {
    const { ctx, w, h } = fitCanvas(this.canvas);
    const th = this.theme;
    const pts = this.points;
    ctx.font = `12px ${th.font}`;

    if (!pts.length) {
      ctx.fillStyle = th.muted;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `14px ${th.font}`;
      ctx.fillText('No position yet', w / 2, h / 2);
      return;
    }

    const ext = this.extent();
    const lat0 = (ext.minLat + ext.maxLat) / 2;
    const lon0 = (ext.minLon + ext.maxLon) / 2;
    const pad = 30;
    const scale = Math.min(
      (w - 2 * pad) / Math.max(ext.eastWest, this.minSpan),
      (h - 2 * pad) / Math.max(ext.northSouth, this.minSpan),
    );
    const cx = w / 2;
    const cy = h / 2;
    const xOf = (p) => cx + (p.lon - lon0) * ext.k.x * scale;
    const yOf = (p) => cy - (p.lat - lat0) * ext.k.y * scale;

    // Grid every `grid` meters, lined up on the middle of the trace.
    const grid = niceStep(72 / scale);
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = -Math.ceil(cx / (grid * scale)); cx + i * grid * scale <= w; i++) {
      const x = Math.round(cx + i * grid * scale) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
    }
    for (let i = -Math.ceil(cy / (grid * scale)); cy + i * grid * scale <= h; i++) {
      const y = Math.round(cy + i * grid * scale) + 0.5;
      ctx.moveTo(0, y); ctx.lineTo(w, y);
    }
    ctx.stroke();

    // The trace: a faint line through every fix, small dots on each.
    ctx.strokeStyle = th.gold;
    ctx.fillStyle = th.gold;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(xOf(p), yOf(p)) : ctx.moveTo(xOf(p), yOf(p))));
    ctx.stroke();
    ctx.globalAlpha = 0.7;
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(xOf(p), yOf(p), 1.75, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // The oldest fix in view: an open ring.
    const first = pts[0];
    ctx.strokeStyle = th.text2;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(xOf(first), yOf(first), 4.5, 0, Math.PI * 2);
    ctx.stroke();

    // The newest fix, or the fix at the time picked on a graph.
    let mark = pts[pts.length - 1];
    if (hoverT !== null) {
      const i = nearestIndex(pts.map((p) => ({ t: p.t, v: 0 })), hoverT);
      if (i >= 0 && Math.abs(pts[i].t - hoverT) <= 6000) mark = pts[i];
    }
    ctx.beginPath();
    ctx.arc(xOf(mark), yOf(mark), 7, 0, Math.PI * 2);
    ctx.fillStyle = th.panel;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(xOf(mark), yOf(mark), 5, 0, Math.PI * 2);
    ctx.fillStyle = th.gold;
    ctx.fill();

    // Scale bar, bottom left.
    const barPx = grid * scale;
    const bx = 14;
    const by = h - 14;
    ctx.strokeStyle = th.text2;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(bx, by - 5); ctx.lineTo(bx, by); ctx.lineTo(bx + barPx, by); ctx.lineTo(bx + barPx, by - 5);
    ctx.stroke();
    ctx.fillStyle = th.text2;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${grid.toLocaleString(undefined, { maximumFractionDigits: 2 })} m`, bx + 4, by - 6);

    // North arrow, top right.
    const nx = w - 18;
    ctx.beginPath();
    ctx.moveTo(nx, 10); ctx.lineTo(nx + 5, 22); ctx.lineTo(nx, 19); ctx.lineTo(nx - 5, 22);
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('N', nx, 25);
  }
}
