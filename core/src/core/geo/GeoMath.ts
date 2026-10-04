/*
 * Pure spherical and planar geometry shared by the engine, the planner and the map (task A1).
 * Sources: docs/ARCHITECTURE.md §4.5 (RelDir table: edges 25/70/120/160, HERE when d < 15 m or the
 * course is unknown) and §4.6 (pointToSegment for leg progress).
 * No platform imports: core/ must run under the local Hypium runner.
 */
import { LatLng } from '../../contracts/Model';
import { RelDir } from '../../contracts/EngineTypes';

/** IUGG mean Earth radius in metres. */
export const EARTH_RADIUS_M: number = 6371008.8;

/** Within this distance of a POI the cue is HERE ("right here"), whatever the course. */
export const HERE_RADIUS_M: number = 15;

/** Upper edges (inclusive, absolute degrees) of the RelDir buckets, ARCHITECTURE §4.5. */
export const REL_AHEAD_MAX_DEG: number = 25;
export const REL_AHEAD_SIDE_MAX_DEG: number = 70;
export const REL_SIDE_MAX_DEG: number = 120;
export const REL_BEHIND_SIDE_MAX_DEG: number = 160;

const DEG_TO_RAD: number = Math.PI / 180;
const RAD_TO_DEG: number = 180 / Math.PI;

export function toRad(deg: number): number {
  return deg * DEG_TO_RAD;
}

export function toDeg(rad: number): number {
  return rad * RAD_TO_DEG;
}

/** Normalises any angle to [0, 360). */
export function normalizeDeg(deg: number): number {
  const r: number = ((deg % 360) + 360) % 360;
  return r === 0 ? 0 : r; // folds -0 to 0
}

/** Normalises any angle to (-180, 180]. */
export function normalizeSignedDeg(deg: number): number {
  const r: number = normalizeDeg(deg);
  return r > 180 ? r - 360 : r;
}

/** Great-circle distance in metres (haversine). */
export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat: number = toRad(bLat - aLat);
  const dLng: number = toRad(bLng - aLng);
  const sLat: number = Math.sin(dLat / 2);
  const sLng: number = Math.sin(dLng / 2);
  const h: number = sLat * sLat + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * sLng * sLng;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function distanceM(a: LatLng, b: LatLng): number {
  return haversineM(a.lat, a.lng, b.lat, b.lng);
}

/** Initial great-circle bearing from a to b, degrees clockwise from north in [0, 360). */
export function bearingDeg(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const p1: number = toRad(aLat);
  const p2: number = toRad(bLat);
  const dl: number = toRad(bLng - aLng);
  const y: number = Math.sin(dl) * Math.cos(p2);
  const x: number = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

export function bearingBetween(a: LatLng, b: LatLng): number {
  return bearingDeg(a.lat, a.lng, b.lat, b.lng);
}

/** Relative angle of a target seen from a heading: normalize(bearing - course) in (-180, 180]; + is right. */
export function relAngleDeg(bearingToTargetDeg: number, courseDeg: number): number {
  return normalizeSignedDeg(bearingToTargetDeg - courseDeg);
}

/** RelDir bucket for a relative angle in degrees (+ = right), ARCHITECTURE §4.5 table. Never HERE. */
export function relDirForAngle(relDeg: number): RelDir {
  const rel: number = normalizeSignedDeg(relDeg);
  const a: number = Math.abs(rel);
  if (a <= REL_AHEAD_MAX_DEG) {
    return RelDir.AHEAD;
  }
  if (a > REL_BEHIND_SIDE_MAX_DEG) {
    return RelDir.BEHIND;
  }
  const right: boolean = rel > 0;
  if (a <= REL_AHEAD_SIDE_MAX_DEG) {
    return right ? RelDir.AHEAD_RIGHT : RelDir.AHEAD_LEFT;
  }
  if (a <= REL_SIDE_MAX_DEG) {
    return right ? RelDir.RIGHT : RelDir.LEFT;
  }
  return right ? RelDir.BEHIND_RIGHT : RelDir.BEHIND_LEFT;
}

/**
 * Where the target is relative to the user. HERE when the target is closer than 15 m or the course
 * is unknown (NaN), otherwise the §4.5 bucket of normalize(bearing - course).
 */
export function relDir(bearingToTargetDeg: number, courseDeg: number, distanceToTargetM: number): RelDir {
  if (!(distanceToTargetM >= HERE_RADIUS_M) || !Number.isFinite(courseDeg) || !Number.isFinite(bearingToTargetDeg)) {
    return RelDir.HERE;
  }
  return relDirForAngle(relAngleDeg(bearingToTargetDeg, courseDeg));
}

/** Closest point on segment AB to P, in projected metres. */
export interface SegmentHit {
  x: number;
  y: number;
  t: number;      // 0..1 along AB (0 for a degenerate segment)
  distM: number;  // |P - closest point|
}

export function pointToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): SegmentHit {
  const dx: number = bx - ax;
  const dy: number = by - ay;
  const len2: number = dx * dx + dy * dy;
  let t: number = 0;
  if (len2 > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const x: number = ax + t * dx;
  const y: number = ay + t * dy;
  const hit: SegmentHit = { x: x, y: y, t: t, distM: Math.hypot(px - x, py - y) };
  return hit;
}
