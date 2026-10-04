/*
 * Home-screen "Next stop" card (B14, DESIGN §3.13, ARCHITECTURE §2.8): what the 2×2 Form Kit card shows for an
 * engine snapshot, and when the app pushes a new version (formProvider.updateForm). Updates go out on events only:
 * the card mode or stop changes, the SIMULATED flag changes, pause changes, or the shown distance moves by at least
 * CARD_DISTANCE_STEP_M (DESIGN: "every ~50 m"), and at most once per CARD_MIN_INTERVAL_MS for distance-only changes.
 * Never per GPS fix. Pure: no platform imports; the caller localises the texts.
 */
import { EngineSnapshot, StopProgress, StopStatus, TourPhase } from '../../contracts/EngineTypes';
import { FixSource } from '../../contracts/Ports';
import { roundWalkDistance } from '../map/WalkDisplay';

export enum CardMode { IDLE = 'idle', HEADING = 'heading', AT_STOP = 'atStop', COMPLETE = 'complete', ENDED = 'ended' }

/** Distance change that justifies a distance-only push. */
export const CARD_DISTANCE_STEP_M: number = 50;
/** Minimum time between two distance-only pushes. */
export const CARD_MIN_INTERVAL_MS: number = 10000;

export class CardState {
  mode: CardMode = CardMode.IDLE;
  tourId: string = '';
  poiId: string = '';           // next stop (HEADING) or current stop (AT_STOP); '' otherwise
  stopNumber: number = 0;       // 1-based
  totalStops: number = 0;
  visited: number = 0;
  distanceM: number = Number.NaN;   // rounded like Now Walking's hero distance; NaN when not heading
  demo: boolean = false;        // SIMULATED Demo walk
  paused: boolean = false;

  /** Same card content (distance compared exactly). */
  sameAs(o: CardState): boolean {
    return this.mode === o.mode && this.tourId === o.tourId && this.poiId === o.poiId &&
      this.stopNumber === o.stopNumber && this.totalStops === o.totalStops && this.visited === o.visited &&
      this.demo === o.demo && this.paused === o.paused && sameNum(this.distanceM, o.distanceM);
  }
}

function sameNum(a: number, b: number): boolean {
  return (Number.isNaN(a) && Number.isNaN(b)) || a === b;
}

function isHeard(s: StopStatus): boolean {
  return s === StopStatus.VISITED || s === StopStatus.TEASER_ONLY;
}

export function cardStateFor(s: EngineSnapshot | undefined): CardState {
  const c = new CardState();
  if (s === undefined) {
    return c;
  }
  const p = s.phase;
  c.tourId = s.tourId;
  c.totalStops = s.stops.length;
  c.visited = s.stops.filter((x: StopProgress) => isHeard(x.status)).length;
  c.demo = s.source === FixSource.DEMO;
  c.paused = s.paused;
  if (p === TourPhase.FINISHED) {
    c.mode = CardMode.COMPLETE;
    return c;
  }
  if (p === TourPhase.ABORTED) {
    c.mode = CardMode.ENDED;
    return c;
  }
  if (p !== TourPhase.WALKING && p !== TourPhase.APPROACHING && p !== TourPhase.AT_STOP) {
    const idle = new CardState();
    idle.tourId = s.tourId;
    return idle;
  }
  c.stopNumber = Math.min(s.stops.length, Math.max(0, s.currentStopIdx) + 1);
  if (p === TourPhase.AT_STOP) {
    c.mode = CardMode.AT_STOP;
    const cur = s.currentStopIdx >= 0 && s.currentStopIdx < s.stops.length ? s.stops[s.currentStopIdx] : undefined;
    c.poiId = cur !== undefined ? cur.poiId : '';
    return c;
  }
  c.mode = CardMode.HEADING;
  if (s.next !== undefined) {
    c.poiId = s.next.poiId;
    const r = roundWalkDistance(s.next.distanceM);
    c.distanceM = r.km ? r.value * 1000 : r.value;
  }
  return c;
}

/** Push the new card? `prev` = last pushed state (undefined = nothing pushed yet). */
export function shouldPushCard(prev: CardState | undefined, next: CardState, lastPushMs: number,
  nowMs: number): boolean {
  if (prev === undefined) {
    return true;
  }
  if (prev.sameAs(next)) {
    return false;
  }
  const structural = prev.mode !== next.mode || prev.tourId !== next.tourId || prev.poiId !== next.poiId ||
    prev.stopNumber !== next.stopNumber || prev.totalStops !== next.totalStops || prev.visited !== next.visited ||
    prev.demo !== next.demo || prev.paused !== next.paused;
  if (structural) {
    return true;
  }
  // Distance only.
  if (Number.isNaN(prev.distanceM) !== Number.isNaN(next.distanceM)) {
    return true;
  }
  return Math.abs(prev.distanceM - next.distanceM) >= CARD_DISTANCE_STEP_M && nowMs - lastPushMs >= CARD_MIN_INTERVAL_MS;
}
