/*
 * Developer stub pack (T0): three real Royal Route stops inline, so Person A can integrate the engine
 * before B's RawfilePackRepository (B3) lands. Coordinates are WGS-84, taken from the lead's
 * docs/design/map/map-meta.json (OSM-based). Narrations are labelled placeholders, tier NAME_ONLY,
 * provenance TEMPLATE: no historical claims are made here. Owned by B after the T0 merge.
 */
import {
  ContentTier, Lang, MapData, Narration, NarrationLength, PackManifest, Persona, Poi, PoiKind, ProvenanceKind,
  RouteData, SourceRef, Tour
} from '@citytour/core';
import { PackLoadResult, PackRepository } from '@citytour/core';

export const STUB_PACK_ID: string = 'krakow-stub';
export const STUB_TOUR_ID: string = 'royal-route-stub';
export const STUB_PERSONA_ID: string = 'historian';
export const STUB_POI_BARBICAN: string = 'poi_stub_barbican';
export const STUB_POI_ST_MARYS: string = 'poi_stub_st_marys';
export const STUB_POI_CLOTH_HALL: string = 'poi_stub_cloth_hall';

// Pack origin = Cloth Hall; x/y = equirectangular metres from it (east, north).
const ORIGIN_LAT: number = 50.0617;
const ORIGIN_LNG: number = 19.9373;

export class StubPackRepository implements PackRepository {
  private readonly poiList: Poi[] = [
    {
      id: STUB_POI_BARBICAN, kind: PoiKind.GATE, lat: 50.0655, lng: 19.9417, x: 314.5, y: 420.1,
      names: { en: 'Barbican', pl: 'Barbakan', zh: '巴比肯' }, importance: 0.9, tier: ContentTier.NAME_ONLY,
      triggerRadiusM: 35, sourceIds: []
    },
    {
      id: STUB_POI_ST_MARYS, kind: PoiKind.CHURCH, lat: 50.0616, lng: 19.9394, x: 150.1, y: -11.0,
      names: { en: 'St Mary\'s Basilica', pl: 'Bazylika Mariacka', zh: '圣母圣殿' }, importance: 1.0,
      tier: ContentTier.NAME_ONLY, triggerRadiusM: 35, sourceIds: []
    },
    {
      id: STUB_POI_CLOTH_HALL, kind: PoiKind.BUILDING, lat: 50.0617, lng: 19.9373, x: 0, y: 0,
      names: { en: 'Cloth Hall', pl: 'Sukiennice', zh: '纺织会馆' }, importance: 1.0, tier: ContentTier.NAME_ONLY,
      triggerRadiusM: 35, sourceIds: []
    }
  ];

  private readonly tourList: Tour[] = [
    {
      id: STUB_TOUR_ID, personaId: STUB_PERSONA_ID,
      titles: { en: 'Royal Route (stub, 3 stops)', pl: 'Droga Królewska (stub)', zh: '皇家之路（测试）' },
      summaries: { en: 'Developer stub tour until the real pack lands.' },
      stops: [
        { poiId: STUB_POI_BARBICAN, dwellS: 60, prize: 3 },
        { poiId: STUB_POI_ST_MARYS, dwellS: 120, prize: 5 },
        { poiId: STUB_POI_CLOTH_HALL, dwellS: 90, prize: 4 }
      ],
      fixedStartPoiId: STUB_POI_BARBICAN,
      estMinutes: 20
    }
  ];

  private readonly personaList: Persona[] = [
    {
      id: STUB_PERSONA_ID, names: { en: 'Historian', pl: 'Historyk', zh: '历史学家' },
      voices: [{ lang: Lang.EN, person: 8 }, { lang: Lang.ZH, person: 13 }], speed: 1, pitch: 1
    }
  ];

  // Haversine x 1.25 detour factor; durations at 1.30 m/s. Node order = nodeIds.
  private readonly routeData: RouteData = {
    nodeIds: [STUB_POI_BARBICAN, STUB_POI_ST_MARYS, STUB_POI_CLOTH_HALL],
    distancesM: [[0, 580, 658], [580, 0, 188], [658, 188, 0]],
    durationsS: [[0, 446, 506], [446, 0, 145], [506, 145, 0]],
    detourFactor: 1.25,
    legs: []
  };

  private loaded: boolean = false;

  load(): Promise<PackLoadResult> {
    this.loaded = true;
    const manifest: PackManifest = {
      schemaVersion: 1, packId: STUB_PACK_ID, version: '0.0.0-stub', builtAt: '2026-10-03T00:00:00Z',
      origin: { lat: ORIGIN_LAT, lng: ORIGIN_LNG }, bbox: [50.0525, 19.929, 50.0675, 19.947], files: [],
      counts: { pois: this.poiList.length, narrations_en: this.poiList.length * 2, narrations_pl: 0, narrations_zh: 0, legs: 0 },
      licenses: ['ODbL-1.0 (OpenStreetMap coordinates)']
    };
    const result: PackLoadResult = { ok: true, manifest: manifest, issues: [] };
    return Promise.resolve(result);
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  pois(): Poi[] {
    return this.poiList;
  }

  poi(id: string): Poi | undefined {
    return this.poiList.find((p: Poi) => p.id === id);
  }

  tours(): Tour[] {
    return this.tourList;
  }

  personas(): Persona[] {
    return this.personaList;
  }

  routes(): RouteData {
    return this.routeData;
  }

  map(level: string): MapData {
    const data: MapData = {
      level: level, origin: { lat: ORIGIN_LAT, lng: ORIGIN_LNG }, bounds: [-600, -1500, 700, 600], layers: []
    };
    return data;
  }

  narration(poiId: string, personaId: string, lang: Lang, len: NarrationLength): Narration | undefined {
    const p = this.poi(poiId);
    if (p === undefined || lang !== Lang.EN || len === NarrationLength.DEEP) {
      return undefined;
    }
    const name = p.names.en !== undefined ? p.names.en : poiId;
    const sentences: string[] = len === NarrationLength.TEASER
      ? [`You have reached ${name}.`, 'This is placeholder text from the developer stub pack.']
      : [`This is ${name}.`, 'The real Historian script arrives with the city pack.',
        'Until then, this placeholder lets the tour engine and the voice run end to end.'];
    const n: Narration = {
      id: `${poiId}:${personaId}:${lang}:${len}`, poiId: poiId, personaId: personaId, lang: lang, length: len,
      sentences: sentences, tier: ContentTier.NAME_ONLY, sources: [], claims: [],
      generatedBy: { kind: ProvenanceKind.TEMPLATE, at: '2026-10-03T00:00:00Z' },
      validation: { status: 'pass', checks: ['stub'], validatorVersion: 0 }
    };
    return n;
  }

  source(id: string): SourceRef | undefined {
    return undefined;
  }
}
