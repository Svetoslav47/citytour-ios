/*
 * Test fixture (A-owned): a tiny typed pack for core/ unit tests until B's loader lands.
 * 4 POIs (3 tour stops + 1 non-tour POI), a 3x3 stop matrix, 2 narrations.
 * Coordinates are WGS-84 (from docs/design/map/map-meta.json); x/y are equirectangular metres from Cloth Hall.
 * Matrix = haversine x 1.25 detour factor, durations at 1.30 m/s.
 */
import {
  ContentTier, Lang, Narration, NarrationLength, Persona, Poi, PoiKind, ProvenanceKind, RouteData, Tour, LatLng
} from '../../src';

export const MINI_ORIGIN: LatLng = { lat: 50.0617, lng: 19.9373 };
export const MINI_PERSONA_ID: string = 'historian';
export const MINI_TOUR_ID: string = 'mini-tour';
export const MINI_BARBICAN: string = 'poi_mini_barbican';
export const MINI_ST_MARYS: string = 'poi_mini_st_marys';
export const MINI_CLOTH_HALL: string = 'poi_mini_cloth_hall';
export const MINI_TOWN_HALL: string = 'poi_mini_town_hall_tower'; // not a tour stop

export function miniPois(): Poi[] {
  return [
    {
      id: MINI_BARBICAN, kind: PoiKind.GATE, lat: 50.0655, lng: 19.9417, x: 314.5, y: 420.1,
      names: { en: 'Barbican', pl: 'Barbakan' }, importance: 0.9, tier: ContentTier.REVIEWED_HISTORIAN,
      triggerRadiusM: 35, sourceIds: ['src_test']
    },
    {
      id: MINI_ST_MARYS, kind: PoiKind.CHURCH, lat: 50.0616, lng: 19.9394, x: 150.1, y: -11.0,
      names: { en: 'St Mary\'s Basilica', pl: 'Bazylika Mariacka' }, importance: 1.0,
      tier: ContentTier.REVIEWED_HISTORIAN, triggerRadiusM: 35, sourceIds: ['src_test']
    },
    {
      id: MINI_CLOTH_HALL, kind: PoiKind.BUILDING, lat: 50.0617, lng: 19.9373, x: 0, y: 0,
      names: { en: 'Cloth Hall', pl: 'Sukiennice' }, importance: 1.0, tier: ContentTier.SOURCE_EXTRACT,
      triggerRadiusM: 35, sourceIds: ['src_test']
    },
    {
      id: MINI_TOWN_HALL, kind: PoiKind.BUILDING, lat: 50.0614, lng: 19.9358, x: -107.2, y: -33.2,
      names: { en: 'Town Hall Tower', pl: 'Wieża Ratuszowa' }, importance: 0.7, tier: ContentTier.NAME_ONLY,
      triggerRadiusM: 30, sourceIds: []
    }
  ];
}

export function miniTour(): Tour {
  return {
    id: MINI_TOUR_ID, personaId: MINI_PERSONA_ID, titles: { en: 'Mini tour' }, summaries: { en: 'Fixture' },
    stops: [
      { poiId: MINI_BARBICAN, dwellS: 60, prize: 3 },
      { poiId: MINI_ST_MARYS, dwellS: 120, prize: 5 },
      { poiId: MINI_CLOTH_HALL, dwellS: 90, prize: 4 }
    ],
    fixedStartPoiId: MINI_BARBICAN,
    estMinutes: 20
  };
}

export function miniPersona(): Persona {
  return {
    id: MINI_PERSONA_ID, names: { en: 'Historian' },
    voices: [{ lang: Lang.EN, person: 8 }, { lang: Lang.ZH, person: 13 }], speed: 1, pitch: 1
  };
}

export function miniRoutes(): RouteData {
  return {
    nodeIds: [MINI_BARBICAN, MINI_ST_MARYS, MINI_CLOTH_HALL],
    distancesM: [[0, 580, 658], [580, 0, 188], [658, 188, 0]],
    durationsS: [[0, 446, 506], [446, 0, 145], [506, 145, 0]],
    detourFactor: 1.25,
    legs: []
  };
}

export function miniNarrations(): Narration[] {
  return [
    {
      id: `${MINI_ST_MARYS}:${MINI_PERSONA_ID}:en:teaser`, poiId: MINI_ST_MARYS, personaId: MINI_PERSONA_ID,
      lang: Lang.EN, length: NarrationLength.TEASER,
      sentences: ['Fixture teaser sentence one.', 'Fixture teaser sentence two.'],
      tier: ContentTier.REVIEWED_HISTORIAN, sources: ['src_test'],
      claims: [{ text: 'Fixture claim.', sourceId: 'src_test', quote: 'Fixture quote.' }],
      generatedBy: { kind: ProvenanceKind.HUMAN, at: '2026-10-03T00:00:00Z' },
      reviewedBy: { reviewer: 'fixture', at: '2026-10-03T00:00:00Z', status: 'approved' },
      validation: { status: 'pass', checks: ['fixture'], validatorVersion: 1 }
    },
    {
      id: `${MINI_CLOTH_HALL}:${MINI_PERSONA_ID}:en:full`, poiId: MINI_CLOTH_HALL, personaId: MINI_PERSONA_ID,
      lang: Lang.EN, length: NarrationLength.FULL,
      sentences: ['Fixture full sentence one.', 'Fixture full sentence two.', 'Fixture full sentence three.'],
      tier: ContentTier.SOURCE_EXTRACT, sources: ['src_test'], claims: [],
      generatedBy: { kind: ProvenanceKind.EXTRACT, at: '2026-10-03T00:00:00Z' },
      validation: { status: 'pass', checks: ['fixture'], validatorVersion: 1 }
    }
  ];
}
