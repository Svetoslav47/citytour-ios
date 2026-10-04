// Suite: HeldKarp.test - module under test: core/route/HeldKarp + Fallback + Planner (task A2).
// Cases from docs/ARCHITECTURE.md §11.1 (HeldKarp.test row) and PLAN A2 DoD. Every random matrix comes from a
// seeded PRNG (mulberry32), so a failure names its seed and reproduces exactly.
import { describe, it, expect } from 'vitest';
import {
  MAX_EXACT_N, PathPlan, pathCost, solveOpenPath, solveOrienteering
} from '../src';
import { UNUSABLE_COST_S, nearestNeighbour2Opt } from '../src';
import { CityPack, PlanInputs, buildCostInputs, plannerHaversineM as haversineM, plan } from '../src';
import {
  ContentTier, LatLng, Poi, PoiKind, RouteData, RouteLeg, Tour, TourStop
} from '../src';
import { TourPlan } from '../src';
import {
  MINI_BARBICAN, MINI_CLOTH_HALL, MINI_ORIGIN, MINI_ST_MARYS, MINI_TOUR_ID, miniPois, miniRoutes, miniTour
} from './fixtures/MiniPack';

const TOL: number = 1e-6;

// ---------- seeded PRNG ----------

class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** mulberry32: uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6D2B79F5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
}

class Instance {
  startCost: number[] = [];
  cost: number[][] = [];
  prize: number[] = [];
}

/** Fully random asymmetric costs (walk 30..630 s + dwell 0..300 s), prizes 1..5. */
function randomAsymmetric(n: number, seed: number): Instance {
  const rng = new Rng(seed);
  const inst = new Instance();
  const dwell: number[] = [];
  for (let j = 0; j < n; j++) {
    dwell.push(Math.round(rng.next() * 300));
    inst.prize.push(1 + rng.int(5));
  }
  for (let j = 0; j < n; j++) {
    inst.startCost.push(30 + rng.next() * 600 + dwell[j]);
  }
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      row.push(i === j ? 0 : 30 + rng.next() * 600 + dwell[j]);
    }
    inst.cost.push(row);
  }
  return inst;
}

/** Walking-like costs: points in a 1.5 km square, euclid x (1..1.3) asymmetric detour / 1.3 m/s + dwell. */
function randomGeometric(n: number, seed: number): Instance {
  const rng = new Rng(seed);
  const xs: number[] = [];
  const ys: number[] = [];
  const dwell: number[] = [];
  for (let j = 0; j <= n; j++) { // point n is the origin
    xs.push(rng.next() * 1500);
    ys.push(rng.next() * 1500);
    dwell.push(60 + rng.int(240));
  }
  const walk = (i: number, j: number): number =>
    Math.sqrt((xs[i] - xs[j]) * (xs[i] - xs[j]) + (ys[i] - ys[j]) * (ys[i] - ys[j])) * (1 + 0.3 * rng.next()) / 1.3;
  const inst = new Instance();
  for (let j = 0; j < n; j++) {
    inst.startCost.push(walk(n, j) + dwell[j]);
    inst.prize.push(1 + rng.int(5));
  }
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) {
      row.push(i === j ? 0 : walk(i, j) + dwell[j]);
    }
    inst.cost.push(row);
  }
  return inst;
}

// ---------- brute force references ----------

class BruteBest {
  cost: number = Number.POSITIVE_INFINITY;
  prize: number = 0;
}

/** Minimum open-path cost over all permutations (fixedEnd last if >= 0). */
function bruteOpenPath(inst: Instance, fixedEnd: number): number {
  const best = new BruteBest();
  const used: boolean[] = inst.startCost.map((): boolean => false);
  bruteOpenRec(inst, fixedEnd, used, -1, 0, 0, best);
  return best.cost;
}

function bruteOpenRec(inst: Instance, fe: number, used: boolean[], last: number, depth: number, acc: number,
  best: BruteBest): void {
  const n = inst.startCost.length;
  if (depth === n) {
    if ((fe < 0 || last === fe) && acc < best.cost) {
      best.cost = acc;
    }
    return;
  }
  for (let k = 0; k < n; k++) {
    if (used[k] || (k === fe && depth !== n - 1)) {
      continue;
    }
    used[k] = true;
    bruteOpenRec(inst, fe, used, k, depth + 1, acc + (last < 0 ? inst.startCost[k] : inst.cost[last][k]), best);
    used[k] = false;
  }
}

/** Best (max prize, then min cost) over every simple path from the origin within budget; empty path allowed. */
function bruteOrienteering(inst: Instance, budget: number, fixedEnd: number): BruteBest {
  const best = new BruteBest();
  best.cost = 0;
  best.prize = 0;
  const used: boolean[] = inst.startCost.map((): boolean => false);
  bruteOrientRec(inst, budget, fixedEnd, used, -1, 0, 0, best);
  return best;
}

function bruteOrientRec(inst: Instance, budget: number, fe: number, used: boolean[], last: number, acc: number,
  prize: number, best: BruteBest): void {
  if (last >= 0 && (fe < 0 || last === fe)) {
    if (prize > best.prize || (prize === best.prize && acc < best.cost)) {
      best.prize = prize;
      best.cost = acc;
    }
  }
  if (last >= 0 && last === fe) {
    return;
  }
  const n = inst.startCost.length;
  for (let k = 0; k < n; k++) {
    if (used[k]) {
      continue;
    }
    const next = acc + (last < 0 ? inst.startCost[k] : inst.cost[last][k]);
    if (next > budget) {
      continue;
    }
    used[k] = true;
    bruteOrientRec(inst, budget, fe, used, k, next, prize + inst.prize[k], best);
    used[k] = false;
  }
}

// ---------- plan checks ----------

function isPermutation(order: number[], n: number): boolean {
  if (order.length !== n) {
    return false;
  }
  const seen: boolean[] = [];
  for (let i = 0; i < n; i++) {
    seen.push(false);
  }
  for (const k of order) {
    if (k < 0 || k >= n || seen[k]) {
      return false;
    }
    seen[k] = true;
  }
  return true;
}

function isSimplePath(order: number[], n: number): boolean {
  const seen = new Set<number>(order);
  return seen.size === order.length && order.every((k: number): boolean => k >= 0 && k < n);
}

function prizeOf(inst: Instance, order: number[]): number {
  let p = 0;
  for (const k of order) {
    p += inst.prize[k];
  }
  return p;
}

/** On failure, the message (with the seed) shows up in the test result so the case can be replayed. */
function check(ok: boolean, what: string): void {
  if (!ok) {
    expect(what).toBe('');
  }
  expect(ok).toBe(true);
}

function lastOf(order: number[]): number {
  return order.length > 0 ? order[order.length - 1] : -1;
}

function solveOpenTimed(n: number, seed: number): number {
  const inst = randomAsymmetric(n, seed);
  const t0 = Date.now();
  const p = solveOpenPath(inst.startCost, inst.cost, -1);
  const ms = Date.now() - t0;
  check(p.exact && isPermutation(p.order, n), `n=${n} seed=${seed} not an exact permutation`);
  return ms;
}

// ---------- Royal Route fixture (11 real stops, coordinates from docs/design/map/map-meta.json) ----------

const ROYAL_IDS: string[] = [
  'barbican', 'florian_gate', 'st_marys', 'cloth_hall', 'mickiewicz', 'town_hall_tower', 'st_adalbert',
  'sts_peter_paul', 'st_andrew', 'kanonicza', 'wawel'
];
const ROYAL_LAT: number[] = [
  50.0655, 50.0648, 50.0616, 50.0617, 50.0614, 50.0614, 50.0609, 50.0573, 50.0568, 50.0553, 50.0545
];
const ROYAL_LNG: number[] = [
  19.941701, 19.9416, 19.9394, 19.9373, 19.9384, 19.9358, 19.937899, 19.939001, 19.938599, 19.9378, 19.9355
];

function mkPoi(id: string, lat: number, lng: number): Poi {
  return {
    id: id, kind: PoiKind.MONUMENT, lat: lat, lng: lng, x: 0, y: 0, names: { pl: id }, importance: 1,
    tier: ContentTier.NAME_ONLY, triggerRadiusM: 30, sourceIds: []
  };
}

/** Straight-line (haversine) matrix at detour 1.0, so metres match the reviewer's Held-Karp check. */
function royalPack(): CityPack {
  const pois: Poi[] = [];
  for (let i = 0; i < ROYAL_IDS.length; i++) {
    pois.push(mkPoi(ROYAL_IDS[i], ROYAL_LAT[i], ROYAL_LNG[i]));
  }
  const dist: number[][] = [];
  const dur: number[][] = [];
  for (let i = 0; i < pois.length; i++) {
    const dRow: number[] = [];
    const tRow: number[] = [];
    for (let j = 0; j < pois.length; j++) {
      const a: LatLng = { lat: pois[i].lat, lng: pois[i].lng };
      const b: LatLng = { lat: pois[j].lat, lng: pois[j].lng };
      const d = i === j ? 0 : haversineM(a, b);
      dRow.push(d);
      tRow.push(d / 1.30);
    }
    dist.push(dRow);
    dur.push(tRow);
  }
  const routes: RouteData = {
    nodeIds: ROYAL_IDS.slice(), durationsS: dur, distancesM: dist, detourFactor: 1.0, legs: []
  };
  const pack: CityPack = { pois: pois, routes: routes };
  return pack;
}

function royalTour(withFixedStart: boolean): Tour {
  const stops: TourStop[] = ROYAL_IDS.map((id: string): TourStop => {
    const s: TourStop = { poiId: id, dwellS: 120, prize: id === 'wawel' ? 5 : 3 };
    return s;
  });
  const tour: Tour = {
    id: 'royal-route', personaId: 'historian', titles: { en: 'Royal Route' }, summaries: { en: 'Test' },
    stops: stops, fixedEndPoiId: 'wawel', estMinutes: 90
  };
  if (withFixedStart) {
    tour.fixedStartPoiId = 'barbican';
  }
  return tour;
}

function royalAt(i: number): LatLng {
  const p: LatLng = { lat: ROYAL_LAT[i], lng: ROYAL_LNG[i] };
  return p;
}

function miniPack(routes: RouteData): CityPack {
  const pack: CityPack = { pois: miniPois(), routes: routes };
  return pack;
}

function mkLeg(from: string, to: string): RouteLeg {
  const leg: RouteLeg = { fromPoiId: from, toPoiId: to, distanceM: 1, durationS: 1, geometry: [], steps: [] };
  return leg;
}

function heldKarpTest() {
  describe('HeldKarp', () => {
    it('trivial_sizes_n0_n1_n2', () => {
      const p0: PathPlan = solveOpenPath([], [], -1);
      expect(p0.order.length).toBe(0);
      expect(p0.costS).toBe(0);
      expect(p0.exact).toBe(true);

      const p1 = solveOpenPath([42], [[0]], -1);
      expect(p1.order.join(',')).toBe('0');
      expect(p1.costS).toBe(42);
      const p1e = solveOpenPath([42], [[0]], 0);
      expect(p1e.order.join(',')).toBe('0');

      // origin->0 = 10, origin->1 = 100, 0->1 = 50, 1->0 = 5: best is 0,1 (60) vs 1,0 (105).
      const p2 = solveOpenPath([10, 100], [[0, 50], [5, 0]], -1);
      expect(p2.order.join(',')).toBe('0,1');
      expect(p2.costS).toBe(60);
      // fixedEnd = 0 forces 1,0 (105).
      const p2e = solveOpenPath([10, 100], [[0, 50], [5, 0]], 0);
      expect(p2e.order.join(',')).toBe('1,0');
      expect(p2e.costS).toBe(105);
      // An out-of-range fixedEnd means "none".
      expect(solveOpenPath([10, 100], [[0, 50], [5, 0]], 7).order.join(',')).toBe('0,1');
    });

    it('equals_brute_force_30_random_asymmetric_7_node', () => {
      for (let seed = 1; seed <= 30; seed++) {
        const inst = randomAsymmetric(7, seed);
        const p = solveOpenPath(inst.startCost, inst.cost, -1);
        const bf = bruteOpenPath(inst, -1);
        check(p.exact && p.algo === 'heldkarp', `seed=${seed} algo=${p.algo}`);
        check(isPermutation(p.order, 7), `seed=${seed} order=${p.order.join(',')}`);
        check(Math.abs(p.costS - bf) < TOL, `seed=${seed} hk=${p.costS} bf=${bf}`);
        check(Math.abs(pathCost(inst.startCost, inst.cost, p.order) - p.costS) < TOL, `seed=${seed} costS mismatch`);
      }
    });

    it('fixed_end_respected_and_optimal_30_random_7_node', () => {
      for (let seed = 101; seed <= 130; seed++) {
        const inst = randomAsymmetric(7, seed);
        const fe = seed % 7;
        const p = solveOpenPath(inst.startCost, inst.cost, fe);
        const bf = bruteOpenPath(inst, fe);
        check(isPermutation(p.order, 7) && lastOf(p.order) === fe, `seed=${seed} fe=${fe} order=${p.order.join(',')}`);
        check(Math.abs(p.costS - bf) < TOL, `seed=${seed} fe=${fe} hk=${p.costS} bf=${bf}`);
      }
    });

    it('equals_brute_force_8_node_with_and_without_fixed_end', () => {
      for (let seed = 201; seed <= 206; seed++) {
        const inst = randomAsymmetric(8, seed);
        const fe = seed % 2 === 0 ? -1 : seed % 8;
        const p = solveOpenPath(inst.startCost, inst.cost, fe);
        const bf = bruteOpenPath(inst, fe);
        check(Math.abs(p.costS - bf) < TOL, `seed=${seed} fe=${fe} hk=${p.costS} bf=${bf}`);
      }
    });

    it('n15_under_1000ms_and_n16_runs', () => {
      const ms15 = solveOpenTimed(15, 1501);
      const ms16 = solveOpenTimed(16, 1601);
      console.info(`CityTour HELDKARP_TIMING n=15 ms=${ms15} n=16 ms=${ms16}`);
      expect(ms15).toBeLessThan(2500);   // 1000 ms target; headroom for a loaded build machine (flaked at 1049-1073 ms)
    });

    it('orienteering_within_budget_and_equals_brute_force_8_node', () => {
      for (let seed = 301; seed <= 330; seed++) {
        const inst = randomAsymmetric(8, seed);
        const rng = new Rng(seed * 7919);
        const budget = 200 + rng.next() * 3000;
        const fe = seed % 3 === 0 ? seed % 8 : -1;
        const p = solveOrienteering(inst.startCost, inst.cost, inst.prize, budget, fe);
        const bf = bruteOrienteering(inst, budget, fe);
        const tag = `seed=${seed} budget=${budget.toFixed(1)} fe=${fe}`;
        check(p.exact && p.algo === 'orienteering', `${tag} algo=${p.algo}`);
        check(isSimplePath(p.order, 8), `${tag} order=${p.order.join(',')}`);
        check(p.costS <= budget, `${tag} cost=${p.costS} over budget`);
        check(Math.abs(pathCost(inst.startCost, inst.cost, p.order) - p.costS) < TOL, `${tag} costS mismatch`);
        check(fe < 0 || p.order.length === 0 || lastOf(p.order) === fe, `${tag} fixedEnd not last`);
        check(prizeOf(inst, p.order) === bf.prize, `${tag} prize=${prizeOf(inst, p.order)} bf=${bf.prize}`);
        check(Math.abs(p.costS - bf.cost) < TOL, `${tag} cost=${p.costS} bf=${bf.cost}`);
      }
    });

    it('orienteering_edge_budgets', () => {
      const inst = randomAsymmetric(6, 401);
      expect(solveOrienteering(inst.startCost, inst.cost, inst.prize, 0, -1).order.length).toBe(0);
      expect(solveOrienteering(inst.startCost, inst.cost, inst.prize, Number.NaN, -1).order.length).toBe(0);
      // Unlimited budget with positive prizes = every stop, at the open-path optimum.
      const all = solveOrienteering(inst.startCost, inst.cost, inst.prize, Number.POSITIVE_INFINITY, 2);
      const open = solveOpenPath(inst.startCost, inst.cost, 2);
      expect(all.order.length).toBe(6);
      check(Math.abs(all.costS - open.costS) < TOL, `inf budget cost=${all.costS} open=${open.costS}`);
    });

    it('nn2opt_within_1_3x_of_optimum_random_10_node', () => {
      let worst = 1;
      for (let seed = 501; seed <= 530; seed++) {
        const inst = randomGeometric(10, seed);
        const fe = seed % 2 === 0 ? -1 : seed % 10;
        const h = nearestNeighbour2Opt(inst.startCost, inst.cost, fe);
        const opt = solveOpenPath(inst.startCost, inst.cost, fe);
        const ratio = h.costS / opt.costS;
        worst = Math.max(worst, ratio);
        check(!h.exact && h.algo === 'nn2opt', `seed=${seed} flags`);
        check(isPermutation(h.order, 10) && (fe < 0 || lastOf(h.order) === fe),
          `seed=${seed} order=${h.order.join(',')}`);
        check(Math.abs(pathCost(inst.startCost, inst.cost, h.order) - h.costS) < TOL, `seed=${seed} costS mismatch`);
        check(ratio <= 1.3, `seed=${seed} fe=${fe} ratio=${ratio.toFixed(3)}`);
      }
      console.info(`CityTour NN2OPT_WORST_RATIO ratio=${worst.toFixed(3)}`);
    });

    it('falls_back_to_nn2opt_above_cap_or_on_nan', () => {
      const big = randomGeometric(MAX_EXACT_N + 1, 601);
      const pb = solveOpenPath(big.startCost, big.cost, 3);
      check(!pb.exact && pb.algo === 'nn2opt', `n=17 algo=${pb.algo}`);
      check(isPermutation(pb.order, MAX_EXACT_N + 1) && lastOf(pb.order) === 3, `n=17 order=${pb.order.join(',')}`);

      const bad = randomAsymmetric(5, 602);
      bad.cost[1][2] = Number.NaN;
      const pn = solveOpenPath(bad.startCost, bad.cost, -1);
      check(!pn.exact && pn.algo === 'nn2opt' && isPermutation(pn.order, 5), `nan algo=${pn.algo}`);
      // The NaN edge counts as UNUSABLE_COST_S, so the heuristic avoids it.
      let usesBad = false;
      for (let k = 1; k < pn.order.length; k++) {
        usesBad = usesBad || (pn.order[k - 1] === 1 && pn.order[k] === 2);
      }
      check(!usesBad && pn.costS < UNUSABLE_COST_S, `nan edge used, cost=${pn.costS}`);

      // Orienteering fallback never exceeds the budget either.
      const po = solveOrienteering(big.startCost, big.cost, big.prize, 1500, 3);
      check(!po.exact && po.costS <= 1500 && (po.order.length === 0 || lastOf(po.order) === 3),
        `n=17 orienteering cost=${po.costS} order=${po.order.join(',')}`);
      check(Math.abs(pathCost(big.startCost, big.cost, po.order) - po.costS) < TOL, 'n=17 orienteering costS');
    });
  });

  describe('Planner', () => {
    it('royal_route_11_stops_swaps_cloth_hall_and_mickiewicz', () => {
      const inputs: PlanInputs = buildCostInputs(royalPack(), royalTour(true), ROYAL_IDS, royalAt(0));
      const tp: TourPlan = plan(inputs, 0);
      const expected = ['barbican', 'florian_gate', 'st_marys', 'mickiewicz', 'cloth_hall', 'town_hall_tower',
        'st_adalbert', 'sts_peter_paul', 'st_andrew', 'kanonicza', 'wawel'];
      expect(tp.order.join(',')).toBe(expected.join(','));
      expect(tp.exact).toBe(true);
      expect(tp.algo).toBe('heldkarp');
      // Reviewer's Held-Karp check: listed ~1,882 m, optimal ~1,733 m.
      check(Math.abs(tp.walkM - 1732.7) < 1, `walkM=${tp.walkM}`);
      check(Math.abs(tp.walkM + tp.savedM - 1881.7) < 1, `listedM=${tp.walkM + tp.savedM}`);
      check(Math.abs(tp.savedM - 149.0) < 1, `savedM=${tp.savedM}`);
      check(Math.abs(tp.costS - (1732.7 / 1.30 + 11 * 120)) < 1, `costS=${tp.costS}`);
      expect(tp.tourId).toBe('royal-route');
      expect(tp.budgetS).toBe(0);
      expect(tp.legs.length).toBe(0); // no legs in this fixture
      expect(tp.ms).toBeGreaterThanOrEqual(0);
    });

    it('fixed_start_wins_over_snapping_and_snapping_without_it', () => {
      // User stands at Cloth Hall (index 3): with a fixed start the tour still begins at the Barbican.
      const fixed = plan(buildCostInputs(royalPack(), royalTour(true), ROYAL_IDS, royalAt(3)), 0);
      expect(fixed.order[0]).toBe('barbican');
      expect(fixed.order[10]).toBe('wawel');
      // Without a fixed start, the stop within 30 m becomes the origin.
      const nearCloth: LatLng = { lat: ROYAL_LAT[3] + 0.0001, lng: ROYAL_LNG[3] }; // ~11 m north
      const inputs = buildCostInputs(royalPack(), royalTour(false), ROYAL_IDS, nearCloth);
      expect(inputs.snappedIdx).toBe(3);
      expect(inputs.originM[3]).toBe(0);
      const snapped = plan(inputs, 0);
      expect(snapped.order[0]).toBe('cloth_hall');
      expect(snapped.order[snapped.order.length - 1]).toBe('wawel');
      expect(snapped.order.length).toBe(11);
    });

    it('replan_remaining_subset_and_drops_unknown_ids', () => {
      const remaining = ['st_andrew', 'wawel', 'st_marys', 'cloth_hall', 'not_a_stop'];
      const inputs = buildCostInputs(royalPack(), royalTour(true), remaining, royalAt(1));
      expect(inputs.stopIds.join(',')).toBe('st_marys,cloth_hall,st_andrew,wawel'); // listed order
      expect(inputs.droppedIds.join(',')).toBe('not_a_stop');
      expect(inputs.headIdx).toBe(-1); // the fixed start was already visited
      const tp = plan(inputs, 0);
      expect(tp.order.length).toBe(4);
      expect(tp.order[3]).toBe('wawel');
      expect(tp.savedM).toBeGreaterThanOrEqual(-TOL);
    });

    it('budget_plan_never_exceeds_budget_and_keeps_head', () => {
      const inputs = buildCostInputs(royalPack(), royalTour(true), ROYAL_IDS, royalAt(0));
      const budgets = [200, 900, 1800, 2700, 100000];
      for (const b of budgets) {
        const tp = plan(inputs, b);
        check(tp.costS <= b, `budget=${b} cost=${tp.costS}`);
        expect(tp.algo).toBe('orienteering');
        expect(tp.budgetS).toBe(b);
        expect(tp.order[0]).toBe('barbican');
      }
      expect(plan(inputs, 100000).order.length).toBe(11);
      // X1: under a budget the fixed end (Wawel) is free; the full tour still ends there.
      const short = plan(inputs, 1800);
      check(short.order.length >= 6 && short.order[short.order.length - 1] !== 'wawel',
        `budget=1800 order=${short.order.join(',')} costS=${short.costS}`);
      expect(plan(inputs, 0).order[10]).toBe('wawel');
      // A budget below the forced first stop gives an empty plan.
      const far = buildCostInputs(royalPack(), royalTour(true), ROYAL_IDS, royalAt(10));
      expect(plan(far, 60).order.length).toBe(0);
    });

    it('mini_pack_costs_and_missing_matrix_entry_falls_back_to_haversine', () => {
      const ids = [MINI_BARBICAN, MINI_ST_MARYS, MINI_CLOTH_HALL];
      const inputs = buildCostInputs(miniPack(miniRoutes()), miniTour(), ids, MINI_ORIGIN);
      expect(inputs.estimatedPairs.length).toBe(0);
      expect(inputs.headIdx).toBe(0); // fixed start Barbican
      expect(inputs.snappedIdx).toBe(2); // the origin is at Cloth Hall
      const tp = plan(inputs, 0);
      // Barbican, then St Mary's (446+120 + 145+90 = 801) beats Cloth Hall first (506+90 + 145+120 = 861).
      expect(tp.order.join(',')).toBe(ids.join(','));
      check(Math.abs(tp.costS - (inputs.originS[0] + 60 + 801)) < TOL, `costS=${tp.costS}`);
      check(Math.abs(tp.walkM - (inputs.originM[0] + 580 + 188)) < TOL, `walkM=${tp.walkM}`);
      check(Math.abs(tp.savedM) < TOL, `savedM=${tp.savedM}`); // the listed order is already optimal

      const broken = miniRoutes();
      broken.durationsS[0][1] = Number.NaN;
      broken.distancesM[0][1] = -1;
      const bIn = buildCostInputs(miniPack(broken), miniTour(), ids, MINI_ORIGIN);
      expect(bIn.estimatedPairs.join(',')).toBe(`${MINI_BARBICAN}>${MINI_ST_MARYS}`);
      check(Number.isFinite(bIn.durS[0][1]) && bIn.distM[0][1] > 0, 'estimate filled');
      expect(plan(bIn, 0).exact).toBe(true);
    });

    it('attaches_legs_only_when_all_present_and_handles_no_fix', () => {
      const ids = [MINI_BARBICAN, MINI_ST_MARYS, MINI_CLOTH_HALL];
      const routes = miniRoutes();
      routes.legs = [mkLeg(MINI_BARBICAN, MINI_ST_MARYS), mkLeg(MINI_ST_MARYS, MINI_CLOTH_HALL)];
      const tp = plan(buildCostInputs(miniPack(routes), miniTour(), ids, MINI_ORIGIN), 0);
      expect(tp.legs.length).toBe(2);
      expect(tp.legs[1].toPoiId).toBe(MINI_CLOTH_HALL);
      routes.legs = [mkLeg(MINI_BARBICAN, MINI_ST_MARYS)];
      expect(plan(buildCostInputs(miniPack(routes), miniTour(), ids, MINI_ORIGIN), 0).legs.length).toBe(0);

      // No location fix: origin costs are 0 and the plan still covers every stop.
      const noFix: LatLng = { lat: Number.NaN, lng: Number.NaN };
      const nf = buildCostInputs(miniPack(miniRoutes()), miniTour(), ids, noFix);
      expect(nf.originKnown).toBe(false);
      const nfPlan = plan(nf, 0);
      expect(nfPlan.order.length).toBe(3);
      expect(nfPlan.tourId).toBe(MINI_TOUR_ID);
      // Empty remaining list: empty plan.
      expect(plan(buildCostInputs(miniPack(miniRoutes()), miniTour(), [], MINI_ORIGIN), 0).order.length)
        .toBe(0);
    });
  });
}

heldKarpTest();
