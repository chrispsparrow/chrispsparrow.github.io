// Checks the landing hero's two tuna (js/hero-currents.js): the anatomy
// field built from the logo, and the flow lines traced through it.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/hero-fish.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFishField, traceFishLines } from '../js/hero-currents.js';

const svg = readFileSync(new URL('../../assets/dogtooth_kicad_silkscreen_files/01_primary_full_logo_kicad_white_tuna.svg', import.meta.url), 'utf8');
const d = [...svg.matchAll(/<path\b[^>]*?\sd="([^"]+)"/g)].map((m) => m[1]).join(' ');
const F = buildFishField(d);

// The same numbers the script uses to place a fish's field (FIELD_UNIT,
// FIELD_PAD and the tuna's box width).
const UNIT = 4;
const PAD = 8;
const BOX_W = 1251;
const lineInfo = (L, l) => {
  const pts = [];
  for (let q = 0; q < L.lens[l]; q++) {
    const o = (L.starts[l] + q) * L.stride;
    pts.push({ x: L.pts[o], y: L.pts[o + 1], glow: L.pts[o + 5], pace: L.pts[o + 6] });
  }
  return pts;
};

test('the field has a crisp edge: no weight outside the fish, full weight just inside', () => {
  let outside = 0;
  let inside = 0;
  for (let k = 0; k < F.sd.length; k++) {
    if (F.sd[k] < -4) outside = Math.max(outside, F.weight[k]);
    if (F.sd[k] > 10) inside = Math.max(inside, 1 - F.weight[k]);
  }
  assert.equal(outside, 0);
  assert.equal(inside, 0);
});

test('every part of the anatomy has its zone, and each zone a point to run into', () => {
  const seen = new Set(F.zone);
  for (let z = 1; z <= 7; z++) {
    assert.ok(seen.has(z), `zone ${z}`);
    assert.ok(F.tips[z] && Number.isFinite(F.tips[z].x), `tip ${z}`);
  }
  assert.ok(F.stripe.length >= 4);
});

test('the outline glows most at the teeth, and the teeth are slower', () => {
  let teeth = 0;
  let edge = 0;
  let slow = 0;
  for (let k = 0; k < F.sd.length; k++) {
    if (F.sd[k] < 0 || F.sd[k] > 4) continue;
    if (F.pace[k] < 1) {
      teeth = Math.max(teeth, F.glow[k]);
      slow += 1;
    } else if (F.zone[k] === 0) edge += F.glow[k] > 0 ? 1 : 0;
  }
  assert.ok(slow > 20, 'some outline cells are teeth');
  assert.ok(teeth > 0.8, `teeth glow ${teeth}`);
  assert.ok(edge > 100, 'the rest of the outline glows too');
});

for (const w of [490, 156]) {
  test(`flow lines for a ${w} px fish`, () => {
    const margin = 0.06 * w;
    const gap = 5;
    const L = traceFishLines(F, w, margin, gap, 1);
    assert.equal(L.stride, 7);
    assert.ok(L.count > 10);
    // The lines a gap apart cover about the fish's area (it fills a little
    // over half its box).
    const box = (w * w * 524) / BOX_W;
    const area = L.total * L.gap;
    assert.ok(area > box * 0.35 && area < box * 0.85, `area ${area} of ${box}`);

    // Patch px back to field cells.
    const unitPx = (UNIT * w) / BOX_W;
    const toCell = (v) => (v - margin + PAD * unitPx) / unitPx - 0.5;
    const sdAt = (x, y) => {
      const i = Math.round(toCell(x));
      const j = Math.round(toCell(y));
      return F.sd[j * F.cols + i];
    };
    // The first lines are the outline's: every point just inside the edge.
    const first = lineInfo(L, 0);
    const deepest = Math.max(...first.map((p) => sdAt(p.x, p.y)));
    assert.ok(deepest < (2 * gap * BOX_W) / w, `outline line ${deepest} logo units in`);
    assert.ok(Math.min(...first.map((p) => sdAt(p.x, p.y))) > -6);

    // A line in a fin ends nearer the fin's point than it starts.
    const tip = (z) => ({ x: (F.tips[z].x + 0.5) * unitPx - PAD * unitPx + margin, y: (F.tips[z].y + 0.5) * unitPx - PAD * unitPx + margin });
    let finLines = 0;
    for (let l = 0; l < L.count; l++) {
      const pts = lineInfo(L, l);
      const mid = pts[pts.length >> 1];
      const z = F.zone[Math.round(toCell(mid.y)) * F.cols + Math.round(toCell(mid.x))];
      if (z < 1 || z > 4 || pts.length < 4) continue;
      const t = tip(z);
      const a = Math.hypot(pts[0].x - t.x, pts[0].y - t.y);
      const b = Math.hypot(pts[pts.length - 1].x - t.x, pts[pts.length - 1].y - t.y);
      if (b < a) finLines += 1;
      else finLines -= 1;
    }
    assert.ok(finLines > 0, 'fin lines run into the fin points');

    // The eye's middle stays calm: no point of any line there.
    const eyeX = (F.eye.x + 0.5) * unitPx - PAD * unitPx + margin;
    const eyeY = (F.eye.y + 0.5) * unitPx - PAD * unitPx + margin;
    const calm = F.eye.r * unitPx * 0.5;
    for (let q = 0; q < L.pts.length; q += L.stride) {
      assert.ok(Math.hypot(L.pts[q] - eyeX, L.pts[q + 1] - eyeY) > calm, 'a point in the calm middle of the eye');
    }
    // Some lines glow (the logo's lines, the stripe, the eye).
    let glowing = 0;
    for (let q = 5; q < L.pts.length; q += L.stride) if (L.pts[q] > 0.5) glowing += 1;
    assert.ok(glowing > L.pts.length / L.stride / 20);
  });
}
