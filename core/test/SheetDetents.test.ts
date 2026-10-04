// Suite: SheetDetents.test - module under test: core/map/SheetDetents (Now Walking half-collapsible sheet, §3.6.3).
// Detent resolution from drag offset and fling velocity, rubber band, peek height with the safe area, map inset.
import { describe, it, expect } from 'vitest';
import {
  collapseProgress, detentOffset, dragOffset, expandedHeight, FLING_VPS, mapBottomInset, mapBoxHeight, PEEK_CONTENT_H, peekHeight,
  resolveDetent, RUBBER, SHEET_OVERLAP, SheetDetent, sheetTravel, toggleDetent, visibleSheetHeight
} from '../src';

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

function sheetDetentsTest() {
  describe('SheetDetents', () => {
    it('peek_height_clears_the_gesture_bar', () => {
      expect(peekHeight(0)).toBe(PEEK_CONTENT_H);
      expect(peekHeight(28)).toBe(PEEK_CONTENT_H + 28);
      expect(peekHeight(Number.NaN)).toBe(PEEK_CONTENT_H);
      expect(peekHeight(-5)).toBe(PEEK_CONTENT_H);
    });
    it('travel_and_detent_offsets', () => {
      expect(sheetTravel(500, 190)).toBe(310);
      expect(sheetTravel(100, 190)).toBe(0);   // never negative
      expect(detentOffset(SheetDetent.EXPANDED, 310)).toBe(0);
      expect(detentOffset(SheetDetent.COLLAPSED, 310)).toBe(310);
    });
    it('slow_release_picks_the_nearer_detent', () => {
      expect(resolveDetent(100, 0, 300)).toBe(SheetDetent.EXPANDED);
      expect(resolveDetent(200, 0, 300)).toBe(SheetDetent.COLLAPSED);
      expect(resolveDetent(149, FLING_VPS - 1, 300)).toBe(SheetDetent.EXPANDED);
      expect(resolveDetent(151, -(FLING_VPS - 1), 300)).toBe(SheetDetent.COLLAPSED);
    });
    it('fling_wins_over_position', () => {
      expect(resolveDetent(10, FLING_VPS, 300)).toBe(SheetDetent.COLLAPSED);    // short fast flick down
      expect(resolveDetent(290, -FLING_VPS, 300)).toBe(SheetDetent.EXPANDED);   // short fast flick up
      expect(resolveDetent(290, -2000, 300)).toBe(SheetDetent.EXPANDED);
    });
    it('no_travel_or_bad_input_stays_expanded', () => {
      expect(resolveDetent(50, 0, 0)).toBe(SheetDetent.EXPANDED);
      expect(resolveDetent(Number.NaN, Number.NaN, 300)).toBe(SheetDetent.EXPANDED);
    });
    it('drag_follows_finger_with_rubber_band', () => {
      expect(dragOffset(0, 120, 300)).toBe(120);
      expect(dragOffset(300, -50, 300)).toBe(250);
      expect(near(dragOffset(0, -40, 300), -40 * RUBBER)).toBe(true);
      expect(near(dragOffset(300, 40, 300), 300 + 40 * RUBBER)).toBe(true);
    });
    it('toggle_and_progress', () => {
      expect(toggleDetent(SheetDetent.EXPANDED)).toBe(SheetDetent.COLLAPSED);
      expect(toggleDetent(SheetDetent.COLLAPSED)).toBe(SheetDetent.EXPANDED);
      expect(collapseProgress(150, 300)).toBe(0.5);
      expect(collapseProgress(-20, 300)).toBe(0);
      expect(collapseProgress(400, 300)).toBe(1);
      expect(collapseProgress(10, 0)).toBe(0);
    });
    it('map_inset_follows_the_visible_sheet', () => {
      expect(visibleSheetHeight(500, 0)).toBe(500);
      expect(visibleSheetHeight(500, 310)).toBe(190);
      expect(visibleSheetHeight(500, -10)).toBe(500);   // rubber band above expanded
      // page 844, peek 190: map box 678; collapsed only the peek's rounded top covers the map
      const box = mapBoxHeight(844, 190);
      expect(box).toBe(844 - 190 + SHEET_OVERLAP);
      expect(mapBottomInset(visibleSheetHeight(500, 310), 844, box)).toBe(SHEET_OVERLAP);
      expect(mapBottomInset(visibleSheetHeight(500, 0), 844, box)).toBe(500 - 190 + SHEET_OVERLAP);
      expect(mapBottomInset(Number.NaN, 844, box)).toBe(0);
      expect(mapBoxHeight(100, 190)).toBe(0);
    });
    it('expanded_height_matches_the_design_map_box', () => {
      expect(expandedHeight(844, 340, 190)).toBe(844 - 340 + SHEET_OVERLAP);
      expect(expandedHeight(300, 340, 190)).toBe(190);   // never below the peek
    });
  });
}

sheetDetentsTest();
