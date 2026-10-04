// Test fixture (task B3, Person B): small pack JSON strings and narration builders for PackParser and
// NarrationValidator. Local unit tests cannot read rawfile, so tests feed these strings to the pure parser.
// The validator cases mirror the shared spec v1 cases of scripts/pack/fixtures/validator-cases.json (task B2).
import { ContentTier, Lang, Narration, NarrationLength, ProvenanceKind } from '../../src';
import { ValidationCtx } from '../../src';

export const SRC_WP: string = 'src_wp_en_Q807309';
export const POI_BARBICAN: string = 'poi_wd_Q807309';

export function ctxBarbican(): ValidationCtx {
  const c = new ValidationCtx();
  c.sourceIds = [SRC_WP, 'src_wd_Q807309'];
  c.poiNames = ['Barbican', 'Barbakan', '克拉科夫瓮城', 'Kraków Barbican'];
  return c;
}

export const QUOTE_1498: string = 'The Barbican was built around 1498 as part of the city fortifications.';
export const QUOTE_GATE: string = 'It was connected to the Florian Gate by a covered passage.';

/** Valid REVIEWED_HISTORIAN English teaser: 36 words, grounded numbers and names. */
export function reviewedTeaser(sentences: string[] = [
  'This is the Barbican, a round brick fortress built in 1498 to guard the road into the city.',
  'Its seven turrets watched over the Florian Gate, where kings entered Kraków on the way to their coronation.'
]): Narration {
  const n: Narration = {
    id: `${POI_BARBICAN}:historian:en:teaser`, poiId: POI_BARBICAN, personaId: 'historian', lang: Lang.EN,
    length: NarrationLength.TEASER, sentences: sentences, tier: ContentTier.REVIEWED_HISTORIAN, sources: [SRC_WP],
    claims: [
      { text: 'built 1498', sourceId: SRC_WP, quote: QUOTE_1498 },
      { text: 'linked to Florian Gate', sourceId: SRC_WP, quote: QUOTE_GATE }
    ],
    generatedBy: { kind: ProvenanceKind.LLM, model: 'claude-opus-5-5', promptId: 'historian-v1', at: '2026-10-03' },
    reviewedBy: { reviewer: 'MS', at: '2026-10-03', status: 'edited' },
    validation: { status: 'pass', checks: [], validatorVersion: 1 }
  };
  return n;
}

/** Valid SOURCE_EXTRACT English teaser (verbatim Wikipedia-style sentences, no claims). */
export function extractTeaser(): Narration {
  const n: Narration = {
    id: `${POI_BARBICAN}:historian:en:teaser`, poiId: POI_BARBICAN, personaId: 'historian', lang: Lang.EN,
    length: NarrationLength.TEASER,
    sentences: ['The Kraków Barbican is a fortified outpost once connected to the city walls.',
      'It is one of the few remaining relics of the complex network of fortifications.'],
    tier: ContentTier.SOURCE_EXTRACT, sources: [SRC_WP], claims: [],
    generatedBy: { kind: ProvenanceKind.EXTRACT, at: '2026-10-03' },
    validation: { status: 'pass', checks: [], validatorVersion: 1 }
  };
  return n;
}

export function withTier(n: Narration, tier: ContentTier): Narration {
  n.tier = tier;
  return n;
}

export const MANIFEST_OK: string =
  '{"schemaVersion":1,"packId":"krakow","version":"1","builtAt":"2026-10-03T12:00:00Z","origin":{"lat":50.06143,"lng":19.93658},"bbox":[50.0,19.8,50.1,20.0],"files":[{"path":"pois.json","bytes":10,"sha256":"ab"}],"counts":{"pois":2,"narrations_en":1,"narrations_pl":0,"narrations_zh":0,"legs":0},"licenses":["ODbL-1.0"]}';

export const MANIFEST_V2: string =
  '{"schemaVersion":2,"packId":"krakow","version":"1","builtAt":"","origin":{"lat":50,"lng":19},"bbox":[],"files":[],"counts":{"pois":0,"narrations_en":0,"narrations_pl":0,"narrations_zh":0,"legs":0},"licenses":[]}';

export const POIS_JSON: string =
  '[{"id":"poi_wd_Q807309","kind":"gate","lat":50.06553,"lng":19.94166,"x":362.4,"y":455.3,"names":{"en":"Barbican","pl":"Barbakan","zh":"克拉科夫瓮城"},"wikidataId":"Q807309","importance":0.9,"tier":"source-extract","triggerRadiusM":35,"sourceIds":["src_wp_en_Q807309"],"view":{"look":"up","feature":{"en":"the seven turrets"}},"heritage":{"unesco":true}},{"id":"poi_wd_Q1072350","kind":"building","lat":50.06168,"lng":19.93738,"x":57.2,"y":27.8,"names":{"pl":"Sukiennice","en":"Cloth Hall"},"importance":0.95,"tier":"name-only","triggerRadiusM":50,"sourceIds":[]},{"id":"poi_wd_Q1","kind":"spaceship","lat":50.06,"lng":19.93,"x":0,"y":0,"names":{"pl":"X"},"importance":0.1,"tier":"name-only","triggerRadiusM":30,"sourceIds":[]},{"id":"poi_wd_Q2","kind":"church","lat":95,"lng":19.93,"x":0,"y":0,"names":{"pl":"Y"},"importance":0.1,"tier":"name-only","triggerRadiusM":30,"sourceIds":[]}]';

export const TOURS_JSON: string =
  '[{"id":"royal-route","personaId":"historian","titles":{"en":"The Royal Route"},"summaries":{"en":"Gate to castle."},"stops":[{"poiId":"poi_wd_Q807309","dwellS":120,"prize":4,"triggerRadiusM":35},{"poiId":"poi_wd_Q1072350","dwellS":90,"prize":5},{"poiId":"poi_wd_Q999","dwellS":60,"prize":1}],"fixedStartPoiId":"poi_wd_Q807309","estMinutes":55}]';

export const ROUTES_JSON: string =
  '{"nodeIds":["poi_wd_Q807309","poi_wd_Q1072350"],"durationsS":[[0,400],[400,0]],"distancesM":[[0,520],[520,0]],"detourFactor":1.21,"legs":[{"fromPoiId":"poi_wd_Q807309","toPoiId":"poi_wd_Q1072350","distanceM":520,"durationS":400,"geometry":[362.4,455.3,57.2,27.8],"steps":[{"maneuver":"teleport","modifier":"","streetName":"Floriańska","distanceM":520,"durationS":400,"geomIndex":0,"x":362.4,"y":455.3}]},{"fromPoiId":"poi_wd_Q1072350","toPoiId":"poi_wd_Q807309","distanceM":520,"durationS":400,"geometry":[1,2,3],"steps":[]}]}';

export const NARR_EN_JSON: string =
  '[{"id":"poi_wd_Q807309:historian:en:teaser","poiId":"poi_wd_Q807309","personaId":"historian","lang":"en","length":"teaser","sentences":["The Kraków Barbican is a fortified outpost once connected to the city walls.","It is one of the few remaining relics of the complex network of fortifications."],"tier":"source-extract","sources":["src_wp_en_Q807309"],"claims":[],"generatedBy":{"kind":"extract","at":"2026-10-03"},"validation":{"status":"pass","checks":[],"validatorVersion":1}},{"id":"x:historian:pl:teaser","poiId":"x","personaId":"historian","lang":"pl","length":"teaser","sentences":["Tak."],"tier":"source-extract","sources":[],"claims":[],"generatedBy":{"kind":"extract","at":""},"validation":{"status":"pass","checks":[],"validatorVersion":1}}]';

export const MAP_JSON: string =
  '{"level":"detail","origin":{"lat":50.06143,"lng":19.93658},"bounds":[-1000,-1000,1000,1000],"layers":[{"id":"buildings","geom":"polygon","minScale":0.5,"features":[{"c":[0,0,10,0,10,10,0,10],"rings":[0],"bb":[0,0,10,10]},{"c":[0,0,10],"bb":[0,0,10,10]}]},{"id":"lava","geom":"polygon","minScale":0,"features":[]}]}';
