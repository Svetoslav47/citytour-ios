/*
 * App-wide UI state (B4): the navigation stack, the active course's pack state (loading / no course / ready / error;
 * the app ships no built-in course, docs/SERVER.md §6), the text language and the tour-flow view model. One instance per app (AppViewModel.get()). Views talk to view models only; view models
 * reach services through AppContainer getters (ARCHITECTURE §1.2).
 * Navigation: Navigation + NavPathStack + navDestination builder (doc: ts-basic-components-navigation).
 */
import { getLocales } from 'expo-localization';
import { proxy, ref } from 'valtio';
import { AppIssue, IssueCode, IssueSeverity } from '@citytour/core';
import { Lang } from '@citytour/core';
import { PackLoadResult } from '@citytour/core';
import { AppConfig } from '../app/AppConfig';
import { AppContainer } from '../app/AppContainer';
import { Log } from '../app/Log';
import { LogEvents } from '@citytour/core';
import { HomeMode, homeMode } from '@citytour/core';
import { withTimeout } from './Async';
import { TourPlanViewModel } from './TourPlanViewModel';
import { NavPathInfo, NavPathStack } from '../platform/Nav';

export class Routes {
  static readonly TOUR_DETAIL: string = 'TourDetail';
  static readonly ROUTE_READY: string = 'RouteReady';
  static readonly NOW_WALKING: string = 'NowWalking';
  static readonly FULL_MAP: string = 'FullMap';
  static readonly PLACE_DETAIL: string = 'PlaceDetail';
  static readonly ABOUT_SOURCES: string = 'AboutSources';
  static readonly ONBOARDING: string = 'Onboarding';   // A12: first run is Index's root; Settings can reopen it here
  static readonly SETTINGS: string = 'Settings';                      // B9
  static readonly SETTINGS_STORY_LANG: string = 'SettingsStoryLanguage';
  static readonly SETTINGS_APP_LANG: string = 'SettingsAppLanguage';
  static readonly SETTINGS_VOICE: string = 'SettingsVoice';
  static readonly SUMMARY: string = 'Summary';                        // B11
  static readonly COURSES: string = 'Courses';                        // SERVER.md §6: downloadable courses
}

/** NO_COURSE: nothing downloaded yet (or the last course was deleted): Home shows "Download your first walk". */
export enum PackState { LOADING = 'loading', NO_COURSE = 'noCourse', READY = 'ready', ERROR = 'error' }

function packStateOf(res: PackLoadResult): PackState {
  const m = homeMode(false, AppContainer.hasCourse(), res.ok);
  return m === HomeMode.NO_COURSE ? PackState.NO_COURSE : m === HomeMode.READY ? PackState.READY : PackState.ERROR;
}

const PACK_LOAD_TIMEOUT_MS: number = 10000;

export class AppViewModel {
  private static inst: AppViewModel | undefined = undefined;

  static get(): AppViewModel {
    if (AppViewModel.inst === undefined) {
      AppViewModel.inst = proxy(new AppViewModel());
    }
    return AppViewModel.inst;
  }

  readonly stack: NavPathStack = ref(new NavPathStack());
  packState: PackState = PackState.LOADING;
  packIssues: AppIssue[] = [];
  /** From the pack manifest, for About & licences. */
  packVersion: string = '';
  packBuiltAt: string = '';
  packPois: number = 0;
  /** The active course's city in the UI language ('' = unknown): "All places in {city}", "You're far from {city}". */
  cityName: string = '';
  /** Language of narration text and place names. B9/B10 bind it to UserSettings.textLang. */
  textLang: Lang = Lang.EN;
  /** Demo walk replay speed last applied to TourControl (TourControl has no getter for it). */
  demoSpeed: number = AppConfig.DEMO_DEFAULT_SPEED;
  /** One flow at a time: Tour detail -> Route ready -> Before you go. */
  tourPlan: TourPlanViewModel = new TourPlanViewModel();
  /** Bumped when the active course changes (Courses screen); Home and About re-read the pack. */
  courseRev: number = 0;
  private loadStarted: boolean = false;

  /**
   * The UI exists in English, Polish and Chinese only. On any other system language the app shows English: on iOS
   * platform/strings.ts already maps an unsupported system language to 'en' (the HarmonyOS app pinned it with
   * i18n.System.setAppPreferredLanguage), so this only logs the decision. The in-app choice (B10) is not touched.
   */
  applySupportedUiLanguage(): void {
    try {
      const sys = getLocales()[0]?.languageTag ?? '';
      const l = sys.toLowerCase();
      if (!(l.startsWith('en') || l.startsWith('pl') || l.startsWith('zh'))) {
        Log.i(LogEvents.SETTINGS, `uiLang=en reason=unsupported_system_lang sys=${sys}`);
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=AppViewModel.applySupportedUiLanguage ${Log.errKv(e as Object)}`);
    }
  }

  /** Loads the active course's pack once (local files, no network). Never throws. */
  async loadPack(): Promise<void> {
    if (this.loadStarted) {
      return;
    }
    this.loadStarted = true;
    this.packState = PackState.LOADING;
    const failed: PackLoadResult = {
      ok: false,
      issues: [this.issue(IssueCode.PACK_ERR, 'load timeout or exception')]
    };
    const res = await withTimeout(AppContainer.packRepository().load(), PACK_LOAD_TIMEOUT_MS, failed, 'pack.load');
    this.applyLoad(res);
    if (res === failed) {
      // A slow load (a large course on a slow device) still lands: show it when it does.
      AppContainer.packRepository().load().then((late: PackLoadResult) => {
        if (late.ok) {
          this.applyLoad(late);
          this.courseRev++;
        }
      }).catch((e: Object) => {
        Log.e(LogEvents.UNCAUGHT, `where=AppViewModel.loadPack.late ${Log.errKv(e)}`);
      });
    }
  }

  private applyLoad(res: PackLoadResult): void {
    this.packIssues = res.issues;
    this.packState = packStateOf(res);
    this.packVersion = res.manifest !== undefined ? res.manifest.version : '';
    this.packBuiltAt = res.manifest !== undefined ? res.manifest.builtAt.substring(0, 10) : '';
    this.packPois = res.manifest !== undefined ? res.manifest.counts.pois : 0;
    this.cityName = AppContainer.cityName();
    if (this.packState === PackState.ERROR) {
      Log.e(LogEvents.PACK_ERR, `where=ui issues=${res.issues.length}`);
    } else if (this.packState === PackState.NO_COURSE) {
      Log.i(LogEvents.COURSE, 'event=no_course where=ui action=empty_state');
    }
  }

  /** SERVER.md §6: the active course changed (downloaded, switched, deleted; CourseRepository already loaded it). */
  courseChanged(): void {
    this.reloadPack();
  }

  /** courseChanged, awaitable: resolves true once the active course's pack is loaded and READY. Never rejects. */
  async reloadPack(): Promise<boolean> {
    this.courseRev++;
    const failed: PackLoadResult = {
      ok: false,
      issues: [this.issue(IssueCode.PACK_ERR, 'load timeout or exception')]
    };
    try {
      const res = await withTimeout(AppContainer.packRepository().load(), PACK_LOAD_TIMEOUT_MS, failed,
        'pack.load.courseChanged');
      this.applyLoad(res);
      this.courseRev++;
      return this.packState === PackState.READY;
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=AppViewModel.courseChanged ${Log.errKv(e as Object)}`);
      return false;
    }
  }

  openCourses(): void {
    this.push(Routes.COURSES, '');
  }

  openTour(tourId: string): void {
    this.tourPlan = new TourPlanViewModel();
    this.push(Routes.TOUR_DETAIL, tourId);
  }

  openRouteReady(): void {
    this.push(Routes.ROUTE_READY, this.tourPlan.tourId);
  }

  /** Now Walking always sits directly on Home, so back from it returns Home and the tour keeps running. */
  openNowWalking(): void {
    try {
      this.stack.clear(false);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=AppViewModel.openNowWalking ${Log.errKv(e as Object)}`);
    }
    this.push(Routes.NOW_WALKING, '');
  }

  /** B11: the Tour summary replaces Now Walking and sits directly on Home, so back or Done returns Home. */
  openSummary(): void {
    try {
      this.stack.clear(false);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=AppViewModel.openSummary ${Log.errKv(e as Object)}`);
    }
    this.push(Routes.SUMMARY, '');
  }

  /** Back to Home (the Navigation root). */
  home(): void {
    try {
      this.stack.clear();
      Log.i(LogEvents.APP_PAGE, 'page=Home');
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=AppViewModel.home ${Log.errKv(e as Object)}`);
    }
  }

  /** B11 "Start again": the tour's detail page on top of Home, where the usual plan -> Route ready -> Start runs. */
  startTourAgain(tourId: string): void {
    try {
      this.stack.clear(false);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=AppViewModel.startTourAgain ${Log.errKv(e as Object)}`);
    }
    this.openTour(tourId);
  }

  /** Full map; `mode` is 'walk' (live tour), 'tour' (planned route) or 'explore' (all places, B13). */
  openFullMap(mode: string): void {
    this.push(Routes.FULL_MAP, mode);
  }

  openPlace(poiId: string): void {
    this.push(Routes.PLACE_DETAIL, poiId);
  }

  openAbout(): void {
    this.push(Routes.ABOUT_SOURCES, '');
  }

  /** B9: Settings and its sub-pages (and the onboarding replay from Settings > About). */
  openSettingsPage(name: string, param: string): void {
    this.push(name, param);
  }

  back(): void {
    try {
      this.stack.pop();
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=AppViewModel.back ${Log.errKv(e as Object)}`);
    }
  }

  private push(name: string, param: string): void {
    try {
      this.stack.pushPath(new NavPathInfo(name, param));
      Log.i(LogEvents.APP_PAGE, `page=${name} param=${param}`);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=AppViewModel.push page=${name} ${Log.errKv(e as Object)}`);
    }
  }

  private issue(code: IssueCode, detail: string): AppIssue {
    const i: AppIssue = { code: code, severity: IssueSeverity.BLOCKING, detail: detail };
    return i;
  }
}
