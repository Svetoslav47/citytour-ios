// Suite: CardModel.test - module under test: core/widget/CardModel (task B14, home-screen "Next stop" card).
// Card content per engine phase (idle / heading / at a stop / complete / ended, SIMULATED flag) and the push policy
// (events only, distance-only pushes need >= 50 m and >= 10 s).
import { describe, it, expect } from 'vitest';
import {
  CARD_MIN_INTERVAL_MS, CardMode, CardState, cardStateFor, shouldPushCard
} from '../src';
import {
  EngineSnapshot, PlatformStatus, RelDir, SignalQuality, StopProgress, StopStatus, TourPhase
} from '../src';
import { FixSource } from '../src';
import { VoiceLabel } from '../src';

function platform(): PlatformStatus {
  const p: PlatformStatus = {
    bgRunning: true, avsActive: true, ttsEngine: 'zh-CN/13', sourceKind: FixSource.REAL, realGpsAccuracyM: Number.NaN,
    demoHold: false
  };
  return p;
}

function stop(id: string, status: StopStatus): StopProgress {
  const p: StopProgress = { poiId: id, order: 0, status: status };
  return p;
}

function snap(phase: TourPhase, distanceM: number): EngineSnapshot {
  const s: EngineSnapshot = {
    phase: phase, tourId: 'royal-route',
    stops: [stop('a', StopStatus.VISITED), stop('b', StopStatus.PENDING), stop('c', StopStatus.PENDING)],
    currentStopIdx: 1,
    next: {
      poiId: 'b', distanceM: distanceM, etaS: 100, relDir: RelDir.AHEAD, bearingDeg: 0, maneuverText: '',
      maneuverDistM: 0
    },
    signal: SignalQuality.GOOD, offRoute: false, paused: false, speechText: false, plannedOrder: ['a', 'b', 'c'],
    walkedM: 0, remainingM: 0, issues: [], voiceLabel: VoiceLabel.NATIVE, source: FixSource.DEMO, platform: platform()
  };
  return s;
}

function cardModelTest() {
  describe('CardModel', () => {
    it('idle_without_a_tour', () => {
      expect(cardStateFor(undefined).mode).toBe(CardMode.IDLE);
      const ready = cardStateFor(snap(TourPhase.READY, 100));
      expect(ready.mode).toBe(CardMode.IDLE);
      expect(ready.poiId).toBe('');
      expect(ready.demo).toBe(false);
    });
    it('heading_shows_next_stop_rounded_distance_and_simulated', () => {
      const c = cardStateFor(snap(TourPhase.WALKING, 183));
      expect(c.mode).toBe(CardMode.HEADING);
      expect(c.poiId).toBe('b');
      expect(c.stopNumber).toBe(2);
      expect(c.totalStops).toBe(3);
      expect(c.visited).toBe(1);
      expect(c.distanceM).toBe(180);
      expect(c.demo).toBe(true);
      expect(cardStateFor(snap(TourPhase.APPROACHING, 1234)).distanceM).toBe(1200);
    });
    it('at_stop_complete_and_ended', () => {
      const at = cardStateFor(snap(TourPhase.AT_STOP, 5));
      expect(at.mode).toBe(CardMode.AT_STOP);
      expect(at.poiId).toBe('b');
      expect(Number.isNaN(at.distanceM)).toBe(true);
      expect(cardStateFor(snap(TourPhase.FINISHED, 0)).mode).toBe(CardMode.COMPLETE);
      const ended = cardStateFor(snap(TourPhase.ABORTED, 0));
      expect(ended.mode).toBe(CardMode.ENDED);
      expect(ended.visited).toBe(1);
    });
    it('pushes_on_events_not_on_every_fix', () => {
      const a = cardStateFor(snap(TourPhase.WALKING, 400));
      expect(shouldPushCard(undefined, a, 0, 0)).toBe(true);
      expect(shouldPushCard(a, cardStateFor(snap(TourPhase.WALKING, 405)), 0, 60000)).toBe(false); // same 400
      // 40 m closer: below the step.
      expect(shouldPushCard(a, cardStateFor(snap(TourPhase.WALKING, 360)), 0, 60000)).toBe(false);
      // 60 m closer: pushes, but not within 10 s of the last push.
      const b = cardStateFor(snap(TourPhase.WALKING, 340));
      expect(shouldPushCard(a, b, 1000, 1000 + CARD_MIN_INTERVAL_MS - 1)).toBe(false);
      expect(shouldPushCard(a, b, 1000, 1000 + CARD_MIN_INTERVAL_MS)).toBe(true);
      // Arrival (mode change) pushes at once.
      expect(shouldPushCard(a, cardStateFor(snap(TourPhase.AT_STOP, 0)), 1000, 1001)).toBe(true);
    });
    it('pause_and_simulated_flag_changes_push', () => {
      const a = cardStateFor(snap(TourPhase.WALKING, 400));
      const p = snap(TourPhase.WALKING, 400);
      p.paused = true;
      expect(shouldPushCard(a, cardStateFor(p), 0, 1)).toBe(true);
      const r = snap(TourPhase.WALKING, 400);
      r.source = FixSource.REAL;
      expect(shouldPushCard(a, cardStateFor(r), 0, 1)).toBe(true);
      const same: CardState = cardStateFor(snap(TourPhase.WALKING, 400));
      expect(a.sameAs(same)).toBe(true);
    });
  });
}

cardModelTest();
