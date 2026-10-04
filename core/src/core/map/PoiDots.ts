/*
 * Explore layer (B13, DESIGN §3.7, ARCHITECTURE §3.2): which of the pack's places are drawn as dots at the current
 * camera. Level of detail: places with a sourced story show from the overview zoom, name-only places appear as
 * the map zooms in (more important first). Then a greedy screen-space thinning (stories first, then by
 * importance) keeps dots at least `minSepPx` apart, so crowded squares stay legible. Hit test: nearest placed dot
 * within the tap radius (24 px, ARCHITECTURE §3.2).
 * Pure: no platform imports.
 */
import { Camera, worldToScreen } from './Camera';

/** Scale (px per metre) at which name-only places of importance 0 / 1 appear. */
export const NAME_ONLY_MIN_S0: number = 2.0;
export const NAME_ONLY_MIN_S1: number = 0.4;
export const DOT_SEP_PX: number = 10;
export const DOT_MAX: number = 400;
export const DOT_HIT_PX: number = 24;

export class DotCandidate {
  id: string;
  x: number;
  y: number;
  importance: number;
  story: boolean;

  constructor(id: string, x: number, y: number, importance: number, story: boolean) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.importance = importance;
    this.story = story;
  }
}

export class PlacedDot {
  id: string;
  sx: number;
  sy: number;
  story: boolean;

  constructor(id: string, sx: number, sy: number, story: boolean) {
    this.id = id;
    this.sx = sx;
    this.sy = sy;
    this.story = story;
  }
}

/** Smallest map scale at which a place is drawn: stories always, name-only places by importance. */
export function dotMinScale(importance: number, story: boolean): number {
  if (story) {
    return 0;
  }
  const imp = Number.isFinite(importance) ? Math.max(0, Math.min(1, importance)) : 0;
  return NAME_ONLY_MIN_S0 * (1 - imp) + NAME_ONLY_MIN_S1 * imp;
}

function rankCmp(a: DotCandidate, b: DotCandidate): number {
  if (a.story !== b.story) {
    return a.story ? -1 : 1;
  }
  return b.importance - a.importance;
}

/**
 * Dots to draw for `cands` (already culled to about the viewport) at camera `cam` on a w x h canvas: LOD filter,
 * on-screen check, then greedy thinning in rank order. A selected place is always kept (drawn last, on top).
 */
export function placeDots(cands: DotCandidate[], cam: Camera, w: number, h: number, selectedId: string = '',
  minSepPx: number = DOT_SEP_PX, maxDots: number = DOT_MAX): PlacedDot[] {
  const visible = cands.filter((c: DotCandidate) => c.id === selectedId || cam.s >= dotMinScale(c.importance, c.story));
  visible.sort((a: DotCandidate, b: DotCandidate) => {
    if (a.id === selectedId || b.id === selectedId) {
      return a.id === selectedId ? -1 : 1;
    }
    return rankCmp(a, b);
  });
  const cell = Math.max(1, minSepPx);
  const taken: Map<string, PlacedDot[]> = new Map<string, PlacedDot[]>();
  const out: PlacedDot[] = [];
  const sep2 = minSepPx * minSepPx;
  for (const c of visible) {
    if (out.length >= maxDots) {
      break;
    }
    const p = worldToScreen(cam, c.x, c.y, w, h);
    if (p.x < -minSepPx || p.y < -minSepPx || p.x > w + minSepPx || p.y > h + minSepPx) {
      continue;
    }
    const gx = Math.floor(p.x / cell);
    const gy = Math.floor(p.y / cell);
    let clash = false;
    for (let dx = -1; dx <= 1 && !clash; dx++) {
      for (let dy = -1; dy <= 1 && !clash; dy++) {
        const bucket = taken.get(`${gx + dx},${gy + dy}`);
        if (bucket === undefined) {
          continue;
        }
        for (const d of bucket) {
          const ex = d.sx - p.x;
          const ey = d.sy - p.y;
          if (ex * ex + ey * ey < sep2) {
            clash = true;
            break;
          }
        }
      }
    }
    if (clash && c.id !== selectedId) {
      continue;
    }
    const dot = new PlacedDot(c.id, p.x, p.y, c.story);
    out.push(dot);
    const key = `${gx},${gy}`;
    const bucket = taken.get(key);
    if (bucket === undefined) {
      taken.set(key, [dot]);
    } else {
      bucket.push(dot);
    }
  }
  return out;
}

/** Id of the placed dot nearest to the tap (sx, sy) within maxPx, or '' when none. */
export function hitDot(dots: PlacedDot[], sx: number, sy: number, maxPx: number = DOT_HIT_PX): string {
  let best = '';
  let bestD = maxPx * maxPx;
  for (const d of dots) {
    const dd = (d.sx - sx) * (d.sx - sx) + (d.sy - sy) * (d.sy - sy);
    if (dd <= bestD) {
      bestD = dd;
      best = d.id;
    }
  }
  return best;
}
