/*
 * Heuristic walking order: nearest neighbour + 2-opt (docs/ARCHITECTURE.md §6.2 fallback, PLAN task A2).
 * Used when n > MAX_EXACT_N (free roam later) or when the cost inputs are not usable by Held-Karp
 * (NaN, negative, missing rows). Always returns exact = false, algo = 'nn2opt'. Pure: no @kit imports.
 *
 * Same cost model as HeldKarp.ets (implicit origin, open path, optional fixedEnd). A non-finite or negative
 * cost is replaced by UNUSABLE_COST_S so the comparisons stay well defined; such a plan's costS is then huge,
 * which is the honest signal that an input was broken. The Planner fills missing pairs from haversine first,
 * so this only happens on really bad input.
 */
import { PathPlan, normaliseFixedEnd } from './HeldKarp';

/** Stand-in for an unusable (NaN, negative, missing) cost: larger than any real walk. */
export const UNUSABLE_COST_S: number = 1e9;
const MAX_2OPT_PASSES: number = 200;
const EPS: number = 1e-9;

/** Nearest neighbour from the origin, then 2-opt segment reversals until no reversal helps. */
export function nearestNeighbour2Opt(startCost: number[], cost: number[][], fixedEnd: number): PathPlan {
  const n = startCost.length;
  const plan = new PathPlan();
  plan.exact = false;
  plan.algo = 'nn2opt';
  if (n === 0) {
    return plan;
  }
  const fe = normaliseFixedEnd(fixedEnd, n);
  const s = new Float64Array(n);
  const c = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    s[i] = safeCost(startCost[i]);
    const row: number[] | undefined = i < cost.length ? cost[i] : undefined;
    for (let j = 0; j < n; j++) {
      c[i * n + j] = i === j ? 0 : safeCost(row === undefined ? undefined : row[j]);
    }
  }

  // 1. Nearest neighbour (fixedEnd is held back and appended last).
  const order: number[] = [];
  const used: boolean[] = [];
  for (let i = 0; i < n; i++) {
    used.push(false);
  }
  let cur = -1;
  const free = fe >= 0 ? n - 1 : n;
  for (let step = 0; step < free; step++) {
    let next = -1;
    let best = Number.POSITIVE_INFINITY;
    for (let k = 0; k < n; k++) {
      if (used[k] || k === fe) {
        continue;
      }
      const v = cur < 0 ? s[k] : c[cur * n + k];
      if (v < best) {
        best = v;
        next = k;
      }
    }
    used[next] = true;
    order.push(next);
    cur = next;
  }
  if (fe >= 0) {
    order.push(fe);
  }

  // 2. 2-opt: reverse order[i..j] (the costs are asymmetric, so the whole path is re-costed).
  //    With a fixed end the last position never moves.
  const movable = fe >= 0 ? n - 1 : n;
  let bestCost = flatCost(s, c, n, order);
  let improved = true;
  for (let pass = 0; improved && pass < MAX_2OPT_PASSES; pass++) {
    improved = false;
    for (let i = 0; i < movable - 1; i++) {
      for (let j = i + 1; j < movable; j++) {
        reverseRange(order, i, j);
        const v = flatCost(s, c, n, order);
        if (v < bestCost - EPS) {
          bestCost = v;
          improved = true;
        } else {
          reverseRange(order, i, j);
        }
      }
    }
  }
  plan.order = order;
  plan.costS = bestCost;
  return plan;
}

/**
 * Cuts a heuristic plan down to a time budget (the orienteering fallback when n > MAX_EXACT_N or the
 * inputs are unusable). Greedy: walk the plan's order and keep a stop only if, after it, the fixed end
 * (if any) is still reachable within budget. Never exceeds budgetS. Returns exact = false, algo = 'nn2opt'.
 */
export function truncateToBudget(plan: PathPlan, startCost: number[], cost: number[][], budgetS: number,
  fixedEnd: number): PathPlan {
  const n = startCost.length;
  const fe = normaliseFixedEnd(fixedEnd, n);
  const out = new PathPlan();
  out.exact = false;
  out.algo = 'nn2opt';
  if (!(budgetS >= 0)) {
    return out;
  }
  let cur = -1;
  let total = 0;
  for (let p = 0; p < plan.order.length; p++) {
    const k = plan.order[p];
    if (k === fe) {
      continue;
    }
    const step = edge(startCost, cost, cur, k);
    const tail = fe >= 0 ? edge(startCost, cost, k, fe) : 0;
    if (total + step + tail <= budgetS) {
      out.order.push(k);
      total += step;
      cur = k;
    }
  }
  if (fe >= 0) {
    const last = edge(startCost, cost, cur, fe);
    if (total + last <= budgetS) {
      out.order.push(fe);
      total += last;
    }
  }
  out.costS = total;
  return out;
}

function safeCost(v: number | undefined): number {
  return v !== undefined && Number.isFinite(v) && v >= 0 ? v : UNUSABLE_COST_S;
}

function edge(startCost: number[], cost: number[][], from: number, to: number): number {
  if (from < 0) {
    return safeCost(startCost[to]);
  }
  const row: number[] | undefined = from < cost.length ? cost[from] : undefined;
  return safeCost(row === undefined ? undefined : row[to]);
}

function flatCost(s: Float64Array, c: Float64Array, n: number, order: number[]): number {
  let total = s[order[0]];
  for (let k = 1; k < order.length; k++) {
    total += c[order[k - 1] * n + order[k]];
  }
  return total;
}

function reverseRange(a: number[], i: number, j: number): void {
  let lo = i;
  let hi = j;
  while (lo < hi) {
    const t = a[lo];
    a[lo] = a[hi];
    a[hi] = t;
    lo++;
    hi--;
  }
}
