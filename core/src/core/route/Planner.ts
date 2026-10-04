/*
 * Tour planner: pack + tour + user position -> cost inputs -> TourPlan (docs/ARCHITECTURE.md §6, PLAN task A2).
 * Pure: no @kit imports and no logging. The caller (TourController, A7) logs ROUTE_PLAN algo/exact/ms and one
 * ROUTE_FALLBACK per entry of PlanInputs.estimatedPairs.
 *
 * Cost model (§6.1): c(i,j) = walkDurationS(i,j) + dwellS(j).
 *   - stop<->stop walking from the pack's OSRM foot matrix (RouteData.durationsS / distancesM);
 *     a missing or invalid entry falls back to haversine x detourFactor (at WALK_SPEED_MPS) and is reported;
 *   - origin->stop walking = haversine x detourFactor, at WALK_SPEED_MPS;
 *   - a stop within SNAP_RADIUS_M of the user becomes the origin (it is visited first, walk cost 0);
 *   - a pending Tour.fixedStartPoiId is always visited first (it takes precedence over snapping);
 *   - a pending Tour.fixedEndPoiId is visited last on a full tour; under a time budget (X1, "I have N minutes") the
 *     end is free, so a short walk picks the best cluster instead of spending the budget walking to the far end.
 * "savedM" = walking metres of the remaining stops in the tour's listed order minus those of the planned order
 * (same stop set, same origin). It can be negative in principle, because the solver minimises time, not metres.
 */
import { LatLng, Poi, RouteData, RouteLeg, Tour } from '../../contracts/Model';
import { TourPlan } from '../../contracts/EngineTypes';
import { PathPlan, solveOpenPath, solveOrienteering } from './HeldKarp';

/** Walking speed for haversine-based estimates (ARCHITECTURE §6.1). */
export const WALK_SPEED_MPS: number = 1.30;
/** A stop this close to the user becomes the origin node (ARCHITECTURE §6.1). */
export const SNAP_RADIUS_M: number = 30;
/** Used when RouteData.detourFactor is missing or invalid (ARCHITECTURE §6.1). */
export const DEFAULT_DETOUR_FACTOR: number = 1.25;
const EARTH_RADIUS_M: number = 6371008.8;

/**
 * What the planner needs from the offline pack. Not a shared contract: TourController builds it from
 * PackRepository as `{ pois: repo.pois(), routes: repo.routes() }`.
 */
export interface CityPack {
  pois: Poi[];
  routes: RouteData;
}

/** Cost inputs for plan(). Index i in every array refers to stopIds[i] (remaining stops, listed order). */
export class PlanInputs {
  tourId: string = '';
  stopIds: string[] = [];
  dwellS: number[] = [];
  prize: number[] = [];
  originKnown: boolean = false;  // false when the origin has no valid fix: walking from it costs 0
  originM: number[] = [];        // user origin -> stop i, metres (haversine x detour; 0 for the snapped stop)
  originS: number[] = [];        // user origin -> stop i, walking seconds
  distM: number[][] = [];        // stop i -> stop j, metres
  durS: number[][] = [];         // stop i -> stop j, walking seconds (no dwell)
  headIdx: number = -1;          // forced first stop: pending fixed start, else the snapped stop; -1 none
  snappedIdx: number = -1;       // stop within SNAP_RADIUS_M of the user; -1 none
  endIdx: number = -1;           // pending fixed end; -1 none
  legs: RouteLeg[] = [];         // the pack's legs, attached to the plan when every leg is present
  estimatedPairs: string[] = []; // 'fromId>toId' pairs filled from haversine (log ROUTE_FALLBACK)
  droppedIds: string[] = [];     // remaining ids that are not stops of this tour or have no POI in the pack
}

export function buildCostInputs(pack: CityPack, tour: Tour, remaining: string[], origin: LatLng): PlanInputs {
  const inputs = new PlanInputs();
  inputs.tourId = tour.id;
  inputs.legs = pack.routes.legs;
  const poiById = new Map<string, Poi>();
  for (const p of pack.pois) {
    poiById.set(p.id, p);
  }
  const wanted = new Set<string>(remaining);
  const points: LatLng[] = [];
  for (const stop of tour.stops) {
    const poi = poiById.get(stop.poiId);
    if (!wanted.has(stop.poiId) || inputs.stopIds.indexOf(stop.poiId) >= 0) {
      continue;
    }
    if (poi === undefined) {
      inputs.droppedIds.push(stop.poiId);
      continue;
    }
    inputs.stopIds.push(stop.poiId);
    inputs.dwellS.push(nonNegative(stop.dwellS));
    inputs.prize.push(nonNegative(stop.prize));
    const pt: LatLng = { lat: poi.lat, lng: poi.lng };
    points.push(pt);
  }
  for (const id of remaining) {
    if (inputs.stopIds.indexOf(id) < 0 && inputs.droppedIds.indexOf(id) < 0) {
      inputs.droppedIds.push(id);
    }
  }

  const detour = Number.isFinite(pack.routes.detourFactor) && pack.routes.detourFactor > 0 ?
    pack.routes.detourFactor : DEFAULT_DETOUR_FACTOR;
  const n = inputs.stopIds.length;
  const nodeIndex = new Map<string, number>();
  for (let k = 0; k < pack.routes.nodeIds.length; k++) {
    nodeIndex.set(pack.routes.nodeIds[k], k);
  }

  // Stop <-> stop matrix: the pack's OSRM values, else a haversine estimate (reported).
  for (let i = 0; i < n; i++) {
    const dRow: number[] = [];
    const tRow: number[] = [];
    const a = nodeIndex.get(inputs.stopIds[i]);
    for (let j = 0; j < n; j++) {
      if (i === j) {
        dRow.push(0);
        tRow.push(0);
        continue;
      }
      const b = nodeIndex.get(inputs.stopIds[j]);
      let dist = a !== undefined && b !== undefined ? matrixValue(pack.routes.distancesM, a, b) : Number.NaN;
      let dur = a !== undefined && b !== undefined ? matrixValue(pack.routes.durationsS, a, b) : Number.NaN;
      if (Number.isNaN(dist) || Number.isNaN(dur)) {
        const est = haversineM(points[i], points[j]) * detour;
        if (Number.isNaN(dist)) {
          dist = est;
        }
        if (Number.isNaN(dur)) {
          dur = est / WALK_SPEED_MPS;
        }
        inputs.estimatedPairs.push(`${inputs.stopIds[i]}>${inputs.stopIds[j]}`);
      }
      dRow.push(dist);
      tRow.push(dur);
    }
    inputs.distM.push(dRow);
    inputs.durS.push(tRow);
  }

  // Origin -> stop, and snapping.
  inputs.originKnown = isValidLatLng(origin);
  let snapDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const straight = inputs.originKnown ? haversineM(origin, points[i]) : 0;
    if (inputs.originKnown && straight <= SNAP_RADIUS_M && straight < snapDist) {
      snapDist = straight;
      inputs.snappedIdx = i;
    }
    inputs.originM.push(straight * detour);
    inputs.originS.push(straight * detour / WALK_SPEED_MPS);
  }
  if (inputs.snappedIdx >= 0) {
    inputs.originM[inputs.snappedIdx] = 0;
    inputs.originS[inputs.snappedIdx] = 0;
  }

  const startIdx = tour.fixedStartPoiId !== undefined ? inputs.stopIds.indexOf(tour.fixedStartPoiId) : -1;
  inputs.headIdx = startIdx >= 0 ? startIdx : inputs.snappedIdx;
  const endIdx = tour.fixedEndPoiId !== undefined ? inputs.stopIds.indexOf(tour.fixedEndPoiId) : -1;
  inputs.endIdx = endIdx !== inputs.headIdx ? endIdx : -1;
  return inputs;
}

/**
 * Solves the walking order. budgetS <= 0 (or NaN): visit every remaining stop (Held-Karp, or NN + 2-opt
 * above 16 stops / on unusable input). budgetS > 0: orienteering, the most prize within budgetS.
 * The forced first stop (headIdx) is always kept and its cost is charged to the budget first; if the budget
 * cannot even cover it, the plan is empty.
 */
export function plan(inputs: PlanInputs, budgetS: number): TourPlan {
  const t0 = Date.now();
  const n = inputs.stopIds.length;
  const useBudget = budgetS > 0;
  const head = inputs.headIdx >= 0 && inputs.headIdx < n ? inputs.headIdx : -1;

  // DP nodes = every remaining stop except the forced first one.
  const nodes: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i !== head) {
      nodes.push(i);
    }
  }
  const m = nodes.length;
  const startCost: number[] = [];
  const cost: number[][] = [];
  const prize: number[] = [];
  for (let a = 0; a < m; a++) {
    const ia = nodes[a];
    startCost.push((head >= 0 ? inputs.durS[head][ia] : inputs.originS[ia]) + inputs.dwellS[ia]);
    prize.push(inputs.prize[ia]);
    const row: number[] = [];
    for (let b = 0; b < m; b++) {
      row.push(a === b ? 0 : inputs.durS[ia][nodes[b]] + inputs.dwellS[nodes[b]]);
    }
    cost.push(row);
  }
  const fe = !useBudget && inputs.endIdx >= 0 ? nodes.indexOf(inputs.endIdx) : -1;   // budget: free end (X1)
  const headCost = head >= 0 ? inputs.originS[head] + inputs.dwellS[head] : 0;

  let path: PathPlan;
  let headKept = head >= 0;
  if (useBudget) {
    if (headCost > budgetS) {
      path = new PathPlan();
      path.algo = 'orienteering';
      headKept = false;
    } else {
      path = solveOrienteering(startCost, cost, prize, budgetS - headCost, fe);
    }
  } else {
    path = solveOpenPath(startCost, cost, fe);
  }

  const orderIdx: number[] = headKept ? [head] : [];
  for (const k of path.order) {
    orderIdx.push(nodes[k]);
  }
  const listedIdx = orderIdx.slice().sort((x: number, y: number) => x - y);
  const walkM = walkMetres(inputs, orderIdx);
  const order: string[] = orderIdx.map((i: number) => inputs.stopIds[i]);

  const result: TourPlan = {
    tourId: inputs.tourId,
    order: order,
    costS: (headKept ? headCost : 0) + path.costS,
    walkM: walkM,
    savedM: walkMetres(inputs, listedIdx) - walkM,
    exact: path.exact,
    algo: path.algo,
    ms: 0,
    budgetS: useBudget ? budgetS : 0,
    legs: attachLegs(inputs.legs, order)
  };
  result.ms = Date.now() - t0;
  return result;
}

/** Great-circle distance in metres (WGS-84 mean radius). */
export function haversineM(a: LatLng, b: LatLng): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Walking metres from the origin through `orderIdx` (indices into inputs.stopIds). */
function walkMetres(inputs: PlanInputs, orderIdx: number[]): number {
  if (orderIdx.length === 0) {
    return 0;
  }
  let total = inputs.originM[orderIdx[0]];
  for (let k = 1; k < orderIdx.length; k++) {
    total += inputs.distM[orderIdx[k - 1]][orderIdx[k]];
  }
  return total;
}

/** The pack's leg for every consecutive pair of `order`, or [] if any of them is missing. */
function attachLegs(legs: RouteLeg[], order: string[]): RouteLeg[] {
  const out: RouteLeg[] = [];
  for (let k = 1; k < order.length; k++) {
    let found: RouteLeg | undefined = undefined;
    for (const leg of legs) {
      if (leg.fromPoiId === order[k - 1] && leg.toPoiId === order[k]) {
        found = leg;
        break;
      }
    }
    if (found === undefined) {
      return [];
    }
    out.push(found);
  }
  return out;
}

/** matrix[a][b] if it is a finite number >= 0, else NaN. */
function matrixValue(matrix: number[][], a: number, b: number): number {
  const row: number[] | undefined = a < matrix.length ? matrix[a] : undefined;
  const v: number | undefined = row !== undefined && b < row.length ? row[b] : undefined;
  return v !== undefined && Number.isFinite(v) && v >= 0 ? v : Number.NaN;
}

function nonNegative(v: number): number {
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function isValidLatLng(p: LatLng): boolean {
  return Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
}
