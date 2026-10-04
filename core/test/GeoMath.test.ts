// Suite: GeoMath.test - module under test: core/geo/GeoMath + Projection (+ GridIndex, task A1).
// Cases from docs/ARCHITECTURE.md §11.1: haversine Rynek->Wawel 800-900 m; bearing N/E/S/W; relDir bucket
// edges (25, 70, 120, 160, wrap at +-180); pointToSegment; projection round-trip < 0.05 m; constants match
// the pipeline reference points (origin, Wawel, Barbican: PLAN A1, pinned by B2 too).
import { describe, it, expect } from 'vitest';
import {
  bearingDeg, haversineM, normalizeDeg, normalizeSignedDeg, pointToSegment, relAngleDeg, relDir, relDirForAngle,
  SegmentHit
} from '../src';
import {
  M_PER_DEG_LAT, M_PER_DEG_LNG_EQUATOR, PACK_ORIGIN_LAT, PACK_ORIGIN_LNG, Projection, XY
} from '../src';
import { GridHit, GridIndex } from '../src';
import { RelDir } from '../src';
import { LatLng } from '../src';

/** The Kraków fixture pack's projection (origin Rynek Główny), as its manifest.json origin gives it. */
const KRAKOW_PROJECTION: Projection = new Projection(PACK_ORIGIN_LAT, PACK_ORIGIN_LNG);

const RYNEK_LAT: number = 50.06143;
const RYNEK_LNG: number = 19.93658;
const WAWEL_LAT: number = 50.0540;
const WAWEL_LNG: number = 19.9354;
const BARBICAN_LAT: number = 50.0655;
const BARBICAN_LNG: number = 19.9417;

function near(actual: number, expected: number, tol: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

function geoMathTest() {
  describe('GeoMath', () => {
    it('haversine_rynek_to_wawel_800_900m', () => {
      const d: number = haversineM(RYNEK_LAT, RYNEK_LNG, WAWEL_LAT, WAWEL_LNG);
      expect(d).toBeGreaterThan(800);
      expect(d).toBeLessThan(900);
      near(d, 830.46, 0.5);
    });
    it('haversine_zero_and_symmetric', () => {
      expect(haversineM(RYNEK_LAT, RYNEK_LNG, RYNEK_LAT, RYNEK_LNG)).toBe(0);
      near(haversineM(WAWEL_LAT, WAWEL_LNG, BARBICAN_LAT, BARBICAN_LNG),
        haversineM(BARBICAN_LAT, BARBICAN_LNG, WAWEL_LAT, WAWEL_LNG), 1e-6);
      // one degree of latitude on the mean sphere is about 111.195 km
      near(haversineM(50, 20, 51, 20), 111195, 5);
    });
    it('bearing_north_east_south_west', () => {
      near(bearingDeg(50, 20, 50.01, 20), 0, 1e-6);
      near(bearingDeg(50, 20, 50, 20.01), 90, 0.01);
      near(bearingDeg(50, 20, 49.99, 20), 180, 1e-6);
      near(bearingDeg(50, 20, 50, 19.99), 270, 0.01);
      // Rynek -> Wawel is roughly south-south-west
      const b: number = bearingDeg(RYNEK_LAT, RYNEK_LNG, WAWEL_LAT, WAWEL_LNG);
      expect(b).toBeGreaterThan(180);
      expect(b).toBeLessThan(200);
    });
    it('normalize_deg_ranges', () => {
      near(normalizeDeg(-90), 270, 1e-9);
      near(normalizeDeg(720), 0, 1e-9);
      near(normalizeDeg(359.5), 359.5, 1e-9);
      expect(normalizeDeg(-0)).toBe(0);
      near(normalizeSignedDeg(190), -170, 1e-9);
      near(normalizeSignedDeg(-180), 180, 1e-9);
      near(normalizeSignedDeg(180), 180, 1e-9);
      near(relAngleDeg(10, 350), 20, 1e-9);
      near(relAngleDeg(350, 10), -20, 1e-9);
    });
    it('reldir_bucket_edges_right', () => {
      expect(relDirForAngle(0)).toBe(RelDir.AHEAD);
      expect(relDirForAngle(25)).toBe(RelDir.AHEAD);
      expect(relDirForAngle(25.01)).toBe(RelDir.AHEAD_RIGHT);
      expect(relDirForAngle(70)).toBe(RelDir.AHEAD_RIGHT);
      expect(relDirForAngle(70.01)).toBe(RelDir.RIGHT);
      expect(relDirForAngle(120)).toBe(RelDir.RIGHT);
      expect(relDirForAngle(120.01)).toBe(RelDir.BEHIND_RIGHT);
      expect(relDirForAngle(160)).toBe(RelDir.BEHIND_RIGHT);
      expect(relDirForAngle(160.01)).toBe(RelDir.BEHIND);
      expect(relDirForAngle(180)).toBe(RelDir.BEHIND);
    });
    it('reldir_bucket_edges_left_mirror', () => {
      expect(relDirForAngle(-25)).toBe(RelDir.AHEAD);
      expect(relDirForAngle(-25.01)).toBe(RelDir.AHEAD_LEFT);
      expect(relDirForAngle(-70)).toBe(RelDir.AHEAD_LEFT);
      expect(relDirForAngle(-70.01)).toBe(RelDir.LEFT);
      expect(relDirForAngle(-120)).toBe(RelDir.LEFT);
      expect(relDirForAngle(-120.01)).toBe(RelDir.BEHIND_LEFT);
      expect(relDirForAngle(-160)).toBe(RelDir.BEHIND_LEFT);
      expect(relDirForAngle(-160.01)).toBe(RelDir.BEHIND);
    });
    it('reldir_wraps_at_180', () => {
      // course 350, target bearing 10 -> rel +20 -> ahead (not 340 -> behind)
      expect(relDir(10, 350, 100)).toBe(RelDir.AHEAD);
      expect(relDir(350, 10, 100)).toBe(RelDir.AHEAD);
      // course 350, target 80 -> rel +90 -> right; target 260 -> rel -90 -> left
      expect(relDir(80, 350, 100)).toBe(RelDir.RIGHT);
      expect(relDir(260, 350, 100)).toBe(RelDir.LEFT);
      // rel exactly -180 normalises to +180 -> behind; 185 -> -175 -> behind
      expect(relDir(170, 350, 100)).toBe(RelDir.BEHIND);
      expect(relDir(185, 0, 100)).toBe(RelDir.BEHIND);
      // course 20, target 300 -> rel -80 -> left
      expect(relDir(300, 20, 100)).toBe(RelDir.LEFT);
    });
    it('reldir_here_when_close_or_course_unknown', () => {
      expect(relDir(90, 0, 14.9)).toBe(RelDir.HERE);
      expect(relDir(90, 0, 15)).toBe(RelDir.RIGHT);
      expect(relDir(90, Number.NaN, 300)).toBe(RelDir.HERE);
      expect(relDir(90, 0, Number.NaN)).toBe(RelDir.HERE);
    });
    it('point_to_segment', () => {
      // perpendicular foot inside the segment
      const mid: SegmentHit = pointToSegment(5, 3, 0, 0, 10, 0);
      near(mid.x, 5, 1e-9);
      near(mid.y, 0, 1e-9);
      near(mid.t, 0.5, 1e-9);
      near(mid.distM, 3, 1e-9);
      // beyond B clamps to B
      const past: SegmentHit = pointToSegment(14, 3, 0, 0, 10, 0);
      near(past.t, 1, 1e-9);
      near(past.distM, 5, 1e-9);
      // before A clamps to A
      const before: SegmentHit = pointToSegment(-3, -4, 0, 0, 10, 0);
      near(before.t, 0, 1e-9);
      near(before.distM, 5, 1e-9);
      // diagonal segment
      const diag: SegmentHit = pointToSegment(0, 10, 0, 0, 10, 10);
      near(diag.x, 5, 1e-9);
      near(diag.y, 5, 1e-9);
      near(diag.distM, Math.sqrt(50), 1e-9);
      // degenerate segment
      const dot: SegmentHit = pointToSegment(3, 4, 0, 0, 0, 0);
      near(dot.t, 0, 1e-9);
      near(dot.distM, 5, 1e-9);
    });
  });

  describe('Projection', () => {
    it('constants_match_architecture', () => {
      expect(PACK_ORIGIN_LAT).toBe(50.06143);
      expect(PACK_ORIGIN_LNG).toBe(19.93658);
      expect(M_PER_DEG_LNG_EQUATOR).toBe(111320.0);
      expect(M_PER_DEG_LAT).toBe(110574.0);
    });
    it('pipeline_reference_points', () => {
      // Expected values = the §3.2 formula evaluated once (Node, IEEE doubles); B2 pins the same numbers.
      const o: XY = KRAKOW_PROJECTION.toXY(RYNEK_LAT, RYNEK_LNG);
      near(o.x, 0, 1e-9);
      near(o.y, 0, 1e-9);
      const w: XY = KRAKOW_PROJECTION.toXY(WAWEL_LAT, WAWEL_LNG);
      near(w.x, -84.3271, 0.001);
      near(w.y, -821.5648, 0.001);
      const b: XY = KRAKOW_PROJECTION.toXY(BARBICAN_LAT, BARBICAN_LNG);
      near(b.x, 365.8939, 0.001);
      near(b.y, 450.0362, 0.001);
      // and the formula itself, written out
      const k: number = Math.cos(50.06143 * Math.PI / 180) * 111320.0;
      near(b.x, (19.9417 - 19.93658) * k, 1e-9);
      near(b.y, (50.0655 - 50.06143) * 110574.0, 1e-9);
    });
    it('projected_distance_close_to_haversine', () => {
      const w: XY = KRAKOW_PROJECTION.toXY(WAWEL_LAT, WAWEL_LNG);
      const planar: number = Math.hypot(w.x, w.y);
      const sphere: number = haversineM(RYNEK_LAT, RYNEK_LNG, WAWEL_LAT, WAWEL_LNG);
      // < 0.2 % within 5 km (ARCHITECTURE §3.2), here generously 1 %
      expect(Math.abs(planar - sphere) / sphere).toBeLessThan(0.01);
    });
    it('round_trip_under_5cm', () => {
      const pts: number[] = [RYNEK_LAT, RYNEK_LNG, WAWEL_LAT, WAWEL_LNG, BARBICAN_LAT, BARBICAN_LNG,
        50.0470, 19.9450, 50.0720, 19.9150];
      for (let i = 0; i < pts.length; i += 2) {
        const p: XY = KRAKOW_PROJECTION.toXY(pts[i], pts[i + 1]);
        const back: LatLng = KRAKOW_PROJECTION.toLatLng(p.x, p.y);
        expect(haversineM(pts[i], pts[i + 1], back.lat, back.lng)).toBeLessThan(0.05);
      }
    });
    it('custom_origin', () => {
      const origin: LatLng = { lat: 50.0617, lng: 19.9373 };
      const proj: Projection = Projection.fromOrigin(origin);
      const p: XY = proj.toXY(50.0617, 19.9373);
      near(p.x, 0, 1e-9);
      near(p.y, 0, 1e-9);
      // MiniPack fixture: Barbican is about (314.5, 420.1) from Cloth Hall
      const b: XY = proj.toXY(BARBICAN_LAT, BARBICAN_LNG);
      near(b.x, 314.5, 0.5);
      near(b.y, 420.1, 0.5);
    });
  });
  describe('GridIndex', () => {
    // deterministic pseudo-random points in a 3 km x 3 km box around the origin (incl. negative cells)
    let seed: number = 12345;
    const rnd = (): number => {
      seed = (seed * 16807) % 2147483647; // Park-Miller, exact in doubles
      return seed / 2147483647;
    };
    const xs: number[] = [];
    const ys: number[] = [];
    const index: GridIndex<number> = new GridIndex<number>(100);
    for (let i = 0; i < 300; i++) {
      xs.push(rnd() * 3000 - 1500);
      ys.push(rnd() * 3000 - 1500);
      index.add(i, xs[i], ys[i]);
    }
    const bruteNearest = (x: number, y: number): number => {
      let best: number = Number.POSITIVE_INFINITY;
      for (let i = 0; i < xs.length; i++) {
        best = Math.min(best, Math.hypot(xs[i] - x, ys[i] - y));
      }
      return best;
    };

    it('nearest_matches_brute_force', () => {
      expect(index.size()).toBe(300);
      for (let q = 0; q < 100; q++) {
        const x: number = rnd() * 4000 - 2000;
        const y: number = rnd() * 4000 - 2000;
        const want: number = bruteNearest(x, y);
        const bounded: GridHit<number> | undefined = index.nearest(x, y, 500);
        if (want <= 500) {
          expect(bounded === undefined).toBe(false);
          near((bounded as GridHit<number>).distM, want, 1e-9);
        } else {
          expect(bounded === undefined).toBe(true);
        }
        const free: GridHit<number> | undefined = index.nearest(x, y);
        near((free as GridHit<number>).distM, want, 1e-9);
      }
    });
    it('nearest_respects_max_distance_and_far_queries', () => {
      const g: GridIndex<string> = new GridIndex<string>();
      g.add('a', 0, 0);
      g.add('b', 250, 0);
      expect(g.nearest(100, 0, 99) === undefined).toBe(true);
      expect((g.nearest(100, 0, 100) as GridHit<string>).item).toBe('a');
      expect((g.nearest(140, 0, 1000) as GridHit<string>).item).toBe('b');
      // a fix in Beijing (thousands of km away) still answers, quickly, via the linear path
      const far: GridHit<string> | undefined = g.nearest(-7000000, 1000000);
      expect((far as GridHit<string>).item).toBe('a');
      expect(g.nearest(-7000000, 1000000, 30) === undefined).toBe(true);
    });
    it('within_radius_sorted_and_inclusive', () => {
      const g: GridIndex<string> = new GridIndex<string>();
      g.add('far', 300, 0);
      g.add('edge', 0, 100);
      g.add('mid', -50, 0);
      g.add('near', 10, 0);
      const hits: GridHit<string>[] = g.within(0, 0, 100);
      expect(hits.length).toBe(3);
      expect(hits[0].item).toBe('near');
      expect(hits[1].item).toBe('mid');
      expect(hits[2].item).toBe('edge');
      // and it agrees with brute force on the random set
      const r: GridHit<number>[] = index.within(120, -340, 260);
      let count: number = 0;
      for (let i = 0; i < xs.length; i++) {
        if (Math.hypot(xs[i] - 120, ys[i] + 340) <= 260) {
          count++;
        }
      }
      expect(r.length).toBe(count);
      for (let i = 1; i < r.length; i++) {
        expect(r[i].distM).toBeGreaterThanOrEqual(r[i - 1].distM);
      }
    });
    it('in_rect_viewport', () => {
      let count: number = 0;
      for (let i = 0; i < xs.length; i++) {
        if (xs[i] >= -420 && xs[i] <= 610 && ys[i] >= -1000 && ys[i] <= 35) {
          count++;
        }
      }
      expect(index.inRect(-420, -1000, 610, 35).length).toBe(count);
      // a whole-world rectangle returns everything; an inverted one nothing
      expect(index.inRect(-1e7, -1e7, 1e7, 1e7).length).toBe(300);
      expect(index.inRect(10, 10, -10, -10).length).toBe(0);
    });
    it('empty_and_invalid_input', () => {
      const g: GridIndex<string> = new GridIndex<string>();
      expect(g.nearest(0, 0) === undefined).toBe(true);
      expect(g.within(0, 0, 100).length).toBe(0);
      expect(g.add('nan', Number.NaN, 0)).toBe(false);
      expect(g.size()).toBe(0);
      g.add('a', 5, 5);
      expect(g.nearest(Number.NaN, 0) === undefined).toBe(true);
      g.clear();
      expect(g.size()).toBe(0);
      expect(g.inRect(-10, -10, 10, 10).length).toBe(0);
    });
  });
}

geoMathTest();
