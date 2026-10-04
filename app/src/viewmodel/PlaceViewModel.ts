/*
 * Place detail view model (B8, DESIGN §3.8): the narration to read (FULL, else TEASER; the active text
 * language, else English), its tier (logged) and the reviewed "where to look" hint for tour stops. Content comes validated from
 * PackRepository.narration() (validator + fallback chain of B3); this class never shows unvalidated text.
 */
import { ContentTier, Lang, LookDir, MapData, Narration, NarrationLength, Poi, PoiKind, Tour, TourStop
} from '@citytour/core';
import { TourPhase } from '@citytour/core';
import { ref } from 'valtio';
import { AppContainer } from '@/main/AppContainer';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';
import { MapOverlay } from '../views/map/MapRenderer';
import { localName } from './Format';
import { MapCache, placeBounds, placeOverlay } from './MapViewModel';
import { safePoi } from './PackView';

const HISTORIAN: string = 'historian';

/** Strips TTS pause markup ([p400]) from a sentence for reading. */
export function readable(sentence: string): string {
  return sentence.replace(/\s*\[p\d+\]\s*/g, ' ').trim();
}

export class PlaceViewModel {
  found: boolean = false;
  poiId: string = '';
  name: string = '';
  localNamePl: string = '';
  kind: PoiKind = PoiKind.OTHER;
  stopNumber: number = 0;
  paragraphs: string[] = [];
  tier: ContentTier = ContentTier.NAME_ONLY;
  look: LookDir | undefined = undefined;
  lookFeature: string = '';
  currentStop: boolean = false;
  map: MapData | undefined = undefined;
  scene: MapOverlay = new MapOverlay();
  sceneBounds: number[] = [];

  load(poiId: string, lang: Lang): void {
    const pack = AppContainer.packRepository();
    const poi: Poi | undefined = safePoi(pack, poiId);
    this.poiId = poiId;
    if (poi === undefined) {
      this.found = false;
      Log.w(LogEvents.PACK_ERR, `where=PlaceViewModel poi=${poiId} reason=not_found`);
      return;
    }
    this.name = localName(poi.names, lang);
    this.localNamePl = lang !== Lang.PL && poi.names.pl !== undefined && poi.names.pl !== this.name ? poi.names.pl : '';
    this.kind = poi.kind;
    this.stopNumber = this.findStopNumber(poiId);
    this.map = MapCache.detailMap();
    this.scene = ref(placeOverlay(poi.x, poi.y, this.stopNumber));
    this.sceneBounds = placeBounds(poi.x, poi.y);
    if (poi.view !== undefined) {
      this.look = poi.view.look;
      this.lookFeature = localName(poi.view.feature, lang);
    }

    let n = this.narration(poiId, lang);
    if (n === undefined && lang !== Lang.EN) {
      n = this.narration(poiId, Lang.EN);
    }
    if (n !== undefined) {
      this.paragraphs = n.sentences.map((s: string) => readable(s)).filter((s: string) => s.length > 0);
      this.tier = n.tier;
    } else {
      this.paragraphs = [];
      this.tier = ContentTier.NAME_ONLY;
    }
    try {
      const snap = AppContainer.tourControl().current();
      const idx = snap.currentStopIdx;
      this.currentStop = snap.phase === TourPhase.AT_STOP && idx >= 0 && idx < snap.stops.length &&
        snap.stops[idx].poiId === poiId;
    } catch (e) {
      this.currentStop = false;
    }
    this.found = true;
    Log.i(LogEvents.NARR_SOURCE, `where=placeDetail poi=${poiId} tier=${this.tier} lang=${lang}`);
  }

  /** "Tell me more" at the stop being visited: the engine queues the deep layer (TourControl.more). */
  tellMore(): void {
    try {
      AppContainer.tourControl().more();
      Log.i('USER_MORE', `src=placeDetail poi=${this.poiId}`);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=PlaceViewModel.tellMore ${Log.errKv(e as Object)}`);
    }
  }

  private narration(poiId: string, lang: Lang): Narration | undefined {
    const pack = AppContainer.packRepository();
    try {
      const full = pack.narration(poiId, HISTORIAN, lang, NarrationLength.FULL);
      return full !== undefined ? full : pack.narration(poiId, HISTORIAN, lang, NarrationLength.TEASER);
    } catch (e) {
      return undefined;
    }
  }

  private findStopNumber(poiId: string): number {
    try {
      for (const t of AppContainer.packRepository().tours()) {
        const tour: Tour = t;
        const i = tour.stops.findIndex((s: TourStop) => s.poiId === poiId);
        if (i >= 0) {
          return i + 1;
        }
      }
    } catch (e) {
      return 0;
    }
    return 0;
  }
}
