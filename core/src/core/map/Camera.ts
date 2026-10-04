/*
 * Map camera maths (ARCHITECTURE §3.2), pure and unit-tested (MapCamera suite). North-up only.
 * World = projected metres (x east, y north) in the pack frame (core/geo/Projection). Screen = vp, y down.
 *   sx = (x - cx) * s + W / 2
 *   sy = -(y - cy) * s + H / 2
 * s = px per metre, clamped to [S_MIN, S_MAX] (whole city .. street level).
 */

export const S_MIN: number = 0.12;
export const S_MAX: number = 8;

export class Camera {
  cx: number = 0;
  cy: number = 0;
  s: number = 1;

  constructor(cx: number = 0, cy: number = 0, s: number = 1) {
    this.cx = cx;
    this.cy = cy;
    this.s = clampScale(s);
  }

  copy(): Camera {
    return new Camera(this.cx, this.cy, this.s);
  }
}

export class ScreenPt {
  x: number = 0;
  y: number = 0;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }
}

export function clampScale(s: number): number {
  if (!Number.isFinite(s) || s <= 0) {
    return 1;
  }
  return Math.max(S_MIN, Math.min(S_MAX, s));
}

export function worldToScreen(cam: Camera, x: number, y: number, w: number, h: number): ScreenPt {
  return new ScreenPt((x - cam.cx) * cam.s + w / 2, -(y - cam.cy) * cam.s + h / 2);
}

export function screenToWorld(cam: Camera, sx: number, sy: number, w: number, h: number): ScreenPt {
  return new ScreenPt((sx - w / 2) / cam.s + cam.cx, -(sy - h / 2) / cam.s + cam.cy);
}

/**
 * Camera that shows the world box [minX, minY, maxX, maxY] inside a w x h viewport with `pad` vp on every side,
 * plus extra `topInset` / `bottomInset` vp reserved for overlays (header, panel). Clamped scale.
 */
export function fitBounds(bounds: number[], w: number, h: number, pad: number, topInset: number = 0,
  bottomInset: number = 0): Camera {
  if (bounds.length < 4 || w <= 0 || h <= 0) {
    return new Camera(0, 0, 1);
  }
  const spanX = Math.max(1, bounds[2] - bounds[0]);
  const spanY = Math.max(1, bounds[3] - bounds[1]);
  const usableW = Math.max(1, w - 2 * pad);
  const usableH = Math.max(1, h - 2 * pad - topInset - bottomInset);
  const s = clampScale(Math.min(usableW / spanX, usableH / spanY));
  const cx = (bounds[0] + bounds[2]) / 2;
  // Shift the centre so the box sits in the usable band between the insets.
  const cy = (bounds[1] + bounds[3]) / 2 + (topInset - bottomInset) / 2 / s;
  return new Camera(cx, cy, s);
}

/**
 * The world box a map opens on when nothing else is framed (explore mode): the pack map's own `bounds` when they
 * form a valid box (each course's map-detail.json covers its own area, e.g. Kazimierz), else `fallback`.
 */
export function mapOpenBounds(mapBounds: number[] | undefined, fallback: number[]): number[] {
  if (mapBounds === undefined || mapBounds.length !== 4) {
    return fallback;
  }
  for (const v of mapBounds) {
    if (!Number.isFinite(v)) {
      return fallback;
    }
  }
  return mapBounds[2] > mapBounds[0] && mapBounds[3] > mapBounds[1] ? mapBounds : fallback;
}

/** Bounding box [minX, minY, maxX, maxY] of flat [x0, y0, x1, y1, ...] arrays; undefined if empty. */
export function boundsOf(flat: number[][]): number[] | undefined {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const arr of flat) {
    for (let i = 0; i + 1 < arr.length; i += 2) {
      minX = Math.min(minX, arr[i]);
      maxX = Math.max(maxX, arr[i]);
      minY = Math.min(minY, arr[i + 1]);
      maxY = Math.max(maxY, arr[i + 1]);
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : undefined;
}

/** Pan by a screen delta (finger moved by dx, dy vp): the world follows the finger. */
export function pan(cam: Camera, dx: number, dy: number): Camera {
  return new Camera(cam.cx - dx / cam.s, cam.cy + dy / cam.s, cam.s);
}

/** Zoom by `factor` keeping the world point under (fx, fy) fixed on screen. */
export function zoomAt(cam: Camera, factor: number, fx: number, fy: number, w: number, h: number): Camera {
  const before = screenToWorld(cam, fx, fy, w, h);
  const s = clampScale(cam.s * factor);
  const c = new Camera(cam.cx, cam.cy, s);
  const after = screenToWorld(c, fx, fy, w, h);
  c.cx += before.x - after.x;
  c.cy += before.y - after.y;
  return c;
}

/** Visible world box [minX, minY, maxX, maxY] for culling. */
export function viewport(cam: Camera, w: number, h: number): number[] {
  const hw = w / 2 / cam.s;
  const hh = h / 2 / cam.s;
  return [cam.cx - hw, cam.cy - hh, cam.cx + hw, cam.cy + hh];
}

/** True when two boxes [minX, minY, maxX, maxY] overlap. */
export function intersects(a: number[], b: number[]): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Index of the nearest point (flat x/y list, world metres) within `maxPx` of the screen tap, else -1. */
export function hitTest(cam: Camera, sx: number, sy: number, w: number, h: number, pts: number[],
  maxPx: number): number {
  let best = -1;
  let bestD = maxPx * maxPx;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const p = worldToScreen(cam, pts[i], pts[i + 1], w, h);
    const d = (p.x - sx) * (p.x - sx) + (p.y - sy) * (p.y - sy);
    if (d <= bestD) {
      bestD = d;
      best = i / 2;
    }
  }
  return best;
}
