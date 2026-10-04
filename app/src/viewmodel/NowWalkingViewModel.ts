/*
 * Now Walking view model (B5, DESIGN §3.6 + §3.6.2): mirrors the TourControl snapshot into the screen state.
 * Subscribes on attach, unsubscribes on detach. Display rules (distance rounding and throttle, Look cue angle)
 * come from the pure, unit-tested core/map/WalkDisplay. Controls call TourControl and log the engine's USER_*
 * event names (contracts EngineEventType) with src=ui.
 */
import {
  EngineEventType, EngineSnapshot, NowPlaying, SignalQuality, StopProgress, StopStatus, TourPhase
} from '@citytour/core';
import { Lang, LookDir } from '@citytour/core';
import { FixSource } from '@citytour/core';
import { ref } from 'valtio';
import { AppConfig } from '@/main/AppConfig';
import { AppContainer } from '@/main/AppContainer';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';
import { dialAngle, RoundedDistance, roundWalkDistance, shouldUpdateDistance } from '@citytour/core';
import { PlaqueState } from '../views/common/Plaque';
import { MapData } from '@citytour/core';
import { PreviewPoint } from '../views/common/RoutePreview';
import { MapOverlay } from '../views/map/MapRenderer';
import { MapCache, overlayBounds, walkOverlay } from './MapViewModel';
import { StopRow } from '../views/common/StopList';
import { AppViewModel } from './AppViewModel';
import { localName } from './Format';
import { findTour, poiName, previewPoints, safePoi } from './PackView';
import { otherLiveLangs, storyLangForLive } from '@citytour/core';
import { SettingsViewModel } from './SettingsViewModel';
import { SummaryViewModel } from './SummaryViewModel';

export enum WalkState {
  IDLE = 'idle', HEADING = 'heading', APPROACHING = 'approaching', AT_STOP = 'atStop', TEASER = 'teaser',
  READING = 'reading', NO_GPS = 'noGps', OFF_ROUTE = 'offRoute', COMPLETE = 'complete', ENDED = 'ended'
}

/** Reported as the engine's walking pace when only distance is known (1.3 m/s, ARCHITECTURE §6). */
const WALK_MPS: number = 1.3;

export class NowWalkingViewModel {
  snap: EngineSnapshot | undefined = undefined;
  tourTitle: string = '';
  stopName: string = '';
  stopNumber: number = 0;
  totalStops: number = 0;
  shownDistance: RoundedDistance | undefined = undefined;
  dialDeg: number = Number.NaN;
  lookUp: boolean = false;
  routePoints: PreviewPoint[] = [];
  routeStates: PlaqueState[] = [];
  user: PreviewPoint | undefined = undefined;
  stopRows: StopRow[] = [];
  nowPlayingTitle: string = '';
  map: MapData | undefined = undefined;
  scene: MapOverlay = new MapOverlay();
  sceneBounds: number[] = [];
  showDemoSheet: boolean = false;
  showStopsSheet: boolean = false;
  demoSpeed: number = AppConfig.DEMO_DEFAULT_SPEED;
  lang: Lang = Lang.EN;      // story language (X2: changes mid-tour from the ⋯ menu)
  private lastDistanceMs: number = 0;
  private plannedKey: string = '';
  private boundsKey: string = '';
  private unsubscribe: (() => void) | undefined = undefined;
  /** B11: called once when the tour has ended and its summary is waiting (the page opens the Tour summary). */
  onTourEnded: () => void = () => {};
  private endHandled: boolean = false;

  attach(lang: Lang): void {
    this.lang = lang;
    this.demoSpeed = AppViewModel.get().demoSpeed;
    if (this.unsubscribe !== undefined) {
      return;
    }
    try {
      this.unsubscribe = AppContainer.tourControl().subscribe((s: EngineSnapshot) => this.onSnapshot(s));
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NowWalkingViewModel.attach ${Log.errKv(e as Object)}`);
    }
  }

  detach(): void {
    if (this.unsubscribe !== undefined) {
      try {
        this.unsubscribe();
      } catch (e) {
        Log.e(LogEvents.UNCAUGHT, `where=NowWalkingViewModel.detach ${Log.errKv(e as Object)}`);
      }
      this.unsubscribe = undefined;
    }
  }

  /** The DESIGN §3.6.2 state; `paused` and weak GPS are modifiers on top of it. */
  state(): WalkState {
    const s = this.snap;
    if (s === undefined || s.phase === TourPhase.IDLE || s.phase === TourPhase.PLANNING || s.phase === TourPhase.READY) {
      return WalkState.IDLE;
    }
    if (s.phase === TourPhase.FINISHED) {
      return WalkState.COMPLETE;
    }
    if (s.phase === TourPhase.ABORTED) {
      return WalkState.ENDED;
    }
    if (s.signal === SignalQuality.LOST && s.phase !== TourPhase.AT_STOP) {
      return WalkState.NO_GPS;
    }
    if (s.phase === TourPhase.AT_STOP) {
      if (s.speechText) {
        return WalkState.READING;
      }
      const cur = this.currentStop();
      return cur !== undefined && cur.status === StopStatus.TEASER_ONLY ? WalkState.TEASER : WalkState.AT_STOP;
    }
    if (s.offRoute) {
      return WalkState.OFF_ROUTE;
    }
    if (s.phase === TourPhase.APPROACHING) {
      return WalkState.APPROACHING;
    }
    return WalkState.HEADING;
  }

  paused(): boolean {
    return this.snap !== undefined && this.snap.paused;
  }

  isDemo(): boolean {
    return this.snap !== undefined && this.snap.source === FixSource.DEMO;
  }

  weakGps(): boolean {
    return this.snap !== undefined && this.snap.signal === SignalQuality.POOR;
  }

  /** Engine's direction bucket for the caption (same words as the voice). */
  relDir(): string {
    return this.snap !== undefined && this.snap.next !== undefined ? this.snap.next.relDir : 'here';
  }

  etaMinutes(): number {
    const s = this.snap;
    if (s === undefined || s.next === undefined) {
      return 0;
    }
    const sec = s.next.etaS > 0 ? s.next.etaS : s.next.distanceM / WALK_MPS;
    return Math.max(1, Math.round(sec / 60));
  }

  nowPlaying(): NowPlaying | undefined {
    return this.snap !== undefined ? this.snap.nowPlaying : undefined;
  }

  visitedCount(): number {
    const s = this.snap;
    return s === undefined ? 0 : s.stops.filter((p: StopProgress) => p.status === StopStatus.VISITED).length;
  }

  // ---------- controls ----------

  togglePlay(): void {
    const tc = AppContainer.tourControl();
    try {
      if (this.paused()) {
        tc.resume();
        Log.i(EngineEventType.USER_RESUME, 'src=ui');
      } else {
        tc.pause();
        Log.i(EngineEventType.USER_PAUSE, 'src=ui');
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NowWalkingViewModel.togglePlay ${Log.errKv(e as Object)}`);
    }
  }

  replay(): void {
    this.call(EngineEventType.USER_REPLAY, () => AppContainer.tourControl().replay());
  }

  skip(): void {
    this.call(EngineEventType.USER_SKIP, () => AppContainer.tourControl().skip());
  }

  end(): void {
    this.call(EngineEventType.USER_END, () => AppContainer.tourControl().end());
  }

  setDemoSpeed(mult: number): void {
    this.demoSpeed = mult;
    AppViewModel.get().demoSpeed = mult;
    try {
      AppContainer.tourControl().setDemoSpeed(mult);
      Log.i(LogEvents.LOC_SOURCE, `kind=demo speed=${mult} where=demoControls`);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NowWalkingViewModel.setDemoSpeed ${Log.errKv(e as Object)}`);
    }
  }

  /** The SIMULATED Demo walk exists for a course whose pack ships a demo track (CourseRules.demoWalkOffered). */
  demoOffered(): boolean {
    return AppContainer.demoWalkOffered();
  }

  /** No-GPS banner action: switch the running tour to the SIMULATED Demo walk. */
  async switchToDemo(): Promise<void> {
    if (!AppContainer.demoWalkOffered()) {
      return;
    }
    try {
      await AppContainer.tourControl().setSource(FixSource.DEMO);
      Log.i(LogEvents.LOC_SOURCE, 'kind=demo where=nowWalking reason=no_gps');
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NowWalkingViewModel.switchToDemo ${Log.errKv(e as Object)}`);
    }
  }

  demoJumpToNext(): void {
    try {
      AppContainer.tourControl().demoJumpToNext();
      Log.i(LogEvents.LOC_SOURCE, 'kind=demo action=jumpToNext label=demo_assist');
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NowWalkingViewModel.demoJumpToNext ${Log.errKv(e as Object)}`);
    }
  }

  // ---------- internals ----------

  private call(event: string, fn: () => void): void {
    try {
      fn();
      Log.i(event, 'src=ui');
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NowWalkingViewModel.${event} ${Log.errKv(e as Object)}`);
    }
  }

  private currentStop(): StopProgress | undefined {
    const s = this.snap;
    if (s === undefined || s.currentStopIdx < 0 || s.currentStopIdx >= s.stops.length) {
      return undefined;
    }
    return s.stops[s.currentStopIdx];
  }

  private onSnapshot(s: EngineSnapshot): void {
    const pack = AppContainer.packRepository();
    this.snap = ref(s);   // immutable per emission: not deep-proxied
    if ((s.phase === TourPhase.FINISHED || s.phase === TourPhase.ABORTED) && !this.endHandled &&
      SummaryViewModel.pending()) {
      this.endHandled = true;
      // Deferred: subscribe() notifies synchronously, possibly inside the page's aboutToAppear.
      setTimeout(() => this.onTourEnded(), 0);
    }
    this.totalStops = s.stops.length;
    this.stopNumber = Math.min(s.stops.length, Math.max(0, s.currentStopIdx) + 1);
    const poiId = s.next !== undefined ? s.next.poiId : (this.currentStop()?.poiId ?? '');
    this.stopName = poiId === '' ? '' : poiName(pack, poiId, this.lang);
    const poi = poiId === '' ? undefined : safePoi(pack, poiId);
    this.lookUp = poi !== undefined && poi.view !== undefined && poi.view.look === LookDir.UP;

    if (this.tourTitle === '') {
      const tour = findTour(pack, s.tourId);
      this.tourTitle = tour === undefined ? '' : localName(tour.titles, this.lang);
    }

    // Hero distance: rounded, at most every 2 s, only on change (DESIGN §3.6).
    if (s.next !== undefined) {
      const r = roundWalkDistance(s.next.distanceM);
      const now = Date.now();
      if (shouldUpdateDistance(this.shownDistance, r, this.lastDistanceMs, now)) {
        this.shownDistance = r;
        this.lastDistanceMs = now;
      }
      const course = s.user !== undefined ? s.user.courseDeg : Number.NaN;
      const speed = s.user !== undefined ? s.user.speedMps : Number.NaN;
      this.dialDeg = dialAngle(s.next.bearingDeg, course, speed, s.next.relDir);
    } else {
      this.shownDistance = undefined;
      this.dialDeg = Number.NaN;
    }

    // Map: planned stops (rebuilt only when the plan changes) with their progress state, and the user dot.
    const key = s.plannedOrder.join(',');
    if (key !== this.plannedKey) {
      this.plannedKey = key;
      this.routePoints = previewPoints(pack, s.plannedOrder);
    }
    this.routeStates = this.routePoints.map((p: PreviewPoint) => this.plaqueState(s, p.n - 1));
    this.user = s.user !== undefined && Number.isFinite(s.user.x) && Number.isFinite(s.user.y) &&
      (s.user.x !== 0 || s.user.y !== 0) ? new PreviewPoint(s.user.x, s.user.y, 0) : undefined;

    this.nowPlayingTitle = s.nowPlaying !== undefined ? poiName(pack, s.nowPlaying.poiId, this.lang) : '';
    if (this.map === undefined) {
      this.map = MapCache.detailMap();
    }
    this.scene = ref(walkOverlay(s, this.lang));
    if (key !== this.boundsKey) {
      this.boundsKey = key;
      this.sceneBounds = overlayBounds(this.scene) ?? [];
    }

    if (this.showStopsSheet) {
      this.stopRows = this.buildStopRows(s);
    }
  }

  /** X2: the ⋯ menu's language entries (the other live languages). */
  menuLangs(): Lang[] {
    return otherLiveLangs(this.lang);
  }

  /**
   * X2: switch the story language from the ⋯ menu. Saved as the Story language setting (B9), which also tells the
   * running tour (TourControl.setStoryLang): the story continues at the next sentence, captions follow.
   */
  switchStoryLang(l: Lang): void {
    if (l === this.lang) {
      return;
    }
    Log.i(LogEvents.LANG_SWITCH, `to=${l} from=${this.lang} src=ui`);
    try {
      SettingsViewModel.get().setStoryLang(storyLangForLive(l));
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NowWalkingViewModel.switchStoryLang ${Log.errKv(e as Object)}`);
    }
    this.lang = l;
    this.tourTitle = '';               // relocalized on the next snapshot
    try {
      this.onSnapshot(AppContainer.tourControl().current());
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NowWalkingViewModel.switchStoryLang.snapshot ${Log.errKv(e as Object)}`);
    }
  }

  /** Rows for the Stops sheet in walking order with their state. */
  buildStopRows(s: EngineSnapshot): StopRow[] {
    const pack = AppContainer.packRepository();
    return s.stops.map((p: StopProgress, i: number) =>
      new StopRow(i + 1, p.poiId, poiName(pack, p.poiId, this.lang), 0, this.plaqueState(s, i)));
  }

  openStops(): void {
    if (this.snap !== undefined) {
      this.stopRows = this.buildStopRows(this.snap);
    }
    this.showStopsSheet = true;
  }

  private plaqueState(s: EngineSnapshot, i: number): PlaqueState {
    if (i < 0 || i >= s.stops.length) {
      return PlaqueState.UPCOMING;
    }
    const st = s.stops[i].status;
    if (st === StopStatus.SKIPPED) {
      return PlaqueState.SKIPPED;
    }
    if (i === s.currentStopIdx && s.phase === TourPhase.AT_STOP) {
      return PlaqueState.CURRENT;
    }
    if (st === StopStatus.VISITED || st === StopStatus.TEASER_ONLY) {
      return PlaqueState.VISITED;
    }
    if (i === s.currentStopIdx) {
      return PlaqueState.NEXT;
    }
    return PlaqueState.UPCOMING;
  }
}
