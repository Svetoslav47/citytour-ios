/*
 * Pure onboarding rules (task A12, docs/DESIGN.md §2.3 Flow A and §3.1). No platform imports: unit-tested in
 * entry/src/test/Onboarding.test.ets. OnboardingViewModel feeds platform state in and renders what comes out.
 *
 * - Step navigation: 3 steps, button driven, never blocks (Skip / Set up later / Done all finish).
 * - Narration choice (step 2): English (spoken), 中文 (spoken), Polski (text only, DESIGN Flow F) -> the
 *   UserSettings textLang + voiceLang pair, and back.
 * - English voice row: what English will actually sound like, from listVoices + the voice strategy through the
 *   same resolveVoicePlan the tour uses, so the row never claims more than the tour delivers: Laura when INSTALLED,
 *   otherwise "Fallback voice" (zh-CN voice reads English, PLAN §0.4), with a Download button while Laura is
 *   DOWNLOADABLE, and an honest failure state after a failed download (emulator: 1002300008).
 * - Permission rows (step 3): location permission + location switch, notifications.
 */
import { Lang } from '../../contracts/Model';
import { PermissionState, SpeechCapabilities, VoiceState } from '../../contracts/Ports';
import { EnVoiceStrategy, VoiceLabel, VoiceLang } from '../../contracts/Settings';
import { resolveVoicePlan, zhUsable } from '../speech/VoicePolicy';

export const ONB_STEPS: number = 3;
export const ONB_STEP_INTRO: number = 0;
export const ONB_STEP_VOICE: number = 1;
export const ONB_STEP_PERMS: number = 2;

/** The next step index, or -1 when the last step is done (finish onboarding). */
export function nextStep(step: number): number {
  const s = clampStep(step);
  return s >= ONB_STEPS - 1 ? -1 : s + 1;
}

export function clampStep(step: number): number {
  if (!Number.isFinite(step)) {
    return ONB_STEP_INTRO;
  }
  return Math.min(ONB_STEPS - 1, Math.max(0, Math.floor(step)));
}

// ---------- Step 2: narration language ----------

export interface NarrationChoice {
  textLang: Lang;
  voiceLang: VoiceLang;
}

/** English and Chinese are spoken in their own language; Polish is text only (no Polish voice in Core Speech Kit). */
export function choiceFor(lang: Lang): NarrationChoice {
  if (lang === Lang.ZH) {
    const c: NarrationChoice = { textLang: Lang.ZH, voiceLang: VoiceLang.ZH };
    return c;
  }
  if (lang === Lang.PL) {
    const c: NarrationChoice = { textLang: Lang.PL, voiceLang: VoiceLang.OFF };
    return c;
  }
  const c: NarrationChoice = { textLang: Lang.EN, voiceLang: VoiceLang.EN };
  return c;
}

/** Which row is selected for saved settings (the text language decides; unknown values fall back to English). */
export function selectedRow(textLang: string): Lang {
  if (textLang === Lang.ZH) {
    return Lang.ZH;
  }
  if (textLang === Lang.PL) {
    return Lang.PL;
  }
  return Lang.EN;
}

/**
 * The voiceLang to give VoiceManager for saved settings: undefined (follow the text language) unless the pair is
 * a deliberate cross-language choice (B9 "listen in English, read in Polish") or OFF (except Polish, see below).
 */
export function voiceLangForPlan(textLang: string, voiceLang: string): VoiceLang | undefined {
  if (voiceLang === VoiceLang.OFF) {
    // A13: Polish is stored as (pl, off) = "no on-device voice in another language", not a "never speak" choice:
    // follow the text language, so the pre-rendered studio clips can speak it (else text only, platform label).
    return textLang === Lang.PL ? undefined : VoiceLang.OFF;
  }
  if (voiceLang === VoiceLang.EN && textLang !== Lang.EN) {
    return VoiceLang.EN;
  }
  if (voiceLang === VoiceLang.ZH && textLang !== Lang.ZH) {
    return VoiceLang.ZH;
  }
  return undefined;
}

// ---------- Step 2: voice status rows ----------

export enum EnVoiceRow {
  CHECKING = 'checking',               // listVoices not answered yet
  NATIVE = 'native',                   // "Spoken · Laura voice" + Installed
  FALLBACK = 'fallback',               // "Spoken · Fallback voice" (zh-CN voice reads English)
  DOWNLOADING = 'downloading',         // progress bar + percent
  DOWNLOAD_FAILED = 'downloadFailed',  // still "Fallback voice", plus "Couldn't download ... Try again"
  TEXT_ONLY = 'textOnly'               // no usable voice for English on this device
}

export interface EnVoiceInput {
  capsKnown: boolean;
  caps: SpeechCapabilities;
  strategy: EnVoiceStrategy;
  downloading: boolean;
  downloadFailed: boolean;   // the last download attempt in this onboarding failed
}

/** The English row state. The label comes from resolveVoicePlan(en), exactly what the tour would use. */
export function enVoiceRow(i: EnVoiceInput): EnVoiceRow {
  if (i.downloading) {
    return EnVoiceRow.DOWNLOADING;
  }
  if (!i.capsKnown) {
    return EnVoiceRow.CHECKING;
  }
  const label = resolveVoicePlan(Lang.EN, i.strategy, i.caps).label;
  if (label === VoiceLabel.NATIVE) {
    return EnVoiceRow.NATIVE;
  }
  if (label === VoiceLabel.FALLBACK_ZH_READS_EN) {
    return i.downloadFailed ? EnVoiceRow.DOWNLOAD_FAILED : EnVoiceRow.FALLBACK;
  }
  return EnVoiceRow.TEXT_ONLY;
}

/** The Download (or Try again) button shows while Laura is downloadable and nothing is downloading. */
export function canDownloadEnglish(i: EnVoiceInput): boolean {
  return i.capsKnown && !i.downloading && i.caps.en === VoiceState.DOWNLOADABLE;
}

/** 中文 is spoken by the built-in zh-CN voice (聆小珊) unless the platform reports it unusable. */
export function zhSpoken(capsKnown: boolean, caps: SpeechCapabilities): boolean {
  return !capsKnown || zhUsable(caps);
}

/** Progress callbacks may report 0..1 or 0..100; the UI shows a whole percent in 0..100. */
export function percent(p: number): number {
  if (!Number.isFinite(p) || p <= 0) {
    return 0;
  }
  const v = p <= 1 ? p * 100 : p;
  return Math.min(100, Math.round(v));
}

// ---------- Step 3: permissions ----------

export enum LocRow {
  ASK = 'ask',               // never asked: Allow opens the system dialog
  ALLOWED = 'allowed',       // precise location granted and the location switch is on
  SWITCH_OFF = 'switchOff',  // granted, but the phone's location switch is off: Turn on opens the switch sheet
  APPROX = 'approx',         // approximate only: Turn on asks for precise location in the settings sheet
  DENIED = 'denied'          // refused: Allow location opens the settings sheet (the dialog won't show again)
}

export function locationRow(state: PermissionState, switchOn: boolean): LocRow {
  if (state === PermissionState.GRANTED) {
    return switchOn ? LocRow.ALLOWED : LocRow.SWITCH_OFF;
  }
  if (state === PermissionState.APPROX_ONLY) {
    return LocRow.APPROX;
  }
  if (state === PermissionState.DENIED) {
    return LocRow.DENIED;
  }
  return LocRow.ASK;
}

export enum NotifRow {
  ASK = 'ask',
  ALLOWED = 'allowed',
  DENIED = 'denied'   // "Notifications are off." Never nag (DESIGN Flow D): Settings is the place to change it
}

/** enabled = isNotificationEnabled(); refused = the last requestEnableNotification ended in 1600004. */
export function notifRow(enabled: boolean, refused: boolean): NotifRow {
  if (enabled) {
    return NotifRow.ALLOWED;
  }
  return refused ? NotifRow.DENIED : NotifRow.ASK;
}

