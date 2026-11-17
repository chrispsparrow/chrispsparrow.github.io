// idle-earth.js
// Where the whole Earth sits in the 3D view while Track a Rocket has
// nothing to show (the idle view), worked out from the view's size alone.
// globe-view.js aims its camera with idleFit(). map-view.js uses
// idleOutline() to lay the globe's poster (a still of that same view,
// assets/flight-console/globe-poster.webp) exactly over where the real
// Earth will draw, before Cesium has even downloaded.
//
// The Earth fits the free part of the view: the view minus the band the
// controls and credits take along the bottom (bottomBand, at most
// IDLE_BOTTOM_MAX of the view's height), with IDLE_MARGIN of that part's
// smaller side to spare. The camera looks a touch south of straight down,
// so the Earth's middle lands in the middle of the free part.
//   Cesium's field of view (GLOBE_FOV_DEG, its own default) spans the
//   view's wider side. A pixel at the middle of the view is 1 / f
//   radians, with f worked out from the view's height and its vertical
//   field of view. The Earth's outline is f * tan(a) px across its middle
//   from distance d, where sin(a) = R / d. So for an outline radius r px,
//   a = atan(r / f) and d = R / sin(a). Tilting the camera b = atan(s / f)
//   moves the Earth's middle s px up the screen.
//
// The poster was drawn for one shape of view (POSTER_ANGLE_DEG, my laptop's
// window). Other shapes see the Earth from a little closer or farther. The
// outline is matched by sizing the poster, but the inside differs too: seen
// from closer up, the middle of the Earth's face looks bigger and the parts
// near the edge more squeezed. So before the poster shows, warpEarth()
// moves each of its pixels in or out to where the real view will draw that
// spot (see posterScale).
//
// Used by: globe-view.js and map-view.js. No imports.

// The share of the free part's smaller side left free around the Earth.
export const IDLE_MARGIN = 0.1;
// The bottom band counts for at most this share of the view's height.
export const IDLE_BOTTOM_MAX = 0.4;
// Cesium's field of view (degrees), which the 3D view never changes.
export const GLOBE_FOV_DEG = 60;

// For a view w by hgt px with a bottom band of bottomBand px:
//   f         px per radian at the middle of the view
//   radius    the Earth's outline radius (px) the camera aims for
//   angle     the Earth's angular radius (radians), atan(radius / f)
//   tilt      how far (radians) the camera looks south of straight down
//   freeH     the free part's height (px)
// fov is the camera's field of view in radians (Cesium's frustum.fov).
export function idleFit(w, hgt, bottomBand, fov = GLOBE_FOV_DEG * Math.PI / 180) {
  const bottom = Math.min(hgt * IDLE_BOTTOM_MAX, Math.max(0, bottomBand || 0));
  const freeH = hgt - bottom;
  const fovy = w > hgt ? 2 * Math.atan(Math.tan(fov / 2) * hgt / w) : fov;
  const f = (hgt / 2) / Math.tan(fovy / 2);
  const radius = (Math.min(w, freeH) / 2) * (1 - IDLE_MARGIN);
  return { f, radius, angle: Math.atan(radius / f), tilt: Math.atan((hgt / 2 - freeH / 2) / f), freeH };
}

// Where the Earth's outline lands on screen in the idle view: an ellipse
// centered at (cx, cy) px from the view's top left, rx px wide and ry px
// tall (half sizes). With no bottom band it is a circle of idleFit's
// radius in the middle of the view. With a band the camera is tilted, and
// a sphere seen off to one side draws a little taller than it is wide and
// a little further from the middle than its own center:
//   A ray through screen point (x, y) (y up from the middle) touches the
//   Earth where its angle to the Earth's middle is a. With the middle
//   b up from the view's axis, that is
//     (y sin b + f cos b)^2 = cos^2 a (x^2 + y^2 + f^2),
//   an ellipse with its center k = f sin b cos b / D up from the middle,
//   where D = cos^2 a - sin^2 b, and half sizes sqrt(N) / cos a across
//   and sqrt(N / D) up and down, where N = D k^2 - f^2 (cos^2 a - cos^2 b).
// faceY is where the middle of the Earth's face shows (f tan b up from the
// view's middle), a little below the outline's center when the camera is
// tilted.
export function idleOutline(w, hgt, bottomBand, fov) {
  const { f, angle: a, tilt: b } = idleFit(w, hgt, bottomBand, fov);
  const cosA2 = Math.cos(a) ** 2;
  const D = cosA2 - Math.sin(b) ** 2;
  const k = f * Math.sin(b) * Math.cos(b) / D;
  const N = D * k * k - f * f * (cosA2 - Math.cos(b) ** 2);
  return { cx: w / 2, cy: hgt / 2 - k, rx: Math.sqrt(N) / Math.cos(a), ry: Math.sqrt(N / D), faceY: hgt / 2 - f * Math.tan(b) };
}

// ------------------------------------------------------------------
// The globe's poster
// ------------------------------------------------------------------

// The idle view the poster was drawn from: the Earth's angular radius
// (degrees) in a view 1440 by 582 px with nothing along its bottom
// (atan(0.45 * 582 / f), f = 720 / tan(30 degrees)). The README says how
// the poster was made.
export const POSTER_ANGLE_DEG = Math.atan((0.45 * 582) / (720 / Math.tan(Math.PI / 6))) * 180 / Math.PI;
// The poster is a square with the Earth's outline across this share of its
// width.
export const POSTER_EARTH_SHARE = 1 / 1.05;

// Where a spot on the Earth's face lands, for a camera that sees the Earth
// at angular radius angle (so d = 1 / sin(angle) Earth radii from its
// center, looking at the middle): a spot phi radians around the Earth from
// the middle of its face shows rho of the outline's radius out from the
// middle, with
//   rho = sin(phi) sqrt(d^2 - 1) / (d - cos(phi)).
// The outline (rho = 1) is at phi = 90 degrees minus angle.
export function earthRho(phi, angle) {
  const d = 1 / Math.sin(angle);
  return Math.sin(phi) * Math.sqrt(d * d - 1) / (d - Math.cos(phi));
}

// The other way: the phi that shows at rho (0 to 1). With
// t = rho / sqrt(d^2 - 1) the sum above is sin(phi) + t cos(phi) = t d, so
// phi = asin(t d / sqrt(1 + t^2)) - atan(t).
export function earthPhi(rho, angle) {
  const d = 1 / Math.sin(angle);
  const t = rho / Math.sqrt(d * d - 1);
  return Math.asin(Math.min(1, t * d / Math.sqrt(1 + t * t))) - Math.atan(t);
}

// For drawing the Earth as seen at angle `to` from a picture of it taken at
// angle `from`: the function that gives, for a point rho of the outline's
// radius out from the middle in the new view, how much farther out (or in)
// to look in the picture, as a factor (picture rho / new rho). A spot the
// picture can't see (past its own outline) is taken from its outline.
export function posterScale(from, to) {
  const limb = Math.PI / 2 - from;
  const d0 = 1 / Math.sin(from);
  const d1 = 1 / Math.sin(to);
  // Near the middle, rho is about phi sqrt((d + 1) / (d - 1)).
  const middle = Math.sqrt((d0 + 1) / (d0 - 1)) / Math.sqrt((d1 + 1) / (d1 - 1));
  return (rho) => {
    if (rho < 1e-6) return middle;
    return earthRho(Math.min(earthPhi(rho, to), limb), from) / rho;
  };
}

// Warps a square picture of the Earth (RGBA pixels, n by n, the Earth's
// outline earthPx px across its radius, in the middle) as posterScale's
// scale says, into a new array. faceShift (px, down) moves the middle of
// the Earth's face below the outline's center, as a tilted camera sees it
// (see faceY in idleOutline). Outside the outline nothing moves. Each
// pixel inside is read from the picture with bilinear filtering.
export function warpEarth(src, n, earthPx, scale, faceShift = 0) {
  const out = new Uint8ClampedArray(src);
  const LUT = 4096;
  const lut = new Float32Array(LUT + 1);
  // The scale against the squared radius, so no square roots per pixel.
  for (let i = 0; i <= LUT; i++) lut[i] = scale(Math.sqrt(i / LUT));
  const c = n / 2;
  const inv = 1 / (earthPx * earthPx);
  const lo = Math.max(0, Math.floor(c - earthPx));
  const hi = Math.min(n, Math.ceil(c + earthPx));
  const row = n * 4;
  const e2 = earthPx * earthPx;
  const d2 = faceShift * faceShift;
  for (let y = lo; y < hi; y++) {
    const dyOutline = y + 0.5 - c;
    const dy = dyOutline - faceShift;
    for (let x = lo; x < hi; x++) {
      const dx = x + 0.5 - c;
      if ((dx * dx + dyOutline * dyOutline) * inv >= 1) continue;
      // How far out the point is, from the face's middle toward the
      // outline (0 to 1): its distance over the distance from the face's
      // middle to the outline in its direction. So the outline always maps
      // onto the picture's own outline, however far the face's middle sits
      // below the outline's center.
      const r = Math.sqrt(dx * dx + dy * dy);
      let s;
      if (r < 1e-6) s = lut[0];
      else {
        const uy = dy / r;
        const reach = -uy * faceShift + Math.sqrt(Math.max(0, uy * uy * d2 - d2 + e2));
        const rho = Math.min(1, r / reach);
        // The picture's radius for that point, earthPx * rho * scale(rho),
        // turned into a factor on (dx, dy).
        s = (lut[(rho * rho * LUT) | 0] * rho * earthPx) / r;
      }
      const sx = Math.min(n - 1.001, Math.max(0, c + dx * s - 0.5));
      const sy = Math.min(n - 1.001, Math.max(0, c + dy * s - 0.5));
      const ix = sx | 0;
      const iy = sy | 0;
      const fx = sx - ix;
      const fy = sy - iy;
      const a = iy * row + ix * 4;
      const b = a + row;
      const o = y * row + x * 4;
      for (let k = 0; k < 3; k++) {
        const top = src[a + k] + (src[a + 4 + k] - src[a + k]) * fx;
        const bottom = src[b + k] + (src[b + 4 + k] - src[b + k]) * fx;
        out[o + k] = top + (bottom - top) * fy;
      }
    }
  }
  return out;
}
