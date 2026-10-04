// Suite: TourSummary.test - module under test: core/tour/TourSummary (task B11, Tour summary).
// Timer start/end/at-stop accounting across snapshots, real vs Demo walk (walking-pace) total time, heard vs still to
// see with the distance from the last position, complete vs ended early.
import { describe, it, expect } from 'vitest';
import {
  buildSummary, isHeard, routeWalkedM, summaryDurationS, SUMMARY_WALK_MPS, TourSummaryData, TourTimer
} from '../src';
import {
  EngineSnapshot, PlatformStatus, SignalQuality, StopProgress, StopStatus, TourPhase
} from '../src';
import { FixSource } from '../src';
import { VoiceLabel } from '../src';
import { ContentTier, Lang } from '../src';

function platform(): PlatformStatus {
  const p: PlatformStatus = {
    bgRunning: true, avsActive: true, ttsEngine: 'zh-CN/13', sourceKind: FixSource.REAL, realGpsAccuracyM: Number.NaN,
    demoHold: false
  };
  return p;
}

function stop(id: string, order: number, status: StopStatus): StopProgress {
  const p: StopProgress = { poiId: id, order: order, status: status };
  return p;
}

function snap(phase: TourPhase, stops: StopProgress[], source: FixSource): EngineSnapshot {
  const s: EngineSnapshot = {
    phase: phase, tourId: 'royal-route', stops: stops, currentStopIdx: 0,
    user: { x: 100, y: 0, lat: 50.06, lng: 19.93, accuracyM: 5, courseDeg: 0, speedMps: 1.3, source: source },
    signal: SignalQuality.GOOD, offRoute: false, paused: false, speechText: false,
    plannedOrder: stops.map((p: StopProgress) => p.poiId), walkedM: 2600, remainingM: 0, issues: [],
    voiceLabel: VoiceLabel.NATIVE, source: source, platform: platform()
  };
  return s;
}

function positions(id: string): number[] | undefined {
  if (id === 'a') {
    return [0, 0];
  }
  if (id === 'c') {
    return [100, 300];
  }
  return undefined;
}

/** Pack leg a->b is 500 m, b->c unknown (falls back to the straight line); everything else unknown. */
function legs(from: string, to: string): number {
  return from === 'a' && to === 'b' ? 500 : 0;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-6;
}

function tourSummaryTest() {
  describe('TourSummary', () => {
    it('timer_records_start_end_and_time_at_stops', () => {
      const t = new TourTimer();
      expect(t.feed(snap(TourPhase.READY, [], FixSource.REAL), 0)).toBe(false);
      expect(t.feed(snap(TourPhase.WALKING, [], FixSource.REAL), 1000)).toBe(false);
      expect(t.isRunning()).toBe(true);
      t.feed(snap(TourPhase.AT_STOP, [], FixSource.REAL), 61000);   // walked 60 s
      t.feed(snap(TourPhase.AT_STOP, [], FixSource.REAL), 91000);   // +30 s at the stop
      t.feed(snap(TourPhase.WALKING, [], FixSource.REAL), 121000);  // +30 s at the stop
      expect(t.feed(snap(TourPhase.FINISHED, [], FixSource.REAL), 181000)).toBe(true);
      expect(t.startMs).toBe(1000);
      expect(t.endMs).toBe(181000);
      expect(t.atStopMs).toBe(60000);
      expect(t.isRunning()).toBe(false);
      // Further FINISHED snapshots don't end it again.
      expect(t.feed(snap(TourPhase.FINISHED, [], FixSource.REAL), 190000)).toBe(false);
      expect(t.endMs).toBe(181000);
    });
    it('timer_counts_at_stop_time_until_the_end_snapshot', () => {
      const t = new TourTimer();
      t.feed(snap(TourPhase.WALKING, [], FixSource.REAL), 0);
      t.feed(snap(TourPhase.AT_STOP, [], FixSource.REAL), 10000);
      expect(t.feed(snap(TourPhase.ABORTED, [], FixSource.REAL), 25000)).toBe(true);
      expect(t.atStopMs).toBe(15000);
    });
    it('timer_restarts_for_a_new_tour', () => {
      const t = new TourTimer();
      t.feed(snap(TourPhase.AT_STOP, [], FixSource.REAL), 0);
      t.feed(snap(TourPhase.FINISHED, [], FixSource.REAL), 5000);
      t.feed(snap(TourPhase.READY, [], FixSource.REAL), 6000);
      t.feed(snap(TourPhase.WALKING, [], FixSource.REAL), 9000);
      expect(t.startMs).toBe(9000);
      expect(Number.isNaN(t.endMs)).toBe(true);
      expect(t.atStopMs).toBe(0);
    });
    it('timer_ignores_a_tour_dropped_without_an_end_phase', () => {
      const t = new TourTimer();
      t.feed(snap(TourPhase.WALKING, [], FixSource.REAL), 0);
      expect(t.feed(snap(TourPhase.IDLE, [], FixSource.REAL), 5000)).toBe(false);
      expect(Number.isNaN(t.startMs)).toBe(true);
      expect(Number.isNaN(summaryDurationS(t, 100, false))).toBe(true);
    });
    it('real_walk_total_is_elapsed_time', () => {
      const t = new TourTimer();
      t.feed(snap(TourPhase.WALKING, [], FixSource.REAL), 1000);
      t.feed(snap(TourPhase.FINISHED, [], FixSource.REAL), 1000 + 84 * 60000);
      expect(summaryDurationS(t, 2600, false)).toBe(84 * 60);
    });
    it('demo_walk_total_is_walking_pace_plus_time_at_stops', () => {
      const t = new TourTimer();
      t.feed(snap(TourPhase.WALKING, [], FixSource.DEMO), 0);
      t.feed(snap(TourPhase.AT_STOP, [], FixSource.DEMO), 20000);     // x8: 20 s real
      t.feed(snap(TourPhase.WALKING, [], FixSource.DEMO), 140000);    // listened 120 s
      t.feed(snap(TourPhase.FINISHED, [], FixSource.DEMO), 160000);
      expect(near(summaryDurationS(t, 2600, true), 2600 / SUMMARY_WALK_MPS + 120)).toBe(true);
      expect(near(summaryDurationS(t, Number.NaN, true), 120)).toBe(true);
    });
    it('heard_includes_visited_and_teasers', () => {
      expect(isHeard(StopStatus.VISITED)).toBe(true);
      expect(isHeard(StopStatus.TEASER_ONLY)).toBe(true);
      expect(isHeard(StopStatus.SKIPPED)).toBe(false);
      expect(isHeard(StopStatus.PENDING)).toBe(false);
    });
    it('complete_tour_lists_every_stop_heard', () => {
      const t = new TourTimer();
      const stops = [stop('a', 0, StopStatus.VISITED), stop('b', 1, StopStatus.TEASER_ONLY),
        stop('c', 2, StopStatus.VISITED)];
      t.feed(snap(TourPhase.WALKING, stops, FixSource.REAL), 0);
      t.feed(snap(TourPhase.FINISHED, stops, FixSource.REAL), 60000);
      const d: TourSummaryData = buildSummary(snap(TourPhase.FINISHED, stops, FixSource.REAL), t, positions, legs);
      expect(d.complete).toBe(true);
      expect(d.demo).toBe(false);
      expect(d.heardCount()).toBe(3);
      expect(d.totalStops).toBe(3);
      expect(d.stillToSee.length).toBe(0);
      expect(d.heard[1].order).toBe(2);
      expect(d.walkedM).toBe(500);           // route legs, not the engine's jittery 2600
      expect(d.durationS).toBe(60);
      expect(d.shown).toBe(false);
    });
    it('ended_early_lists_still_to_see_with_distance_from_here', () => {
      const t = new TourTimer();
      const stops = [stop('a', 0, StopStatus.VISITED), stop('b', 1, StopStatus.SKIPPED),
        stop('c', 2, StopStatus.PENDING)];
      t.feed(snap(TourPhase.WALKING, stops, FixSource.DEMO), 0);
      const end = snap(TourPhase.ABORTED, stops, FixSource.DEMO);
      end.currentStopIdx = 2;                               // heading to 'c' when the tour ended
      t.feed(end, 1000);
      const d = buildSummary(end, t, positions, legs);
      expect(d.complete).toBe(false);
      expect(d.demo).toBe(true);
      expect(d.heardCount()).toBe(1);
      expect(d.stillToSee.length).toBe(2);
      expect(d.stillToSee[0].poiId).toBe('b');
      expect(Number.isNaN(d.stillToSee[0].distanceM)).toBe(true);   // no position for 'b'
      expect(d.stillToSee[1].order).toBe(3);
      expect(near(d.stillToSee[1].distanceM, 300)).toBe(true);      // user (100, 0) -> c (100, 300)
    });
    it('walked_is_route_length_to_the_last_stop_heard', () => {
      // a -> b pack leg 500 m; b has no position, so b -> c counts 0; c -> d unheard is not walked.
      const heardAC = [stop('a', 0, StopStatus.VISITED), stop('b', 1, StopStatus.SKIPPED),
        stop('c', 2, StopStatus.VISITED), stop('d', 3, StopStatus.PENDING)];
      expect(routeWalkedM(heardAC, legs, positions)).toBe(500);
      // Straight-line fallback when the pack has no leg: a (0,0) -> c (100,300).
      const ac = [stop('a', 0, StopStatus.VISITED), stop('c', 1, StopStatus.TEASER_ONLY)];
      expect(near(routeWalkedM(ac, legs, positions), Math.hypot(100, 300))).toBe(true);
      // Only the first stop heard: nothing walked between stops yet.
      expect(routeWalkedM([stop('a', 0, StopStatus.VISITED), stop('b', 1, StopStatus.PENDING)], legs, positions))
        .toBe(0);
    });
    it('stop_entered_but_ended_before_its_story_is_not_heard', () => {
      const t = new TourTimer();
      const stops = [stop('a', 0, StopStatus.VISITED), stop('c', 1, StopStatus.VISITED)];
      const walking = snap(TourPhase.WALKING, stops, FixSource.DEMO);
      walking.nowPlaying = {
        itemId: 'it1', poiId: 'a', kind: 'fullStory', sentenceIndex: 0, sentenceCount: 3, caption: '',
        tier: ContentTier.REVIEWED_HISTORIAN, lang: Lang.EN
      };
      t.feed(walking, 0);
      const nav = snap(TourPhase.AT_STOP, stops, FixSource.DEMO);
      nav.nowPlaying = {
        itemId: 'it2', poiId: 'c', kind: 'navCue', sentenceIndex: 0, sentenceCount: 1, caption: '',
        tier: ContentTier.REVIEWED_HISTORIAN, lang: Lang.EN
      };
      t.feed(nav, 1000);                                  // only a nav cue for 'c', no story
      const end = snap(TourPhase.ABORTED, stops, FixSource.DEMO);
      end.currentStopIdx = 1;
      t.feed(end, 2000);
      expect(t.storyPois.length).toBe(1);
      const d = buildSummary(end, t, positions, legs);
      expect(d.heardCount()).toBe(1);
      expect(d.stillToSee.length).toBe(1);
      expect(d.stillToSee[0].poiId).toBe('c');
      expect(near(d.walkedM, Math.hypot(100, 300))).toBe(true);   // the walk to 'c' still counts
      // Same end but the story of 'c' had started: heard.
      const t2 = new TourTimer();
      t2.feed(walking, 0);
      const story = snap(TourPhase.AT_STOP, stops, FixSource.DEMO);
      story.nowPlaying = {
        itemId: 'it3', poiId: 'c', kind: 'stopStory', sentenceIndex: 0, sentenceCount: 2, caption: '',
        tier: ContentTier.REVIEWED_HISTORIAN, lang: Lang.EN
      };
      t2.feed(story, 1000);
      t2.feed(end, 2000);
      expect(buildSummary(end, t2, positions, legs).heardCount()).toBe(2);
    });
    it('no_position_means_no_distance_and_bad_walked_is_zero', () => {
      const t = new TourTimer();
      const stops = [stop('c', 0, StopStatus.PENDING)];
      const s = snap(TourPhase.ABORTED, stops, FixSource.REAL);
      s.user = undefined;
      s.walkedM = Number.NaN;
      const d = buildSummary(s, t, positions, legs);
      expect(Number.isNaN(d.stillToSee[0].distanceM)).toBe(true);
      expect(d.walkedM).toBe(0);             // nothing heard, nothing walked
      expect(d.heardCount()).toBe(0);
      expect(Number.isNaN(d.durationS)).toBe(true);   // never saw the start
    });
  });
}

tourSummaryTest();
