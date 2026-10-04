// Suite: HudRows.test - module under test: core/hud/HudRows (task B12, "How it works" HUD).
// Every row shows only snapshot values or "n/a"; the Demo walk is SIMULATED; Fallback/Studio voice labels; A9 route
// state; the trigger radii match what TourEngine actually builds (cross-check against the reducer).
import { describe, it, expect } from 'vitest';
import {
  HudInput, HudRow, HudTone, hudDegrees, hudDistance, hudRows, hudSignedDegrees, hudSpeed, NA, serverRow, TriggerRadii,
  triggerRadii
} from '../src';
import { TourConfig } from '../src';
import { TourEngine, TourInput, TourState } from '../src';
import {
  EngineEvent, EngineEventType, EngineSnapshot, PlatformStatus, RelDir, SignalQuality, TourPhase, TourPlan
} from '../src';
import { ContentTier, Lang, Narration, NarrationLength, Poi, Tour } from '../src';
import { FixSource, VoicePlan } from '../src';
import { VoiceLabel } from '../src';
import {
  MINI_BARBICAN, MINI_CLOTH_HALL, MINI_PERSONA_ID, MINI_ST_MARYS, MINI_TOUR_ID, miniPois, miniTour
} from './fixtures/MiniPack';

function platform(): PlatformStatus {
  const p: PlatformStatus = {
    bgRunning: true, avsActive: true, ttsEngine: 'zh-CN/13', sourceKind: FixSource.REAL, realGpsAccuracyM: Number.NaN,
    demoHold: false
  };
  return p;
}

function snap(): EngineSnapshot {
  const s: EngineSnapshot = {
    phase: TourPhase.WALKING, tourId: MINI_TOUR_ID, stops: [], currentStopIdx: 0,
    next: {
      poiId: MINI_ST_MARYS, distanceM: 180.4, etaS: 139, relDir: RelDir.AHEAD_RIGHT, bearingDeg: 230,
      maneuverText: 'In 40 metres, turn left', maneuverDistM: 41
    },
    user: {
      x: 0, y: 0, lat: 50.0617, lng: 19.9373, accuracyM: 6.2, courseDeg: 212, speedMps: 1.34, source: FixSource.REAL
    },
    signal: SignalQuality.GOOD, offRoute: false, paused: false, speechText: false, plannedOrder: [], walkedM: 0,
    remainingM: 0, issues: [], voiceLabel: VoiceLabel.FALLBACK_ZH_READS_EN, source: FixSource.REAL, platform: platform()
  };
  return s;
}

function find(rows: HudRow[], key: string): HudRow {
  for (const r of rows) {
    if (r.key === key) {
      return r;
    }
  }
  const none: HudRow = { key: key, label: '', value: '<missing>', tone: HudTone.NA };
  return none;
}

function rows(s: EngineSnapshot | undefined, t?: TriggerRadii): HudRow[] {
  return hudRows({ snap: s, nextName: 'St Mary\'s Basilica', demoSpeed: 4, trigger: t });
}

function contains(hay: string, needle: string): boolean {
  return hay.indexOf(needle) >= 0;
}

/** Builds the engine's stops for one tour through the real reducer (START_PLANNING -> PLAN_READY). */
function engineStops(tour: Tour, pois: Poi[], cfg: TourConfig): TourState {
  const v: VoicePlan = {
    textLang: Lang.EN, speechMode: 'text', engineLocale: '', person: 0, languageContext: '',
    label: VoiceLabel.TEXT_ONLY_USER, reason: 'test'
  };
  const inp: TourInput = {
    tour: tour, pois: pois, lang: Lang.EN, personaId: MINI_PERSONA_ID,
    narration: (poiId: string, len: NarrationLength): Narration | undefined => undefined,
    voice: v, adaptiveLength: true, spokenDirections: true, source: FixSource.DEMO
  };
  let st: TourState = TourEngine.init(inp, cfg);
  const e1: EngineEvent = { type: EngineEventType.START_PLANNING, nowMs: 1000 };
  st = TourEngine.reduce(st, e1).state;
  const plan: TourPlan = {
    tourId: tour.id, order: tour.stops.map(s => s.poiId), costS: 1, walkM: 1, savedM: 0, exact: true,
    algo: 'heldkarp', ms: 1, budgetS: 0, legs: []
  };
  const e2: EngineEvent = { type: EngineEventType.PLAN_READY, nowMs: 1000, plan: plan };
  return TourEngine.reduce(st, e2).state;
}

function hudRowsTest() {
  describe('HudRows', () => {
    it('formats_units_and_na', () => {
      expect(hudDistance(180.4)).toBe('180 m');
      expect(hudDistance(1234)).toBe('1.2 km');
      expect(hudDistance(Number.NaN)).toBe(NA);
      expect(hudDistance(-1)).toBe(NA);
      expect(hudDegrees(212.4)).toBe('212°');
      expect(hudDegrees(359.7)).toBe('0°');
      expect(hudDegrees(-10)).toBe('350°');
      expect(hudDegrees(Number.NaN)).toBe(NA);
      expect(hudSignedDegrees(18.2)).toBe('+18°');
      expect(hudSignedDegrees(-34)).toBe('-34°');
      expect(hudSignedDegrees(Number.NaN)).toBe(NA);
      expect(hudSpeed(1.34)).toBe('1.3 m/s');
      expect(hudSpeed(Number.NaN)).toBe(NA);
    });
    it('server_row_optional', () => {
      const base: HudInput = { snap: snap(), nextName: 'x', demoSpeed: 4, trigger: undefined };
      expect(hudRows(base).length).toBe(8);
      const on: HudInput = { snap: snap(), nextName: 'x', demoSpeed: 4, trigger: undefined,
        server: 'server online · online voice on · 3 lines cached' };
      const r = hudRows(on);
      expect(r.length).toBe(9);
      expect(find(r, 'server').tone).toBe(HudTone.OK);
      expect(serverRow('server offline · online voice on · 0 lines cached').tone).toBe(HudTone.WARN);
      expect(serverRow('server budget reached · online voice on · 0 lines cached').tone).toBe(HudTone.WARN);
      expect(serverRow('server disabled').tone).toBe(HudTone.OFF);
      expect(serverRow('').value).toBe(NA);
    });
    it('no_snapshot_is_all_na', () => {
      const r = rows(undefined);
      expect(r.length).toBe(8);
      for (const x of r) {
        expect(x.value).toBe(NA);
        expect(x.tone).toBe(HudTone.NA);
      }
    });
    it('real_source_rows', () => {
      const r = rows(snap(), { arriveM: 35, approachM: 110 });
      expect(r.length).toBe(8);
      expect(find(r, 'location').value).toBe('Location Kit · ±6 m');
      expect(find(r, 'location').tone).toBe(HudTone.OK);
      expect(find(r, 'course').value).toBe('212° · 1.3 m/s');
      // bearing 230 vs course 212 => +18 relative
      expect(find(r, 'next').value).toBe('St Mary\'s Basilica · 180 m · brg 230° (+18°)');
      expect(find(r, 'trigger').value).toBe('approach 110 m · arrive 35 m');
      expect(find(r, 'route').value).toBe('on route · cue in 41 m: In 40 metres, turn left');
      const near = snap();
      near.phase = TourPhase.APPROACHING;
      expect(find(rows(near, { arriveM: 35, approachM: 110 }), 'trigger').value)
        .toBe('approach 110 m · arrive 35 m · approaching');
      expect(find(r, 'voice').value).toBe('Fallback voice (zh-CN reads EN) · Core Speech zh-CN/13 · idle');
      expect(find(r, 'voice').tone).toBe(HudTone.WARN);
      expect(find(r, 'session').value).toBe('AVSession active · playing');
      expect(find(r, 'background').value).toBe('LOCATION + AUDIO_PLAYBACK running');
    });
    it('demo_source_is_simulated_with_shadow_gps', () => {
      const s = snap();
      s.source = FixSource.DEMO;
      s.platform.demoHold = true;
      let loc = find(rows(s), 'location');
      expect(contains(loc.value, 'SIMULATED')).toBe(true);
      expect(contains(loc.value, '4×')).toBe(true);
      expect(contains(loc.value, 'holding')).toBe(true);
      expect(contains(loc.value, `real GPS ${NA}`)).toBe(true);
      expect(loc.tone).toBe(HudTone.SIM);
      s.platform.realGpsAccuracyM = 12.4;
      loc = find(rows(s), 'location');
      expect(contains(loc.value, 'real GPS ±12 m')).toBe(true);
    });
    it('unknown_values_show_na', () => {
      const s = snap();
      s.user = undefined;
      s.next = undefined;
      s.platform.ttsEngine = 'none';
      s.platform.avsActive = false;
      s.platform.bgRunning = false;
      const r = rows(s);
      expect(find(r, 'location').value).toBe(`Location Kit · accuracy ${NA}`);
      expect(find(r, 'course').value).toBe(`${NA} · ${NA}`);
      expect(find(r, 'next').value).toBe(NA);
      expect(find(r, 'trigger').value).toBe(`approach ${NA} · arrive ${NA}`);
      expect(find(r, 'route').value).toBe(`on route · cue ${NA}`);
      expect(contains(find(r, 'voice').value, `Core Speech ${NA}`)).toBe(true);
      expect(find(r, 'session').tone).toBe(HudTone.OFF);
      expect(find(r, 'background').value).toBe('continuous task not running');
    });
    it('next_without_course_has_no_relative_bearing', () => {
      const s = snap();
      if (s.user !== undefined) {
        s.user.courseDeg = Number.NaN;
      }
      expect(find(rows(s), 'next').value).toBe('St Mary\'s Basilica · 180 m · brg 230°');
      expect(find(rows(s), 'course').tone).toBe(HudTone.NA);
    });
    it('off_route_lost_signal_and_voice_states', () => {
      const s = snap();
      s.offRoute = true;
      s.signal = SignalQuality.LOST;
      s.voiceLabel = VoiceLabel.PRERENDERED;
      s.paused = true;
      s.nowPlaying = {
        itemId: 'a', poiId: MINI_ST_MARYS, kind: 'stopStory', sentenceIndex: 0, sentenceCount: 3, caption: 'x',
        tier: ContentTier.REVIEWED_HISTORIAN, lang: Lang.EN
      };
      const r = rows(s);
      expect(contains(find(r, 'route').value, 'OFF ROUTE')).toBe(true);
      expect(find(r, 'route').tone).toBe(HudTone.WARN);
      expect(find(r, 'location').tone).toBe(HudTone.OFF);
      expect(find(r, 'voice').value).toBe('Studio voice (pre-recorded) · Core Speech zh-CN/13 for other lines · paused');
      expect(find(r, 'session').value).toBe('AVSession active · paused');
      s.platform.ttsEngine = 'clips';
      expect(find(rows(s), 'voice').value).toBe('Studio voice (pre-recorded) · clips only, no TTS · paused');
      s.platform.ttsEngine = 'zh-CN/13';
      s.voiceLabel = VoiceLabel.TEXT_ONLY_USER;
      s.paused = false;
      s.speechText = true;
      expect(find(rows(s), 'voice').value).toBe('text only (your choice) · Core Speech zh-CN/13 · showing text');
      expect(find(rows(s), 'voice').tone).toBe(HudTone.OFF);
    });
    it('trigger_radii_match_the_engine', () => {
      const tour = miniTour();
      tour.stops[1].triggerRadiusM = 50;      // tour stop override
      tour.stops[2].approachRadiusM = 60;     // below arrive + 30 => clamped
      const pois = miniPois();
      for (const scale of [1, 0.57, 1.43]) {
        const cfg = new TourConfig();
        cfg.triggerRadiusScale = scale;
        const st = engineStops(tour, pois, cfg);
        expect(st.stops.length).toBe(3);
        for (const rt of st.stops) {
          const ts = tour.stops.find(s => s.poiId === rt.poiId);
          const poi = pois.find(p => p.id === rt.poiId);
          const t = triggerRadii(ts, poi, cfg);
          expect(t === undefined).toBe(false);
          expect(t?.arriveM).toBe(rt.trigger.triggerRadiusM);
          expect(t?.approachM).toBe(rt.approachRadiusM);
        }
      }
      expect(triggerRadii(undefined, undefined, new TourConfig()) === undefined).toBe(true);
      const p = pois.find(x => x.id === MINI_BARBICAN);
      expect(triggerRadii(undefined, p, new TourConfig())?.arriveM).toBe(35);
      expect(triggerRadii(tour.stops[2], pois.find(x => x.id === MINI_CLOTH_HALL), new TourConfig())?.approachM)
        .toBe(65);
    });
  });
}

hudRowsTest();
