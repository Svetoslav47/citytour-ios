/*
 * Pure Settings rules (task B9, docs/DESIGN.md §3.11, docs/PLAN.md §0.4 + card B9). No platform imports: unit-tested
 * in entry/src/test/Settings.test.ets. SettingsViewModel feeds the persisted UserSettings in and renders what comes out.
 *
 * - Story language: the four rows of DESIGN §3.11 <-> the UserSettings (textLang, voiceLang) pair. "Listen in
 *   English, read in Polish" is textLang pl + voiceLang en (VoicePolicy speaks the en plan, captions stay Polish).
 * - App language: System / English / Polski / 中文 -> the i18n.System.setAppPreferredLanguage tag.
 * - Voice strategy picker: Auto / Chinese voice / Text only <-> EnVoiceStrategy. A strategy that is not on the
 *   picker (AUTO_NATIVE_THEN_TEXT, the gate-G1 build switch) shows as Auto: both prefer Laura when installed.
 * - Voice row: what the listener hears for the chosen story language, from the same VoicePlan the tour uses.
 * - Detail level: Brief / Standard / Deep -> the tour engine knobs it really drives (adaptiveLength, briefOnly).
 * - Trigger distance 20 / 35 / 50 m -> a scale on the curated per-stop geofences (35 m = the curated radii).
 * - Demo walk speed 1 / 2 / 4 / 8 and the Offline data line (pack counts + size).
 */
import { Lang } from '../../contracts/Model';
import { EnVoiceStrategy, UiLang, VoiceLabel, VoiceLang } from '../../contracts/Settings';

// ---------- Story language ----------

export enum StoryLang {
  EN = 'en',                   // English (spoken)
  ZH = 'zh',                   // 中文 (spoken)
  PL = 'pl',                   // Polski (text only)
  PL_LISTEN_EN = 'pl-listen-en' // Listen in English, read in Polish
}

export const STORY_LANGS: StoryLang[] = [StoryLang.EN, StoryLang.ZH, StoryLang.PL, StoryLang.PL_LISTEN_EN];

export interface StoryLangPair {
  textLang: Lang;
  voiceLang: VoiceLang;
}

export function storyLangPair(s: StoryLang): StoryLangPair {
  if (s === StoryLang.ZH) {
    const p: StoryLangPair = { textLang: Lang.ZH, voiceLang: VoiceLang.ZH };
    return p;
  }
  if (s === StoryLang.PL) {
    const p: StoryLangPair = { textLang: Lang.PL, voiceLang: VoiceLang.OFF };
    return p;
  }
  if (s === StoryLang.PL_LISTEN_EN) {
    const p: StoryLangPair = { textLang: Lang.PL, voiceLang: VoiceLang.EN };
    return p;
  }
  const p: StoryLangPair = { textLang: Lang.EN, voiceLang: VoiceLang.EN };
  return p;
}

/** The selected row for saved settings. Unknown values fall back to English (the default). */
export function storyLangOf(textLang: string, voiceLang: string): StoryLang {
  if (textLang === Lang.ZH) {
    return StoryLang.ZH;
  }
  if (textLang === Lang.PL) {
    return voiceLang === VoiceLang.EN ? StoryLang.PL_LISTEN_EN : StoryLang.PL;
  }
  return StoryLang.EN;
}

// ---------- App language ----------

export const UI_LANGS: UiLang[] = [UiLang.SYSTEM, UiLang.EN, UiLang.PL, UiLang.ZH];

/** setAppPreferredLanguage tag (doc js-apis-i18n, i18n-preferred-language). 'default' = follow the system. */
export function uiLangTag(u: string): string {
  if (u === UiLang.EN) {
    return 'en-US';
  }
  if (u === UiLang.PL) {
    return 'pl-PL';
  }
  if (u === UiLang.ZH) {
    return 'zh-Hans';
  }
  return 'default';
}

export function uiLangOf(v: string): UiLang {
  if (v === UiLang.EN || v === UiLang.PL || v === UiLang.ZH) {
    return v as UiLang;
  }
  return UiLang.SYSTEM;
}

// ---------- Voice strategy ----------

export enum StrategyChoice { AUTO = 'auto', ZH = 'zh', TEXT = 'text' }

export const STRATEGY_CHOICES: StrategyChoice[] = [StrategyChoice.AUTO, StrategyChoice.ZH, StrategyChoice.TEXT];

export function strategyFor(c: StrategyChoice): EnVoiceStrategy {
  if (c === StrategyChoice.ZH) {
    return EnVoiceStrategy.FORCE_ZH;
  }
  if (c === StrategyChoice.TEXT) {
    return EnVoiceStrategy.TEXT_ONLY;
  }
  return EnVoiceStrategy.AUTO_NATIVE_THEN_ZH;
}

export function strategyChoiceOf(s: string): StrategyChoice {
  if (s === EnVoiceStrategy.FORCE_ZH) {
    return StrategyChoice.ZH;
  }
  if (s === EnVoiceStrategy.TEXT_ONLY) {
    return StrategyChoice.TEXT;
  }
  return StrategyChoice.AUTO;
}

/** A persisted value the app does not know (older build, manual edit) becomes the default strategy. */
export function validStrategy(s: string, fallback: EnVoiceStrategy): EnVoiceStrategy {
  if (s === EnVoiceStrategy.AUTO_NATIVE_THEN_ZH || s === EnVoiceStrategy.AUTO_NATIVE_THEN_TEXT ||
    s === EnVoiceStrategy.FORCE_ZH || s === EnVoiceStrategy.TEXT_ONLY) {
    return s as EnVoiceStrategy;
  }
  return fallback;
}

// ---------- Voice row ----------

export enum VoiceRow {
  LAURA = 'laura',             // "Laura · Installed"
  FALLBACK = 'fallback',       // "Fallback voice · Chinese voice reads English"
  ZH = 'zh',                   // "聆小珊 · Chinese voice"
  TEXT_USER = 'textUser',      // "Text only" (the user's choice)
  TEXT_PLATFORM = 'textPlatform', // "Text only: no voice on this device"
  PRERENDERED = 'prerendered'  // A13 studio clips
}

/** The Voice row value for the story language's VoicePlan (engineLocale tells the zh voice from the en one). */
export function voiceRowFor(label: VoiceLabel, engineLocale: string): VoiceRow {
  if (label === VoiceLabel.NATIVE) {
    return engineLocale.toLowerCase().startsWith('zh') ? VoiceRow.ZH : VoiceRow.LAURA;
  }
  if (label === VoiceLabel.FALLBACK_ZH_READS_EN) {
    return VoiceRow.FALLBACK;
  }
  if (label === VoiceLabel.TEXT_ONLY_USER) {
    return VoiceRow.TEXT_USER;
  }
  if (label === VoiceLabel.PRERENDERED) {
    return VoiceRow.PRERENDERED;
  }
  return VoiceRow.TEXT_PLATFORM;
}

// ---------- Detail level ----------

export enum DetailLevel { BRIEF = 'brief', STANDARD = 'standard', DEEP = 'deep' }

export const DETAIL_LEVELS: DetailLevel[] = [DetailLevel.BRIEF, DetailLevel.STANDARD, DetailLevel.DEEP];

export interface DetailKnobs {
  adaptiveLength: boolean;   // teaser if walking past, full story when stopping
  briefOnly: boolean;        // teaser at every stop unless the user asks for more
}

/**
 * What each level really changes in the tour engine:
 * Brief = the short version at every stop ("Tell me more" still plays the full story);
 * Standard = full when you stop, short when you walk past (the default, adaptive);
 * Deep = the full story at every stop, even when walking on.
 */
export function detailKnobs(d: DetailLevel): DetailKnobs {
  if (d === DetailLevel.BRIEF) {
    const k: DetailKnobs = { adaptiveLength: true, briefOnly: true };
    return k;
  }
  if (d === DetailLevel.DEEP) {
    const k: DetailKnobs = { adaptiveLength: false, briefOnly: false };
    return k;
  }
  const k: DetailKnobs = { adaptiveLength: true, briefOnly: false };
  return k;
}

export function detailLevelOf(v: string): DetailLevel {
  if (v === DetailLevel.BRIEF || v === DetailLevel.DEEP) {
    return v as DetailLevel;
  }
  return DetailLevel.STANDARD;
}

// ---------- Trigger distance ----------

export const TRIGGER_DISTANCES_M: number[] = [20, 35, 50];
/** The curated stop radii (data/tours/royal-route.json) are tuned for this setting. */
export const CURATED_TRIGGER_M: number = 35;

export function normalizeTriggerM(m: number): number {
  return nearest(m, TRIGGER_DISTANCES_M, CURATED_TRIGGER_M);
}

/** Scale applied to every stop's geofence: 20 m -> 0.57, 35 m -> 1, 50 m -> 1.43. */
export function triggerScale(m: number): number {
  return normalizeTriggerM(m) / CURATED_TRIGGER_M;
}

// ---------- Demo walk ----------

export const DEMO_SPEEDS: number[] = [1, 2, 4, 8];

export function normalizeSpeed(x: number): number {
  return nearest(x, DEMO_SPEEDS, 4);
}

// ---------- Offline data ----------

export interface PackLine {
  places: number;
  stories: number;
  sizeMb: number;      // 0 = unknown (the stub pack lists no files)
}

/** Megabytes with one decimal below 10 MB, whole above; 0 for no or unknown bytes. */
export function megabytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return 0;
  }
  const mb = bytes / (1024 * 1024);
  return mb < 10 ? Math.max(0.1, Math.round(mb * 10) / 10) : Math.round(mb);
}

export function packLine(places: number, stories: number, fileBytes: number[]): PackLine {
  let total = 0;
  for (const b of fileBytes) {
    if (Number.isFinite(b) && b > 0) {
      total += b;
    }
  }
  const l: PackLine = {
    places: Number.isFinite(places) && places > 0 ? Math.floor(places) : 0,
    stories: Number.isFinite(stories) && stories > 0 ? Math.floor(stories) : 0,
    sizeMb: megabytes(total)
  };
  return l;
}

// ---------- helpers ----------

function nearest(x: number, options: number[], fallback: number): number {
  if (!Number.isFinite(x)) {
    return fallback;
  }
  let best = options[0];
  for (const o of options) {
    if (Math.abs(o - x) < Math.abs(best - x)) {
      best = o;
    }
  }
  return best;
}
