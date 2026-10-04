// Suite: DemoWalkPlayer.test - module under test: core/sim/DemoWalkPlayer (task A5).
// PLAN A5 DoD: order, speed multiplier, hold while the predicate is true. Plus: JSON validation (simulated flag,
// time order, null course -> NaN), strictly increasing timestamps while holding, jump to the next stop, the end of
// the track, jump to a stop by number / POI (Skip in demo mode), and the generated fixture (fixtures/DemoTrackMini.ets:
// a plain walk with a hold at every stop) played through at x8.
// Registered in List.test.ets by T1 (do not rename the exported function).
import { describe, it, expect } from 'vitest';
import {
  DemoFix, DemoStop, DemoTick, DemoTrack, DemoWalkPlayer, DEMO_PROVIDER, nextDemoSpeed, normalizeDemoSpeed, parseDemoTrack
} from '../src';
import { FixSource } from '../src';
import { DEMO_MINI_EVENTS, DEMO_MINI_STOPS, demoTrackMini } from './fixtures/DemoTrackMini';

const T0: number = 1700000000000;

/** Sample i at lat = 50 + i * 1e-5, one per second; stop > 0 = hold sample of that stop. */
function sample(i: number, stop: number): DemoFix {
  const f: DemoFix = {
    tRelMs: i * 1000, lat: 50 + i * 0.00001, lng: 19.9, accuracyM: 5, speedMps: stop > 0 ? 0 : 1.3,
    courseDeg: stop > 0 ? Number.NaN : 0, courseAccuracyDeg: stop > 0 ? Number.NaN : 10, hold: stop > 0, stop: stop
  };
  return f;
}

/** 0-4 walking, 5-9 hold at stop 1, 10-14 walking, 15-17 hold at stop 2, 18-19 walking. */
function testTrack(): DemoTrack {
  const fixes: DemoFix[] = [];
  for (let i = 0; i < 20; i++) {
    let stop = 0;
    if (i >= 5 && i <= 9) {
      stop = 1;
    } else if (i >= 15 && i <= 17) {
      stop = 2;
    }
    fixes.push(sample(i, stop));
  }
  const t: DemoTrack = { id: 't', name: 'test', simulated: true, generatedBy: 'test', fixes: fixes };
  return t;
}

/** testTrack() with its stop list: stop 1 = poi_a, stop 2 = poi_b. */
function testTrackWithStops(): DemoTrack {
  const t = testTrack();
  const a: DemoStop = { n: 1, poiId: 'poi_a' };
  const b: DemoStop = { n: 2, poiId: 'poi_b' };
  t.stops = [a, b];
  return t;
}

function player(): DemoWalkPlayer {
  const p = new DemoWalkPlayer(testTrack());
  p.reset(T0);
  return p;
}

function demoWalkPlayerTest() {
  describe('DemoWalkPlayer', () => {
    it('parse_valid_track_maps_null_course_to_nan', () => {
      const json = '{"id":"w","name":"n","simulated":true,"generatedBy":"g","fixes":[' +
        '{"tRelMs":0,"lat":50.06,"lng":19.93,"accuracyM":5,"speedMps":1.3,"courseDeg":90,"courseAccuracyDeg":8},' +
        '{"tRelMs":1000,"lat":50.07,"lng":19.94,"accuracyM":6,"speedMps":0.1,"courseDeg":null,' +
        '"courseAccuracyDeg":null,"hold":true,"stop":3}]}';
      const r = parseDemoTrack(json);
      expect(r.error).toBe('');
      const t = r.track as DemoTrack;
      expect(t.simulated).toBe(true);
      expect(t.fixes.length).toBe(2);
      expect(t.fixes[0].courseDeg).toBe(90);
      expect(t.fixes[0].hold).toBe(false);
      expect(Number.isNaN(t.fixes[1].courseDeg)).toBe(true);
      expect(t.fixes[1].hold).toBe(true);
      expect(t.fixes[1].stop).toBe(3);
    });

    it('parse_rejects_unlabelled_unordered_or_broken_tracks', () => {
      expect(parseDemoTrack('{"simulated":false,"fixes":[{"tRelMs":0,"lat":1,"lng":1}]}').error)
        .toBe('not_simulated');
      expect(parseDemoTrack('{"fixes":[{"tRelMs":0,"lat":1,"lng":1}]}').error).toBe('not_simulated');
      expect(parseDemoTrack('{"simulated":true,"fixes":[]}').error).toBe('no_fixes');
      expect(parseDemoTrack('{"simulated":true,"fixes":[{"tRelMs":5,"lat":1,"lng":1},{"tRelMs":5,"lat":1,"lng":1}]}')
        .error).toBe('time_order i=1');
      expect(parseDemoTrack('{"simulated":true,"fixes":[{"tRelMs":0,"lat":91,"lng":1}]}').error)
        .toBe('bad_fix i=0');
      expect(parseDemoTrack('{"simulated":true,').error).toBe('json');
      expect(parseDemoTrack('null').error).toBe('not_object');
    });

    it('order_x1_emits_every_sample_in_order_as_demo_fixes', () => {
      const p = player();
      const first = p.current();
      expect(first.lat).toBe(50);
      expect(first.timestampMs).toBe(T0);
      for (let k = 1; k <= 5; k++) {
        const t: DemoTick = p.tick(1000, false);
        expect(t.index).toBe(k);
        expect(t.fix.source).toBe(FixSource.DEMO);
        expect(t.fix.provider).toBe(DEMO_PROVIDER);
        expect(t.fix.timestampMs).toBe(T0 + k * 1000);
        expect(Math.abs(t.fix.lat - (50 + k * 0.00001))).toBeLessThan(1e-9);
      }
    });

    it('speed_multiplier_advances_mult_samples_per_tick', () => {
      const p = player();
      expect(p.tick(4000, false).index).toBe(4);
      expect(p.tick(8000, false).index).toBe(12);
      const t = p.tick(2000, false);
      expect(t.index).toBe(14);
      expect(t.fix.timestampMs).toBe(T0 + 14000); // simulated time = track time
    });

    it('speed_values_are_1_2_4_8', () => {
      expect(normalizeDemoSpeed(3)).toBe(2);
      expect(normalizeDemoSpeed(6.5)).toBe(8);
      expect(normalizeDemoSpeed(100)).toBe(8);
      expect(normalizeDemoSpeed(Number.NaN)).toBe(1);
      expect(nextDemoSpeed(1)).toBe(2);
      expect(nextDemoSpeed(4)).toBe(8);
      expect(nextDemoSpeed(8)).toBe(1);
    });

    it('hold_loops_at_the_stop_while_predicate_true_then_leaves', () => {
      const p = player();
      p.tick(5000, true);                       // arrive at index 5 (stop 1)
      expect(p.currentStop()).toBe(1);
      for (let k = 0; k < 30; k++) {            // 30 ticks at x4 = 120 s of track time, story still playing
        const t = p.tick(4000, true);
        expect(t.index >= 5 && t.index <= 9).toBe(true);
        expect(t.ended).toBe(false);
      }
      const holding = p.tick(1000, true);
      expect(holding.index >= 5 && holding.index <= 9).toBe(true);
      let t = p.tick(1000, false);              // story over: walk on
      let guard = 0;
      while (t.index <= 9 && guard < 10) {
        t = p.tick(1000, false);
        guard++;
      }
      expect(t.index).toBe(10);
      expect(t.holding).toBe(false);
      expect(p.currentStop()).toBe(0);
    });

    it('hold_flag_reports_demo_assist_at_the_segment_end', () => {
      const p = player();
      p.tick(9000, true);                       // index 9 = last hold sample of stop 1
      expect(p.index()).toBe(9);
      const t = p.tick(1000, true);             // would leave: loops back instead
      expect(t.holding).toBe(true);
      expect(t.index).toBe(5);
      for (let k = 0; k < 12; k++) {            // stays on for the whole extension, not only on loop ticks
        expect(p.tick(1000, true).holding).toBe(true);
      }
      expect(p.tick(1000, false).holding).toBe(false);   // story over
    });

    it('hold_without_predicate_passes_through_at_walking_time', () => {
      const p = player();
      const idx: number[] = [];
      for (let k = 0; k < 12; k++) {
        const t = p.tick(1000, false);
        idx.push(t.index);
        expect(t.holding).toBe(false);
      }
      expect(idx.join(',')).toBe('1,2,3,4,5,6,7,8,9,10,11,12');
    });

    it('timestamps_strictly_increase_while_holding', () => {
      const p = player();
      let last = p.current().timestampMs;
      for (let k = 0; k < 40; k++) {
        const t = p.tick(8000, true);
        expect(t.fix.timestampMs).toBeGreaterThan(last);
        last = t.fix.timestampMs;
      }
    });

    it('jump_to_next_stop_lands_on_the_next_hold_segment', () => {
      const p = player();
      expect(p.jumpToNextStop()).toBe(1);
      expect(p.index()).toBe(5);
      expect(p.jumpToNextStop()).toBe(2);    // from inside stop 1's hold to the start of stop 2's
      expect(p.index()).toBe(15);
      expect(p.jumpToNextStop()).toBe(0);    // no more stops: last sample
      expect(p.isAtEnd()).toBe(true);
    });

    it('jump_to_stop_by_number_goes_forwards_and_backwards_to_the_hold_start', () => {
      const p = player();
      expect(p.jumpToStop(2)).toBe(2);       // Skip from the start straight to stop 2 (the tour's target)
      expect(p.index()).toBe(15);
      expect(p.currentStop()).toBe(2);
      p.tick(1000, false);
      expect(p.index()).toBe(16);
      expect(p.jumpToStop(2)).toBe(2);       // already in stop 2's hold: stays
      expect(p.index()).toBe(16);
      expect(p.jumpToStop(1)).toBe(1);       // backwards (a re-plan put stop 1 next)
      expect(p.index()).toBe(5);
      expect(p.jumpToStop(3)).toBe(0);       // no such stop: cursor unchanged
      expect(p.jumpToStop(0)).toBe(0);
      expect(p.jumpToStop(Number.NaN)).toBe(0);
      expect(p.index()).toBe(5);
    });

    it('jump_to_stop_then_holds_while_the_story_plays_and_releases_after', () => {
      const p = player();
      p.jumpToStop(2);                               // 15-17 hold at stop 2
      const idx: number[] = [];
      for (let k = 0; k < 6; k++) {
        idx.push(p.tick(1000, true).index);          // story playing: loops inside the segment
      }
      expect(idx.every((i: number) => i >= 15 && i <= 17)).toBe(true);
      expect(p.currentStop()).toBe(2);
      let t = p.tick(1000, false);                   // story over: walks on
      while (t.index <= 17) {
        t = p.tick(1000, false);
      }
      expect(t.index).toBe(18);
      expect(t.holding).toBe(false);
    });

    it('stop_number_of_poi_and_hold_stops', () => {
      const p = new DemoWalkPlayer(testTrackWithStops());
      p.reset(T0);
      expect(p.stopNumberOf('poi_b')).toBe(2);
      expect(p.stopNumberOf('poi_a')).toBe(1);
      expect(p.stopNumberOf('poi_x')).toBe(0);
      expect(player().stopNumberOf('poi_a')).toBe(0);    // a track without a stop list
      expect(p.holdStops().join(',')).toBe('1,2');
      expect(p.jumpToStop(p.stopNumberOf('poi_b'))).toBe(2);
      expect(p.index()).toBe(15);
    });

    it('parse_reads_the_stop_list_and_drops_bad_entries', () => {
      const json = '{"simulated":true,"fixes":[{"tRelMs":0,"lat":50,"lng":19.9}],"stops":[' +
        '{"n":1,"poiId":"poi_a"},{"n":0,"poiId":"poi_z"},{"n":2.5,"poiId":"poi_y"},{"n":3},{"n":4,"poiId":""},' +
        '{"n":2,"poiId":"poi_b","name":"B"}]}';
      const t = parseDemoTrack(json).track as DemoTrack;
      const stops = t.stops as DemoStop[];
      expect(stops.map((s: DemoStop) => `${s.n}:${s.poiId}`).join(',')).toBe('1:poi_a,2:poi_b');
      const none = parseDemoTrack('{"simulated":true,"fixes":[{"tRelMs":0,"lat":50,"lng":19.9}]}').track as DemoTrack;
      expect((none.stops as DemoStop[]).length).toBe(0);
    });

    it('ends_on_the_last_sample', () => {
      const p = player();
      let t = p.tick(8000, false);
      let n = 0;
      while (!t.ended && n < 50) {
        t = p.tick(8000, false);
        n++;
      }
      expect(t.ended).toBe(true);
      expect(t.index).toBe(19);
      expect(p.progress()).toBe(1);
      const again = p.tick(8000, false);
      expect(again.index).toBe(19);
      expect(again.fix.timestampMs).toBeGreaterThan(t.fix.timestampMs);
    });

    it('generated_fixture_is_simulated_and_plays_to_wawel_at_x8', () => {
      const track = demoTrackMini();
      expect(track.simulated).toBe(true);
      expect(track.fixes.length).toBeGreaterThan(600);
      // plain walk: every stop has one 40 s hold segment, in the planned order
      for (const s of DEMO_MINI_STOPS) {
        expect(track.fixes.filter((f: DemoFix) => f.hold && f.stop === s.n).length).toBe(40);
        expect(s.mode).toBe('dwell');
      }
      expect(new DemoWalkPlayer(track).holdStops().join(',')).toBe('7,8,9,10,11');
      expect(DEMO_MINI_EVENTS.length).toBe(1);           // the detour only
      const p = new DemoWalkPlayer(track);
      p.reset(T0);
      const stopsSeen: number[] = [];
      let t = p.tick(8000, false);
      let n = 0;
      while (!t.ended && n < 1000) {
        const s = p.currentStop();
        if (s > 0 && stopsSeen.indexOf(s) < 0) {
          stopsSeen.push(s);
        }
        t = p.tick(8000, false);
        n++;
      }
      expect(t.ended).toBe(true);
      expect(stopsSeen.join(',')).toBe('7,8,9,10,11');
      expect(n).toBeLessThan(Math.ceil(track.fixes.length / 8) + 2);
    });
  });
}

demoWalkPlayerTest();
