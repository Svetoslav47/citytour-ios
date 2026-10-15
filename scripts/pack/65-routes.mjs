// Stage 6b: routes.json (RouteData) from the committed OSRM foot snapshots (Node 22+ ESM, no network).
//
// Input:  data/raw/osrm/stops-table-foot.json        11 x 11 durations + distances, tour stops in listed order
//         data/raw/osrm/stop-pairs-foot.json(.gz)    one OSRM route (steps, full GeoJSON geometry) per directed pair
// Output: RouteData {
//           nodeIds      the tour stop poiIds in listed order (= the table's row/column order)
//           durationsS   table durations, s (1 decimal);  distancesM  table distances, m (1 decimal)
//           detourFactor median over all ordered pairs i != j of table distance / haversine(stop i, stop j), 3 decimals
//           legs         one RouteLeg per directed pair (110): geometry = projected metres [x0,y0,...] (1 decimal),
//                        Douglas-Peucker 1 m with every maneuver vertex kept; steps = OSRM steps as RouteStep with
//                        geomIndex = VERTEX index of the maneuver point in `geometry` }
// What the app uses (checked on main 2026-10-03): core/route/Planner.ets reads nodeIds, durationsS, distancesM,
// detourFactor and finds legs by fromPoiId/toPoiId for consecutive planned stops; TourController logs legs.length;
// the turn-by-turn LegTracker (task A9) will read geometry + steps (maneuver, modifier, streetName, geomIndex, x, y).

import { haversineM, douglasPeuckerIndices, project, round1, round3 } from './projection.mjs';

export const ROUTE_TOLERANCE_M = 1;

/** OSRM maneuver type -> contracts Maneuver ('other' for merge, ramps, notification, use lane, ...). */
export const MANEUVER_BY_OSRM = Object.freeze({
  depart: 'depart',
  arrive: 'arrive',
  turn: 'turn',
  continue: 'continue',
  'new name': 'new name',
  fork: 'fork',
  'end of road': 'end of road',
  roundabout: 'roundabout',
  rotary: 'roundabout',
  'roundabout turn': 'roundabout',
  'exit roundabout': 'roundabout',
  'exit rotary': 'roundabout',
});

export function maneuverOf(type) {
  return MANEUVER_BY_OSRM[type] ?? 'other';
}

export function median(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return NaN;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Index of the first coordinate at or after `from` equal to `loc` ([lng, lat]); else the nearest one after `from`. */
export function vertexOf(coords, loc, from) {
  for (let k = from; k < coords.length; k++) if (coords[k][0] === loc[0] && coords[k][1] === loc[1]) return k;
  let best = from;
  let bestD = Infinity;
  for (let k = from; k < coords.length; k++) {
    const d = haversineM(coords[k][1], coords[k][0], loc[1], loc[0]);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return Math.min(best, coords.length - 1);
}

/** One OSRM route response -> RouteLeg. */
export function legFromOsrm(fromPoiId, toPoiId, response, tolerance = ROUTE_TOLERANCE_M) {
  if (response?.code !== 'Ok' || !response.routes?.length) throw new Error(`OSRM ${fromPoiId}>${toPoiId}: no route`);
  const route = response.routes[0];
  const coords = route.geometry?.coordinates ?? [];
  if (coords.length < 2) throw new Error(`OSRM ${fromPoiId}>${toPoiId}: geometry has < 2 points`);
  const flat = [];
  for (const [lng, lat] of coords) {
    const p = project(lat, lng);
    flat.push(p.x, p.y);
  }
  const osrmSteps = route.legs.flatMap((l) => l.steps ?? []);
  const stepVertex = [];
  let from = 0;
  for (const s of osrmSteps) {
    const k = vertexOf(coords, s.maneuver.location, from);
    stepVertex.push(k);
    from = k;
  }
  const kept = douglasPeuckerIndices(flat, tolerance, new Set(stepVertex));
  const newIndex = new Map(kept.map((k, i) => [k, i]));
  const geometry = [];
  for (const k of kept) geometry.push(round1(flat[2 * k]), round1(flat[2 * k + 1]));
  const steps = osrmSteps.map((s, i) => {
    const p = project(s.maneuver.location[1], s.maneuver.location[0]);
    return {
      maneuver: maneuverOf(s.maneuver.type),
      modifier: s.maneuver.modifier ?? '',
      streetName: s.name ?? '',
      distanceM: round1(s.distance),
      durationS: round1(s.duration),
      geomIndex: newIndex.get(stepVertex[i]),
      x: round1(p.x),
      y: round1(p.y),
    };
  });
  return {
    fromPoiId,
    toPoiId,
    distanceM: round1(route.distance),
    durationS: round1(route.duration),
    geometry,
    steps,
  };
}

/**
 * RouteData from the table + pair snapshots and the tour. The snapshots must be for the tour's stops
 * (50-fetch-osrm.mjs guards that too); legs are sorted by (from index, to index) in listed order.
 */
export function buildRoutes({ table, pairs, tour }) {
  const stops = tour.stops;
  const nodeIds = stops.map((s) => s.poiId);
  const n = nodeIds.length;
  const metaIds = (table.meta?.stops ?? []).map((s) => s.poiId);
  if (metaIds.join() !== nodeIds.join()) throw new Error('OSRM table snapshot is for other stops than the tour');
  const { durations, distances } = table.response;
  if (durations.length !== n || distances.length !== n) throw new Error(`OSRM table is not ${n} x ${n}`);
  const durationsS = durations.map((row) => row.map(round1));
  const distancesM = distances.map((row) => row.map(round1));
  const ratios = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const h = haversineM(stops[i].lat, stops[i].lng, stops[j].lat, stops[j].lng);
      if (h > 0 && Number.isFinite(distances[i][j])) ratios.push(distances[i][j] / h);
    }
  const detourFactor = round3(median(ratios));
  const index = new Map(nodeIds.map((id, i) => [id, i]));
  const legs = pairs.routes
    .filter((r) => index.has(r.from) && index.has(r.to) && r.from !== r.to)
    .sort((a, b) => index.get(a.from) - index.get(b.from) || index.get(a.to) - index.get(b.to))
    .map((r) => legFromOsrm(r.from, r.to, r.response));
  return { nodeIds, durationsS, distancesM, detourFactor, legs };
}
