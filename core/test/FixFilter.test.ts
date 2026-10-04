// Suite: FixFilter.test - module under test: core/geo/FixFilter (task A1).
// Cases from docs/ARCHITECTURE.md §11.1: rejects acc > 40 for triggers; NETWORK provider rule; speed median;
// out-of-order timestamps dropped. Plus: malformed fixes dropped, 20 s network gaps tolerated.
import { describe, it, expect } from 'vitest';
import { classifyFix, FilteredFix, FixFilter, FixVerdict, median } from '../src';
import { Fix, FixSource } from '../src';

function mkFix(tS: number, accuracyM: number, provider: number, speedMps: number): Fix {
  const f: Fix = {
    lat: 50.06143,
    lng: 19.93658,
    accuracyM: accuracyM,
    speedMps: speedMps,
    courseDeg: Number.NaN,
    courseAccuracyDeg: Number.NaN,
    timestampMs: 1000000 + tS * 1000,
    provider: provider,
    source: FixSource.REAL
  };
  return f;
}

function near(actual: number, expected: number, tol: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

function fixFilterTest() {
  describe('FixFilter', () => {
    it('rejects_accuracy_over_40_for_triggers', () => {
      const ff: FixFilter = new FixFilter();
      const ok: FilteredFix = ff.accept(mkFix(0, 40, 1, 1.2));
      expect(ok.accepted).toBe(true);
      expect(ok.triggerGrade).toBe(true);
      expect(ok.verdict).toBe(FixVerdict.TRIGGER);
      const poor: FilteredFix = ff.accept(mkFix(1, 40.1, 1, 1.2));
      expect(poor.accepted).toBe(true);      // still moves the dot
      expect(poor.triggerGrade).toBe(false);
      expect(poor.verdict).toBe(FixVerdict.POOR_ACCURACY);
      const bad: FilteredFix = ff.accept(mkFix(2, 80, 1, 1.2));
      expect(bad.triggerGrade).toBe(false);
      // unknown accuracy is never trigger-grade
      expect(ff.accept(mkFix(3, Number.NaN, 1, 1.2)).triggerGrade).toBe(false);
    });
    it('network_provider_rule', () => {
      const ff: FixFilter = new FixFilter();
      const coarse: FilteredFix = ff.accept(mkFix(0, 30, 2, Number.NaN));
      expect(coarse.accepted).toBe(true);
      expect(coarse.triggerGrade).toBe(false);
      expect(coarse.verdict).toBe(FixVerdict.NETWORK_COARSE);
      // NETWORK at exactly 25 m is trigger-grade
      expect(ff.accept(mkFix(20, 25, 2, Number.NaN)).triggerGrade).toBe(true);
      // the same 30 m from GNSS is trigger-grade
      expect(ff.accept(mkFix(40, 30, 1, Number.NaN)).triggerGrade).toBe(true);
      // NETWORK at 45 m is caught by the general accuracy rule first
      expect(ff.accept(mkFix(60, 45, 2, Number.NaN)).verdict).toBe(FixVerdict.POOR_ACCURACY);
    });
    it('tolerates_20s_network_gaps', () => {
      const ff: FixFilter = new FixFilter();
      expect(Number.isNaN(ff.accept(mkFix(0, 20, 2, Number.NaN)).gapMs)).toBe(true);
      const second: FilteredFix = ff.accept(mkFix(20, 20, 2, Number.NaN));
      expect(second.accepted).toBe(true);
      expect(second.gapMs).toBe(20000);
    });
    it('speed_median_of_last_5_trigger_grade', () => {
      const ff: FixFilter = new FixFilter();
      expect(Number.isNaN(ff.speedMedianMps())).toBe(true);
      near(ff.accept(mkFix(0, 5, 1, 1.0)).speedMedianMps, 1.0, 1e-9);
      near(ff.accept(mkFix(1, 5, 1, 3.0)).speedMedianMps, 2.0, 1e-9);     // even count: mean of the middle two
      ff.accept(mkFix(2, 5, 1, 1.2));
      ff.accept(mkFix(3, 5, 1, 9.0));                                    // spike
      near(ff.accept(mkFix(4, 5, 1, 1.4)).speedMedianMps, 1.4, 1e-9);     // [1, 3, 1.2, 9, 1.4]
      // poor-accuracy and unknown speeds do not enter the window
      near(ff.accept(mkFix(5, 60, 1, 50)).speedMedianMps, 1.4, 1e-9);
      near(ff.accept(mkFix(6, 5, 1, Number.NaN)).speedMedianMps, 1.4, 1e-9);
      // window slides: [3, 1.2, 9, 1.4, 0] -> 1.4; then [1.2, 9, 1.4, 0, 0] -> 1.2
      near(ff.accept(mkFix(7, 5, 1, 0)).speedMedianMps, 1.4, 1e-9);
      near(ff.accept(mkFix(8, 5, 1, 0)).speedMedianMps, 1.2, 1e-9);
      near(ff.speedMedianMps(), 1.2, 1e-9);
    });
    it('out_of_order_timestamps_dropped', () => {
      const ff: FixFilter = new FixFilter();
      expect(ff.accept(mkFix(10, 5, 1, 1.0)).accepted).toBe(true);
      const older: FilteredFix = ff.accept(mkFix(9, 5, 1, 7.0));
      expect(older.accepted).toBe(false);
      expect(older.triggerGrade).toBe(false);
      expect(older.verdict).toBe(FixVerdict.OUT_OF_ORDER);
      const dup: FilteredFix = ff.accept(mkFix(10, 5, 1, 7.0));
      expect(dup.accepted).toBe(false);
      expect(ff.droppedCount()).toBe(2);
      // dropped fixes did not touch the speed window, and newer fixes still pass
      near(ff.speedMedianMps(), 1.0, 1e-9);
      const next: FilteredFix = ff.accept(mkFix(11, 5, 1, 1.0));
      expect(next.accepted).toBe(true);
      expect(next.gapMs).toBe(1000);
    });
    it('malformed_fixes_dropped', () => {
      const ff: FixFilter = new FixFilter();
      const nanLat: Fix = mkFix(0, 5, 1, 1.0);
      nanLat.lat = Number.NaN;
      expect(ff.accept(nanLat).verdict).toBe(FixVerdict.MALFORMED);
      const farLng: Fix = mkFix(1, 5, 1, 1.0);
      farLng.lng = 200;
      expect(ff.accept(farLng).accepted).toBe(false);
      const noTime: Fix = mkFix(2, 5, 1, 1.0);
      noTime.timestampMs = Number.NaN;
      expect(classifyFix(noTime)).toBe(FixVerdict.MALFORMED);
      // a malformed fix does not advance the clock: the next valid fix is accepted
      expect(ff.accept(mkFix(0, 5, 1, 1.0)).accepted).toBe(true);
      ff.reset();
      expect(ff.droppedCount()).toBe(0);
    });
    it('median_helper', () => {
      expect(Number.isNaN(median([]))).toBe(true);
      expect(median([3])).toBe(3);
      expect(median([5, 1, 3])).toBe(3);
      expect(median([4, 1, 3, 2])).toBe(2.5);
    });
  });
}

fixFilterTest();
