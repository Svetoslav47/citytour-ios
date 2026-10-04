/*
 * CityTour shared contracts: offline city pack model.
 * Source: docs/ARCHITECTURE.md §7.3 (copied verbatim, plus the three helper shapes it references
 * inline: HeritageInfo, PackFile, PackCounts). The Node pipeline mirrors this in scripts/pack/schema.mjs.
 * Contracts hold types, enums and interfaces only: no imports, no logic.
 * ArkTS notes: no index signatures and no `any`; cast after JSON.parse and re-validate in PackParser.
 */

export enum Lang { EN = 'en', PL = 'pl', ZH = 'zh' }

export interface LocalizedText {
  en?: string;
  pl?: string;
  zh?: string;
}

export interface LatLng {
  lat: number;
  lng: number;
}

export enum PoiKind {
  MONUMENT = 'monument', CHURCH = 'church', CASTLE = 'castle', SQUARE = 'square', GATE = 'gate',
  MUSEUM = 'museum', BUILDING = 'building', PLAQUE = 'plaque', VIEWPOINT = 'viewpoint', SYNAGOGUE = 'synagogue',
  OTHER = 'other'
}

export enum ContentTier {
  REVIEWED_HISTORIAN = 'reviewed',
  GROUNDED_AI = 'grounded-ai',
  SOURCE_EXTRACT = 'source-extract',
  NAME_ONLY = 'name-only'
}

export enum LookDir { UP = 'up', LEVEL = 'level', DOWN = 'down' }

/** "the taller tower", reviewed data, never computed. */
export interface ViewHint {
  look: LookDir;
  feature: LocalizedText;
}

/** Referenced inline in §7.3 as `{ registerNo?: string; unesco: boolean }`. */
export interface HeritageInfo {
  registerNo?: string;
  unesco: boolean;
}

export interface Poi {
  id: string;                 // 'poi_wd_Q186304' | 'poi_osm_n123' | 'poi_krk_pomnik_45' (stable across rebuilds)
  kind: PoiKind;
  lat: number;                // WGS-84
  lng: number;
  x: number;                  // projected metres from pack origin
  y: number;
  names: LocalizedText;       // pl always present
  wikidataId?: string;
  importance: number;         // 0..1
  tier: ContentTier;          // best tier available for this POI
  triggerRadiusM: number;     // default 30 for non-tour POIs
  view?: ViewHint;
  heritage?: HeritageInfo;
  sourceIds: string[];        // -> sources.json
  photo?: string;             // rawfile path, P2
}

export interface TourStop {
  poiId: string;
  dwellS: number;
  prize: number;
  triggerRadiusM?: number;
  approachRadiusM?: number;
}

export interface Tour {
  id: string;
  personaId: string;
  titles: LocalizedText;
  summaries: LocalizedText;
  stops: TourStop[];
  fixedStartPoiId?: string;
  fixedEndPoiId?: string;
  estMinutes: number;
}

export enum NarrationLength { TEASER = 'teaser', FULL = 'full', DEEP = 'deep' }

export enum ProvenanceKind {
  LLM = 'llm', HUMAN = 'human', EXTRACT = 'extract', TEMPLATE = 'template', MACHINE_TRANSLATION = 'mt'
}

export interface Provenance {
  kind: ProvenanceKind;
  model?: string;
  promptId?: string;
  at: string;
  translatedFrom?: Lang;
}

export interface Review {
  reviewer: string;
  at: string;
  status: string;             // 'approved' | 'edited'
}

export interface Claim {
  text: string;
  sourceId: string;
  quote: string;              // exact supporting text from the source
}

export interface ValidationReport {
  status: string;             // 'pass' | 'fallback'
  checks: string[];
  validatorVersion: number;
}

export interface Narration {
  id: string;                 // `${poiId}:${personaId}:${lang}:${length}`
  poiId: string;
  personaId: string;
  lang: Lang;
  length: NarrationLength;
  sentences: string[];        // TTS-sized sentences; may contain [pNNN] pause markup
  tier: ContentTier;
  sources: string[];          // sourceIds
  claims: Claim[];            // grounding evidence (empty for EXTRACT/NAME_ONLY)
  generatedBy: Provenance;
  reviewedBy?: Review;        // REQUIRED when tier == REVIEWED_HISTORIAN
  validation: ValidationReport;
}

export interface SourceRef {
  id: string;
  title: string;
  url: string;
  publisher: string;
  license: string;
  retrievedAt: string;
  lang: Lang;
}

export interface PersonaVoice {
  lang: Lang;
  person: number;
}

export interface Persona {
  id: string;                 // 'historian'
  names: LocalizedText;
  voices: PersonaVoice[];     // [{ lang:'en', person: 8 }, { lang:'zh', person: 13 }]
  speed: number;
  pitch: number;
  fallbackPersonaId?: string; // e.g. 'kids-legends' -> 'historian'
}

export enum Maneuver {
  DEPART = 'depart', TURN = 'turn', CONTINUE = 'continue', NEW_NAME = 'new name', FORK = 'fork',
  END_OF_ROAD = 'end of road', ROUNDABOUT = 'roundabout', ARRIVE = 'arrive', OTHER = 'other'
}

export interface RouteStep {
  maneuver: Maneuver;
  modifier: string;
  streetName: string;
  distanceM: number;
  durationS: number;
  geomIndex: number;
  x: number;
  y: number;
}

export interface RouteLeg {
  fromPoiId: string;
  toPoiId: string;
  distanceM: number;
  durationS: number;
  geometry: number[];         // flat [x0,y0,x1,y1,...] projected metres (1 decimal)
  steps: RouteStep[];
}

export interface RouteData {
  nodeIds: string[];
  durationsS: number[][];
  distancesM: number[][];
  detourFactor: number;
  legs: RouteLeg[];
}

export enum MapLayerId {
  WATER = 'water', GREEN = 'green', BUILDINGS = 'buildings', UNESCO = 'unesco', PATHS = 'paths',
  MINOR = 'minor', MAJOR = 'major', RIVER = 'river'
}

export interface MapFeature {
  c: number[];                // flat dm ints
  rings?: number[];           // ring start offsets
  bb: number[];
  name?: string;
}

export interface MapLayer {
  id: MapLayerId;
  geom: string;               // 'polygon' | 'line'
  minScale: number;
  features: MapFeature[];
}

export interface MapData {
  level: string;
  origin: LatLng;
  bounds: number[];
  layers: MapLayer[];
}

/** Referenced inline in §7.3 as `{ path, bytes, sha256 }`. */
export interface PackFile {
  path: string;
  bytes: number;
  sha256: string;
}

/** Referenced inline in §7.3 as `{ pois, narrations_en, narrations_pl, narrations_zh, legs }`. */
export interface PackCounts {
  pois: number;
  narrations_en: number;
  narrations_pl: number;
  narrations_zh: number;
  legs: number;
}

export interface PackManifest {
  schemaVersion: number;      // 1; the app refuses a different major
  packId: string;
  version: string;
  builtAt: string;
  origin: LatLng;
  bbox: number[];             // [minLat, minLng, maxLat, maxLng]
  files: PackFile[];
  counts: PackCounts;
  licenses: string[];
}
