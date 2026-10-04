/*
 * Tour summary (B11, DESIGN §3.10): what the summary screen shows, from the engine snapshots of one tour.
 *   - TourTimer: fed every snapshot from the start of a tour; records when the tour started and ended and how long
 *     the walker stood at stops (phase AT_STOP), because EngineSnapshot carries no duration.
 *   - buildSummary: the final snapshot + the timer -> stops heard, stops still to see (with the distance from the
 *     last position), walked metres and the total time.
 * Walked: the route length (pack legs) from the first stop to the last stop heard, not EngineSnapshot.walkedM, which
 * also sums the GPS jitter while standing at stops (7.3 km for the 2 km Royal Route demo walk on the emulator).
 * Total time: real GPS = elapsed wall-clock time from start to end. Demo walk (SIMULATED, replayed at up to x8) =
 * "walking-pace time": walked metres at the engine's 1.3 m/s pace plus the real time spent at stops listening, so it
 * reads like the real walk (the screen says "Simulated walk: distances and times come from a recorded route").
 * Pure: no platform imports; the caller passes the clock and the POI positions.
 */
import { AnnouncementKind, EngineSnapshot, StopProgress, StopStatus, TourPhase } from '../../contracts/EngineTypes';
import { FixSource } from '../../contracts/Ports';

/** Walking pace the engine assumes (ARCHITECTURE §6), used for the Demo walk's time. */
export const SUMMARY_WALK_MPS: number = 1.3;

export function isActivePhase(p: TourPhase): boolean {
  return p === TourPhase.WALKING || p === TourPhase.APPROACHING || p === TourPhase.AT_STOP;
}

export function isEndPhase(p: TourPhase): boolean {
  return p === TourPhase.FINISHED || p === TourPhase.ABORTED;
}

/** Start/end/at-stop time of the current (or last) tour. Restarts when a new tour becomes active. */
export class TourTimer {
  startMs: number = Number.NaN;
  endMs: number = Number.NaN;
  atStopMs: number = 0;
  /** POIs whose story (stop/full/deep story, teasers included) was seen playing in a snapshot. */
  storyPois: string[] = [];
  private lastMs: number = Number.NaN;
  private lastAtStop: boolean = false;
  private active: boolean = false;

  /** Feeds one snapshot. Returns true exactly once per tour: on the first snapshot after it ended. */
  feed(s: EngineSnapshot, nowMs: number): boolean {
    const p = s.phase;
    if (isActivePhase(p)) {
      if (!this.active) {
        this.active = true;
        this.startMs = nowMs;
        this.endMs = Number.NaN;
        this.atStopMs = 0;
        this.storyPois = [];
        this.noteStory(s);
        this.lastMs = nowMs;
        this.lastAtStop = p === TourPhase.AT_STOP;
        return false;
      }
      this.accumulate(nowMs);
      this.noteStory(s);
      this.lastAtStop = p === TourPhase.AT_STOP;
      return false;
    }
    if (this.active && isEndPhase(p)) {
      this.accumulate(nowMs);
      this.active = false;
      this.lastAtStop = false;
      this.endMs = nowMs;
      return true;
    }
    if (this.active) {
      // Back to IDLE/PLANNING/READY without an end phase: the tour was dropped, nothing to summarise.
      this.active = false;
      this.startMs = Number.NaN;
    }
    return false;
  }

  isRunning(): boolean {
    return this.active;
  }

  private noteStory(s: EngineSnapshot): void {
    const np = s.nowPlaying;
    if (np === undefined || np.poiId === '' || this.storyPois.indexOf(np.poiId) >= 0) {
      return;
    }
    const k = np.kind;
    if (k === AnnouncementKind.STOP_STORY || k === AnnouncementKind.FULL_STORY || k === AnnouncementKind.DEEP_STORY) {
      this.storyPois.push(np.poiId);
    }
  }

  private accumulate(nowMs: number): void {
    const dt = nowMs - this.lastMs;
    if (this.lastAtStop && Number.isFinite(dt) && dt > 0) {
      this.atStopMs += dt;
    }
    this.lastMs = nowMs;
  }
}

/** Total time in seconds (see the file comment); NaN when unknown. */
export function summaryDurationS(t: TourTimer, walkedM: number, demo: boolean): number {
  if (demo) {
    const walkS = Number.isFinite(walkedM) && walkedM > 0 ? walkedM / SUMMARY_WALK_MPS : 0;
    return walkS + Math.max(0, t.atStopMs) / 1000;
  }
  const d = t.endMs - t.startMs;
  return Number.isFinite(d) && d >= 0 ? d / 1000 : Number.NaN;
}

export class SummaryStop {
  poiId: string;
  order: number;        // 1-based position in the walked order
  status: StopStatus;
  distanceM: number;    // from the last position; NaN when unknown (or for heard stops)

  constructor(poiId: string, order: number, status: StopStatus, distanceM: number) {
    this.poiId = poiId;
    this.order = order;
    this.status = status;
    this.distanceM = distanceM;
  }
}

export class TourSummaryData {
  tourId: string = '';
  complete: boolean = false;     // FINISHED ("Tour complete"); false = ended early ("Tour ended")
  demo: boolean = false;         // the Demo walk (SIMULATED) drove the tour
  heard: SummaryStop[] = [];
  stillToSee: SummaryStop[] = [];
  totalStops: number = 0;
  walkedM: number = 0;
  durationS: number = Number.NaN;
  endedMs: number = Number.NaN;
  plannedOrder: string[] = [];
  shown: boolean = false;        // the summary screen has opened for this tour

  heardCount(): number {
    return this.heard.length;
  }
}

/** A stop counts as heard once its story (or, passing by, its teaser) played. */
export function isHeard(status: StopStatus): boolean {
  return status === StopStatus.VISITED || status === StopStatus.TEASER_ONLY;
}

/**
 * Route metres from the first stop to the last stop heard, leg by leg in walking order: the pack leg length
 * (`legM`, <= 0 = unknown), else the straight line between the two POIs, else the leg is left out.
 */
export function routeWalkedM(stops: StopProgress[], legM: (from: string, to: string) => number,
  pos: (poiId: string) => number[] | undefined): number {
  let last = -1;
  stops.forEach((p: StopProgress, i: number) => {
    if (isHeard(p.status)) {
      last = i;
    }
  });
  let sum = 0;
  for (let i = 1; i <= last; i++) {
    const a = stops[i - 1].poiId;
    const b = stops[i].poiId;
    let d = legM(a, b);
    if (!Number.isFinite(d) || d <= 0) {
      const pa = pos(a);
      const pb = pos(b);
      d = pa !== undefined && pb !== undefined && pa.length >= 2 && pb.length >= 2 ?
        Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) : 0;
    }
    sum += Number.isFinite(d) && d > 0 ? d : 0;
  }
  return sum;
}

/**
 * Summary of the tour that `s` (its final snapshot) ended. `pos` returns a POI's [x, y] or undefined; `legM` the pack
 * route length between two stops (<= 0 = unknown).
 */
export function buildSummary(s: EngineSnapshot, t: TourTimer, pos: (poiId: string) => number[] | undefined,
  legM: (from: string, to: string) => number): TourSummaryData {
  const d = new TourSummaryData();
  d.tourId = s.tourId;
  d.complete = s.phase === TourPhase.FINISHED;
  d.demo = s.source === FixSource.DEMO;
  d.totalStops = s.stops.length;
  d.walkedM = routeWalkedM(s.stops, legM, pos);
  d.durationS = summaryDurationS(t, d.walkedM, d.demo);
  d.endedMs = t.endMs;
  d.plannedOrder = s.plannedOrder.slice();
  const ux = s.user !== undefined ? s.user.x : Number.NaN;
  const uy = s.user !== undefined ? s.user.y : Number.NaN;
  const hasUser = Number.isFinite(ux) && Number.isFinite(uy) && (ux !== 0 || uy !== 0);
  s.stops.forEach((p: StopProgress, i: number) => {
    // The engine marks a stop VISITED on arrival, before its story plays: a tour ended right at that moment did not
    // hear it (the walk to it still counts in walkedM).
    const cutOff = s.phase === TourPhase.ABORTED && i === s.currentStopIdx && t.storyPois.indexOf(p.poiId) < 0;
    if (isHeard(p.status) && !cutOff) {
      d.heard.push(new SummaryStop(p.poiId, i + 1, p.status, Number.NaN));
      return;
    }
    let dist = Number.NaN;
    const xy = pos(p.poiId);
    if (hasUser && xy !== undefined && xy.length >= 2) {
      dist = Math.hypot(xy[0] - ux, xy[1] - uy);
    }
    d.stillToSee.push(new SummaryStop(p.poiId, i + 1, p.status, dist));
  });
  return d;
}
