// Suite: WalkDisplay.test - module under test: core/map/WalkDisplay (task B5, Person B).
// Distance rounding and throttle rules of DESIGN §3.6 and the Look cue dial geometry of §3.6.1.
import { describe, it, expect } from 'vitest';
import {
  dialAngle, dialDot, dialShouldMove, relDirAngle, normalizeSigned, relativeBearing, RoundedDistance, roundWalkDistance,
  shouldUpdateDistance
} from '../src';

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

function walkDisplayTest() {
  describe('WalkDisplay', () => {
    it('rounds_under_100m_to_10m', () => {
      expect(roundWalkDistance(44).value).toBe(40);
      expect(roundWalkDistance(45).value).toBe(50);
      expect(roundWalkDistance(0).value).toBe(0);
      expect(roundWalkDistance(44).km).toBe(false);
    });
    it('rounds_100_to_1000m_to_20m', () => {
      expect(roundWalkDistance(181).value).toBe(180);
      expect(roundWalkDistance(191).value).toBe(200);
      expect(roundWalkDistance(995).km).toBe(true);
      expect(roundWalkDistance(995).value).toBe(1);
    });
    it('shows_km_with_one_decimal_from_1km', () => {
      const r = roundWalkDistance(1234);
      expect(r.km).toBe(true);
      expect(near(r.value, 1.2)).toBe(true);
      expect(near(roundWalkDistance(2497).value, 2.5)).toBe(true);
    });
    it('bad_input_is_zero_not_nan', () => {
      expect(roundWalkDistance(Number.NaN).value).toBe(0);
      expect(roundWalkDistance(-5).value).toBe(0);
    });
    it('throttles_distance_updates', () => {
      const shown: RoundedDistance = roundWalkDistance(180);
      expect(shouldUpdateDistance(undefined, shown, 0, 0)).toBe(true);
      expect(shouldUpdateDistance(shown, roundWalkDistance(178), 0, 10000)).toBe(false); // same rounded value
      expect(shouldUpdateDistance(shown, roundWalkDistance(160), 1000, 2500)).toBe(false); // < 2 s
      expect(shouldUpdateDistance(shown, roundWalkDistance(160), 1000, 3000)).toBe(true);
    });
    it('normalizes_and_relative_bearing', () => {
      expect(normalizeSigned(190)).toBe(-170);
      expect(normalizeSigned(-190)).toBe(170);
      expect(normalizeSigned(180)).toBe(-180);
      expect(relativeBearing(30, 350)).toBe(40);
      expect(Number.isNaN(relativeBearing(30, Number.NaN))).toBe(true);
    });
    it('dial_dot_positions', () => {
      const ahead = dialDot(0, 36, 36, 30, 20);
      expect(ahead.valid).toBe(true);
      expect(near(ahead.x, 36)).toBe(true);
      expect(near(ahead.y, 6)).toBe(true);
      const right = dialDot(90, 36, 36, 30, 20);
      expect(near(right.x, 66)).toBe(true);
      expect(near(right.y, 36)).toBe(true);
      const left = dialDot(-90, 36, 36, 30, 20);
      expect(near(left.x, 6)).toBe(true);
      const behind = dialDot(150, 36, 36, 30, 20);
      expect(behind.behind).toBe(true);
      expect(near(behind.y, 56)).toBe(true);
      expect(dialDot(Number.NaN, 36, 36, 30, 20).valid).toBe(false);
    });
    it('dial_angle_matches_spoken_bucket_when_slow', () => {
      expect(relDirAngle('left')).toBe(-90);
      expect(relDirAngle('aheadRight')).toBe(45);
      expect(Number.isNaN(relDirAngle('here'))).toBe(true);
      expect(dialAngle(100, 80, 1.3, 'ahead')).toBe(20);         // walking: exact angle
      expect(dialAngle(100, 80, 0.2, 'right')).toBe(90);         // standing: the bucket
      expect(dialAngle(100, Number.NaN, 1.3, 'left')).toBe(-90); // no course: the bucket
    });
    it('dial_moves_only_on_10_degrees', () => {
      expect(dialShouldMove(10, 15)).toBe(false);
      expect(dialShouldMove(10, 20)).toBe(true);
      expect(dialShouldMove(175, -175)).toBe(true);
      expect(dialShouldMove(Number.NaN, 10)).toBe(true);
    });
  });
}

walkDisplayTest();
