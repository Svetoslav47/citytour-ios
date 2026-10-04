/*
 * CityTour shared contracts: tour engine types, the snapshot B's UI renders, and issues.
 * Sources: docs/ARCHITECTURE.md §12.2 (TourPhase .. EngineSnapshot, verbatim), §4.2 (events/effects),
 * §4.4 (Announcement, Priority), §9 (AppIssue/IssueCode), §6.4 + PLAN A2 (TourPlan),
 * PLAN T0 (EngineSnapshot.voiceLabel/source/platform, PlatformStatus).
 * ArkTS has no discriminated unions of object literals: events and effects are one interface each,
 * with a string-enum `type` and optional payload fields.
 * Imports from Ports.ets are type-only uses, so the Ports <-> EngineTypes cycle has no runtime effect.
 */
import { ContentTier, Lang, RouteLeg } from './Model';
import { VoiceLabel } from './Settings';
import { Fix, FixSource, Utterance } from './Ports';

// ---------- Snapshot (ARCHITECTURE §12.2) ----------

export enum TourPhase {
  IDLE = 'idle', PLANNING = 'planning', READY = 'ready', WALKING = 'walking',
  APPROACHING = 'approaching', AT_STOP = 'atStop', FINISHED = 'finished', ABORTED = 'aborted'
}

export enum StopStatus {
  PENDING = 'pending', APPROACHING = 'approaching', VISITED = 'visited', TEASER_ONLY = 'teaserOnly', SKIPPED = 'skipped'
}

export enum SignalQuality { GOOD = 'good', POOR = 'poor', LOST = 'lost' }

export enum RelDir {
  AHEAD = 'ahead', AHEAD_RIGHT = 'aheadRight', RIGHT = 'right', BEHIND_RIGHT = 'behindRight', BEHIND = 'behind',
  BEHIND_LEFT = 'behindLeft', LEFT = 'left', AHEAD_LEFT = 'aheadLeft', HERE = 'here'
}

export interface StopProgress {
  poiId: string;
  order: number;
  status: StopStatus;
}

export interface NextInfo {
  poiId: string;
  distanceM: number;
  etaS: number;
  relDir: RelDir;
  bearingDeg: number;
  maneuverText: string;
  maneuverDistM: number;
}

export interface NowPlaying {
  itemId: string;
  poiId: string;
  kind: string;
  sentenceIndex: number;
  sentenceCount: number;
  caption: string;
  tier: ContentTier;
  lang: Lang;
}

export interface UserPos {
  x: number;
  y: number;
  lat: number;
  lng: number;
  accuracyM: number;
  courseDeg: number;
  speedMps: number;
  source: FixSource;
}

/** Live platform status for the "How it works" HUD (B12). Added in T0. */
export interface PlatformStatus {
  bgRunning: boolean;          // continuous task ['location','audioPlayback'] active
  avsActive: boolean;          // AVSession activated
  ttsEngine: string;           // e.g. 'zh-CN/13', 'en-US/8', 'none'
  sourceKind: FixSource;       // active location source
  realGpsAccuracyM: number;    // last real-source accuracy, NaN if no real fix
  demoHold: boolean;           // Demo walk is holding at a stop while the story plays ("Demo assist")
}

// ---------- Issues (ARCHITECTURE §9) ----------

export enum IssueSeverity { INFO = 'info', WARN = 'warn', BLOCKING = 'blocking' }

/** One code per row of the §9 error matrix. */
export enum IssueCode {
  PERM_DENIED = 'PERM_DENIED',             // 1
  PERM_APPROX_ONLY = 'PERM_APPROX_ONLY',   // 2
  LOC_SWITCH_OFF = 'LOC_SWITCH_OFF',       // 3
  LOC_NOFIX = 'LOC_NOFIX',                 // 4
  LOC_LOST = 'LOC_LOST',                   // 5
  LOC_POOR = 'LOC_POOR',                   // 6
  LOC_UNAVAILABLE = 'LOC_UNAVAILABLE',     // 7
  LOC_OUT_OF_AREA = 'LOC_OUT_OF_AREA',     // 8
  TTS_INIT_FAIL = 'TTS_INIT_FAIL',         // 9
  VOICE_UNAVAILABLE = 'VOICE_UNAVAILABLE', // 10
  TTS_ERR = 'TTS_ERR',                     // 11
  AUDIO_INTERRUPT = 'AUDIO_INTERRUPT',     // 12
  AUDIO_ROUTE_LOST = 'AUDIO_ROUTE_LOST',   // 13
  BG_FAIL = 'BG_FAIL',                     // 14
  AVS_FAIL = 'AVS_FAIL',                   // 15
  NOTIF_DENIED = 'NOTIF_DENIED',           // 16
  PACK_ERR = 'PACK_ERR',                   // 17
  NARR_FALLBACK = 'NARR_FALLBACK',         // 18
  ROUTE_FALLBACK = 'ROUTE_FALLBACK',       // 19, 20
  UNCAUGHT = 'UNCAUGHT'                    // 22
}

export interface AppIssue {
  code: IssueCode;
  severity: IssueSeverity;
  detail: string;
}

export interface EngineSnapshot {
  phase: TourPhase;
  tourId: string;
  stops: StopProgress[];
  currentStopIdx: number;
  next?: NextInfo;
  nowPlaying?: NowPlaying;
  user?: UserPos;
  signal: SignalQuality;
  offRoute: boolean;
  paused: boolean;
  speechText: boolean;         // speechText = text-only mode
  plannedOrder: string[];
  walkedM: number;
  remainingM: number;
  issues: AppIssue[];
  // T0 additions (PLAN §0.4 / T0 card)
  voiceLabel: VoiceLabel;      // "Fallback voice" chip, Settings voice row, AVSession artist
  source: FixSource;           // REAL | DEMO; DEMO => SIMULATED badge on every surface
  platform: PlatformStatus;
}

// ---------- Planning (ARCHITECTURE §6.4, PLAN A2) ----------

export interface TourPlan {
  tourId: string;
  order: string[];             // poiIds in walking order
  costS: number;               // walk + dwell seconds
  walkM: number;               // walking distance in metres
  savedM: number;              // metres saved vs the listed order (Route ready shows it)
  exact: boolean;              // false for the NN + 2-opt fallback
  algo: string;                // 'heldkarp' | 'orienteering' | 'nn2opt'
  ms: number;                  // solver time
  budgetS: number;             // 0 = no time budget
  legs: RouteLeg[];            // legs in walking order (may be empty when only haversine estimates exist)
}

// ---------- Announcement queue (ARCHITECTURE §4.4) ----------

/** Lower value = higher priority, so the queue can compare numerically. */
export enum Priority { P0_SYSTEM = 0, P1_NAV = 1, P2_STORY = 2, P3_APPROACH = 3, P4_AMBIENT = 4 }

export enum AnnouncementKind {
  SYSTEM = 'system', NAV_CUE = 'navCue', STOP_STORY = 'stopStory', FULL_STORY = 'fullStory',
  DEEP_STORY = 'deepStory', APPROACH = 'approach', AMBIENT = 'ambient'
}

export interface Announcement {
  id: string;
  priority: Priority;
  kind: AnnouncementKind;
  poiId?: string;
  utterances: Utterance[];
  cursor: number;
  expiresAtMs: number;         // Number.POSITIVE_INFINITY = never (P2)
  dedupeKey: string;
}

// ---------- Events and effects (ARCHITECTURE §4.2) ----------

export enum EngineEventType {
  START_PLANNING = 'START_PLANNING', PLAN_READY = 'PLAN_READY', PLAN_FAILED = 'PLAN_FAILED', START_TOUR = 'START_TOUR',
  FIX = 'FIX', FIX_TIMEOUT = 'FIX_TIMEOUT',
  UTTERANCE_STARTED = 'UTTERANCE_STARTED', UTTERANCE_DONE = 'UTTERANCE_DONE', UTTERANCE_FAILED = 'UTTERANCE_FAILED',
  USER_PAUSE = 'USER_PAUSE', USER_RESUME = 'USER_RESUME', USER_SKIP = 'USER_SKIP', USER_REPLAY = 'USER_REPLAY',
  USER_MORE = 'USER_MORE', USER_END = 'USER_END',
  AUDIO_INTERRUPT = 'AUDIO_INTERRUPT', AUDIO_ROUTE_LOST = 'AUDIO_ROUTE_LOST', BG_CANCELLED = 'BG_CANCELLED',
  TICK = 'TICK'
}

export interface EngineEvent {
  type: EngineEventType;
  nowMs: number;
  fix?: Fix;                   // FIX
  plan?: TourPlan;             // PLAN_READY
  utteranceId?: string;        // UTTERANCE_*
  code?: number;               // UTTERANCE_FAILED, PLAN_FAILED
  hint?: string;               // AUDIO_INTERRUPT(hint)
  reason?: string;             // BG_CANCELLED(reason), PLAN_FAILED
}

export enum HapticKind { ARRIVE = 'arrive', APPROACH = 'approach', OFF_ROUTE = 'offRoute', FINISH = 'finish' }

export enum MediaPlayState { PLAY = 'play', PAUSE = 'pause', STOP = 'stop' }

/** AVSession metadata. The executor appends " · DEMO" to the artist line. */
export interface MediaMeta {
  title: string;
  artist: string;
  voiceLabel: VoiceLabel;
  demo: boolean;
  album?: string;              // "{city} · {tour title}" (TourController, CityPack.albumLine)
}

/** Next-stop notification content ("Next: Wawel 240 m"). */
export interface NextNotice {
  poiId: string;
  title: string;
  text: string;
  distanceM: number;
}

export enum EffectType {
  SPEAK = 'SPEAK', STOP_SPEECH = 'STOP_SPEECH',
  SET_MEDIA_META = 'SET_MEDIA_META', SET_MEDIA_STATE = 'SET_MEDIA_STATE', NOTIFY_NEXT = 'NOTIFY_NEXT', HAPTIC = 'HAPTIC',
  REQUEST_REPLAN = 'REQUEST_REPLAN', PERSIST_PROGRESS = 'PERSIST_PROGRESS', LOG = 'LOG'
}

export interface Effect {
  type: EffectType;
  utterance?: Utterance;       // SPEAK
  afterCurrent?: boolean;      // STOP_SPEECH
  meta?: MediaMeta;            // SET_MEDIA_META
  playState?: MediaPlayState;  // SET_MEDIA_STATE
  notice?: NextNotice;         // NOTIFY_NEXT
  haptic?: HapticKind;         // HAPTIC
  logCode?: string;            // LOG: event code from app/LogEvents.ets
  logKv?: string;              // LOG: "k=v k=v"
}
