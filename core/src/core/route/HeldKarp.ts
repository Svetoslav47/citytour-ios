/*
 * Exact walking order for the tour stops (docs/ARCHITECTURE.md §6.1-6.4, PLAN task A2).
 * Pure: no @kit imports, no logging, no clock. The caller logs ROUTE_PLAN with the returned algo.
 *
 * Model: an implicit origin node (the user, or the stop the user stands at) plus n stops 0..n-1.
 *   startCost[j] = cost from the origin to stop j (walk seconds + dwell at j)
 *   cost[i][j]   = cost from stop i to stop j     (walk seconds + dwell at j); the diagonal is ignored
 * Open path: no return to the origin. fixedEnd = -1 for none, else the stop that must come last.
 *
 * Held-Karp: dp[mask][j] = min cost to start at the origin, visit exactly `mask`, and end at j in mask.
 * O(n^2 * 2^n) time, O(n * 2^n) memory (Float64Array dp + Int8Array parent). Hard cap n <= 16; above
 * the cap, or with a non-finite/negative cost, the solvers hand over to the NN + 2-opt fallback
 * (Fallback.ets) and return exact = false.
 */
import { nearestNeighbour2Opt, truncateToBudget } from './Fallback';

/** Hard cap for the exact solvers (ARCHITECTURE §6.2): n = 16 is 1M dp cells, ~16.7M relaxations. */
export const MAX_EXACT_N: number = 16;

export class PathPlan {
  order: number[] = [];      // stop indices in walking order (the origin is implicit)
  costS: number = 0;         // startCost[order[0]] + sum of cost[order[k-1]][order[k]]
  exact: boolean = true;     // false for the NN + 2-opt fallback
  algo: string = 'heldkarp'; // 'heldkarp' | 'orienteering' | 'nn2opt'
}

/** A DP table: dp/parent are indexed [mask * n + j]. */
class HkTable {
  n: number = 0;
  dp: Float64Array = new Float64Array(0);
  parent: Int8Array = new Int8Array(0);
}

/** True when the inputs are square, every off-diagonal cost is finite and >= 0, and n <= MAX_EXACT_N. */
export function isExactSolvable(startCost: number[], cost: number[][]): boolean {
  const n = startCost.length;
  if (n > MAX_EXACT_N || cost.length !== n) {
    return false;
  }
  for (let i = 0; i < n; i++) {
    if (!isUsableCost(startCost[i])) {
      return false;
    }
    const row: number[] | undefined = cost[i];
    if (row === undefined || row.length !== n) {
      return false;
    }
    for (let j = 0; j < n; j++) {
      if (i !== j && !isUsableCost(row[j])) {
        return false;
      }
    }
  }
  return true;
}

/** Normalises fixedEnd: anything that is not a valid stop index means "no fixed end". */
export function normaliseFixedEnd(fixedEnd: number, n: number): number {
  return Number.isInteger(fixedEnd) && fixedEnd >= 0 && fixedEnd < n ? fixedEnd : -1;
}

/** Cost of visiting `order` from the origin. Returns NaN if an index is out of range. */
export function pathCost(startCost: number[], cost: number[][], order: number[]): number {
  if (order.length === 0) {
    return 0;
  }
  let total = startCost[order[0]];
  for (let k = 1; k < order.length; k++) {
    total += cost[order[k - 1]][order[k]];
  }
  return total;
}

/** Shortest open path from the origin through every stop (ending at fixedEnd if >= 0). */
export function solveOpenPath(startCost: number[], cost: number[][], fixedEnd: number): PathPlan {
  const n = startCost.length;
  if (n === 0) {
    return new PathPlan();
  }
  if (!isExactSolvable(startCost, cost)) {
    return nearestNeighbour2Opt(startCost, cost, fixedEnd);
  }
  const fe = normaliseFixedEnd(fixedEnd, n);
  const table = fillTable(startCost, cost, fe);
  const full = (1 << n) - 1;
  let end = fe;
  if (end < 0) {
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < n; j++) {
      const v = table.dp[full * n + j];
      if (v < best) {
        best = v;
        end = j;
      }
    }
  }
  const plan = new PathPlan();
  plan.order = reconstruct(table, full, end);
  plan.costS = table.dp[full * n + end];
  return plan;
}

/**
 * Orienteering ("I have N minutes", ARCHITECTURE §6.3): the subset and order with the largest total prize
 * whose cost is <= budgetS; ties go to the lower cost. Exact, from the same DP table. With fixedEnd >= 0
 * only paths ending at fixedEnd count (the empty plan is always allowed). Non-finite prizes count as 0;
 * a NaN or negative budget gives the empty plan, +Infinity means "no limit".
 */
export function solveOrienteering(startCost: number[], cost: number[][], prize: number[], budgetS: number,
  fixedEnd: number): PathPlan {
  const n = startCost.length;
  const empty = new PathPlan();
  empty.algo = 'orienteering';
  if (n === 0 || !(budgetS >= 0)) {
    return empty;
  }
  if (!isExactSolvable(startCost, cost)) {
    return truncateToBudget(nearestNeighbour2Opt(startCost, cost, fixedEnd), startCost, cost, budgetS, fixedEnd);
  }
  const fe = normaliseFixedEnd(fixedEnd, n);
  const table = fillTable(startCost, cost, fe);
  const size = 1 << n;
  // prizeSum[mask] built from mask without its lowest bit.
  const prizeSum = new Float64Array(size);
  for (let mask = 1; mask < size; mask++) {
    const low = mask & (-mask);
    const idx = 31 - Math.clz32(low);
    const p = idx < prize.length && Number.isFinite(prize[idx]) ? prize[idx] : 0;
    prizeSum[mask] = prizeSum[mask ^ low] + p;
  }
  let bestMask = 0;
  let bestEnd = -1;
  let bestPrize = 0;
  let bestCost = 0;
  for (let mask = 1; mask < size; mask++) {
    const base = mask * n;
    const p = prizeSum[mask];
    if (p < bestPrize) {
      continue;
    }
    for (let j = 0; j < n; j++) {
      if ((fe >= 0 && j !== fe) || ((mask >> j) & 1) === 0) {
        continue;
      }
      const d = table.dp[base + j];
      if (d <= budgetS && (p > bestPrize || d < bestCost)) {
        bestMask = mask;
        bestEnd = j;
        bestPrize = p;
        bestCost = d;
      }
    }
  }
  if (bestEnd < 0) {
    return empty;
  }
  const plan = new PathPlan();
  plan.algo = 'orienteering';
  plan.order = reconstruct(table, bestMask, bestEnd);
  plan.costS = bestCost;
  return plan;
}

function isUsableCost(v: number | undefined): boolean {
  return v !== undefined && Number.isFinite(v) && v >= 0;
}

/**
 * Fills dp[mask][j] for every subset. fe (if >= 0) is terminal: paths may end there for any mask
 * (orienteering needs that) but never continue from it, so it is always the last stop.
 */
function fillTable(startCost: number[], cost: number[][], fe: number): HkTable {
  const n = startCost.length;
  const size = 1 << n;
  const dp = new Float64Array(size * n);
  dp.fill(Number.POSITIVE_INFINITY);
  const parent = new Int8Array(size * n);
  parent.fill(-1);
  const c = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      c[i * n + j] = i === j ? 0 : cost[i][j];
    }
  }
  for (let j = 0; j < n; j++) {
    dp[(1 << j) * n + j] = startCost[j];
  }
  for (let mask = 1; mask < size; mask++) {
    const base = mask * n;
    for (let j = 0; j < n; j++) {
      if (j === fe || ((mask >> j) & 1) === 0) {
        continue;
      }
      const d = dp[base + j];
      if (d === Number.POSITIVE_INFINITY) {
        continue;
      }
      const row = j * n;
      for (let k = 0; k < n; k++) {
        if (((mask >> k) & 1) !== 0) {
          continue;
        }
        const idx = (mask | (1 << k)) * n + k;
        const v = d + c[row + k];
        if (v < dp[idx]) {
          dp[idx] = v;
          parent[idx] = j;
        }
      }
    }
  }
  const table = new HkTable();
  table.n = n;
  table.dp = dp;
  table.parent = parent;
  return table;
}

function reconstruct(table: HkTable, endMask: number, end: number): number[] {
  const n = table.n;
  const rev: number[] = [];
  let mask = endMask;
  let cur = end;
  while (cur >= 0 && mask !== 0) {
    rev.push(cur);
    const p: number = table.parent[mask * n + cur];
    mask = mask ^ (1 << cur);
    cur = p;
  }
  return rev.reverse();
}
