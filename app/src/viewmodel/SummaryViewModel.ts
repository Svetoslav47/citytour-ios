/*
 * Tour summary view model (B11, DESIGN §3.10).
 *   - Recorder (static, app lifetime): Index starts it once; it feeds every TourControl snapshot to the pure
 *     core/tour/TourTimer and builds the TourSummaryData when a tour ends (FINISHED or ABORTED). Now Walking opens
 *     the summary screen when it sees the end (pending()).
 *   - Screen state: the final snapshot rendered as the summary map (walked legs grey, plaques visited/skipped),
 *     stat trio, "You heard" and "Still to see" rows, the date of the walk, and the SIMULATED note for the Demo walk.
 * Date: Intl.DateTimeFormat in the app's UI language (platform/strings uiCode(); on HarmonyOS
 * i18n.System.getAppPreferredLanguage).
 */
import { EngineSnapshot, StopStatus } from '@citytour/core';
import { Lang, MapData } from '@citytour/core';
import { ref } from 'valtio';
import { AppContainer } from '@/main/AppContainer';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';
import { uiCode } from '../platform/strings';
import { buildSummary, SummaryStop, TourSummaryData, TourTimer } from '@citytour/core';
import { PlaqueState } from '../views/common/Plaque';
import { StopRow } from '../views/common/StopList';
import { MapOverlay } from '../views/map/MapRenderer';
import { localName } from './Format';
import { MapCache, overlayBounds, walkOverlay } from './MapViewModel';
import { findTour, legMetres, poiName, safePoi, safeRoutes } from './PackView';

/** A "Still to see" row: plaque, name and the distance from where the walk ended (NaN = unknown). */
export class StillRow {
  order: number;
  poiId: string;
  name: string;
  distanceM: number;
  skipped: boolean;

  constructor(order: number, poiId: string, name: string, distanceM: number, skipped: boolean) {
    this.order = order;
    this.poiId = poiId;
    this.name = name;
    this.distanceM = distanceM;
    this.skipped = skipped;
  }
}

export class SummaryViewModel {
  private static timer: TourTimer = new TourTimer();
  private static last: TourSummaryData | undefined = undefined;
  private static lastSnap: EngineSnapshot | undefined = undefined;
  private static unsubscribe: (() => void) | undefined = undefined;

  /** Subscribes once for the app's lifetime (Index.aboutToAppear). Never throws. */
  static startRecording(): void {
    if (SummaryViewModel.unsubscribe !== undefined) {
      return;
    }
    try {
      SummaryViewModel.unsubscribe =
        AppContainer.tourControl().subscribe((s: EngineSnapshot) => SummaryViewModel.onSnapshot(s));
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SummaryViewModel.startRecording ${Log.errKv(e as Object)}`);
    }
  }

  /** A tour ended and its summary has not been shown yet. */
  static pending(): boolean {
    return SummaryViewModel.last !== undefined && !SummaryViewModel.last.shown;
  }

  private static onSnapshot(s: EngineSnapshot): void {
    try {
      if (SummaryViewModel.timer.feed(s, Date.now())) {
        SummaryViewModel.finish(s);
      } else if (SummaryViewModel.timer.isRunning() && SummaryViewModel.last !== undefined) {
        SummaryViewModel.last = undefined;   // a new tour is running; the old summary is gone
        SummaryViewModel.lastSnap = undefined;
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SummaryViewModel.onSnapshot ${Log.errKv(e as Object)}`);
    }
  }

  private static finish(s: EngineSnapshot): void {
    const pack = AppContainer.packRepository();
    const routes = safeRoutes(pack);
    const d = buildSummary(s, SummaryViewModel.timer, (id: string): number[] | undefined => {
      const p = safePoi(pack, id);
      return p === undefined ? undefined : [p.x, p.y];
    }, (a: string, b: string): number => legMetres(routes, a, b));
    SummaryViewModel.last = d;
    SummaryViewModel.lastSnap = s;
    Log.i(LogEvents.TOUR_SUMMARY, `tour=${d.tourId} complete=${d.complete ? 1 : 0} heard=${d.heardCount()}/` +
      `${d.totalStops} walkedM=${Math.round(d.walkedM)} engineWalkedM=${Math.round(s.walkedM)} ` +
      `durationS=${Number.isFinite(d.durationS) ? Math.round(d.durationS) : 'nan'} ` +
      `time=${d.demo ? 'walking_pace' : 'elapsed'} src=${d.demo ? 'demo' : 'real'}`);
  }

  // ---------- screen state ----------

  data: TourSummaryData | undefined = undefined;
  tourTitle: string = '';
  dateText: string = '';
  heardRows: StopRow[] = [];
  stillRows: StillRow[] = [];
  map: MapData | undefined = undefined;
  scene: MapOverlay = new MapOverlay();
  sceneBounds: number[] = [];

  /** Loads the last summary for display and marks it shown. Leaves `data` undefined when there is none. */
  load(lang: Lang): void {
    const d = SummaryViewModel.last;
    const s = SummaryViewModel.lastSnap;
    if (d === undefined || s === undefined) {
      Log.w(LogEvents.TOUR_SUMMARY, 'state=empty reason=no_ended_tour');
      return;
    }
    d.shown = true;
    const pack = AppContainer.packRepository();
    try {
      const tour = findTour(pack, d.tourId);
      this.tourTitle = tour === undefined ? '' : localName(tour.titles, lang);
      this.heardRows = d.heard.map((h: SummaryStop) =>
        new StopRow(h.order, h.poiId, poiName(pack, h.poiId, lang), 0, PlaqueState.VISITED));
      this.stillRows = d.stillToSee.map((h: SummaryStop) =>
        new StillRow(h.order, h.poiId, poiName(pack, h.poiId, lang), h.distanceM, h.status === StopStatus.SKIPPED));
      this.map = MapCache.detailMap();
      this.scene = ref(walkOverlay(s, lang));
      this.sceneBounds = overlayBounds(this.scene) ?? [];
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SummaryViewModel.load ${Log.errKv(e as Object)}`);
    }
    this.dateText = SummaryViewModel.formatDate(d.endedMs);
    this.data = ref(d);   // the recorder's object: shown read-only, not deep-proxied
    Log.i(LogEvents.TOUR_SUMMARY, `state=shown tour=${d.tourId} heard=${d.heardCount()}/${d.totalStops} ` +
      `still=${d.stillToSee.length} src=${d.demo ? 'demo' : 'real'}`);
  }

  /** "Saturday, 3 October" in the app's language; '' when the date is unknown or formatting fails. */
  private static formatDate(ms: number): string {
    if (!Number.isFinite(ms)) {
      return '';
    }
    try {
      const code = uiCode();
      const tag = code === 'pl' ? 'pl-PL' : code === 'zh' ? 'zh-CN' : 'en-US';
      const opts: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' };
      return new Intl.DateTimeFormat(tag, opts).format(new Date(ms));
    } catch (e) {
      Log.w(LogEvents.TOUR_SUMMARY, `where=formatDate ${Log.errKv(e as Object)}`);
      return '';
    }
  }

  totalTime(): number {
    return this.data === undefined ? Number.NaN : this.data.durationS;
  }
}
