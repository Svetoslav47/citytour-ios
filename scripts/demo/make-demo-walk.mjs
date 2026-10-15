#!/usr/bin/env node
// Generates the SIMULATED "Demo walk" location track for the emulator (task A5, docs/ARCHITECTURE.md §5).
//
// The emulator's GPS is a fixed point in Beijing (docs/RISKS.md §1 b4-b6) and the CLI cannot inject locations,
// so the tour is demonstrated with this pre-generated track, replayed by core/sim/DemoWalkPlayer through the
// same pipeline as real fixes. Everything in the output is labelled simulated (`simulated: true`, `notice`).
//
// Input (committed, never fetched here):
//   data/course/<id>/packs/<id>/{routes,tours,pois}.json  the course pack (downloaded by the app): the tour's stops,
//       their OSRM foot legs (geometry + steps) and the walking-time matrix
// The walk follows the pack's legs in the order the app's planner (core/route/Planner, Held-Karp: walking time +
// dwell, fixed first and last stop) visits the stops, so the simulated walker stays on the route the app draws and
// guides along (task A9: turn cues and off-route detection run against exactly these legs).
// Output:
//   data/course/<courseId>/demo-walk.json   (default course krakow; split-city.mjs ships it in the course's tour/ pack,
//                                            the app downloads it with the course)
//   entry/src/test/fixtures/DemoTrackMini.ets  (with --fixture, krakow only: stops 7-11 for A11's replay test)
//
// Every course gets the same PLAIN, predictable walk (a live demo must never surprise the presenter):
//   - starts standing at stop 1 (the planner's fixed start), warms up 8 s (accuracy 30 m -> 6 m);
//   - then the pack's legs stop by stop in the planner's order, so stop n is always reached before stop n+1;
//   - a 40 s dwell at EVERY stop (the last one too), flagged `hold: true` + `stop: n` (the player extends a hold
//     while the story plays, and the app's Skip moves the walker to the start of a stop's hold segment), at the
//     leg's end point (the OSRM snap of the stop), or `dwellTowardPoiM` metres from it towards the stop's POI;
//   - walking speed 1.3 +- 0.15 m/s per leg, gentle per-second variation, accelerates from stops, slows at corners;
//   - GPS-like error: AR(1)-correlated Gaussian jitter, sigma 4 m, reported accuracy 4-9 m;
//   - course over ground from the direction of motion (+- 4 deg), speed ~0 and course unknown while standing.
// The Royal Route (krakow) adds exactly one scripted moment that does not change the order: a ~80 m detour off
// Grodzka between stops 7 and 8 (off-route warning -> re-plan, which keeps stop 8 as the next stop).
// Self-check (the script fails instead of writing a confusing track): wherever a LATER stop's arrival zone (trigger
// radius + accuracy allowance, 2 m margin) is reachable, the planned next stop's own zone is surely reached on the
// same fix (the engine then makes the later stop wait), so the stops can only be marked visited in the planned order.
//
// Usage: node scripts/demo/make-demo-walk.mjs [--course ID] [--seed N] [--out FILE] [--fixture]
// Node 22+, standard library only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unproject } from '../pack/projection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_COURSE = 'krakow';
const DEFAULT_TOUR_ID = 'royal-route';
const FIXTURE_FILE = 'entry/src/test/fixtures/DemoTrackMini.ets';

// ---- parameters (written into the output under "params") ----
const P = {
  seed: 20261004,          // any seed must pass the order self-check below (20261003 grazed St Adalbert's zone)
  start: 'first-stop',
  walkMeanMps: 1.3,
  walkSdMps: 0.15,
  walkMinMps: 1.0,
  walkMaxMps: 1.6,
  jitterSigmaM: 4,
  jitterRho: 0.85,
  courseNoiseDeg: 4,
  dwellS: 40,
  warmupS: 8,
  detourAfterStop: 7,      // on the leg 7 -> 8 (ul. Grodzka)
  detourAtFraction: 0.45,
  detourOutM: 80,
  fixtureFromStop: 7,
  detourSide: 'left',      // east of Grodzka (towards stop 8: the re-plan keeps stop 8 as the next stop)
  // Sts Peter and Paul (stop 8) and St Andrew's (stop 9) are neighbours on Grodzka: the OSRM snap of stop 8 is 39 m
  // from St Andrew's POI. The walker waits in the church forecourt instead (30 m from the snap towards the POI:
  // 10 m from stop 8, 58 m from St Andrew's) and walks back to Grodzka when the story is over.
  dwellTowardPoiM: { 8: 30 },
  // Order self-check margin: the check runs on the exact emitted fixes (jitter included), so a small margin covers
  // the engine's rounding; the closest case is the Royal Route's walk into the Main Square towards St Mary's (stop 3),
  // which passes 2.5 m outside the Cloth Hall's (stop 5, R = 70 m) zone while already inside St Mary's.
  orderMarginM: 2
};
const ACC_ALLOWANCE_CAP_M = 15;     // core/tour/TourConfig.accuracyAllowanceCapM
const DEFAULT_TRIGGER_RADIUS_M = 35; // core/tour/TourConfig.defaultTriggerRadiusM

// ---- CLI ----
const argv = process.argv.slice(2);
let courseId = DEFAULT_COURSE;
let outFile = null;
let writeFixture = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--course') { courseId = String(argv[++i]); }
  else if (a === '--seed') { P.seed = Number(argv[++i]); }
  else if (a === '--out') { outFile = argv[++i]; }
  else if (a === '--fixture') { writeFixture = true; }
  else if (a === '-h' || a === '--help') {
    console.log('node scripts/demo/make-demo-walk.mjs [--course ID] [--seed N] [--out FILE] [--fixture]');
    process.exit(0);
  } else { die(`unknown argument ${a}`); }
}
if (!Number.isInteger(P.seed)) { die('--seed must be an integer'); }
if (!/^[a-z0-9][a-z0-9-]*$/.test(courseId)) { die(`--course ${courseId}: expected a lowercase id like krakow-scholars`); }
const PACK_DIR = `data/course/${courseId}/packs/${courseId}`;
if (outFile === null) { outFile = `data/course/${courseId}/demo-walk.json`; }
// The detour exists only on the Royal Route (krakow); other courses are the plain walk alone (see the header).
const ROYAL = courseId === DEFAULT_COURSE;
if (!ROYAL) {
  if (writeFixture) { die('--fixture is only for the default course krakow'); }
  Object.assign(P, { detourAfterStop: 0, detourAtFraction: 0, detourOutM: 0, fixtureFromStop: 0, detourSide: 'none',
    dwellTowardPoiM: {} });
}

function die(msg) {
  console.error(`make-demo-walk: ${msg}`);
  process.exit(1);
}

// ---- seeded randomness (mulberry32 + Box-Muller) ----
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(P.seed);
let spareGauss = null;
function gauss() {
  if (spareGauss !== null) { const g = spareGauss; spareGauss = null; return g; }
  let u = 0;
  while (u === 0) { u = rnd(); }
  const v = rnd();
  const r = Math.sqrt(-2 * Math.log(u));
  spareGauss = r * Math.sin(2 * Math.PI * v);
  return r * Math.cos(2 * Math.PI * v);
}
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// ---- local planar frame (equirectangular around the route's first point; < 0.1 % error over 2 km) ----
const R = 6371008.8;
const RAD = Math.PI / 180;
let LAT0 = 0;
let LNG0 = 0;
let KX = 1;
function toXY(lat, lng) { return { x: (lng - LNG0) * RAD * R * KX, y: (lat - LAT0) * RAD * R }; }
function toLL(p) { return { lat: LAT0 + p.y / (RAD * R), lng: LNG0 + p.x / (RAD * R * KX) }; }
const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
function bearing(a, b) { return (Math.atan2(b.x - a.x, b.y - a.y) / RAD + 360) % 360; }

// ---- inputs ----
function readJson(rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
  } catch (e) {
    die(`cannot read ${rel}: ${e.message}`);
  }
  return null;
}
const routes = readJson(`${PACK_DIR}/routes.json`);
const tours = readJson(`${PACK_DIR}/tours.json`);
const poisJson = readJson(`${PACK_DIR}/pois.json`);
const tourList = Array.isArray(tours) ? tours : [];
const tour = ROYAL ? tourList.find((t) => t.id === DEFAULT_TOUR_ID) : (tourList.length === 1 ? tourList[0] : undefined);
if (!tour || !Array.isArray(tour.stops) || tour.stops.length < 2) {
  die(`${PACK_DIR}/tours.json has no ${ROYAL ? `tour ${DEFAULT_TOUR_ID}` : 'single tour'}`);
}
if (!Array.isArray(routes?.legs) || !Array.isArray(routes?.nodeIds)) { die(`${PACK_DIR}/routes.json has no legs`); }
const poiById = new Map((Array.isArray(poisJson) ? poisJson : poisJson.pois || []).map((p) => [p.id, p]));
const order = plannedOrder(tour, routes);
const legOf = (a, b) => routes.legs.find((l) => l.fromPoiId === a && l.toPoiId === b);

/**
 * The app planner's order (core/route/Planner + HeldKarp, ARCHITECTURE §6): an open path over the tour's stops that
 * minimises sum(walk duration + dwell of the stop reached), with the fixed first and last stop. Exact DP (11 stops).
 */
function plannedOrder(t, r) {
  const ids = t.stops.map((x) => x.poiId);
  const ix = new Map(r.nodeIds.map((id, i) => [id, i]));
  const dwell = t.stops.map((x) => x.dwellS || 0);
  const c = (a, b) => {
    const v = r.durationsS?.[ix.get(ids[a])]?.[ix.get(ids[b])];
    if (!Number.isFinite(v)) { die(`routes.json has no duration ${ids[a]} -> ${ids[b]}`); }
    return v + dwell[b];
  };
  const first = t.fixedStartPoiId ? ids.indexOf(t.fixedStartPoiId) : 0;
  const last = t.fixedEndPoiId ? ids.indexOf(t.fixedEndPoiId) : -1;
  const mid = ids.map((_, i) => i).filter((i) => i !== first && i !== last);
  const m = mid.length;
  const full = (1 << m) - 1;
  const dp = Array.from({ length: 1 << m }, () => new Array(m).fill(Infinity));
  const par = Array.from({ length: 1 << m }, () => new Array(m).fill(-1));
  for (let a = 0; a < m; a++) { dp[1 << a][a] = c(first, mid[a]); }
  for (let S = 1; S <= full; S++) {
    for (let a = 0; a < m; a++) {
      if (!((S >> a) & 1) || dp[S][a] === Infinity) { continue; }
      for (let b = 0; b < m; b++) {
        if ((S >> b) & 1) { continue; }
        const v = dp[S][a] + c(mid[a], mid[b]);
        if (v < dp[S | (1 << b)][b]) { dp[S | (1 << b)][b] = v; par[S | (1 << b)][b] = a; }
      }
    }
  }
  let best = Infinity;
  let ba = -1;
  for (let a = 0; a < m; a++) {
    const v = dp[full][a] + (last >= 0 ? c(mid[a], last) : 0);
    if (v < best) { best = v; ba = a; }
  }
  const path = [];
  for (let S = full, a = ba; a >= 0;) { path.unshift(mid[a]); const p = par[S][a]; S &= ~(1 << a); a = p; }
  return [first, ...path, ...(last >= 0 ? [last] : [])].map((i) => ids[i]);
}

// Local frame around the first stop's leg start.
const firstLeg = legOf(order[0], order[1]);
if (!firstLeg) { die(`routes.json has no leg ${order[0]} -> ${order[1]}`); }
{
  const ll = unproject(firstLeg.geometry[0], firstLeg.geometry[1]);
  LAT0 = ll.lat;
  LNG0 = ll.lng;
  KX = Math.cos(LAT0 * RAD);
}
/** A pack leg (projected pack metres) as points of the local frame. */
function legPoints(leg) {
  const pts = [];
  for (let i = 0; i + 1 < leg.geometry.length; i += 2) {
    const ll = unproject(leg.geometry[i], leg.geometry[i + 1]);
    const p = toXY(ll.lat, ll.lng);
    if (pts.length === 0 || dist(pts[pts.length - 1], p) > 0.05) { pts.push(p); }
  }
  return pts;
}
const legPts = [];
for (let k = 1; k < order.length; k++) {
  const leg = legOf(order[k - 1], order[k]);
  if (!leg || leg.geometry.length < 4) { die(`routes.json has no leg geometry ${order[k - 1]} -> ${order[k]}`); }
  legPts.push(legPoints(leg));
}
// Stop k (1-based n) is reached at the end of leg k-1; the first stop at the start of leg 0.
const stops = order.map((id, k) => {
  const poi = poiById.get(id);
  if (!poi) { die(`pois.json has no ${id}`); }
  const p = k === 0 ? legPts[0][0] : legPts[k - 1][legPts[k - 1].length - 1];
  return { n: k + 1, poiId: id, name: poi.names?.en || poi.names?.pl || id, lat: poi.lat, lng: poi.lng, p };
});

// ---- the plan: a list of pieces ----
// warmup: { at: XY, s }   walk: { pts: XY[], toStop: n }   dwell: { stop: n, s: seconds }
const pieces = [];
pieces.push({ kind: 'warmup', at: stops[0].p, s: P.warmupS });
pieces.push({ kind: 'dwell', stop: 1, s: P.dwellS });
/** The incoming leg, extended `dwellTowardPoiM` metres from its end towards the stop's POI where asked. */
function legToStop(k) {
  let pts = legPts[k - 1];
  const m = P.dwellTowardPoiM[stops[k].n] || 0;
  if (m > 0) {
    const end = pts[pts.length - 1];
    const poi = toXY(stops[k].lat, stops[k].lng);
    const d = dist(end, poi);
    if (d > 0.5) {
      const p = lerp(end, poi, m / d);
      pts = [...pts, p];
      stops[k].p = p;
    }
  }
  return pts;
}
for (let k = 1; k < stops.length; k++) {
  let pts = legToStop(k);
  if (dist(stops[k - 1].p, pts[0]) > 0.5) { pts = [stops[k - 1].p, ...pts]; }   // from where the walker waited
  if (k === P.detourAfterStop) { pts = withDetour(pts); }
  pieces.push({ kind: 'walk', pts, toStop: stops[k].n });
  pieces.push({ kind: 'dwell', stop: stops[k].n, s: P.dwellS });
}

/** Leaves the polyline at a fraction of its length, walks ~detourOutM sideways and back, rejoins 30 m later. */
function withDetour(pts) {
  const cum = cumulative(pts);
  const total = cum[cum.length - 1];
  const a = pointAt(pts, cum, total * P.detourAtFraction);
  const b = pointAt(pts, cum, total * P.detourAtFraction + 30);
  const ux = (b.p.x - a.p.x) / 30;
  const uy = (b.p.y - a.p.y) / 30;
  // Normal to the right (west of Grodzka, which runs south) or, with detourSide 'left', to the left (east).
  const sgn = P.detourSide === 'left' ? -1 : 1;
  const nx = sgn * uy;
  const ny = -sgn * ux;
  const off = (d, along) => ({ x: a.p.x + nx * d + ux * along, y: a.p.y + ny * d + uy * along });
  const out = P.detourOutM;
  const excursion = [off(out * 0.35, 4), off(out * 0.7, 8), off(out * 0.95, 12), off(out * 0.95, 18),
    off(out * 0.6, 23), off(out * 0.25, 27)];
  return [...pts.slice(0, a.i + 1), a.p, ...excursion, b.p, ...pts.slice(b.i + 1)];
}

function cumulative(pts) {
  const c = [0];
  for (let i = 1; i < pts.length; i++) { c.push(c[i - 1] + dist(pts[i - 1], pts[i])); }
  return c;
}
/** Point at arc length s; i = index of the segment start. */
function pointAt(pts, cum, s) {
  const total = cum[cum.length - 1];
  const t = clamp(s, 0, total);
  let i = 0;
  while (i < pts.length - 2 && cum[i + 1] < t) { i++; }
  const segLen = cum[i + 1] - cum[i];
  const f = segLen > 0 ? (t - cum[i]) / segLen : 0;
  return { p: lerp(pts[i], pts[i + 1], f), i };
}
/** Turn angle (deg) at the vertex nearest to arc length s, within `win` metres. */
function sharpTurnNear(pts, cum, s, win) {
  for (let i = 1; i < pts.length - 1; i++) {
    if (Math.abs(cum[i] - s) <= win) {
      const turn = Math.abs(((bearing(pts[i], pts[i + 1]) - bearing(pts[i - 1], pts[i]) + 540) % 360) - 180);
      if (turn > 45 && dist(pts[i - 1], pts[i]) > 2 && dist(pts[i], pts[i + 1]) > 2) { return true; }
    }
  }
  return false;
}

// ---- simulation at 1 Hz ----
const fixes = [];
const stopLog = new Map(); // n -> { arrivalMs, departMs, mode }: the stop's hold segment
const events = [];
let t = 0;
const jit = { x: 0, y: 0 };
let accM = 6;
function stepJitter(sigma, rho) {
  const k = Math.sqrt(1 - rho * rho) * sigma;
  jit.x = rho * jit.x + k * gauss();
  jit.y = rho * jit.y + k * gauss();
}
function emit(truth, speed, course, opts) {
  const ll = toLL({ x: truth.x + jit.x, y: truth.y + jit.y });
  const f = {
    tRelMs: t * 1000,
    lat: Number(ll.lat.toFixed(7)),
    lng: Number(ll.lng.toFixed(7)),
    accuracyM: Number(opts.acc.toFixed(1)),
    speedMps: Number(Math.max(0, speed).toFixed(2)),
    courseDeg: course === null ? null : Number(((course + 360) % 360).toFixed(1)),
    courseAccuracyDeg: course === null ? null : Number(opts.crsAcc.toFixed(1))
  };
  if (opts.hold) { f.hold = true; f.stop = opts.stop; }
  fixes.push(f);
  t++;
}
function normalAccuracy() {
  accM = clamp(accM + 0.4 * gauss(), 4, 9);
  return accM;
}

for (const piece of pieces) {
  if (piece.kind === 'warmup') {
    for (let k = 0; k < piece.s; k++) {
      stepJitter(P.jitterSigmaM * 2, P.jitterRho);
      const acc = 30 - (24 * k) / Math.max(1, piece.s - 1);
      emit(piece.at, Math.abs(0.1 * gauss()), null, { acc });
    }
    events.push({ kind: 'warmup', fromMs: 0, toMs: (t - 1) * 1000, note: 'standing at the start, accuracy 30 m -> 6 m' });
  } else if (piece.kind === 'dwell') {
    const s = stops[piece.stop - 1];
    stopLog.set(piece.stop, { arrivalMs: t * 1000, departMs: (t + piece.s - 1) * 1000, mode: 'dwell' });
    let wander = { x: 0, y: 0 };
    for (let k = 0; k < piece.s; k++) {
      stepJitter(P.jitterSigmaM, P.jitterRho);
      wander = { x: clamp(wander.x + 0.3 * gauss(), -3, 3), y: clamp(wander.y + 0.3 * gauss(), -3, 3) };
      emit({ x: s.p.x + wander.x, y: s.p.y + wander.y }, Math.abs(0.12 * gauss()), null,
        { acc: normalAccuracy(), hold: true, stop: piece.stop });
    }
  } else {
    const pts = piece.pts;
    const cum = cumulative(pts);
    const total = cum[cum.length - 1];
    const legSpeed = clamp(P.walkMeanMps + P.walkSdMps * gauss(), P.walkMinMps, P.walkMaxMps);
    let s = 0;
    let k = 0;
    let vNoise = 0;
    while (s < total - 0.05) {
      vNoise = 0.8 * vNoise + 0.6 * 0.05 * gauss();
      let v = legSpeed * (1 + vNoise);
      v *= Math.min(1, (k + 1) / 3);                        // accelerate over ~3 s
      v = Math.min(v, Math.max(0.5, (total - s) / 2));       // slow down into the stop
      if (sharpTurnNear(pts, cum, s, 3)) { v *= 0.85; }       // corners
      s = Math.min(total, s + v);
      const here = pointAt(pts, cum, s).p;
      const back = pointAt(pts, cum, Math.max(0, s - 4)).p;
      const ahead = pointAt(pts, cum, Math.min(total, s + 2)).p;
      const course = bearing(back, ahead) + P.courseNoiseDeg * gauss();
      stepJitter(P.jitterSigmaM, P.jitterRho);
      emit(here, v + 0.08 * gauss(), course, { acc: normalAccuracy(), crsAcc: 8 + 3 * Math.abs(gauss()) });
      k++;
    }
  }
}

// Detour window = fixes farther than 35 m from the planned leg (computed on the truth-free output for honesty).
function distToLine(p, poly) {
  let best = Infinity;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    const L2 = (b.x - a.x) ** 2 + (b.y - a.y) ** 2;
    const u = L2 > 0 ? clamp(((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / L2, 0, 1) : 0;
    best = Math.min(best, dist(p, lerp(a, b, u)));
  }
  return best;
}
if (P.detourAfterStop > 0) {
  const s7 = stopLog.get(P.detourAfterStop);
  const s8 = stopLog.get(P.detourAfterStop + 1);
  let first = -1;
  let last = -1;
  let maxOff = 0;
  for (const f of fixes) {
    if (f.tRelMs <= s7.departMs || f.tRelMs >= s8.arrivalMs) { continue; }
    const d = distToLine(toXY(f.lat, f.lng), legPts[P.detourAfterStop - 1]);
    maxOff = Math.max(maxOff, d);
    if (d > 35) {
      if (first < 0) { first = f.tRelMs; }
      last = f.tRelMs;
    }
  }
  events.push({ kind: 'detour', fromMs: first, toMs: last, maxOffRouteM: Math.round(maxOff),
    note: `leg ${P.detourAfterStop}->${P.detourAfterStop + 1}, window = fixes more than 35 m from the route` });
}
events.sort((a, b) => a.fromMs - b.fromMs);

// ---- order self-check: only the planned next stop can be entered ----
// The engine (core/tour/TourEngine.checkArrivalAndApproach) enters any open stop whose geofence confirms, except that
// a different stop waits while the planned next stop (the target) is itself inside its zone on the same fix (its
// entry streak is running). With k = the stop the walker is heading for or standing at (the warm-up counts as
// heading for stop 1), the target is k, or k + 1 once k has been entered and its story is over. Per fix:
//   (a) if any stop j > k is enterable, k must surely be inside its zone (target k: the others wait);
//   (b) once k may have been entered (the walker has been in k's zone, or stands at k), if any stop j > k + 1 is
//       enterable, k + 1 must surely be inside its zone (target k + 1: the others wait).
// "Enterable" is the engine's accuracy-aware entry distance d - min(acc, 15) <= R (+ margin), "surely inside" the
// same <= R - margin. The check runs per fix, so it also holds when the player skips samples at x2..x8.
const zoneOf = stops.map((s) => {
  const poi = poiById.get(s.poiId);
  const r = Number.isFinite(poi?.triggerRadiusM) && poi.triggerRadiusM > 0 ? poi.triggerRadiusM : DEFAULT_TRIGGER_RADIUS_M;
  return { r, p: toXY(s.lat, s.lng) };
});
const orderProblems = [];
let minClearanceM = Infinity;
{
  let heading = 1;
  let mayHaveEntered = false;
  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i];
    const standing = f.hold === true;
    if (!standing && i > 0 && fixes[i - 1].hold === true) {   // left stop k's hold: heading for k + 1
      heading = fixes[i - 1].stop + 1;
      mayHaveEntered = false;
    }
    if (standing && f.stop !== heading) { die(`hold of stop ${f.stop} while heading for stop ${heading}`); }
    const allowance = Math.min(f.accuracyM, ACC_ALLOWANCE_CAP_M);
    const here = toXY(f.lat, f.lng);
    const entryOver = (n) => dist(here, zoneOf[n - 1].p) - allowance - zoneOf[n - 1].r;   // <= 0: enterable
    const sure = (n) => n <= stops.length && entryOver(n) <= -P.orderMarginM;
    if (standing || entryOver(heading) <= P.orderMarginM) { mayHaveEntered = true; }
    const check = (from, guard, why) => {
      if (sure(guard)) { return; }
      for (let j = from; j <= stops.length; j++) {
        const clearance = entryOver(j);
        minClearanceM = Math.min(minClearanceM, clearance);
        if (clearance < P.orderMarginM && orderProblems.length < 10) {
          orderProblems.push(`t=${f.tRelMs / 1000}s ${standing ? 'at' : 'to'} stop ${heading} (${why}): ` +
            `stop ${j} (${stops[j - 1].name}) zone only ${clearance.toFixed(1)} m away`);
        }
      }
    };
    check(heading + 1, heading, 'a');
    if (mayHaveEntered) { check(heading + 2, heading + 1, 'b'); }
  }
}
if (orderProblems.length > 0) {
  die(`a later stop could be entered before the planned one:\n  ${orderProblems.join('\n  ')}`);
}

// ---- output ----
let walkedM = 0;
for (const pc of pieces) {
  if (pc.kind === 'walk') { const c = cumulative(pc.pts); walkedM += c[c.length - 1]; }
}
const track = {
  id: ROYAL ? 'royal-route-walk' : `${tour.id}-walk`,
  name: ROYAL ? 'Royal Route demo walk' : `${tour.titles?.en ?? tour.id} demo walk`,
  simulated: true,
  notice: 'SIMULATED location track for the emulator demo (the emulator GPS is a fixed point). Not recorded GPS.',
  generatedBy: 'scripts/demo/make-demo-walk.mjs',
  source: `${PACK_DIR}/routes.json (the pack's OSRM foot legs in the planner's order, OSM data ODbL)`,
  params: P,
  summary: { fixes: fixes.length, durationS: fixes.length - 1, walkedM: Math.round(walkedM),
    minLaterStopClearanceM: Number(minClearanceM.toFixed(1)) },
  stops: stops.map((s) => ({
    n: s.n, poiId: s.poiId, name: s.name, lat: s.lat, lng: s.lng,
    mode: stopLog.get(s.n).mode, arrivalMs: stopLog.get(s.n).arrivalMs, departMs: stopLog.get(s.n).departMs
  })),
  events,
  fixes
};

function writeTrackJson(file, tr) {
  // One fix per line keeps diffs readable.
  const head = { ...tr };
  delete head.fixes;
  let body = JSON.stringify(head, null, 1);
  body = body.slice(0, body.lastIndexOf('}')).replace(/\s*$/, '');
  body += ',\n "fixes": [\n' + tr.fixes.map((f) => '  ' + JSON.stringify(f)).join(',\n') + '\n ]\n}\n';
  const abs = path.isAbsolute(file) ? file : path.join(ROOT, file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  JSON.parse(fs.readFileSync(abs, 'utf8')); // self-check
  return abs;
}

const outAbs = writeTrackJson(outFile, track);
console.log(`make-demo-walk: SIMULATED track -> ${path.relative(ROOT, outAbs)}`);
console.log(`  seed=${P.seed} start=${P.start} fixes=${fixes.length} duration=${fmt(fixes.length - 1)} walked=${Math.round(walkedM)} m` +
  ` bytes=${fs.statSync(outAbs).size}`);
for (const s of track.stops) {
  console.log(`  stop ${String(s.n).padStart(2)} ${s.mode.padEnd(6)} at ${fmt(s.arrivalMs / 1000)}  ${s.name}`);
}
for (const e of events) {
  console.log(`  event ${e.kind} ${fmt(e.fromMs / 1000)}-${fmt(e.toMs / 1000)}${e.maxOffRouteM ? ` max ${e.maxOffRouteM} m off-route` : ''}`);
}

function fmt(sec) {
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.round(sec - m * 60)).padStart(2, '0')}`;
}

if (writeFixture) {
  // Stops >= fixtureFromStop (the detour, then a dwell at every stop to Wawel), times rebased to 0. Compact rows:
  // [tRelMs, lat, lng, accuracyM, speedMps, courseDeg (-1 = unknown), hold stop number (0 = moving)].
  const t0 = stopLog.get(P.fixtureFromStop).arrivalMs;
  const rows = fixes.filter((f) => f.tRelMs >= t0).map((f) =>
    `[${f.tRelMs - t0}, ${f.lat}, ${f.lng}, ${f.accuracyM}, ${f.speedMps}, ${f.courseDeg === null ? -1 : f.courseDeg}, ${f.hold ? f.stop : 0}]`);
  const fixtureStops = track.stops.filter((s) => s.n >= P.fixtureFromStop);
  const miniStops = fixtureStops.map((s) =>
    `  { n: ${s.n}, poiId: '${s.poiId}', name: '${s.name.replace(/'/g, '\\\'')}', lat: ${s.lat}, lng: ${s.lng}, ` +
    `triggerRadiusM: ${zoneOf[s.n - 1].r}, mode: '${s.mode}', arrivalMs: ${s.arrivalMs - t0}, departMs: ${s.departMs - t0} }`);
  // The pack's legs between every ordered pair of the fixture stops (a re-plan may pick any of them) and their
  // walking matrix, verbatim from routes.json (pack projection, like RouteLeg.geometry in the app).
  const MAN = { 'depart': 'DEPART', 'turn': 'TURN', 'continue': 'CONTINUE', 'new name': 'NEW_NAME', 'fork': 'FORK',
    'end of road': 'END_OF_ROAD', 'roundabout': 'ROUNDABOUT', 'arrive': 'ARRIVE' };
  const q = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
  const miniIds = fixtureStops.map((s) => s.poiId);
  const miniLegs = [];
  for (const a of miniIds) {
    for (const b of miniIds) {
      if (a === b) { continue; }
      const l = legOf(a, b);
      if (!l) { die(`routes.json has no leg ${a} -> ${b}`); }
      const steps = l.steps.map((st) => `st(Maneuver.${MAN[st.maneuver] || 'OTHER'}, ${q(st.modifier)}, ` +
        `${q(st.streetName)}, ${st.distanceM}, ${st.durationS}, ${st.geomIndex}, ${st.x}, ${st.y})`);
      miniLegs.push(`  leg(${q(a)}, ${q(b)}, ${l.distanceM}, ${l.durationS}, [${l.geometry.join(', ')}], [\n` +
        `    ${steps.join(',\n    ')}\n  ])`);
    }
  }
  const ix = new Map(routes.nodeIds.map((id, i) => [id, i]));
  const sub = (mx) => miniIds.map((a) => `[${miniIds.map((b) => mx[ix.get(a)][ix.get(b)]).join(', ')}]`).join(', ');
  const miniEvents = events.filter((e) => e.fromMs >= t0).map((e) =>
    `  { kind: '${e.kind}', fromMs: ${e.fromMs - t0}, toMs: ${e.toMs - t0} }`);
  const ets = `/*
 * GENERATED by \`node scripts/demo/make-demo-walk.mjs --fixture\` (seed ${P.seed}). Do not edit by hand.
 * SIMULATED: the last part of the Royal Route Demo walk (stops ${P.fixtureFromStop}-11: a dwell at every stop, the ~80 m
 * detour between stops ${P.detourAfterStop} and ${P.detourAfterStop + 1}), times rebased to 0, for the replay test (A11).
 * Row = [tRelMs, lat, lng, accuracyM, speedMps, courseDeg (-1 = unknown), hold stop number (0 = moving)].
 */
import { DemoFix, DemoStop, DemoTrack } from 'common';
import { Maneuver, RouteLeg, RouteStep } from 'common';

export interface MiniStop {
  n: number;
  poiId: string;     // the pack POI of the stop
  name: string;
  lat: number;
  lng: number;
  triggerRadiusM: number;  // the pack POI's arrival radius (the replay uses the app's real geofences)
  mode: string;      // 'dwell' (every stop)
  arrivalMs: number;
  departMs: number;
}

export interface MiniEvent {
  kind: string;      // 'detour'
  fromMs: number;
  toMs: number;
}

export const DEMO_MINI_STOPS: MiniStop[] = [
${miniStops.join(',\n')}
];

export const DEMO_MINI_EVENTS: MiniEvent[] = [
${miniEvents.join(',\n')}
];

/** routes.json walking matrix of the fixture stops (DEMO_MINI_STOPS order). */
export const DEMO_MINI_DIST_M: number[][] = [${sub(routes.distancesM)}];
export const DEMO_MINI_DUR_S: number[][] = [${sub(routes.durationsS)}];

function st(m: Maneuver, modifier: string, street: string, d: number, t: number, gi: number, x: number,
  y: number): RouteStep {
  const s: RouteStep = {
    maneuver: m, modifier: modifier, streetName: street, distanceM: d, durationS: t, geomIndex: gi, x: x, y: y
  };
  return s;
}

function leg(from: string, to: string, d: number, t: number, g: number[], steps: RouteStep[]): RouteLeg {
  const l: RouteLeg = { fromPoiId: from, toPoiId: to, distanceM: d, durationS: t, geometry: g, steps: steps };
  return l;
}

/** The pack's legs between every ordered pair of fixture stops (routes.json, verbatim). */
export function demoMiniLegs(): RouteLeg[] {
  return [
${miniLegs.join(',\n')}
  ];
}

const ROWS: number[][] = [
${rows.map((r) => '  ' + r).join(',\n')}
];

export function demoTrackMini(): DemoTrack {
  const fixes: DemoFix[] = [];
  for (const r of ROWS) {
    const f: DemoFix = {
      tRelMs: r[0], lat: r[1], lng: r[2], accuracyM: r[3], speedMps: r[4],
      courseDeg: r[5] < 0 ? Number.NaN : r[5], courseAccuracyDeg: r[5] < 0 ? Number.NaN : 10,
      hold: r[6] > 0, stop: r[6]
    };
    fixes.push(f);
  }
  const t: DemoTrack = {
    id: 'royal-route-walk-mini', name: 'Royal Route demo walk (stops ${P.fixtureFromStop}-11)', simulated: true,
    generatedBy: 'scripts/demo/make-demo-walk.mjs --fixture', fixes: fixes, stops: DEMO_MINI_STOPS.map((s: MiniStop) => {
      const d: DemoStop = { n: s.n, poiId: s.poiId };
      return d;
    })
  };
  return t;
}
`;
  const abs = path.join(ROOT, FIXTURE_FILE);
  fs.writeFileSync(abs, ets);
  console.log(`  fixture -> ${FIXTURE_FILE} (${rows.length} fixes)`);
}
