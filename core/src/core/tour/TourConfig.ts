/*
 * Tunable constants of the tour engine (task A3). Logged once at START_TOUR (`TOUR_CONFIG k=v ...`).
 * Sources: docs/ARCHITECTURE.md §4.1 (approach exit: approachR * 1.3 for 20 s), §4.3 (trigger table; the linger
 * window after the teaser, issue #60), §4.4 (queue expiry, text-only reading timer), §9 rows 5/6/11 (GPS lost,
 * poor-accuracy log rate, 3 consecutive TTS errors => text only), DESIGN §5.4 (distance rounding, walking speed
 * for minutes).
 * The fix-quality thresholds are owned by core/geo/FixFilter (A1) and re-exported here so the engine has
 * one place that lists every number it depends on.
 * Pure: no platform imports.
 */
import { MAX_TRIGGER_ACCURACY_M, NETWORK_MAX_TRIGGER_ACCURACY_M, SPEED_WINDOW } from '../geo/FixFilter';

export { MAX_TRIGGER_ACCURACY_M, NETWORK_MAX_TRIGGER_ACCURACY_M, SPEED_WINDOW };

export class TourConfig {
  // ---- Triggers (§4.3) ----
  /** Arrival geofence when neither the tour stop nor the POI sets one. */
  defaultTriggerRadiusM: number = 35;
  /**
   * Settings "Start the story when I'm within" (B9): every stop's arrival radius is multiplied by this (20 m -> 0.57,
   * 35 m -> 1, 50 m -> 1.43; the curated radii are tuned for 35 m). 1 = the curated radii unchanged.
   */
  triggerRadiusScale: number = 1;
  /** "Coming up" cue radius. */
  approachRadiusM: number = 110;
  /** Approaching -> Walking when farther than approachR * 1.3 ... */
  approachExitFactor: number = 1.3;
  /** ... for at least this long (passed by / detour). */
  approachExitHoldMs: number = 20000;
  /** Exit hysteresis: exit radius = triggerR * 1.6. */
  exitFactor: number = 1.6;
  /** Fixes worse than this never cause arrival or exit (same value FixFilter enforces). */
  maxTriggerAccuracyM: number = MAX_TRIGGER_ACCURACY_M;
  /** NETWORK provider fixes are trigger-grade only up to this accuracy (FixFilter). */
  networkMaxTriggerAccuracyM: number = NETWORK_MAX_TRIGGER_ACCURACY_M;
  /** Accuracy allowance cap: dEnter = max(0, d - min(acc, 15)), dExit = d + min(acc, 15). */
  accuracyAllowanceCapM: number = 15;
  /** Enter after this many consecutive inside fixes ... */
  enterConfirmFixes: number = 2;
  /** ... spanning at least this long ... */
  enterConfirmMinSpanMs: number = 1500;
  /** ... or after one fix with dEnter <= 0.5 * triggerR. */
  enterImmediateFraction: number = 0.5;
  /** Exit after this many consecutive fixes beyond the exit radius. */
  exitConfirmFixes: number = 3;
  /** Below this median speed the user is "stopped / lingering". */
  slowSpeedMps: number = 0.6;
  /** Slow time inside the trigger radius that proves the user has stopped (full story). */
  fullStoryDwellS: number = 8;
  /** Speed median window (FixFilter's window). */
  speedWindow: number = SPEED_WINDOW;
  /*
   * Linger window after the teaser (issue #60). While the user is moving but still getting closer to the stop, the
   * teaser/full decision waits (silence, no sentence is cut): the geofence is entered up to R + 15 m out, i.e.
   * ~25-50 s before a walker reaches the stop, and the teaser is shorter than that.
   */
  /** Full story once the speed median has stayed below slowSpeedMps this long (DESIGN §5.3 S1-more: >= 4 s). */
  lingerStillS: number = 4;
  /** Teaser only once the user is moving and this far beyond their closest point (above standing GPS jitter). */
  lingerRecedeM: number = 15;
  /** Teaser only when the user is moving and has got no closer to the stop for this long (DESIGN S1-more: 20 s). */
  lingerWindowS: number = 20;
  /** Safety bound: never wait longer than this after the teaser. */
  lingerMaxS: number = 90;
  /** A gap between two inside fixes longer than this does not count as dwell (signal gaps). */
  maxDwellGapMs: number = 5000;

  // ---- Distances and ETA in phrases (DESIGN §5.4) ----
  walkSpeedMps: number = 1.3;

  // ---- Announcement queue (§4.4) ----
  expiryP0Ms: number = 30000;
  expiryP1Ms: number = 20000;
  expiryP3Ms: number = 30000;
  expiryP4Ms: number = 60000;
  /** Text-only mode: each sentence stays max(2.5 s, words / 2.6 words per second). */
  textMinSentenceMs: number = 2500;
  textWordsPerS: number = 2.6;

  // ---- Errors (§9) ----
  /** LOC_POOR is logged at most once per this interval. */
  poorLogIntervalMs: number = 30000;
  /** This many consecutive UTTERANCE_FAILED switch the tour to text only. */
  maxConsecutiveTtsErrors: number = 3;

  /** One log line with every tunable, for `TOUR_CONFIG` at the start of a tour. */
  toLogKv(): string {
    return `trigR=${this.defaultTriggerRadiusM} trigScale=${this.triggerRadiusScale} approachR=${this.approachRadiusM} ` +
      `approachExit=${this.approachExitFactor}x/${this.approachExitHoldMs}ms exitFactor=${this.exitFactor} ` +
      `maxAcc=${this.maxTriggerAccuracyM} netMaxAcc=${this.networkMaxTriggerAccuracyM} ` +
      `accCap=${this.accuracyAllowanceCapM} enter=${this.enterConfirmFixes}/${this.enterConfirmMinSpanMs}ms ` +
      `enterNow=${this.enterImmediateFraction} exit=${this.exitConfirmFixes} slow=${this.slowSpeedMps} ` +
      `dwell=${this.fullStoryDwellS}s linger=still${this.lingerStillS}s/recede${this.lingerRecedeM}m/` +
      `noCloser${this.lingerWindowS}s/max${this.lingerMaxS}s speedWin=${this.speedWindow} walk=${this.walkSpeedMps}`;
  }
}

/** Fresh defaults (each tour gets its own instance, so a test can tune one without touching others). */
export function defaultTourConfig(): TourConfig {
  return new TourConfig();
}
