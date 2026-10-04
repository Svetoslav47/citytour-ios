/*
 * Uniform grid over projected metres for nearest-POI and viewport queries (task A1, P1 part).
 * Sources: docs/PLAN.md A1 (bucket POIs by 100 m cells), docs/ARCHITECTURE.md §3.2 (map hit test: nearest POI
 * within 24 px; POI dots culled to the viewport). Generic: callers pass the item and its projected x/y,
 * e.g. `index.add(poi, poi.x, poi.y)`.
 * Pure: no platform imports.
 */

export const GRID_CELL_M: number = 100;

export interface GridHit<T> {
  item: T;
  distM: number;
}

class GridEntry<T> {
  item: T;
  x: number;
  y: number;

  constructor(item: T, x: number, y: number) {
    this.item = item;
    this.x = x;
    this.y = y;
  }
}

export class GridIndex<T> {
  readonly cellM: number;
  private cells: Map<string, GridEntry<T>[]> = new Map<string, GridEntry<T>[]>();
  private count: number = 0;
  private minCx: number = Number.POSITIVE_INFINITY;
  private maxCx: number = Number.NEGATIVE_INFINITY;
  private minCy: number = Number.POSITIVE_INFINITY;
  private maxCy: number = Number.NEGATIVE_INFINITY;

  constructor(cellM: number = GRID_CELL_M) {
    this.cellM = cellM > 0 ? cellM : GRID_CELL_M;
  }

  size(): number {
    return this.count;
  }

  clear(): void {
    this.cells.clear();
    this.count = 0;
    this.minCx = Number.POSITIVE_INFINITY;
    this.maxCx = Number.NEGATIVE_INFINITY;
    this.minCy = Number.POSITIVE_INFINITY;
    this.maxCy = Number.NEGATIVE_INFINITY;
  }

  /** Adds an item at projected metres (x east, y north). Non-finite positions are ignored. */
  add(item: T, x: number, y: number): boolean {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return false;
    }
    const cx: number = this.cellOf(x);
    const cy: number = this.cellOf(y);
    const key: string = GridIndex.key(cx, cy);
    let bucket: GridEntry<T>[] | undefined = this.cells.get(key);
    if (bucket === undefined) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push(new GridEntry<T>(item, x, y));
    this.count++;
    this.minCx = Math.min(this.minCx, cx);
    this.maxCx = Math.max(this.maxCx, cx);
    this.minCy = Math.min(this.minCy, cy);
    this.maxCy = Math.max(this.maxCy, cy);
    return true;
  }

  /** Nearest item to (x, y) within maxDistM (inclusive), or undefined. Searches rings of cells outwards. */
  nearest(x: number, y: number, maxDistM: number = Number.POSITIVE_INFINITY): GridHit<T> | undefined {
    if (this.count === 0 || !Number.isFinite(x) || !Number.isFinite(y) || !(maxDistM >= 0)) {
      return undefined;
    }
    const cx0: number = this.cellOf(x);
    const cy0: number = this.cellOf(y);
    const toEdge: number = Math.max(Math.abs(cx0 - this.minCx), Math.abs(cx0 - this.maxCx),
      Math.abs(cy0 - this.minCy), Math.abs(cy0 - this.maxCy));
    const maxRing: number = Number.isFinite(maxDistM) ? Math.min(toEdge, Math.ceil(maxDistM / this.cellM) + 1) : toEdge;
    let best: GridEntry<T> | undefined = undefined;
    let bestD: number = Number.POSITIVE_INFINITY;
    if ((2 * maxRing + 1) * (2 * maxRing + 1) > 4 * this.count + 64) {
      // far-away query (e.g. the emulator's Beijing fix) or an unbounded radius: a linear scan is cheaper
      this.cells.forEach((bucket: GridEntry<T>[]) => {
        for (const e of bucket) {
          const d: number = Math.hypot(e.x - x, e.y - y);
          if (d < bestD) {
            bestD = d;
            best = e;
          }
        }
      });
      return this.hitOrUndefined(best, bestD, maxDistM);
    }
    for (let k = 0; k <= maxRing; k++) {
      for (let dx = -k; dx <= k; dx++) {
        const edge: boolean = dx === -k || dx === k;
        for (let dy = -k; dy <= k; dy += (edge ? 1 : 2 * k)) {
          const bucket: GridEntry<T>[] | undefined = this.cells.get(GridIndex.key(cx0 + dx, cy0 + dy));
          if (bucket !== undefined) {
            for (const e of bucket) {
              const d: number = Math.hypot(e.x - x, e.y - y);
              if (d < bestD) {
                bestD = d;
                best = e;
              }
            }
          }
          if (k === 0) {
            break;
          }
        }
      }
      // every cell of ring k + 1 is at least k cells away from the query point
      if (best !== undefined && bestD <= k * this.cellM) {
        break;
      }
    }
    return this.hitOrUndefined(best, bestD, maxDistM);
  }

  private hitOrUndefined(best: GridEntry<T> | undefined, bestD: number, maxDistM: number): GridHit<T> | undefined {
    if (best === undefined || bestD > maxDistM) {
      return undefined;
    }
    const hit: GridHit<T> = { item: best.item, distM: bestD };
    return hit;
  }

  /** All items within radiusM (inclusive) of (x, y), nearest first. */
  within(x: number, y: number, radiusM: number): GridHit<T>[] {
    const out: GridHit<T>[] = [];
    if (this.count === 0 || !Number.isFinite(x) || !Number.isFinite(y) || !(radiusM >= 0)) {
      return out;
    }
    this.forEachInRect(x - radiusM, y - radiusM, x + radiusM, y + radiusM, (e: GridEntry<T>) => {
      const d: number = Math.hypot(e.x - x, e.y - y);
      if (d <= radiusM) {
        const hit: GridHit<T> = { item: e.item, distM: d };
        out.push(hit);
      }
    });
    out.sort((a: GridHit<T>, b: GridHit<T>) => a.distM - b.distM);
    return out;
  }

  /** All items inside the rectangle (inclusive), e.g. the map viewport in world metres. */
  inRect(minX: number, minY: number, maxX: number, maxY: number): T[] {
    const out: T[] = [];
    if (this.count === 0) {
      return out;
    }
    this.forEachInRect(minX, minY, maxX, maxY, (e: GridEntry<T>) => {
      out.push(e.item);
    });
    return out;
  }

  private forEachInRect(minX: number, minY: number, maxX: number, maxY: number, f: (e: GridEntry<T>) => void): void {
    if (!(minX <= maxX) || !(minY <= maxY)) {
      return;
    }
    const inside = (e: GridEntry<T>): boolean => e.x >= minX && e.x <= maxX && e.y >= minY && e.y <= maxY;
    const c0x: number = Math.max(this.cellOf(minX), this.minCx);
    const c1x: number = Math.min(this.cellOf(maxX), this.maxCx);
    const c0y: number = Math.max(this.cellOf(minY), this.minCy);
    const c1y: number = Math.min(this.cellOf(maxY), this.maxCy);
    if (c0x > c1x || c0y > c1y) {
      return;
    }
    if ((c1x - c0x + 1) * (c1y - c0y + 1) > this.cells.size) {
      // a huge rectangle: scanning the occupied buckets is cheaper than walking empty cells
      this.cells.forEach((bucket: GridEntry<T>[]) => {
        for (const e of bucket) {
          if (inside(e)) {
            f(e);
          }
        }
      });
      return;
    }
    for (let cx = c0x; cx <= c1x; cx++) {
      for (let cy = c0y; cy <= c1y; cy++) {
        const bucket: GridEntry<T>[] | undefined = this.cells.get(GridIndex.key(cx, cy));
        if (bucket !== undefined) {
          for (const e of bucket) {
            if (inside(e)) {
              f(e);
            }
          }
        }
      }
    }
  }

  private cellOf(v: number): number {
    return Math.floor(v / this.cellM);
  }

  private static key(cx: number, cy: number): string {
    return `${cx},${cy}`;
  }
}
