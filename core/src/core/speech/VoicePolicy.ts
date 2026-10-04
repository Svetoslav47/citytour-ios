/*
 * Pure voice policy (docs/PLAN.md §0.4, task A4). No @kit imports: unit-tested in entry/src/test/VoicePolicy.test.ets.
 *
 * resolveVoicePlan(textLang, strategy, caps, opts) decides WHO speaks a narration (or that nobody does):
 *   en + AUTO_NATIVE_THEN_ZH  : en-US/8 (Laura) if INSTALLED, else zh-CN/13 reads English (label fallback-zh),
 *                               else text-only (platform)
 *   en + AUTO_NATIVE_THEN_TEXT: en-US/8 if INSTALLED, else text-only (platform)
 *   en + FORCE_ZH             : zh-CN/13 reads English (fallback-zh), else text-only (platform)
 *   en + TEXT_ONLY            : text-only (user)
 *   zh                        : zh-CN/13 (native), else text-only (platform)
 *   pl                        : text-only (platform; Core Speech Kit has no Polish voice), unless the user picked
 *                               "listen in English" (voiceLang EN) or Chinese (voiceLang ZH): then the en/zh plan,
 *                               with textLang kept as pl so captions stay Polish
 *   voiceLang OFF             : text-only (user) for every language
 * EnVoiceStrategy only governs English; Chinese has a built-in voice and is not affected by it.
 *
 * The zh voice (person 13) is preinstalled. It counts as usable when listVoices says INSTALLED, and also when
 * listVoices failed (ERROR): we then try the engine and VoiceManager downgrades the state if createEngine fails.
 * languageContext is the "context language for digits" of SpeakParams (doc API参考/Core_Speech_Kit_基础语音服务/
 * ArkTS_API/textToSpeech_文本转语音/hms-ai-texttospeech): 'en-US' makes the zh voice read "1257" in English.
 */
import { Lang } from '../../contracts/Model';
import { EnVoiceStrategy, VoiceLabel, VoiceLang } from '../../contracts/Settings';
import { SpeechCapabilities, VoicePlan, VoiceState } from '../../contracts/Ports';

export const EN_LOCALE: string = 'en-US';
export const ZH_LOCALE: string = 'zh-CN';
export const EN_PERSON: number = 8;    // Laura, needs a download (RISKS a4/a5)
export const ZH_PERSON: number = 13;   // 聆小珊, built in
export const SPEECH_MODE_VOICE: string = 'voice';
export const SPEECH_MODE_TEXT: string = 'text';
/** Reason prefix of a cross-language "listen in English/Chinese, read in Polish" plan (the user's explicit choice). */
export const LISTEN_REASON_PREFIX: string = 'pl_listen_';

/** Default languageContext when the zh voice reads English. The DevPanel can A/B it against 'zh-CN' (gate G1). */
export const DEFAULT_FALLBACK_EN_CONTEXT: string = EN_LOCALE;

/** PCM from playType 0: 16 kHz, 16-bit, mono -> 32 bytes per millisecond (StartResponse, RISKS a7). */
export const PCM_BYTES_PER_MS: number = 32;

export interface VoicePolicyOptions {
  voiceLang?: VoiceLang;            // UserSettings.voiceLang; undefined = follow the text language
  fallbackEnContext?: string;       // languageContext for the zh voice reading English ('en-US' | 'zh-CN')
}

function plan(textLang: Lang, mode: string, locale: string, person: number, ctx: string, label: VoiceLabel,
  reason: string): VoicePlan {
  const p: VoicePlan = {
    textLang: textLang, speechMode: mode, engineLocale: locale, person: person, languageContext: ctx,
    label: label, reason: reason
  };
  return p;
}

function textOnly(textLang: Lang, label: VoiceLabel, reason: string): VoicePlan {
  return plan(textLang, SPEECH_MODE_TEXT, '', 0, '', label, reason);
}

/** zh/13 is built in: usable when INSTALLED, and worth a try when listVoices itself failed. */
export function zhUsable(caps: SpeechCapabilities): boolean {
  return caps.zh === VoiceState.INSTALLED || caps.zh === VoiceState.ERROR;
}

export function stateTag(s: VoiceState): string {
  return String(s).toUpperCase();
}

function zhPlan(textLang: Lang, caps: SpeechCapabilities, reasonPrefix: string): VoicePlan {
  const reason = `${reasonPrefix}zh_status=${stateTag(caps.zh)}`;
  if (zhUsable(caps)) {
    return plan(textLang, SPEECH_MODE_VOICE, ZH_LOCALE, ZH_PERSON, ZH_LOCALE, VoiceLabel.NATIVE, reason);
  }
  return textOnly(textLang, VoiceLabel.TEXT_ONLY_PLATFORM, reason);
}

function enPlan(textLang: Lang, strategy: EnVoiceStrategy, caps: SpeechCapabilities, ctx: string,
  reasonPrefix: string): VoicePlan {
  const enTag = `${reasonPrefix}en_status=${stateTag(caps.en)}`;
  const fallbackReason = `${enTag} zh_status=${stateTag(caps.zh)} strategy=${strategy}`;
  if (strategy === EnVoiceStrategy.TEXT_ONLY) {
    return textOnly(textLang, VoiceLabel.TEXT_ONLY_USER, `${reasonPrefix}strategy=${strategy}`);
  }
  const nativeOk = caps.en === VoiceState.INSTALLED;
  if (nativeOk && strategy !== EnVoiceStrategy.FORCE_ZH) {
    return plan(textLang, SPEECH_MODE_VOICE, EN_LOCALE, EN_PERSON, EN_LOCALE, VoiceLabel.NATIVE, enTag);
  }
  if (strategy === EnVoiceStrategy.AUTO_NATIVE_THEN_TEXT) {
    return textOnly(textLang, VoiceLabel.TEXT_ONLY_PLATFORM, fallbackReason);
  }
  // AUTO_NATIVE_THEN_ZH (Laura missing) or FORCE_ZH: the zh voice reads the English text.
  if (zhUsable(caps)) {
    return plan(textLang, SPEECH_MODE_VOICE, ZH_LOCALE, ZH_PERSON, ctx, VoiceLabel.FALLBACK_ZH_READS_EN,
      fallbackReason);
  }
  return textOnly(textLang, VoiceLabel.TEXT_ONLY_PLATFORM, fallbackReason);
}

/** The one decision function (PLAN §0.4). Pure and total: always returns a plan. */
export function resolveVoicePlan(textLang: Lang, strategy: EnVoiceStrategy, caps: SpeechCapabilities,
  opts?: VoicePolicyOptions): VoicePlan {
  const voiceLang: VoiceLang | undefined = opts !== undefined ? opts.voiceLang : undefined;
  const ctxOpt: string | undefined = opts !== undefined ? opts.fallbackEnContext : undefined;
  const ctx: string = (ctxOpt === EN_LOCALE || ctxOpt === ZH_LOCALE) ? ctxOpt : DEFAULT_FALLBACK_EN_CONTEXT;
  if (voiceLang === VoiceLang.OFF) {
    return textOnly(textLang, VoiceLabel.TEXT_ONLY_USER, 'voice_lang=off');
  }
  if (textLang === Lang.EN) {
    return enPlan(textLang, strategy, caps, ctx, '');
  }
  if (textLang === Lang.ZH) {
    return zhPlan(textLang, caps, '');
  }
  // Polish (or anything else): no Polish voice in Core Speech Kit.
  if (voiceLang === VoiceLang.EN) {
    return enPlan(textLang, strategy, caps, ctx, `${LISTEN_REASON_PREFIX}en `);
  }
  if (voiceLang === VoiceLang.ZH) {
    return zhPlan(textLang, caps, `${LISTEN_REASON_PREFIX}zh `);
  }
  return textOnly(textLang, VoiceLabel.TEXT_ONLY_PLATFORM, `no_voice_for_lang=${textLang}`);
}

/** True for the user's cross-language choice (voice language != text language), e.g. Polish text, English voice. */
export function isListenChoice(p: VoicePlan): boolean {
  return p.reason.startsWith(LISTEN_REASON_PREFIX);
}

/** The VOICE_PLAN log line body (ARCHITECTURE §10). */
export function planLogKv(p: VoicePlan): string {
  const engine = p.engineLocale !== '' ? p.engineLocale : 'none';
  return `lang=${p.textLang} mode=${p.speechMode} engine=${engine} person=${p.person} ctx=${p.languageContext || 'none'}` +
    ` label=${p.label} reason=${p.reason}`;
}

/** listVoices VoiceInfo.status -> VoiceState ('GA' = downloadable, 'INSTALLED', 'EOM' = unavailable). */
export function mapVoiceStatus(status: string | undefined): VoiceState {
  if (status === undefined || status === null) {
    return VoiceState.UNAVAILABLE;
  }
  const s = status.toUpperCase();
  if (s === 'INSTALLED') {
    return VoiceState.INSTALLED;
  }
  if (s === 'GA') {
    return VoiceState.DOWNLOADABLE;
  }
  return VoiceState.UNAVAILABLE;
}

/** The fields of textToSpeech.VoiceInfo that the policy reads (kept here so core stays free of @kit types). */
export interface VoiceEntry {
  language: string;
  person: number;
  status?: string;
}

/** 'zh_CN' and 'zh-CN' are both used by the kit (listVoices returns underscores). */
export function normLocale(l: string): string {
  return (l || '').replace('_', '-').toLowerCase();
}

/** en = en-US/8, zh = zh-CN/13 (person 0 is an alias of 13). A voice that is not listed is UNAVAILABLE. */
export function capsFromVoices(voices: VoiceEntry[]): SpeechCapabilities {
  let en: VoiceState = VoiceState.UNAVAILABLE;
  let zh: VoiceState = VoiceState.UNAVAILABLE;
  for (const v of voices) {
    const loc = normLocale(v.language);
    if (loc === normLocale(EN_LOCALE) && v.person === EN_PERSON) {
      en = mapVoiceStatus(v.status);
    } else if (loc === normLocale(ZH_LOCALE) && (v.person === ZH_PERSON || v.person === 0)) {
      if (zh !== VoiceState.INSTALLED) {
        zh = mapVoiceStatus(v.status);
      }
    }
  }
  const caps: SpeechCapabilities = { en: en, zh: zh };
  return caps;
}

/** Captions never show TTS pause markup: "[p300]" -> "" (ARCHITECTURE §2.5). Collapses the doubled spaces. */
export function stripPauseMarkup(text: string): string {
  return text.replace(/\[p\d+\]/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * How long a text-only utterance stays "speaking" so the tour pacing matches a spoken one.
 * About 160 words per minute for Latin text, about 4 characters per second for CJK, plus the [pN] pauses,
 * clamped to [1.5 s, 60 s].
 */
export function estimateReadingMs(text: string): number {
  let pauseMs = 0;
  const pauses = text.match(/\[p(\d+)\]/g);
  if (pauses !== null) {
    for (const p of pauses) {
      const n = Number.parseInt(p.substring(2, p.length - 1));
      if (!Number.isNaN(n)) {
        pauseMs += n;
      }
    }
  }
  const clean = stripPauseMarkup(text);
  let cjk = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    if (c >= 0x3400 && c <= 0x9FFF) {
      cjk++;
    }
  }
  const words = clean.replace(/[㐀-鿿]/g, ' ').split(/\s+/).filter((w: string) => w.length > 0).length;
  const ms = words * 375 + cjk * 250 + pauseMs;
  return Math.max(1500, Math.min(60000, Math.round(ms)));
}

/** Playback length of a PCM byte count at 16 kHz mono S16LE. */
export function pcmDurationMs(bytes: number): number {
  return bytes <= 0 ? 0 : Math.ceil(bytes / PCM_BYTES_PER_MS);
}
