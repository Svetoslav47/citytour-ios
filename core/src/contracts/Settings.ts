/*
 * CityTour shared contracts: user settings and the English voice strategy.
 * Sources: docs/PLAN.md §0.4 (voice strategy, user decision 2026-10-03) and
 * docs/ARCHITECTURE.md §1.2 / §8 / §12.1 (UserSettings shape: uiLang, textLang, voiceLang, adaptiveLength,
 * ambient, demoSpeed). UserSettings is an @ObservedV2 class so B9 can persist it with
 * PersistenceV2.connect(UserSettings, 'settings', () => new UserSettings()).
 */
import { Lang } from './Model';

/** How English narration is voiced. Default lives in app/AppConfig.ets (DEFAULT_EN_VOICE_STRATEGY). */
export enum EnVoiceStrategy {
  AUTO_NATIVE_THEN_ZH = 'auto-native-then-zh',     // DEFAULT (user decision): Laura if INSTALLED, else zh-CN voice reads English, labelled "Fallback voice"
  AUTO_NATIVE_THEN_TEXT = 'auto-native-then-text', // used if gate G1 rejects the zh voice: Laura if INSTALLED, else English text-only
  FORCE_ZH = 'force-zh',                           // demo/testing: always the zh-CN voice for English
  TEXT_ONLY = 'text-only'                          // user choice: never speak
}

/** Honesty label for what the listener actually hears. Drives the "Fallback voice" chip, AVSession artist, Settings. */
export enum VoiceLabel {
  NATIVE = 'native',
  FALLBACK_ZH_READS_EN = 'fallback-zh',
  TEXT_ONLY_PLATFORM = 'text-only-platform',
  TEXT_ONLY_USER = 'text-only-user',
  /** A13: a pre-rendered studio clip (ElevenLabs, build time) plays this sentence. UI: "Studio voice (pre-recorded)". */
  PRERENDERED = 'prerendered'
}

/** App UI language (Settings -> Language). SYSTEM maps to setAppPreferredLanguage('default'). */
export enum UiLang { SYSTEM = 'system', EN = 'en', PL = 'pl', ZH = 'zh' }

/** Spoken narration language, independent of the text language (§8). OFF = text only by user choice. */
export enum VoiceLang { EN = 'en', ZH = 'zh', OFF = 'off' }

export class UserSettings {
  uiLang: UiLang = UiLang.SYSTEM;
  textLang: Lang = Lang.EN;
  voiceLang: VoiceLang = VoiceLang.EN;
  enVoiceStrategy: EnVoiceStrategy = EnVoiceStrategy.AUTO_NATIVE_THEN_ZH; // keep equal to AppConfig.DEFAULT_EN_VOICE_STRATEGY
  adaptiveLength: boolean = true;   // "full if they stop, teaser if they walk past" (proposal, default on, §4.3)
  ambient: boolean = false;         // P4 nearby non-tour POI cues
  useDemoWalk: boolean = false;     // SIMULATED location source; the real source stays the default
  demoSpeed: number = 4;            // 1 | 2 | 4 | 8; keep equal to AppConfig.DEMO_DEFAULT_SPEED
  triggerDistanceM: number = 35;    // 20 | 35 | 50 (Settings P1 row)
  spokenDirections: boolean = true;
  onboardingDone: boolean = false;
}
