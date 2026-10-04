/*
 * TourController (task A7): the real TourControl. It hosts the pure TourEngine reducer and executes its effects
 * through the services, in order. Sources: docs/ARCHITECTURE.md §1.2 (lifecycle: lives in AppContainer, survives
 * screen lock and page changes, shutdown() on EntryAbility.onDestroy), §4 (engine, effects), §5 (location sources,
 * one pipeline, the real source keeps running in demo mode), §9 rows 4/5/8/14/15/17 (no fix, fix lost, out of
 * area, background/AVSession failures, pack errors), §10 (log events); docs/PLAN.md task A7.
 *
 * Flow:
 *   plan(tourId, budgetMin): pack.load() once (PACK_LOAD) -> speech.init() (voice caps) -> VoicePlan for the text
 *     language -> origin = latest fix (§9 row 8: > 5 km outside the pack bbox => LOC_OUT_OF_AREA, plan from the
 *     tour's start instead) -> core/route/Planner -> TourEngine.init + START_PLANNING + PLAN_READY.
 *   start(): BackgroundPort.start (continuous task) -> MediaSessionPort.init -> location source(s) -> TICK at 1 Hz
 *     -> START_TOUR. FIX_TIMEOUT after 25 s without a fix of the active source.
 *   Every engine event goes through dispatch(): events raised while effects run (speech callbacks fire
 *   synchronously in text mode or on errors) are queued, so reduce() is never re-entered.
 *
 * Effects: SPEAK -> SpeechPort.speak (+ prefetch of the predicted next sentence); STOP_SPEECH(false) -> stopNow,
 * STOP_SPEECH(true) -> nothing (the in-flight sentence finishes, the engine already dropped the rest);
 * SET_MEDIA_META/STATE -> MediaSessionPort; NOTIFY_NEXT -> NotifierPort; HAPTIC -> HapticsPort; REQUEST_REPLAN ->
 * Planner from the current fix; LOG -> LoggerPort (app/Log.ets). A port that is not wired yet (A5/A6/A8 not
 * merged) is a no-op with one log line per tour and effect type.
 *
 * One text-only pacer (A3 note): in text mode the engine paces captions on TICK and emits no SPEAK, so
 * NarrationPlayer's own reading timer is never used by a tour.
 * The reducer updates the state in place (A3 note): this class keeps exactly one TourState per tour.
 * The snapshot's platform fields are filled here (A3 note); snapshots are published at most every 250 ms.
 * Pure TypeScript/ArkTS: no @kit import, so the local unit tests can drive it with fake ports
 * (entry/src/test/TourController.test.ets). Platform calls are all behind ports and wrapped in try/catch + .catch.
 *
 * Error matrix (task A10, ARCHITECTURE §9): every row the controller can see ends as an AppIssue in the snapshot
 * plus one log line with the row's code. Rows 1/3/7: location source errors map through locationErrorIssue()
 * (PERM_DENIED / LOC_SWITCH_OFF / LOC_UNAVAILABLE) and clear on the next fix or a switch to the Demo walk. Row 2:
 * PERM_APPROX_ONLY on the first real fix (approximate fixes are > 40 m, so the engine's accuracy gate keeps
 * triggers off). Row 8: LOC_OUT_OF_AREA at plan time and on the first real fix of a tour. Rows 9/10: voiceIssueFor()
 * on the voice plan (TTS_INIT_FAIL when the platform leaves only text, VOICE_UNAVAILABLE when the zh voice stands
 * in for English). Rows 12/13: onAudioInterrupt()/onAudioRouteLost(), fed by NarrationPlayer through AppContainer
 * (no SpeechPort contract change). Row 14: BG_FAIL/BG_CANCEL keep the screen on (deps.keepScreenOn). Row 16:
 * NotifierPort.requestEnable() false => NOTIF_DENIED, no next-stop notices. Row 17: PACK_ERR (BLOCKING).
 */
import { Announcement, AppIssue, Effect, EffectType, EngineEvent, EngineEventType, EngineSnapshot, IssueCode, IssueSeverity, MediaMeta, MediaPlayState, PlatformStatus, SignalQuality, StopStatus, TourPhase, TourPlan } from '../contracts/EngineTypes';
import { BackgroundListener, BackgroundPort, Clock, Fix, FixSource, HapticsPort, LocationSource, LoggerPort, MediaCommand, MediaSessionPort, NotifierPort, PackLoadResult, PackRepository, PermissionPort, PermissionState, SnapshotListener, SpeechListener, SpeechPort, TourControl, Utterance, VoicePlan, VoicePort } from '../contracts/Ports';
import { LatLng, Lang, Narration, NarrationLength, PackManifest, Poi, RouteLeg, Tour, TourStop } from '../contracts/Model';
import { VoiceLabel } from '../contracts/Settings';
import { ClipIndex, StoryClips, StoryCoverage, storiesAllOrNothing, storyClipCoverage, storyVoicePlan } from '../core/speech/ClipSelection';
import { StepResult, TourEngine, TourInput, TourState } from '../core/tour/TourEngine';
import { TourConfig } from '../core/tour/TourConfig';
import { CityPack, PlanInputs, buildCostInputs, plan as planRoute } from '../core/route/Planner';
import { haversineM } from '../core/geo/GeoMath';
import { Projection } from '../core/geo/Projection';
import { albumLine } from '../core/content/CityPack';
import { LogEvents } from '../app/LogEvents';
import { Scheduler } from '../app/Clock';

/** No fix from the active source for this long => FIX_TIMEOUT (§9 row 5). */
export const FIX_TIMEOUT_MS: number = 25000;
/** No fix at all this long after start => LOC_NOFIX (§9 row 4). */
export const NO_FIRST_FIX_MS: number = 30000;
/** Engine clock (TICK) period. */
export const TICK_MS: number = 1000;
/** Snapshot publisher throttle: at most 4 Hz. */
export const SNAPSHOT_MIN_INTERVAL_MS: number = 250;
/** §9 row 8: an origin this far outside the pack (city) bbox is "far from {city}". */
export const OUT_OF_AREA_KM: number = 5;
/** A fix older than this is not used as the planning origin. */
export const ORIGIN_MAX_AGE_MS: number = 120000;
/** plan() waits this long for a first fix of an already running source before planning without an origin. */
export const ORIGIN_WAIT_MS: number = 3000;
/** Upper bound for a platform start (continuous task, AVSession), so start() can never hang. */
export const PLATFORM_START_TIMEOUT_MS: number = 5000;
/** Demo walk speeds (PLAN A5). */
export const DEMO_SPEEDS: number[] = [1, 2, 4, 8];
/** At most this many ROUTE_FALLBACK lines per plan (the rest is summarised). */
const MAX_FALLBACK_LINES: number = 12;

/**
 * Demo walk extras the controller needs from DemoWalkSource (A5). Not a shared contract: AppContainer adapts the
 * concrete source to it. Labelled "Demo assist" in the UI.
 */
export interface DemoControls {
  setSpeed(mult: number): void;
  /** Fallback when the tour has no open stop: the next hold segment of the track. */
  jumpToNextStop(): void;
  /**
   * Moves the walker to the start of the hold segment of the tour stop `poiId` (the track's stop list maps it; a
   * track without one uses `plannedIdx` + 1, the stop's 0-based index in the engine's planned order).
   */
  jumpToStop(poiId: string, plannedIdx: number): void;
  /** While it returns true the demo walk holds at a stop (re-emits jittered hold fixes). */
  setHoldPredicate(p: () => boolean): void;
  /** The last tick extended a hold ("Demo assist: waiting at stop while the story plays"). */
  isHolding(): boolean;
  /** Back to the first sample on the next start() (a stopped walk otherwise resumes where it was). */
  rewind(): void;
}

/** Everything the controller talks to. Optional services return undefined until their task is merged. */
export interface TourControllerDeps {
  pack: PackRepository;
  speech: SpeechPort;
  voice: VoicePort;
  log: LoggerPort;
  clock: Clock;
  scheduler: Scheduler;
  sourceFor: (kind: FixSource) => LocationSource | undefined;
  demoControls: () => DemoControls | undefined;
  background: () => BackgroundPort | undefined;
  media: () => MediaSessionPort | undefined;
  notifier: () => NotifierPort | undefined;
  haptics: () => HapticsPort | undefined;
  permissions: () => PermissionPort | undefined;
  /** §9 row 14: window keep-screen-on while the continuous task is missing (AppContainer: setWindowKeepScreenOn). */
  keepScreenOn?: (on: boolean) => void;
  /** A13: the pre-rendered clip index (NarrationPlayer's manifest); undefined = no clips, native TTS only. */
  clips?: () => ClipIndex | undefined;
  /** A13: the label of the sentence playing right now (studio clip / native / fallback TTS), undefined when idle. */
  liveVoiceLabel?: () => VoiceLabel | undefined;
  /** The active course's city name in the UI language ('' = unknown): the media session album "{city} · {tour}". */
  cityName?: () => string;
}

/** Tour settings the controller applies at plan() time (B9: SettingsViewModel.applyToTour from UserSettings). */
export class TourOptions {
  lang: Lang = Lang.EN;
  adaptiveLength: boolean = true;
  spokenDirections: boolean = true;
  briefOnly: boolean = false;          // Settings detail level Brief: teaser at every stop unless asked for more
  demoSpeed: number = 4;
  config: TourConfig | undefined = undefined;
}

// ---------------------------------------------------------------- pure helpers (unit-tested)

/** Kilometres from (lat, lng) to the bbox [minLat, minLng, maxLat, maxLng]; 0 inside; NaN for a bad bbox. */
export function kmOutsideBbox(lat: number, lng: number, bbox: number[]): number {
  if (bbox.length < 4 || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return Number.NaN;
  }
  const cLat: number = Math.min(Math.max(lat, bbox[0]), bbox[2]);
  const cLng: number = Math.min(Math.max(lng, bbox[1]), bbox[3]);
  if (cLat === lat && cLng === lng) {
    return 0;
  }
  return haversineM(lat, lng, cLat, cLng) / 1000;
}

/** The nearest supported demo speed (1 | 2 | 4 | 8). */
export function normalizeDemoSpeed(mult: number): number {
  if (!Number.isFinite(mult)) {
    return 4;
  }
  let best: number = DEMO_SPEEDS[0];
  for (const s of DEMO_SPEEDS) {
    if (Math.abs(s - mult) < Math.abs(best - mult)) {
      best = s;
    }
  }
  return best;
}

/**
 * The id AnnouncementQueue.next() will give the sentence after `u` in the same item: `<sentenceId>#<seq + 1>`.
 * Returns '' if `u.id` has no `#<seq>` suffix. A wrong guess only costs a discarded prefetch.
 */
export function predictNextUtteranceId(currentId: string, nextSentenceId: string): string {
  const hash: number = currentId.lastIndexOf('#');
  if (hash < 0) {
    return '';
  }
  const seq: number = parseInt(currentId.substring(hash + 1), 10);
  if (!Number.isFinite(seq)) {
    return '';
  }
  return `${nextSentenceId}#${seq + 1}`;
}

/** Open (not yet visited) stops of a running tour, in the current planned order. */
export function openStopIds(st: TourState): string[] {
  const out: string[] = [];
  for (const s of st.stops) {
    if (s.status === StopStatus.PENDING || s.status === StopStatus.APPROACHING) {
      out.push(s.poiId);
    }
  }
  return out;
}

/** §9 location error codes (LocationSource onError: LocationError -1..-5 or a Location Kit exception code). */
export const LOC_ERR_PERMISSION: number = -2;
export const LOC_ERR_SWITCH_OFF: number = -4;
const LOC_CODES_PERMISSION: number[] = [LOC_ERR_PERMISSION, 201];
const LOC_CODES_SWITCH_OFF: number[] = [LOC_ERR_SWITCH_OFF, 3301100];
const LOC_CODES_UNAVAILABLE: number[] = [3301000, 801];
/** Issues that describe the active location source; a fix or a source switch clears them. */
const LOCATION_ISSUES: IssueCode[] = [
  IssueCode.PERM_DENIED, IssueCode.LOC_SWITCH_OFF, IssueCode.LOC_UNAVAILABLE, IssueCode.LOC_NOFIX
];

/** §9 rows 1/3/7: the issue a location source error code maps to. */
export function locationErrorIssue(code: number, kind: FixSource): AppIssue {
  let c: IssueCode = IssueCode.LOC_UNAVAILABLE;
  let sev: IssueSeverity = IssueSeverity.WARN;
  if (LOC_CODES_PERMISSION.indexOf(code) >= 0) {
    c = IssueCode.PERM_DENIED;
    sev = IssueSeverity.BLOCKING;
  } else if (LOC_CODES_SWITCH_OFF.indexOf(code) >= 0) {
    c = IssueCode.LOC_SWITCH_OFF;
    sev = IssueSeverity.BLOCKING;
  } else if (LOC_CODES_UNAVAILABLE.indexOf(code) >= 0) {
    sev = IssueSeverity.BLOCKING;
  }
  const i: AppIssue = { code: c, severity: sev, detail: `${kind} code=${code}` };
  return i;
}

/**
 * §9 rows 9/10: what the voice plan means for the user. TEXT_ONLY_PLATFORM (the platform left no voice, except the
 * by-design "no Polish voice") => TTS_INIT_FAIL; FALLBACK_ZH_READS_EN (Laura not installed) => VOICE_UNAVAILABLE.
 * A text-only choice of the user is no issue.
 */
export function voiceIssueFor(vp: VoicePlan): AppIssue | undefined {
  if (vp.label === VoiceLabel.TEXT_ONLY_PLATFORM && vp.reason.indexOf('no_voice_for_lang') < 0) {
    const i: AppIssue = { code: IssueCode.TTS_INIT_FAIL, severity: IssueSeverity.WARN, detail: vp.reason };
    return i;
  }
  if (vp.label === VoiceLabel.FALLBACK_ZH_READS_EN) {
    const i: AppIssue = { code: IssueCode.VOICE_UNAVAILABLE, severity: IssueSeverity.INFO, detail: vp.reason };
    return i;
  }
  return undefined;
}

/** "en_status=DOWNLOADABLE ..." -> "DOWNLOADABLE"; '' if absent. */
export function enStatusOf(reason: string): string {
  const m: RegExpMatchArray | null = reason.match(new RegExp('en_status=([A-Z_]+)'));
  return m !== null && m.length > 1 ? m[1] : '';
}

function invalidOrigin(): LatLng {
  const o: LatLng = { lat: Number.NaN, lng: Number.NaN };
  return o;
}

function emptyPlan(tourId: string, algo: string): TourPlan {
  const p: TourPlan = {
    tourId: tourId, order: [], costS: 0, walkM: 0, savedM: 0, exact: false, algo: algo, ms: 0, budgetS: 0, legs: []
  };
  return p;
}

function errText(e: Object | undefined | null): string {
  if (e === undefined || e === null) {
    return 'msg=unknown';
  }
  try {
    const m: string | undefined = (e as Error).message;
    return `msg=${m !== undefined ? m : JSON.stringify(e)}`;
  } catch (x) {
    return 'msg=unprintable';
  }
}

/** Log codes the engine emits that are warnings (everything else is info). */
const WARN_CODES: string[] = [
  LogEvents.LOC_POOR, LogEvents.LOC_LOST, LogEvents.TTS_ERR, LogEvents.BG_CANCEL, LogEvents.NARR_FALLBACK,
  LogEvents.PACK_DROP, LogEvents.AUDIO_ROUTE, LogEvents.QUEUE_EXPIRED
];

// ---------------------------------------------------------------- listeners (classes: ArkTS object literals
// cannot carry methods for these interfaces safely)

class SpeechBridge implements SpeechListener {
  private owner: TourController;
  private gen: number;

  constructor(owner: TourController, gen: number) {
    this.owner = owner;
    this.gen = gen;
  }

  onUtteranceStart(id: string): void {
    this.owner.onSpeechEvent(this.gen, EngineEventType.UTTERANCE_STARTED, id, 0);
  }

  onUtteranceDone(id: string): void {
    this.owner.onSpeechEvent(this.gen, EngineEventType.UTTERANCE_DONE, id, 0);
  }

  onUtteranceError(id: string, code: number): void {
    this.owner.onSpeechEvent(this.gen, EngineEventType.UTTERANCE_FAILED, id, code);
  }
}

class BackgroundBridge implements BackgroundListener {
  private owner: TourController;

  constructor(owner: TourController) {
    this.owner = owner;
  }

  onCancelled(reason: string): void {
    this.owner.onBackgroundCancelled(reason);
  }

  onSuspended(reason: string): void {
    this.owner.onBackgroundSuspended(reason);
  }
}

// ---------------------------------------------------------------- the controller

export class TourController implements TourControl {
  private readonly deps: TourControllerDeps;
  private opts: TourOptions = new TourOptions();
  private state: TourState | undefined = undefined;
  private tour: Tour | undefined = undefined;
  private lastPlan: TourPlan | undefined = undefined;
  private voicePlan: VoicePlan | undefined = undefined;
  private packBbox: number[] = [];
  /** The pack's projection (its manifest origin: every record's x/y is in this frame); undefined before load. */
  private packProjection: Projection | undefined = undefined;
  private packLoaded: boolean = false;
  private sourceKind: FixSource = FixSource.REAL;
  private activeSource: LocationSource | undefined = undefined;
  private shadowSource: LocationSource | undefined = undefined;
  private listeners: SnapshotListener[] = [];
  private pending: EngineEvent[] = [];
  private dispatching: boolean = false;
  private running: boolean = false;          // a tour session holds sources, TICK and the platform
  private generation: number = 0;            // bumps on every start/teardown: late callbacks of old sessions are ignored
  private tickId: number = -1;
  private publishTimer: number = -1;
  private lastPublishMs: number = Number.NEGATIVE_INFINITY;
  private startedAtMs: number = Number.NaN;
  private lastActiveFixMs: number = Number.NaN;
  private timeoutSent: boolean = false;
  private noFixLogged: boolean = false;
  private latestFix: Fix | undefined = undefined;
  private latestFixAtMs: number = Number.NaN;
  private realAccuracyM: number = Number.NaN;
  private originWaiter: (() => void) | undefined = undefined;
  private ctrlIssues: AppIssue[] = [];
  private noopLogged: Set<string> = new Set<string>();
  private narrLogged: Set<string> = new Set<string>();
  private deferredInfo: string[] = [];         // NARR_SOURCE kv lines raised inside reduce(), logged after its effects
  private bgUp: boolean = false;
  private artist: string = 'CityTour · Historian';
  /**
   * The voice heard last (studio clip / native / fallback TTS), updated on UTTERANCE_STARTED only, so the chip, the
   * HUD and the AVSession artist name what is actually speaking and do not flicker between sentences or while the
   * next one is synthesized. undefined until the first sentence of a tour is heard (the tour plan label is used).
   */
  private heardLabel: VoiceLabel | undefined = undefined;
  private lastMeta: MediaMeta | undefined = undefined;
  private avsUp: boolean = false;
  private screenKept: boolean = false;         // §9 row 14: keepScreenOn(true) is in force
  private notifDenied: boolean = false;        // §9 row 16: no next-stop notices this tour
  private firstRealFixSeen: boolean = false;   // §9 rows 2/8 at tour time: checked once per session

  constructor(deps: TourControllerDeps) {
    this.deps = deps;
  }

  // ================================================================ TourControl

  plan(tourId: string, budgetMin: number): Promise<TourPlan> {
    return this.planInternal(tourId, budgetMin).catch((e: Object) => {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=TourController.plan ${errText(e)}`);
      this.addIssue(IssueCode.UNCAUGHT, IssueSeverity.WARN, 'plan');
      this.schedulePublish();
      return emptyPlan(tourId, 'none');
    });
  }

  start(): Promise<void> {
    return this.startInternal().catch((e: Object) => {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=TourController.start ${errText(e)}`);
      this.addIssue(IssueCode.UNCAUGHT, IssueSeverity.WARN, 'start');
      this.schedulePublish();
    });
  }

  pause(): void {
    this.userEvent(EngineEventType.USER_PAUSE);
  }

  resume(): void {
    this.userEvent(EngineEventType.USER_RESUME);
  }

  /**
   * Skip / "Next stop". On the Demo walk the walker follows the tour: when the skip moved the tour on (or the tour is
   * walking to its next stop), the walker jumps to that stop's hold segment, so dot and tour agree and the stop's story
   * plays there (the hold predicate keeps the walker there while it plays).
   */
  skip(): void {
    this.userEvent(EngineEventType.USER_SKIP);
    this.demoFollowTarget('skip');
  }

  replay(): void {
    this.userEvent(EngineEventType.USER_REPLAY);
  }

  more(): void {
    this.userEvent(EngineEventType.USER_MORE);
  }

  end(): void {
    this.userEvent(EngineEventType.USER_END);
    if (this.running) {
      this.teardown('user_end');       // USER_END from READY/IDLE does not go through the phase check
    }
  }

  setSource(kind: FixSource): Promise<void> {
    try {
      if (kind === this.sourceKind) {
        return Promise.resolve();
      }
      this.deps.log.info(LogEvents.LOC_SOURCE, `kind=${kind} action=select from=${this.sourceKind}`);
      this.sourceKind = kind;
      this.clearLocationIssues();          // e.g. [Try Demo walk] after PERM_DENIED: the old source's banner goes
      if (this.running) {
        this.stopSources();
        this.startSources(false);
      } else {
        this.rebuildReadyEngine();       // the welcome line says "simulated walk" only for DEMO
      }
      this.schedulePublish();
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=TourController.setSource ${errText(e as Object)}`);
    }
    return Promise.resolve();
  }

  subscribe(l: SnapshotListener): () => void {
    this.listeners.push(l);
    this.safeNotify(l, this.current());
    return () => {
      this.listeners = this.listeners.filter((x: SnapshotListener) => x !== l);
    };
  }

  current(): EngineSnapshot {
    const st: TourState | undefined = this.state;
    let s: EngineSnapshot;
    try {
      s = st === undefined ? this.idleSnapshot() : TourEngine.snapshot(st);
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=TourEngine.snapshot ${errText(e as Object)}`);
      s = this.idleSnapshot();
    }
    s.platform = this.platformStatus(st);
    if (st !== undefined && !st.speechText && this.heardLabel !== undefined) {
      s.voiceLabel = this.heardLabel;    // A13: "Studio voice" after a clip started, "Fallback voice" after TTS did
    }
    if (st === undefined) {
      s.source = this.sourceKind;
    }
    if (this.ctrlIssues.length > 0) {
      // "You're far from {city} … try a demo walk" is moot while the Demo walk is the active source (issue #20).
      const demo: boolean = this.sourceKind === FixSource.DEMO;
      s.issues = s.issues.concat(demo ?
        this.ctrlIssues.filter((i: AppIssue) => i.code !== IssueCode.LOC_OUT_OF_AREA) : this.ctrlIssues);
    }
    return s;
  }

  setDemoSpeed(mult: number): void {
    const m: number = normalizeDemoSpeed(mult);
    this.opts.demoSpeed = m;
    const dc: DemoControls | undefined = this.demo();
    if (dc === undefined) {
      this.noop('demo', LogEvents.LOC_SOURCE, `kind=demo action=speed x=${m} noop=no_demo_source`);
      return;
    }
    try {
      dc.setSpeed(m);
      this.deps.log.info(LogEvents.LOC_SOURCE, `kind=demo action=speed x=${m}`);
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=DemoControls.setSpeed ${errText(e as Object)}`);
    }
  }

  /** "Demo assist: jump to next stop": to the tour's next open stop (planned order), else the track's next hold. */
  demoJumpToNext(): void {
    const dc: DemoControls | undefined = this.demo();
    if (dc === undefined) {
      this.noop('demo', LogEvents.LOC_SOURCE, 'kind=demo action=jump noop=no_demo_source');
      return;
    }
    try {
      const idx: number = this.nextOpenStopIdx();
      if (idx >= 0 && this.state !== undefined) {
        const poi: string = this.state.stops[idx].poiId;
        dc.jumpToStop(poi, idx);
        this.deps.log.info(LogEvents.LOC_SOURCE, `kind=demo action=jump to=${poi} idx=${idx} why=demoAssist`);
      } else {
        dc.jumpToNextStop();
        this.deps.log.info(LogEvents.LOC_SOURCE, 'kind=demo action=jump to=nextHold why=demoAssist');
      }
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=DemoControls.jumpToNextStop ${errText(e as Object)}`);
    }
  }

  /** First open (pending / approaching) stop in the engine's planned order, -1 if none or no tour. */
  private nextOpenStopIdx(): number {
    const st: TourState | undefined = this.state;
    if (st === undefined) {
      return -1;
    }
    for (let i = 0; i < st.stops.length; i++) {
      const status: StopStatus = st.stops[i].status;
      if (status === StopStatus.PENDING || status === StopStatus.APPROACHING) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Demo walk only: while the tour walks to its target stop (after a Skip finished the previous stop, or a Skip while
   * walking), the walker jumps to that stop. Not while a stop's story is still active (AT_STOP), never on GPS.
   */
  private demoFollowTarget(why: string): void {
    try {
      const st: TourState | undefined = this.state;
      if (!this.running || this.sourceKind !== FixSource.DEMO || st === undefined || st.targetIdx < 0 ||
        (st.phase !== TourPhase.WALKING && st.phase !== TourPhase.APPROACHING)) {
        return;
      }
      const dc: DemoControls | undefined = this.demo();
      if (dc === undefined) {
        return;
      }
      const poi: string = st.stops[st.targetIdx].poiId;
      dc.jumpToStop(poi, st.targetIdx);
      this.deps.log.info(LogEvents.LOC_SOURCE, `kind=demo action=jump to=${poi} idx=${st.targetIdx} why=${why}`);
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=TourController.demoFollowTarget ${errText(e as Object)}`);
    }
  }

  // ================================================================ extras

  /** Applied at the next plan(); spokenDirections also to the running tour (A9). */
  setOptions(o: TourOptions): void {
    this.opts = o;
    this.syncDirections(o.spokenDirections);   // A9: the Spoken directions toggle also applies to a running tour
  }

  options(): TourOptions {
    return this.opts;
  }

  sourceKindSelected(): FixSource {
    return this.sourceKind;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** The latest fix seen (any source; undefined before the first). Home's "You're in {city}" uses a REAL one. */
  lastFix(): Fix | undefined {
    return this.latestFix;
  }

  /** EntryAbility.onDestroy (via AppContainer.shutdown): stop everything, no new speech, keep no timers. */
  shutdown(): void {
    try {
      if (this.running) {
        this.teardown('shutdown');
      } else {
        this.stopSources();              // a plan-time origin source may still run
      }
      this.deps.scheduler.cancel(this.publishTimer);
      this.publishTimer = -1;
      this.listeners = [];
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=TourController.shutdown ${errText(e as Object)}`);
    }
  }

  /** Same as shutdown() (the name AppContainer used for ScriptedTourControl). */
  dispose(): void {
    this.shutdown();
  }

  // ================================================================ callbacks (public for the bridge classes)

  onSpeechEvent(gen: number, type: EngineEventType, id: string, code: number): void {
    if (gen !== this.generation || !this.running) {
      return;                            // a late callback from a torn-down tour (or another speech user)
    }
    if (type === EngineEventType.UTTERANCE_STARTED) {
      this.noteHeard(id);
    }
    const ev: EngineEvent = { type: type, nowMs: this.deps.clock.nowMs(), utteranceId: id, code: code };
    this.dispatch(ev);
  }

  /**
   * A13 label honesty: at UTT_START, take the label of the sentence now audible. A change is logged (NARR_AUDIO
   * event=voice_label) and re-sent to the AVSession artist line; text sentences (no audio) keep the last label.
   */
  private noteHeard(id: string): void {
    const l: VoiceLabel | undefined = this.liveLabel();
    if (l === undefined || l === this.heardLabel) {
      return;
    }
    const from: string = this.heardLabel === undefined ? 'plan' : this.heardLabel;
    this.heardLabel = l;
    this.deps.log.info(LogEvents.NARR_AUDIO, `event=voice_label from=${from} to=${l} id=${id}`);
    const m: MediaMeta | undefined = this.lastMeta;
    if (m !== undefined) {
      this.sendMeta(m);
    }
  }

  onBackgroundCancelled(reason: string): void {
    this.bgUp = false;
    this.addIssue(IssueCode.BG_FAIL, IssueSeverity.WARN, `cancelled ${reason}`);
    if (this.running) {
      this.keepScreen(true, `bg_cancel reason=${reason}`);
      const ev: EngineEvent = { type: EngineEventType.BG_CANCELLED, nowMs: this.deps.clock.nowMs(), reason: reason };
      this.dispatch(ev);
      // BackgroundRunner stops the audio with the task (continuous-task guide), which cuts the sentence in flight
      // without a done callback. Pause the tour so that sentence restarts when the user resumes in the foreground.
      const st: TourState | undefined = this.state;
      if (st !== undefined && st.queue.isBusy() && !st.paused) {
        this.deps.log.warn(LogEvents.BG_CANCEL, `reason=${reason} action=pause_tour`);
        this.dispatchType(EngineEventType.USER_PAUSE);
      }
    }
  }

  onBackgroundSuspended(reason: string): void {
    this.deps.log.warn(LogEvents.BG_SUSPEND, `reason=${reason} where=controller`);
    this.addIssue(IssueCode.BG_FAIL, IssueSeverity.WARN, `suspended ${reason}`);
    this.schedulePublish();
  }

  /**
   * §9 row 12: an audio focus interrupt seen by the speech service (NarrationPlayer via AppContainer). hint is
   * 'PAUSE' | 'STOP' | 'RESUME'. Outside a running tour it is only logged.
   */
  onAudioInterrupt(hint: string): void {
    try {
      if (!this.running || this.state === undefined) {
        this.deps.log.info(LogEvents.AUDIO_INTERRUPT, `hint=${hint} action=ignored reason=no_tour`);
        return;
      }
      const ev: EngineEvent = { type: EngineEventType.AUDIO_INTERRUPT, nowMs: this.deps.clock.nowMs(), hint: hint };
      this.dispatch(ev);
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=TourController.onAudioInterrupt ${errText(e as Object)}`);
    }
  }

  /** §9 row 13: the headphones went away (output fell back to the loudspeaker). */
  onAudioRouteLost(devices: string): void {
    try {
      if (!this.running || this.state === undefined) {
        this.deps.log.info(LogEvents.AUDIO_ROUTE, `device=SPEAKER action=ignored reason=no_tour devices=${devices}`);
        return;
      }
      this.dispatchType(EngineEventType.AUDIO_ROUTE_LOST);
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=TourController.onAudioRouteLost ${errText(e as Object)}`);
    }
  }

  onMediaCommand(cmd: MediaCommand): void {
    switch (cmd) {
      case MediaCommand.PLAY:
        this.resume();
        break;
      case MediaCommand.NEXT:
        this.skip();
        break;
      case MediaCommand.PREVIOUS:
        this.replay();
        break;
      case MediaCommand.FAVORITE:
        this.more();
        break;
      default:
        this.pause();                    // PAUSE and STOP: never end a tour from the lock screen
        break;
    }
  }

  // ================================================================ planning

  private async planInternal(tourId: string, budgetMin: number): Promise<TourPlan> {
    if (this.running) {
      this.deps.log.info(LogEvents.STATE, `from=${this.phase()} to=idle ev=PLAN_AGAIN`);
      this.teardown('plan_again');
    }
    this.ctrlIssues = [];
    this.state = undefined;
    this.schedulePublish();

    const loaded: boolean = await this.ensurePack();
    if (!loaded) {
      return emptyPlan(tourId, 'none');
    }
    const tour: Tour | undefined = this.findTour(tourId);
    if (tour === undefined) {
      this.deps.log.error(LogEvents.PACK_ERR, `file=tours.json reason=no_tour requested=${tourId}`);
      this.addIssue(IssueCode.PACK_ERR, IssueSeverity.BLOCKING, 'no tour');
      return emptyPlan(tourId, 'none');
    }
    try {
      await this.deps.speech.init();     // never rejects (A4); warms the engine English uses
    } catch (e) {
      this.deps.log.error(LogEvents.TTS_INIT_FAIL, `where=TourController.plan ${errText(e as Object)}`);
    }
    await this.primeOrigin();
    const base: VoicePlan = this.resolveVoice();
    const vp: VoicePlan = this.applyClips(tour, base);
    if (vp.label !== VoiceLabel.PRERENDERED) {
      this.reportVoice(base);   // the studio voice covers this language: the built-in voice's state is moot
    }
    const origin: LatLng = this.planningOrigin();
    const p: TourPlan = this.solve(tour, tour.stops.map((s: TourStop) => s.poiId), origin, budgetMin > 0 ? budgetMin * 60 : 0);
    this.tour = tour;
    this.artist = this.artistFor(tour.personaId);
    this.voicePlan = vp;
    this.lastPlan = p;
    this.buildEngine(tour, vp, p);
    this.publishNow();
    return p;
  }

  /**
   * Remote courses (docs/SERVER.md §6): the active course changed (ActivePackRepository now forwards to another
   * pack), so the next plan() reloads the pack facts (bbox, counts). Not called while a tour runs.
   */
  onPackSwitched(): void {
    this.packLoaded = false;
    this.packBbox = [];
    this.packProjection = undefined;
  }

  private async ensurePack(): Promise<boolean> {
    if (this.packLoaded) {
      return true;
    }
    const t0: number = this.deps.clock.nowMs();
    let r: PackLoadResult;
    try {
      r = await this.deps.pack.load();
    } catch (e) {
      this.deps.log.error(LogEvents.PACK_ERR, `file=pack reason=load_threw ${errText(e as Object)}`);
      this.addIssue(IssueCode.PACK_ERR, IssueSeverity.BLOCKING, 'load');
      return false;
    }
    if (!r.ok) {
      this.deps.log.error(LogEvents.PACK_ERR, `file=pack reason=not_ok issues=${r.issues.length}`);
      for (const i of r.issues) {
        this.ctrlIssues.push(i);
      }
      if (r.issues.length === 0) {
        this.addIssue(IssueCode.PACK_ERR, IssueSeverity.BLOCKING, 'load');
      }
      return false;
    }
    this.packLoaded = true;
    const m: PackManifest | undefined = r.manifest;
    this.packBbox = m !== undefined ? m.bbox : [];
    this.packProjection = m !== undefined ? Projection.fromOrigin(m.origin) : undefined;
    const narr: number = m !== undefined ? m.counts.narrations_en + m.counts.narrations_pl + m.counts.narrations_zh : 0;
    this.deps.log.info(LogEvents.PACK_LOAD, `ms=${this.deps.clock.nowMs() - t0} pack=${m !== undefined ? m.packId : ''} ` +
      `pois=${this.deps.pack.pois().length} narr=${narr} legs=${this.deps.pack.routes().legs.length} ` +
      `tours=${this.deps.pack.tours().length}`);
    return true;
  }

  private artistFor(personaId: string): string {
    try {
      for (const p of this.deps.pack.personas()) {
        if (p.id === personaId) {
          const n: string | undefined = p.names.en;
          return `CityTour · ${n !== undefined && n.length > 0 ? n : personaId}`;
        }
      }
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=TourController.artistFor ${errText(e as Object)}`);
    }
    return 'CityTour · Historian';
  }

  private findTour(tourId: string): Tour | undefined {
    const tours: Tour[] = this.deps.pack.tours();
    for (const t of tours) {
      if (t.id === tourId) {
        return t;
      }
    }
    if (tours.length > 0) {
      this.deps.log.warn(LogEvents.ROUTE_FALLBACK, `reason=unknown_tour requested=${tourId} used=${tours[0].id}`);
      return tours[0];
    }
    return undefined;
  }

  private resolveVoice(): VoicePlan {
    try {
      return this.deps.voice.plan(this.opts.lang);
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=VoicePort.plan ${errText(e as Object)}`);
      const t: VoicePlan = {
        textLang: this.opts.lang, speechMode: 'text', engineLocale: '', person: 0, languageContext: '',
        label: VoiceLabel.TEXT_ONLY_PLATFORM, reason: 'voice_plan_threw'
      };
      return t;
    }
  }

  /**
   * A13: the stop-story plan. With clips for the story language the tour runs in voice mode labelled
   * PRERENDERED (Polish becomes spoken); the base plan still voices dynamic lines and sentences without a clip.
   * Where that fallback is text (Polish), a story only partly covered by clips is excluded from clip playback,
   * so it is read as text from start to end instead of switching between spoken and silent sentences.
   */
  private applyClips(tour: Tour, base: VoicePlan): VoicePlan {
    let idx: ClipIndex | undefined = undefined;
    try {
      idx = this.deps.clips !== undefined ? this.deps.clips() : undefined;
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=TourController.clips ${errText(e as Object)}`);
    }
    const lang: Lang = this.opts.lang;
    const has: boolean = idx !== undefined && idx.hasLang(lang, tour.personaId);
    const vp: VoicePlan = storyVoicePlan(base, has);
    if (idx === undefined || vp.label !== VoiceLabel.PRERENDERED) {
      this.deps.log.info(LogEvents.NARR_AUDIO, `event=story_voice lang=${lang} clips=${has ? 'yes' : 'no'} ` +
        `label=${vp.label}`);
      return vp;
    }
    idx.clearExclusions();
    const strict: boolean = storiesAllOrNothing(base);
    let all = 0;
    let partial = 0;
    let none = 0;
    const lens: NarrationLength[] = [NarrationLength.TEASER, NarrationLength.FULL, NarrationLength.DEEP];
    for (const stop of tour.stops) {
      for (const len of lens) {
        const n: Narration | undefined = this.narrationFor(stop.poiId, tour.personaId, lang, len);
        if (n === undefined || n.sentences.length === 0) {
          continue;
        }
        const c: StoryCoverage = storyClipCoverage(idx, n.sentences, lang, tour.personaId);
        if (c.state === StoryClips.ALL) {
          all++;
        } else if (c.state === StoryClips.NONE) {
          none++;
        } else {
          partial++;
          if (strict) {
            c.shas.forEach((sha: string) => idx!.exclude(sha));
          }
          this.deps.log.warn(LogEvents.NARR_AUDIO, `event=story_incomplete poi=${stop.poiId} len=${len} ` +
            `matched=${c.matched}/${c.total} action=${strict ? 'text_whole_story' : 'tts_per_sentence'}`);
        }
      }
    }
    this.deps.log.info(LogEvents.NARR_AUDIO, `event=story_voice lang=${lang} clips=yes label=${vp.label} ` +
      `fallback=${base.label} stories_all=${all} partial=${partial} none=${none}`);
    return vp;
  }

  /** §9 rows 9/10: one issue + one log line for a voice plan the user should know about. */
  private reportVoice(vp: VoicePlan): void {
    const i: AppIssue | undefined = voiceIssueFor(vp);
    if (i === undefined) {
      return;
    }
    if (i.code === IssueCode.TTS_INIT_FAIL) {
      this.deps.log.error(LogEvents.TTS_INIT_FAIL, `lang=${vp.textLang} reason=${vp.reason} action=text_only where=controller`);
    } else {
      const st: string = enStatusOf(vp.reason);
      this.deps.log.warn(LogEvents.VOICE_STATUS, `lang=en person=8 status=${st.length > 0 ? st : 'unknown'} ` +
        `action=fallback_voice label=${vp.label} where=controller`);
    }
    this.addIssue(i.code, i.severity, i.detail);
  }

  /**
   * Gets a planning origin if one can be had without asking the user: a fresh fix, else the real source started
   * now (only when location permission is already GRANTED; it then keeps running as the §5 shadow), waiting up to
   * ORIGIN_WAIT_MS for its first fix. On the emulator this is the fixed Beijing point => LOC_OUT_OF_AREA.
   */
  private async primeOrigin(): Promise<void> {
    if (this.latestFix !== undefined && this.deps.clock.nowMs() - this.latestFixAtMs <= ORIGIN_MAX_AGE_MS) {
      return;
    }
    const running: boolean = (this.shadowSource !== undefined && this.shadowSource.isRunning()) ||
      (this.activeSource !== undefined && this.activeSource.isRunning());
    if (!running) {
      const real: LocationSource | undefined = this.safeGet<LocationSource>(
        () => this.deps.sourceFor(FixSource.REAL), 'source');
      const perms: PermissionPort | undefined = this.safeGet(this.deps.permissions, 'permissions');
      if (real === undefined || perms === undefined) {
        return;
      }
      let ps: PermissionState = PermissionState.UNKNOWN;
      try {
        ps = await perms.locationState();
      } catch (e) {
        this.deps.log.warn(LogEvents.LOC_ERR, `where=plan_origin_permission ${errText(e as Object)}`);
        return;
      }
      if (ps !== PermissionState.GRANTED || real.isRunning()) {
        return;
      }
      this.shadowSource = real;
      this.deps.log.info(LogEvents.LOC_SOURCE, 'kind=real role=origin');
      this.startSource(real, FixSource.REAL, this.generation, false);
    }
    if (this.latestFix !== undefined) {
      return;
    }
    await new Promise<void>((resolve) => {
      const id: number = this.deps.scheduler.after(ORIGIN_WAIT_MS, () => {
        this.originWaiter = undefined;
        resolve();
      });
      this.originWaiter = () => {
        this.deps.scheduler.cancel(id);
        this.originWaiter = undefined;
        resolve();
      };
    });
  }

  /** §9 row 8: the latest fix, unless it is stale or > 5 km outside the pack (then the tour's own start). */
  private planningOrigin(): LatLng {
    const f: Fix | undefined = this.latestFix;
    if (f === undefined || this.deps.clock.nowMs() - this.latestFixAtMs > ORIGIN_MAX_AGE_MS) {
      return invalidOrigin();
    }
    const km: number = kmOutsideBbox(f.lat, f.lng, this.packBbox);
    if (Number.isFinite(km) && km > OUT_OF_AREA_KM) {
      this.deps.log.info(LogEvents.LOC_OUT_OF_AREA, `km=${Math.round(km)} src=${f.source} action=plan_from_tour_start`);
      this.addIssue(IssueCode.LOC_OUT_OF_AREA, IssueSeverity.INFO, `km=${Math.round(km)}`);
      return invalidOrigin();
    }
    const o: LatLng = { lat: f.lat, lng: f.lng };
    return o;
  }

  private tourPois(tour: Tour): Poi[] {
    const out: Poi[] = [];
    for (const s of tour.stops) {
      const p: Poi | undefined = this.deps.pack.poi(s.poiId);
      if (p !== undefined) {
        out.push(p);
      }
    }
    return out;
  }

  private solve(tour: Tour, remaining: string[], origin: LatLng, budgetS: number): TourPlan {
    const pack: CityPack = { pois: this.tourPois(tour), routes: this.deps.pack.routes() };
    const inputs: PlanInputs = buildCostInputs(pack, tour, remaining, origin);
    const n: number = inputs.estimatedPairs.length;
    for (let i = 0; i < Math.min(n, MAX_FALLBACK_LINES); i++) {
      this.deps.log.warn(LogEvents.ROUTE_FALLBACK, `pair=${inputs.estimatedPairs[i].replace('>', ',')} est=haversine`);
    }
    if (n > MAX_FALLBACK_LINES) {
      this.deps.log.warn(LogEvents.ROUTE_FALLBACK, `pairs=${n} shown=${MAX_FALLBACK_LINES}`);
    }
    if (inputs.droppedIds.length > 0) {
      this.deps.log.warn(LogEvents.PACK_DROP, `file=tour n=${inputs.droppedIds.length} first=${inputs.droppedIds[0]}`);
    }
    return planRoute(inputs, budgetS);
  }

  private buildEngine(tour: Tour, vp: VoicePlan, p: TourPlan): void {
    const lang: Lang = this.opts.lang;
    const personaId: string = tour.personaId;
    const input: TourInput = {
      tour: tour, pois: this.tourPois(tour), lang: lang, personaId: personaId,
      narration: (poiId: string, len: NarrationLength) => this.narrationFor(poiId, personaId, lang, len),
      voice: vp, adaptiveLength: this.opts.adaptiveLength, spokenDirections: this.opts.spokenDirections,
      briefOnly: this.opts.briefOnly, source: this.sourceKind, legs: this.packLegs(), projection: this.packProjection
    };
    this.heardLabel = undefined;           // a new tour starts from its plan label
    this.state = TourEngine.init(input, this.opts.config !== undefined ? this.opts.config : new TourConfig());
    this.dispatchType(EngineEventType.START_PLANNING);
    if (p.order.length === 0) {
      const ev: EngineEvent = {
        type: EngineEventType.PLAN_FAILED, nowMs: this.deps.clock.nowMs(), code: -1, reason: 'empty_plan'
      };
      this.dispatch(ev);
      return;
    }
    const ev: EngineEvent = { type: EngineEventType.PLAN_READY, nowMs: this.deps.clock.nowMs(), plan: p };
    this.dispatch(ev);
  }

  /** setSource() between plan() and start(): rebuild the READY engine so the welcome line matches the source. */
  private rebuildReadyEngine(): void {
    const st: TourState | undefined = this.state;
    if (st === undefined || st.phase !== TourPhase.READY || this.tour === undefined || this.voicePlan === undefined ||
      this.lastPlan === undefined) {
      return;
    }
    this.buildEngine(this.tour, this.voicePlan, this.lastPlan);
  }

  private narrationFor(poiId: string, personaId: string, lang: Lang, len: NarrationLength): Narration | undefined {
    let n: Narration | undefined = undefined;
    try {
      n = this.deps.pack.narration(poiId, personaId, lang, len);
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=PackRepository.narration poi=${poiId} ${errText(e as Object)}`);
      return undefined;
    }
    const key: string = `${poiId}:${len}`;
    if (n !== undefined && !this.narrLogged.has(key)) {
      this.narrLogged.add(key);
      this.deferredInfo.push(`poi=${poiId} len=${len} lang=${n.lang} tier=${n.tier} ` +
        `sources=${n.sources.length} sentences=${n.sentences.length}`);
    }
    return n;
  }

  /** A9: every directed stop-pair leg of the pack (turn-by-turn geometry and OSRM steps); [] if unavailable. */
  private packLegs(): RouteLeg[] {
    try {
      return this.deps.pack.routes().legs;
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=PackRepository.routes ${errText(e as Object)}`);
      return [];
    }
  }

  /**
   * X2 (issue #37): the story language, live. Saved for the next plan(); with a tour planned or running, the voice
   * plan is re-run for `lang` (VoiceManager logs VOICE_PLAN, A13 clips re-applied so the "Studio voice" /
   * "Fallback voice" label stays honest) and TourEngine.switchLang continues the queued stories at the next
   * sentence boundary in the new language. Pause, skip, AVSession, nav cues and the continuous task are untouched.
   */
  setStoryLang(lang: Lang): void {
    try {
      this.opts.lang = lang;
      const st: TourState | undefined = this.state;
      const tour: Tour | undefined = this.tour;
      const ph: TourPhase = this.phase();
      if (st === undefined || tour === undefined || ph === TourPhase.IDLE || ph === TourPhase.PLANNING ||
        ph === TourPhase.FINISHED || ph === TourPhase.ABORTED) {
        this.deps.log.info(LogEvents.LANG_SWITCH, `to=${lang} where=next_plan phase=${ph}`);
        return;
      }
      const prev: VoicePlan | undefined = this.voicePlan;
      this.ctrlIssues = this.ctrlIssues.filter((i: AppIssue) =>
        i.code !== IssueCode.TTS_INIT_FAIL && i.code !== IssueCode.VOICE_UNAVAILABLE);
      const base: VoicePlan = this.resolveVoice();
      const vp: VoicePlan = this.applyClips(tour, base);
      if (vp.label !== VoiceLabel.PRERENDERED) {
        this.reportVoice(base);
      }
      if (lang === st.input.lang && prev !== undefined && prev.label === vp.label &&
        prev.speechMode === vp.speechMode && prev.engineLocale === vp.engineLocale) {
        this.deps.log.info(LogEvents.LANG_SWITCH, `to=${lang} action=none reason=same_lang_and_voice`);
        return;
      }
      this.voicePlan = vp;
      this.narrLogged.clear();
      const personaId: string = tour.personaId;
      if (st.speechText) {
        this.heardLabel = undefined;       // from text to voice: no voice heard yet in this mode, use the plan label
      }
      // Otherwise the heard label stays until the first new-language sentence starts (noteHeard at UTT_START):
      // the sentence in flight finishes in the old voice, and the chip / AVSession artist say so.
      const fxs: Effect[] = TourEngine.switchLang(st, lang,
        (poiId: string, len: NarrationLength) => this.narrationFor(poiId, personaId, lang, len), vp,
        this.deps.clock.nowMs());
      for (const fx of fxs) {
        this.execute(fx);
      }
      this.flushDeferred();
      const u: Utterance | undefined = st.queue.inFlight();
      if (u !== undefined && !st.speechText) {
        this.prefetchAfter(u);             // replaces the parked old-language sentence (new utterance ids)
      }
      this.publishNow();
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=TourController.setStoryLang ${errText(e as Object)}`);
    }
  }

  /** A9: the Spoken directions toggle: applies to the running tour at once (setOptions calls it too). */
  setSpokenDirections(on: boolean): void {
    this.opts.spokenDirections = on;
    this.syncDirections(on);
  }

  private syncDirections(on: boolean): void {
    const st: TourState | undefined = this.state;
    if (st === undefined || st.spokenDirections === on) {
      return;
    }
    TourEngine.setSpokenDirections(st, on);
    this.deps.log.info(LogEvents.SETTINGS, `spokenDirections=${on ? 1 : 0} where=tour phase=${st.phase}`);
  }

  private replan(): void {
    const st: TourState | undefined = this.state;
    const tour: Tour | undefined = this.tour;
    if (st === undefined || tour === undefined) {
      return;
    }
    const remaining: string[] = openStopIds(st);
    if (remaining.length === 0) {
      return;
    }
    const f: Fix | undefined = st.lastFix;
    let origin: LatLng = invalidOrigin();
    if (f !== undefined) {
      origin = { lat: f.lat, lng: f.lng };
    }
    const p: TourPlan = this.solve(tour, remaining, origin, 0);
    this.lastPlan = p;
    const ev: EngineEvent = { type: EngineEventType.PLAN_READY, nowMs: this.deps.clock.nowMs(), plan: p };
    this.dispatch(ev);
  }

  // ================================================================ start / stop

  private async startInternal(): Promise<void> {
    if (this.state === undefined || this.phase() === TourPhase.IDLE || this.phase() === TourPhase.FINISHED ||
      this.phase() === TourPhase.ABORTED) {
      const tours: Tour[] = this.packLoaded ? this.deps.pack.tours() : [];
      await this.planInternal(this.tour !== undefined ? this.tour.id : (tours.length > 0 ? tours[0].id : ''), 0);
    }
    if (this.phase() !== TourPhase.READY) {
      this.deps.log.warn(LogEvents.STATE, `from=${this.phase()} to=${this.phase()} ev=START_TOUR ignored=not_ready`);
      return;
    }
    if (this.running) {
      return;
    }
    this.generation++;
    const gen: number = this.generation;
    this.running = true;
    this.heardLabel = undefined;
    this.lastMeta = undefined;
    this.noopLogged.clear();
    this.timeoutSent = false;
    this.noFixLogged = false;
    this.firstRealFixSeen = false;
    this.notifDenied = false;
    this.deps.speech.setListener(new SpeechBridge(this, gen));
    await this.startPlatform(gen);
    if (gen !== this.generation) {
      return;                            // ended while the platform was starting
    }
    this.startedAtMs = this.deps.clock.nowMs();
    this.lastActiveFixMs = Number.NaN;
    this.stopSources();                  // a plan-time origin source restarts with this session's callbacks
    this.startSources(true);
    this.tickId = this.deps.scheduler.every(TICK_MS, () => this.onTick(gen));
    this.dispatchType(EngineEventType.START_TOUR);
  }

  /** Continuous task, then AVSession. Each failure is logged, shown as an issue, and the tour goes on. */
  private async startPlatform(gen: number): Promise<void> {
    const bg: BackgroundPort | undefined = this.safeGet(this.deps.background, 'background');
    if (bg === undefined) {
      this.noop('bg', LogEvents.BG_START, 'modes=location,audioPlayback noop=no_service');
    } else {
      try {
        bg.setListener(new BackgroundBridge(this));
        this.bgUp = await this.withTimeout<boolean>(bg.start(), PLATFORM_START_TIMEOUT_MS, false);
        if (!this.bgUp) {
          this.deps.log.error(LogEvents.BG_FAIL, 'where=controller result=false action=foreground_only');
          this.addIssue(IssueCode.BG_FAIL, IssueSeverity.WARN, 'continuous task not running');
          this.keepScreen(true, 'bg_fail');
        }
      } catch (e) {
        this.bgUp = false;
        this.deps.log.error(LogEvents.BG_FAIL, `where=controller ${errText(e as Object)} action=foreground_only`);
        this.addIssue(IssueCode.BG_FAIL, IssueSeverity.WARN, 'continuous task failed');
        this.keepScreen(true, 'bg_fail');
      }
    }
    if (gen !== this.generation) {
      return;
    }
    this.requestNotifications(gen);
    if (gen !== this.generation) {
      return;
    }
    const media: MediaSessionPort | undefined = this.safeGet(this.deps.media, 'media');
    if (media === undefined) {
      this.noop('avs', LogEvents.AVS_META, 'noop=no_service');
      return;
    }
    try {
      this.avsUp = await this.withTimeout<boolean>(media.init((cmd: MediaCommand) => this.onMediaCommand(cmd)),
        PLATFORM_START_TIMEOUT_MS, false);
      if (!this.avsUp) {
        this.deps.log.error(LogEvents.AVS_FAIL, 'where=controller result=false');
        this.addIssue(IssueCode.AVS_FAIL, IssueSeverity.INFO, 'lock-screen controls unavailable');
      }
    } catch (e) {
      this.avsUp = false;
      this.deps.log.error(LogEvents.AVS_FAIL, `where=controller ${errText(e as Object)}`);
      this.addIssue(IssueCode.AVS_FAIL, IssueSeverity.INFO, 'lock-screen controls unavailable');
    }
  }

  /** `fresh`: a new tour, so the demo walk starts from its first sample. */
  private startSources(fresh: boolean): void {
    const gen: number = this.generation;
    const kind: FixSource = this.sourceKind;
    const src: LocationSource | undefined = this.safeGet<LocationSource>(() => this.deps.sourceFor(kind), 'source');
    if (src === undefined) {
      this.deps.log.warn(LogEvents.LOC_SOURCE, `kind=${kind} available=false noop=no_source`);
      this.addIssue(IssueCode.LOC_UNAVAILABLE, IssueSeverity.WARN, `no ${kind} source`);
    } else {
      this.activeSource = src;
      if (kind === FixSource.DEMO) {
        this.wireDemo(fresh);
      }
      this.deps.log.info(LogEvents.LOC_SOURCE, `kind=${kind} role=active`);
      this.startSource(src, kind, gen, true);
    }
    if (kind === FixSource.DEMO) {
      this.startShadowReal(gen);
    }
  }

  private wireDemo(fresh: boolean): void {
    const dc: DemoControls | undefined = this.demo();
    if (dc === undefined) {
      return;
    }
    try {
      if (fresh) {
        dc.rewind();
      }
      dc.setHoldPredicate(() => this.storyActive());
      dc.setSpeed(this.opts.demoSpeed);
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=TourController.wireDemo ${errText(e as Object)}`);
    }
  }

  /** §5: in demo mode the real source keeps running, so the HUD can show "Real GPS: ±xx m". Never asks. */
  private startShadowReal(gen: number): void {
    const real: LocationSource | undefined = this.safeGet<LocationSource>(
      () => this.deps.sourceFor(FixSource.REAL), 'source');
    if (real === undefined || real === this.activeSource) {
      return;
    }
    const perms: PermissionPort | undefined = this.safeGet(this.deps.permissions, 'permissions');
    if (perms === undefined) {
      return;
    }
    perms.locationState().then((ps: PermissionState) => {
      if (gen !== this.generation || ps !== PermissionState.GRANTED) {
        return;
      }
      this.shadowSource = real;
      this.deps.log.info(LogEvents.LOC_SOURCE, 'kind=real role=shadow');
      this.startSource(real, FixSource.REAL, gen, false);
    }).catch((e: Object) => {
      this.deps.log.warn(LogEvents.LOC_ERR, `where=shadow_real_permission ${errText(e)}`);
    });
  }

  private startSource(src: LocationSource, kind: FixSource, gen: number, active: boolean): void {
    try {
      src.start((fix: Fix) => this.onSourceFix(gen, kind, active, fix),
        (code: number, msg: string) => this.onSourceError(gen, kind, code, msg)).catch((e: Object) => {
        this.onSourceError(gen, kind, -1, errText(e));
      });
    } catch (e) {
      this.onSourceError(gen, kind, -1, errText(e as Object));
    }
  }

  private stopSources(): void {
    const srcs: (LocationSource | undefined)[] = [this.activeSource, this.shadowSource];
    for (const s of srcs) {
      if (s !== undefined) {
        try {
          s.stop();
        } catch (e) {
          this.deps.log.error(LogEvents.UNCAUGHT, `where=LocationSource.stop kind=${s.kind} ${errText(e as Object)}`);
        }
      }
    }
    this.activeSource = undefined;
    this.shadowSource = undefined;
  }

  /** Stops the session's sources, TICK and the platform. The engine state stays readable (FINISHED/ABORTED). */
  private teardown(why: string): void {
    this.running = false;
    this.generation++;
    this.deps.scheduler.cancel(this.tickId);
    this.tickId = -1;
    this.stopSources();
    const bg: BackgroundPort | undefined = this.safeGet(this.deps.background, 'background');
    if (bg !== undefined && this.bgUp) {
      try {
        bg.stop().catch((e: Object) => {
          this.deps.log.error(LogEvents.BG_FAIL, `where=controller.stop ${errText(e)}`);
        });
      } catch (e) {
        this.deps.log.error(LogEvents.BG_FAIL, `where=controller.stop ${errText(e as Object)}`);
      }
    }
    this.bgUp = false;
    const media: MediaSessionPort | undefined = this.safeGet(this.deps.media, 'media');
    if (media !== undefined && this.avsUp) {
      try {
        media.destroy().catch((e: Object) => {
          this.deps.log.error(LogEvents.AVS_FAIL, `where=controller.destroy ${errText(e)}`);
        });
      } catch (e) {
        this.deps.log.error(LogEvents.AVS_FAIL, `where=controller.destroy ${errText(e as Object)}`);
      }
    }
    this.avsUp = false;
    this.keepScreen(false, why);
    this.deps.log.info(LogEvents.STATE, `from=${this.phase()} to=${this.phase()} ev=TEARDOWN why=${why}`);
    this.schedulePublish();
  }

  // ================================================================ location and clock

  private onSourceFix(gen: number, kind: FixSource, active: boolean, fix: Fix): void {
    if (gen !== this.generation) {
      return;
    }
    const now: number = this.deps.clock.nowMs();
    if (kind === FixSource.REAL) {
      this.realAccuracyM = fix.accuracyM;
    }
    this.latestFix = fix;
    this.latestFixAtMs = now;
    if (this.originWaiter !== undefined) {
      this.originWaiter();
    }
    if (!active || this.state === undefined) {
      this.schedulePublish();
      return;
    }
    this.lastActiveFixMs = now;
    this.timeoutSent = false;
    this.clearLocationIssues();
    if (kind === FixSource.REAL && this.running && !this.firstRealFixSeen) {
      this.firstRealFixSeen = true;
      this.checkFirstRealFix(gen, fix);
    }
    const ev: EngineEvent = { type: EngineEventType.FIX, nowMs: now, fix: fix };
    this.dispatch(ev);
  }

  private onSourceError(gen: number, kind: FixSource, code: number, msg: string): void {
    if (gen !== this.generation) {
      return;
    }
    this.deps.log.warn(LogEvents.LOC_ERR, `src=${kind} code=${code} ${msg.startsWith('msg=') ? msg : 'msg=' + msg}`);
    if (kind !== this.sourceKind) {
      return;                            // the §5 shadow source: the HUD shows "Real GPS: n/a", nothing else
    }
    const i: AppIssue = locationErrorIssue(code, kind);
    const kv: string = `src=${kind} code=${code} where=controller`;
    if (i.code === IssueCode.PERM_DENIED) {
      this.deps.log.error(LogEvents.PERM_DENIED, `perm=LOCATION ${kv} action=offer_settings_or_demo`);
    } else if (i.code === IssueCode.LOC_SWITCH_OFF) {
      this.deps.log.warn(LogEvents.LOC_SWITCH_OFF, `${kv} action=offer_switch_or_demo`);
    } else {
      this.deps.log.error(LogEvents.LOC_UNAVAILABLE, `${kv} action=offer_demo`);
    }
    this.addIssue(i.code, i.severity, i.detail);
    this.schedulePublish();
  }

  /** §9 rows 2 and 8 during a tour on real GPS: approximate-only permission, far from the pack. */
  private checkFirstRealFix(gen: number, fix: Fix): void {
    const km: number = kmOutsideBbox(fix.lat, fix.lng, this.packBbox);
    if (Number.isFinite(km) && km > OUT_OF_AREA_KM) {
      this.deps.log.info(LogEvents.LOC_OUT_OF_AREA, `km=${Math.round(km)} src=${fix.source} action=suggest_demo`);
      this.addIssue(IssueCode.LOC_OUT_OF_AREA, IssueSeverity.INFO, `km=${Math.round(km)}`);
    }
    const perms: PermissionPort | undefined = this.safeGet(this.deps.permissions, 'permissions');
    if (perms === undefined) {
      return;
    }
    try {
      perms.locationState().then((ps: PermissionState) => {
        if (gen !== this.generation || ps !== PermissionState.APPROX_ONLY) {
          return;
        }
        this.deps.log.warn(LogEvents.PERM_APPROX_ONLY, `acc=${Math.round(fix.accuracyM)} where=controller ` +
          'action=stories_need_precise');
        this.addIssue(IssueCode.PERM_APPROX_ONLY, IssueSeverity.WARN, 'approximate location only');
        this.schedulePublish();
      }).catch((e: Object) => {
        this.deps.log.warn(LogEvents.LOC_ERR, `where=approx_check ${errText(e)}`);
      });
    } catch (e) {
      this.deps.log.warn(LogEvents.LOC_ERR, `where=approx_check ${errText(e as Object)}`);
    }
  }

  private onTick(gen: number): void {
    if (gen !== this.generation || !this.running) {
      return;
    }
    const now: number = this.deps.clock.nowMs();
    const since: number = Number.isFinite(this.lastActiveFixMs) ? this.lastActiveFixMs : this.startedAtMs;
    if (!Number.isFinite(this.lastActiveFixMs) && !this.noFixLogged && now - this.startedAtMs >= NO_FIRST_FIX_MS) {
      this.noFixLogged = true;
      this.deps.log.warn(LogEvents.LOC_NOFIX, `secs=${Math.round((now - this.startedAtMs) / 1000)} src=${this.sourceKind}`);
      this.addIssue(IssueCode.LOC_NOFIX, IssueSeverity.WARN, `src=${this.sourceKind}`);
    }
    if (!this.timeoutSent && Number.isFinite(since) && now - since > FIX_TIMEOUT_MS) {
      this.timeoutSent = true;
      this.dispatchType(EngineEventType.FIX_TIMEOUT);
    }
    this.dispatchType(EngineEventType.TICK);
  }

  // ================================================================ dispatch and effects

  private userEvent(type: EngineEventType): void {
    if (this.state === undefined) {
      return;
    }
    this.dispatchType(type);
  }

  private dispatchType(type: EngineEventType): void {
    const ev: EngineEvent = { type: type, nowMs: this.deps.clock.nowMs() };
    this.dispatch(ev);
  }

  /** Runs the reducer for `ev` and every event raised while its effects execute, in arrival order. */
  private dispatch(ev: EngineEvent): void {
    this.pending.push(ev);
    if (this.dispatching) {
      return;
    }
    this.dispatching = true;
    try {
      while (this.pending.length > 0) {
        const e: EngineEvent = this.pending.shift() as EngineEvent;
        const st: TourState | undefined = this.state;
        if (st === undefined) {
          continue;
        }
        let r: StepResult;
        try {
          r = TourEngine.reduce(st, e);
        } catch (err) {
          this.deps.log.error(LogEvents.UNCAUGHT, `where=TourEngine.reduce ev=${e.type} ${errText(err as Object)}`);
          continue;
        }
        this.state = r.state;
        for (const fx of r.effects) {
          this.execute(fx);
        }
        this.flushDeferred();
      }
    } finally {
      this.dispatching = false;
    }
    this.afterDispatch();
  }

  private afterDispatch(): void {
    const st: TourState | undefined = this.state;
    if (this.running && st !== undefined) {
      const idle: boolean = !st.queue.isBusy() && st.queue.size() === 0;
      if (st.phase === TourPhase.ABORTED || (st.phase === TourPhase.FINISHED && idle)) {
        this.teardown(st.phase === TourPhase.ABORTED ? 'aborted' : 'finished');
      }
    }
    this.schedulePublish();
  }

  private execute(fx: Effect): void {
    try {
      switch (fx.type) {
        case EffectType.SPEAK:
          if (fx.utterance !== undefined) {
            this.deps.speech.speak(fx.utterance);
            this.prefetchAfter(fx.utterance);
          }
          break;
        case EffectType.STOP_SPEECH:
          if (fx.afterCurrent !== true) {
            this.deps.speech.stopNow();
          }
          break;
        case EffectType.SET_MEDIA_META:
          this.mediaMeta(fx);
          break;
        case EffectType.SET_MEDIA_STATE:
          this.mediaState(fx.playState);
          break;
        case EffectType.NOTIFY_NEXT:
          this.notifyNext(fx);
          break;
        case EffectType.HAPTIC:
          this.haptic(fx);
          break;
        case EffectType.REQUEST_REPLAN:
          this.replan();
          break;
        case EffectType.PERSIST_PROGRESS:
          break;                         // nothing is persisted in v1 (no task owns tour resume)
        case EffectType.LOG:
          this.engineLog(fx.logCode === undefined ? 'ENGINE' : fx.logCode, fx.logKv === undefined ? '' : fx.logKv);
          break;
        default:
          break;
      }
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=TourController.execute fx=${fx.type} ${errText(e as Object)}`);
    }
  }

  private flushDeferred(): void {
    if (this.deferredInfo.length === 0) {
      return;
    }
    const lines: string[] = this.deferredInfo;
    this.deferredInfo = [];
    for (const kv of lines) {
      this.deps.log.info(LogEvents.NARR_SOURCE, kv);
    }
  }

  private engineLog(code: string, kv: string): void {
    if (WARN_CODES.indexOf(code) >= 0) {
      this.deps.log.warn(code, kv);
    } else {
      this.deps.log.info(code, kv);
    }
  }

  /** Prefetch the next sentence of the same item while this one plays (A4: ~90 ms gap instead of synthesis time). */
  private prefetchAfter(u: Utterance): void {
    const st: TourState | undefined = this.state;
    if (st === undefined) {
      return;
    }
    const item: Announcement | undefined = st.queue.currentItem();
    if (item === undefined || item.cursor + 1 >= item.utterances.length) {
      return;
    }
    const src: Utterance = item.utterances[item.cursor + 1];
    const id: string = predictNextUtteranceId(u.id, src.id);
    if (id.length === 0) {
      return;
    }
    const next: Utterance = { id: id, itemId: src.itemId, text: src.text, lang: src.lang, personaId: src.personaId };
    this.deps.speech.prefetch(next);
  }

  private mediaMeta(fx: Effect): void {
    const media: MediaSessionPort | undefined = this.safeGet(this.deps.media, 'media');
    if (fx.meta === undefined) {
      return;
    }
    this.lastMeta = fx.meta;
    if (media === undefined) {
      this.noop('meta', LogEvents.AVS_META, `title="${fx.meta.title}" noop=no_service`);
      return;
    }
    this.sendMeta(fx.meta);
  }

  /**
   * Artist = "CityTour · <persona>" (the service appends " · DEMO" for the Demo walk); the engine puts the tour
   * title there, which the card already shows as the album. voiceLabel is the label heard last (heardLabel), not
   * the tour plan; it is logged, not shown.
   */
  private sendMeta(meta: MediaMeta): void {
    const media: MediaSessionPort | undefined = this.safeGet(this.deps.media, 'media');
    if (media === undefined) {
      return;
    }
    const st: TourState | undefined = this.state;
    const textNow: boolean = st !== undefined && st.speechText;
    const label: VoiceLabel = !textNow && this.heardLabel !== undefined ? this.heardLabel : meta.voiceLabel;
    let city: string = '';
    try {
      city = this.deps.cityName !== undefined ? this.deps.cityName() : '';
    } catch (e) {
      city = '';
    }
    const m: MediaMeta = {
      title: meta.title, artist: this.artist, voiceLabel: label, demo: meta.demo, album: albumLine(city, meta.artist)
    };
    try {
      media.setMeta(m);                  // a session that is not active yet buffers it (A6)
    } catch (e) {
      this.deps.log.error(LogEvents.AVS_FAIL, `where=controller.setMeta ${errText(e as Object)}`);
    }
  }

  private mediaState(s: MediaPlayState | undefined): void {
    const media: MediaSessionPort | undefined = this.safeGet(this.deps.media, 'media');
    if (s === undefined) {
      return;
    }
    if (media === undefined) {
      this.noop('state', LogEvents.AVS_META, `state=${s} noop=no_service`);
      return;
    }
    media.setState(s);
  }

  private notifyNext(fx: Effect): void {
    if (fx.notice === undefined) {
      return;
    }
    if (this.notifDenied) {
      return;                            // §9 row 16: nothing else changes
    }
    const n: NotifierPort | undefined = this.safeGet(this.deps.notifier, 'notifier');
    if (n === undefined) {
      this.noop('notify', LogEvents.NOTIF_PUBLISH, `poi=${fx.notice.poiId} d=${fx.notice.distanceM} noop=no_service`);
      return;
    }
    n.publishNext(fx.notice).catch((e: Object) => {
      this.deps.log.warn(LogEvents.NOTIF_DENIED, `where=publishNext ${errText(e)}`);
    });
  }

  private haptic(fx: Effect): void {
    if (fx.haptic === undefined) {
      return;
    }
    const h: HapticsPort | undefined = this.safeGet(this.deps.haptics, 'haptics');
    if (h === undefined) {
      this.noop(`haptic:${fx.haptic}`, LogEvents.HAPTIC, `kind=${fx.haptic} noop=no_service`);
      return;
    }
    h.play(fx.haptic);
  }

  // ================================================================ snapshot

  private demoHolding(): boolean {
    const dc: DemoControls | undefined = this.demo();
    try {
      return dc !== undefined ? dc.isHolding() : this.storyActive();
    } catch (e) {
      return false;
    }
  }

  private storyActive(): boolean {
    const st: TourState | undefined = this.state;
    return st !== undefined && st.phase === TourPhase.AT_STOP && st.activeIdx >= 0;
  }

  private platformStatus(st: TourState | undefined): PlatformStatus {
    let bgRunning: boolean = false;
    let avsActive: boolean = false;
    try {
      const bg: BackgroundPort | undefined = this.deps.background();
      bgRunning = bg !== undefined && bg.isRunning();
      const media: MediaSessionPort | undefined = this.deps.media();
      avsActive = media !== undefined && media.isActive();
    } catch (e) {
      // status only; never fail a snapshot
    }
    const vp: VoicePlan | undefined = this.voicePlan;
    const textOnly: boolean = st !== undefined ? st.speechText : (vp === undefined || vp.speechMode === 'text');
    const p: PlatformStatus = {
      bgRunning: bgRunning, avsActive: avsActive,
      ttsEngine: textOnly || vp === undefined ? 'none' :
        vp.engineLocale === '' ? 'clips' : `${vp.engineLocale}/${vp.person}`,
      sourceKind: this.sourceKind, realGpsAccuracyM: this.realAccuracyM,
      demoHold: this.running && this.sourceKind === FixSource.DEMO && this.demoHolding()
    };
    return p;
  }

  private idleSnapshot(): EngineSnapshot {
    const vp: VoicePlan | undefined = this.voicePlan;
    const s: EngineSnapshot = {
      phase: TourPhase.IDLE, tourId: this.tour !== undefined ? this.tour.id : '', stops: [], currentStopIdx: -1,
      signal: SignalQuality.GOOD, offRoute: false, paused: false,
      speechText: vp !== undefined && vp.speechMode === 'text', plannedOrder: [], walkedM: 0, remainingM: 0,
      issues: [], voiceLabel: vp !== undefined ? vp.label : VoiceLabel.FALLBACK_ZH_READS_EN, source: this.sourceKind,
      platform: this.platformStatus(undefined)
    };
    return s;
  }

  /** The label of what is audible now: a clip, native or fallback TTS. Text sentences give undefined. */
  private liveLabel(): VoiceLabel | undefined {
    try {
      const f = this.deps.liveVoiceLabel;
      const l: VoiceLabel | undefined = f !== undefined ? f() : undefined;
      if (l === VoiceLabel.PRERENDERED || l === VoiceLabel.NATIVE || l === VoiceLabel.FALLBACK_ZH_READS_EN) {
        return l;
      }
    } catch (e) {
      // status only; never fail a snapshot
    }
    return undefined;
  }

  private schedulePublish(): void {
    if (this.publishTimer >= 0 || this.listeners.length === 0) {
      return;
    }
    const wait: number = this.lastPublishMs + SNAPSHOT_MIN_INTERVAL_MS - this.deps.clock.nowMs();
    if (wait <= 0) {
      this.publishNow();
      return;
    }
    this.publishTimer = this.deps.scheduler.after(wait, () => {
      this.publishTimer = -1;
      this.publishNow();
    });
  }

  private publishNow(): void {
    if (this.publishTimer >= 0) {
      this.deps.scheduler.cancel(this.publishTimer);
      this.publishTimer = -1;
    }
    this.lastPublishMs = this.deps.clock.nowMs();
    if (this.listeners.length === 0) {
      return;
    }
    const s: EngineSnapshot = this.current();
    for (const l of this.listeners) {
      this.safeNotify(l, s);
    }
  }

  private safeNotify(l: SnapshotListener, s: EngineSnapshot): void {
    try {
      l(s);
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=SnapshotListener ${errText(e as Object)}`);
    }
  }

  // ================================================================ small helpers

  private phase(): TourPhase {
    return this.state === undefined ? TourPhase.IDLE : this.state.phase;
  }

  private demo(): DemoControls | undefined {
    return this.safeGet(this.deps.demoControls, 'demo');
  }

  private safeGet<T>(f: () => T | undefined, what: string): T | undefined {
    try {
      return f();
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=TourController.get ${what} ${errText(e as Object)}`);
      return undefined;
    }
  }

  /** One log line per tour and key for an effect whose service is not wired yet. */
  private noop(key: string, event: string, kv: string): void {
    if (this.noopLogged.has(key)) {
      return;
    }
    this.noopLogged.add(key);
    this.deps.log.info(event, kv);
  }

  /** §9 row 16: ask once per tour, never wait for the dialog; a refusal only stops the next-stop notices. */
  private requestNotifications(gen: number): void {
    const n: NotifierPort | undefined = this.safeGet(this.deps.notifier, 'notifier');
    if (n === undefined) {
      return;
    }
    try {
      n.requestEnable().then((ok: boolean) => {
        if (gen !== this.generation || ok) {
          return;
        }
        this.notifDenied = true;
        this.deps.log.info(LogEvents.NOTIF_DENIED, 'where=controller action=no_next_notice');
        this.addIssue(IssueCode.NOTIF_DENIED, IssueSeverity.INFO, 'notifications off');
        this.schedulePublish();
      }).catch((e: Object) => {
        this.deps.log.warn(LogEvents.NOTIF_DENIED, `where=requestEnable ${errText(e)}`);
      });
    } catch (e) {
      this.deps.log.warn(LogEvents.NOTIF_DENIED, `where=requestEnable ${errText(e as Object)}`);
    }
  }

  /** §9 row 14: keep the screen on while guiding without the continuous task; released at teardown. */
  private keepScreen(on: boolean, why: string): void {
    const f: ((on: boolean) => void) | undefined = this.deps.keepScreenOn;
    if (f === undefined || on === this.screenKept) {
      return;
    }
    this.screenKept = on;
    try {
      f(on);
      this.deps.log.info(LogEvents.SETTINGS, `keepScreenOn=${on} why=${why}`);
    } catch (e) {
      this.deps.log.error(LogEvents.UNCAUGHT, `where=keepScreenOn ${errText(e as Object)}`);
    }
  }

  private clearLocationIssues(): void {
    if (this.ctrlIssues.length > 0) {
      this.ctrlIssues = this.ctrlIssues.filter((i: AppIssue) => LOCATION_ISSUES.indexOf(i.code) < 0);
    }
  }

  private addIssue(code: IssueCode, severity: IssueSeverity, detail: string): void {
    for (const i of this.ctrlIssues) {
      if (i.code === code) {
        i.severity = severity;
        i.detail = detail;
        return;
      }
    }
    const issue: AppIssue = { code: code, severity: severity, detail: detail };
    this.ctrlIssues.push(issue);
  }

  /** Resolves with `fallback` if `p` has not settled after `ms`; a later rejection is swallowed. */
  private withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled: boolean = false;
      const id: number = this.deps.scheduler.after(ms, () => {
        if (!settled) {
          settled = true;
          this.deps.log.warn(LogEvents.UNCAUGHT, `where=TourController.withTimeout ms=${ms}`);
          resolve(fallback);
        }
      });
      p.then((v: T) => {
        if (!settled) {
          settled = true;
          this.deps.scheduler.cancel(id);
          resolve(v);
        }
      }).catch((e: Object) => {
        if (!settled) {
          settled = true;
          this.deps.scheduler.cancel(id);
          this.deps.log.error(LogEvents.UNCAUGHT, `where=TourController.withTimeout ${errText(e)}`);
          resolve(fallback);
        }
      });
    });
  }
}
