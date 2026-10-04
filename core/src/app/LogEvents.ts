/*
 * Event codes for app/Log.ets, from docs/ARCHITECTURE.md §10 (plus the §9 error-matrix codes).
 * Format of every line: "<EVENT> k=v k=v" under domain 0xC17A, tag CityTour.
 */
export class LogEvents {
  // App
  static readonly APP_START: string = 'APP_START';
  static readonly APP_STOP: string = 'APP_STOP';
  static readonly APP_FG: string = 'APP_FG';
  static readonly APP_BG: string = 'APP_BG';
  static readonly APP_PAGE: string = 'APP_PAGE';
  static readonly SETTINGS: string = 'SETTINGS';
  // Pack
  static readonly PACK_LOAD: string = 'PACK_LOAD';
  static readonly PACK_ERR: string = 'PACK_ERR';
  static readonly PACK_DROP: string = 'PACK_DROP';
  // Permissions
  static readonly PERM_DENIED: string = 'PERM_DENIED';
  static readonly PERM_APPROX_ONLY: string = 'PERM_APPROX_ONLY';
  // Location
  static readonly LOC_SOURCE: string = 'LOC_SOURCE';
  static readonly LOC_FIX: string = 'LOC_FIX';
  static readonly LOC_POOR: string = 'LOC_POOR';
  static readonly LOC_LOST: string = 'LOC_LOST';
  static readonly LOC_BACK: string = 'LOC_BACK';
  static readonly LOC_ERR: string = 'LOC_ERR';
  static readonly LOC_SWITCH_OFF: string = 'LOC_SWITCH_OFF';
  static readonly LOC_NOFIX: string = 'LOC_NOFIX';
  static readonly LOC_UNAVAILABLE: string = 'LOC_UNAVAILABLE';
  static readonly LOC_OUT_OF_AREA: string = 'LOC_OUT_OF_AREA';
  // Planning
  static readonly ROUTE_PLAN: string = 'ROUTE_PLAN';
  static readonly REPLAN: string = 'REPLAN';
  static readonly ROUTE_FALLBACK: string = 'ROUTE_FALLBACK';
  // Engine
  static readonly STATE: string = 'STATE';
  static readonly POI_APPROACH: string = 'POI_APPROACH';
  static readonly POI_ENTER: string = 'POI_ENTER';
  static readonly POI_EXIT: string = 'POI_EXIT';
  static readonly OFF_ROUTE: string = 'OFF_ROUTE';
  static readonly ON_ROUTE: string = 'ON_ROUTE';
  static readonly TOUR_SUMMARY: string = 'TOUR_SUMMARY';   // B11: tour ended -> summary built / shown
  // Narration
  static readonly STORY_QUEUE: string = 'STORY_QUEUE';
  static readonly STORY_START: string = 'STORY_START';
  static readonly STORY_END: string = 'STORY_END';
  static readonly STORY_SKIP_MOVING: string = 'STORY_SKIP_MOVING';
  static readonly STORY_LINGER: string = 'STORY_LINGER';
  static readonly NARR_SOURCE: string = 'NARR_SOURCE';
  static readonly NARR_FALLBACK: string = 'NARR_FALLBACK';
  static readonly NARR_PERSONA_FALLBACK: string = 'NARR_PERSONA_FALLBACK';
  static readonly QUEUE_EXPIRED: string = 'QUEUE_EXPIRED';
  static readonly NAV_CUE: string = 'NAV_CUE';
  // Speech / audio
  static readonly TTS_INIT: string = 'TTS_INIT';
  static readonly TTS_INIT_FAIL: string = 'TTS_INIT_FAIL';
  static readonly VOICE_STATUS: string = 'VOICE_STATUS';
  static readonly VOICE_PLAN: string = 'VOICE_PLAN';
  static readonly LANG_SWITCH: string = 'LANG_SWITCH';      // X2: mid-tour story language switch
  static readonly VOICE_DL_FAIL: string = 'VOICE_DL_FAIL';
  static readonly TTS_ERR: string = 'TTS_ERR';
  static readonly UTT_START: string = 'UTT_START';
  static readonly UTT_DONE: string = 'UTT_DONE';
  static readonly NARR_AUDIO: string = 'NARR_AUDIO';     // A13: src=prerendered|tts|text reason=... per sentence
  static readonly AUDIO_INTERRUPT: string = 'AUDIO_INTERRUPT';
  static readonly AUDIO_ROUTE: string = 'AUDIO_ROUTE';
  // Platform
  static readonly BG_START: string = 'BG_START';
  static readonly BG_STOP: string = 'BG_STOP';
  static readonly BG_FAIL: string = 'BG_FAIL';
  static readonly BG_SUSPEND: string = 'BG_SUSPEND';
  static readonly BG_CANCEL: string = 'BG_CANCEL';
  static readonly AVS_CMD: string = 'AVS_CMD';
  static readonly AVS_META: string = 'AVS_META';
  static readonly AVS_FAIL: string = 'AVS_FAIL';
  static readonly NOTIF_PUBLISH: string = 'NOTIF_PUBLISH';
  static readonly NOTIF_DENIED: string = 'NOTIF_DENIED';
  static readonly NOTIF_PERM: string = 'NOTIF_PERM';       // A8: consent state (enabled=0|1 asked=0|1)
  static readonly NOTIF_CANCEL: string = 'NOTIF_CANCEL';   // A8: notification 1001 removed (tour end, shutdown)
  static readonly NOTIF_FAIL: string = 'NOTIF_FAIL';       // A8: publish/cancel/slot/wantAgent error
  static readonly HAPTIC: string = 'HAPTIC';
  static readonly WIDGET: string = 'WIDGET';     // B14: home-screen card add/push/remove
  // Optional server (docs/SERVER.md): courses and the runtime studio voice
  static readonly REMOTE: string = 'REMOTE';             // HTTP call: path, status, ms, reason (never the token or text)
  static readonly COURSE: string = 'COURSE';             // catalog, download, verify, install, delete, active course
  static readonly REMOTE_TTS: string = 'REMOTE_TTS';     // POST /v1/tts outcome per line (sha prefix only)
  // Fakes and errors
  static readonly TOUR_SCRIPTED: string = 'TOUR_SCRIPTED';
  static readonly UNCAUGHT: string = 'UNCAUGHT';
}
