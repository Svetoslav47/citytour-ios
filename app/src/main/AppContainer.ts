/*
 * Composition root (docs/ARCHITECTURE.md §1.2 lifecycle, §12.1). EntryAbility calls init() in onCreate and
 * shutdown() in onDestroy. init() builds services but starts nothing. ViewModels read the getters only.
 * A5 wiring: permissions() = PermissionService (location permission + switch), realLocation() = RealLocationSource
 * (Location Kit), demoWalk() = DemoWalkSource (SIMULATED track replay). Built in init(), started by their users.
 * A7 wiring: tourControl() = TourController (engine + Planner + speech + background() + mediaSession() +
 * realLocation()/demoWalk() + permissions()). DemoWalkSource reaches the controller's DemoControls through
 * DemoWalkControls. ScriptedTourControl stays for UI previews (scriptedTourControl()).
 * A8 wiring: notifier() = TourNotifier (Notification Kit, id 1001 next-stop / text-only arrival notification; it
 * subscribes to the controller's snapshots for the 50 m refresh and the cancel at tour end), haptics() = Haptics
 * (vibrator preset with isSupportEffectSync check, timed fallback). shutdown() cancels the notification.
 * A4 wiring: voice() = VoiceManager (listVoices/downloadVoice + pure VoicePolicy), speech() = NarrationPlayer
 * (TTS playType 0 -> PcmPlayer AudioRenderer). Both share one TtsEngines, so each engine exists once per app.
 * A13 wiring: NarrationPlayer also gets a ClipPlayer (AVPlayer over the active course's downloaded clips, ElevenLabs
 * pre-rendered at build time); with no course (or no clip manifest) every sentence uses the TTS path.
 * A6 wiring: background() = BackgroundRunner (one continuous task ['location','audioPlayback']; it stops speech
 * before stopping the task, as the continuous-task guide requires), mediaSession() = MediaSessionService (AVSession
 * 'audio'). Both are constructed lazily and only touch the platform when start()/init() is called. shutdown()
 * stops the task and destroys the session.
 * A10 wiring (ARCHITECTURE §9): NarrationPlayer's audio interrupts / headphone loss go to the TourController
 * (rows 12/13, a services-side hook, no SpeechPort change); the controller's keepScreenOn goes to
 * window.setWindowKeepScreenOn on the last window (row 14; API 9, doc API参考/ArkUI_方舟UI框架/ArkTS_API/窗口管理/
 * ohos_window_窗口_/Interface_Window/arkts-apis-window-window, getLastWindow: .../Functions/arkts-apis-window-f,
 * FAQ faqs-arkui-1366: only effective in the foreground, reset it when the scene ends); AppConfig.DEBUG_CORRUPT_PACK
 * swaps in CorruptPackRepository (row 17 demo).
 * Course server (docs/SERVER.md): the app ships NO built-in course. remoteClient() = RemoteClient (Network Kit http,
 * Ed25519-verified envelopes), courses() = CourseRepository (downloaded courses; the PackRepository every caller gets
 * is the ActivePackRepository forwarding to the active course, or to an empty pack until the first download), and
 * speech() = RemoteVoice, a SpeechPort decorator over NarrationPlayer that adds the runtime studio voice. Once a
 * course is downloaded everything works offline (its pack, its clips, the built-in voice as the last resort).
 * UIAbilityContext: doc 开发指南/Ability_Kit_程序框架服务/应用模型/应用组件/UIAbility组件/
 * 启动应用内的UIAbility组件/uiability-intra-device-interaction.
 */
import { Paths } from 'expo-file-system';
import { ref } from 'valtio';
import {
  BackgroundPort, Clock, FixSource, HapticsPort, LocationSource, LoggerPort, MediaSessionPort, NotifierPort,
  PackRepository, PermissionPort, PermissionState, SpeechPort, TourControl, VoicePlan, VoicePort
} from '@citytour/core';
import { VoiceLabel } from '@citytour/core';
import { ClipIndex } from '@citytour/core';
import { ClipPlayer } from '../services/audio/ClipPlayer';
import { BackgroundRunner } from '../services/background/BackgroundRunner';
import { MediaSessionService } from '../services/media/MediaSessionService';
import { DemoTrackText, DemoWalkSource } from '../services/location/DemoWalkSource';
import { CityInfo, cityDisplayName } from '@citytour/core';
import { PermissionService } from '../services/location/PermissionService';
import { RealLocationSource } from '../services/location/RealLocationSource';
import { CorruptPackRepository } from '@citytour/core';
import { AudioEventListener, NarrationPlayer } from '../services/speech/NarrationPlayer';
import { TtsEngines } from '../services/speech/TtsEngines';
import { VoiceManager } from '../services/speech/VoiceManager';
import { TourNotifier } from '../services/notify/TourNotifier';
import { Haptics } from '../services/haptics/Haptics';
import { ScriptedTourControl } from '../services/tour/ScriptedTourControl';
import { DemoControls, TourController, TourControllerDeps } from '@citytour/core';
import { Lang } from '@citytour/core';
import { ClipEntry } from '@citytour/core';
import { ActivePackRepository } from '../services/pack/ActivePackRepository';
import { ActiveCourse, CourseRepository } from '../services/remote/CourseRepository';
import { demoWalkOffered, InstalledCourse } from '@citytour/core';
import { CourseStore } from '../services/remote/CourseStore';
import { CoverStore } from '../services/remote/CoverStore';
import { courseClipsOffThread } from '../services/remote/ClipManifestTask';
import { FileStore } from '../services/remote/FileStore';
import { RemoteClient } from '../services/remote/RemoteClient';
import { Ed25519Verifier } from '../services/remote/SignatureVerifier';
import { RemoteVoice } from '../services/speech/RemoteVoice';
import { StreamClips } from '../services/remote/StreamClips';
import { RemoteConfig } from './RemoteConfig';
import { SystemClock, SystemScheduler } from '@citytour/core';
import { AppConfig } from './AppConfig';
import { ConsoleLogger, Log } from './Log';
import { keepScreenOn as keepAwake } from '../services/screen/KeepScreen';
import { uiCode } from '../platform/strings';
// Defines the background location task at module scope, so it exists when iOS relaunches the app in the background.
import '../services/background/BackgroundRunner';
import { LogEvents } from '@citytour/core';

/** Before init() (no UIAbilityContext): reports UNKNOWN and never opens a dialog. */
class StubPermissionPort implements PermissionPort {
  locationState(): Promise<PermissionState> {
    return Promise.resolve(PermissionState.UNKNOWN);
  }

  requestLocation(): Promise<PermissionState> {
    return Promise.resolve(PermissionState.UNKNOWN);
  }

  openLocationSettings(): Promise<PermissionState> {
    return Promise.resolve(PermissionState.UNKNOWN);
  }

  isLocationSwitchOn(): boolean {
    return false;
  }

  requestLocationSwitch(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** TourController's DemoControls over the A5 DemoWalkSource (ArkTS has no structural typing). */
class DemoWalkControls implements DemoControls {
  private readonly src: DemoWalkSource;

  constructor(src: DemoWalkSource) {
    this.src = src;
  }

  wraps(s: DemoWalkSource): boolean {
    return this.src === s;
  }

  setSpeed(mult: number): void {
    this.src.setSpeed(mult);
  }

  jumpToNextStop(): void {
    this.src.jumpToNextStop();
  }

  jumpToStop(poiId: string, plannedIdx: number): void {
    this.src.jumpToStop(poiId, plannedIdx);
  }

  setHoldPredicate(p: () => boolean): void {
    this.src.setHoldPredicate(p);
  }

  isHolding(): boolean {
    return this.src.isHolding();
  }

  rewind(): void {
    this.src.rewind();
  }
}

/** What the services need from the app on iOS (the HarmonyOS UIAbilityContext stand-in). */
export interface AppContext {
  filesDir: string;   // Paths.document.uri without the trailing slash (file:// URI)
}

export class AppContainer {
  /** iOS has no ability context; set by init() so isReady()/context() keep their HarmonyOS meaning. */
  private static ctx: AppContext | undefined = undefined;
  private static clockImpl: Clock = new SystemClock();
  private static loggerImpl: LoggerPort = new ConsoleLogger();
  private static packImpl: PackRepository | undefined = undefined;
  private static tourImpl: TourController | undefined = undefined;
  private static scriptedImpl: ScriptedTourControl | undefined = undefined;
  private static voiceImpl: VoiceManager | undefined = undefined;
  private static speechImpl: NarrationPlayer | undefined = undefined;
  private static permImpl: PermissionPort | undefined = undefined;
  private static bgImpl: BackgroundRunner | undefined = undefined;
  private static avsImpl: MediaSessionService | undefined = undefined;
  private static realLocImpl: RealLocationSource | undefined = undefined;
  private static demoImpl: DemoWalkSource | undefined = undefined;
  private static activePackImpl: ActivePackRepository | undefined = undefined;
  private static demoCtlImpl: DemoWalkControls | undefined = undefined;
  private static notifierImpl: TourNotifier | undefined = undefined;
  private static hapticsImpl: Haptics | undefined = undefined;
  private static remoteImpl: RemoteClient | undefined = undefined;
  private static coursesImpl: CourseRepository | undefined = undefined;
  private static remoteVoiceImpl: RemoteVoice | undefined = undefined;
  private static streamClipsImpl: StreamClips | undefined = undefined;

  /** Idempotent. Builds services; starts nothing. */
  static init(): void {
    const ctx: AppContext = { filesDir: Paths.document.uri.replace(/\/+$/, '') };
    if (AppContainer.ctx !== undefined) {
      return;
    }
    AppContainer.ctx = ctx;
    try {
      AppContainer.packImpl = AppContainer.makePack();
      AppContainer.buildSpeech();
      AppContainer.startCourses();                   // SERVER.md §6: restore the active course + its clips (local)
      AppContainer.remoteVoice().probe();            // one GET /healthz (skipped when BASE_URL is '')
      AppContainer.permImpl = new PermissionService();
      AppContainer.realLocImpl = new RealLocationSource(AppContainer.permImpl);
      AppContainer.demoImpl = new DemoWalkSource(() => AppContainer.demoTrackText());
      AppContainer.tourImpl = AppContainer.buildTour();
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=AppContainer.init ${Log.errKv(e as Object)}`);
    }
  }

  static shutdown(): void {
    // The tour first (A7: stops sources and TICK, stops its task and AVSession), then anything a DevPanel button
    // started outside a tour. Stop the continuous task (it stops speech first) and destroy the AVSession; both are
    // async, best effort.
    try {
      if (AppContainer.tourImpl !== undefined) {
        AppContainer.tourImpl.shutdown();
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=AppContainer.shutdown.tour ${Log.errKv(e as Object)}`);
    }
    try {
      if (AppContainer.bgImpl !== undefined && AppContainer.bgImpl.isRunning()) {
        AppContainer.bgImpl.stop().catch((e: Object) => {
          Log.e(LogEvents.UNCAUGHT, `where=AppContainer.shutdown.bg ${Log.errKv(e)}`);
        });
      }
      if (AppContainer.avsImpl !== undefined) {
        AppContainer.avsImpl.destroy().catch((e: Object) => {
          Log.e(LogEvents.UNCAUGHT, `where=AppContainer.shutdown.avs ${Log.errKv(e)}`);
        });
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=AppContainer.shutdown.platform ${Log.errKv(e as Object)}`);
    }
    try {
      if (AppContainer.notifierImpl !== undefined) {
        AppContainer.notifierImpl.shutdown().catch((e: Object) => {
          Log.e(LogEvents.UNCAUGHT, `where=AppContainer.shutdown.notifier ${Log.errKv(e)}`);
        });
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=AppContainer.shutdown.notifier ${Log.errKv(e as Object)}`);
    }
    try {
      if (AppContainer.scriptedImpl !== undefined) {
        AppContainer.scriptedImpl.dispose();
      }
      if (AppContainer.speechImpl !== undefined) {
        AppContainer.speechImpl.dispose();
      }
      if (AppContainer.realLocImpl !== undefined) {
        AppContainer.realLocImpl.stop();
      }
      if (AppContainer.demoImpl !== undefined) {
        AppContainer.demoImpl.stop();
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=AppContainer.shutdown ${Log.errKv(e as Object)}`);
    }
    AppContainer.tourImpl = undefined;
    AppContainer.scriptedImpl = undefined;
    AppContainer.packImpl = undefined;
    AppContainer.voiceImpl = undefined;
    AppContainer.speechImpl = undefined;
    AppContainer.permImpl = undefined;
    AppContainer.bgImpl = undefined;
    AppContainer.avsImpl = undefined;
    AppContainer.realLocImpl = undefined;
    AppContainer.demoImpl = undefined;
    AppContainer.demoCtlImpl = undefined;
    AppContainer.notifierImpl = undefined;
    AppContainer.hapticsImpl = undefined;
    AppContainer.remoteImpl = undefined;
    AppContainer.coursesImpl = undefined;
    AppContainer.remoteVoiceImpl = undefined;
    AppContainer.streamClipsImpl = undefined;
    AppContainer.ctx = undefined;
  }

  static isReady(): boolean {
    return AppContainer.ctx !== undefined;
  }

  static context(): AppContext | undefined {
    return AppContainer.ctx;
  }

  static clock(): Clock {
    return AppContainer.clockImpl;
  }

  static logger(): LoggerPort {
    return AppContainer.loggerImpl;
  }

  static packKind(): string {
    if (AppConfig.DEBUG_CORRUPT_PACK) {
      return 'corrupt-debug';
    }
    const id = AppContainer.coursesImpl !== undefined ? AppContainer.coursesImpl.activeId() : '';
    return id === '' ? 'none' : `download:${id}`;
  }

  /** The active course's pack (none until a download), or the §9 row 17 fault (AppConfig.DEBUG_CORRUPT_PACK). */
  private static makePack(): PackRepository {
    if (AppConfig.DEBUG_CORRUPT_PACK) {
      Log.w(LogEvents.PACK_ERR, 'file=pois.json reason=parse src=debug action=inject flag=DEBUG_CORRUPT_PACK');
      return new CorruptPackRepository(AppContainer.loggerImpl);
    }
    return new ActivePackRepository();
  }

  static tourControl(): TourControl {
    return AppContainer.tourController();
  }

  /** Concrete TourController for DevPanel extras (options, isRunning). */
  static tourController(): TourController {
    if (AppContainer.tourImpl === undefined) {
      AppContainer.tourImpl = AppContainer.buildTour();
    }
    return AppContainer.tourImpl;
  }

  /** SIMULATED canned snapshots for UI previews and page development (T0). Not used by the app flow. */
  static scriptedTourControl(): TourControl {
    if (AppContainer.scriptedImpl === undefined) {
      AppContainer.scriptedImpl = new ScriptedTourControl();
    }
    return AppContainer.scriptedImpl;
  }

  /** Constructs only: the controller touches no platform API before plan()/start(). */
  private static buildTour(): TourController {
    const deps: TourControllerDeps = {
      pack: AppContainer.packRepository(),
      speech: AppContainer.speech(),
      voice: AppContainer.voiceManager(),
      log: AppContainer.loggerImpl,
      clock: AppContainer.clockImpl,
      scheduler: new SystemScheduler(),
      sourceFor: (kind: FixSource): LocationSource | undefined => AppContainer.locationSource(kind),
      demoControls: (): DemoControls | undefined => AppContainer.demoControls(),
      background: (): BackgroundPort | undefined => AppContainer.background(),
      media: (): MediaSessionPort | undefined => AppContainer.mediaSession(),
      notifier: (): NotifierPort | undefined => AppContainer.notifier(),
      haptics: (): HapticsPort | undefined => AppContainer.haptics(),
      permissions: (): PermissionPort | undefined => AppContainer.permissions(),
      keepScreenOn: (on: boolean) => AppContainer.keepScreenOn(on),
      clips: (): ClipIndex | undefined => AppContainer.narration().loadedClips(),
      liveVoiceLabel: (): VoiceLabel | undefined => {
        const p: VoicePlan | undefined = AppContainer.narration().currentPlan();
        return p !== undefined ? p.label : undefined;
      },
      cityName: (): string => AppContainer.cityName()
    };
    const ctrl: TourController = new TourController(deps);
    AppContainer.tourNotifier().attach(ctrl, (): Lang => ctrl.options().lang);
    // §9 rows 12/13: the speech service reports audio focus loss and headphone removal to the tour.
    const audioEvents: AudioEventListener = {
      onInterrupt: (hint: string) => ctrl.onAudioInterrupt(hint),
      onRouteLost: (devices: string) => ctrl.onAudioRouteLost(devices)
    };
    AppContainer.narration().setAudioEventListener(audioEvents);
    return ctrl;
  }

  static notifier(): NotifierPort {
    return AppContainer.tourNotifier();
  }

  /** Concrete TourNotifier: requestEnable() for Onboarding (A12); attach() is done by buildTour(). */
  static tourNotifier(): TourNotifier {
    if (AppContainer.notifierImpl === undefined) {
      AppContainer.notifierImpl = new TourNotifier();
    }
    return AppContainer.notifierImpl;
  }

  static haptics(): HapticsPort {
    if (AppContainer.hapticsImpl === undefined) {
      AppContainer.hapticsImpl = new Haptics();
    }
    return AppContainer.hapticsImpl;
  }

  /** §9 row 14: keep the screen on while the tour runs without its continuous task. Best effort, never throws. */
  static keepScreenOn(on: boolean): void {
    try {
      keepAwake(on);
    } catch (e) {
      Log.w(LogEvents.UNCAUGHT, `where=AppContainer.keepScreenOn on=${on} ${Log.errKv(e as Object)}`);
    }
  }

  /** The LocationSource for a kind: RealLocationSource (Location Kit) or the SIMULATED DemoWalkSource. */
  static locationSource(kind: FixSource): LocationSource | undefined {
    return kind === FixSource.DEMO ? AppContainer.demoWalk() : AppContainer.realLocation();
  }

  private static demoControls(): DemoControls | undefined {
    const d: DemoWalkSource | undefined = AppContainer.demoWalk();
    if (d === undefined) {
      return undefined;
    }
    if (AppContainer.demoCtlImpl === undefined || !AppContainer.demoCtlImpl.wraps(d)) {
      AppContainer.demoCtlImpl = new DemoWalkControls(d);
    }
    return AppContainer.demoCtlImpl;
  }

  static packRepository(): PackRepository {
    if (AppContainer.packImpl === undefined) {
      AppContainer.packImpl = AppContainer.makePack();
    }
    return AppContainer.packImpl;
  }

  static voice(): VoicePort {
    return AppContainer.voiceManager();
  }

  /**
   * The SpeechPort (one utterance in flight, prefetch n+1): RemoteVoice over NarrationPlayer (SERVER.md §2).
   * Call init() once before the first speak().
   */
  static speech(): SpeechPort {
    return AppContainer.remoteVoice();
  }

  /** The runtime studio voice decorator (Settings toggle, HUD Server row). */
  static remoteVoice(): RemoteVoice {
    if (AppContainer.remoteVoiceImpl === undefined) {
      AppContainer.remoteVoiceImpl = new RemoteVoice(AppContainer.narration(), AppContainer.remoteClient(),
        () => AppContainer.filesDir(), () => AppContainer.courses().activeId(), AppContainer.streamClips());
    }
    return AppContainer.remoteVoiceImpl;
  }

  /** The app's filesDir ('' before init()). */
  static filesDir(): string {
    const c = AppContainer.ctx;
    return c === undefined ? '' : c.filesDir;
  }

  static remoteClient(): RemoteClient {
    if (AppContainer.remoteImpl === undefined) {
      AppContainer.remoteImpl = new RemoteClient(RemoteConfig.BASE_URL,
        new Ed25519Verifier(RemoteConfig.SIGNING_PUBLIC_KEY_SPKI_B64), () => AppContainer.filesDir());
    }
    return AppContainer.remoteImpl;
  }

  /** Clips of a streamed course, fetched on demand (SERVER.md §6 "Streaming a course"). */
  static streamClips(): StreamClips {
    if (AppContainer.streamClipsImpl === undefined) {
      AppContainer.streamClipsImpl = new StreamClips(AppContainer.remoteClient());
    }
    return AppContainer.streamClipsImpl;
  }

  /** Downloaded and streamed courses (SERVER.md §6). */
  static courses(): CourseRepository {
    if (AppContainer.coursesImpl === undefined) {
      const pack = AppContainer.packRepository();
      // DEBUG_CORRUPT_PACK replaces the pack with a fake: courses then manage a private wrapper the app never shows.
      const active: ActivePackRepository = pack instanceof ActivePackRepository ? pack as ActivePackRepository :
        new ActivePackRepository();
      AppContainer.activePackImpl = active;
      AppContainer.coursesImpl = new CourseRepository(AppContainer.remoteClient(),
        new CourseStore(() => AppContainer.filesDir()), active,
        new CoverStore(AppContainer.remoteClient(), () => AppContainer.filesDir()),
        new CourseStore(() => AppContainer.filesDir(), 'cities'),
        new CourseStore(() => AppContainer.filesDir(), 'stream'),
        new CourseStore(() => AppContainer.filesDir(), 'stream-cities'));
    }
    return AppContainer.coursesImpl;
  }

  /** A course is installed and active (false on first run until the first download). */
  static hasCourse(): boolean {
    try {
      return AppContainer.courses().hasCourse();
    } catch (e) {
      return false;
    }
  }

  /** The SIMULATED Demo walk is offered while the active course's pack ships a demo track (any course, any city). */
  static demoWalkOffered(): boolean {
    try {
      const a = AppContainer.activePack();
      return demoWalkOffered(AppContainer.courses().activeId(), a !== undefined && a.hasDemoTrack());
    } catch (e) {
      return false;
    }
  }

  /** Restores the active course and keeps the speech side in step with it (clips, tour pack facts). */
  private static startCourses(): void {
    const repo = AppContainer.courses();
    repo.addListener((c: ActiveCourse) => AppContainer.onActiveCourse(c));
    repo.start();
  }

  private static onActiveCourse(c: ActiveCourse): void {
    try {
      if (AppContainer.tourImpl !== undefined && !AppContainer.tourImpl.isRunning()) {
        AppContainer.tourImpl.onPackSwitched();
      }
      if (c.id === '' || c.audioManifestPath === '' || c.root === '') {
        AppContainer.streamClips().setCourse('', '', false);
        AppContainer.narration().setCourseClips([]);
        return;
      }
      const streamLoad: Promise<void> = AppContainer.streamClips().setCourse(c.id, c.root, c.streamed);
      const load: Promise<void> = streamLoad.then(() => FileStore.readText(`${c.root}/${c.audioManifestPath}`)
        .then((text: string | undefined): Promise<void> | undefined => {
          if (text === undefined) {
            Log.w(LogEvents.NARR_AUDIO, `event=course_clips_missing course=${c.id}`);
            AppContainer.narration().setCourseClips([]);
            return undefined;
          }
          return courseClipsOffThread(text, c.root).then((entries: ClipEntry[]) => {
            AppContainer.narration().setCourseClips(entries);
          });
        })).catch((e: Object) => {
          Log.e(LogEvents.NARR_AUDIO, `event=course_clips_fail course=${c.id} ${Log.errKv(e)}`);
        });
      AppContainer.narration().trackClipLoad(load);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=AppContainer.onActiveCourse ${Log.errKv(e as Object)}`);
    }
  }

  /** Concrete VoiceManager for Settings/Onboarding/DevPanel extras (strategy(), lastCaps(), fallback context). */
  static voiceManager(): VoiceManager {
    if (AppContainer.voiceImpl === undefined) {
      AppContainer.buildSpeech();
    }
    return AppContainer.voiceImpl as VoiceManager;
  }

  static narration(): NarrationPlayer {
    if (AppContainer.speechImpl === undefined) {
      AppContainer.buildSpeech();
    }
    return AppContainer.speechImpl as NarrationPlayer;
  }

  /** Constructs only (no platform call): engines and the renderer are created lazily on first use. */
  private static buildSpeech(): void {
    const engines = new TtsEngines();
    const vm = new VoiceManager(engines);
    AppContainer.voiceImpl = vm;
    // A13: ClipPlayer plays the course's pre-rendered sentence clips (sandbox files, AVPlayer) when a hash matches.
    // iOS: no system TTS. Sentences play from course clips, else the server's studio voice, else as text.
    const np = new NarrationPlayer(vm, new ClipPlayer());
    AppContainer.speechImpl = np;
    vm.setClipSource((lang: string): boolean => np.hasClips(lang));
  }

  static permissions(): PermissionPort {
    if (AppContainer.permImpl === undefined) {
      AppContainer.permImpl = AppContainer.ctx !== undefined ? new PermissionService() :
        new StubPermissionPort();
    }
    return AppContainer.permImpl;
  }

  static background(): BackgroundPort {
    return AppContainer.backgroundRunner();
  }

  /** Concrete BackgroundRunner for the DevPanel / HUD extras (lastIssueLine()). */
  static backgroundRunner(): BackgroundRunner {
    if (AppContainer.bgImpl === undefined) {
      AppContainer.bgImpl = new BackgroundRunner(() => {
        if (AppContainer.remoteVoiceImpl !== undefined) {
          AppContainer.remoteVoiceImpl.stopNow();
        } else if (AppContainer.speechImpl !== undefined) {
          AppContainer.speechImpl.stopNow();
        }
      });
    }
    return AppContainer.bgImpl;
  }

  static mediaSession(): MediaSessionPort {
    return AppContainer.mediaSessionService();
  }

  /** Concrete MediaSessionService for the DevPanel extras (lastCommandLine()). */
  static mediaSessionService(): MediaSessionService {
    if (AppContainer.avsImpl === undefined) {
      AppContainer.avsImpl = new MediaSessionService();
    }
    return AppContainer.avsImpl;
  }

  /** Location Kit source (asks for the permission and the location switch on start()). */
  static realLocation(): RealLocationSource {
    if (AppContainer.realLocImpl === undefined) {
      AppContainer.realLocImpl = new RealLocationSource(AppContainer.permissions());
    }
    return AppContainer.realLocImpl;
  }

  /** SIMULATED Demo walk source (replays the active course's demo-walk.json). Undefined before init(). */
  static demoWalk(): DemoWalkSource | undefined {
    if (AppContainer.demoImpl === undefined && AppContainer.ctx !== undefined) {
      AppContainer.demoImpl = new DemoWalkSource(() => AppContainer.demoTrackText());
    }
    return AppContainer.demoImpl;
  }

  /** The active course's SIMULATED Demo walk track (its pack's demo-walk.json), undefined when it has none. */
  private static async demoTrackText(): Promise<DemoTrackText | undefined> {
    const active = AppContainer.activePack();
    if (active === undefined || !active.hasDemoTrack()) {
      return undefined;
    }
    const text = await active.demoTrack();
    if (text === undefined) {
      return undefined;
    }
    const t = new DemoTrackText();
    t.key = `${active.activeId()}#${text.length}`;   // another course (or another track) restarts the walk
    t.text = text;
    return t;
  }

  /** 'en' | 'pl' | 'zh': the language the app's strings resolve to (app preferred language, else the system's). */
  static uiLangCode(): string {
    return uiCode();
  }

  /**
   * The active course's city in the UI language: its city pack's city.json names, else the catalog display name
   * (CourseSummary.city) of an older self-contained course, else '' (no course). Strings put it in a nominative slot.
   */
  static cityName(): string {
    try {
      const repo = AppContainer.courses();
      const id = repo.activeId();
      if (id === '') {
        return '';
      }
      const inst = repo.installed().find((c: InstalledCourse) => c.id === id);
      return cityDisplayName(AppContainer.activeCity(), AppContainer.uiLangCode(),
        inst !== undefined ? inst.summary.city : '');
    } catch (e) {
      return '';
    }
  }

  /** The ActivePackRepository the courses drive (undefined before courses() was first built). */
  static activePack(): ActivePackRepository | undefined {
    return AppContainer.activePackImpl;
  }

  /** city.json of the active course's city (names, projection origin, bbox, default map bounds); undefined: none. */
  static activeCity(): CityInfo | undefined {
    try {
      const a = AppContainer.activePack();
      return a !== undefined ? a.cityInfo() : undefined;
    } catch (e) {
      return undefined;
    }
  }
}
