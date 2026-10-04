// Suite: CourseEstimator.test - module under test: core/geo/CourseEstimator (task A1).
// Cases from docs/ARCHITECTURE.md §11.1: uses fix.direction when moving; derives from history when direction
// is NaN; holds 60 s when stopped; unknown after. Plus: slow/inaccurate direction ignored, vector smoothing
// across north, jitter at a stop does not turn the held course, out-of-order fixes ignored.
import { describe, it, expect } from 'vitest';
import { CourseEstimate, CourseEstimator, CourseSource } from '../src';
import { Fix, FixSource } from '../src';

const LAT0: number = 50.06143;
const LNG0: number = 19.93658;
const M_PER_DEG_LAT: number = 111195;
const M_PER_DEG_LNG: number = 111195 * Math.cos(LAT0 * Math.PI / 180);

/** A fix at (east, north) metres from Rynek. */
function fixAt(eastM: number, northM: number, tS: number, speed: number, course: number, courseAcc: number): Fix {
  const f: Fix = {
    lat: LAT0 + northM / M_PER_DEG_LAT,
    lng: LNG0 + eastM / M_PER_DEG_LNG,
    accuracyM: 5,
    speedMps: speed,
    courseDeg: course,
    courseAccuracyDeg: courseAcc,
    timestampMs: 1000000 + tS * 1000,
    provider: 1,
    source: FixSource.DEMO
  };
  return f;
}

function near(actual: number, expected: number, tol: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

/** Smallest absolute angle between two courses. */
function angDiff(a: number, b: number): number {
  const d: number = Math.abs(((a - b) % 360 + 540) % 360 - 180);
  return d;
}

/** Walks east at 1.4 m/s for n seconds with the given fix direction; returns the last estimate. */
function walkEast(ce: CourseEstimator, n: number, course: number): CourseEstimate {
  let e: CourseEstimate = ce.update(fixAt(0, 0, 0, 1.4, course, Number.NaN));
  for (let s = 1; s <= n; s++) {
    e = ce.update(fixAt(1.4 * s, 0, s, 1.4, course, Number.NaN));
  }
  return e;
}

function courseEstimatorTest() {
  describe('CourseEstimator', () => {
    it('unknown_before_any_fix_and_at_first_still_fix', () => {
      const ce: CourseEstimator = new CourseEstimator();
      const e: CourseEstimate = ce.update(fixAt(0, 0, 0, 0, Number.NaN, Number.NaN));
      expect(e.known).toBe(false);
      expect(e.source).toBe(CourseSource.UNKNOWN);
      expect(Number.isNaN(e.courseDeg)).toBe(true);
    });
    it('uses_fix_direction_when_moving', () => {
      const ce: CourseEstimator = new CourseEstimator();
      const e: CourseEstimate = ce.update(fixAt(0, 0, 0, 1.4, 90, 10));
      expect(e.source).toBe(CourseSource.FIX);
      expect(e.known).toBe(true);
      near(e.courseDeg, 90, 1e-9);
      // directionAccuracy absent (NaN) is accepted too
      const e2: CourseEstimate = ce.update(fixAt(1.4, 0, 1, 1.4, 90, Number.NaN));
      expect(e2.source).toBe(CourseSource.FIX);
      near(e2.courseDeg, 90, 1e-9);
    });
    it('ignores_direction_when_slow_or_inaccurate', () => {
      // too slow: no course from the fix (and no history yet)
      const slow: CourseEstimator = new CourseEstimator();
      expect(slow.update(fixAt(0, 0, 0, 0.3, 90, 5)).known).toBe(false);
      // directionAccuracy 60 > 45: direction ignored; history gives east once >= 8 m are covered
      const bad: CourseEstimator = new CourseEstimator();
      bad.update(fixAt(0, 0, 0, 1.4, 200, 60));
      const e: CourseEstimate = bad.update(fixAt(10, 0, 5, 1.4, 200, 60));
      expect(e.source).toBe(CourseSource.HISTORY);
      near(e.courseDeg, 90, 0.5);
    });
    it('derives_from_history_when_direction_nan', () => {
      const ce: CourseEstimator = new CourseEstimator();
      // walking north at 1.4 m/s without a direction: unknown until 8 m are covered (6 s)
      for (let s = 0; s <= 5; s++) {
        expect(ce.update(fixAt(0, 1.4 * s, s, 1.4, Number.NaN, Number.NaN)).known).toBe(false);
      }
      const e: CourseEstimate = ce.update(fixAt(0, 1.4 * 6, 6, 1.4, Number.NaN, Number.NaN));
      expect(e.source).toBe(CourseSource.HISTORY);
      near(angDiff(e.courseDeg, 0), 0, 0.5);
      // speed unknown (NaN) also derives from history: now heading west
      const w: CourseEstimator = new CourseEstimator();
      w.update(fixAt(0, 0, 0, Number.NaN, Number.NaN, Number.NaN));
      const e2: CourseEstimate = w.update(fixAt(-9, 0, 6, Number.NaN, Number.NaN, Number.NaN));
      expect(e2.source).toBe(CourseSource.HISTORY);
      near(e2.courseDeg, 270, 0.5);
    });
    it('history_only_within_30s', () => {
      const ce: CourseEstimator = new CourseEstimator();
      ce.update(fixAt(0, 0, 0, Number.NaN, Number.NaN, Number.NaN));
      // 20 m away but 31 s later: too old to derive a course
      expect(ce.update(fixAt(20, 0, 31, Number.NaN, Number.NaN, Number.NaN)).known).toBe(false);
    });
    it('smooths_by_vector_average_across_north', () => {
      const ce: CourseEstimator = new CourseEstimator();
      ce.update(fixAt(0, 0, 0, 1.4, 350, Number.NaN));
      const e: CourseEstimate = ce.update(fixAt(0, 1.4, 1, 1.4, 10, Number.NaN));
      // arithmetic mean would be 180; the vector average is north
      near(angDiff(e.courseDeg, 0), 0, 1e-6);
      // window of 3: after three fixes at 90 the old 350/10 are gone
      ce.update(fixAt(1.4, 1.4, 2, 1.4, 90, Number.NaN));
      ce.update(fixAt(2.8, 1.4, 3, 1.4, 90, Number.NaN));
      const e2: CourseEstimate = ce.update(fixAt(4.2, 1.4, 4, 1.4, 90, Number.NaN));
      near(e2.courseDeg, 90, 1e-6);
    });
    it('holds_60s_when_stopped_then_unknown', () => {
      const ce: CourseEstimator = new CourseEstimator();
      walkEast(ce, 10, 90);
      const x: number = 14;
      // stopped (speed 0, no direction) at t = 11 .. 70: held
      for (let s = 11; s <= 70; s++) {
        const e: CourseEstimate = ce.update(fixAt(x, 0, s, 0, Number.NaN, Number.NaN));
        expect(e.source).toBe(CourseSource.HELD);
        near(e.courseDeg, 90, 1e-6);
      }
      // last valid course at t = 10, so t = 71 is 61 s later: unknown
      const after: CourseEstimate = ce.update(fixAt(x, 0, 71, 0, Number.NaN, Number.NaN));
      expect(after.known).toBe(false);
      expect(after.source).toBe(CourseSource.UNKNOWN);
    });
    it('course_at_tick_without_fix', () => {
      const ce: CourseEstimator = new CourseEstimator();
      walkEast(ce, 5, 90);
      const t5: number = 1000000 + 5 * 1000;
      expect(ce.courseAt(t5).source).toBe(CourseSource.FIX);
      const held: CourseEstimate = ce.courseAt(t5 + 60000);
      expect(held.source).toBe(CourseSource.HELD);
      near(held.courseDeg, 90, 1e-6);
      expect(ce.courseAt(t5 + 60001).known).toBe(false);
    });
    it('jitter_at_a_stop_does_not_turn_the_course', () => {
      const ce: CourseEstimator = new CourseEstimator();
      walkEast(ce, 10, 90);
      // standing still (speed 0.1) while the fix jumps 10 m around the stop
      const jx: number[] = [14, 4, 14, 14, 24, 14];
      const jy: number[] = [10, 0, -10, 0, 0, 0];
      for (let i = 0; i < jx.length; i++) {
        const e: CourseEstimate = ce.update(fixAt(jx[i], jy[i], 11 + i, 0.1, Number.NaN, Number.NaN));
        expect(e.source).toBe(CourseSource.HELD);
        near(e.courseDeg, 90, 1e-6);
      }
    });
    it('ignores_out_of_order_and_malformed_fixes', () => {
      const ce: CourseEstimator = new CourseEstimator();
      ce.update(fixAt(0, 0, 10, 1.4, 90, Number.NaN));
      // older timestamp with a different direction: ignored
      const e: CourseEstimate = ce.update(fixAt(0, 0, 5, 1.4, 270, Number.NaN));
      near(e.courseDeg, 90, 1e-6);
      const bad: Fix = fixAt(0, 0, 11, 1.4, 270, Number.NaN);
      bad.lat = Number.NaN;
      near(ce.update(bad).courseDeg, 90, 1e-6);
      ce.reset();
      expect(ce.courseAt(1000000 + 11000).known).toBe(false);
    });
  });
}

courseEstimatorTest();
