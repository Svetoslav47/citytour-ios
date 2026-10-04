// Suite: VoicePolicy.test - module under test: core/speech/VoicePolicy (task A4).
// Matrix from PLAN A4 DoD: 4 strategies x en status INSTALLED/DOWNLOADABLE/UNAVAILABLE/ERROR x textLang en/zh/pl,
// plus zh-unavailable, voiceLang overrides, listVoices mapping and the caption/timing helpers.
import { describe, it, expect } from 'vitest';
import { Lang } from '../src';
import { EnVoiceStrategy, VoiceLabel, VoiceLang } from '../src';
import { SpeechCapabilities, VoicePlan, VoiceState } from '../src';
import {
  capsFromVoices, estimateReadingMs, mapVoiceStatus, pcmDurationMs, planLogKv, resolveVoicePlan, stripPauseMarkup,
  VoiceEntry
} from '../src';

const STRATEGIES: EnVoiceStrategy[] = [
  EnVoiceStrategy.AUTO_NATIVE_THEN_ZH, EnVoiceStrategy.AUTO_NATIVE_THEN_TEXT, EnVoiceStrategy.FORCE_ZH,
  EnVoiceStrategy.TEXT_ONLY
];
const EN_STATES: VoiceState[] = [VoiceState.INSTALLED, VoiceState.DOWNLOADABLE, VoiceState.UNAVAILABLE, VoiceState.ERROR];

// Expected label for English text, rows = STRATEGIES, columns = EN_STATES (zh voice installed).
const N: string = VoiceLabel.NATIVE;
const F: string = VoiceLabel.FALLBACK_ZH_READS_EN;
const TP: string = VoiceLabel.TEXT_ONLY_PLATFORM;
const TU: string = VoiceLabel.TEXT_ONLY_USER;
const EXPECTED_EN: string[][] = [
  [N, F, F, F],      // AUTO_NATIVE_THEN_ZH (DEFAULT, user decision)
  [N, TP, TP, TP],   // AUTO_NATIVE_THEN_TEXT (if gate G1 rejects the zh voice)
  [F, F, F, F],      // FORCE_ZH
  [TU, TU, TU, TU]   // TEXT_ONLY
];

function caps(en: VoiceState, zh: VoiceState): SpeechCapabilities {
  const c: SpeechCapabilities = { en: en, zh: zh };
  return c;
}

function checkShape(p: VoicePlan, label: string): void {
  expect(p.label as string).toBe(label);
  if (label === N || label === F) {
    expect(p.speechMode).toBe('voice');
  } else {
    expect(p.speechMode).toBe('text');
    expect(p.engineLocale).toBe('');
    expect(p.person).toBe(0);
  }
  if (label === F) {
    expect(p.engineLocale).toBe('zh-CN');
    expect(p.person).toBe(13);
  }
  expect(p.reason.length > 0).toBe(true);
}

function voicePolicyTest() {
  describe('VoicePolicy', () => {
    it('matrix_4_strategies_x_4_en_states_x_3_langs', () => {
      let n = 0;
      for (let si = 0; si < STRATEGIES.length; si++) {
        for (let ei = 0; ei < EN_STATES.length; ei++) {
          const c = caps(EN_STATES[ei], VoiceState.INSTALLED);
          // English
          const en = resolveVoicePlan(Lang.EN, STRATEGIES[si], c);
          checkShape(en, EXPECTED_EN[si][ei]);
          expect(en.textLang).toBe(Lang.EN);
          if (EXPECTED_EN[si][ei] === N) {
            expect(en.engineLocale).toBe('en-US');
            expect(en.person).toBe(8);
            expect(en.languageContext).toBe('en-US');
          }
          // Chinese: always the built-in zh voice, the EN strategy does not apply
          const zh = resolveVoicePlan(Lang.ZH, STRATEGIES[si], c);
          checkShape(zh, N);
          expect(zh.engineLocale).toBe('zh-CN');
          expect(zh.person).toBe(13);
          expect(zh.languageContext).toBe('zh-CN');
          // Polish: text only, platform limitation
          const pl = resolveVoicePlan(Lang.PL, STRATEGIES[si], c);
          checkShape(pl, TP);
          expect(pl.textLang).toBe(Lang.PL);
          n += 3;
        }
      }
      expect(n).toBe(48);
    });

    it('default_on_emulator_is_fallback_zh_with_reason', () => {
      const p = resolveVoicePlan(Lang.EN, EnVoiceStrategy.AUTO_NATIVE_THEN_ZH,
        caps(VoiceState.DOWNLOADABLE, VoiceState.INSTALLED));
      expect(p.label).toBe(VoiceLabel.FALLBACK_ZH_READS_EN);
      expect(p.languageContext).toBe('en-US');
      expect(p.reason).toContain('en_status=DOWNLOADABLE');
      const kv = planLogKv(p);
      expect(kv).toContain('lang=en');
      expect(kv).toContain('engine=zh-CN');
      expect(kv).toContain('person=13');
      expect(kv).toContain('label=fallback-zh');
    });

    it('fallback_context_can_be_switched_to_zh', () => {
      const p = resolveVoicePlan(Lang.EN, EnVoiceStrategy.FORCE_ZH,
        caps(VoiceState.DOWNLOADABLE, VoiceState.INSTALLED), { fallbackEnContext: 'zh-CN' });
      expect(p.languageContext).toBe('zh-CN');
      const bad = resolveVoicePlan(Lang.EN, EnVoiceStrategy.FORCE_ZH,
        caps(VoiceState.DOWNLOADABLE, VoiceState.INSTALLED), { fallbackEnContext: 'xx' });
      expect(bad.languageContext).toBe('en-US');
    });

    it('zh_voice_unavailable_means_text_only_platform', () => {
      const c = caps(VoiceState.DOWNLOADABLE, VoiceState.UNAVAILABLE);
      expect(resolveVoicePlan(Lang.EN, EnVoiceStrategy.AUTO_NATIVE_THEN_ZH, c).label)
        .toBe(VoiceLabel.TEXT_ONLY_PLATFORM);
      expect(resolveVoicePlan(Lang.EN, EnVoiceStrategy.FORCE_ZH, c).label).toBe(VoiceLabel.TEXT_ONLY_PLATFORM);
      expect(resolveVoicePlan(Lang.ZH, EnVoiceStrategy.AUTO_NATIVE_THEN_ZH, c).label)
        .toBe(VoiceLabel.TEXT_ONLY_PLATFORM);
      // Laura installed still speaks English even when zh is gone
      expect(resolveVoicePlan(Lang.EN, EnVoiceStrategy.AUTO_NATIVE_THEN_ZH,
        caps(VoiceState.INSTALLED, VoiceState.UNAVAILABLE)).label).toBe(VoiceLabel.NATIVE);
    });

    it('zh_error_still_tries_the_builtin_voice', () => {
      const c = caps(VoiceState.ERROR, VoiceState.ERROR);
      expect(resolveVoicePlan(Lang.EN, EnVoiceStrategy.AUTO_NATIVE_THEN_ZH, c).label)
        .toBe(VoiceLabel.FALLBACK_ZH_READS_EN);
      expect(resolveVoicePlan(Lang.ZH, EnVoiceStrategy.AUTO_NATIVE_THEN_ZH, c).speechMode).toBe('voice');
    });

    it('voice_lang_overrides', () => {
      const c = caps(VoiceState.DOWNLOADABLE, VoiceState.INSTALLED);
      const off = resolveVoicePlan(Lang.ZH, EnVoiceStrategy.AUTO_NATIVE_THEN_ZH, c, { voiceLang: VoiceLang.OFF });
      expect(off.label).toBe(VoiceLabel.TEXT_ONLY_USER);
      const plEn = resolveVoicePlan(Lang.PL, EnVoiceStrategy.AUTO_NATIVE_THEN_ZH, c, { voiceLang: VoiceLang.EN });
      expect(plEn.label).toBe(VoiceLabel.FALLBACK_ZH_READS_EN);
      expect(plEn.textLang).toBe(Lang.PL);
      expect(plEn.reason).toContain('pl_listen_en');
      const plZh = resolveVoicePlan(Lang.PL, EnVoiceStrategy.AUTO_NATIVE_THEN_ZH, c, { voiceLang: VoiceLang.ZH });
      expect(plZh.engineLocale).toBe('zh-CN');
      expect(plZh.label).toBe(VoiceLabel.NATIVE);
      const plText = resolveVoicePlan(Lang.PL, EnVoiceStrategy.AUTO_NATIVE_THEN_TEXT, c, { voiceLang: VoiceLang.EN });
      expect(plText.label).toBe(VoiceLabel.TEXT_ONLY_PLATFORM);
    });

    it('maps_list_voices_like_the_emulator', () => {
      expect(mapVoiceStatus('GA')).toBe(VoiceState.DOWNLOADABLE);
      expect(mapVoiceStatus('INSTALLED')).toBe(VoiceState.INSTALLED);
      expect(mapVoiceStatus('EOM')).toBe(VoiceState.UNAVAILABLE);
      expect(mapVoiceStatus(undefined)).toBe(VoiceState.UNAVAILABLE);
      // RISKS a1: what listVoices returned on Pura 90
      const emu: VoiceEntry[] = [
        { language: 'zh_CN', person: 13, status: 'INSTALLED' },
        { language: 'zh_CN', person: 21, status: 'GA' },
        { language: 'en_US', person: 8, status: 'GA' }
      ];
      const c = capsFromVoices(emu);
      expect(c.en).toBe(VoiceState.DOWNLOADABLE);
      expect(c.zh).toBe(VoiceState.INSTALLED);
      const dev: VoiceEntry[] = [{ language: 'en-US', person: 8, status: 'INSTALLED' }];
      expect(capsFromVoices(dev).en).toBe(VoiceState.INSTALLED);
      expect(capsFromVoices(dev).zh).toBe(VoiceState.UNAVAILABLE);
      expect(capsFromVoices([]).en).toBe(VoiceState.UNAVAILABLE);
    });

    it('strips_pause_markup_for_captions', () => {
      expect(stripPauseMarkup('Look left.[p300] The tower [p1200]is Gothic.')).toBe('Look left. The tower is Gothic.');
      expect(stripPauseMarkup('No markup')).toBe('No markup');
      expect(stripPauseMarkup('[p500]')).toBe('');
    });

    it('reading_time_and_pcm_duration', () => {
      expect(estimateReadingMs('')).toBe(1500);
      const tenWords = 'one two three four five six seven eight nine ten';
      expect(estimateReadingMs(tenWords)).toBe(3750);
      expect(estimateReadingMs(tenWords + ' [p1000]')).toBe(4750);
      expect(estimateReadingMs('欢迎来到克拉科夫中央广场')).toBe(3000);
      expect(estimateReadingMs('word '.repeat(1000))).toBe(60000);
      expect(pcmDurationMs(88186)).toBe(2756); // RISKS a7: 88,186 B = 2.76 s
      expect(pcmDurationMs(0)).toBe(0);
    });
  });
}

voicePolicyTest();
