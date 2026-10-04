/*
 * Fix quality gate between every LocationSource and the TourEngine (task A1).
 * Sources: docs/ARCHITECTURE.md §2.3 (NETWORK fixes are not trigger-grade unless accuracy <= 25 m; network
 * fallback reports every 20 s, so gaps are tolerated, never dropped), §4.3 (maxTriggerAccuracyM = 40;
 * speedWindow = median of the last 5 trigger-grade speeds), §5 (both sources share this filter).
 * Rules:
 *   - malformed fixes (non-finite lat/lng/timestamp, lat/lng out of range) are dropped;
 *   - out-of-order or duplicate timestamps (<= the last accepted one) are dropped;
 *   - accuracy > 40 m (or unknown) is accepted but not trigger-grade: it moves the dot, never triggers;
 *   - provider NETWORK (2) with accuracy > 25 m is accepted but not trigger-grade;
 *   - speedMedianMps = median of the last 5 finite, non-negative speeds of trigger-grade fixes (NaN if none).
 * Pure: no platform imports.
 */
import { Fix } from '../../contracts/Ports';

export const MAX_TRIGGER_ACCURACY_M: number = 40;
export const NETWORK_MAX_TRIGGER_ACCURACY_M: number = 25;
export const SPEED_WINDOW: number = 5;
export const PROVIDER_NETWORK: number = 2;

export enum FixVerdict {
  TRIGGER = 'trigger',               // accepted and trigger-grade
  POOR_ACCURACY = 'poorAccuracy',    // accepted, accuracy > 40 m or unknown
  NETWORK_COARSE = 'networkCoarse',  // accepted, NETWORK provider with accuracy > 25 m
  OUT_OF_ORDER = 'outOfOrder',       // dropped
  MALFORMED = 'malformed'            // dropped
}

export interface FilteredFix {
  fix: Fix;
  accepted: boolean;        // false = drop it entirely (do not move the dot)
  triggerGrade: boolean;    // may cause arrival/exit and feeds the speed median
  verdict: FixVerdict;
  speedMedianMps: number;   // over the last 5 trigger-grade speeds, NaN if none yet
  gapMs: number;            // since the previous accepted fix, NaN for the first one or a dropped fix
}

/** Median of a non-empty list; NaN for an empty one. */
export function median(values: number[]): number {
  if (values.length === 0) {
    return Number.NaN;
  }
  const s: number[] = values.slice().sort((a: number, b: number) => a - b);
  const mid: number = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Quality class of a single fix, ignoring ordering. */
export function classifyFix(fix: Fix): FixVerdict {
  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng) || !Number.isFinite(fix.timestampMs) ||
    Math.abs(fix.lat) > 90 || Math.abs(fix.lng) > 180) {
    return FixVerdict.MALFORMED;
  }
  if (!(fix.accuracyM <= MAX_TRIGGER_ACCURACY_M)) { // also catches NaN
    return FixVerdict.POOR_ACCURACY;
  }
  if (fix.provider === PROVIDER_NETWORK && fix.accuracyM > NETWORK_MAX_TRIGGER_ACCURACY_M) {
    return FixVerdict.NETWORK_COARSE;
  }
  return FixVerdict.TRIGGER;
}

export class FixFilter {
  private lastT: number = Number.NEGATIVE_INFINITY;
  private speeds: number[] = [];
  private dropped: number = 0;

  reset(): void {
    this.lastT = Number.NEGATIVE_INFINITY;
    this.speeds = [];
    this.dropped = 0;
  }

  /** Number of fixes dropped since the last reset (malformed or out of order). */
  droppedCount(): number {
    return this.dropped;
  }

  /** Current speed median (NaN until a trigger-grade fix with a speed arrived). */
  speedMedianMps(): number {
    return median(this.speeds);
  }

  accept(fix: Fix): FilteredFix {
    let verdict: FixVerdict = classifyFix(fix);
    if (verdict !== FixVerdict.MALFORMED && fix.timestampMs <= this.lastT) {
      verdict = FixVerdict.OUT_OF_ORDER;
    }
    if (verdict === FixVerdict.MALFORMED || verdict === FixVerdict.OUT_OF_ORDER) {
      this.dropped++;
      const drop: FilteredFix = {
        fix: fix, accepted: false, triggerGrade: false, verdict: verdict,
        speedMedianMps: median(this.speeds), gapMs: Number.NaN
      };
      return drop;
    }
    const gapMs: number = Number.isFinite(this.lastT) ? fix.timestampMs - this.lastT : Number.NaN;
    this.lastT = fix.timestampMs;
    const triggerGrade: boolean = verdict === FixVerdict.TRIGGER;
    if (triggerGrade && Number.isFinite(fix.speedMps) && fix.speedMps >= 0) {
      this.speeds.push(fix.speedMps);
      if (this.speeds.length > SPEED_WINDOW) {
        this.speeds.shift();
      }
    }
    const out: FilteredFix = {
      fix: fix, accepted: true, triggerGrade: triggerGrade, verdict: verdict,
      speedMedianMps: median(this.speeds), gapMs: gapMs
    };
    return out;
  }
}
