/*
 * The watch's haptic cue language (docs/research/WATCH.md §5, user-approved set of four):
 *   ARRIVAL    one long buzz (600 ms)                 entering a stop; also used at the end of the tour
 *   LOOK_LEFT  2 short pulses (80 ms)                 after ARRIVAL when the stop is on the walker's left
 *   LOOK_RIGHT 3 short pulses (80 ms)                 after ARRIVAL when the stop is on the walker's right
 *   OFF_ROUTE  2 long buzzes (300 ms)                 the engine's off-route warning
 * Left and right differ by count, so they can be told apart without looking. The engine's APPROACH haptic is not
 * mapped (no buzz while merely getting close: too many buzzes and users stop noticing them).
 * CueGate rate-limits cues so they never stack: any cue at most once per ANY_CUE_GAP_MS, and the same non-arrival
 * cue at most once per SAME_CUE_GAP_MS (arrivals are always distinct stops; an arrival's look cue is part of the same
 * sequence, not a second cue).
 * Pure: no platform imports (unit-tested in entry/src/test/CueMap.test.ets).
 */
import { HapticKind, RelDir } from '../../contracts/EngineTypes';

export enum Cue {
  ARRIVAL = 'arrival', LOOK_LEFT = 'lookLeft', LOOK_RIGHT = 'lookRight', OFF_ROUTE = 'offRoute'
}

/** Alternating on/off durations in ms, starting with "on". */
export type CuePattern = number[];

export const PULSE_SHORT_MS: number = 80;
export const PULSE_LONG_MS: number = 300;
export const ARRIVAL_MS: number = 600;
export const PULSE_GAP_MS: number = 120;
export const LONG_GAP_MS: number = 200;
/** Pause between the arrival buzz and the look cue of the same arrival. */
export const SEQUENCE_GAP_MS: number = 700;
export const SAME_CUE_GAP_MS: number = 10000;
export const ANY_CUE_GAP_MS: number = 2000;

export function patternFor(cue: Cue): CuePattern {
  switch (cue) {
    case Cue.ARRIVAL:
      return [ARRIVAL_MS];
    case Cue.LOOK_LEFT:
      return [PULSE_SHORT_MS, PULSE_GAP_MS, PULSE_SHORT_MS];
    case Cue.LOOK_RIGHT:
      return [PULSE_SHORT_MS, PULSE_GAP_MS, PULSE_SHORT_MS, PULSE_GAP_MS, PULSE_SHORT_MS];
    case Cue.OFF_ROUTE:
      return [PULSE_LONG_MS, LONG_GAP_MS, PULSE_LONG_MS];
    default:
      return [];
  }
}

/** Total length of a pattern in ms (on + off). */
export function patternMs(p: CuePattern): number {
  let t: number = 0;
  for (const d of p) {
    t += d;
  }
  return t;
}

/** The look cue for a stop's direction relative to the walker; undefined if ahead, behind, here or unknown. */
export function lookCueFor(dir: RelDir | undefined): Cue | undefined {
  if (dir === RelDir.LEFT || dir === RelDir.AHEAD_LEFT || dir === RelDir.BEHIND_LEFT) {
    return Cue.LOOK_LEFT;
  }
  if (dir === RelDir.RIGHT || dir === RelDir.AHEAD_RIGHT || dir === RelDir.BEHIND_RIGHT) {
    return Cue.LOOK_RIGHT;
  }
  return undefined;
}

/** The cue sequence for one engine HAPTIC effect. `dir` = the arriving stop's direction (arrive only). */
export function cuesFor(kind: HapticKind, dir: RelDir | undefined): Cue[] {
  switch (kind) {
    case HapticKind.ARRIVE: {
      const look: Cue | undefined = lookCueFor(dir);
      return look !== undefined ? [Cue.ARRIVAL, look] : [Cue.ARRIVAL];
    }
    case HapticKind.FINISH:
      return [Cue.ARRIVAL];
    case HapticKind.OFF_ROUTE:
      return [Cue.OFF_ROUTE];
    default:
      return [];                         // APPROACH: deliberately silent
  }
}

/** One cue of a sequence with its start offset from the sequence start. */
export class TimedCue {
  readonly cue: Cue;
  readonly atMs: number;
  readonly pattern: CuePattern;

  constructor(cue: Cue, atMs: number) {
    this.cue = cue;
    this.atMs = atMs;
    this.pattern = patternFor(cue);
  }
}

/** Lays out a cue sequence in time: each cue starts SEQUENCE_GAP_MS after the previous one ends. */
export function schedule(cues: Cue[]): TimedCue[] {
  const out: TimedCue[] = [];
  let at: number = 0;
  for (const c of cues) {
    const t: TimedCue = new TimedCue(c, at);
    out.push(t);
    at += patternMs(t.pattern) + SEQUENCE_GAP_MS;
  }
  return out;
}

/** Rate limit for cue sequences (keyed by the sequence's first cue). */
export class CueGate {
  private lastAnyMs: number = Number.NEGATIVE_INFINITY;
  private readonly lastByCue: Map<string, number> = new Map<string, number>();

  /** True if a sequence starting with `first` may play at `nowMs`; records it if so. */
  allow(first: Cue, nowMs: number): boolean {
    if (nowMs - this.lastAnyMs < ANY_CUE_GAP_MS) {
      return false;
    }
    const last: number | undefined = this.lastByCue.get(first);
    // Each arrival is a different stop (the engine fires a stop once), so only stacking limits it.
    if (first !== Cue.ARRIVAL && last !== undefined && nowMs - last < SAME_CUE_GAP_MS) {
      return false;
    }
    this.lastAnyMs = nowMs;
    this.lastByCue.set(first, nowMs);
    return true;
  }
}
