// Checks js/views/idle-earth.js: where the idle Earth sits in the 3D view
// (the camera's sums), where its outline lands on screen, and the warp that
// fits the globe's poster to any shape of view.
// Run it from the repo's root folder with Node 22 or newer:
//   node --test flight-console/test/idle-earth.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  idleFit, idleOutline, earthRho, earthPhi, posterScale, warpEarth,
  IDLE_MARGIN, POSTER_ANGLE_DEG, POSTER_EARTH_SHARE,
} from '../js/views/idle-earth.js';

const DEG = Math.PI / 180;
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b}`);

// The sums globe-view.js used before they moved here, written out again.
function oldFit(w, hgt, band) {
  const bottom = Math.min(hgt * 0.4, Math.max(0, band));
  const freeH = hgt - bottom;
  const fov = 60 * DEG;
  const fovy = w > hgt ? 2 * Math.atan(Math.tan(fov / 2) * hgt / w) : fov;
  const f = (hgt / 2) / Math.tan(fovy / 2);
  const radius = (Math.min(w, freeH) / 2) * (1 - IDLE_MARGIN);
  return { angle: Math.atan(radius / f), tilt: Math.atan((hgt / 2 - freeH / 2) / f) };
}

test('idleFit gives the camera the same fit it always had', () => {
  for (const [w, hgt, band] of [[1440, 622, 39.6], [390, 738, 60.9], [1920, 970, 40], [800, 800, 0], [300, 900, 500]]) {
    const a = idleFit(w, hgt, band);
    const b = oldFit(w, hgt, band);
    near(a.angle, b.angle, 1e-12, 'angle');
    near(a.tilt, b.tilt, 1e-12, 'tilt');
  }
  // The band counts for at most 40% of the height.
  near(idleFit(400, 1000, 900).freeH, 600, 1e-9, 'freeH');
});

test('with no band the outline is a circle in the middle of the view', () => {
  const o = idleOutline(1440, 582, 0);
  near(o.cx, 720, 1e-9, 'cx');
  near(o.cy, 291, 1e-9, 'cy');
  near(o.rx, 0.45 * 582, 1e-6, 'rx');
  near(o.ry, 0.45 * 582, 1e-6, 'ry');
  near(o.faceY, 291, 1e-9, 'faceY');
});

test('with a band the outline is the tilted camera\'s real outline', () => {
  // Projects the Earth's outline directly: rays that just touch a sphere of
  // angular radius a whose middle is tilt b above the view's axis.
  for (const [w, hgt, band] of [[390, 738, 60.9], [1440, 622, 39.6], [700, 900, 200]]) {
    const { f, angle: a, tilt: b } = idleFit(w, hgt, band);
    const o = idleOutline(w, hgt, band);
    const c = [0, Math.sin(b), Math.cos(b)];          // toward the Earth's middle (y up)
    const u = [1, 0, 0];                               // two directions across it
    const v = [0, Math.cos(b), -Math.sin(b)];
    let worst = 0;
    for (let k = 0; k < 72; k++) {
      const t = k * 5 * DEG;
      const ray = [0, 1, 2].map((i) => c[i] * Math.cos(a) + (u[i] * Math.cos(t) + v[i] * Math.sin(t)) * Math.sin(a));
      const x = f * ray[0] / ray[2];
      const yUp = f * ray[1] / ray[2];
      // On the ellipse: ((x - cx) / rx)^2 + ((y - cy) / ry)^2 = 1, in page y (down).
      const y = hgt / 2 - yUp;
      const e = ((x + w / 2 - o.cx) / o.rx) ** 2 + ((y - o.cy) / o.ry) ** 2;
      worst = Math.max(worst, Math.abs(e - 1));
    }
    assert.ok(worst < 1e-9, `outline off by ${worst} for ${w}x${hgt}`);
    near(o.faceY, hgt / 2 - f * Math.tan(b), 1e-9, 'faceY');
  }
});

test('the poster was made for a 1440 by 582 view with no band', () => {
  near(POSTER_ANGLE_DEG * DEG, idleFit(1440, 582, 0).angle, 1e-12, 'angle');
  near(POSTER_EARTH_SHARE, 1 / 1.05, 1e-12, 'share');
});

test('earthRho and earthPhi undo each other, and the outline is rho 1', () => {
  for (const deg of [8, 11.86, 15.4, 25]) {
    const a = deg * DEG;
    near(earthRho(Math.PI / 2 - a, a), 1, 1e-12, 'outline');
    for (const rho of [0, 0.1, 0.5, 0.9, 0.999]) near(earthRho(earthPhi(rho, a), a), rho, 1e-9, `rho ${rho}`);
  }
});

test('posterScale is 1 for the same view and smooth through the middle', () => {
  const a = POSTER_ANGLE_DEG * DEG;
  const same = posterScale(a, a);
  for (const rho of [0, 0.3, 0.7, 0.99]) near(same(rho), 1, 1e-9, `same ${rho}`);
  // Seen from closer up (a bigger angle) the middle looks bigger, so the
  // picture is read from nearer its middle.
  const closer = posterScale(a, 15.4 * DEG);
  assert.ok(closer(0) < 1 && closer(0.5) < 1);
  near(closer(0), closer(1e-4), 1e-6, 'middle');
  assert.ok(closer(0.99) > closer(0.5), 'it nears 1 at the edge');
});

test('warpEarth leaves the picture alone for the same view and outside the Earth', () => {
  const n = 64;
  const src = new Uint8ClampedArray(n * n * 4).map((_, i) => (i * 37) % 251);
  const a = POSTER_ANGLE_DEG * DEG;
  const out = warpEarth(src, n, (n / 2) * POSTER_EARTH_SHARE, posterScale(a, a));
  // Bilinear reads at the exact pixel centers give the pixels back.
  let diff = 0;
  for (let i = 0; i < src.length; i++) diff = Math.max(diff, Math.abs(out[i] - src[i]));
  assert.ok(diff <= 1, `changed by ${diff}`);
  const moved = warpEarth(src, n, (n / 2) * POSTER_EARTH_SHARE, posterScale(a, 20 * DEG));
  // A corner pixel is outside the Earth.
  assert.deepEqual([...moved.slice(0, 4)], [...src.slice(0, 4)]);
});

test('warpEarth moves a ring to where the new view draws it', () => {
  const n = 400;
  const earth = (n / 2) * POSTER_EARTH_SHARE;
  const a = POSTER_ANGLE_DEG * DEG;
  const b = 16 * DEG;
  const scale = posterScale(a, b);
  // A bright ring at half the outline's radius in the picture.
  const src = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const r = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / earth;
      const o = (y * n + x) * 4;
      src[o] = src[o + 1] = src[o + 2] = Math.abs(r - 0.5) < 0.01 ? 255 : 0;
      src[o + 3] = 255;
    }
  }
  const out = warpEarth(src, n, earth, scale);
  // Along a row through the middle, the brightest pixel should sit where
  // the new view draws the ring: rho with rho * scale(rho) = 0.5.
  let lo = 0.3;
  let hi = 0.7;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (mid * scale(mid) < 0.5) lo = mid; else hi = mid;
  }
  const want = n / 2 + lo * earth;
  const row = n / 2;
  let best = 0;
  let at = 0;
  for (let x = n / 2; x < n; x++) {
    const v = out[(row * n + x) * 4];
    if (v > best) { best = v; at = x + 0.5; }
  }
  near(at, want, 1.5, 'ring position');
});
