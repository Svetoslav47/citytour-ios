// Suite: LegTracker.test - module under test: core/route/LegTracker + Guidance (task A9).
// Cases from docs/ARCHITECTURE.md §11.1: progress is monotonic; off-route after 12 s at 50 m; clear when back;
// prepare and now cues at 30/8 m once each. Plus: the demo-speed rule (12 s of walking = a 16 m span at x8 wall-clock
// stamps), accuracy widens the threshold, poor fixes are ignored, GPS jitter on the route never goes off-route,
// leg 0 snapping within 30 m, coalesced turns ("Now turn left, then turn right."), missed cues stay silent, the
// §4.6 step rules (depart/arrive silent, continue only > 250 m) and the Guidance sentences built from the steps.
import { describe, it, expect } from 'vitest';
import {
  CueKind, LegTracker, LegUpdate, NavConfig, NavCue, OffRouteChange
} from '../src';
import {
  StepCue, bearingText, continueText, maneuverUiText, nowText, offRouteSentences, prepareText, replanSentence,
  stepCueKind
} from '../src';
import { Lang, Maneuver, RouteLeg, RouteStep } from '../src';
import { RelDir } from '../src';

const T0: number = 5000000;

function step(m: Maneuver, mod: string, street: string, dist: number, idx: number, g: number[]): RouteStep {
  const s: RouteStep = {
    maneuver: m, modifier: mod, streetName: street, distanceM: dist, durationS: dist / 1.3, geomIndex: idx,
    x: g[idx * 2], y: g[idx * 2 + 1]
  };
  return s;
}

/** North 100 m, turn left onto Grodzka, west 100 m, arrive. */
function lLeg(): RouteLeg {
  const g: number[] = [0, 0, 0, 100, -100, 100];
  const l: RouteLeg = {
    fromPoiId: 'a', toPoiId: 'b', distanceM: 200, durationS: 154, geometry: g,
    steps: [
      step(Maneuver.DEPART, 'straight', '', 100, 0, g),
      step(Maneuver.TURN, 'left', 'Grodzka', 100, 1, g),
      step(Maneuver.ARRIVE, 'left', 'Grodzka', 0, 2, g)
    ]
  };
  return l;
}

/** North 100 m, left for gapM, right, north 100 m (gapM = 4: a jog; 20: a dog-leg). */
function jogLeg(gapM: number): RouteLeg {
  const g: number[] = [0, 0, 0, 100, -gapM, 100, -gapM, 200];
  const l: RouteLeg = {
    fromPoiId: 'a', toPoiId: 'c', distanceM: 200 + gapM, durationS: 160, geometry: g,
    steps: [
      step(Maneuver.DEPART, 'straight', '', 100, 0, g),
      step(Maneuver.TURN, 'left', '', gapM, 1, g),
      step(Maneuver.TURN, 'right', '', 100, 2, g),
      step(Maneuver.ARRIVE, '', '', 0, 3, g)
    ]
  };
  return l;
}

class Feed {
  readonly t: LegTracker;
  ms: number = T0;
  cues: NavCue[] = [];
  entered: number = 0;
  cleared: number = 0;
  alongs: number[] = [];

  constructor(leg: RouteLeg) {
    this.t = new LegTracker(leg, new NavConfig());
  }

  /** One fix, `dtMs` after the previous one. */
  at(x: number, y: number, acc: number, dtMs: number, triggerGrade: boolean): LegUpdate {
    this.ms += dtMs;
    const u: LegUpdate = this.t.update(x, y, acc, this.ms, triggerGrade);
    for (const c of u.cues) {
      this.cues.push(c);
    }
    if (u.offRoute === OffRouteChange.ENTERED) {
      this.entered++;
    } else if (u.offRoute === OffRouteChange.CLEARED) {
      this.cleared++;
    }
    this.alongs.push(this.t.alongM);
    return u;
  }

  ok(x: number, y: number): LegUpdate {
    return this.at(x, y, 5, 1000, true);
  }

  kinds(): string {
    return this.cues.map((c: NavCue) => `${c.kind}@${c.stepIdx}`).join(',');
  }
}

/** Walks the L leg from y = y0 north to the corner, then west, 1 m per fix. */
function walkL(f: Feed, y0: number): void {
  for (let y = y0; y <= 100; y++) {
    f.ok(0, y);
  }
  for (let x = -1; x >= -100; x--) {
    f.ok(x, 100);
  }
}

function legTrackerTest() {
  describe('LegTracker', () => {
    it('progress_is_monotonic_even_when_a_fix_jumps_back', () => {
      const f: Feed = new Feed(lLeg());
      for (let y = 0; y <= 60; y += 2) {
        f.ok(y % 4 === 0 ? 3 : -3, y);            // +-3 m sideways jitter
      }
      f.ok(0, 40);                                 // a fix 20 m behind
      f.ok(0, 62);
      for (let i = 1; i < f.alongs.length; i++) {
        expect(f.alongs[i] >= f.alongs[i - 1]).toBe(true);
      }
      expect(Math.abs(f.t.alongM - 62) < 0.5).toBe(true);
      expect(f.t.crossTrackM < 0.5).toBe(true);
      expect(f.entered).toBe(0);
    });

    it('prepare_at_30_m_and_now_at_8_m_fire_once_each', () => {
      const f: Feed = new Feed(lLeg());
      walkL(f, 0);
      expect(f.kinds()).toBe('prepare@1,now@1');
      expect(f.cues[0].distM <= 30 && f.cues[0].distM > 8).toBe(true);
      expect(f.cues[1].distM <= 8).toBe(true);
      // dithering around the corner and walking back a bit never repeats a cue
      f.ok(0, 95);
      f.ok(0, 99);
      f.ok(-2, 100);
      expect(f.cues.length).toBe(2);
      expect(f.entered).toBe(0);
    });

    it('off_route_after_12_s_at_50_m_and_not_before', () => {
      const f: Feed = new Feed(lLeg());
      for (let y = 0; y <= 40; y++) {
        f.ok(0, y);
      }
      // stands 50 m east of the leg (accuracy 5 m => threshold 35 m), one fix per second
      for (let s = 0; s <= 11; s++) {
        f.ok(50, 40);
        expect(f.t.offRoute).toBe(false);
      }
      f.ok(50, 40);                                // 12 s after the first off-route fix
      expect(f.entered).toBe(1);
      expect(f.t.offRoute).toBe(true);
      expect(f.t.enteredFixes >= 3).toBe(true);
      expect(f.t.enteredThresholdM).toBe(35);
      f.ok(50, 40);
      expect(f.entered).toBe(1);            // one episode
    });

    it('clears_after_2_fixes_back_within_20_m', () => {
      const f: Feed = new Feed(lLeg());
      for (let y = 0; y <= 40; y++) {
        f.ok(0, y);
      }
      for (let s = 0; s < 14; s++) {
        f.ok(50, 40);
      }
      expect(f.t.offRoute).toBe(true);
      f.ok(25, 45);                                // 25 m off: not yet back
      f.ok(15, 50);
      expect(f.t.offRoute).toBe(true);           // one fix within 20 m
      f.ok(10, 55);
      expect(f.t.offRoute).toBe(false);
      expect(f.cleared).toBe(1);
      expect(Math.abs(f.t.alongM - 55) < 0.5).toBe(true);   // re-joined further ahead
      // no cue was spoken for the off-route time, and the corner still gets its cues
      walkL(f, 56);
      expect(f.kinds()).toBe('prepare@1,now@1');
    });

    it('demo_x8_wall_clock_stamps_the_span_rule_fires_after_3_fixes', () => {
      // DemoWalkSource at x8: a fix per wall second, ~10 m apart; the detour lasts ~7 wall seconds.
      const f: Feed = new Feed(lLeg());
      for (let y = 0; y <= 40; y += 10) {
        f.ok(0, y);
      }
      f.ok(40, 45);
      f.ok(50, 50);
      expect(f.t.offRoute).toBe(false);
      f.ok(60, 55);                                // 3rd fix, 2 s of fix time, 22 m from the first off fix
      expect(f.entered).toBe(1);
      expect(f.t.enteredHeldMs < 12000).toBe(true);
      expect(f.t.enteredSpanM >= 16).toBe(true);
    });

    it('accuracy_widens_the_threshold_and_poor_fixes_are_ignored', () => {
      const f: Feed = new Feed(lLeg());
      for (let y = 0; y <= 40; y++) {
        f.ok(0, y);
      }
      expect(f.t.offRouteThresholdM(30)).toBe(50);
      expect(f.t.offRouteThresholdM(80)).toBe(50);    // min(acc, 30)
      expect(f.t.offRouteThresholdM(Number.NaN)).toBe(50);
      for (let s = 0; s < 30; s++) {
        f.at(40, 40, 30, 1000, true);              // 40 m off with acc 30 => threshold 50: on route
      }
      expect(f.entered).toBe(0);
      const along: number = f.t.alongM;
      for (let s = 0; s < 30; s++) {
        f.at(200, 40, 60, 1000, false);            // not trigger-grade: ignored entirely
      }
      expect(f.entered).toBe(0);
      expect(f.t.alongM).toBe(along);
    });

    it('gps_jitter_on_the_route_never_goes_off_route', () => {
      const f: Feed = new Feed(lLeg());
      let seed: number = 7;
      const rnd = (): number => {
        seed = (seed * 16807) % 2147483647;
        return seed / 2147483647 * 2 - 1;
      };
      for (let y = 0; y <= 100; y++) {
        f.at(15 * rnd(), y, 12, 1000, true);
      }
      for (let x = -1; x >= -100; x--) {
        f.at(x, 100 + 15 * rnd(), 12, 1000, true);
      }
      expect(f.entered).toBe(0);
      // jitter near the corner may move the projection, but a cue is never repeated
      expect(f.cues.filter((c: NavCue) => c.kind === CueKind.PREPARE).length <= 1).toBe(true);
      expect(f.cues.filter((c: NavCue) => c.kind === CueKind.NOW).length <= 1).toBe(true);
    });

    it('leg0_snaps_within_30_m_and_is_silent_before', () => {
      const f: Feed = new Feed(lLeg());
      expect(f.t.distanceTo(80, 50)).toBe(80);
      for (let x = 80; x > 30; x -= 2) {
        const u: LegUpdate = f.ok(x, 50);
        expect(u.snappedNow).toBe(false);
      }
      expect(f.t.snapped).toBe(false);
      for (let s = 0; s < 20; s++) {
        f.ok(80, 50);                              // far away for long: no off-route before snapping
      }
      expect(f.entered).toBe(0);
      const u: LegUpdate = f.ok(28, 50);
      expect(u.snappedNow).toBe(true);
      expect(Math.abs(f.t.alongM - 50) < 0.5).toBe(true);
      walkL(f, 51);
      expect(f.kinds()).toBe('prepare@1,now@1');
    });

    it('snapping_inside_the_prepare_window_only_says_now', () => {
      const f: Feed = new Feed(lLeg());
      walkL(f, 85);                                // the first fix is 15 m before the corner
      expect(f.kinds()).toBe('now@1');
    });

    it('a_jog_is_one_cue_and_a_dog_leg_says_then_and_now_again', () => {
      const jog: Feed = new Feed(jogLeg(4));
      for (let y = 0; y <= 100; y++) {
        jog.ok(0, y);
      }
      for (let y = 100; y <= 150; y++) {
        jog.ok(-4, y);
      }
      expect(jog.kinds()).toBe('prepare@1,now@1');
      expect(jog.cues[0].thenStepIdx).toBe(2);
      expect(jog.cues[1].thenStepIdx).toBe(2);
      const dog: Feed = new Feed(jogLeg(20));
      for (let y = 0; y <= 100; y++) {
        dog.ok(0, y);
      }
      for (let x = -1; x >= -20; x--) {
        dog.ok(x, 100);
      }
      for (let y = 101; y <= 150; y++) {
        dog.ok(-20, y);
      }
      expect(dog.kinds()).toBe('prepare@1,now@1,now@2');
      expect(dog.cues[1].thenStepIdx).toBe(2);
    });

    it('a_fix_far_past_the_corner_misses_the_cue_silently', () => {
      const f: Feed = new Feed(lLeg());
      for (let y = 0; y <= 60; y += 10) {
        f.ok(0, y);
      }
      const u: LegUpdate = f.ok(-15, 100);         // jumped 55 m, past the corner by 15 m
      expect(u.passedSteps.join(',')).toBe('1');
      expect(f.cues.length).toBe(0);
    });

    it('step_rules_depart_arrive_silent_continue_only_when_long', () => {
      const g: number[] = [0, 0, 0, 10];
      expect(stepCueKind(step(Maneuver.DEPART, 'left', '', 300, 0, g), 250)).toBe(StepCue.NONE);
      expect(stepCueKind(step(Maneuver.ARRIVE, 'left', '', 0, 0, g), 250)).toBe(StepCue.NONE);
      expect(stepCueKind(step(Maneuver.CONTINUE, 'straight', '', 120, 0, g), 250)).toBe(StepCue.NONE);
      expect(stepCueKind(step(Maneuver.NEW_NAME, 'straight', 'Grodzka', 300, 0, g), 250))
        .toBe(StepCue.CONTINUE);
      expect(stepCueKind(step(Maneuver.NEW_NAME, 'slight left', 'Grodzka', 80, 0, g), 250)).toBe(StepCue.NONE);
      expect(stepCueKind(step(Maneuver.TURN, 'straight', '', 30, 0, g), 250)).toBe(StepCue.NONE);
      expect(stepCueKind(step(Maneuver.TURN, 'left', '', 30, 0, g), 250)).toBe(StepCue.TURN);
      expect(stepCueKind(step(Maneuver.END_OF_ROAD, 'right', '', 30, 0, g), 250)).toBe(StepCue.TURN);
      expect(stepCueKind(step(Maneuver.FORK, 'slight left', '', 30, 0, g), 250)).toBe(StepCue.TURN);
      expect(stepCueKind(step(Maneuver.ROUNDABOUT, '', '', 30, 0, g), 250)).toBe(StepCue.TURN);
    });

    it('long_continue_fires_once_at_the_step', () => {
      const g: number[] = [0, 0, 0, 50, 0, 400];
      const leg: RouteLeg = {
        fromPoiId: 'a', toPoiId: 'd', distanceM: 400, durationS: 300, geometry: g,
        steps: [
          step(Maneuver.DEPART, 'straight', '', 50, 0, g),
          step(Maneuver.NEW_NAME, 'straight', 'Grodzka', 350, 1, g),
          step(Maneuver.ARRIVE, '', '', 0, 2, g)
        ]
      };
      const f: Feed = new Feed(leg);
      for (let y = 0; y <= 400; y += 2) {
        f.ok(0, y);
      }
      expect(f.kinds()).toBe('continue@1');
    });

    it('guidance_sentences_from_steps', () => {
      const g: number[] = [0, 0, 0, 10];
      const left: RouteStep = step(Maneuver.TURN, 'left', 'Grodzka', 120, 0, g);
      const right: RouteStep = step(Maneuver.TURN, 'right', '', 40, 0, g);
      const end: RouteStep = step(Maneuver.END_OF_ROAD, 'right', 'Floriańska', 40, 0, g);
      expect(prepareText(Lang.EN, left, 28, 1.3, undefined)).toBe('In 30 metres, turn left onto Grodzka.');
      expect(prepareText(Lang.EN, left, 28, 1.3, right))
        .toBe('In 30 metres, turn left onto Grodzka, then turn right.');
      expect(nowText(Lang.EN, right, undefined)).toBe('Now turn right.');
      expect(nowText(Lang.EN, end, undefined)).toBe('Now turn right at the end of the street onto Floriańska.');
      expect(nowText(Lang.EN, left, right)).toBe('Now turn left onto Grodzka, then turn right.');
      // zh never speaks the Polish street name; pl puts it in brackets (no case agreement)
      expect(prepareText(Lang.ZH, left, 28, 1.3, undefined)).toBe('前方30米，左转。');
      expect(nowText(Lang.ZH, left, right)).toBe('现在左转，然后右转。');
      expect(prepareText(Lang.PL, left, 28, 1.3, undefined)).toBe('Za 30 metrów skręć w lewo (Grodzka).');
      // the screen shows the street in zh
      expect(maneuverUiText(Lang.ZH, left, 120, 1.3, 8)).toBe('前方100米，左转（Grodzka）。');
      expect(maneuverUiText(Lang.EN, left, 5, 1.3, 8)).toBe('Now turn left onto Grodzka.');
      const cont: RouteStep = step(Maneuver.NEW_NAME, 'straight', 'Grodzka', 300, 0, g);
      expect(continueText(Lang.EN, cont, 1.3, '')).toBe('Continue along Grodzka for about 300 metres.');
      expect(continueText(Lang.EN, cont, 1.3, 'the Cloth Hall')).toBe('Walk straight past the Cloth Hall.');
      expect(continueText(Lang.ZH, cont, 1.3, '')).toBe('沿这条路继续直行大约300米。');
      expect(bearingText(Lang.EN, 'Barbican', 290, RelDir.AHEAD_LEFT, 1.3, true))
        .toBe('Barbican is about 300 metres ahead on your left.');
      expect(bearingText(Lang.EN, 'Barbican', 290, RelDir.AHEAD_LEFT, 1.3, false))
        .toBe('Barbican is about 300 metres away.');
      expect(offRouteSentences(Lang.EN, 'Cloth Hall', 210, RelDir.BEHIND_RIGHT, 1.3, true).join(' '))
        .toBe('You\'ve left the route. Cloth Hall is about 200 metres behind you, on the right.');
      expect(offRouteSentences(Lang.ZH, '纺织会馆', 210, RelDir.LEFT, 1.3, true).join(''))
        .toBe('您已偏离路线。纺织会馆在您左侧，大约200米。');
      expect(replanSentence(Lang.EN, 'Wawel Hill')).toBe('New plan: we\'ll visit Wawel Hill first.');
    });

    it('nav_config_logs_its_numbers', () => {
      const kv: string = new NavConfig().toLogKv();
      expect(kv.indexOf('prep30') >= 0 && kv.indexOf('now8') >= 0 && kv.indexOf('12000ms') >= 0).toBe(true);
      const c: NavCue = new NavCue(CueKind.NOW, 1, 3, -1);
      expect(c.kind).toBe(CueKind.NOW);
    });
  });
}

legTrackerTest();
