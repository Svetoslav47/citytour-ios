// Suite: PoiDots.test - module under test: core/map/PoiDots (task B13, Person B).
// Explore layer of the full map: level of detail by story/importance, screen-space thinning, tap hit test.
import { describe, it, expect } from 'vitest';
import { Camera } from '../src';
import { DotCandidate, dotMinScale, hitDot, NAME_ONLY_MIN_S0, NAME_ONLY_MIN_S1, PlacedDot, placeDots } from '../src';

function poiDotsTest() {
  describe('PoiDots', () => {
    it('stories_show_at_every_zoom_name_only_by_importance', () => {
      expect(dotMinScale(0, true)).toBe(0);
      expect(dotMinScale(0, false)).toBe(NAME_ONLY_MIN_S0);
      expect(dotMinScale(1, false)).toBe(NAME_ONLY_MIN_S1);
      expect(dotMinScale(0.8, false) < dotMinScale(0.2, false)).toBe(true);   // important places appear first
      expect(dotMinScale(Number.NaN, false)).toBe(NAME_ONLY_MIN_S0);       // malformed importance
      expect(dotMinScale(5, false)).toBe(NAME_ONLY_MIN_S1);                // clamped
    });
    it('overview_hides_minor_name_only_places', () => {
      const c = [new DotCandidate('story', 0, 0, 0.1, true), new DotCandidate('minor', 100, 0, 0.1, false)];
      const far = placeDots(c, new Camera(0, 0, 0.5), 400, 400);
      expect(far.length).toBe(1);
      expect(far[0].id).toBe('story');
      const near = placeDots(c, new Camera(0, 0, 2), 400, 400);
      expect(near.length).toBe(2);
    });
    it('off_screen_places_are_culled', () => {
      const c = [new DotCandidate('in', 0, 0, 1, true), new DotCandidate('out', 1000, 0, 1, true)];
      const dots = placeDots(c, new Camera(0, 0, 1), 400, 400);
      expect(dots.length).toBe(1);
      expect(dots[0].id).toBe('in');
      expect(dots[0].sx).toBe(200);
      expect(dots[0].sy).toBe(200);
    });
    it('crowded_dots_are_thinned_keeping_the_story', () => {
      // three places 2 m apart at 1 px/m: only one dot survives, the one with a story wins over importance
      const c = [new DotCandidate('a', 0, 0, 0.9, false), new DotCandidate('b', 2, 0, 0.1, true),
        new DotCandidate('c', 4, 0, 0.5, false)];
      const dots = placeDots(c, new Camera(0, 0, 3), 400, 400);
      expect(dots.length).toBe(1);
      expect(dots[0].id).toBe('b');
    });
    it('selected_place_is_kept_and_first', () => {
      // a name-only place below its LOD scale still shows while selected, and wins a clash with a story
      const c = [new DotCandidate('a', 0, 0, 0.9, true), new DotCandidate('sel', 1, 0, 0.0, false),
        new DotCandidate('far', 200, 0, 0.9, true)];
      const dots = placeDots(c, new Camera(0, 0, 0.5), 400, 400, 'sel');
      expect(dots.length).toBe(2);
      expect(dots[0].id).toBe('sel');
      expect(dots[1].id).toBe('far');
    });
    it('max_dots_caps_the_frame', () => {
      const c: DotCandidate[] = [];
      for (let i = 0; i < 50; i++) {
        c.push(new DotCandidate(`p${i}`, i * 20, 0, 0.5, true));
      }
      expect(placeDots(c, new Camera(500, 0, 1), 1200, 400, '', 10, 7).length).toBe(7);
    });
    it('hit_test_picks_the_nearest_within_radius', () => {
      const dots = [new PlacedDot('a', 100, 100, true), new PlacedDot('b', 120, 100, true)];
      expect(hitDot(dots, 112, 100)).toBe('b');
      expect(hitDot(dots, 100, 90)).toBe('a');
      expect(hitDot(dots, 300, 300)).toBe('');
      expect(hitDot([], 0, 0)).toBe('');
    });
  });
}

poiDotsTest();
