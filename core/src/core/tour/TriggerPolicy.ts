/*
 * Arrival / exit geofence logic per tour stop, and the teaser-vs-full decision (task A3).
 * Source: docs/ARCHITECTURE.md §4.3.
 *   - Accuracy-aware distance: dEnter = max(0, d - min(acc, 15)) for entry (benefit of the doubt),
 *     dExit = d + min(acc, 15) for exit (conservative); exit radius = triggerR * 1.6.
 *   - Enter: 2 consecutive inside fixes spanning >= 1.5 s, or 1 fix with dEnter <= 0.5 * triggerR.
 *   - Exit: 3 consecutive fixes with dExit beyond the exit radius.
 *   - Fixes that are not trigger-grade (accuracy > 40 m, coarse NETWORK; see FixFilter) are ignored here:
 *     they neither count towards nor reset a streak, so they can never cause an arrival or an exit.
 * Teaser vs full (decided at sentence boundaries, never mid-sentence; issue #60 "linger window"):
 *   FULL when adaptive length is off, the user asked for more, or the user has not left the stop (no EXIT yet)
 *   and is lingering: >= 8 s of slow fixes inside the trigger radius, or the speed is unknown (benefit of the
 *   doubt), or slow: at the teaser's end the speed median < 0.6 m/s; later, the median has stayed < 0.6 m/s for
 *   lingerStillS (a short slow-down while walking past, e.g. a corner, is not a stop).
 *   TEASER_ONLY (STORY_SKIP_MOVING) once the user has clearly walked past: EXIT confirmed, or moving and
 *   lingerRecedeM beyond the closest point to the stop, or moving without getting any closer for lingerWindowS,
 *   or still undecided lingerMaxS after the teaser (safety bound).
 *   Otherwise (moving, still getting closer) the verdict is UNDECIDED: the engine holds silence after the teaser
 *   and asks again on every fix. Why: at walking pace the geofence (R + accuracy allowance) is entered ~25-50 s
 *   before the walker reaches the stop, so a decision taken the moment the teaser ends saw a walker who was still
 *   approaching and gave every dwell stop the teaser only. A guide waits to see whether you stop at the monument.
 *   Interpretation (A3, flagged for review): §4.3 first said `insideExit || slow || dwell >= 8 s`, but a walker is
 *   still inside 1.6 * R when a 20 s teaser ends and spends ~50 s inside R, so "inside" and plain dwell
 *   would make every walk-through FULL. Here leaving the stop forces TEASER_ONLY and dwell counts slow time only.
 * Pure: no platform imports.
 */
import { TourConfig } from './TourConfig';

export enum TriggerVerdict { NONE = 'none', ENTER = 'enter', EXIT = 'exit' }

/** UNDECIDED: the user is still moving but has not passed the stop yet (keep waiting, see the header). */
export enum StoryLength { FULL = 'full', TEASER_ONLY = 'teaserOnly', UNDECIDED = 'undecided' }

/** A teaser/full verdict and why (logged in STORY_LINGER / STORY_SKIP_MOVING). */
export interface StoryDecision {
  length: StoryLength;
  /** brief | adaptiveOff | askedMore | exited | speedUnknown | dwell | slow | still | receding | window | maxWait |
   *  approaching (UNDECIDED) */
  reason: string;
}

/** What the engine knows besides the geofence when it asks for the teaser/full verdict. */
export interface LingerInput {
  speedMedianMps: number;   // FixFilter's median of the last 5 trigger-grade speeds (NaN if unknown)
  slowForMs: number;        // fix time the median has been < slowSpeedMps without a break (0 = not slow now)
  waitedMs: number;         // engine time since the teaser ended (0 = at its end)
  adaptiveLength: boolean;
  userAskedMore: boolean;
  /** Settings detail level Brief (B9): the teaser at every stop unless the user asks for more. */
  briefOnly?: boolean;
}

/** One fix, reduced to what the geofence needs. */
export interface TriggerSample {
  tMs: number;
  distanceM: number;      // haversine user -> stop
  accuracyM: number;
  speedMps: number;       // NaN if unknown
  triggerGrade: boolean;  // FixFilter verdict
}

/** Geofence state of one stop. Mutated by evaluateTrigger. */
export class StopTrigger {
  readonly poiId: string;
  readonly triggerRadiusM: number;
  inside: boolean = false;
  enterStreak: number = 0;
  enterFirstMs: number = Number.NaN;
  exitStreak: number = 0;
  enteredAtMs: number = Number.NaN;
  exitedAtMs: number = Number.NaN;
  enterCount: number = 0;
  exitCount: number = 0;
  /** Slow (speed < slowSpeedMps) time inside the trigger radius since the last ENTER. */
  slowDwellMs: number = 0;
  lastInsideSampleMs: number = Number.NaN;
  lastDistanceM: number = Number.NaN;
  /** Closest raw distance to the stop since the last ENTER, and the fix time it was reached. */
  closestM: number = Number.NaN;
  closestAtMs: number = Number.NaN;
  /** How far the user is beyond that closest point: max(0, dEnter - closestM) (accuracy works in their favour). */
  recedeM: number = 0;

  constructor(poiId: string, triggerRadiusM: number) {
    this.poiId = poiId;
    this.triggerRadiusM = triggerRadiusM;
  }

  exitRadiusM(cfg: TourConfig): number {
    return this.triggerRadiusM * cfg.exitFactor;
  }

  /** Time since ENTER (ms), NaN when not inside. */
  dwellMs(nowMs: number): number {
    return this.inside ? nowMs - this.enteredAtMs : Number.NaN;
  }
}

export function accuracyAllowanceM(accuracyM: number, cfg: TourConfig): number {
  return Number.isFinite(accuracyM) && accuracyM > 0 ? Math.min(accuracyM, cfg.accuracyAllowanceCapM) : 0;
}

/** Entry distance: max(0, d - min(acc, 15)). */
export function entryDistanceM(distanceM: number, accuracyM: number, cfg: TourConfig): number {
  return Math.max(0, distanceM - accuracyAllowanceM(accuracyM, cfg));
}

/** Exit distance: d + min(acc, 15). */
export function exitDistanceM(distanceM: number, accuracyM: number, cfg: TourConfig): number {
  return distanceM + accuracyAllowanceM(accuracyM, cfg);
}

/** True when the sample may move a geofence (trigger-grade and accuracy within the limit). */
export function isTriggerSample(s: TriggerSample, cfg: TourConfig): boolean {
  return s.triggerGrade && Number.isFinite(s.distanceM) && Number.isFinite(s.tMs) &&
    s.accuracyM <= cfg.maxTriggerAccuracyM;
}

/** Feeds one sample (in time order) to a stop's geofence; returns ENTER or EXIT on a transition. */
export function evaluateTrigger(t: StopTrigger, s: TriggerSample, cfg: TourConfig): TriggerVerdict {
  if (!isTriggerSample(s, cfg)) {
    return TriggerVerdict.NONE;
  }
  t.lastDistanceM = s.distanceM;
  if (!t.inside) {
    const dEnter: number = entryDistanceM(s.distanceM, s.accuracyM, cfg);
    if (dEnter > t.triggerRadiusM) {
      t.enterStreak = 0;
      t.enterFirstMs = Number.NaN;
      return TriggerVerdict.NONE;
    }
    t.enterStreak++;
    if (t.enterStreak === 1) {
      t.enterFirstMs = s.tMs;
    }
    const immediate: boolean = dEnter <= cfg.enterImmediateFraction * t.triggerRadiusM;
    const confirmed: boolean = t.enterStreak >= cfg.enterConfirmFixes &&
      s.tMs - t.enterFirstMs >= cfg.enterConfirmMinSpanMs;
    if (!immediate && !confirmed) {
      return TriggerVerdict.NONE;
    }
    t.inside = true;
    t.enterCount++;
    t.enteredAtMs = s.tMs;
    t.exitedAtMs = Number.NaN;
    t.enterStreak = 0;
    t.enterFirstMs = Number.NaN;
    t.exitStreak = 0;
    t.slowDwellMs = 0;
    t.lastInsideSampleMs = s.tMs;
    t.closestM = s.distanceM;
    t.closestAtMs = s.tMs;
    t.recedeM = 0;
    return TriggerVerdict.ENTER;
  }
  // Inside: dwell bookkeeping, then the exit hysteresis.
  if (s.distanceM <= t.triggerRadiusM && Number.isFinite(t.lastInsideSampleMs)) {
    const gap: number = s.tMs - t.lastInsideSampleMs;
    if (gap > 0 && gap <= cfg.maxDwellGapMs && Number.isFinite(s.speedMps) && s.speedMps < cfg.slowSpeedMps) {
      t.slowDwellMs += gap;
    }
  }
  t.lastInsideSampleMs = s.tMs;
  if (!Number.isFinite(t.closestM) || s.distanceM < t.closestM) {
    t.closestM = s.distanceM;
    t.closestAtMs = s.tMs;
  }
  t.recedeM = Math.max(0, entryDistanceM(s.distanceM, s.accuracyM, cfg) - t.closestM);
  if (exitDistanceM(s.distanceM, s.accuracyM, cfg) <= t.exitRadiusM(cfg)) {
    t.exitStreak = 0;
    return TriggerVerdict.NONE;
  }
  t.exitStreak++;
  if (t.exitStreak < cfg.exitConfirmFixes) {
    return TriggerVerdict.NONE;
  }
  t.inside = false;
  t.exitCount++;
  t.exitedAtMs = s.tMs;
  t.exitStreak = 0;
  t.lastInsideSampleMs = Number.NaN;
  return TriggerVerdict.EXIT;
}

function decision(length: StoryLength, reason: string): StoryDecision {
  const d: StoryDecision = { length: length, reason: reason };
  return d;
}

/**
 * Teaser vs full after the teaser item has finished (see the header). Returns UNDECIDED while the user is moving,
 * has not passed the stop, is still getting closer and the linger window is open.
 */
export function decideAfterTeaser(t: StopTrigger, inp: LingerInput, cfg: TourConfig): StoryDecision {
  if (inp.userAskedMore) {
    return decision(StoryLength.FULL, 'askedMore');
  }
  if (inp.briefOnly === true) {
    return decision(StoryLength.TEASER_ONLY, 'brief');      // Settings detail level Brief
  }
  if (!inp.adaptiveLength) {
    return decision(StoryLength.FULL, 'adaptiveOff');
  }
  if (!t.inside) {
    return decision(StoryLength.TEASER_ONLY, 'exited');     // moving away: EXIT already confirmed
  }
  if (!Number.isFinite(inp.speedMedianMps)) {
    return decision(StoryLength.FULL, 'speedUnknown');
  }
  if (t.slowDwellMs >= cfg.fullStoryDwellS * 1000) {
    return decision(StoryLength.FULL, 'dwell');
  }
  if (inp.waitedMs <= 0 && inp.speedMedianMps < cfg.slowSpeedMps) {
    return decision(StoryLength.FULL, 'slow');              // already standing when the teaser ends
  }
  if (inp.waitedMs > 0 && inp.slowForMs >= cfg.lingerStillS * 1000) {
    return decision(StoryLength.FULL, 'still');             // came to a stop during the linger window
  }
  if (t.recedeM >= cfg.lingerRecedeM) {
    return decision(StoryLength.TEASER_ONLY, 'receding');   // walked past the closest point and on
  }
  if (t.lastInsideSampleMs - t.closestAtMs >= cfg.lingerWindowS * 1000) {
    return decision(StoryLength.TEASER_ONLY, 'window');     // moving, but no closer for a while
  }
  if (inp.waitedMs >= cfg.lingerMaxS * 1000) {
    return decision(StoryLength.TEASER_ONLY, 'maxWait');
  }
  return decision(StoryLength.UNDECIDED, 'approaching');
}

/**
 * The verdict at the teaser's end with no linger window (never UNDECIDED: still approaching counts as moving).
 * speedMedianMps is FixFilter's median of the last 5 trigger-grade speeds (NaN if unknown).
 */
export function decideStoryLength(t: StopTrigger, speedMedianMps: number, adaptiveLength: boolean,
  userAskedMore: boolean, cfg: TourConfig): StoryLength {
  const inp: LingerInput = {
    speedMedianMps: speedMedianMps, slowForMs: 0, waitedMs: 0, adaptiveLength: adaptiveLength,
    userAskedMore: userAskedMore
  };
  const d: StoryDecision = decideAfterTeaser(t, inp, cfg);
  return d.length === StoryLength.UNDECIDED ? StoryLength.TEASER_ONLY : d.length;
}
