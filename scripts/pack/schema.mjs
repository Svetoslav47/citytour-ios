// CityTour pack pipeline: the pack schema, mirrored from common/src/main/ets/contracts/Model.ets (Node 22+ ESM).
//
// ENUMS and INTERFACES below are a literal copy of Model.ets: enum values, field names, optional markers and
// the TypeScript type text of every field. schema.test.mjs parses Model.ets and fails on any difference, so
// the pipeline can never drift from the app's contracts.
//
// checkRecord(type, value) validates an emitted record against that copy at runtime: required fields
// present, no extra fields (review-only keys must not leak into the pack), primitive types, enum
// membership, nested interfaces and arrays. 90-emit.mjs runs it on every record before writing.
//
// Conventions the contract leaves implicit (documented here for the app side, tasks B3/B6/A9):
//   - Poi.x/y, RouteLeg.geometry, RouteStep.x/y: projected metres, 1 decimal (projection.mjs).
//   - RouteStep.geomIndex: VERTEX index into RouteLeg.geometry, i.e. the maneuver point is
//     (geometry[2*geomIndex], geometry[2*geomIndex+1]). Maneuver vertices survive simplification.
//   - MapFeature.c: flat integer DECIMETRES [x0,y0,x1,y1,...] in the same projected frame.
//     MapFeature.rings: polygons only, the start offset into c (array index, even) of every ring, first
//     always 0; absent for lines. Ring 0 is the outer ring, the others are holes (fill with the even-odd
//     rule). Rings do not repeat their first vertex.
//     MapFeature.bb: [minX, minY, maxX, maxY] in decimetres.
//   - MapData.bounds: [minX, minY, maxX, maxY] in METRES (the area the level covers; features may
//     extend beyond it). MapData.layers is in draw order, bottom to top.
//   - PackManifest.bbox: [minLat, minLng, maxLat, maxLng] of all POIs.

export const SCHEMA_VERSION = 1;

export const ENUMS = Object.freeze({
  Lang: { EN: 'en', PL: 'pl', ZH: 'zh' },
  PoiKind: {
    MONUMENT: 'monument', CHURCH: 'church', CASTLE: 'castle', SQUARE: 'square', GATE: 'gate', MUSEUM: 'museum',
    BUILDING: 'building', PLAQUE: 'plaque', VIEWPOINT: 'viewpoint', SYNAGOGUE: 'synagogue', OTHER: 'other',
  },
  ContentTier: {
    REVIEWED_HISTORIAN: 'reviewed', GROUNDED_AI: 'grounded-ai', SOURCE_EXTRACT: 'source-extract', NAME_ONLY: 'name-only',
  },
  LookDir: { UP: 'up', LEVEL: 'level', DOWN: 'down' },
  NarrationLength: { TEASER: 'teaser', FULL: 'full', DEEP: 'deep' },
  ProvenanceKind: { LLM: 'llm', HUMAN: 'human', EXTRACT: 'extract', TEMPLATE: 'template', MACHINE_TRANSLATION: 'mt' },
  Maneuver: {
    DEPART: 'depart', TURN: 'turn', CONTINUE: 'continue', NEW_NAME: 'new name', FORK: 'fork', END_OF_ROAD: 'end of road',
    ROUNDABOUT: 'roundabout', ARRIVE: 'arrive', OTHER: 'other',
  },
  MapLayerId: {
    WATER: 'water', GREEN: 'green', BUILDINGS: 'buildings', UNESCO: 'unesco', PATHS: 'paths', MINOR: 'minor',
    MAJOR: 'major', RIVER: 'river',
  },
});

export const Lang = ENUMS.Lang;
export const PoiKind = ENUMS.PoiKind;
export const ContentTier = ENUMS.ContentTier;
export const LookDir = ENUMS.LookDir;
export const NarrationLength = ENUMS.NarrationLength;
export const ProvenanceKind = ENUMS.ProvenanceKind;
export const Maneuver = ENUMS.Maneuver;
export const MapLayerId = ENUMS.MapLayerId;

export const LANGS = Object.freeze(Object.values(Lang));
export const LENGTHS = Object.freeze(Object.values(NarrationLength));
/** Best first: the fallback chain walks this list downwards. */
export const TIER_ORDER = Object.freeze(['reviewed', 'grounded-ai', 'source-extract', 'name-only']);

/** Field name ('?' suffix = optional) -> TypeScript type text exactly as in Model.ets. */
export const INTERFACES = Object.freeze({
  LocalizedText: { 'en?': 'string', 'pl?': 'string', 'zh?': 'string' },
  LatLng: { lat: 'number', lng: 'number' },
  ViewHint: { look: 'LookDir', feature: 'LocalizedText' },
  HeritageInfo: { 'registerNo?': 'string', unesco: 'boolean' },
  Poi: {
    id: 'string', kind: 'PoiKind', lat: 'number', lng: 'number', x: 'number', y: 'number', names: 'LocalizedText',
    'wikidataId?': 'string', importance: 'number', tier: 'ContentTier', triggerRadiusM: 'number', 'view?': 'ViewHint',
    'heritage?': 'HeritageInfo', sourceIds: 'string[]', 'photo?': 'string',
  },
  TourStop: { poiId: 'string', dwellS: 'number', prize: 'number', 'triggerRadiusM?': 'number', 'approachRadiusM?': 'number' },
  Tour: {
    id: 'string', personaId: 'string', titles: 'LocalizedText', summaries: 'LocalizedText', stops: 'TourStop[]',
    'fixedStartPoiId?': 'string', 'fixedEndPoiId?': 'string', estMinutes: 'number',
  },
  Provenance: { kind: 'ProvenanceKind', 'model?': 'string', 'promptId?': 'string', at: 'string', 'translatedFrom?': 'Lang' },
  Review: { reviewer: 'string', at: 'string', status: 'string' },
  Claim: { text: 'string', sourceId: 'string', quote: 'string' },
  ValidationReport: { status: 'string', checks: 'string[]', validatorVersion: 'number' },
  Narration: {
    id: 'string', poiId: 'string', personaId: 'string', lang: 'Lang', length: 'NarrationLength', sentences: 'string[]',
    tier: 'ContentTier', sources: 'string[]', claims: 'Claim[]', generatedBy: 'Provenance', 'reviewedBy?': 'Review',
    validation: 'ValidationReport',
  },
  SourceRef: {
    id: 'string', title: 'string', url: 'string', publisher: 'string', license: 'string', retrievedAt: 'string', lang: 'Lang',
  },
  PersonaVoice: { lang: 'Lang', person: 'number' },
  Persona: {
    id: 'string', names: 'LocalizedText', voices: 'PersonaVoice[]', speed: 'number', pitch: 'number',
    'fallbackPersonaId?': 'string',
  },
  RouteStep: {
    maneuver: 'Maneuver', modifier: 'string', streetName: 'string', distanceM: 'number', durationS: 'number',
    geomIndex: 'number', x: 'number', y: 'number',
  },
  RouteLeg: {
    fromPoiId: 'string', toPoiId: 'string', distanceM: 'number', durationS: 'number', geometry: 'number[]',
    steps: 'RouteStep[]',
  },
  RouteData: {
    nodeIds: 'string[]', durationsS: 'number[][]', distancesM: 'number[][]', detourFactor: 'number', legs: 'RouteLeg[]',
  },
  MapFeature: { c: 'number[]', 'rings?': 'number[]', bb: 'number[]', 'name?': 'string' },
  MapLayer: { id: 'MapLayerId', geom: 'string', minScale: 'number', features: 'MapFeature[]' },
  MapData: { level: 'string', origin: 'LatLng', bounds: 'number[]', layers: 'MapLayer[]' },
  PackFile: { path: 'string', bytes: 'number', sha256: 'string' },
  PackCounts: {
    pois: 'number', narrations_en: 'number', narrations_pl: 'number', narrations_zh: 'number', legs: 'number',
  },
  PackManifest: {
    schemaVersion: 'number', packId: 'string', version: 'string', builtAt: 'string', origin: 'LatLng', bbox: 'number[]',
    files: 'PackFile[]', counts: 'PackCounts', licenses: 'string[]',
  },
});

/** Parsed field specs: { name, optional, type }. */
export function fieldsOf(iface) {
  const spec = INTERFACES[iface];
  if (!spec) throw new Error(`unknown interface ${iface}`);
  return Object.entries(spec).map(([k, type]) => ({ name: k.replace(/\?$/, ''), optional: k.endsWith('?'), type }));
}

/** Errors (strings with a JSON-ish path) for `value` checked against type text `type`; [] when valid. */
export function checkType(type, value, path = '$') {
  const errors = [];
  check(type, value, path, errors);
  return errors;
}

export function checkRecord(iface, value, path = iface) {
  return checkType(iface, value, path);
}

function check(type, value, path, errors) {
  if (type.endsWith('[]')) {
    if (!Array.isArray(value)) return void errors.push(`${path}: expected ${type}`);
    const inner = type.slice(0, -2);
    value.forEach((v, i) => check(inner, v, `${path}[${i}]`, errors));
    return;
  }
  if (type === 'string') {
    if (typeof value !== 'string') errors.push(`${path}: expected string`);
    return;
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) errors.push(`${path}: expected finite number`);
    return;
  }
  if (type === 'boolean') {
    if (typeof value !== 'boolean') errors.push(`${path}: expected boolean`);
    return;
  }
  if (ENUMS[type]) {
    if (!Object.values(ENUMS[type]).includes(value)) errors.push(`${path}: ${JSON.stringify(value)} is not a ${type}`);
    return;
  }
  if (INTERFACES[type]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return void errors.push(`${path}: expected ${type} object`);
    const fields = fieldsOf(type);
    const known = new Set(fields.map((f) => f.name));
    for (const k of Object.keys(value)) if (!known.has(k)) errors.push(`${path}.${k}: not a field of ${type}`);
    for (const f of fields) {
      if (value[f.name] === undefined) {
        if (!f.optional) errors.push(`${path}.${f.name}: required`);
        continue;
      }
      check(f.type, value[f.name], `${path}.${f.name}`, errors);
    }
    return;
  }
  throw new Error(`schema: unknown type ${type}`);
}

/** Throws with the first few errors if any record fails its schema. */
export function assertRecords(iface, records, label = iface) {
  const errors = [];
  records.forEach((r, i) => {
    for (const e of checkRecord(iface, r, `${label}[${i}]`)) if (errors.length < 20) errors.push(e);
  });
  if (errors.length) throw new Error(`schema check failed for ${label}:\n  ${errors.join('\n  ')}`);
}
