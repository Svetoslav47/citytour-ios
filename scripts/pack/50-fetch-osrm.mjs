#!/usr/bin/env node
// Stage 5: OSRM foot routing between the tour stops -> data/raw/osrm/
//
//   stops-table-foot.json        one `table` call (durations + distances, 11 x 11)
//   stop-pairs-foot.json(.gz)    one `route` call per directed stop pair (11 stops = 110 calls),
//                                overview=full, geometries=geojson, steps=true
//
// Server: the FOSSGIS OSRM demo (routing.openstreetmap.de/routed-foot), fair use, 1 req/s.
// Stop coordinates come from data/tours/royal-route.json. The snapshot records them; if the tour
// coordinates change later, this script refuses to reuse the stale snapshot (re-run with --refresh).
// The pair file is written every 10 routes, so an interrupted run resumes where it stopped.
// The lead's listed-order route data/raw/osrm/royal-route-foot.json is kept as is (task A5 uses it).
//
// Courses (scripts/pack/lib/course.mjs): default course data/raw/osrm/*; any other tour writes the same two files
// under data/raw/tours/<tourId>/osrm/.
//
// Usage: node scripts/pack/50-fetch-osrm.mjs [--offline | --refresh] [--course <courseId> | --tour <tourId>]

import {
  createHttp,
  findSnapshot,
  isMain,
  MissingSnapshotError,
  nowIso,
  readSnapshot,
  readTour,
  runMain,
  writeSnapshot,
} from './lib/http.mjs';
import { resolveCourse } from './lib/course.mjs';

export const OSRM_BASE = 'https://routing.openstreetmap.de/routed-foot';
export const TABLE_REL = 'osrm/stops-table-foot.json';
export const PAIRS_REL = 'osrm/stop-pairs-foot.json';
export const ROUTE_PARAMS = 'overview=full&geometries=geojson&steps=true';
export const TABLE_PARAMS = 'annotations=duration,distance';
const LICENCE = 'Routes computed by OSRM (FOSSGIS demo server) from OpenStreetMap data, © OpenStreetMap contributors, ODbL 1.0';

/** Every ordered pair (i, j), i != j, in row-major order. */
export function directedPairs(n) {
  const out = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) out.push([i, j]);
  return out;
}

export function coordString(stops) {
  return stops.map((s) => `${s.lng.toFixed(6)},${s.lat.toFixed(6)}`).join(';');
}

export function stopsOf(tour) {
  return tour.stops.map((s) => ({ n: s.n, poiId: s.poiId, lat: s.lat, lng: s.lng }));
}

/** Same stops in the same order at the same coordinates (to 1e-6 deg, ~0.1 m)? */
export function sameStops(a, b) {
  return (
    a.length === b.length &&
    a.every((s, i) => s.poiId === b[i].poiId && Math.abs(s.lat - b[i].lat) < 1e-6 && Math.abs(s.lng - b[i].lng) < 1e-6)
  );
}

/** Waypoint hints are opaque server-side ids that change with every OSRM data update: drop them. */
export function stripHints(resp) {
  const strip = (w) => {
    const { hint, ...rest } = w;
    return rest;
  };
  const out = { ...resp };
  for (const k of ['waypoints', 'sources', 'destinations']) if (Array.isArray(out[k])) out[k] = out[k].map(strip);
  return out;
}

export function pairKey(stops, i, j) {
  return `${stops[i].poiId}>${stops[j].poiId}`;
}

function assertOk(resp, what) {
  if (!resp || resp.code !== 'Ok') throw new Error(`OSRM ${what}: code=${resp?.code} ${resp?.message ?? ''}`);
  return resp;
}

function guardStops(snapshot, stops, rel) {
  if (!sameStops(snapshot.meta.stops, stops)) {
    throw new Error(`data/raw/${rel} was fetched for other stop coordinates than the tour file; re-run with --refresh`);
  }
}

async function fetchTable(http, stops) {
  const url = `${OSRM_BASE}/table/v1/foot/${coordString(stops)}?${TABLE_PARAMS}`;
  console.error(`  fetch  OSRM table ${stops.length}x${stops.length}`);
  const resp = assertOk(await http.getJson(url), 'table');
  return {
    meta: { endpoint: `${OSRM_BASE}/table/v1/foot/{coords}`, params: TABLE_PARAMS, profile: 'foot', retrievedAt: nowIso(), licence: LICENCE, stops },
    response: stripHints(resp),
  };
}

async function table(http, args, stops, tableRel) {
  if (!args.refresh && findSnapshot(tableRel)) {
    const snap = readSnapshot(tableRel);
    guardStops(snap, stops, tableRel);
    console.error(`  keep   data/raw/${tableRel} (exists)`);
    return snap;
  }
  if (args.offline) throw new MissingSnapshotError(tableRel);
  const snap = await fetchTable(http, stops);
  writeSnapshot(tableRel, snap);
  console.error(`  wrote  data/raw/${tableRel}`);
  return snap;
}

async function pairs(http, args, stops, pairsRel) {
  const todo = directedPairs(stops.length);
  let snap = null;
  if (!args.refresh && findSnapshot(pairsRel)) {
    snap = readSnapshot(pairsRel);
    guardStops(snap, stops, pairsRel);
  }
  const have = new Set(snap ? snap.routes.map((r) => `${r.from}>${r.to}`) : []);
  const missing = todo.filter(([i, j]) => !have.has(pairKey(stops, i, j)));
  if (!missing.length) {
    console.error(`  keep   data/raw/${pairsRel} (${snap.routes.length} routes)`);
    return snap;
  }
  if (args.offline) {
    if (!snap) throw new MissingSnapshotError(pairsRel);
    throw new Error(`offline: data/raw/${pairsRel} lacks ${missing.length} of ${todo.length} stop pairs`);
  }
  snap ??= {
    meta: {
      endpoint: `${OSRM_BASE}/route/v1/foot/{from};{to}`,
      params: ROUTE_PARAMS,
      profile: 'foot',
      licence: LICENCE,
      stops,
      retrievedAt: null,
    },
    routes: [],
  };
  console.error(`  fetch  ${missing.length} OSRM routes at 1 req/s (~${Math.ceil(missing.length / 60)} min)`);
  let k = 0;
  for (const [i, j] of missing) {
    const url = `${OSRM_BASE}/route/v1/foot/${coordString([stops[i], stops[j]])}?${ROUTE_PARAMS}`;
    const resp = assertOk(await http.getJson(url), `route ${pairKey(stops, i, j)}`);
    snap.routes.push({ from: stops[i].poiId, to: stops[j].poiId, i, j, response: stripHints(resp) });
    snap.meta.retrievedAt = nowIso();
    if (++k % 10 === 0 || k === missing.length) {
      snap.routes.sort((a, b) => a.i - b.i || a.j - b.j);
      writeSnapshot(pairsRel, snap);
      console.error(`  ...    ${snap.routes.length}/${todo.length} routes saved`);
    }
  }
  return snap;
}

/** Listed-order totals from the pair routes: [distance m, duration s]. */
export function listedOrderTotals(pairSnap) {
  const by = new Map(pairSnap.routes.map((r) => [`${r.i}>${r.j}`, r.response.routes[0]]));
  let d = 0;
  let t = 0;
  for (let i = 0; i + 1 < pairSnap.meta.stops.length; i++) {
    const r = by.get(`${i}>${i + 1}`);
    d += r.distance;
    t += r.duration;
  }
  return [d, t];
}

async function main(args) {
  const course = resolveCourse(args);
  const stops = stopsOf(readTour(course.tourFile));
  const http = createHttp();
  const t = await table(http, args, stops, course.rawRel(TABLE_REL));
  const p = await pairs(http, args, stops, course.rawRel(PAIRS_REL));
  const snaps = t.response.sources.map((w, i) => `${stops[i].n}:${w.distance.toFixed(1)}m`).join(' ');
  const [d, s] = listedOrderTotals(p);
  console.log(`osrm table ${t.response.durations.length}x${t.response.durations[0].length}, routes ${p.routes.length}`);
  console.log(`osrm snap distance per stop: ${snaps}`);
  console.log(`osrm listed order: ${Math.round(d)} m, ${(s / 60).toFixed(1)} min`);
}

if (isMain(import.meta.url)) runMain(main);
