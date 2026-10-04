/*
 * VoicePort implementation (docs/PLAN.md §0.4, ARCHITECTURE §2.5 "Voice availability", task A4).
 *
 * iOS port: the built-in system TTS (Core Speech Kit) is DROPPED (docs/PORTING.md). TtsEngines is a stub whose
 * listVoices() lists nothing, so capabilities() is always en=UNAVAILABLE zh=UNAVAILABLE and the pure resolveVoicePlan
 * never picks an engine. The voice chain per sentence is: pre-rendered course clip -> runtime studio voice from the
 * server (RemoteVoice, POST /v1/tts) -> on-screen text.
 *
 * - capabilities(): TtsEngines.listVoices() -> SpeechCapabilities via the pure capsFromVoices. Logs VOICE_STATUS.
 * - plan(textLang): pure resolveVoicePlan(textLang, strategy, caps) + a VOICE_PLAN log line for every decision, then
 *   the iOS adjustment (iosPlan): a platform text-only plan is the normal case on iOS (like Polish on HarmonyOS), so
 *   its reason says no_voice_for_lang (no "voice failed" issue banner). When the runtime studio voice can be tried
 *   for this language (setStudioVoiceSource, wired by RemoteVoice: server configured, "Online studio voice" on, a
 *   course id known), the plan is upgraded to speechMode 'voice' with no engine and the PRERENDERED ("Studio voice")
 *   label, so the tour engine hands every sentence to the SpeechPort: RemoteVoice asks the server, and a sentence
 *   without studio audio is shown as text by NarrationPlayer on the same reading-time timer as a text-only tour.
 *   The user's text-only and cross-language "listen in" choices are never upgraded (same rule as clips).
 * - downloadEnglish(): there is no voice to download; the stub reports UNSUPPORTED, logged VOICE_DL_FAIL, false.
 * - markEngineFailed(): kept for the API; never called on iOS (no engine is ever created).
 * The default strategy comes from AppConfig.DEFAULT_EN_VOICE_STRATEGY; it only matters for TEXT_ONLY on iOS.
 */
import { Lang } from '@citytour/core';
import { EnVoiceStrategy, VoiceLabel, VoiceLang } from '@citytour/core';
import { SpeechCapabilities, VoicePlan, VoicePort, VoiceState } from '@citytour/core';
import {
  capsFromVoices, DEFAULT_FALLBACK_EN_CONTEXT, EN_LOCALE, EN_PERSON, isListenChoice, planLogKv, resolveVoicePlan,
  SPEECH_MODE_TEXT, SPEECH_MODE_VOICE, stateTag, VoiceEntry, VoicePolicyOptions, ZH_LOCALE
} from '@citytour/core';
import { storyVoicePlan } from '@citytour/core';
import { AppConfig } from '@/main/AppConfig';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';
import { DownloadCallbacks, errCode, errMsg, TtsEngines, TtsErr, VoiceInfo } from './TtsEngines';

export class VoiceManager implements VoicePort {
  private engines: TtsEngines;
  private caps: SpeechCapabilities = { en: VoiceState.ERROR, zh: VoiceState.ERROR };
  private capsKnown: boolean = false;
  private querying: Promise<SpeechCapabilities> | undefined = undefined;
  private strategyValue: EnVoiceStrategy = AppConfig.DEFAULT_EN_VOICE_STRATEGY;
  private voiceLangValue: VoiceLang | undefined = undefined;
  private fallbackCtx: string = DEFAULT_FALLBACK_EN_CONTEXT;
  private enEngineFail: number = 0;
  private zhEngineFail: number = 0;
  private downloading: boolean = false;
  private lastDlCode: number = 0;
  private clipLangs: ((lang: string) => boolean) | undefined = undefined;
  private studioLangs: ((lang: Lang) => boolean) | undefined = undefined;

  constructor(engines: TtsEngines) {
    this.engines = engines;
  }

  // ---------- VoicePort ----------

  /** Cached after the first successful query; refresh(true) forces a new listVoices. Never rejects. */
  capabilities(): Promise<SpeechCapabilities> {
    if (this.capsKnown) {
      return Promise.resolve(this.effectiveCaps());
    }
    return this.refresh();
  }

  /** quiet: no VOICE_PLAN log line (RemoteVoice's look-ahead; the real job logs its own plan). */
  plan(textLang: Lang, quiet: boolean = false): VoicePlan {
    const opts: VoicePolicyOptions = { voiceLang: this.voiceLangValue, fallbackEnContext: this.fallbackCtx };
    let p: VoicePlan;
    try {
      p = this.iosPlan(textLang, resolveVoicePlan(textLang, this.strategyValue, this.effectiveCaps(), opts));
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=VoiceManager.plan ${Log.errKv(e)}`);
      const t: VoicePlan = {
        textLang: textLang, speechMode: 'text', engineLocale: '', person: 0, languageContext: '',
        label: VoiceLabel.TEXT_ONLY_PLATFORM, reason: 'policy_threw'
      };
      p = t;
    }
    if (!quiet) {
      Log.i(LogEvents.VOICE_PLAN, `${planLogKv(p)} caps_known=${this.capsKnown}`);
    }
    return p;
  }

  /**
   * iOS: who knows whether the runtime studio voice can be tried for a language (RemoteVoice wires itself here).
   * undefined = never (plans stay text-only unless clips upgrade them).
   */
  setStudioVoiceSource(f: ((lang: Lang) => boolean) | undefined): void {
    this.studioLangs = f;
  }

  /** iOS: true when RemoteVoice may ask the server for sentences in this language. Never throws. */
  hasStudioVoice(textLang: Lang): boolean {
    try {
      return this.studioLangs !== undefined && this.studioLangs(textLang);
    } catch (e) {
      return false;
    }
  }

  /**
   * iOS adjustment of the pure plan (see the header). Only a platform text-only plan that is not a cross-language
   * listen choice changes; the user's TEXT_ONLY_USER plan never does.
   */
  private iosPlan(textLang: Lang, base: VoicePlan): VoicePlan {
    if (base.label !== VoiceLabel.TEXT_ONLY_PLATFORM || base.speechMode !== SPEECH_MODE_TEXT || isListenChoice(base)) {
      return base;
    }
    const reason = `no_voice_for_lang=${textLang} system_tts=none`;
    if (!this.hasStudioVoice(textLang)) {
      const t: VoicePlan = {
        textLang: textLang, speechMode: SPEECH_MODE_TEXT, engineLocale: '', person: 0, languageContext: '',
        label: VoiceLabel.TEXT_ONLY_PLATFORM, reason: reason
      };
      return t;
    }
    const v: VoicePlan = {
      textLang: textLang, speechMode: SPEECH_MODE_VOICE, engineLocale: '', person: 0, languageContext: '',
      label: VoiceLabel.PRERENDERED, reason: `${reason} studio=remote fallback=text`
    };
    return v;
  }

  /** A13: who knows which story languages have pre-rendered clips (NarrationPlayer's manifest). */
  setClipSource(f: (lang: string) => boolean): void {
    this.clipLangs = f;
  }

  /** A13: true when the clip manifest covers this story language. Never throws. */
  hasClips(textLang: Lang): boolean {
    try {
      return this.clipLangs !== undefined && this.clipLangs(textLang);
    } catch (e) {
      return false;
    }
  }

  /**
   * The plan for stop stories, i.e. what the UI labels and the tour engine runs on: plan() upgraded to the studio
   * clips (PRERENDERED, 'voice') when the manifest covers the language (ClipSelection.storyVoicePlan).
   * plan() stays the per-sentence fallback for dynamic lines and sentences without a clip.
   */
  storyPlan(textLang: Lang): VoicePlan {
    const base = this.plan(textLang);
    const p = storyVoicePlan(base, this.hasClips(textLang));
    if (p !== base) {
      Log.i(LogEvents.VOICE_PLAN, `event=story_plan ${planLogKv(p)}`);
    }
    return p;
  }

  downloadEnglish(onProgress: (pct: number) => void): Promise<boolean> {
    if (this.downloading) {
      Log.w(LogEvents.VOICE_DL_FAIL, 'code=busy msg=download already running');
      return Promise.resolve(false);
    }
    if (this.caps.en === VoiceState.INSTALLED && this.enEngineFail === 0) {
      Log.i(LogEvents.VOICE_STATUS, 'event=download_skipped en=INSTALLED');
      return Promise.resolve(true);
    }
    this.downloading = true;
    Log.i(LogEvents.VOICE_STATUS, `event=download_start lang=${EN_LOCALE} person=${EN_PERSON}`);
    return new Promise<boolean>((resolve) => {
      const cb: DownloadCallbacks = {
        onStart: () => {
          Log.i(LogEvents.VOICE_STATUS, 'event=download_started');
        },
        onProgress: (pct: number) => {
          try {
            onProgress(pct);
          } catch (e) {
            Log.w(LogEvents.UNCAUGHT, `where=downloadEnglish.onProgress ${Log.errKv(e)}`);
          }
        },
        onComplete: () => {
          this.lastDlCode = 0;
          this.afterDownloadOk('complete').then(() => resolve(true));
        },
        onCancel: () => {
          this.downloading = false;
          this.lastDlCode = -7;
          Log.w(LogEvents.VOICE_DL_FAIL, 'code=cancelled msg=user cancelled the download dialog');
          this.plan(Lang.EN);
          resolve(false);
        },
        onError: (code: number, msg: string) => {
          if (code === TtsErr.KIT_DL_ALREADY) {
            this.lastDlCode = 0;
            this.afterDownloadOk('already_downloaded').then(() => resolve(true));
            return;
          }
          this.downloading = false;
          this.lastDlCode = code;
          Log.e(LogEvents.VOICE_DL_FAIL, `code=${code} msg=${msg}`);
          this.plan(Lang.EN); // logs that the plan stays on the fallback
          resolve(false);
        }
      };
      this.engines.downloadVoice(EN_LOCALE, EN_PERSON, cb);
    });
  }

  setStrategy(s: EnVoiceStrategy): void {
    if (s === this.strategyValue) {
      return;
    }
    Log.i(LogEvents.SETTINGS, `key=enVoiceStrategy from=${this.strategyValue} to=${s}`);
    this.strategyValue = s;
  }

  // ---------- extras (Settings B9, Onboarding A12, DevPanel) ----------

  strategy(): EnVoiceStrategy {
    return this.strategyValue;
  }

  setVoiceLang(v: VoiceLang | undefined): void {
    this.voiceLangValue = v;
  }

  /** languageContext for the zh voice reading English: 'en-US' (default) or 'zh-CN' (G1 A/B). */
  setFallbackEnContext(ctx: string): void {
    this.fallbackCtx = ctx === ZH_LOCALE ? ZH_LOCALE : EN_LOCALE;
    Log.i(LogEvents.SETTINGS, `key=fallbackEnContext to=${this.fallbackCtx}`);
  }

  fallbackEnContext(): string {
    return this.fallbackCtx;
  }

  lastCaps(): SpeechCapabilities {
    return this.effectiveCaps();
  }

  isDownloading(): boolean {
    return this.downloading;
  }

  /**
   * The caller gave up waiting (Settings/Onboarding: no progress event for 30 s, e.g. the system "Download language
   * package?" dialog was cancelled, which on the emulator sends no callback at all). Frees the busy flag so a later
   * "Try again" really calls downloadVoice again; a late callback of the abandoned attempt still updates the caps.
   */
  abandonDownload(reason: string): void {
    if (!this.downloading) {
      return;
    }
    this.downloading = false;
    this.lastDlCode = -8;
    Log.w(LogEvents.VOICE_DL_FAIL, `code=abandoned reason=${reason}`);
  }

  /** 0 = no failure yet / success, else the last download error code (1002300008 on the emulator). */
  lastDownloadCode(): number {
    return this.lastDlCode;
  }

  /** Called by NarrationPlayer when createEngine fails for a voice the plan picked. */
  markEngineFailed(locale: string, person: number, code: number): void {
    if (locale === EN_LOCALE) {
      this.enEngineFail = code !== 0 ? code : -1;
    } else {
      this.zhEngineFail = code !== 0 ? code : -1;
    }
    const c = this.effectiveCaps();
    Log.w(LogEvents.VOICE_STATUS,
      `event=engine_failed engine=${locale}/${person} code=${code} en=${stateTag(c.en)} zh=${stateTag(c.zh)}`);
  }

  /** listVoices now (also after a download). Never rejects. */
  refresh(): Promise<SpeechCapabilities> {
    if (this.querying !== undefined) {
      return this.querying;
    }
    const t0 = Date.now();
    this.querying = this.engines.listVoices().then((voices: VoiceInfo[]) => {
      const entries: VoiceEntry[] = [];
      const desc: string[] = [];
      for (const v of voices) {
        const e: VoiceEntry = { language: v.language, person: v.person, status: v.status };
        entries.push(e);
        desc.push(`${v.language}/${v.person}/${v.status !== undefined ? v.status : '?'}`);
      }
      this.caps = capsFromVoices(entries);
      this.capsKnown = true;
      this.querying = undefined;
      const c = this.effectiveCaps();
      Log.i(LogEvents.VOICE_STATUS, `en=${stateTag(c.en)} zh=${stateTag(c.zh)} src=listVoices ms=${Date.now() - t0}` +
        ` voices=${desc.join(',')} system_tts=none`);
      return c;
    }).catch((e: unknown) => {
      this.querying = undefined;
      this.caps = { en: VoiceState.ERROR, zh: VoiceState.ERROR };
      Log.e(LogEvents.VOICE_STATUS, `en=ERROR zh=ERROR src=listVoices code=${errCode(e)} msg=${errMsg(e)}`);
      return this.effectiveCaps();
    });
    return this.querying;
  }

  private effectiveCaps(): SpeechCapabilities {
    const c: SpeechCapabilities = {
      en: this.enEngineFail !== 0 && this.caps.en === VoiceState.INSTALLED ? VoiceState.ERROR : this.caps.en,
      zh: this.zhEngineFail !== 0 ? VoiceState.UNAVAILABLE : this.caps.zh
    };
    return c;
  }

  private afterDownloadOk(how: string): Promise<void> {
    this.enEngineFail = 0;
    this.engines.clearFailure(EN_LOCALE, EN_PERSON);
    Log.i(LogEvents.VOICE_STATUS, `event=download_ok how=${how}`);
    return this.refresh().then(() => {
      this.downloading = false;
      this.plan(Lang.EN);
    });
  }
}
