/*
 * CityTour shared contracts: ports between the engine, the platform services and the UI.
 * Sources: docs/ARCHITECTURE.md §5 (Fix, LocationSource, verbatim), §12.2 (Utterance, SpeechPort,
 * PackRepository, TourControl, verbatim), PLAN §0.4 (VoicePlan, VoicePort, VoiceState, SpeechCapabilities),
 * PLAN T0 (TourControl.setDemoSpeed/demoJumpToNext; PermissionPort, BackgroundPort, MediaSessionPort,
 * NotifierPort, HapticsPort, Clock, LoggerPort).
 * Imports from EngineTypes.ets are type-only uses, so the Ports <-> EngineTypes cycle has no runtime effect.
 */
import {
  Lang, MapData, Narration, NarrationLength, PackManifest, Persona, Poi, RouteData, SourceRef, Tour
} from './Model';
import { EnVoiceStrategy, VoiceLabel } from './Settings';
import {
  AppIssue, EngineSnapshot, HapticKind, MediaMeta, MediaPlayState, NextNotice, TourPlan
} from './EngineTypes';

// ---------- Location (ARCHITECTURE §5) ----------

export enum FixSource { REAL = 'real', DEMO = 'demo' }

export interface Fix {
  lat: number;                 // WGS-84
  lng: number;
  accuracyM: number;           // horizontal, metres
  speedMps: number;            // NaN if unknown
  courseDeg: number;           // 0..360, NaN if unknown
  courseAccuracyDeg: number;   // NaN if unknown
  timestampMs: number;         // UTC ms
  provider: number;            // 1 GNSS, 2 NETWORK, 3 INDOOR, 4 RTK, 0 unknown/demo
  source: FixSource;
}

export type FixListener = (fix: Fix) => void;
export type LocationErrorListener = (code: number, message: string) => void;

export interface LocationSource {
  readonly kind: FixSource;
  start(onFix: FixListener, onError: LocationErrorListener): Promise<void>;
  stop(): void;
  isRunning(): boolean;
}

// ---------- Speech (ARCHITECTURE §12.2, PLAN §0.4) ----------

export interface Utterance {
  id: string;
  itemId: string;
  text: string;
  lang: Lang;
  personaId: string;
}

export interface SpeechListener {
  onUtteranceStart(id: string): void;
  onUtteranceDone(id: string): void;
  onUtteranceError(id: string, code: number): void;
}

/** listVoices status mapped to our four states (GA -> DOWNLOADABLE). */
export enum VoiceState {
  INSTALLED = 'installed', DOWNLOADABLE = 'downloadable', UNAVAILABLE = 'unavailable', ERROR = 'error'
}

export interface SpeechCapabilities {
  en: VoiceState;
  zh: VoiceState;
}

export interface SpeechPort {
  init(): Promise<SpeechCapabilities>;
  setListener(l: SpeechListener): void;
  speak(u: Utterance): void;   // exactly one in flight; NarrationPlayer prefetches next itself
  prefetch(u: Utterance): void;
  stopNow(): void;
  pause(): void;
  resume(): void;
  isSpeaking(): boolean;
}

/** Resolved by the pure core/speech/VoicePolicy.resolveVoicePlan(textLang, strategy, caps). */
export interface VoicePlan {
  textLang: Lang;
  speechMode: string;          // 'voice' | 'text'
  engineLocale: string;        // 'en-US' | 'zh-CN' | ''
  person: number;              // 8 Laura (en-US), 13 (zh-CN), 0 when text-only
  languageContext: string;
  label: VoiceLabel;
  reason: string;              // e.g. 'en_status=DOWNLOADABLE'
}

export interface VoicePort {
  capabilities(): Promise<SpeechCapabilities>;
  plan(textLang: Lang): VoicePlan;
  downloadEnglish(onProgress: (pct: number) => void): Promise<boolean>;
  setStrategy(s: EnVoiceStrategy): void;
}

// ---------- Pack (ARCHITECTURE §12.2) ----------

export interface PackLoadResult {
  ok: boolean;
  manifest?: PackManifest;
  issues: AppIssue[];
}

export interface PackRepository {
  load(): Promise<PackLoadResult>;
  pois(): Poi[];
  poi(id: string): Poi | undefined;
  tours(): Tour[];
  personas(): Persona[];
  routes(): RouteData;
  map(level: string): MapData;
  /** validated + fallback applied */
  narration(poiId: string, personaId: string, lang: Lang, len: NarrationLength): Narration | undefined;
  source(id: string): SourceRef | undefined;
}

// ---------- Tour control (ARCHITECTURE §12.2 + T0 additions) ----------

export type SnapshotListener = (s: EngineSnapshot) => void;

/** Implemented by TourController (A7), consumed by B's ViewModels. ScriptedTourControl is the fake until A7. */
export interface TourControl {
  plan(tourId: string, budgetMin: number): Promise<TourPlan>;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  skip(): void;
  replay(): void;
  more(): void;
  end(): void;
  setSource(kind: FixSource): Promise<void>;
  subscribe(l: SnapshotListener): () => void;    // returns unsubscribe
  current(): EngineSnapshot;
  // T0 additions: Demo walk controls (labelled "Demo assist" in the UI)
  setDemoSpeed(mult: number): void;              // 1 | 2 | 4 | 8
  demoJumpToNext(): void;
  // X2 addition (issue #37): story language, live. The queued stories continue at the next sentence in `lang`.
  setStoryLang(lang: Lang): void;
}

// ---------- Platform ports (T0) ----------

export enum PermissionState {
  GRANTED = 'granted',         // precise + approximate
  APPROX_ONLY = 'approxOnly',  // §9 row 2
  DENIED = 'denied',           // §9 row 1
  UNKNOWN = 'unknown'
}

export interface PermissionPort {
  locationState(): Promise<PermissionState>;
  requestLocation(): Promise<PermissionState>;          // requestPermissionsFromUser
  openLocationSettings(): Promise<PermissionState>;     // requestPermissionOnSetting after a denial
  isLocationSwitchOn(): boolean;
  requestLocationSwitch(): Promise<boolean>;            // requestGlobalSwitch
}

export interface BackgroundListener {
  onCancelled(reason: string): void;
  onSuspended(reason: string): void;
}

export interface BackgroundPort {
  start(): Promise<boolean>;   // startBackgroundRunning(['location','audioPlayback']); 9800005 counts as success
  stop(): Promise<void>;
  isRunning(): boolean;
  setListener(l: BackgroundListener): void;
}

export enum MediaCommand {
  PLAY = 'play', PAUSE = 'pause', NEXT = 'playNext', PREVIOUS = 'playPrevious', FAVORITE = 'toggleFavorite',
  STOP = 'stop'
}

export type MediaCommandListener = (cmd: MediaCommand) => void;

export interface MediaSessionPort {
  init(onCommand: MediaCommandListener): Promise<boolean>; // registers commands, then activate()
  setMeta(meta: MediaMeta): void;
  setState(state: MediaPlayState): void;
  isActive(): boolean;
  destroy(): Promise<void>;
}

export interface NotifierPort {
  requestEnable(): Promise<boolean>;
  publishNext(notice: NextNotice): Promise<void>;       // id 1001, updated in place, isAlertOnce
  cancel(): Promise<void>;
}

export interface HapticsPort {
  play(kind: HapticKind): void;
}

export interface Clock {
  nowMs(): number;
}

/** Implemented by app/Log.ets (domain 0xC17A, tag CityTour, "EVENT k=v"). core/ logs only through this port. */
export interface LoggerPort {
  info(event: string, kv: string): void;
  warn(event: string, kv: string): void;
  error(event: string, kv: string): void;
}
