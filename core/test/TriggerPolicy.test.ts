// Suite: TriggerPolicy.test - module under test: core/tour/TriggerPolicy (task A3).
// Cases from docs/ARCHITECTURE.md §11.1: jitter +-15 m at the radius edge => exactly one ENTER; acc = 80 m
// fixes => no ENTER; walk-through at 1.4 m/s => teaser only; stop 40 s => full; exit hysteresis.
// Plus: accuracy-aware distances, enter debounce (2 fixes >= 1.5 s, or 1 fix within R/2), streak reset,
// adaptive length off / user asked for more => full, unknown speed => full.
// Linger window after the teaser (issue #60, decideAfterTeaser): approach while moving, then stop => full;
// approach and walk past => teaser; GPS jitter while standing => still full; walking around the stop without getting
// closer => teaser after the window; a 3 s slow-down while passing is not a stop.
import { describe, it, expect } from 'vitest';
import {
  LingerInput, StopTrigger, StoryDecision, TriggerSample, TriggerVerdict, StoryLength, evaluateTrigger,
  decideAfterTeaser, decideStoryLength, entryDistanceM, exitDistanceM
} from '../src';
import { TourConfig, defaultTourConfig, MAX_TRIGGER_ACCURACY_M } from '../src';
import { median } from '../src';

const T0: number = 1000000;

function sample(tS: number, d: number, acc: number, speed: number): TriggerSample {
  const s: TriggerSample = {
    tMs: T0 + tS * 1000, distanceM: d, accuracyM: acc, speedMps: speed,
    triggerGrade: acc <= MAX_TRIGGER_ACCURACY_M
  };
  return s;
}

/** Deterministic pseudo-random numbers in (-1, 1) (Park-Miller, exact in doubles), so the jitter is reproducible. */
class Lcg {
  private state: number;

  constructor(seed: number) {
    this.state = seed % 2147483647;
  }

  next(): number {
    this.state = (this.state * 16807) % 2147483647;
    return this.state / 2147483647 * 2 - 1;
  }
}

class Counts {
  enter: number = 0;
  exit: number = 0;
  firstEnterS: number = -1;
}

function feed(t: StopTrigger, s: TriggerSample, cfg: TourConfig, c: Counts, tS: number): TriggerVerdict {
  const v: TriggerVerdict = evaluateTrigger(t, s, cfg);
  if (v === TriggerVerdict.ENTER) {
    c.enter++;
    if (c.firstEnterS < 0) {
      c.firstEnterS = tS;
    }
  } else if (v === TriggerVerdict.EXIT) {
    c.exit++;
  }
  return v;
}

/** One fix per second as the engine sees it: geofence + speed median + how long the median has been slow. */
class Walker {
  readonly cfg: TourConfig = defaultTourConfig();
  readonly t: StopTrigger = new StopTrigger('p', 35);
  readonly c: Counts = new Counts();
  speeds: number[] = [];
  slowSinceMs: number = Number.NaN;
  s: number = 0;
  lastMs: number = 0;
  teaserEndS: number = -1;
  verdict: StoryDecision | undefined = undefined;
  verdictS: number = -1;
  verdictDistanceM: number = Number.NaN;

  median(): number {
    return this.speeds.length === 0 ? Number.NaN : median(this.speeds.slice(-this.cfg.speedWindow));
  }

  /** One fix; once the teaser has ended (teaserEndS), asks decideAfterTeaser until it is no longer UNDECIDED. */
  fix(d: number, acc: number, speed: number): void {
    const smp: TriggerSample = sample(this.s, d, acc, speed);
    feed(this.t, smp, this.cfg, this.c, this.s);
    this.speeds.push(speed);
    this.lastMs = smp.tMs;
    const m: number = this.median();
    if (m < this.cfg.slowSpeedMps) {
      if (!Number.isFinite(this.slowSinceMs)) {
        this.slowSinceMs = smp.tMs;
      }
    } else {
      this.slowSinceMs = Number.NaN;
    }
    if (this.c.firstEnterS >= 0 && this.teaserEndS < 0 && this.s >= this.c.firstEnterS + 10) {
      this.teaserEndS = this.s;                       // a 10 s teaser (arrival line + 2 sentences at x1)
    }
    if (this.teaserEndS >= 0 && this.verdict === undefined) {
      const v: StoryDecision = decideAfterTeaser(this.t, this.input((this.s - this.teaserEndS) * 1000), this.cfg);
      if (v.length !== StoryLength.UNDECIDED) {
        this.verdict = v;
        this.verdictS = this.s;
        this.verdictDistanceM = d;
      }
    }
    this.s++;
  }

  input(waitedMs: number): LingerInput {
    const inp: LingerInput = {
      speedMedianMps: this.median(),
      slowForMs: Number.isFinite(this.slowSinceMs) ? this.lastMs - this.slowSinceMs : 0,
      waitedMs: waitedMs, adaptiveLength: true, userAskedMore: false
    };
    return inp;
  }

  length(): string {
    return this.verdict === undefined ? 'none' : this.verdict.length;
  }

  reason(): string {
    return this.verdict === undefined ? 'none' : this.verdict.reason;
  }
}

function triggerPolicyTest() {
  describe('TriggerPolicy', () => {
    it('accuracy_aware_distances', () => {
      const cfg: TourConfig = defaultTourConfig();
      expect(entryDistanceM(50, 10, cfg)).toBe(40);
      expect(entryDistanceM(50, 40, cfg)).toBe(35);   // allowance capped at 15
      expect(entryDistanceM(5, 10, cfg)).toBe(0);
      expect(exitDistanceM(50, 40, cfg)).toBe(65);
      expect(exitDistanceM(50, Number.NaN, cfg)).toBe(50);
      expect(new StopTrigger('p', 35).exitRadiusM(cfg)).toBe(56);
    });

    it('enter_needs_two_fixes_over_1_5s_or_one_deep_fix', () => {
      const cfg: TourConfig = defaultTourConfig();
      const t: StopTrigger = new StopTrigger('p', 35);
      // dEnter = 30 - 5 = 25: inside R but not within R/2
      expect(evaluateTrigger(t, sample(0, 30, 5, 1.4), cfg)).toBe(TriggerVerdict.NONE);
      expect(evaluateTrigger(t, sample(1, 30, 5, 1.4), cfg)).toBe(TriggerVerdict.NONE); // span 1 s < 1.5 s
      expect(evaluateTrigger(t, sample(2, 30, 5, 1.4), cfg)).toBe(TriggerVerdict.ENTER);
      expect(t.inside).toBe(true);
      expect(t.enteredAtMs).toBe(T0 + 2000);
      // a single deep fix (dEnter <= 17.5) enters at once
      const u: StopTrigger = new StopTrigger('q', 35);
      expect(evaluateTrigger(u, sample(0, 20, 5, 1.4), cfg)).toBe(TriggerVerdict.ENTER);
    });

    it('enter_streak_resets_when_a_fix_falls_outside', () => {
      const cfg: TourConfig = defaultTourConfig();
      const t: StopTrigger = new StopTrigger('p', 35);
      evaluateTrigger(t, sample(0, 30, 5, 1.4), cfg);
      evaluateTrigger(t, sample(1, 60, 5, 1.4), cfg);                                          // outside: reset
      expect(evaluateTrigger(t, sample(2, 30, 5, 1.4), cfg)).toBe(TriggerVerdict.NONE);
      expect(evaluateTrigger(t, sample(3, 30, 5, 1.4), cfg)).toBe(TriggerVerdict.NONE); // span 1 s
      expect(evaluateTrigger(t, sample(4, 30, 5, 1.4), cfg)).toBe(TriggerVerdict.ENTER);
    });

    it('acc_80_fixes_never_enter', () => {
      const cfg: TourConfig = defaultTourConfig();
      const t: StopTrigger = new StopTrigger('p', 35);
      for (let s = 0; s < 60; s++) {
        expect(evaluateTrigger(t, sample(s, 0, 80, 0), cfg)).toBe(TriggerVerdict.NONE);
      }
      // even if a caller wrongly marks it trigger-grade, accuracy > 40 is refused
      const bad: TriggerSample = { tMs: T0 + 61000, distanceM: 0, accuracyM: 80, speedMps: 0, triggerGrade: true };
      expect(evaluateTrigger(t, bad, cfg)).toBe(TriggerVerdict.NONE);
      expect(t.inside).toBe(false);
      expect(t.enterCount).toBe(0);
    });

    it('poor_fixes_neither_count_nor_reset', () => {
      const cfg: TourConfig = defaultTourConfig();
      const t: StopTrigger = new StopTrigger('p', 35);
      evaluateTrigger(t, sample(0, 30, 5, 1.4), cfg);
      evaluateTrigger(t, sample(1, 300, 80, 1.4), cfg);   // ignored, does not reset the streak
      expect(evaluateTrigger(t, sample(2, 30, 5, 1.4), cfg)).toBe(TriggerVerdict.ENTER);
      // and inside, a far poor fix cannot cause an exit
      for (let s = 3; s < 10; s++) {
        expect(evaluateTrigger(t, sample(s, 500, 90, 1.4), cfg)).toBe(TriggerVerdict.NONE);
      }
      expect(t.inside).toBe(true);
    });

    it('jitter_15m_at_radius_edge_enters_exactly_once', () => {
      // Standing at the 35 m edge, the reported distance jitters uniformly in 35 +- 15 m (acc 5 m) for 10 min.
      // Entry: dEnter = d - 5 reaches R; exit would need d + 5 > 56, i.e. d > 51, which the jitter never reaches.
      const cfg: TourConfig = defaultTourConfig();
      const t: StopTrigger = new StopTrigger('p', 35);
      const rnd: Lcg = new Lcg(20261003);
      const c: Counts = new Counts();
      for (let s = 0; s < 600; s++) {
        feed(t, sample(s, 35 + 15 * rnd.next(), 5, 0.3), cfg, c, s);
      }
      expect(c.enter).toBe(1);
      expect(c.exit).toBe(0);
      expect(c.firstEnterS).toBeLessThan(10);
    });

    it('exit_hysteresis_needs_1_6R_for_3_fixes', () => {
      const cfg: TourConfig = defaultTourConfig();
      const t: StopTrigger = new StopTrigger('p', 35);
      expect(evaluateTrigger(t, sample(0, 10, 5, 0), cfg)).toBe(TriggerVerdict.ENTER);
      // 50 m + 5 = 55 <= 56: still inside however long it lasts
      for (let s = 1; s <= 10; s++) {
        expect(evaluateTrigger(t, sample(s, 50, 5, 1.0), cfg)).toBe(TriggerVerdict.NONE);
      }
      // two fixes beyond, then one back inside: the streak resets
      expect(evaluateTrigger(t, sample(11, 60, 5, 1.0), cfg)).toBe(TriggerVerdict.NONE);
      expect(evaluateTrigger(t, sample(12, 60, 5, 1.0), cfg)).toBe(TriggerVerdict.NONE);
      expect(evaluateTrigger(t, sample(13, 40, 5, 1.0), cfg)).toBe(TriggerVerdict.NONE);
      expect(evaluateTrigger(t, sample(14, 60, 5, 1.0), cfg)).toBe(TriggerVerdict.NONE);
      expect(evaluateTrigger(t, sample(15, 60, 5, 1.0), cfg)).toBe(TriggerVerdict.NONE);
      expect(evaluateTrigger(t, sample(16, 60, 5, 1.0), cfg)).toBe(TriggerVerdict.EXIT);
      expect(t.inside).toBe(false);
      expect(t.exitCount).toBe(1);
    });

    it('walk_through_at_1_4mps_is_teaser_only', () => {
      // Straight line through the stop at 1.4 m/s, 1 Hz; the teaser (arrival line + teaser) takes 20 s.
      const cfg: TourConfig = defaultTourConfig();
      const t: StopTrigger = new StopTrigger('p', 35);
      const c: Counts = new Counts();
      const speeds: number[] = [];
      let decision: string = '';
      for (let s = 0; s <= 180; s++) {
        const x: number = -126 + 1.4 * s;
        feed(t, sample(s, Math.abs(x), 8, 1.4), cfg, c, s);
        speeds.push(1.4);
        if (c.firstEnterS >= 0 && s === c.firstEnterS + 20) {
          decision = decideStoryLength(t, median(speeds.slice(-5)), true, false, cfg);
          expect(t.inside).toBe(true);   // still inside 1.6 R: "inside" alone must not mean "full"
        }
      }
      expect(decision).toBe(StoryLength.TEASER_ONLY);
      expect(c.enter).toBe(1);
      expect(c.exit).toBe(1);
      expect(t.slowDwellMs).toBe(0);
      // after the exit the decision stays teaser only
      expect(decideStoryLength(t, 0, true, false, cfg)).toBe(StoryLength.TEASER_ONLY);
    });

    it('stopping_40s_at_the_stop_is_full', () => {
      const cfg: TourConfig = defaultTourConfig();
      const t: StopTrigger = new StopTrigger('p', 35);
      const c: Counts = new Counts();
      const speeds: number[] = [];
      let s: number = 0;
      for (let x = -100; x < -10; x += 1.4) {          // walk in
        feed(t, sample(s, Math.abs(x), 8, 1.4), cfg, c, s);
        speeds.push(1.4);
        s++;
      }
      for (let k = 0; k < 40; k++) {                   // stand still 40 s, 10 m from the stop
        feed(t, sample(s, 10, 8, 0.1), cfg, c, s);
        speeds.push(0.1);
        s++;
      }
      expect(c.enter).toBe(1);
      expect(t.slowDwellMs).toBeGreaterThanOrEqual(8000);
      expect(decideStoryLength(t, median(speeds.slice(-5)), true, false, cfg)).toBe(StoryLength.FULL);
      // dwell alone also proves the stop when the median is still high (e.g. a short pause between strides)
      expect(decideStoryLength(t, 1.2, true, false, cfg)).toBe(StoryLength.FULL);
    });

    it('length_overrides', () => {
      const cfg: TourConfig = defaultTourConfig();
      const t: StopTrigger = new StopTrigger('p', 35);
      evaluateTrigger(t, sample(0, 5, 5, 1.4), cfg);
      expect(decideStoryLength(t, 1.4, true, false, cfg)).toBe(StoryLength.TEASER_ONLY);
      expect(decideStoryLength(t, 1.4, false, false, cfg)).toBe(StoryLength.FULL);  // adaptive off
      expect(decideStoryLength(t, 1.4, true, true, cfg)).toBe(StoryLength.FULL);    // USER_MORE
      expect(decideStoryLength(t, Number.NaN, true, false, cfg)).toBe(StoryLength.FULL); // speed unknown
    });
    it('linger_approach_while_moving_then_stop_is_full', () => {
      // x1 replay shape: the zone is entered ~40 m out at 1.3 m/s, the teaser ends 10 s later 27 m out; the walker
      // goes on to 4 m from the stop and stands there. The teaser end alone would say teaser (old behaviour).
      const w: Walker = new Walker();
      let x: number = -100;
      let askedAtTeaserEnd: string = '';
      while (x < -4) {
        w.fix(Math.abs(x), 8, 1.3);
        if (w.s - 1 === w.teaserEndS) {
          askedAtTeaserEnd = decideStoryLength(w.t, w.median(), true, false, w.cfg);
          expect(decideAfterTeaser(w.t, w.input(0), w.cfg).length).toBe(StoryLength.UNDECIDED);
        }
        x += 1.3;
      }
      const stopS: number = w.s;
      for (let k = 0; k < 40; k++) {
        w.fix(4, 8, 0.1);
      }
      expect(askedAtTeaserEnd).toBe(StoryLength.TEASER_ONLY);   // why the replay's dwell stops got teasers
      expect(w.length()).toBe(StoryLength.FULL);
      expect(w.reason()).toBe('still');
      expect(w.verdictS >= stopS && w.verdictS <= stopS + 8).toBe(true);   // a few seconds after standing still
      expect(w.c.enter).toBe(1);
      expect(w.c.exit).toBe(0);
    });

    it('linger_approach_and_walk_past_is_teaser', () => {
      const w: Walker = new Walker();
      let closestS: number = -1;
      for (let x = -100; x <= 100; x += 1.3) {
        if (closestS < 0 && x >= 0) {
          closestS = w.s;
        }
        w.fix(Math.abs(x), 8, 1.3);
      }
      expect(w.length()).toBe(StoryLength.TEASER_ONLY);
      expect(w.reason()).toBe('receding');
      expect(w.verdictS > closestS && w.verdictS <= closestS + 20).toBe(true);   // soon after passing
      expect(w.verdictDistanceM >= w.cfg.lingerRecedeM).toBe(true);
    });

    it('linger_gps_jitter_while_standing_is_still_full', () => {
      // Stands 8 m from the stop after the approach; the fix wanders +-10 m and the reported speed jumps up to
      // 0.9 m/s now and then (single spikes), as a phone standing in a street canyon does.
      const w: Walker = new Walker();
      const rnd: Lcg = new Lcg(60);
      for (let x = -100; x < -8; x += 1.3) {
        w.fix(Math.abs(x), 8, 1.3);
      }
      let spikes: number = 0;
      for (let k = 0; k < 60; k++) {
        const spike: boolean = k % 7 === 3;
        spikes += spike ? 1 : 0;
        w.fix(Math.max(0, 8 + 10 * rnd.next()), 12 + 3 * rnd.next(), spike ? 0.9 : 0.25 + 0.2 * rnd.next());
      }
      expect(spikes > 5).toBe(true);
      expect(w.length()).toBe(StoryLength.FULL);
      expect(w.c.enter).toBe(1);
      expect(w.c.exit).toBe(0);
      // the jitter never looked like walking on: not receding beyond the threshold while standing
      expect(w.t.recedeM < w.cfg.lingerRecedeM).toBe(true);
    });

    it('linger_walking_around_without_getting_closer_is_teaser_after_the_window', () => {
      const w: Walker = new Walker();
      for (let x = -100; x < -20; x += 1.3) {
        w.fix(Math.abs(x), 8, 1.3);
      }
      const circleS: number = w.s;
      for (let k = 0; k < 60; k++) {                    // keeps walking at ~20 m from the stop (round the square)
        w.fix(20 + (k % 2), 8, 1.2);
      }
      expect(w.length()).toBe(StoryLength.TEASER_ONLY);
      expect(w.reason()).toBe('window');
      expect(w.verdictS - circleS >= w.cfg.lingerWindowS - 1 && w.verdictS - circleS <= w.cfg.lingerWindowS + 2)
        .toBe(true);
    });

    it('linger_short_slow_down_while_passing_is_not_a_stop', () => {
      // Replay stop 9 shape: slows to 0.3-0.4 m/s for 3 s at the corner next to the stop, then walks on.
      const w: Walker = new Walker();
      for (let x = -60; x < 0; x += 1.1) {
        w.fix(Math.abs(x), 6, 1.1);
      }
      w.fix(2, 6, 0.4);
      w.fix(3, 6, 0.4);
      w.fix(3, 6, 0.3);
      for (let x = 4; x < 80; x += 1.1) {
        w.fix(x, 6, 1.1);
      }
      expect(w.length()).toBe(StoryLength.TEASER_ONLY);
      expect(w.t.slowDwellMs < w.cfg.fullStoryDwellS * 1000).toBe(true);
    });

    it('linger_bounds_and_overrides', () => {
      const cfg: TourConfig = defaultTourConfig();
      const t: StopTrigger = new StopTrigger('p', 35);
      evaluateTrigger(t, sample(0, 30, 5, 1.3), cfg);     // two inside fixes 2 s apart => ENTER
      evaluateTrigger(t, sample(2, 28, 5, 1.3), cfg);
      expect(t.inside).toBe(true);
      const inp: LingerInput = {
        speedMedianMps: 1.3, slowForMs: 0, waitedMs: 5000, adaptiveLength: true, userAskedMore: false
      };
      expect(decideAfterTeaser(t, inp, cfg).length).toBe(StoryLength.UNDECIDED);
      inp.waitedMs = cfg.lingerMaxS * 1000;                // safety bound
      expect(decideAfterTeaser(t, inp, cfg).reason).toBe('maxWait');
      inp.waitedMs = 5000;
      inp.userAskedMore = true;                            // "Tell me more" during the silence
      expect(decideAfterTeaser(t, inp, cfg).length).toBe(StoryLength.FULL);
      inp.userAskedMore = false;
      inp.speedMedianMps = 0.3;                            // slow, but not for lingerStillS yet
      inp.slowForMs = 2000;
      expect(decideAfterTeaser(t, inp, cfg).length).toBe(StoryLength.UNDECIDED);
      inp.slowForMs = cfg.lingerStillS * 1000;
      expect(decideAfterTeaser(t, inp, cfg).reason).toBe('still');
      inp.waitedMs = 0;                                    // at the teaser's end the plain median decides
      inp.slowForMs = 0;
      expect(decideAfterTeaser(t, inp, cfg).reason).toBe('slow');
    });
  });
}

triggerPolicyTest();
