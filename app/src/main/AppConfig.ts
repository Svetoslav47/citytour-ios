/*
 * Build-time switches. One place to flip a strategy without touching feature code (PLAN §0.4).
 */
import { EnVoiceStrategy } from '@citytour/core';

export class AppConfig {
  static readonly APP_VERSION: string = '1.0.0'; // keep equal to AppScope/app.json5 versionName

  /** User decision 2026-10-03: Laura if installed, else the zh-CN voice reads English ("Fallback voice"). */
  static readonly DEFAULT_EN_VOICE_STRATEGY: EnVoiceStrategy = EnVoiceStrategy.AUTO_NATIVE_THEN_ZH;

  /** Emergency switch (RISKS T7): true = TTS playType 1 (system playback) instead of our PCM AudioRenderer. */
  static readonly USE_SYSTEM_PLAYBACK: boolean = false;

  /** Demo walk replay speed multiplier (1 | 2 | 4 | 8). */
  static readonly DEMO_DEFAULT_SPEED: number = 4;

  /** ScriptedTourControl (the UI fake) advances one snapshot every this many ms at speed 1. */
  static readonly SCRIPTED_STEP_MS: number = 2000;

  // ---- Debug fault injection (ARCHITECTURE §9, task A10). ALL false in git. Flip one locally, rebuild, and the
  // matching row of the README "Error handling" table can be shown on the emulator. Every simulated failure logs
  // src=debug, so a log line never passes a fake failure off as a real one.

  /** §9 row 9: every TextToSpeech createEngine rejects with 1002300005 => text-only stories + TTS_INIT_FAIL. */
  static readonly DEBUG_FAIL_TTS_INIT: boolean = false;

  /** §9 row 17: the offline pack reports pois.json as unparseable => PACK_ERR, Home shows the damaged-data state. */
  static readonly DEBUG_CORRUPT_PACK: boolean = false;

  /** §9 row 14: startBackgroundRunning is refused => BG_FAIL, the tour runs in the foreground, screen kept on. */
  static readonly DEBUG_FAIL_BG_START: boolean = false;

  /** Launch parameter that opens the developer page: `aa start ... --ps page dev`. */
  static readonly LAUNCH_PARAM_PAGE: string = 'page';
  static readonly LAUNCH_PAGE_DEV: string = 'dev';
}
