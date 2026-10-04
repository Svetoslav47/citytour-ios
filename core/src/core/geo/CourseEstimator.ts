/*
 * Course over ground for the "on your left" cues and the map's course cone (task A1).
 * Source: docs/ARCHITECTURE.md §4.5, rules 1-5:
 *   1. speed >= 0.5 m/s and a valid fix direction (directionAccuracy <= 45 when present) -> use it;
 *   2. else the bearing from the newest history fix that is >= 8 m back (within 30 s);
 *   3. smooth by a vector average of the last 3 estimates;
 *   4. keep the last valid course for 60 s after the user stops;
 *   5. otherwise the course is unknown (NaN).
 * Interpretation of rule 2: it is skipped while the fix reports a known speed below 0.5 m/s (the user has
 * stopped), so GPS jitter at a stop cannot turn the held course around; rule 4 applies instead.
 * History ignores fixes worse than 40 m accuracy (not trigger-grade, see FixFilter), and estimates older
 * than 30 s drop out of the smoothing window.
 * Pure: no platform imports.
 */
import { Fix } from '../../contracts/Ports';
import { bearingDeg, haversineM, normalizeDeg, toDeg, toRad } from './GeoMath';

export const COURSE_MIN_SPEED_MPS: number = 0.5;
export const COURSE_MAX_DIRECTION_ACCURACY_DEG: number = 45;
export const COURSE_HISTORY_MIN_DIST_M: number = 8;
export const COURSE_HISTORY_MAX_AGE_MS: number = 30000;
export const COURSE_SMOOTH_WINDOW: number = 3;
export const COURSE_HOLD_MS: number = 60000;
export const COURSE_HISTORY_MAX_ACCURACY_M: number = 40;

export enum CourseSource {
  FIX = 'fix',          // rule 1: the fix's own direction
  HISTORY = 'history',  // rule 2: derived from movement
  HELD = 'held',        // rule 4: last valid course, user stopped
  UNKNOWN = 'unknown'   // rule 5
}

export interface CourseEstimate {
  courseDeg: number;    // 0..360, NaN when unknown
  source: CourseSource;
  known: boolean;
}

class HistoryPoint {
  lat: number;
  lng: number;
  t: number;

  constructor(lat: number, lng: number, t: number) {
    this.lat = lat;
    this.lng = lng;
    this.t = t;
  }
}

class RawEstimate {
  deg: number;
  t: number;

  constructor(deg: number, t: number) {
    this.deg = deg;
    this.t = t;
  }
}

function makeEstimate(courseDeg: number, source: CourseSource): CourseEstimate {
  const e: CourseEstimate = { courseDeg: courseDeg, source: source, known: !Number.isNaN(courseDeg) };
  return e;
}

export class CourseEstimator {
  private history: HistoryPoint[] = [];
  private raw: RawEstimate[] = [];
  private lastValidDeg: number = Number.NaN;
  private lastValidT: number = Number.NEGATIVE_INFINITY;
  private lastT: number = Number.NEGATIVE_INFINITY;
  private last: CourseEstimate = makeEstimate(Number.NaN, CourseSource.UNKNOWN);

  reset(): void {
    this.history = [];
    this.raw = [];
    this.lastValidDeg = Number.NaN;
    this.lastValidT = Number.NEGATIVE_INFINITY;
    this.lastT = Number.NEGATIVE_INFINITY;
    this.last = makeEstimate(Number.NaN, CourseSource.UNKNOWN);
  }

  /** Feeds one fix (in timestamp order) and returns the course estimate at that fix. */
  update(fix: Fix): CourseEstimate {
    const t: number = fix.timestampMs;
    if (!Number.isFinite(t) || t <= this.lastT || !Number.isFinite(fix.lat) || !Number.isFinite(fix.lng)) {
      return this.last; // out-of-order or malformed: ignore, keep the previous estimate
    }
    this.lastT = t;

    let rawDeg: number = Number.NaN;
    let source: CourseSource = CourseSource.UNKNOWN;
    const speedKnown: boolean = Number.isFinite(fix.speedMps);
    const directionValid: boolean = Number.isFinite(fix.courseDeg) &&
      !(Number.isFinite(fix.courseAccuracyDeg) && fix.courseAccuracyDeg > COURSE_MAX_DIRECTION_ACCURACY_DEG);

    if (speedKnown && fix.speedMps >= COURSE_MIN_SPEED_MPS && directionValid) {
      rawDeg = normalizeDeg(fix.courseDeg);                                 // rule 1
      source = CourseSource.FIX;
    } else if (!speedKnown || fix.speedMps >= COURSE_MIN_SPEED_MPS) {
      rawDeg = this.fromHistory(fix.lat, fix.lng, t);                       // rule 2
      source = Number.isNaN(rawDeg) ? CourseSource.UNKNOWN : CourseSource.HISTORY;
    }

    this.pushHistory(fix, t);

    if (!Number.isNaN(rawDeg)) {
      this.lastValidDeg = this.smooth(rawDeg, t);                           // rule 3
      this.lastValidT = t;
      this.last = makeEstimate(this.lastValidDeg, source);
    } else {
      this.last = this.heldAt(t);                                           // rules 4 and 5
    }
    return this.last;
  }

  /** Course at a later time without a new fix (e.g. a 1 Hz TICK): held for 60 s, then unknown. */
  courseAt(nowMs: number): CourseEstimate {
    if (nowMs <= this.lastT) {
      return this.last;
    }
    return this.last.source === CourseSource.UNKNOWN ? this.last : this.heldAt(nowMs);
  }

  private heldAt(t: number): CourseEstimate {
    if (!Number.isNaN(this.lastValidDeg) && t - this.lastValidT <= COURSE_HOLD_MS) {
      return makeEstimate(this.lastValidDeg, CourseSource.HELD);
    }
    return makeEstimate(Number.NaN, CourseSource.UNKNOWN);
  }

  private fromHistory(lat: number, lng: number, t: number): number {
    for (let i = this.history.length - 1; i >= 0; i--) {
      const p: HistoryPoint = this.history[i];
      if (t - p.t > COURSE_HISTORY_MAX_AGE_MS) {
        break;
      }
      if (haversineM(p.lat, p.lng, lat, lng) >= COURSE_HISTORY_MIN_DIST_M) {
        return bearingDeg(p.lat, p.lng, lat, lng);
      }
    }
    return Number.NaN;
  }

  private pushHistory(fix: Fix, t: number): void {
    if (Number.isFinite(fix.accuracyM) && fix.accuracyM <= COURSE_HISTORY_MAX_ACCURACY_M) {
      this.history.push(new HistoryPoint(fix.lat, fix.lng, t));
    }
    while (this.history.length > 0 && t - this.history[0].t > COURSE_HISTORY_MAX_AGE_MS) {
      this.history.shift();
    }
  }

  private smooth(rawDeg: number, t: number): number {
    this.raw.push(new RawEstimate(rawDeg, t));
    while (this.raw.length > COURSE_SMOOTH_WINDOW ||
      (this.raw.length > 0 && t - this.raw[0].t > COURSE_HISTORY_MAX_AGE_MS)) {
      this.raw.shift();
    }
    let sx: number = 0;
    let sy: number = 0;
    for (const r of this.raw) {
      sx += Math.sin(toRad(r.deg));
      sy += Math.cos(toRad(r.deg));
    }
    if (Math.hypot(sx, sy) < 1e-6) {
      return rawDeg; // opposite estimates cancel out: trust the newest
    }
    return normalizeDeg(toDeg(Math.atan2(sx, sy)));
  }
}
