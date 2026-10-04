/*
 * Draws the offline map with Skia (ARCHITECTURE §3.2): one SkPath per pack layer, built once in world metres
 * (pack geometry is decimetre ints in the Projection frame), then per frame one camera transform
 * (translate + scale(s, -s), the Camera maths of core/map/Camera), layers bottom to top, the route, and screen-space
 * overlays (explore dots, plaques, user). During a gesture (`fast`) only water, green, major streets and the
 * overlays are drawn. Returns the frame time in ms (logged as MAP_FRAME by MapCanvas).
 * Port of views/map/MapRenderer.ets: the CanvasRenderingContext2D calls map 1:1 onto SkCanvas calls recorded into an
 * SkPicture by MapCanvas.
 */
import {
  matchFont, PaintStyle, Skia, SkCanvas, SkColor, SkFont, SkPaint, SkPath, StrokeCap, StrokeJoin
} from '@shopify/react-native-skia';
import { Platform } from 'react-native';
import { Camera, MapData, MapFeature, MapLayer } from '@citytour/core';
import { Log } from '@/main/Log';
import { PlaqueState } from '@/views/common/Plaque';
import { defaultMinScale, LineWidth, MapPalette } from './MapStyle';
import type { PoiLayer } from './PoiLayer';

export class StopMark {
  x: number;
  y: number;
  n: number;
  state: PlaqueState;
  name: string;

  constructor(x: number, y: number, n: number, state: PlaqueState, name: string) {
    this.x = x;
    this.y = y;
    this.n = n;
    this.state = state;
    this.name = name;
  }
}

export class UserMark {
  x: number = 0;
  y: number = 0;
  accuracyM: number = Number.NaN;
  courseDeg: number = Number.NaN;   // NaN = unknown: no cone
  simulated: boolean = false;
}

export class MapOverlay {
  /** Route legs in walking order, flat world metres [x0, y0, x1, y1, ...]. */
  legs: number[][] = [];
  /** Legs before this index are walked (grey), this one is next (accent + casing), later ones 45 % accent. */
  nextLegIdx: number = 0;
  /** Previews: draw every leg in the "next" style. */
  allActive: boolean = false;
  stops: StopMark[] = [];
  user: UserMark | undefined = undefined;
  labels: boolean = false;
}

class LayerPath {
  id: string;
  polygon: boolean;
  minScale: number;
  path: SkPath;

  constructor(id: string, polygon: boolean, minScale: number, path: SkPath) {
    this.id = id;
    this.polygon = polygon;
    this.minScale = minScale;
    this.path = path;
  }
}

function clampPx(metres: number, s: number, minPx: number, maxPx: number): number {
  return Math.max(minPx, Math.min(maxPx, metres * s));
}

const MAP_FRAME: string = 'MAP_FRAME';

/** Pack geometry: decimetres. */
const DM: number = 10;
/** JS-thread budget per slice while building paths; the rest continues on the next macrotask. */
const SLICE_MS: number = 6;
/** Pause between slices so input and rendering run in between. */
const YIELD_MS: number = 4;

// ---- Paint helpers (Canvas 2D state -> SkPaint) ----

const colorCache: Map<string, SkColor> = new Map<string, SkColor>();

function col(css: string): SkColor {
  let c = colorCache.get(css);
  if (c === undefined) {
    c = Skia.Color(css);
    colorCache.set(css, c);
  }
  return c;
}

function fillPaint(css: string, alpha: number = 1): SkPaint {
  const p = Skia.Paint();
  p.setAntiAlias(true);
  p.setStyle(PaintStyle.Fill);
  p.setColor(col(css));
  if (alpha < 1) {
    p.setAlphaf(p.getAlphaf() * alpha);
  }
  return p;
}

function strokePaint(css: string, width: number, alpha: number = 1): SkPaint {
  const p = fillPaint(css, alpha);
  p.setStyle(PaintStyle.Stroke);
  p.setStrokeWidth(width);
  p.setStrokeJoin(StrokeJoin.Round);
  p.setStrokeCap(StrokeCap.Round);
  return p;
}

const FONT_FAMILY: string = Platform.select({ ios: 'Helvetica', default: 'sans-serif' }) ?? 'sans-serif';
const fonts: Map<string, SkFont> = new Map<string, SkFont>();

/** System font by weight and size, created once. */
export function mapFont(weight: '500' | 'bold', size: number): SkFont {
  const key = `${weight}:${size}`;
  let f = fonts.get(key);
  if (f === undefined) {
    f = matchFont({ fontFamily: FONT_FAMILY, fontSize: size, fontWeight: weight });
    fonts.set(key, f);
  }
  return f;
}

/** Baseline for text vertically centred on y (Canvas textBaseline 'middle'). */
function middleBaseline(font: SkFont, y: number): number {
  const m = font.getMetrics();
  return y - (m.ascent + m.descent) / 2;
}

/**
 * The SkPaths of one map, built incrementally: a slice of features at a time (moveTo/lineTo), yielding to the JS
 * event loop between slices so a big pack never blocks input. Layers become visible one by one as they finish;
 * every MapCanvas showing this map is notified.
 */
class PathBuild {
  layers: LayerPath[] = [];
  done: boolean = false;
  private listeners: Set<() => void> = new Set<() => void>();

  listen(f: () => void): void {
    this.listeners.add(f);
  }

  unlisten(f: () => void): void {
    this.listeners.delete(f);
  }

  start(data: MapData): void {
    const t0 = Date.now();
    let li = 0;
    let fi = 0;
    let path: SkPath = Skia.Path.Make();
    const step = (): void => {
      const sliceStart = Date.now();
      try {
        while (li < data.layers.length) {
          const l: MapLayer = data.layers[li];
          const polygon = l.geom === 'polygon';
          while (fi < l.features.length) {
            addFeature(path, l.features[fi], polygon);
            fi++;
            if ((fi & 31) === 0 && Date.now() - sliceStart > SLICE_MS) {
              setTimeout(step, YIELD_MS);
              return;
            }
          }
          this.layers.push(new LayerPath(l.id, polygon, l.minScale > 0 ? l.minScale : defaultMinScale(l.id), path));
          this.notify();
          li++;
          fi = 0;
          path = Skia.Path.Make();
        }
      } catch (e) {
        Log.e(MAP_FRAME, `event=paths_fail layer=${li} ${Log.errKv(e)}`);
      }
      this.done = true;
      Log.i(MAP_FRAME, `event=paths_built layers=${this.layers.length} ms=${Date.now() - t0}`);
      this.notify();
    };
    step();
  }

  private notify(): void {
    this.listeners.forEach((f: () => void) => {
      try {
        f();
      } catch {
        // a disappeared canvas: ignore
      }
    });
  }
}

/** `rings` are start offsets into `c` (flat index, even); one ring when absent. */
function addFeature(p: SkPath, f: MapFeature, polygon: boolean): void {
  const c = f.c;
  const starts: number[] = f.rings !== undefined && f.rings !== null && f.rings.length > 0 ? f.rings : [0];
  for (let r = 0; r < starts.length; r++) {
    const from = starts[r];
    const to = r + 1 < starts.length ? starts[r + 1] : c.length;
    if (from < 0 || from + 1 >= c.length) {
      continue;
    }
    p.moveTo(c[from] / DM, c[from + 1] / DM);
    for (let i = from + 2; i + 1 < to; i += 2) {
      p.lineTo(c[i] / DM, c[i + 1] / DM);
    }
    if (polygon) {
      p.close();
    }
  }
}

export class MapRenderer {
  private build: PathBuild | undefined = undefined;
  private source: MapData | undefined = undefined;
  private onUpdate: (() => void) | undefined = undefined;
  /** Path builds per MapData object (a few maps per session: the city map, a course's own map). */
  private static builds: Map<MapData, PathBuild> = new Map<MapData, PathBuild>();

  private get layers(): LayerPath[] {
    return this.build !== undefined ? this.build.layers : [];
  }

  /** Starts (or joins) the incremental path build for this map; `onUpdate` fires as layers become ready. */
  setMap(data: MapData | undefined, onUpdate?: () => void): void {
    if (data === this.source) {
      return;
    }
    if (this.build !== undefined && this.onUpdate !== undefined) {
      this.build.unlisten(this.onUpdate);
    }
    this.source = data;
    this.build = undefined;
    this.onUpdate = onUpdate;
    if (data === undefined) {
      return;
    }
    let b = MapRenderer.builds.get(data);
    if (b === undefined) {
      if (MapRenderer.builds.size >= 4) {
        MapRenderer.builds.clear();
      }
      b = new PathBuild();
      MapRenderer.builds.set(data, b);
      if (onUpdate !== undefined) {
        b.listen(onUpdate);
      }
      this.build = b;
      b.start(data);
      return;
    }
    if (onUpdate !== undefined && !b.done) {
      b.listen(onUpdate);
    }
    this.build = b;
  }

  /** Stop notifying this renderer's canvas (the canvas is going away). */
  release(): void {
    if (this.build !== undefined && this.onUpdate !== undefined) {
      this.build.unlisten(this.onUpdate);
    }
    this.onUpdate = undefined;
  }

  hasBase(): boolean {
    return this.layers.length > 0;
  }

  layerCount(): number {
    return this.layers.length;
  }

  /** `transparentLand`: leave the background clear instead of painting the land. */
  draw(ctx: SkCanvas, w: number, h: number, cam: Camera, ov: MapOverlay, pal: MapPalette,
    fast: boolean, transparentLand: boolean = false, places: PoiLayer | undefined = undefined,
    lodScale: number = 1): number {
    const t0 = Date.now();
    const s = cam.s;
    if (!transparentLand) {
      ctx.drawRect(Skia.XYWHRect(0, 0, w, h), fillPaint(pal.land));
    }

    // World transform: x east, y north (flipped), metres -> pt.
    ctx.save();
    ctx.translate(w / 2 - cam.cx * s, h / 2 + cam.cy * s);
    ctx.scale(s, -s);
    for (const l of this.layers) {
      // lodScale < 1 (static previews, e.g. Tour detail's Route card) shows the street layers further out.
      if (s < l.minScale * lodScale) {
        continue;
      }
      if (fast && !(l.id === 'water' || l.id === 'river' || l.id === 'green' || l.id === 'major')) {
        continue;
      }
      this.drawLayer(ctx, l, s, pal);
    }
    this.drawRoute(ctx, ov, s, pal);
    ctx.restore();

    if (places !== undefined) {
      places.draw(ctx, w, h, cam, pal);   // B13 explore layer: under the stop plaques and the user
    }
    this.drawStops(ctx, w, h, cam, ov, pal);
    if (ov.user !== undefined) {
      this.drawUser(ctx, w, h, cam, ov.user, pal);
    }
    return Date.now() - t0;
  }

  private drawLayer(ctx: SkCanvas, l: LayerPath, s: number, pal: MapPalette): void {
    switch (l.id) {
      case 'water':
        ctx.drawPath(l.path, fillPaint(pal.water));
        return;
      case 'river':
        ctx.drawPath(l.path, strokePaint(pal.water, Math.max(4, LineWidth.RIVER_M * s) / s));
        return;
      case 'green':
        ctx.drawPath(l.path, fillPaint(pal.green));
        return;
      case 'buildings':
        ctx.drawPath(l.path, fillPaint(pal.buildings));
        if (s > 1.5) {
          ctx.drawPath(l.path, strokePaint(pal.buildingStroke, 1 / s));
        }
        return;
      case 'unesco': {
        const p = strokePaint(pal.unesco, 1 / s);
        p.setPathEffect(Skia.PathEffect.MakeDash([6 / s, 4 / s], 0));
        ctx.drawPath(l.path, p);
        return;
      }
      case 'paths':
        ctx.drawPath(l.path, strokePaint(pal.path,
          clampPx(LineWidth.PATH_M, s, LineWidth.PATH_MIN_PX, LineWidth.PATH_MAX_PX) / s));
        return;
      case 'minor':
        ctx.drawPath(l.path, strokePaint(pal.minorStreet,
          clampPx(LineWidth.MINOR_M, s, LineWidth.MINOR_MIN_PX, LineWidth.MINOR_MAX_PX) / s));
        return;
      case 'major':
        ctx.drawPath(l.path, strokePaint(pal.majorStreet,
          clampPx(LineWidth.MAJOR_M, s, LineWidth.MAJOR_MIN_PX, LineWidth.MAJOR_MAX_PX) / s));
        return;
      default:
        return;
    }
  }

  private legPath(flat: number[]): SkPath {
    const p = Skia.Path.Make();
    if (flat.length >= 4) {
      p.moveTo(flat[0], flat[1]);
      for (let i = 2; i + 1 < flat.length; i += 2) {
        p.lineTo(flat[i], flat[i + 1]);
      }
    }
    return p;
  }

  private drawRoute(ctx: SkCanvas, ov: MapOverlay, s: number, pal: MapPalette): void {
    for (let i = ov.legs.length - 1; i >= 0; i--) {
      const path = this.legPath(ov.legs[i]);
      const isNext = ov.allActive || i === ov.nextLegIdx;
      const walked = !ov.allActive && i < ov.nextLegIdx;
      if (isNext) {
        ctx.drawPath(path, strokePaint(pal.casing, 9 / s));
        ctx.drawPath(path, strokePaint(pal.routeNext, 5 / s));
      } else {
        ctx.drawPath(path, strokePaint(walked ? pal.routeWalked : pal.routeLater, 4 / s));
      }
    }
  }

  private drawStops(ctx: SkCanvas, w: number, h: number, cam: Camera, ov: MapOverlay, pal: MapPalette): void {
    // Priority: next/current, then the first and last stop, then upcoming, then visited. A plaque that would
    // overlap one already placed becomes a small dot, so crowded squares (Rynek at overview zoom) stay legible.
    const last = ov.stops.length - 1;
    const order = ov.stops.map((st: StopMark, i: number) => i).sort((a: number, b: number) =>
      this.priority(ov.stops[b], b === 0 || b === last) - this.priority(ov.stops[a], a === 0 || a === last));
    const placed: number[] = [];
    const dots: number[] = [];
    for (const i of order) {
      const st = ov.stops[i];
      const x = (st.x - cam.cx) * cam.s + w / 2;
      const y = -(st.y - cam.cy) * cam.s + h / 2;
      if (x < -30 || y < -30 || x > w + 30 || y > h + 30) {
        continue;
      }
      let clash = false;
      for (let k = 0; k + 1 < placed.length; k += 2) {
        const dx = placed[k] - x;
        const dy = placed[k + 1] - y;
        if (dx * dx + dy * dy < 30 * 30) {
          clash = true;
          break;
        }
      }
      if (clash) {
        dots.push(i);
        continue;
      }
      placed.push(x, y);
      this.drawPlaque(ctx, x, y, st, pal);
      if (ov.labels && st.name !== '' && (st.state === PlaqueState.NEXT || st.state === PlaqueState.CURRENT)) {
        const font = mapFont('500', 12);
        const by = middleBaseline(font, y);
        ctx.drawText(st.name, x + 22, by, strokePaint(pal.labelHalo, 3), font);
        ctx.drawText(st.name, x + 22, by, fillPaint(pal.label), font);
      }
    }
    // Crowded stops as small dots, under the plaques' halo colours.
    for (const i of dots) {
      const st = ov.stops[i];
      const x = (st.x - cam.cx) * cam.s + w / 2;
      const y = -(st.y - cam.cy) * cam.s + h / 2;
      ctx.drawCircle(x, y, 4, fillPaint(st.state === PlaqueState.VISITED ? pal.tertiary : pal.accent));
      ctx.drawCircle(x, y, 4, strokePaint(pal.surface, 1.5));
    }
  }

  private priority(st: StopMark, endpoint: boolean): number {
    if (st.state === PlaqueState.NEXT || st.state === PlaqueState.CURRENT) {
      return 4;
    }
    if (endpoint) {
      return 3;
    }
    return st.state === PlaqueState.UPCOMING ? 2 : 1;
  }

  private drawPlaque(ctx: SkCanvas, x: number, y: number, st: StopMark, pal: MapPalette): void {
    const big = st.state === PlaqueState.NEXT || st.state === PlaqueState.CURRENT;
    const small = st.state === PlaqueState.VISITED || st.state === PlaqueState.SKIPPED;
    const r = big ? 17 : small ? 12 : 14;
    if (st.state === PlaqueState.CURRENT) {
      ctx.drawCircle(x, y, r + 8, fillPaint(pal.routeLater));
    }
    ctx.drawCircle(x, y, r, fillPaint(big ? pal.accent : st.state === PlaqueState.VISITED ? pal.tertiary : pal.surface));
    if (st.state !== PlaqueState.VISITED) {
      const ring = strokePaint(big ? pal.surface : st.state === PlaqueState.UPCOMING ? pal.accent : pal.tertiary,
        big ? 3 : st.state === PlaqueState.UPCOMING ? 2 : 1.5);
      ring.setStrokeCap(StrokeCap.Butt);
      if (st.state === PlaqueState.SKIPPED) {
        ring.setPathEffect(Skia.PathEffect.MakeDash([3, 2], 0));
      }
      ctx.drawCircle(x, y, r, ring);
    }
    if (st.state === PlaqueState.VISITED) {
      const tick = Skia.Path.Make();
      tick.moveTo(x - 4.5, y + 0.5);
      tick.lineTo(x - 1.2, y + 3.8);
      tick.lineTo(x + 5, y - 3.5);
      const p = strokePaint(pal.surface, 2);
      p.setStrokeJoin(StrokeJoin.Miter);
      p.setStrokeCap(StrokeCap.Butt);
      ctx.drawPath(tick, p);
      return;
    }
    if (st.n <= 0) {
      // Not a tour stop (Place detail of an explore place): a plain pin, no number.
      ctx.drawCircle(x, y, 5, fillPaint(big ? pal.onAccent : pal.accent));
      return;
    }
    const font = mapFont('bold', big ? 13 : 12);
    const text = `${st.n}`;
    const tw = font.measureText(text).width;
    ctx.drawText(text, x - tw / 2, middleBaseline(font, y + 0.5),
      fillPaint(big ? pal.onAccent : st.state === PlaqueState.UPCOMING ? pal.accent : pal.tertiary), font);
  }

  private drawUser(ctx: SkCanvas, w: number, h: number, cam: Camera, u: UserMark, pal: MapPalette): void {
    const x = (u.x - cam.cx) * cam.s + w / 2;
    const y = -(u.y - cam.cy) * cam.s + h / 2;
    if (x < -40 || y < -40 || x > w + 40 || y > h + 40) {
      return;
    }
    if (Number.isFinite(u.accuracyM) && u.accuracyM >= 10) {
      ctx.drawCircle(x, y, u.accuracyM * cam.s, fillPaint(pal.userHalo));
    }
    if (Number.isFinite(u.courseDeg)) {
      // 60 degree wedge, 40 pt, pointing along the course (0 = north, clockwise).
      const a = u.courseDeg - 90;
      const cone = Skia.Path.Make();
      cone.moveTo(x, y);
      cone.arcToOval(Skia.XYWHRect(x - 40, y - 40, 80, 80), a - 30, 60, false);
      cone.close();
      ctx.drawPath(cone, fillPaint(pal.userCone));
    }
    if (u.simulated) {
      ctx.drawCircle(x, y, 7, strokePaint(pal.user, 3));   // hollow ring = simulated (DESIGN §4.8)
    } else {
      ctx.drawCircle(x, y, 7, fillPaint(pal.user));
      ctx.drawCircle(x, y, 7, strokePaint('#FFFFFF', 3));
    }
  }
}
