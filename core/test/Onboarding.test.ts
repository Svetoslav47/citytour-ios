// Suite: Onboarding.test - module under test: core/onboarding/OnboardingRules (task A12).
// Step navigation, the narration choice <-> UserSettings mapping, the English voice row (incl. the emulator path
// Laura DOWNLOADABLE -> download fails -> "Fallback voice"), the 中文 row and the permission rows.
import { describe, it, expect } from 'vitest';
import { Lang } from '../src';
import { PermissionState, SpeechCapabilities, VoiceState } from '../src';
import { EnVoiceStrategy, VoiceLang } from '../src';
import {
  canDownloadEnglish, choiceFor, clampStep, EnVoiceInput, EnVoiceRow, enVoiceRow, LocRow, locationRow, nextStep,
  NotifRow, notifRow, ONB_STEPS, percent, selectedRow, voiceLangForPlan, zhSpoken
} from '../src';

function caps(en: VoiceState, zh: VoiceState): SpeechCapabilities {
  const c: SpeechCapabilities = { en: en, zh: zh };
  return c;
}

function input(en: VoiceState, zh: VoiceState, strategy: EnVoiceStrategy, downloading: boolean,
  failed: boolean, known: boolean): EnVoiceInput {
  const i: EnVoiceInput = {
    capsKnown: known, caps: caps(en, zh), strategy: strategy, downloading: downloading, downloadFailed: failed
  };
  return i;
}

const AUTO: EnVoiceStrategy = EnVoiceStrategy.AUTO_NATIVE_THEN_ZH;

function onboardingTest() {
  describe('Onboarding', () => {
    it('steps_advance_and_finish_after_the_third', () => {
      expect(ONB_STEPS).toBe(3);
      expect(nextStep(0)).toBe(1);
      expect(nextStep(1)).toBe(2);
      expect(nextStep(2)).toBe(-1);
      expect(nextStep(7)).toBe(-1);
      expect(clampStep(-3)).toBe(0);
      expect(clampStep(Number.NaN)).toBe(0);
      expect(clampStep(1.7)).toBe(1);
    });

    it('choice_maps_to_settings_and_back', () => {
      const en = choiceFor(Lang.EN);
      expect(en.textLang as string).toBe(Lang.EN);
      expect(en.voiceLang as string).toBe(VoiceLang.EN);
      const zh = choiceFor(Lang.ZH);
      expect(zh.textLang as string).toBe(Lang.ZH);
      expect(zh.voiceLang as string).toBe(VoiceLang.ZH);
      const pl = choiceFor(Lang.PL);
      expect(pl.textLang as string).toBe(Lang.PL);
      expect(pl.voiceLang as string).toBe(VoiceLang.OFF);
      expect(selectedRow('zh') as string).toBe(Lang.ZH);
      expect(selectedRow('pl') as string).toBe(Lang.PL);
      expect(selectedRow('en') as string).toBe(Lang.EN);
      expect(selectedRow('xx') as string).toBe(Lang.EN);
    });

    it('voice_lang_for_plan_follows_text_unless_cross_language_or_off', () => {
      expect(voiceLangForPlan('en', 'en') === undefined).toBe(true);
      expect(voiceLangForPlan('zh', 'zh') === undefined).toBe(true);
      expect(voiceLangForPlan('pl', 'off') === undefined).toBe(true);   // A13: Polish follows the text language
      expect(voiceLangForPlan('en', 'off') as string).toBe(VoiceLang.OFF);
      expect(voiceLangForPlan('pl', 'en') as string).toBe(VoiceLang.EN);
      expect(voiceLangForPlan('pl', 'zh') as string).toBe(VoiceLang.ZH);
    });

    it('emulator_path_laura_downloadable_then_failed_stays_fallback', () => {
      // listVoices pending
      expect(enVoiceRow(input(VoiceState.DOWNLOADABLE, VoiceState.INSTALLED, AUTO, false, false, false)) as string)
        .toBe(EnVoiceRow.CHECKING);
      // Laura GA (downloadable), zh installed: Fallback voice, Download offered
      const idle = input(VoiceState.DOWNLOADABLE, VoiceState.INSTALLED, AUTO, false, false, true);
      expect(enVoiceRow(idle) as string).toBe(EnVoiceRow.FALLBACK);
      expect(canDownloadEnglish(idle)).toBe(true);
      // downloading
      const dl = input(VoiceState.DOWNLOADABLE, VoiceState.INSTALLED, AUTO, true, false, true);
      expect(enVoiceRow(dl) as string).toBe(EnVoiceRow.DOWNLOADING);
      expect(canDownloadEnglish(dl)).toBe(false);
      // 1002300008: still the Fallback voice, honest failure + Try again
      const failed = input(VoiceState.DOWNLOADABLE, VoiceState.INSTALLED, AUTO, false, true, true);
      expect(enVoiceRow(failed) as string).toBe(EnVoiceRow.DOWNLOAD_FAILED);
      expect(canDownloadEnglish(failed)).toBe(true);
    });

    it('laura_installed_is_native_and_needs_no_download', () => {
      const i = input(VoiceState.INSTALLED, VoiceState.INSTALLED, AUTO, false, false, true);
      expect(enVoiceRow(i) as string).toBe(EnVoiceRow.NATIVE);
      expect(canDownloadEnglish(i)).toBe(false);
    });

    it('english_row_follows_the_strategy', () => {
      expect(enVoiceRow(input(VoiceState.DOWNLOADABLE, VoiceState.INSTALLED,
        EnVoiceStrategy.AUTO_NATIVE_THEN_TEXT, false, false, true)) as string).toBe(EnVoiceRow.TEXT_ONLY);
      expect(enVoiceRow(input(VoiceState.INSTALLED, VoiceState.INSTALLED,
        EnVoiceStrategy.FORCE_ZH, false, false, true)) as string).toBe(EnVoiceRow.FALLBACK);
      expect(enVoiceRow(input(VoiceState.INSTALLED, VoiceState.INSTALLED,
        EnVoiceStrategy.TEXT_ONLY, false, false, true)) as string).toBe(EnVoiceRow.TEXT_ONLY);
      // no zh voice and no Laura: text only
      expect(enVoiceRow(input(VoiceState.DOWNLOADABLE, VoiceState.UNAVAILABLE, AUTO, false, false, true)) as string)
        .toBe(EnVoiceRow.TEXT_ONLY);
    });

    it('zh_row_spoken_unless_unavailable', () => {
      expect(zhSpoken(false, caps(VoiceState.ERROR, VoiceState.ERROR))).toBe(true);
      expect(zhSpoken(true, caps(VoiceState.DOWNLOADABLE, VoiceState.INSTALLED))).toBe(true);
      expect(zhSpoken(true, caps(VoiceState.DOWNLOADABLE, VoiceState.ERROR))).toBe(true);
      expect(zhSpoken(true, caps(VoiceState.DOWNLOADABLE, VoiceState.UNAVAILABLE))).toBe(false);
    });

    it('percent_accepts_fraction_or_percent', () => {
      expect(percent(0.4)).toBe(40);
      expect(percent(40)).toBe(40);
      expect(percent(250)).toBe(100);
      expect(percent(-1)).toBe(0);
      expect(percent(Number.NaN)).toBe(0);
    });

    it('location_row_states', () => {
      expect(locationRow(PermissionState.UNKNOWN, false) as string).toBe(LocRow.ASK);
      expect(locationRow(PermissionState.GRANTED, true) as string).toBe(LocRow.ALLOWED);
      expect(locationRow(PermissionState.GRANTED, false) as string).toBe(LocRow.SWITCH_OFF);
      expect(locationRow(PermissionState.APPROX_ONLY, true) as string).toBe(LocRow.APPROX);
      expect(locationRow(PermissionState.DENIED, true) as string).toBe(LocRow.DENIED);
    });

    it('notification_row_states', () => {
      expect(notifRow(true, false) as string).toBe(NotifRow.ALLOWED);
      expect(notifRow(true, true) as string).toBe(NotifRow.ALLOWED);
      expect(notifRow(false, false) as string).toBe(NotifRow.ASK);
      expect(notifRow(false, true) as string).toBe(NotifRow.DENIED);
    });
  });
}

onboardingTest();
