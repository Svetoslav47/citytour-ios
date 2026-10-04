/*
 * Per-sentence voice fallback chain (docs/SERVER.md §2). Pure: no @kit imports, unit-tested in
 * entry/src/test/VoiceChain.test.ets.
 *
 *   1. clip          a pre-rendered clip of the downloaded course (ClipSelection, hash of the sentence)
 *   2. remote_cache  a runtime studio line rendered earlier (filesDir/tts/<sha>.mp3)
 *   3. remote        POST /v1/tts within REMOTE_BUDGET_MS, only when "Online studio voice" is on, the server is
 *                    configured and not known to be offline or out of budget; X-Text-Sha256 must equal our sha
 *   4. tts           the built-in Core Speech voice ("Fallback voice")
 *   5. text          no voice for this language (Polish without clip and server), or the user chose text only
 * The user's explicit "text only" and cross-language "listen in" choices never get studio audio (as for clips).
 */

export const REMOTE_BUDGET_MS: number = 2500;
/** After a network failure, skip the server for this long (no 2.5 s wait per sentence while offline). */
export const OFFLINE_BACKOFF_MS: number = 60000;
/** After a 429 (daily character budget), skip the server for this long. */
export const BUDGET_BACKOFF_MS: number = 10 * 60000;

export enum VoiceSrc {
  CLIP = 'prerendered',
  REMOTE_CACHE = 'remote_cache',
  REMOTE = 'remote',
  TTS = 'tts',
  TEXT = 'text'
}

/** Server state shown in the HUD Voice/Server row. */
export enum ServerState { ONLINE = 'online', OFFLINE = 'offline', BUDGET = 'budget', DISABLED = 'disabled' }

export class ChainInput {
  localClip: boolean = false;      // ClipSelection found a playable clip
  userOptOut: boolean = false;     // the user's text-only or cross-language listen choice
  cached: boolean = false;         // filesDir/tts/<sha>.mp3 exists
  toggleOn: boolean = true;        // Settings "Online studio voice"
  serverConfigured: boolean = false; // RemoteConfig.BASE_URL non-empty
  courseKnown: boolean = true;     // a course id to send (allowed-lines set)
  textSendable: boolean = true;    // within the 400-char / 1 KB limits
  offlineUntilMs: number = 0;
  budgetUntilMs: number = 0;
  nowMs: number = 0;
  platformText: boolean = false;   // the plan's own path is text (Polish without a voice)
}

export class ChainStep {
  src: VoiceSrc = VoiceSrc.TTS;
  /** 'remote' means: ask the server now, fall back to `fallback` on any failure. */
  fallback: VoiceSrc = VoiceSrc.TTS;
  reason: string = '';
}

function fallbackOf(i: ChainInput): VoiceSrc {
  return i.platformText ? VoiceSrc.TEXT : VoiceSrc.TTS;
}

/** The first step for one sentence. Never throws. */
export function decideVoice(i: ChainInput): ChainStep {
  const s = new ChainStep();
  s.fallback = fallbackOf(i);
  if (i.localClip) {
    s.src = VoiceSrc.CLIP;
    s.reason = 'hash_match';
    return s;
  }
  if (i.userOptOut) {
    s.src = s.fallback;
    s.reason = 'user_choice';
    return s;
  }
  if (!i.serverConfigured) {
    s.src = s.fallback;
    s.reason = 'server_disabled';
    return s;
  }
  if (!i.toggleOn) {
    s.src = s.fallback;
    s.reason = 'toggle_off';
    return s;
  }
  if (i.cached) {
    s.src = VoiceSrc.REMOTE_CACHE;
    s.reason = 'cache_hit';
    return s;
  }
  if (!i.courseKnown) {
    s.src = s.fallback;
    s.reason = 'no_course';
    return s;
  }
  if (!i.textSendable) {
    s.src = s.fallback;
    s.reason = 'text_limits';
    return s;
  }
  if (i.nowMs < i.budgetUntilMs) {
    s.src = s.fallback;
    s.reason = 'budget';
    return s;
  }
  if (i.nowMs < i.offlineUntilMs) {
    s.src = s.fallback;
    s.reason = 'offline';
    return s;
  }
  s.src = VoiceSrc.REMOTE;
  s.reason = 'no_clip';
  return s;
}

/** What came back from POST /v1/tts. status 0 = no HTTP response (network error, DNS, TLS). */
export class RemoteResult {
  status: number = 0;
  timedOut: boolean = false;
  headerSha: string = '';
  contentType: string = '';
  bytes: number = 0;
  elapsedMs: number = 0;
}

export class RemoteVerdict {
  accept: boolean = false;
  reason: string = '';
  /** New server state for the HUD; DISABLED is never produced here. */
  server: ServerState = ServerState.ONLINE;
  /** Back off until now + this (0 = no back-off). */
  offlineForMs: number = 0;
  budgetForMs: number = 0;
  /** 403 not_allowed: this exact line is refused for good; never ask again for this sha (SERVER.md §3.1). */
  neverRetry: boolean = false;
}

/** Judges one /v1/tts response against our own sha256 of the text. Never throws. */
export function judgeRemote(r: RemoteResult, localSha: string, budgetMs: number = REMOTE_BUDGET_MS): RemoteVerdict {
  const v = new RemoteVerdict();
  if (r.timedOut || r.elapsedMs > budgetMs) {
    v.reason = 'timeout';
    v.server = ServerState.ONLINE;   // reachable but slow: try again for the next sentence
    return v;
  }
  if (r.status === 0) {
    v.reason = 'offline';
    v.server = ServerState.OFFLINE;
    v.offlineForMs = OFFLINE_BACKOFF_MS;
    return v;
  }
  if (r.status === 429) {
    v.reason = 'http_429';
    v.server = ServerState.BUDGET;
    v.budgetForMs = BUDGET_BACKOFF_MS;
    return v;
  }
  if (r.status >= 500) {
    v.reason = `http_${r.status}`;
    v.server = ServerState.OFFLINE;
    v.offlineForMs = OFFLINE_BACKOFF_MS;
    return v;
  }
  if (r.status === 403) {
    v.reason = 'http_403';
    v.neverRetry = true;
    return v;
  }
  if (r.status !== 200) {
    v.reason = `http_${r.status}`;   // 400/401/404/413: this line or token is refused; the server is up
    return v;
  }
  if (r.headerSha.toLowerCase() !== localSha.toLowerCase() || localSha === '') {
    v.reason = r.headerSha === '' ? 'sha_missing' : 'sha_mismatch';
    return v;
  }
  if (r.bytes <= 0) {
    v.reason = 'empty_body';
    return v;
  }
  if (r.contentType !== '' && r.contentType.toLowerCase().indexOf('audio/') !== 0) {
    v.reason = 'content_type';
    return v;
  }
  v.accept = true;
  v.reason = 'ok';
  return v;
}

/** HUD text for the server state. */
export function serverStateText(s: ServerState): string {
  switch (s) {
    case ServerState.ONLINE:
      return 'server online';
    case ServerState.OFFLINE:
      return 'server offline';
    case ServerState.BUDGET:
      return 'server budget reached';
    default:
      return 'server disabled';
  }
}
