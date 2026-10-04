// Suite: Settings.test - module under test: core/settings/SettingsRules (task B9), plus the two engine knobs the
// Settings rows drive: TourConfig.triggerRadiusScale (trigger distance) and LingerInput.briefOnly (detail level).
import { describe, it, expect } from 'vitest';
import { Lang } from '../src';
import { EngineEvent, EngineEventType, TourPlan } from '../src';
import { FixSource, VoicePlan } from '../src';
import { EnVoiceStrategy, UiLang, VoiceLabel, VoiceLang } from '../src';
import {
  DetailLevel, detailKnobs, detailLevelOf, megabytes, normalizeSpeed, normalizeTriggerM, packLine, STORY_LANGS,
  StoryLang, storyLangOf, storyLangPair, StrategyChoice, strategyChoiceOf, strategyFor, triggerScale, uiLangOf,
  uiLangTag, validStrategy, VoiceRow, voiceRowFor
} from '../src';
import { TourConfig } from '../src';
import { TourEngine, TourInput, TourState } from '../src';
import { decideAfterTeaser, LingerInput, StopTrigger, StoryLength } from '../src';
import { MINI_BARBICAN, MINI_CLOTH_HALL, MINI_PERSONA_ID, MINI_ST_MARYS, MINI_TOUR_ID, miniPois, miniTour } from './fixtures/MiniPack';

function voicePlan(): VoicePlan {
  const v: VoicePlan = {
    textLang: Lang.EN, speechMode: 'text', engineLocale: '', person: 0, languageContext: '',
    label: VoiceLabel.TEXT_ONLY_USER, reason: 'test'
  };
  return v;
}

/** Radii of the planned stops after PLAN_READY with the given scale. */
function plannedRadii(scale: number): number[] {
  const inp: TourInput = {
    tour: miniTour(), pois: miniPois(), lang: Lang.EN, personaId: MINI_PERSONA_ID,
    narration: () => undefined, voice: voicePlan(), adaptiveLength: true, spokenDirections: true,
    source: FixSource.DEMO
  };
  const cfg = new TourConfig();
  cfg.triggerRadiusScale = scale;
  let st: TourState = TourEngine.init(inp, cfg);
  const e0: EngineEvent = { type: EngineEventType.START_PLANNING, nowMs: 1000 };
  st = TourEngine.reduce(st, e0).state;
  const p: TourPlan = {
    tourId: MINI_TOUR_ID, order: [MINI_BARBICAN, MINI_ST_MARYS, MINI_CLOTH_HALL], costS: 900, walkM: 700,
    savedM: 0, exact: true, algo: 'heldkarp', ms: 1, budgetS: 0, legs: []
  };
  const e1: EngineEvent = { type: EngineEventType.PLAN_READY, nowMs: 1000, plan: p };
  st = TourEngine.reduce(st, e1).state;
  return st.stops.map((s) => s.trigger.triggerRadiusM);
}

function linger(adaptive: boolean, brief: boolean, askedMore: boolean): LingerInput {
  const i: LingerInput = {
    speedMedianMps: 0.2, slowForMs: 0, waitedMs: 0, adaptiveLength: adaptive, userAskedMore: askedMore,
    briefOnly: brief
  };
  return i;
}

function insideStop(): StopTrigger {
  const t = new StopTrigger('p', 35);
  t.inside = true;
  return t;
}

function settingsTest() {
  describe('Settings', () => {
    it('story_language_rows_map_to_text_and_voice_and_back', () => {
      for (const s of STORY_LANGS) {
        const p = storyLangPair(s);
        expect(storyLangOf(p.textLang, p.voiceLang) as string).toBe(s);
      }
      const listen = storyLangPair(StoryLang.PL_LISTEN_EN);
      expect(listen.textLang as string).toBe(Lang.PL);
      expect(listen.voiceLang as string).toBe(VoiceLang.EN);
      expect(storyLangPair(StoryLang.PL).voiceLang as string).toBe(VoiceLang.OFF);
      expect(storyLangPair(StoryLang.ZH).voiceLang as string).toBe(VoiceLang.ZH);
      expect(storyLangOf('xx', 'en') as string).toBe(StoryLang.EN);
      expect(storyLangOf('pl', 'zh') as string).toBe(StoryLang.PL);   // no row for pl + zh: text-only row
    });

    it('app_language_tags_for_setAppPreferredLanguage', () => {
      expect(uiLangTag(UiLang.SYSTEM)).toBe('default');
      expect(uiLangTag(UiLang.EN)).toBe('en-US');
      expect(uiLangTag(UiLang.PL)).toBe('pl-PL');
      expect(uiLangTag(UiLang.ZH)).toBe('zh-Hans');
      expect(uiLangTag('??')).toBe('default');
      expect(uiLangOf('pl') as string).toBe(UiLang.PL);
      expect(uiLangOf('de') as string).toBe(UiLang.SYSTEM);
    });

    it('strategy_picker_round_trip_and_unknown_values', () => {
      expect(strategyFor(StrategyChoice.AUTO) as string).toBe(EnVoiceStrategy.AUTO_NATIVE_THEN_ZH);
      expect(strategyFor(StrategyChoice.ZH) as string).toBe(EnVoiceStrategy.FORCE_ZH);
      expect(strategyFor(StrategyChoice.TEXT) as string).toBe(EnVoiceStrategy.TEXT_ONLY);
      expect(strategyChoiceOf(EnVoiceStrategy.FORCE_ZH) as string).toBe(StrategyChoice.ZH);
      expect(strategyChoiceOf(EnVoiceStrategy.TEXT_ONLY) as string).toBe(StrategyChoice.TEXT);
      expect(strategyChoiceOf(EnVoiceStrategy.AUTO_NATIVE_THEN_TEXT) as string).toBe(StrategyChoice.AUTO);
      expect(validStrategy('bogus', EnVoiceStrategy.AUTO_NATIVE_THEN_ZH) as string)
        .toBe(EnVoiceStrategy.AUTO_NATIVE_THEN_ZH);
      expect(validStrategy('force-zh', EnVoiceStrategy.AUTO_NATIVE_THEN_ZH) as string)
        .toBe(EnVoiceStrategy.FORCE_ZH);
    });

    it('voice_row_is_honest_about_what_is_heard', () => {
      expect(voiceRowFor(VoiceLabel.NATIVE, 'en-US') as string).toBe(VoiceRow.LAURA);
      expect(voiceRowFor(VoiceLabel.NATIVE, 'zh-CN') as string).toBe(VoiceRow.ZH);
      expect(voiceRowFor(VoiceLabel.FALLBACK_ZH_READS_EN, 'zh-CN') as string).toBe(VoiceRow.FALLBACK);
      expect(voiceRowFor(VoiceLabel.TEXT_ONLY_USER, '') as string).toBe(VoiceRow.TEXT_USER);
      expect(voiceRowFor(VoiceLabel.TEXT_ONLY_PLATFORM, '') as string).toBe(VoiceRow.TEXT_PLATFORM);
      expect(voiceRowFor(VoiceLabel.PRERENDERED, '') as string).toBe(VoiceRow.PRERENDERED);
    });

    it('detail_levels_drive_real_engine_knobs', () => {
      const b = detailKnobs(DetailLevel.BRIEF);
      expect(b.briefOnly).toBe(true);
      const s = detailKnobs(DetailLevel.STANDARD);
      expect(s.adaptiveLength).toBe(true);
      expect(s.briefOnly).toBe(false);
      const d = detailKnobs(DetailLevel.DEEP);
      expect(d.adaptiveLength).toBe(false);
      expect(d.briefOnly).toBe(false);
      expect(detailLevelOf('deep') as string).toBe(DetailLevel.DEEP);
      expect(detailLevelOf('') as string).toBe(DetailLevel.STANDARD);
    });

    it('brief_gives_the_teaser_even_when_standing_unless_asked_for_more', () => {
      const cfg = new TourConfig();
      const standing = decideAfterTeaser(insideStop(), linger(true, false, false), cfg);
      expect(standing.length as string).toBe(StoryLength.FULL);
      const brief = decideAfterTeaser(insideStop(), linger(true, true, false), cfg);
      expect(brief.length as string).toBe(StoryLength.TEASER_ONLY);
      expect(brief.reason).toBe('brief');
      const more = decideAfterTeaser(insideStop(), linger(true, true, true), cfg);
      expect(more.length as string).toBe(StoryLength.FULL);
      const deep = decideAfterTeaser(insideStop(), linger(false, false, false), cfg);
      expect(deep.length as string).toBe(StoryLength.FULL);
    });

    it('trigger_distance_scales_the_curated_radii', () => {
      expect(normalizeTriggerM(22)).toBe(20);
      expect(normalizeTriggerM(Number.NaN)).toBe(35);
      expect(normalizeTriggerM(100)).toBe(50);
      expect(triggerScale(35)).toBe(1);
      expect(Math.abs(triggerScale(20) - 20 / 35) < 1e-9).toBe(true);
      const base = plannedRadii(1);
      expect(base.length).toBe(3);
      const wide = plannedRadii(triggerScale(50));
      const tight = plannedRadii(triggerScale(20));
      for (let i = 0; i < base.length; i++) {
        expect(wide[i]).toBe(Math.round(base[i] * 50 / 35));
        expect(tight[i]).toBe(Math.round(base[i] * 20 / 35));
      }
      expect(plannedRadii(0)[0]).toBe(base[0]);   // a broken scale keeps the curated radius
    });

    it('demo_speed_and_pack_line', () => {
      expect(normalizeSpeed(3)).toBe(2);
      expect(normalizeSpeed(8)).toBe(8);
      expect(normalizeSpeed(Number.NaN)).toBe(4);
      expect(megabytes(0)).toBe(0);
      expect(megabytes(1024)).toBe(0.1);
      expect(megabytes(5 * 1024 * 1024 + 300000)).toBe(5.3);
      expect(megabytes(48 * 1024 * 1024)).toBe(48);
      const l = packLine(3412, 11, [1024 * 1024, Number.NaN, -5, 1024 * 1024]);
      expect(l.places).toBe(3412);
      expect(l.stories).toBe(11);
      expect(l.sizeMb).toBe(2);
      expect(packLine(-1, Number.NaN, []).sizeMb).toBe(0);
    });
  });
}

settingsTest();
