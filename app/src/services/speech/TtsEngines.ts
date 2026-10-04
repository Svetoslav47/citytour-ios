/*
 * System TTS engines: DROPPED in the iOS port (docs/PORTING.md, product decision).
 *
 * On HarmonyOS this class owned the Core Speech Kit engines (createEngine / speak / listVoices / downloadVoice,
 * ARCHITECTURE §2.5, task A4). The iOS port has no on-device voice at all: the voice chain is
 *   pre-rendered course clip (sentence SHA-256) -> runtime studio voice from the server (RemoteVoice, POST /v1/tts)
 *   -> on-screen text only.
 * This stub keeps the same class name, error codes and helpers so VoiceManager and the code reading TtsErr compile and
 * behave like a device on which no voice is installed:
 *   - listVoices() resolves [] -> capsFromVoices gives en=UNAVAILABLE zh=UNAVAILABLE (no engine is ever planned);
 *   - get()/speak() never create anything: they fail with ENGINE_UNAVAILABLE (nothing calls them on iOS);
 *   - downloadVoice() fails at once with UNSUPPORTED (there is nothing to download).
 */
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';

/** Our own error codes (negative, so they never collide with the kit's 1002300xxx codes). */
export class TtsErr {
  static readonly TIMEOUT: number = -2;
  static readonly ENGINE_UNAVAILABLE: number = -3;
  static readonly THREW: number = -4;
  static readonly RENDERER: number = -5;
  static readonly WATCHDOG: number = -6;
  /** iOS port: there is no system TTS, so there is no voice to download and no engine to create. */
  static readonly UNSUPPORTED: number = -9;
  /** Kit (HarmonyOS only, kept for log/UI compatibility): createEngine failed, voice model missing (RISKS a4). */
  static readonly KIT_ENGINE_CREATE: number = 1002300005;
  /** Kit (HarmonyOS only): downloadVoice failed (RISKS a5). */
  static readonly KIT_DL_FAILED: number = 1002300008;
  /** Kit (HarmonyOS only): the voice is already downloaded, which counts as success. */
  static readonly KIT_DL_ALREADY: number = 1002300010;
}

export const ENGINE_CREATE_TIMEOUT_MS: number = 6000;
export const LIST_VOICES_TIMEOUT_MS: number = 5000;
export const DOWNLOAD_TIMEOUT_MS: number = 300000;

/** The fields of a listed voice that VoicePolicy reads (textToSpeech.VoiceInfo on HarmonyOS). */
export interface VoiceInfo {
  language: string;
  person: number;
  status?: string;
}

/** Per-request callbacks (kept for API compatibility; nothing calls them on iOS). */
export interface TtsRequestHandler {
  onStart: (sampleRate: number, channels: number) => void;
  onData: (audio: ArrayBuffer, sequence: number) => void;
  onComplete: (type: number) => void;
  onStop: () => void;
  onError: (code: number, message: string) => void;
}

export interface DownloadCallbacks {
  onStart: () => void;
  onProgress: (pct: number) => void;
  onComplete: () => void;
  onCancel: () => void;
  onError: (code: number, message: string) => void;
}

interface CodedError {
  code?: unknown;
  message?: unknown;
}

export function errCode(e: unknown): number {
  if (e === undefined || e === null) {
    return -1;
  }
  const c = (e as CodedError).code;
  return typeof c === 'number' ? c : -1;
}

export function errMsg(e: unknown): string {
  if (e === undefined || e === null) {
    return 'unknown';
  }
  const m = (e as CodedError).message;
  return typeof m === 'string' ? m : 'unknown';
}

/** Rejects with {code: TtsErr.TIMEOUT} if p does not settle within ms. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const t = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject({ code: TtsErr.TIMEOUT, message: `${what} timeout ${ms}ms`, name: 'Timeout' });
      }
    }, ms);
    p.then((v: T) => {
      if (!settled) {
        settled = true;
        clearTimeout(t);
        resolve(v);
      }
    }).catch((e: unknown) => {
      if (!settled) {
        settled = true;
        clearTimeout(t);
        reject(e);
      }
    });
  });
}

export const NO_TTS_MSG: string = 'no system TTS on iOS (dropped by decision)';

export class TtsEngines {
  private seq: number = 0;
  private loggedOnce: boolean = false;

  static key(locale: string, person: number): string {
    return `${locale}/${person}`;
  }

  /** Unique per call: "<tag>#<ms>#<n>". */
  newRequestId(tag: string): string {
    this.seq++;
    return `${tag}#${Date.now()}#${this.seq}`;
  }

  /** No engine is ever tried, so none has failed. */
  failure(locale: string, person: number): number {
    return 0;
  }

  clearFailure(locale: string, person: number): void {
    // nothing cached
  }

  isReady(locale: string, person: number): boolean {
    return false;
  }

  /** Never creates an engine. */
  get(locale: string, person: number): Promise<never> {
    if (!this.loggedOnce) {
      this.loggedOnce = true;
      Log.w(LogEvents.TTS_INIT_FAIL, `engine=${TtsEngines.key(locale, person)} code=${TtsErr.UNSUPPORTED} msg=${NO_TTS_MSG}`);
    }
    return Promise.reject({ code: TtsErr.ENGINE_UNAVAILABLE, message: NO_TTS_MSG, name: 'Unsupported' });
  }

  /** Never speaks: the handler gets one onError (async, like the kit). */
  speak(locale: string, person: number, text: string, requestId: string, extra: Record<string, unknown>,
    h: TtsRequestHandler): void {
    setTimeout(() => {
      try {
        h.onError(TtsErr.ENGINE_UNAVAILABLE, NO_TTS_MSG);
      } catch (e) {
        Log.e(LogEvents.UNCAUGHT, `where=TtsEngines.speak ${Log.errKv(e)}`);
      }
    }, 0);
  }

  forget(requestId: string): void {
    // no requests
  }

  stop(locale: string, person: number): void {
    // no engines
  }

  stopAll(): void {
    // no engines
  }

  shutdownAll(): void {
    // no engines
  }

  /** No system voice is installed or installable on iOS. */
  listVoices(): Promise<VoiceInfo[]> {
    return Promise.resolve([]);
  }

  /** Nothing to download: one onError(UNSUPPORTED), asynchronously. */
  downloadVoice(locale: string, person: number, cb: DownloadCallbacks): void {
    setTimeout(() => {
      try {
        cb.onError(TtsErr.UNSUPPORTED, NO_TTS_MSG);
      } catch (e) {
        Log.e(LogEvents.UNCAUGHT, `where=TtsEngines.downloadVoice ${Log.errKv(e)}`);
      }
    }, 0);
  }
}
