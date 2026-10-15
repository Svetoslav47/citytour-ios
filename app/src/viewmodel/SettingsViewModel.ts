/*
 * Settings view model (task B9, docs/DESIGN.md §3.11, docs/PLAN.md card B9). One instance (SettingsViewModel.get())
 * shared by the Settings page and its sub-pages. The pure decisions live in core/settings/SettingsRules.
 *
 * Persistence: UserSettings (contracts/Settings) through platform/Persist connect() under the key 'settings' (the
 * instance A12's OnboardingViewModel.settings() connects, so both screens edit the same object). Two rows the contract
 * has no field for (detail level, vibrate on arrival) persist in SettingsExtras under 'settingsExtras' (no contract
 * change). On HarmonyOS this was PersistenceV2.
 *
 * What each row really drives (applyAll() on app start, apply*() on every change; each change logs
 * `SETTINGS key=... lang=... voice=... source=...`):
 * - Demo walk + replay speed -> TourControl.setSource(DEMO|REAL) and setDemoSpeed; TourPlanViewModel.startTour reads
 *   useDemoWalk, so the next tour started from Home logs LOC_SOURCE kind=demo (or kind=real through the location gate).
 * - Story language -> AppViewModel.textLang, VoiceManager.setVoiceLang, TourOptions.lang (narration language).
 * - Voice strategy -> VoiceManager.setStrategy, then VoiceManager.plan(textLang) logs VOICE_PLAN with the new label.
 * - Laura download -> VoiceManager.downloadEnglish (downloadVoice). The system dialog's Cancel sends no callback on
 *   the emulator (issue #24 comment), so after 30 s without a progress event the row gives up honestly, as A12's
 *   onboarding does, and VoiceManager.abandonDownload frees the busy flag for "Try again".
 * - Detail level / spoken directions / trigger distance -> TourController.setOptions (applied at the next plan()).
 * - Vibrate on arrival -> Haptics.setEnabled.
 * - App language -> platform/strings setAppLanguage (the UI re-renders in the new language at once; on HarmonyOS
 *   i18n.System.setAppPreferredLanguage). SYSTEM follows the system language (English when it is unsupported).
 * - Permissions: the same PermissionPort / NotifierPort calls as onboarding; the notifications status reads
 *   expo-notifications getPermissionsAsync.
 * Every platform call goes through withTimeout or try/catch: Settings never crashes and never hangs.
 */
import * as Notifications from 'expo-notifications';
import { proxy } from 'valtio';
import { connect } from '../platform/Persist';
import { setAppLanguage } from '../platform/strings';
import { Lang, Tour } from '@citytour/core';
import {
  FixSource, PackLoadResult, PermissionPort, PermissionState, SpeechCapabilities, VoicePlan, VoiceState
} from '@citytour/core';
import { EnVoiceStrategy, UiLang, UserSettings, VoiceLabel } from '@citytour/core';
import { AppConfig } from '@/main/AppConfig';
import { AppContainer } from '@/main/AppContainer';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';
import { LocRow, locationRow, NotifRow, notifRow, percent, voiceLangForPlan } from '@citytour/core';
import {
  DetailLevel, detailKnobs, detailLevelOf, normalizeSpeed, normalizeTriggerM, PackLine, packLine, StoryLang,
  storyLangOf, storyLangPair, StrategyChoice, strategyChoiceOf, strategyFor, triggerScale, uiLangOf, uiLangTag,
  validStrategy, VoiceRow, voiceRowFor
} from '@citytour/core';
import { TourConfig } from '@citytour/core';
import { Haptics } from '../services/haptics/Haptics';
import { TourController, TourOptions } from '@citytour/core';
import { AppViewModel } from './AppViewModel';
import { withTimeout } from './Async';
import { OnboardingViewModel } from './OnboardingViewModel';
import { findTour, personaName } from './PackView';

/** Settings rows the UserSettings contract has no field for (persisted beside it, no contract change). */
export class SettingsExtras {
  detailLevel: string = DetailLevel.STANDARD;
  vibrateOnArrival: boolean = true;
}

export const SETTINGS_EXTRAS_KEY: string = 'settingsExtras';

const QUERY_TIMEOUT_MS: number = 8000;
const CONTROL_TIMEOUT_MS: number = 8000;
const DIALOG_TIMEOUT_MS: number = 120000;
const DOWNLOAD_TIMEOUT_MS: number = 120000;
/** No start/progress event for this long (the system dialog was cancelled, issue #24): show the failure. */
export const DOWNLOAD_STALL_MS: number = 30000;

export enum DownloadState { IDLE = 'idle', DOWNLOADING = 'downloading', FAILED = 'failed', DONE = 'done' }

export class SettingsViewModel {
  private static inst: SettingsViewModel | undefined = undefined;
  private static extrasInst: SettingsExtras | undefined = undefined;

  static get(): SettingsViewModel {
    if (SettingsViewModel.inst === undefined) {
      SettingsViewModel.inst = proxy(new SettingsViewModel());
    }
    return SettingsViewModel.inst;
  }

  /** The persisted UserSettings (same instance as onboarding and Index). */
  static settings(): UserSettings {
    return OnboardingViewModel.settings();
  }

  static extras(): SettingsExtras {
    if (SettingsViewModel.extrasInst === undefined) {
      let x: SettingsExtras | undefined = undefined;
      try {
        x = connect(SETTINGS_EXTRAS_KEY, () => new SettingsExtras());
      } catch (e) {
        Log.e(LogEvents.UNCAUGHT, `where=SettingsViewModel.extras ${Log.errKv(e as Object)}`);
      }
      if (x === undefined) {
        Log.w(LogEvents.SETTINGS, `store=memory key=${SETTINGS_EXTRAS_KEY} reason=persistence_unavailable`);
        x = proxy(new SettingsExtras());
      }
      SettingsViewModel.extrasInst = x;
    }
    return SettingsViewModel.extrasInst;
  }

  /** App start (Index.aboutToAppear): push every persisted setting into the services. Never throws. */
  static applyAll(app: AppViewModel): void {
    const s = SettingsViewModel.settings();
    try {
      OnboardingViewModel.restoreNarration(app);   // textLang + voiceLang (A12)
      AppContainer.voiceManager().setStrategy(validStrategy(s.enVoiceStrategy, AppConfig.DEFAULT_EN_VOICE_STRATEGY));
      SettingsViewModel.applyUiLang(s.uiLang, app, false);
      SettingsViewModel.applyHaptics();
      SettingsViewModel.applyToTour();
      SettingsViewModel.applySource('start');
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SettingsViewModel.applyAll ${Log.errKv(e as Object)}`);
    }
    Log.i(LogEvents.SETTINGS, `event=restore ${SettingsViewModel.summaryKv()} detail=${SettingsViewModel.extras().detailLevel}` +
      ` triggerM=${s.triggerDistanceM} directions=${s.spokenDirections} uiLang=${s.uiLang}` +
      ` strategy=${s.enVoiceStrategy}`);
  }

  /** TourOptions from the settings; the controller applies them at its next plan(). */
  static applyToTour(): void {
    try {
      const s = SettingsViewModel.settings();
      const knobs = detailKnobs(detailLevelOf(SettingsViewModel.extras().detailLevel));
      const ctrl: TourController = AppContainer.tourController();
      const o = new TourOptions();
      o.lang = storyLangPair(storyLangOf(s.textLang, s.voiceLang)).textLang;
      o.adaptiveLength = knobs.adaptiveLength;
      o.briefOnly = knobs.briefOnly;
      o.spokenDirections = s.spokenDirections;
      o.demoSpeed = normalizeSpeed(s.demoSpeed);
      const cfg = new TourConfig();
      cfg.triggerRadiusScale = triggerScale(s.triggerDistanceM);
      o.config = cfg;
      ctrl.setOptions(o);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SettingsViewModel.applyToTour ${Log.errKv(e as Object)}`);
    }
  }

  /**
   * The location source the next tour uses. Called on app start, on a toggle and by TourPlanViewModel.startTour.
   * A running tour keeps its source (the change applies to the next start). Resolves true when applied.
   */
  static async applySource(where: string): Promise<boolean> {
    const s = SettingsViewModel.settings();
    try {
      const ctrl = AppContainer.tourController();
      if (ctrl.isRunning() && where !== 'startTour') {
        Log.i(LogEvents.SETTINGS, `key=useDemoWalk value=${s.useDemoWalk} applied=next_start reason=tour_running`);
        return false;
      }
      const kind = s.useDemoWalk ? FixSource.DEMO : FixSource.REAL;
      const ok = await withTimeout(ctrl.setSource(kind).then((): boolean => true), CONTROL_TIMEOUT_MS, false,
        `settings.setSource.${kind}`);
      if (s.useDemoWalk) {
        const speed = normalizeSpeed(s.demoSpeed);
        ctrl.setDemoSpeed(speed);
        AppViewModel.get().demoSpeed = speed;
      }
      return ok;
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SettingsViewModel.applySource ${Log.errKv(e as Object)}`);
      return false;
    }
  }

  static applyHaptics(): void {
    try {
      const h = AppContainer.haptics();
      if (h instanceof Haptics) {
        h.setEnabled(SettingsViewModel.extras().vibrateOnArrival);
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SettingsViewModel.applyHaptics ${Log.errKv(e as Object)}`);
    }
  }

  /**
   * A chosen language now; SYSTEM clears the preference and keeps the unsupported-language pin. On iOS the
   * language lives in platform/strings (not persisted by the platform), so it is set on app start too and SYSTEM
   * takes effect at once (HarmonyOS 'default' needed a restart). `fromUser` is kept for parity.
   */
  static applyUiLang(u: string, app: AppViewModel, fromUser: boolean): void {
    const lang = uiLangOf(u);
    try {
      if (lang === UiLang.SYSTEM) {
        setAppLanguage('');
        app.applySupportedUiLanguage();
      } else {
        setAppLanguage(lang === UiLang.PL ? 'pl' : lang === UiLang.ZH ? 'zh' : 'en');
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SettingsViewModel.applyUiLang lang=${lang} ${Log.errKv(e as Object)}`);
    }
    app.cityName = AppContainer.cityName();   // the city's name in the new UI language
  }

  /** `lang=en voice=fallback-zh source=demo speed=4` for every SETTINGS line. */
  static summaryKv(): string {
    const s = SettingsViewModel.settings();
    let label = '';
    try {
      label = AppContainer.voiceManager().storyPlan(storyLangPair(storyLangOf(s.textLang, s.voiceLang)).textLang).label;
    } catch (e) {
      label = 'unknown';
    }
    return `lang=${s.textLang} voiceLang=${s.voiceLang} voice=${label} source=${s.useDemoWalk ? 'demo' : 'real'}` +
      ` speed=${normalizeSpeed(s.demoSpeed)}`;
  }

  // ================================================================ page state

  settings: UserSettings = SettingsViewModel.settings();
  extras: SettingsExtras = SettingsViewModel.extras();
  voiceRow: VoiceRow = VoiceRow.FALLBACK;
  capsKnown: boolean = false;
  caps: SpeechCapabilities = { en: VoiceState.ERROR, zh: VoiceState.ERROR };
  download: DownloadState = DownloadState.IDLE;
  downloadPct: number = 0;
  loc: LocRow = LocRow.ASK;
  locBusy: boolean = false;
  notif: NotifRow = NotifRow.ASK;
  notifBusy: boolean = false;
  packKnown: boolean = false;
  packOk: boolean = true;
  /** A course is installed (the app ships none; false until the first download). */
  hasCourse: boolean = true;
  /** The SIMULATED Demo walk is offered for a course whose pack ships a demo track (CourseRules.demoWalkOffered). */
  demoOffered: boolean = false;
  pack: PackLine = packLine(0, 0, []);
  guideName: string = '';
  tourRunning: boolean = false;
  private notifRefused: boolean = false;

  /** Settings page appeared: read the live state (voices, permissions, pack). */
  refresh(): void {
    try {
      this.tourRunning = AppContainer.tourController().isRunning();
    } catch (e) {
      this.tourRunning = false;
    }
    this.refreshVoice();
    this.refreshPermissions();
    this.refreshPack();
  }

  /** A13: Polish stories are spoken by the pre-rendered studio clips. */
  plSpoken(): boolean {
    try {
      // iOS: course clips or the server's studio voice (no system voice).
      return AppContainer.voiceManager().hasClips(Lang.PL) || AppContainer.remoteVoice().studioVoiceOffered(Lang.PL);
    } catch (e) {
      return false;
    }
  }

  storyLang(): StoryLang {
    return storyLangOf(this.settings.textLang, this.settings.voiceLang);
  }

  strategyChoice(): StrategyChoice {
    return strategyChoiceOf(this.settings.enVoiceStrategy);
  }

  detailLevel(): DetailLevel {
    return detailLevelOf(this.extras.detailLevel);
  }

  uiLang(): UiLang {
    return uiLangOf(this.settings.uiLang);
  }

  triggerM(): number {
    return normalizeTriggerM(this.settings.triggerDistanceM);
  }

  demoSpeed(): number {
    return normalizeSpeed(this.settings.demoSpeed);
  }

  // ---------- Narration ----------

  setStoryLang(l: StoryLang): void {
    if (l === this.storyLang()) {
      return;
    }
    const p = storyLangPair(l);
    try {
      this.settings.textLang = p.textLang;
      this.settings.voiceLang = p.voiceLang;
      AppViewModel.get().textLang = p.textLang;
      AppContainer.voiceManager().setVoiceLang(voiceLangForPlan(p.textLang, p.voiceLang));
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SettingsViewModel.setStoryLang ${Log.errKv(e as Object)}`);
    }
    SettingsViewModel.applyToTour();
    try {
      AppContainer.tourControl().setStoryLang(p.textLang);   // X2: a running tour switches at the next sentence
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SettingsViewModel.setStoryLang.live ${Log.errKv(e as Object)}`);
    }
    this.updateVoiceRow();
    this.logChange('storyLang', l);
  }

  setUiLang(u: UiLang): void {
    if (u === this.uiLang()) {
      return;
    }
    this.settings.uiLang = u;
    SettingsViewModel.applyUiLang(u, AppViewModel.get(), true);
    this.logChange('uiLang', `${u} tag=${uiLangTag(u)}`);
  }

  setStrategy(c: StrategyChoice): void {
    const s: EnVoiceStrategy = strategyFor(c);
    if (s === this.settings.enVoiceStrategy) {
      return;
    }
    this.settings.enVoiceStrategy = s;
    try {
      AppContainer.voiceManager().setStrategy(s);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SettingsViewModel.setStrategy ${Log.errKv(e as Object)}`);
    }
    this.updateVoiceRow();     // logs VOICE_PLAN with the new label
    this.logChange('enVoiceStrategy', s);
  }

  setDetailLevel(d: DetailLevel): void {
    if (d === this.detailLevel()) {
      return;
    }
    this.extras.detailLevel = d;
    SettingsViewModel.applyToTour();
    const k = detailKnobs(d);
    this.logChange('detailLevel', `${d} adaptive=${k.adaptiveLength} brief=${k.briefOnly}`);
  }

  // ---------- Walking ----------

  setSpokenDirections(on: boolean): void {
    if (on === this.settings.spokenDirections) {
      return;
    }
    this.settings.spokenDirections = on;
    SettingsViewModel.applyToTour();
    this.logChange('spokenDirections', `${on}`);
  }

  setTriggerM(m: number): void {
    const v = normalizeTriggerM(m);
    if (v === this.triggerM()) {
      return;
    }
    this.settings.triggerDistanceM = v;
    SettingsViewModel.applyToTour();
    this.logChange('triggerDistanceM', `${v} scale=${triggerScale(v).toFixed(2)}`);
  }

  // ---------- Sound and haptics ----------

  setVibrate(on: boolean): void {
    if (on === this.extras.vibrateOnArrival) {
      return;
    }
    this.extras.vibrateOnArrival = on;
    SettingsViewModel.applyHaptics();
    this.logChange('vibrateOnArrival', `${on}`);
  }

  // ---------- Demo walk ----------

  async setDemoWalk(on: boolean): Promise<void> {
    if (on === this.settings.useDemoWalk) {
      return;
    }
    this.settings.useDemoWalk = on;
    this.logChange('useDemoWalk', `${on}`);
    await SettingsViewModel.applySource('settings');
  }

  setDemoSpeed(x: number): void {
    const v = normalizeSpeed(x);
    if (v === this.demoSpeed()) {
      return;
    }
    this.settings.demoSpeed = v;
    SettingsViewModel.applyToTour();
    try {
      const ctrl = AppContainer.tourController();
      if (this.settings.useDemoWalk || ctrl.sourceKindSelected() === FixSource.DEMO) {
        ctrl.setDemoSpeed(v);           // a running Demo walk follows at once
        AppViewModel.get().demoSpeed = v;
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SettingsViewModel.setDemoSpeed ${Log.errKv(e as Object)}`);
    }
    this.logChange('demoSpeed', `${v}`);
  }

  // ---------- Voice ----------

  async refreshVoice(): Promise<void> {
    const vm = AppContainer.voiceManager();
    const c = await withTimeout(vm.capabilities(), QUERY_TIMEOUT_MS, vm.lastCaps(), 'settings.listVoices');
    this.caps = c;
    this.capsKnown = true;
    if (this.download === DownloadState.IDLE && vm.isDownloading()) {
      this.download = DownloadState.DOWNLOADING;   // onboarding's attempt is still running
    }
    this.updateVoiceRow();
  }

  canDownload(): boolean {
    return this.capsKnown && this.download !== DownloadState.DOWNLOADING && this.caps.en === VoiceState.DOWNLOADABLE;
  }

  /**
   * Tries Laura (en-US/8) with progress. Never throws. On the emulator downloadVoice fails (1002300008) or, after
   * the system dialog's Cancel, never calls back: then the row gives up after DOWNLOAD_STALL_MS without progress.
   */
  async downloadEnglish(): Promise<void> {
    if (this.download === DownloadState.DOWNLOADING) {
      return;
    }
    this.download = DownloadState.DOWNLOADING;
    this.downloadPct = 0;
    const vm = AppContainer.voiceManager();
    let lastEventMs = Date.now();
    const real = vm.downloadEnglish((p: number) => {
      lastEventMs = Date.now();
      this.downloadPct = percent(p);
    });
    let stallTimer: ReturnType<typeof setInterval> | undefined = undefined;
    const stalled = new Promise<boolean>((resolve) => {
      stallTimer = setInterval(() => {
        if (Date.now() - lastEventMs >= DOWNLOAD_STALL_MS) {
          Log.w(LogEvents.VOICE_DL_FAIL, `where=settings code=stalled ms=${DOWNLOAD_STALL_MS} pct=${this.downloadPct}`);
          resolve(false);
        }
      }, 1000);
    });
    const ok = await withTimeout(Promise.race([real, stalled]), DOWNLOAD_TIMEOUT_MS, false, 'settings.downloadVoice');
    clearInterval(stallTimer);
    if (!ok) {
      vm.abandonDownload('settings_stall_or_fail');
    }
    this.caps = vm.lastCaps();
    this.download = ok ? DownloadState.DONE : DownloadState.FAILED;
    this.updateVoiceRow();
    Log.i(LogEvents.VOICE_STATUS, `where=settings event=download ok=${ok} code=${vm.lastDownloadCode()}` +
      ` row=${this.voiceRow}`);
    if (!ok) {
      real.then((late: boolean) => {
        if (late) {
          this.caps = vm.lastCaps();
          this.download = DownloadState.DONE;
          this.updateVoiceRow();
          Log.i(LogEvents.VOICE_STATUS, `where=settings event=download_late_ok row=${this.voiceRow}`);
        }
      }).catch(() => {});
    }
  }

  private updateVoiceRow(): void {
    try {
      const lang = storyLangPair(this.storyLang()).textLang;
      const p: VoicePlan = AppContainer.voiceManager().storyPlan(lang);   // logs VOICE_PLAN; A13 studio clips
      this.voiceRow = voiceRowFor(p.label, p.engineLocale);
    } catch (e) {
      this.voiceRow = voiceRowFor(VoiceLabel.TEXT_ONLY_PLATFORM, '');
      Log.e(LogEvents.UNCAUGHT, `where=SettingsViewModel.updateVoiceRow ${Log.errKv(e as Object)}`);
    }
  }

  // ---------- Offline data ----------

  async refreshPack(): Promise<void> {
    const pack = AppContainer.packRepository();
    const failed: PackLoadResult = { ok: false, issues: [] };
    const res = await withTimeout(pack.load(), QUERY_TIMEOUT_MS, failed, 'settings.pack.load');
    this.hasCourse = AppContainer.hasCourse();
    this.demoOffered = AppContainer.demoWalkOffered();
    this.packOk = res.ok;
    if (res.ok) {
      try {
        const tour: Tour | undefined = findTour(pack, '');
        const stories = tour === undefined ? 0 : tour.stops.length;
        const bytes = res.manifest === undefined ? [] : res.manifest.files.map((f) => f.bytes);
        this.pack = packLine(pack.pois().length, stories, bytes);
        this.guideName = tour === undefined ? '' : personaName(pack, tour.personaId, AppViewModel.get().textLang);
      } catch (e) {
        this.packOk = false;
        Log.e(LogEvents.UNCAUGHT, `where=SettingsViewModel.refreshPack ${Log.errKv(e as Object)}`);
      }
    }
    this.packKnown = true;
  }

  // ---------- Permissions ----------

  refreshPermissions(): void {
    this.refreshLocation();
    this.refreshNotifications();
  }

  async refreshLocation(): Promise<void> {
    const p: PermissionPort = AppContainer.permissions();
    const st = await withTimeout(p.locationState(), QUERY_TIMEOUT_MS, PermissionState.UNKNOWN, 'settings.locState');
    let on = false;
    try {
      on = p.isLocationSwitchOn();
    } catch (e) {
      on = false;
    }
    this.loc = locationRow(st, on);
  }

  /** Location row tap: the system dialog, the settings sheet after a denial, or the location switch sheet. */
  async onLocationRow(): Promise<void> {
    if (this.locBusy) {
      return;
    }
    this.locBusy = true;
    const before = this.loc;
    const p: PermissionPort = AppContainer.permissions();
    try {
      let st: PermissionState = PermissionState.UNKNOWN;
      if (before === LocRow.ASK) {
        st = await withTimeout(p.requestLocation(), DIALOG_TIMEOUT_MS, PermissionState.UNKNOWN, 'settings.requestLocation');
      } else if (before === LocRow.DENIED || before === LocRow.APPROX) {
        st = await withTimeout(p.openLocationSettings(), DIALOG_TIMEOUT_MS, PermissionState.UNKNOWN,
          'settings.openLocationSettings');
      } else {
        st = await withTimeout(p.locationState(), QUERY_TIMEOUT_MS, PermissionState.UNKNOWN, 'settings.locState');
      }
      if ((st === PermissionState.GRANTED || st === PermissionState.APPROX_ONLY) && !p.isLocationSwitchOn()) {
        await withTimeout(p.requestLocationSwitch(), DIALOG_TIMEOUT_MS, false, 'settings.locationSwitch');
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SettingsViewModel.onLocationRow ${Log.errKv(e as Object)}`);
    }
    await this.refreshLocation();
    this.locBusy = false;
    Log.i(LogEvents.SETTINGS, `key=location from=${before} to=${this.loc}`);
  }

  async refreshNotifications(): Promise<void> {
    const enabled = await withTimeout(this.notifEnabled(), QUERY_TIMEOUT_MS, false, 'settings.notifEnabled');
    this.notif = notifRow(enabled, this.notifRefused);
  }

  /** Notifications row tap: requestEnableNotification through A8's notifier (shares the answer with the tour). */
  async onNotificationsRow(): Promise<void> {
    if (this.notifBusy || this.notif === NotifRow.ALLOWED) {
      return;
    }
    if (AppContainer.context() === undefined) {
      Log.w(LogEvents.NOTIF_DENIED, 'where=settings reason=no_context');
      return;
    }
    this.notifBusy = true;
    let granted = false;
    try {
      granted = await withTimeout(AppContainer.notifier().requestEnable(), DIALOG_TIMEOUT_MS, false,
        'settings.requestEnableNotification');
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SettingsViewModel.onNotificationsRow ${Log.errKv(e as Object)}`);
    }
    this.notifRefused = !granted;
    await this.refreshNotifications();
    this.notifBusy = false;
    Log.i(LogEvents.SETTINGS, `key=notifications granted=${granted} row=${this.notif}`);
  }

  /** expo-notifications getPermissionsAsync (the iOS port of notificationManager.isNotificationEnabled). */
  private notifEnabled(): Promise<boolean> {
    try {
      return Notifications.getPermissionsAsync().then((p: Notifications.NotificationPermissionsStatus) => p.granted ||
        p.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=settings.isNotificationEnabled ${Log.errKv(e as Object)}`);
      return Promise.resolve(false);
    }
  }

  private logChange(key: string, value: string): void {
    Log.i(LogEvents.SETTINGS, `key=${key} value=${value} ${SettingsViewModel.summaryKv()}`);
  }
}
