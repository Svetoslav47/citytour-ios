/*
 * "You are here" on the Explore map (MapMode.EXPLORE): which position source feeds the marker, and when the map
 * centres on it. Pure (no system APIs) so it runs in the local unit tests (ExploreMe.test).
 *   - a running tour owns the fix (same snapshots as Now Walking, incl. the Demo walk): src=tour;
 *   - otherwise Location Kit directly, only when the permission is already granted and the switch is on: the page
 *     never opens a system dialog by itself; the locate button asks (src=none until then).
 */

export enum MeSource {
  TOUR = 'tour',
  LOCATION = 'location',
  NONE = 'none'
}

export class MeChoice {
  src: MeSource;
  reason: string;

  constructor(src: MeSource, reason: string) {
    this.src = src;
    this.reason = reason;
  }
}

/** permGranted: precise or approximate-only (approximate fixes still move the dot). */
export function chooseMeSource(tourRunning: boolean, permGranted: boolean, switchOn: boolean): MeChoice {
  if (tourRunning) {
    return new MeChoice(MeSource.TOUR, 'tour_running');
  }
  if (!permGranted) {
    return new MeChoice(MeSource.NONE, 'no_permission');
  }
  if (!switchOn) {
    return new MeChoice(MeSource.NONE, 'switch_off');
  }
  return new MeChoice(MeSource.LOCATION, 'granted');
}

/** (x, y) inside the world box [minX, minY, maxX, maxY]; false for an invalid box or a non-finite point. */
export function insideBounds(b: number[], x: number, y: number): boolean {
  if (b.length !== 4 || !Number.isFinite(x) || !Number.isFinite(y)) {
    return false;
  }
  return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
}

/**
 * The first fix centres the map once, and only when it falls inside the map's bounds: a user far from the city
 * (e.g. the emulator's fixed point) keeps the city view.
 */
export function centreOnFirstFix(alreadyHandled: boolean, b: number[], x: number, y: number): boolean {
  return !alreadyHandled && insideBounds(b, x, y);
}

/** The locate button zooms in to at least this scale (px per metre: a few blocks around the dot). */
export const LOCATE_MIN_SCALE: number = 1.2;

export function locateScale(current: number): number {
  return Number.isFinite(current) && current > LOCATE_MIN_SCALE ? current : LOCATE_MIN_SCALE;
}
