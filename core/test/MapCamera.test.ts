// Suite: MapCamera.test - module under test: core/map/Camera (task B6, Person B).
// North-up camera of ARCHITECTURE §3.2: world <-> screen, fit, pan, zoom about a point, culling, hit test.
import { describe, it, expect } from 'vitest';
import {
  boundsOf, Camera, clampScale, fitBounds, hitTest, intersects, mapOpenBounds, pan, S_MAX, S_MIN, screenToWorld, viewport,
  worldToScreen, zoomAt
} from '../src';

function near(a: number, b: number, eps: number = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

function mapCameraTest() {
  describe('MapCamera', () => {
    it('world_to_screen_is_north_up', () => {
      const cam = new Camera(100, 200, 2);
      const c = worldToScreen(cam, 100, 200, 400, 300);
      expect(near(c.x, 200) && near(c.y, 150)).toBe(true);       // centre maps to the middle
      const north = worldToScreen(cam, 100, 210, 400, 300);
      expect(near(north.y, 130)).toBe(true);                       // +10 m north = 20 px up
      const east = worldToScreen(cam, 110, 200, 400, 300);
      expect(near(east.x, 220)).toBe(true);
    });
    it('screen_to_world_inverts', () => {
      const cam = new Camera(-35.5, 812.25, 3.3);
      const s = worldToScreen(cam, 12.5, -40, 390, 320);
      const w = screenToWorld(cam, s.x, s.y, 390, 320);
      expect(near(w.x, 12.5) && near(w.y, -40)).toBe(true);
    });
    it('map_open_bounds_follow_the_course_map', () => {
      const fallback: number[] = [-541.7, -987.4, 744.7, 671.2];
      const kazimierz: number[] = [-541.7, -1540.3, 1173.4, -434.6];
      expect(mapOpenBounds(kazimierz, fallback).join(',')).toBe(kazimierz.join(','));
      expect(mapOpenBounds(undefined, fallback).join(',')).toBe(fallback.join(','));
      expect(mapOpenBounds([1, 2, 3], fallback).join(',')).toBe(fallback.join(','));
      expect(mapOpenBounds([10, 0, 5, 20], fallback).join(',')).toBe(fallback.join(','));     // empty box
      expect(mapOpenBounds([0, 0, Number.NaN, 5], fallback).join(',')).toBe(fallback.join(','));
    });
    it('scale_is_clamped', () => {
      expect(clampScale(100)).toBe(S_MAX);
      expect(clampScale(0.001)).toBe(S_MIN);
      expect(clampScale(Number.NaN)).toBe(1);
    });
    it('fit_bounds_contains_the_box', () => {
      const cam = fitBounds([-100, -200, 300, 600], 400, 400, 20);
      const a = worldToScreen(cam, -100, 600, 400, 400);
      const b = worldToScreen(cam, 300, -200, 400, 400);
      expect(a.x >= 19.99 && a.y >= 19.99 && b.x <= 380.01 && b.y <= 380.01).toBe(true);
      expect(near(cam.s, 0.45)).toBe(true);                        // 360 / 800 m
    });
    it('fit_bounds_respects_insets', () => {
      const cam = fitBounds([0, 0, 100, 100], 300, 400, 10, 60, 40);
      const top = worldToScreen(cam, 50, 100, 300, 400);
      const bottom = worldToScreen(cam, 50, 0, 300, 400);
      expect(top.y >= 69.99).toBe(true);                           // below pad + topInset
      expect(bottom.y <= 350.01).toBe(true);                       // above pad + bottomInset
    });
    it('pan_follows_the_finger', () => {
      const cam = new Camera(0, 0, 2);
      const before = worldToScreen(cam, 50, 50, 300, 300);
      const moved = pan(cam, 30, -10);
      const after = worldToScreen(moved, 50, 50, 300, 300);
      expect(near(after.x - before.x, 30) && near(after.y - before.y, -10)).toBe(true);
    });
    it('zoom_keeps_the_focus_point_fixed', () => {
      const cam = new Camera(10, 20, 1);
      const z = zoomAt(cam, 2, 80, 60, 300, 200);
      const w1 = screenToWorld(cam, 80, 60, 300, 200);
      const w2 = screenToWorld(z, 80, 60, 300, 200);
      expect(near(z.s, 2) && near(w1.x, w2.x) && near(w1.y, w2.y)).toBe(true);
    });
    it('viewport_and_culling', () => {
      const vp = viewport(new Camera(0, 0, 1), 200, 100);
      expect(vp.join(',')).toBe('-100,-50,100,50');
      expect(intersects(vp, [90, 40, 120, 60])).toBe(true);
      expect(intersects(vp, [101, 0, 120, 10])).toBe(false);
    });
    it('bounds_of_flat_arrays', () => {
      expect((boundsOf([[1, 2, 5, -3], [0, 9]]) as number[]).join(',')).toBe('0,-3,5,9');
      expect(boundsOf([[]]) === undefined).toBe(true);
    });
    it('hit_test_finds_nearest_within_radius', () => {
      const cam = new Camera(0, 0, 1);
      const pts = [0, 0, 30, 0, 100, 100];
      expect(hitTest(cam, 160, 100, 300, 200, pts, 24)).toBe(0);    // (150,100) is world (0,0)
      expect(hitTest(cam, 178, 100, 300, 200, pts, 24)).toBe(1);
      expect(hitTest(cam, 10, 10, 300, 200, pts, 24)).toBe(-1);
    });
  });
}

mapCameraTest();
