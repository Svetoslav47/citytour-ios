/*
 * Home view model (B4, DESIGN §3.2; SERVER.md §6 "Home"): Home lists the walks of the current city straight from the
 * catalog (CoursesViewModel rows: cached catalog offline, streamed/downloaded courses always), with the header
 * "You're in {city}" / "Walks in {city}" (core/remote/HomeRules). Each walk's card carries its actions:
 * Start (one tap: activate or stream the walk, location check, plan all stops, start, Now Walking; no Route ready),
 * Demo walk (SIMULATED source, x2; offered while the course ships demo-walk.json, CourseRules.demoWalkOffered),
 * download / remove. The "Now walking" continue card comes from the TourControl snapshots.
 */
import { EngineSnapshot, TourPhase } from '@citytour/core';
import { Lang } from '@citytour/core';
import { FixSource } from '@citytour/core';
import { proxy, ref } from 'valtio';
import { AppContainer } from '../app/AppContainer';
import { Log } from '../app/Log';
import { LogEvents } from '@citytour/core';
import { MapData } from '@citytour/core';
import { PreviewPoint } from '../views/common/RoutePreview';
import { AppViewModel, PackState } from './AppViewModel';
import { CoverModel } from './CoverModel';
import { MapOverlay } from '../views/map/MapRenderer';
import { MapCache, overlayBounds, previewOverlay } from './MapViewModel';
import { withTimeout } from './Async';
import { localName } from './Format';
import { findTour, listedMetres, personaName, poiName, previewPoints } from './PackView';
import {
  CardActions, CardInput, cardActions, ExploreInput, ExploreStep, exploreStep, ExploreWalk, exploreWalk, homeCity,
  HomeHeader, homeHeader
} from '@citytour/core';
import { progressPct, sizeLabel } from '@citytour/core';
import { CancelToken, InstallProgress } from '../services/remote/CourseStore';
import { OpResult } from '../services/remote/CourseRepository';
import { CourseState } from '@citytour/core';
import { CourseItem, CoursesViewModel } from './CoursesViewModel';
import { LocBanner, TourPlanViewModel } from './TourPlanViewModel';

const CONTROL_TIMEOUT_MS: number = 8000;
const DEMO_HOME_SPEED: number = 2;
const CITY_DOWNLOAD_TIMEOUT_MS: number = 15 * 60000;   // the city's places pack (~9 MB) on a slow connection   // x2: fast enough to show the walk, slow enough to follow it on screen

export class HomeViewModel {
  hasTour: boolean = false;
  tourId: string = '';
  title: string = '';
  firstStop: string = '';
  lastStop: string = '';
  stopCount: number = 0;
  listedM: number = 0;
  estMinutes: number = 0;
  guideName: string = '';
  placesCount: number = 0;
  /** "All places" can open: the city's places are on the device (false for a streamed walk: Download first). */
  allPlaces: boolean = true;
  /** The active course's city ('' = none or a self-contained course). */
  activeCityId: string = '';
  preview: PreviewPoint[] = [];
  map: MapData | undefined = undefined;
  mapScene: MapOverlay = new MapOverlay();
  mapBounds: number[] = [];
  snap: EngineSnapshot | undefined = undefined;
  currentStopName: string = '';
  demoOffered: boolean = false;
  /** The active course's cover photo (falls back to the map preview when it has none). */
  cover: CoverModel = new CoverModel();
  /** The walks (catalog + on-device courses), shared with the internal Courses rows. */
  courses: CoursesViewModel = CoursesViewModel.get();
  /** The city Home lists ('' = every walk), its display name and the header form. */
  cityId: string = '';
  cityLabel: string = '';
  header: HomeHeader = HomeHeader.WALKS_IN;
  /** The walk whose Start / Demo walk is running ('' = none). */
  startingId: string = '';
  /** Location gate of the last Start: its banner shows on the card `gateId`. */
  gate: TourPlanViewModel = new TourPlanViewModel();
  gateId: string = '';
  /** Demo walk asked for a walk whose pack ships no demo track. */
  noDemoId: string = '';
  /** Explore row: preparing a walk / fetching the city's places. */
  exploreBusy: boolean = false;
  /** Explore row: places download progress (-1 = preparing, no percentage yet). */
  explorePct: number = -1;
  /** Explore row: the last prepare / fetch failed ("Tap to try again"). */
  exploreFailed: boolean = false;
  private lang: Lang = Lang.EN;
  private unsubscribe: (() => void) | undefined = undefined;

  /** Reads the tour card from the loaded pack. */
  refresh(lang: Lang): void {
    this.lang = lang;
    const pack = AppContainer.packRepository();
    this.demoOffered = AppContainer.demoWalkOffered();
    const tour = findTour(pack, '');
    if (tour === undefined) {
      this.hasTour = false;
      this.tourId = '';
      this.placesCount = 0;
      return;
    }
    const ids = tour.stops.map((s) => s.poiId);
    this.tourId = tour.id;
    this.title = localName(tour.titles, lang);
    this.firstStop = ids.length > 0 ? poiName(pack, ids[0], lang) : '';
    this.lastStop = ids.length > 0 ? poiName(pack, ids[ids.length - 1], lang) : '';
    this.stopCount = ids.length;
    this.listedM = listedMetres(pack, ids);
    this.estMinutes = tour.estMinutes;
    this.guideName = personaName(pack, tour.personaId, lang);
    this.preview = previewPoints(pack, ids);
    this.map = MapCache.detailMap();
    this.mapScene = ref(previewOverlay(ids, lang));
    this.mapBounds = overlayBounds(this.mapScene) ?? [];
    try {
      this.placesCount = pack.pois().length;
      this.allPlaces = AppContainer.courses().allPlacesReady();
      this.activeCityId = AppContainer.courses().activeCityId();
    } catch (e) {
      this.placesCount = 0;
      this.allPlaces = true;
    }
    this.hasTour = true;
    let courseId = '';
    try {
      courseId = AppContainer.courses().activeId();
    } catch (e) {
      courseId = '';
    }
    this.cover.load(courseId, true);
    this.updateCity();
  }

  /** Loads the walks (local rows at once, then the catalog) and picks the city. */
  async loadWalks(lang: Lang): Promise<void> {
    this.lang = lang;
    this.demoOffered = AppContainer.demoWalkOffered();
    this.updateCity();
    await this.courses.open(lang);
    this.updateCity();
  }

  /** The city Home lists and its header ("You're in" with a real fix inside its bbox, else "Walks in"). */
  updateCity(): void {
    try {
      const items = this.courses.items;
      const ids: string[] = [];
      let activeCity = '';
      for (const it of items) {
        if (it.cityId !== '' && ids.indexOf(it.cityId) < 0) {
          ids.push(it.cityId);
        }
        if (it.active) {
          activeCity = it.cityId;
        }
      }
      this.cityId = homeCity(activeCity, ids);
      const first = items.find((i: CourseItem) => i.cityId === this.cityId && i.city !== '');
      this.cityLabel = first !== undefined ? first.city : AppViewModel.get().cityName;
      const info = AppContainer.activeCity();
      const bbox = info !== undefined && (info.id === this.cityId || this.cityId === '') ? info.bbox : [];
      const f = AppContainer.tourController().lastFix();
      const real = f !== undefined && f.source === FixSource.REAL;
      this.header = homeHeader(real && f !== undefined ? f.lat : Number.NaN, real && f !== undefined ? f.lng : Number.NaN,
        bbox);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=HomeViewModel.updateCity ${Log.errKv(e as Object)}`);
    }
  }

  /** The walks of the listed city (all of them when no city is known). */
  walks(): CourseItem[] {
    return this.courses.items.filter((i: CourseItem) => this.cityId === '' || i.cityId === '' ||
      i.cityId === this.cityId);
  }

  /** The card's buttons (HomeRules.cardActions). */
  card(it: CourseItem): CardActions {
    const i = new CardInput();
    i.downloaded = it.state !== CourseState.AVAILABLE;
    i.updateAvailable = it.state === CourseState.UPDATE;
    i.streamed = it.streaming;
    i.downloading = it.downloading;
    i.preparing = it.preparing || this.startingId === it.id;
    i.failed = it.playFailed || it.failed;
    const live = this.sessionActive();
    i.running = live && it.active;
    i.otherRunning = live && !it.active;
    i.serverEnabled = this.courses.enabled;
    i.active = it.active;
    i.activeHasDemo = this.demoOffered;
    return cardActions(i);
  }

  /**
   * Card Start / Demo walk: make the walk active (stream it when it is not on the device), check location (Start)
   * or select the SIMULATED source (Demo walk), plan every stop and start. Resolves true when Now Walking should open;
   * false leaves the card's state to explain (failed line, location banner, no demo track).
   */
  async startWalk(id: string, demo: boolean): Promise<boolean> {
    if (this.startingId !== '') {
      return false;
    }
    this.startingId = id;
    this.gateId = '';
    this.noDemoId = '';
    try {
      const ready = await this.courses.ensureActive(id);
      if (!ready) {
        return false;
      }
      this.refresh(this.lang);
      if (this.tourId === '') {
        this.courses.markFailed(id, true);
        return false;
      }
      const gate = proxy(new TourPlanViewModel());
      gate.load(this.tourId, this.lang);
      AppViewModel.get().tourPlan = gate;
      this.gate = gate;
      if (demo) {
        if (!AppContainer.demoWalkOffered()) {
          this.noDemoId = id;
          return false;
        }
        const tc = AppContainer.tourControl();
        await withTimeout(tc.setSource(FixSource.DEMO).then((): boolean => true), CONTROL_TIMEOUT_MS, false,
          'tour.setSource.demo');
        tc.setDemoSpeed(DEMO_HOME_SPEED);
        AppViewModel.get().demoSpeed = DEMO_HOME_SPEED;
        gate.demo = true;
        Log.i(LogEvents.LOC_SOURCE, `kind=demo where=homeCard speed=${DEMO_HOME_SPEED}`);
      } else if (!await gate.startTour()) {
        this.gateId = id;   // denied / approximate / switch off: the friendly banner on this card (with the demo)
        return false;
      }
      return await this.launch(id);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=HomeViewModel.startWalk ${Log.errKv(e as Object)}`);
      this.courses.markFailed(id, true);
      return false;
    } finally {
      this.startingId = '';
    }
  }

  /** Location banner "Allow location" / "Turn on" on the card, then start. */
  async allowAndStart(): Promise<boolean> {
    const id = this.gateId;
    const g = this.gate;
    const ok = g.locBanner === LocBanner.SWITCH_OFF ? await g.turnOnLocationSwitch() : await g.allowLocation();
    if (!ok) {
      return false;
    }
    this.gateId = '';
    return await this.launchGuarded(id);
  }

  /** Location banner "Try a demo walk instead" on the card. */
  async demoInstead(): Promise<boolean> {
    const id = this.gateId;
    if (!await this.gate.useDemo()) {
      return false;
    }
    this.gateId = '';
    return await this.launchGuarded(id);
  }

  private async launchGuarded(id: string): Promise<boolean> {
    if (this.startingId !== '') {
      return false;
    }
    this.startingId = id;
    try {
      return await this.launch(id);
    } finally {
      this.startingId = '';
    }
  }

  /**
   * Cover / title tap: the walk's Tour detail. A walk that is not the active course is made active first (streamed
   * when needed; never while a tour runs). Resolves the tour id to open, '' when it cannot be shown.
   */
  async openWalk(id: string): Promise<string> {
    const item = this.courses.items.find((i: CourseItem) => i.id === id);
    const loaded = AppViewModel.get().packState === PackState.READY;
    if (item !== undefined && item.active && loaded && this.tourId !== '') {
      return this.tourId;
    }
    if (this.sessionActive() || this.startingId !== '') {
      return '';
    }
    this.startingId = id;
    try {
      if (!await this.courses.ensureActive(id)) {
        return '';
      }
      this.refresh(this.lang);
      return this.tourId;
    } finally {
      this.startingId = '';
    }
  }

  /** The Explore row's step (HomeRules.exploreStep). Reads only observed state, so the row re-renders with it. */
  exploreStep(packReady: boolean): ExploreStep {
    const i = new ExploreInput();
    i.homeCityId = this.cityId;
    i.activeLoaded = packReady && this.hasTour;
    i.activeCityId = this.activeCityId;
    i.placesOnDevice = this.allPlaces;
    i.serverEnabled = this.courses.enabled;
    i.busy = this.exploreBusy;
    return exploreStep(i);
  }

  /** The size of the city's places pack ('' = unknown), for the Explore row. */
  citySize(): string {
    try {
      return sizeLabel(AppContainer.courses().cityBytes(this.cityId));
    } catch (e) {
      return '';
    }
  }

  /**
   * Explore row tap (B13 "All places in {city}"): with no walk of the city loaded, make one active (HomeRules
   * exploreWalk: downloaded, else streamed, else the first; streamed = its small files only); then, while the city's
   * places are not on the device, fetch the city's places pack only (not a whole walk). Resolves true when the full
   * map can open in explore mode. Never rejects; a failure shows "Tap to try again" on the row.
   */
  async explore(packReady: boolean): Promise<boolean> {
    const step = this.exploreStep(packReady);
    if (step === ExploreStep.OPEN) {
      return true;
    }
    if (step !== ExploreStep.PREPARE && step !== ExploreStep.GET_PLACES) {
      return false;
    }
    this.exploreBusy = true;
    this.exploreFailed = false;
    this.explorePct = -1;
    Log.i(LogEvents.COURSE, `event=explore_start step=${step} city=${this.cityId || 'none'}`);
    try {
      if (step === ExploreStep.PREPARE) {
        const walks = this.walks().map((it: CourseItem) =>
          new ExploreWalk(it.id, it.cityId, it.state !== CourseState.AVAILABLE, it.streaming));
        const id = exploreWalk(walks, this.cityId);
        if (id === '' || !await this.courses.ensureActive(id)) {
          Log.w(LogEvents.COURSE, `event=explore_fail stage=prepare id=${id || 'none'}`);
          this.exploreFailed = true;
          return false;
        }
        this.refresh(this.lang);
      }
      const repo = AppContainer.courses();
      if (!repo.allPlacesReady()) {
        const cancel = new CancelToken();
        const timedOut = new OpResult();
        timedOut.error = 'timeout';
        const r = await withTimeout(repo.downloadCity(repo.activeCityId(), cancel, (p: InstallProgress) => {
          this.explorePct = progressPct(p.doneBytes, p.totalBytes, p.doneFiles, p.totalFiles);
        }), CITY_DOWNLOAD_TIMEOUT_MS, timedOut, 'courses.downloadCity');
        if (r.error === 'timeout') {
          cancel.cancelled = true;
        }
        if (!r.ok) {
          Log.w(LogEvents.COURSE, `event=explore_fail stage=places reason=${r.error}`);
          this.exploreFailed = true;
          return false;
        }
        MapCache.reset();
        await AppViewModel.get().reloadPack();   // the active walk now reads the whole city
        this.refresh(this.lang);
      }
      const ok = AppViewModel.get().packState === PackState.READY && this.hasTour;
      Log.i(LogEvents.COURSE, `event=explore_ready ok=${ok} places=${this.placesCount} all=${this.allPlaces}`);
      this.exploreFailed = !ok;
      return ok;
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=HomeViewModel.explore ${Log.errKv(e as Object)}`);
      this.exploreFailed = true;
      return false;
    } finally {
      this.exploreBusy = false;
    }
  }

  /** Plan every stop (optimised order, default settings) and start. */
  private async launch(id: string): Promise<boolean> {
    const ok = await this.gate.startNow();
    this.courses.markFailed(id, !ok);
    return ok;
  }

  attach(): void {
    if (this.unsubscribe !== undefined) {
      return;
    }
    try {
      this.unsubscribe = AppContainer.tourControl().subscribe((s: EngineSnapshot) => this.onSnapshot(s));
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=HomeViewModel.attach ${Log.errKv(e as Object)}`);
    }
  }

  detach(): void {
    if (this.unsubscribe !== undefined) {
      try {
        this.unsubscribe();
      } catch (e) {
        Log.e(LogEvents.UNCAUGHT, `where=HomeViewModel.detach ${Log.errKv(e as Object)}`);
      }
      this.unsubscribe = undefined;
    }
  }

  /** A tour is running (or paused) and can be reopened. */
  sessionActive(): boolean {
    const s = this.snap;
    return s !== undefined && (s.phase === TourPhase.WALKING || s.phase === TourPhase.APPROACHING ||
      s.phase === TourPhase.AT_STOP);
  }

  /** 1-based number of the stop being walked to or visited. */
  currentStopNumber(): number {
    const s = this.snap;
    if (s === undefined || s.stops.length === 0) {
      return 0;
    }
    return Math.min(s.stops.length, s.currentStopIdx + 1);
  }

  totalStops(): number {
    return this.snap === undefined ? 0 : this.snap.stops.length;
  }

  progressPct(): number {
    const total = this.totalStops();
    return total === 0 ? 0 : Math.round(100 * (this.currentStopNumber() - 1) / total);
  }

  isDemo(): boolean {
    return this.snap !== undefined && this.snap.source === FixSource.DEMO;
  }

  endTour(): void {
    try {
      AppContainer.tourControl().end();
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=HomeViewModel.endTour ${Log.errKv(e as Object)}`);
    }
  }

  private onSnapshot(s: EngineSnapshot): void {
    this.snap = ref(s);   // immutable per emission: not deep-proxied
    const idx = s.currentStopIdx;
    const id = idx >= 0 && idx < s.stops.length ? s.stops[idx].poiId : '';
    this.currentStopName = id === '' ? '' : poiName(AppContainer.packRepository(), id, this.lang);
  }
}
