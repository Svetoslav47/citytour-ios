// Suite: CueMap.test - module under test: core/haptics/CueMap (watch task W6, docs/research/WATCH.md §5).
// The four approved cues, their patterns (left = 2 pulses, right = 3), the arrival + look sequence, the silent
// APPROACH, and the CueGate rate limit.
import { describe, it, expect } from 'vitest';
import {
  ANY_CUE_GAP_MS, ARRIVAL_MS, Cue, CueGate, SAME_CUE_GAP_MS, SEQUENCE_GAP_MS, TimedCue, cuesFor, lookCueFor,
  patternFor, patternMs, schedule
} from '../src';
import { HapticKind, RelDir } from '../src';

function pulses(c: Cue): number {
  return Math.ceil(patternFor(c).length / 2);
}

function cueMapTest() {
  describe('CueMap', () => {
    it('patterns: arrival one long, left 2 short, right 3 short, off-route 2 long', () => {
      expect(JSON.stringify(patternFor(Cue.ARRIVAL))).toBe(JSON.stringify([ARRIVAL_MS]));
      expect(pulses(Cue.LOOK_LEFT)).toBe(2);
      expect(pulses(Cue.LOOK_RIGHT)).toBe(3);
      expect(pulses(Cue.OFF_ROUTE)).toBe(2);
      expect(patternFor(Cue.OFF_ROUTE)[0]).toBeGreaterThan(patternFor(Cue.LOOK_LEFT)[0]);
      expect(patternMs([80, 120, 80])).toBe(280);
    });

    it('look cue follows the stop side; ahead, behind, here and unknown give none', () => {
      expect(lookCueFor(RelDir.LEFT)).toBe(Cue.LOOK_LEFT);
      expect(lookCueFor(RelDir.AHEAD_LEFT)).toBe(Cue.LOOK_LEFT);
      expect(lookCueFor(RelDir.BEHIND_LEFT)).toBe(Cue.LOOK_LEFT);
      expect(lookCueFor(RelDir.RIGHT)).toBe(Cue.LOOK_RIGHT);
      expect(lookCueFor(RelDir.AHEAD_RIGHT)).toBe(Cue.LOOK_RIGHT);
      expect(lookCueFor(RelDir.BEHIND_RIGHT)).toBe(Cue.LOOK_RIGHT);
      expect(lookCueFor(RelDir.AHEAD) === undefined).toBe(true);
      expect(lookCueFor(RelDir.BEHIND) === undefined).toBe(true);
      expect(lookCueFor(RelDir.HERE) === undefined).toBe(true);
      expect(lookCueFor(undefined) === undefined).toBe(true);
    });

    it('engine haptics map to cue sequences; approach stays silent', () => {
      expect(JSON.stringify(cuesFor(HapticKind.ARRIVE, RelDir.LEFT))).toBe(
        JSON.stringify([Cue.ARRIVAL, Cue.LOOK_LEFT]));
      expect(JSON.stringify(cuesFor(HapticKind.ARRIVE, RelDir.AHEAD))).toBe(JSON.stringify([Cue.ARRIVAL]));
      expect(JSON.stringify(cuesFor(HapticKind.FINISH, RelDir.RIGHT))).toBe(JSON.stringify([Cue.ARRIVAL]));
      expect(JSON.stringify(cuesFor(HapticKind.OFF_ROUTE, undefined))).toBe(JSON.stringify([Cue.OFF_ROUTE]));
      expect(cuesFor(HapticKind.APPROACH, RelDir.LEFT).length).toBe(0);
    });

    it('schedule: the look cue starts after the arrival buzz plus the sequence gap', () => {
      const s: TimedCue[] = schedule([Cue.ARRIVAL, Cue.LOOK_RIGHT]);
      expect(s.length).toBe(2);
      expect(s[0].atMs).toBe(0);
      expect(s[1].atMs).toBe(ARRIVAL_MS + SEQUENCE_GAP_MS);
      expect(s[1].pattern.length).toBe(5);
    });

    it('gate: no stacking, same cue at most once per window', () => {
      const g: CueGate = new CueGate();
      expect(g.allow(Cue.ARRIVAL, 0)).toBe(true);
      expect(g.allow(Cue.OFF_ROUTE, ANY_CUE_GAP_MS - 1)).toBe(false);
      expect(g.allow(Cue.OFF_ROUTE, ANY_CUE_GAP_MS)).toBe(true);
      expect(g.allow(Cue.OFF_ROUTE, ANY_CUE_GAP_MS + SAME_CUE_GAP_MS - 1)).toBe(false);
      expect(g.allow(Cue.OFF_ROUTE, ANY_CUE_GAP_MS + SAME_CUE_GAP_MS)).toBe(true);
    });

    it('gate: two stops close together both get their arrival (demo walk: 8 s apart)', () => {
      const g: CueGate = new CueGate();
      expect(g.allow(Cue.ARRIVAL, 0)).toBe(true);
      expect(g.allow(Cue.ARRIVAL, 8000)).toBe(true);
      expect(g.allow(Cue.ARRIVAL, 8000 + ANY_CUE_GAP_MS - 1)).toBe(false);
    });
  });
}

cueMapTest();
