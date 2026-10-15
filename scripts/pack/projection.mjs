// CityTour pack pipeline: the pack projection and small planar-geometry helpers (Node 22+ ESM, stdlib only).
//
// The projection MUST stay identical to the app's common/src/main/ets/core/geo/Projection.ets (task A1,
// docs/ARCHITECTURE.md §3.2): a local equirectangular (ENU) projection around Rynek Główny.
//   x = (lng - lng0) * (cos(lat0 * PI / 180) * 111320.0)   // metres east
//   y = (lat - lat0) * 110574.0                           // metres north
// The factor is computed in the same order as Projection.ets (cos first, then * 111320.0) so the doubles match.
// projection.test.mjs pins the three reference points that GeoMath.test.ets pins on the app side.

export const PACK_ORIGIN_LAT = 50.06143;
export const PACK_ORIGIN_LNG = 19.93658;
/** Metres per degree of longitude at the equator. */
export const M_PER_DEG_LNG_EQUATOR = 111320.0;
/** Metres per degree of latitude. */
export const M_PER_DEG_LAT = 110574.0;
export const PACK_ORIGIN = Object.freeze({ lat: PACK_ORIGIN_LAT, lng: PACK_ORIGIN_LNG });

const M_PER_DEG_LNG = Math.cos(PACK_ORIGIN_LAT * Math.PI / 180) * M_PER_DEG_LNG_EQUATOR;

/** Projected metres east of the origin. */
export function projectX(lng) {
  return (lng - PACK_ORIGIN_LNG) * M_PER_DEG_LNG;
}

/** Projected metres north of the origin. */
export function projectY(lat) {
  return (lat - PACK_ORIGIN_LAT) * M_PER_DEG_LAT;
}

export function project(lat, lng) {
  return { x: projectX(lng), y: projectY(lat) };
}

export function unproject(x, y) {
  return { lat: PACK_ORIGIN_LAT + y / M_PER_DEG_LAT, lng: PACK_ORIGIN_LNG + x / M_PER_DEG_LNG };
}

/** Fixed number formatting: 1 decimal (projected metres, distances, durations). -0 becomes 0. */
export function round1(v) {
  const r = Math.round(v * 10) / 10;
  return r === 0 ? 0 : r;
}

export function round3(v) {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r;
}

export function round6(v) {
  const r = Math.round(v * 1e6) / 1e6;
  return r === 0 ? 0 : r;
}

/** Metres -> integer decimetres (map geometry). */
export function toDm(v) {
  const r = Math.round(v * 10);
  return r === 0 ? 0 : r;
}

/** Great-circle distance in metres; same radius as core/route/Planner.ets. */
export const EARTH_RADIUS_M = 6371008.8;
export function haversineM(lat1, lng1, lat2, lng2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLng = (lng2 - lng1) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---------------------------------------------------------------------------------------------
// Planar geometry on flat coordinate arrays [x0, y0, x1, y1, ...]

/** Distance from (px, py) to the segment (ax, ay)-(bx, by). */
export function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Douglas-Peucker on a flat polyline. Returns the indices (vertex numbers, ascending) to keep.
 * `keep` (optional Set of vertex numbers) are always kept: the line is split there and each part is
 * simplified on its own, so maneuver points of a route survive simplification.
 */
export function douglasPeuckerIndices(flat, tolerance, keep = null) {
  const n = flat.length / 2;
  if (n <= 2) return [...Array(n).keys()];
  const anchors = [0];
  if (keep) for (const k of [...keep].sort((a, b) => a - b)) if (k > 0 && k < n - 1) anchors.push(k);
  anchors.push(n - 1);
  const marked = new Uint8Array(n);
  for (const a of anchors) marked[a] = 1;
  for (let s = 0; s + 1 < anchors.length; s++) {
    const stack = [[anchors[s], anchors[s + 1]]];
    while (stack.length) {
      const [i, j] = stack.pop();
      if (j <= i + 1) continue;
      let maxD = -1;
      let idx = -1;
      for (let k = i + 1; k < j; k++) {
        const d = pointSegmentDistance(flat[2 * k], flat[2 * k + 1], flat[2 * i], flat[2 * i + 1], flat[2 * j], flat[2 * j + 1]);
        if (d > maxD) {
          maxD = d;
          idx = k;
        }
      }
      if (maxD > tolerance) {
        marked[idx] = 1;
        stack.push([idx, j], [i, idx]);
      }
    }
  }
  const out = [];
  for (let k = 0; k < n; k++) if (marked[k]) out.push(k);
  return out;
}

export function douglasPeucker(flat, tolerance, keep = null) {
  const idx = douglasPeuckerIndices(flat, tolerance, keep);
  const out = [];
  for (const k of idx) out.push(flat[2 * k], flat[2 * k + 1]);
  return out;
}

/** [minX, minY, maxX, maxY] of a flat array; null when empty. */
export function bboxOf(flat) {
  if (flat.length < 2) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < flat.length; k += 2) {
    if (flat[k] < minX) minX = flat[k];
    if (flat[k] > maxX) maxX = flat[k];
    if (flat[k + 1] < minY) minY = flat[k + 1];
    if (flat[k + 1] > maxY) maxY = flat[k + 1];
  }
  return [minX, minY, maxX, maxY];
}

/** Signed shoelace area of a ring (flat, not repeating the first vertex). Positive = counter-clockwise. */
export function ringArea(flat) {
  let a = 0;
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += flat[2 * j] * flat[2 * i + 1] - flat[2 * i] * flat[2 * j + 1];
  return a / 2;
}

/** Even-odd point-in-ring test (flat ring, first vertex not repeated, or repeated: both work). */
export function pointInRing(x, y, flat) {
  let inside = false;
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = flat[2 * i];
    const yi = flat[2 * i + 1];
    const xj = flat[2 * j];
    const yj = flat[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Point in a polygon given as rings (first = outer, others = holes), even-odd over all rings. */
export function pointInPolygon(x, y, rings) {
  let inside = false;
  for (const r of rings) if (pointInRing(x, y, r)) inside = !inside;
  return inside;
}
