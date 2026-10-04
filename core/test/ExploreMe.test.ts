// Suite: ExploreMe.test - module under test: core/map/ExploreMe ("you are here" on the Explore map).
import { describe, it, expect } from 'vitest';
import { centreOnFirstFix, chooseMeSource, insideBounds, LOCATE_MIN_SCALE, locateScale, MeSource } from '../src';

function exploreMeTest() {
  describe('ExploreMe', () => {
    it('a_running_tour_owns_the_fix', () => {
      const c = chooseMeSource(true, false, false);
      expect(c.src).toBe(MeSource.TOUR);
      expect(c.reason).toBe('tour_running');
    });
    it('location_only_with_permission_and_switch', () => {
      expect(chooseMeSource(false, true, true).src).toBe(MeSource.LOCATION);
      const noPerm = chooseMeSource(false, false, true);
      expect(noPerm.src).toBe(MeSource.NONE);
      expect(noPerm.reason).toBe('no_permission');
      const off = chooseMeSource(false, true, false);
      expect(off.src).toBe(MeSource.NONE);
      expect(off.reason).toBe('switch_off');
    });
    it('inside_bounds_checks_box_and_point', () => {
      const b = [-100, -50, 100, 50];
      expect(insideBounds(b, 0, 0)).toBe(true);
      expect(insideBounds(b, 100, 50)).toBe(true);
      expect(insideBounds(b, 101, 0)).toBe(false);
      expect(insideBounds(b, 0, -51)).toBe(false);
      expect(insideBounds([], 0, 0)).toBe(false);
      expect(insideBounds(b, Number.NaN, 0)).toBe(false);
    });
    it('first_fix_centres_once_and_only_inside', () => {
      const b = [0, 0, 1000, 1000];
      expect(centreOnFirstFix(false, b, 500, 500)).toBe(true);
      expect(centreOnFirstFix(true, b, 500, 500)).toBe(false);
      // Far from the city (e.g. the emulator's fixed point): keep the city view.
      expect(centreOnFirstFix(false, b, 900000, -40000)).toBe(false);
    });
    it('locate_zooms_in_but_never_out', () => {
      expect(locateScale(0.2)).toBe(LOCATE_MIN_SCALE);
      expect(locateScale(3)).toBe(3);
      expect(locateScale(Number.NaN)).toBe(LOCATE_MIN_SCALE);
    });
  });
}

exploreMeTest();
