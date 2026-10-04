/*
 * Progress along one walking leg, maneuver cues and off-route detection (task A9).
 * Sources: docs/ARCHITECTURE.md §4.6 (project the fix onto the leg polyline with pointToSegment, monotonic search
 * from the last index => alongM, crossTrackM, next step, distToManeuverM; prepare at <= 30 m, now at <= 8 m, once
 * per step; long continue > 250 m; leg 0 snaps onto a leg polyline once within 30 m), §4.7 (off-route when
 * crossTrackM > max(35, 20 + min(accuracy, 30)) for >= 12 s and >= 3 trigger-grade fixes; clear when crossTrackM < 20
 * for 2 fixes).
 *
 * Demo speeds (issue #10, A5 note): DemoWalkSource stamps fixes with the wall clock, so at x8 the ~55 s demo detour
 * lasts ~7 wall seconds and a pure ">= 12 s" rule never fires. "12 s" is therefore read as "12 s of walking": the
 * hold is met after 12 s of fix time OR once the walker has moved offRouteHoldSpanM (12 s x 1.3 m/s) away from where
 * they first left the route, always with >= 3 trigger-grade fixes. At real walking pace both are the same; GPS
 * jitter while standing does not build up a 16 m span (it is a displacement, not a path length).
 *
 * Coordinates are the pack's projected metres (core/geo/Projection, the same as RouteLeg.geometry).
 * Fixes that are not trigger-grade (accuracy > 40 m, FixFilter) never move progress, fire a cue or change the
 * off-route state. Progress never goes backwards. Pure: no platform imports.
 */
import { RouteLeg, RouteStep } from '../../contracts/Model';
import { pointToSegment, SegmentHit } from '../geo/GeoMath';
import { StepCue, stepCueKind } from './Guidance';

/** Every number the turn-by-turn and off-route logic depends on (logged in TOUR_CONFIG). */
export class NavConfig {
  /** Leg 0 / after a re-plan: snap onto a leg polyline once within this distance (§4.6). */
  snapRadiusM: number = 30;
  /** "In 30 metres, ..." (§4.6). */
  prepareM: number = 30;
  /** "Now turn left." (§4.6). */
  nowM: number = 8;
  /** A "now" cue still fires this far past the maneuver point (a fix every ~10 m at demo x8), then it is missed. */
  passedSlackM: number = 8;
  /** continue / new name steps are announced only when the segment is longer than this (§4.6). */
  longContinueM: number = 250;
  /** Two turns this close are spoken as one cue: "Now turn left, then turn right." */
  coalesceM: number = 25;
  /** A folded follow-up turn closer than this (a jog) gets no "now" cue of its own. */
  jogM: number = 10;
  /** Progress search window ahead of the last position. */
  searchAheadM: number = 120;
  /** Off-route threshold: max(offRouteMinM, offRouteBaseM + min(accuracy, offRouteAccCapM)) (§4.7). */
  offRouteMinM: number = 35;
  offRouteBaseM: number = 20;
  offRouteAccCapM: number = 30;
  /** ... held for 12 s (§4.7) ... */
  offRouteHoldMs: number = 12000;
  /** ... or 12 s of walking at 1.3 m/s away from the first off-route fix (demo x4/x8 wall-clock stamps) ... */
  offRouteHoldSpanM: number = 16;
  /** ... and at least this many trigger-grade fixes (§4.7). */
  offRouteMinFixes: number = 3;
  /** Back on the route below this cross-track distance ... */
  backOnRouteM: number = 20;
  /** ... for this many fixes (§4.7). */
  backOnRouteFixes: number = 2;
  /** The P0 off-route line is spoken at most once per this interval (§4.7). */
  offRouteCueIntervalMs: number = 60000;

  toLogKv(): string {
    return `nav=snap${this.snapRadiusM}/prep${this.prepareM}/now${this.nowM}/cont${this.longContinueM} ` +
      `offRoute=max(${this.offRouteMinM},${this.offRouteBaseM}+acc<=${this.offRouteAccCapM})/` +
      `${this.offRouteHoldMs}ms|${this.offRouteHoldSpanM}m/${this.offRouteMinFixes}fixes ` +
      `back=<${this.backOnRouteM}x${this.backOnRouteFixes}`;
  }
}

export enum CueKind { PREPARE = 'prepare', NOW = 'now', CONTINUE = 'continue' }

/** One cue to speak. `thenStepIdx` >= 0: a second maneuver within coalesceM is folded into this cue. */
export class NavCue {
  kind: CueKind;
  stepIdx: number;
  distM: number;
  thenStepIdx: number;

  constructor(kind: CueKind, stepIdx: number, distM: number, thenStepIdx: number) {
    this.kind = kind;
    this.stepIdx = stepIdx;
    this.distM = distM;
    this.thenStepIdx = thenStepIdx;
  }
}

export enum OffRouteChange { NONE = 'none', ENTERED = 'entered', CLEARED = 'cleared' }

/** Result of one update. */
export class LegUpdate {
  used: boolean = false;            // the fix was trigger-grade and the tracker looked at it
  snappedNow: boolean = false;      // this fix snapped the walker onto the leg
  cues: NavCue[] = [];
  passedSteps: number[] = [];       // announced steps left behind with this fix (their waiting cues are stale)
  offRoute: OffRouteChange = OffRouteChange.NONE;
}

/** Closest point of a polyline. */
export class PolyHit {
  segIdx: number = -1;
  alongM: number = 0;
  distM: number = Number.POSITIVE_INFINITY;
}

export class LegTracker {
  readonly leg: RouteLeg;
  readonly cfg: NavConfig;
  /** Leg key for logs and dedupe: `${from}>${to}`. */
  readonly key: string;
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly cum: number[] = [];
  /** Along-distance of each step's maneuver point. */
  readonly stepAlongM: number[] = [];
  readonly stepCue: StepCue[] = [];
  private readonly firedPrepare: boolean[] = [];
  private readonly firedNow: boolean[] = [];

  snapped: boolean = false;
  alongM: number = 0;
  crossTrackM: number = Number.NaN;
  private segIdx: number = 0;

  offRoute: boolean = false;
  private offFixes: number = 0;
  private offSinceMs: number = Number.NaN;
  private offX: number = Number.NaN;
  private offY: number = Number.NaN;
  private offSpanM: number = 0;
  private backFixes: number = 0;
  /** Diagnostics of the last ENTERED (for the OFF_ROUTE log line). */
  enteredHeldMs: number = 0;
  enteredSpanM: number = 0;
  enteredFixes: number = 0;
  enteredThresholdM: number = 0;
  offRouteEnteredAtMs: number = Number.NaN;

  constructor(leg: RouteLeg, cfg: NavConfig) {
    this.leg = leg;
    this.cfg = cfg;
    this.key = `${leg.fromPoiId}>${leg.toPoiId}`;
    const g: number[] = leg.geometry;
    for (let i = 0; i + 1 < g.length; i += 2) {
      const x: number = g[i];
      const y: number = g[i + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        continue;
      }
      this.cum.push(this.xs.length === 0 ? 0 :
        this.cum[this.cum.length - 1] + Math.hypot(x - this.xs[this.xs.length - 1], y - this.ys[this.ys.length - 1]));
      this.xs.push(x);
      this.ys.push(y);
    }
    for (const s of leg.steps) {
      this.stepAlongM.push(this.alongOfStep(s));
      this.stepCue.push(stepCueKind(s, cfg.longContinueM));
      this.firedPrepare.push(false);
      this.firedNow.push(false);
    }
  }

  /** At least one segment. */
  usable(): boolean {
    return this.xs.length >= 2;
  }

  lengthM(): number {
    return this.cum.length > 0 ? this.cum[this.cum.length - 1] : 0;
  }

  /** Distance from (x, y) to the whole polyline (snap test for leg 0 candidates). */
  distanceTo(x: number, y: number): number {
    return this.closest(x, y, 0, this.xs.length - 2).distM;
  }

  /** Closest point of the whole polyline to (x, y) (along-distance and distance). */
  project(x: number, y: number): PolyHit {
    return this.closest(x, y, 0, this.xs.length - 2);
  }

  /** Off-route threshold for a fix of this accuracy (§4.7). */
  offRouteThresholdM(accuracyM: number): number {
    const acc: number = Number.isFinite(accuracyM) ? Math.max(0, Math.min(accuracyM, this.cfg.offRouteAccCapM)) :
      this.cfg.offRouteAccCapM;
    return Math.max(this.cfg.offRouteMinM, this.cfg.offRouteBaseM + acc);
  }

  /** Index of the next announced step ahead of the walker (-1 if none). */
  nextAnnouncedStep(): number {
    for (let k = 0; k < this.leg.steps.length; k++) {
      if (this.stepCue[k] !== StepCue.NONE && this.stepAlongM[k] >= this.alongM - this.cfg.passedSlackM &&
        !this.firedNow[k]) {
        return k;
      }
    }
    return -1;
  }

  /** Metres from the walker to step k's maneuver point along the leg. */
  distToStepM(k: number): number {
    return this.stepAlongM[k] - this.alongM;
  }

  /** Metres left to the end of the leg. */
  remainingM(): number {
    return Math.max(0, this.lengthM() - this.alongM);
  }

  /** Feeds one fix (projected metres). Only trigger-grade fixes count (see header). */
  update(x: number, y: number, accuracyM: number, tMs: number, triggerGrade: boolean): LegUpdate {
    const out: LegUpdate = new LegUpdate();
    if (!triggerGrade || !this.usable() || !Number.isFinite(x) || !Number.isFinite(y)) {
      return out;
    }
    out.used = true;
    const all: PolyHit = this.closest(x, y, 0, this.xs.length - 2);
    this.crossTrackM = all.distM;
    if (!this.snapped) {
      if (all.distM > this.cfg.snapRadiusM) {
        return out;
      }
      this.snapped = true;
      out.snappedNow = true;
      this.moveTo(all);
      // Steps already behind, and the "prepare" of a turn the walker is already inside of, stay silent.
      for (let k = 0; k < this.stepAlongM.length; k++) {
        const d: number = this.stepAlongM[k] - this.alongM;
        if (d < -this.cfg.passedSlackM) {
          this.firedPrepare[k] = true;
          this.firedNow[k] = true;
        } else if (d <= this.cfg.prepareM) {
          this.firedPrepare[k] = true;
        }
      }
      return out;
    }

    this.updateOffRoute(out, x, y, accuracyM, tMs, all);
    if (this.offRoute) {
      return out;                       // no progress and no cues while off the route
    }
    // Progress: monotonic windowed search, a forward jump only onto the polyline (re-joined further ahead).
    const win: PolyHit = this.closest(x, y, Math.max(0, this.segIdx - 1), this.segAhead(this.cfg.searchAheadM));
    if (win.distM <= Math.max(this.cfg.snapRadiusM, all.distM + 10)) {
      if (win.alongM > this.alongM) {
        this.moveTo(win);
      }
    } else if (all.distM <= this.cfg.snapRadiusM && all.alongM > this.alongM) {
      this.moveTo(all);
    }
    this.collectCues(out);
    return out;
  }

  private updateOffRoute(out: LegUpdate, x: number, y: number, accuracyM: number, tMs: number, all: PolyHit): void {
    const thr: number = this.offRouteThresholdM(accuracyM);
    if (!this.offRoute) {
      if (all.distM > thr) {
        if (this.offFixes === 0) {
          this.offSinceMs = tMs;
          this.offX = x;
          this.offY = y;
          this.offSpanM = 0;
        } else {
          this.offSpanM = Math.max(this.offSpanM, Math.hypot(x - this.offX, y - this.offY));
        }
        this.offFixes++;
        const held: number = tMs - this.offSinceMs;
        if (this.offFixes >= this.cfg.offRouteMinFixes &&
          (held >= this.cfg.offRouteHoldMs || this.offSpanM >= this.cfg.offRouteHoldSpanM)) {
          this.offRoute = true;
          this.backFixes = 0;
          this.enteredHeldMs = held;
          this.enteredSpanM = this.offSpanM;
          this.enteredFixes = this.offFixes;
          this.enteredThresholdM = thr;
          this.offRouteEnteredAtMs = tMs;
          out.offRoute = OffRouteChange.ENTERED;
        }
      } else {
        this.offFixes = 0;
        this.offSpanM = 0;
        this.offSinceMs = Number.NaN;
      }
      return;
    }
    if (all.distM < this.cfg.backOnRouteM) {
      this.backFixes++;
      if (this.backFixes >= this.cfg.backOnRouteFixes) {
        this.offRoute = false;
        this.offFixes = 0;
        this.offSpanM = 0;
        this.offSinceMs = Number.NaN;
        out.offRoute = OffRouteChange.CLEARED;
        if (all.alongM > this.alongM) {
          this.moveTo(all);              // re-joined further ahead: steps skipped meanwhile stay silent
        }
        for (let k = 0; k < this.stepAlongM.length; k++) {
          if (this.stepAlongM[k] < this.alongM - this.cfg.passedSlackM) {
            this.firedPrepare[k] = true;
            this.firedNow[k] = true;
          }
        }
      }
    } else {
      this.backFixes = 0;
    }
  }

  private collectCues(out: LegUpdate): void {
    for (let k = 0; k < this.leg.steps.length; k++) {
      const cue: StepCue = this.stepCue[k];
      if (cue === StepCue.NONE || this.firedNow[k]) {
        continue;
      }
      const d: number = this.stepAlongM[k] - this.alongM;
      if (d < -this.cfg.passedSlackM) {      // missed (a jump past it): silent, waiting cues are stale
        this.firedPrepare[k] = true;
        this.firedNow[k] = true;
        out.passedSteps.push(k);
        continue;
      }
      if (d > this.cfg.prepareM) {
        break;                                // the nearest announced step is still far: nothing yet
      }
      if (cue === StepCue.CONTINUE) {
        if (d <= this.cfg.nowM) {
          this.firedPrepare[k] = true;
          this.firedNow[k] = true;
          out.cues.push(new NavCue(CueKind.CONTINUE, k, d, -1));
        }
        break;
      }
      if (d <= this.cfg.nowM) {
        const then: number = this.followUp(k);
        this.firedPrepare[k] = true;
        this.firedNow[k] = true;
        if (then >= 0) {
          this.firedPrepare[then] = true;     // already announced as "..., then turn right"
          if (this.stepAlongM[then] - this.stepAlongM[k] <= this.cfg.jogM) {
            this.firedNow[then] = true;       // a jog: one cue covers both turns
          }
        }
        out.cues.push(new NavCue(CueKind.NOW, k, d, then));
        continue;                             // a follow-up turn may already be due as well
      }
      if (!this.firedPrepare[k]) {
        const then: number = this.followUp(k);
        this.firedPrepare[k] = true;
        out.cues.push(new NavCue(CueKind.PREPARE, k, d, then));
      }
      break;
    }
  }

  /** The next announced TURN step within coalesceM after step k, or -1. */
  private followUp(k: number): number {
    for (let j = k + 1; j < this.leg.steps.length; j++) {
      if (this.stepAlongM[j] - this.stepAlongM[k] > this.cfg.coalesceM) {
        return -1;
      }
      if (this.stepCue[j] === StepCue.TURN) {
        return j;
      }
    }
    return -1;
  }

  private moveTo(h: PolyHit): void {
    this.alongM = h.alongM;
    this.segIdx = h.segIdx;
  }

  /** Last segment index within `aheadM` of the current position. */
  private segAhead(aheadM: number): number {
    let j: number = this.segIdx;
    while (j < this.xs.length - 2 && this.cum[j + 1] < this.alongM + aheadM) {
      j++;
    }
    return j;
  }

  private closest(x: number, y: number, from: number, to: number): PolyHit {
    const best: PolyHit = new PolyHit();
    const last: number = Math.min(to, this.xs.length - 2);
    for (let i = Math.max(0, from); i <= last; i++) {
      const h: SegmentHit = pointToSegment(x, y, this.xs[i], this.ys[i], this.xs[i + 1], this.ys[i + 1]);
      if (h.distM < best.distM) {
        best.distM = h.distM;
        best.segIdx = i;
        best.alongM = this.cum[i] + h.t * (this.cum[i + 1] - this.cum[i]);
      }
    }
    return best;
  }

  private alongOfStep(s: RouteStep): number {
    const n: number = this.xs.length;
    if (n === 0) {
      return 0;
    }
    if (s.geomIndex >= 0 && s.geomIndex < n && this.leg.geometry.length === n * 2) {
      return this.cum[s.geomIndex];
    }
    // geometry had dropped points or the index is out of range: project the maneuver point instead
    return this.closest(s.x, s.y, 0, n - 2).alongM;
  }
}
