/*
 * Onboarding view model (task A12, DESIGN §2.3 Flow A, §3.1). Three button-driven steps; every step can be
 * skipped and nothing blocks. Decisions about what each row shows live in the pure core/onboarding/OnboardingRules.
 *
 * Step 2 reads the real voice status: VoiceManager.capabilities() (listVoices) + the voice strategy, through the same
 * resolveVoicePlan the tour uses. Download tries Laura with VoiceManager.downloadEnglish (downloadVoice); on the
 * emulator that fails with 1002300008 and the row keeps saying "Fallback voice" (PLAN §0.4). Play a sample speaks
 * one Phrases line through the real SpeechPort in the chosen language (Polish: text only, shown as a caption).
 * Step 3 asks in context: Location -> PermissionPort.requestLocation (the system permission dialog), then the
 * location services check when they are off; after a denial the app's Settings page. Notifications -> A8's
 * NotifierPort.requestEnable(); the row reads expo-notifications getPermissionsAsync (on HarmonyOS
 * notificationManager.isNotificationEnabled). After a refusal the row says "Notifications are off" and never nags
 * (DESIGN Flow D).
 *
 * Persistence: UserSettings (contracts/Settings) through connect('settings', ...) from platform/Persist (the port of
 * PersistenceV2.connect(UserSettings, 'settings', ...), the key the contract names for B9). onboardingDone = true
 * after Done, Skip or Set up later, so the second launch goes straight to Home.
 */
import * as Notifications from 'expo-notifications';
import { proxy } from 'valtio';
import { connect } from '../platform/Persist';
import { Lang, NarrationLength } from '@citytour/core';
import { PermissionPort, PermissionState, SpeechCapabilities, SpeechListener, Utterance, VoiceState } from '@citytour/core';
import { UserSettings } from '@citytour/core';
import { AppContainer } from '@/main/AppContainer';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';
import { phrase, PhraseKey } from '@citytour/core';
import {
  canDownloadEnglish, choiceFor, clampStep, EnVoiceInput, EnVoiceRow, enVoiceRow, LocRow, locationRow, nextStep,
  NotifRow, notifRow, ONB_STEP_PERMS, ONB_STEP_VOICE, percent,
  selectedRow, voiceLangForPlan, zhSpoken
} from '@citytour/core';
import { stripPauseMarkup } from '@citytour/core';
import { PreviewPoint } from '../views/common/RoutePreview';
import { AppViewModel } from './AppViewModel';
import { withTimeout } from './Async';
import { findTour, previewPoints } from './PackView';

/** The persistence key the UserSettings contract names (contracts/Settings.ets). */
export const SETTINGS_KEY: string = 'settings';

const VOICES_TIMEOUT_MS: number = 8000;
const DOWNLOAD_TIMEOUT_MS: number = 120000;
/** No start/progress event for this long (e.g. the system dialog was cancelled): show the failure. */
const DOWNLOAD_STALL_MS: number = 30000;
/** System dialogs and sheets wait for the user; after this the row re-reads the real state. */
const DIALOG_TIMEOUT_MS: number = 120000;
const NOTIF_QUERY_TIMEOUT_MS: number = 5000;
/** A sample that never reports done (engine hung) frees the button after this. */
const SAMPLE_GUARD_MS: number = 20000;

/** Forwards SpeechPort callbacks for the one sample utterance to the view model. */
class SampleListener implements SpeechListener {
  private readonly id: string;
  private readonly onEnd: (id: string, ok: boolean) => void;

  constructor(id: string, onEnd: (id: string, ok: boolean) => void) {
    this.id = id;
    this.onEnd = onEnd;
  }

  onUtteranceStart(id: string): void {
    // the caption is already showing
  }

  onUtteranceDone(id: string): void {
    if (id === this.id) {
      this.onEnd(id, true);
    }
  }

  onUtteranceError(id: string, code: number): void {
    if (id === this.id) {
      Log.w(LogEvents.TTS_ERR, `where=onboarding_sample id=${id} code=${code}`);
      this.onEnd(id, false);
    }
  }
}

export class OnboardingViewModel {
  private static settingsInst: UserSettings | undefined = undefined;

  /** UserSettings persisted (platform/Persist connect, one instance per key). An in-memory copy if storage fails. */
  static settings(): UserSettings {
    if (OnboardingViewModel.settingsInst === undefined) {
      let s: UserSettings | undefined = undefined;
      try {
        s = connect(SETTINGS_KEY, () => new UserSettings());   // Persist logs its own storage errors
      } catch (e) {
        Log.e(LogEvents.UNCAUGHT, `where=OnboardingViewModel.settings ${Log.errKv(e as Object)}`);
      }
      if (s === undefined) {
        Log.w(LogEvents.SETTINGS, 'store=memory reason=persistence_unavailable');
        s = proxy(new UserSettings());
      }
      OnboardingViewModel.settingsInst = s;
      Log.i(LogEvents.SETTINGS, `store=persist key=${SETTINGS_KEY} onboardingDone=${s.onboardingDone}` +
        ` textLang=${s.textLang} voiceLang=${s.voiceLang}`);
    }
    return OnboardingViewModel.settingsInst;
  }

  /** On app start: the saved narration language drives the text language and the voice plan. */
  static restoreNarration(app: AppViewModel): void {
    try {
      const s = OnboardingViewModel.settings();
      const lang = selectedRow(s.textLang);
      app.textLang = lang;
      AppContainer.voiceManager().setVoiceLang(voiceLangForPlan(lang, s.voiceLang));
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=OnboardingViewModel.restoreNarration ${Log.errKv(e as Object)}`);
    }
  }

  step: number = 0;
  selected: Lang = Lang.EN;
  capsKnown: boolean = false;
  caps: SpeechCapabilities = { en: VoiceState.ERROR, zh: VoiceState.ERROR };
  downloading: boolean = false;
  downloadPct: number = 0;
  downloadFailed: boolean = false;
  sampleText: string = '';
  samplePlaying: boolean = false;
  loc: LocRow = LocRow.ASK;
  locBusy: boolean = false;
  notif: NotifRow = NotifRow.ASK;
  notifBusy: boolean = false;
  preview: PreviewPoint[] = [];
  clipsChecked: boolean = false;   // A13: the clip manifest has been read (rows can say "Studio voice")
  /** Opened from Settings (a NavDestination) instead of as the first-run root. */
  asRoute: boolean = false;
  private notifRefused: boolean = false;
  private speechReady: boolean = false;
  private sampleSeq: number = 0;
  private sampleId: string = '';
  private sampleGuard: ReturnType<typeof setTimeout> | undefined = undefined;
  private finished: boolean = false;
  private choiceApplied: boolean = false;

  start(asRoute: boolean): void {
    this.asRoute = asRoute;
    this.selected = selectedRow(OnboardingViewModel.settings().textLang);
    Log.i(LogEvents.APP_PAGE, `page=Onboarding step=1 asRoute=${asRoute} lang=${this.selected}`);
    this.refreshVoices();
    this.refreshPermissions();
  }

  stop(): void {
    this.stopSample();
  }

  /** Step 1 visual: the tour stops of the active course (empty on first run: no course is downloaded yet). */
  refreshPreview(): void {
    try {
      const pack = AppContainer.packRepository();
      const tour = findTour(pack, '');
      this.preview = tour === undefined ? [] : previewPoints(pack, tour.stops.map((s) => s.poiId));
    } catch (e) {
      this.preview = [];
    }
  }

  // ---------- navigation ----------

  next(): void {
    const n = nextStep(this.step);
    if (n < 0) {
      this.finish('done');
      return;
    }
    this.goTo(n);
  }

  goTo(step: number): void {
    const s = clampStep(step);
    if (this.step === ONB_STEP_VOICE && s !== ONB_STEP_VOICE) {
      this.stopSample();
    }
    this.step = s;
    Log.i(LogEvents.APP_PAGE, `page=Onboarding step=${s + 1}`);
    if (s === ONB_STEP_PERMS) {
      this.refreshPermissions();
    }
  }

  /** Done, Skip or Set up later: never asked again on this install (Settings can reopen it). */
  finish(how: string): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.stopSample();
    try {
      OnboardingViewModel.settings().onboardingDone = true;
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=OnboardingViewModel.finish ${Log.errKv(e as Object)}`);
    }
    Log.i(LogEvents.SETTINGS, `key=onboardingDone value=true how=${how} step=${this.step + 1} lang=${this.selected}` +
      ` loc=${this.loc} notif=${this.notif}`);
    if (this.asRoute) {
      AppViewModel.get().back();
    }
  }

  // ---------- step 2: language and voice ----------

  select(lang: Lang): void {
    if (lang === this.selected && this.choiceApplied) {
      return;   // the row tap and the Radio's onChange both report the same choice
    }
    this.choiceApplied = true;
    if (lang !== this.selected) {
      this.stopSample();
    }
    this.selected = lang;
    const c = choiceFor(lang);
    try {
      const s = OnboardingViewModel.settings();
      s.textLang = c.textLang;
      s.voiceLang = c.voiceLang;
      AppViewModel.get().textLang = c.textLang;
      AppContainer.voiceManager().setVoiceLang(voiceLangForPlan(c.textLang, c.voiceLang));
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=OnboardingViewModel.select ${Log.errKv(e as Object)}`);
    }
    Log.i(LogEvents.SETTINGS, `key=narration textLang=${c.textLang} voiceLang=${c.voiceLang} where=onboarding`);
  }

  enRow(): EnVoiceRow {
    return enVoiceRow(this.enInput());
  }

  canDownload(): boolean {
    return canDownloadEnglish(this.enInput());
  }

  zhSpoken(): boolean {
    return zhSpoken(this.capsKnown, this.caps);
  }

  /** A13: stories in this language play the pre-rendered studio voice (ElevenLabs clips ship in the app). */
  studio(lang: Lang): boolean {
    if (!this.clipsChecked) {
      return false;
    }
    try {
      return AppContainer.voiceManager().hasClips(lang);
    } catch (e) {
      return false;
    }
  }

  async refreshVoices(): Promise<void> {
    const vm = AppContainer.voiceManager();
    await withTimeout(AppContainer.narration().loadClipManifest(), VOICES_TIMEOUT_MS, undefined, 'onboarding.clips');
    this.clipsChecked = true;
    const c = await withTimeout(vm.capabilities(), VOICES_TIMEOUT_MS, vm.lastCaps(), 'onboarding.listVoices');
    this.caps = c;
    this.capsKnown = true;
    Log.i(LogEvents.VOICE_STATUS, `where=onboarding en=${c.en} zh=${c.zh} row=${this.enRow()}`);
  }

  /**
   * Tries Laura (en-US/8). Never throws; on failure the English row keeps the Fallback voice.
   * The system shows its own "Download language package?" dialog first. On the Pura 90 emulator its Cancel delivers
   * no callback at all (the kit's own timeout is 5 min), so the row gives up after DOWNLOAD_STALL_MS without any
   * progress event and says so honestly. A late success still flips the row to Laura.
   */
  async download(): Promise<void> {
    if (this.downloading) {
      return;
    }
    this.downloading = true;
    this.downloadPct = 0;
    this.downloadFailed = false;
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
          Log.w(LogEvents.VOICE_DL_FAIL, `where=onboarding code=stalled ms=${DOWNLOAD_STALL_MS} pct=${this.downloadPct}`);
          resolve(false);
        }
      }, 1000);
    });
    const ok = await withTimeout(Promise.race([real, stalled]), DOWNLOAD_TIMEOUT_MS, false, 'onboarding.downloadVoice');
    clearInterval(stallTimer);
    this.caps = vm.lastCaps();
    this.downloading = false;
    this.downloadFailed = !ok;
    Log.i(LogEvents.VOICE_STATUS, `where=onboarding event=download ok=${ok} code=${vm.lastDownloadCode()}` +
      ` row=${this.enRow()}`);
    if (!ok) {
      real.then((late: boolean) => {
        if (late) {
          this.caps = vm.lastCaps();
          this.downloadFailed = false;
          Log.i(LogEvents.VOICE_STATUS, `where=onboarding event=download_late_ok row=${this.enRow()}`);
        }
      }).catch(() => {});
    }
  }

  /** A tour owns the speech listener while it runs, so the sample is offered only when no tour is running. */
  sampleAllowed(): boolean {
    try {
      return !AppContainer.tourController().isRunning();
    } catch (e) {
      return false;
    }
  }

  /** Speaks one line in the chosen language (Polish: shown as text for a reading time, no audio). */
  async playSample(): Promise<void> {
    if (!this.sampleAllowed()) {
      return;
    }
    this.stopSample();
    const lang = this.selected;
    const text = this.studio(lang) ? this.storySample(lang) : phrase(PhraseKey.WELCOME_HINT, lang, {});
    this.sampleSeq++;
    const id = `onb-sample-${this.sampleSeq}`;
    this.sampleId = id;
    this.sampleText = stripPauseMarkup(text);
    this.samplePlaying = true;
    try {
      const speech = AppContainer.speech();
      if (!this.speechReady) {
        const vm = AppContainer.voiceManager();
        const c = await withTimeout(speech.init(), VOICES_TIMEOUT_MS, vm.lastCaps(), 'onboarding.speechInit');
        this.speechReady = true;
        this.caps = c;
        this.capsKnown = true;
      }
      if (this.sampleId !== id) {
        return;   // stopped or replaced while the engine warmed up
      }
      speech.setListener(new SampleListener(id, (doneId: string, ok: boolean) => this.onSampleEnd(doneId, ok)));
      const u: Utterance = { id: id, itemId: 'onboarding-sample', text: text, lang: lang, personaId: 'historian' };
      const plan = AppContainer.voiceManager().plan(lang);
      Log.i(LogEvents.STORY_QUEUE, `event=onboarding_sample id=${id} lang=${lang} label=${plan.label}`);
      speech.speak(u);
      this.sampleGuard = setTimeout(() => this.onSampleEnd(id, false), SAMPLE_GUARD_MS);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=OnboardingViewModel.playSample ${Log.errKv(e as Object)}`);
      this.onSampleEnd(id, false);
    }
  }

  /** A13: with studio clips the sample is the first story sentence (it has a clip), so Polish is heard too. */
  private storySample(lang: Lang): string {
    try {
      const pack = AppContainer.packRepository();
      const tour = findTour(pack, '');
      if (tour !== undefined && tour.stops.length > 0) {
        const n = pack.narration(tour.stops[0].poiId, tour.personaId, lang, NarrationLength.TEASER);
        if (n !== undefined && n.sentences.length > 0) {
          return n.sentences[0];
        }
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=OnboardingViewModel.storySample ${Log.errKv(e as Object)}`);
    }
    return phrase(PhraseKey.WELCOME_HINT, lang, {});
  }

  stopSample(): void {
    if (!this.samplePlaying) {
      return;
    }
    this.sampleId = '';
    this.samplePlaying = false;
    this.clearGuard();
    try {
      AppContainer.speech().stopNow();
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=OnboardingViewModel.stopSample ${Log.errKv(e as Object)}`);
    }
  }

  private onSampleEnd(id: string, ok: boolean): void {
    if (id !== this.sampleId) {
      return;
    }
    this.clearGuard();
    this.sampleId = '';
    this.samplePlaying = false;
    Log.i(LogEvents.STORY_QUEUE, `event=onboarding_sample_end id=${id} ok=${ok}`);
  }

  private clearGuard(): void {
    if (this.sampleGuard !== undefined) {
      clearTimeout(this.sampleGuard);
      this.sampleGuard = undefined;
    }
  }

  private enInput(): EnVoiceInput {
    const i: EnVoiceInput = {
      capsKnown: this.capsKnown,
      caps: this.caps,
      strategy: AppContainer.voiceManager().strategy(),
      downloading: this.downloading,
      downloadFailed: this.downloadFailed
    };
    return i;
  }

  // ---------- step 3: permissions ----------

  refreshPermissions(): void {
    this.refreshLocation();
    this.refreshNotifications();
  }

  async refreshLocation(): Promise<void> {
    const p: PermissionPort = AppContainer.permissions();
    const st = await withTimeout(p.locationState(), VOICES_TIMEOUT_MS, PermissionState.UNKNOWN, 'onboarding.locState');
    let on = false;
    try {
      on = p.isLocationSwitchOn();
    } catch (e) {
      on = false;
    }
    this.loc = locationRow(st, on);
  }

  /**
   * One button, which opens the system UI directly (HIG privacy): the permission dialog, then the location switch
   * sheet if the phone's switch is off. After a denial or approximate-only grant, the settings sheet.
   */
  async allowLocation(): Promise<void> {
    if (this.locBusy) {
      return;
    }
    this.locBusy = true;
    const p: PermissionPort = AppContainer.permissions();
    const before = this.loc;
    try {
      let st: PermissionState = PermissionState.UNKNOWN;
      if (before === LocRow.ASK) {
        st = await withTimeout(p.requestLocation(), DIALOG_TIMEOUT_MS, PermissionState.UNKNOWN,
          'onboarding.requestLocation');
      } else if (before === LocRow.DENIED || before === LocRow.APPROX) {
        st = await withTimeout(p.openLocationSettings(), DIALOG_TIMEOUT_MS, PermissionState.UNKNOWN,
          'onboarding.openLocationSettings');
      } else {
        st = await withTimeout(p.locationState(), VOICES_TIMEOUT_MS, PermissionState.UNKNOWN, 'onboarding.locState');
      }
      if ((st === PermissionState.GRANTED || st === PermissionState.APPROX_ONLY) && !p.isLocationSwitchOn()) {
        await withTimeout(p.requestLocationSwitch(), DIALOG_TIMEOUT_MS, false, 'onboarding.locationSwitch');
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=OnboardingViewModel.allowLocation ${Log.errKv(e as Object)}`);
    }
    await this.refreshLocation();
    this.locBusy = false;
    Log.i(LogEvents.SETTINGS, `key=onboarding_location from=${before} to=${this.loc}`);
  }

  async refreshNotifications(): Promise<void> {
    const enabled = await withTimeout(this.notifEnabled(), NOTIF_QUERY_TIMEOUT_MS, false, 'onboarding.notifEnabled');
    this.notif = notifRow(enabled, this.notifRefused);
  }

  /**
   * Through A8's NotifierPort.requestEnable() (isNotificationEnabled -> requestEnableNotification(ctx)), so the
   * tour's notifier shares the answer and asks nothing at tour start. false = refused (1600004) or unavailable.
   */
  async allowNotifications(): Promise<void> {
    if (this.notifBusy || this.notif !== NotifRow.ASK) {
      return;
    }
    if (AppContainer.context() === undefined) {
      Log.w(LogEvents.NOTIF_DENIED, 'where=onboarding reason=no_context');
      return;
    }
    this.notifBusy = true;
    let granted = false;
    try {
      granted = await withTimeout(AppContainer.notifier().requestEnable(), DIALOG_TIMEOUT_MS, false,
        'onboarding.requestEnableNotification');
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=onboarding.requestEnableNotification ${Log.errKv(e as Object)}`);
    }
    this.notifRefused = !granted;
    await this.refreshNotifications();
    this.notifBusy = false;
    Log.i(LogEvents.SETTINGS, `key=onboarding_notifications granted=${granted} row=${this.notif}`);
  }

  /** expo-notifications getPermissionsAsync (the iOS port of notificationManager.isNotificationEnabled). */
  private notifEnabled(): Promise<boolean> {
    try {
      return Notifications.getPermissionsAsync().then((p: Notifications.NotificationPermissionsStatus) => p.granted ||
        p.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=onboarding.isNotificationEnabled ${Log.errKv(e as Object)}`);
      return Promise.resolve(false);
    }
  }
}
