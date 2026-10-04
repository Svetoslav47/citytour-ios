/*
 * Parses the offline pack JSON (ARCHITECTURE §7.2-7.3) and re-validates every record at runtime: types, ranges
 * and enum membership. Invalid records are dropped with a reason (logged by the caller as PACK_DROP); a file
 * that is not valid JSON, or a manifest with another schema major, is blocking (PACK_ERR, §9 row 17).
 * Pure: no @kit imports (local unit tests feed it strings).
 */
import {
  ContentTier, Lang, LatLng, LocalizedText, LookDir, Maneuver, MapData, MapFeature, MapLayer, MapLayerId,
  Narration, NarrationLength, PackManifest, Persona, PersonaVoice, Poi, PoiKind, RouteData, RouteLeg, RouteStep,
  SourceRef, Tour, TourStop
} from '../../contracts/Model';

export const SUPPORTED_SCHEMA: number = 1;

export class Drop {
  file: string;
  id: string;
  reason: string;

  constructor(file: string, id: string, reason: string) {
    this.file = file;
    this.id = id;
    this.reason = reason;
  }
}

export class Parsed<T> {
  items: T[] = [];
  drops: Drop[] = [];
  /** Non-empty = blocking error (bad JSON / wrong shape of the whole file). */
  error: string = '';
}

const POI_KINDS: string[] = [PoiKind.MONUMENT, PoiKind.CHURCH, PoiKind.CASTLE, PoiKind.SQUARE, PoiKind.GATE,
  PoiKind.MUSEUM, PoiKind.BUILDING, PoiKind.PLAQUE, PoiKind.VIEWPOINT, PoiKind.SYNAGOGUE, PoiKind.OTHER];
const TIERS: string[] = [ContentTier.REVIEWED_HISTORIAN, ContentTier.GROUNDED_AI, ContentTier.SOURCE_EXTRACT,
  ContentTier.NAME_ONLY];
const LANGS: string[] = [Lang.EN, Lang.PL, Lang.ZH];
const LENGTHS: string[] = [NarrationLength.TEASER, NarrationLength.FULL, NarrationLength.DEEP];
const LOOKS: string[] = [LookDir.UP, LookDir.LEVEL, LookDir.DOWN];
const MANEUVERS: string[] = [Maneuver.DEPART, Maneuver.TURN, Maneuver.CONTINUE, Maneuver.NEW_NAME, Maneuver.FORK,
  Maneuver.END_OF_ROAD, Maneuver.ROUNDABOUT, Maneuver.ARRIVE, Maneuver.OTHER];
const LAYERS: string[] = [MapLayerId.WATER, MapLayerId.GREEN, MapLayerId.BUILDINGS, MapLayerId.UNESCO,
  MapLayerId.PATHS, MapLayerId.MINOR, MapLayerId.MAJOR, MapLayerId.RIVER];

// ---------- primitive checks ----------

export function isStr(v: Object | undefined | null): boolean {
  return typeof v === 'string';
}

export function isNonEmptyStr(v: Object | undefined | null): boolean {
  return typeof v === 'string' && (v as string).length > 0;
}

export function isNum(v: Object | undefined | null): boolean {
  return typeof v === 'number' && Number.isFinite(v as number);
}

function isNumArray(v: Object | undefined | null): boolean {
  if (!Array.isArray(v)) {
    return false;
  }
  for (const x of v as Object[]) {
    if (!isNum(x)) {
      return false;
    }
  }
  return true;
}

function isStrArray(v: Object | undefined | null): boolean {
  if (!Array.isArray(v)) {
    return false;
  }
  for (const x of v as Object[]) {
    if (!isStr(x)) {
      return false;
    }
  }
  return true;
}

/** At least one non-empty en/pl/zh string; no other types. */
export function isLocalized(v: LocalizedText | undefined | null): boolean {
  if (v === undefined || v === null || typeof v !== 'object') {
    return false;
  }
  const parts: (string | undefined)[] = [v.en, v.pl, v.zh];
  let any = false;
  for (const p of parts) {
    if (p !== undefined && p !== null) {
      if (typeof p !== 'string') {
        return false;
      }
      if (p.length > 0) {
        any = true;
      }
    }
  }
  return any;
}

function isLatLng(v: LatLng | undefined | null): boolean {
  return v !== undefined && v !== null && isNum(v.lat) && isNum(v.lng) && Math.abs(v.lat) <= 90 &&
    Math.abs(v.lng) <= 180;
}

function parseArray<T>(file: string, text: string): Parsed<T> {
  const out = new Parsed<T>();
  try {
    const raw = JSON.parse(text) as T[];
    if (!Array.isArray(raw)) {
      out.error = `${file}: not an array`;
      return out;
    }
    out.items = raw;
  } catch (e) {
    out.error = `${file}: invalid JSON`;
  }
  return out;
}

function keep<T>(src: Parsed<T>, file: string, check: (x: T) => string, idOf: (x: T) => string): Parsed<T> {
  const out = new Parsed<T>();
  out.error = src.error;
  for (const x of src.items) {
    let reason = '';
    try {
      reason = x === undefined || x === null || typeof x !== 'object' ? 'not_object' : check(x);
    } catch (e) {
      reason = 'exception';
    }
    if (reason === '') {
      out.items.push(x);
    } else {
      let id = '?';
      try {
        id = x !== undefined && x !== null ? idOf(x) : '?';
      } catch (e) {
        id = '?';
      }
      out.drops.push(new Drop(file, id, reason));
    }
  }
  return out;
}

// ---------- manifest ----------

export class ManifestResult {
  manifest: PackManifest | undefined = undefined;
  error: string = '';
}

export function parseManifest(text: string): ManifestResult {
  const r = new ManifestResult();
  let m: PackManifest;
  try {
    m = JSON.parse(text) as PackManifest;
  } catch (e) {
    r.error = 'manifest.json: invalid JSON';
    return r;
  }
  if (m === undefined || m === null || typeof m !== 'object') {
    r.error = 'manifest.json: not an object';
    return r;
  }
  if (!isNum(m.schemaVersion) || Math.floor(m.schemaVersion) !== SUPPORTED_SCHEMA) {
    r.error = `manifest.json: schemaVersion=${String(m.schemaVersion)} expected=${SUPPORTED_SCHEMA}`;
    return r;
  }
  if (!isNonEmptyStr(m.packId) || !isStr(m.version) || !isStr(m.builtAt) || !isLatLng(m.origin) ||
    !Array.isArray(m.files)) {
    r.error = 'manifest.json: missing required fields';
    return r;
  }
  for (const f of m.files) {
    if (f === undefined || f === null || !isNonEmptyStr(f.path) || !isNum(f.bytes) || !isStr(f.sha256)) {
      r.error = 'manifest.json: bad files entry';
      return r;
    }
  }
  r.manifest = m;
  return r;
}

// ---------- records ----------

function poiReason(p: Poi): string {
  if (!isNonEmptyStr(p.id)) {
    return 'id';
  }
  if (POI_KINDS.indexOf(p.kind) < 0) {
    return 'enum_kind';
  }
  if (!isNum(p.lat) || !isNum(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
    return 'latlng';
  }
  if (!isNum(p.x) || !isNum(p.y)) {
    return 'xy';
  }
  if (!isLocalized(p.names)) {
    return 'names';
  }
  if (!isNum(p.importance) || p.importance < 0 || p.importance > 1) {
    return 'importance';
  }
  if (TIERS.indexOf(p.tier) < 0) {
    return 'enum_tier';
  }
  if (!isNum(p.triggerRadiusM) || p.triggerRadiusM <= 0) {
    return 'triggerRadiusM';
  }
  if (!isStrArray(p.sourceIds)) {
    return 'sourceIds';
  }
  if (p.view !== undefined && p.view !== null && (LOOKS.indexOf(p.view.look) < 0 || !isLocalized(p.view.feature))) {
    return 'view';
  }
  if (p.heritage !== undefined && p.heritage !== null && typeof p.heritage.unesco !== 'boolean') {
    return 'heritage';
  }
  if (p.wikidataId !== undefined && p.wikidataId !== null && !isStr(p.wikidataId)) {
    return 'wikidataId';
  }
  return '';
}

export function parsePois(text: string): Parsed<Poi> {
  return keep<Poi>(parseArray<Poi>('pois.json', text), 'pois.json', poiReason, (p: Poi) => String(p.id));
}

function stopReason(s: TourStop): string {
  if (s === undefined || s === null || !isNonEmptyStr(s.poiId) || !isNum(s.dwellS) || s.dwellS < 0 || !isNum(s.prize)) {
    return 'stop';
  }
  if (s.triggerRadiusM !== undefined && s.triggerRadiusM !== null && (!isNum(s.triggerRadiusM) || s.triggerRadiusM <= 0)) {
    return 'stop_radius';
  }
  return '';
}

function tourReason(t: Tour): string {
  if (!isNonEmptyStr(t.id) || !isNonEmptyStr(t.personaId) || !isLocalized(t.titles)) {
    return 'fields';
  }
  if (!Array.isArray(t.stops) || t.stops.length === 0) {
    return 'stops';
  }
  for (const s of t.stops) {
    const r = stopReason(s);
    if (r !== '') {
      return r;
    }
  }
  if (!isNum(t.estMinutes)) {
    return 'estMinutes';
  }
  return '';
}

export function parseTours(text: string): Parsed<Tour> {
  return keep<Tour>(parseArray<Tour>('tours.json', text), 'tours.json', tourReason, (t: Tour) => String(t.id));
}

function personaReason(p: Persona): string {
  if (!isNonEmptyStr(p.id) || !isLocalized(p.names) || !isNum(p.speed) || !isNum(p.pitch)) {
    return 'fields';
  }
  if (!Array.isArray(p.voices)) {
    return 'voices';
  }
  for (const v of p.voices) {
    const pv: PersonaVoice = v;
    if (pv === undefined || pv === null || LANGS.indexOf(pv.lang) < 0 || !isNum(pv.person)) {
      return 'voice';
    }
  }
  return '';
}

export function parsePersonas(text: string): Parsed<Persona> {
  return keep<Persona>(parseArray<Persona>('personas.json', text), 'personas.json', personaReason,
    (p: Persona) => String(p.id));
}

function sourceReason(s: SourceRef): string {
  if (!isNonEmptyStr(s.id) || !isStr(s.title) || !isStr(s.url) || !isStr(s.publisher) || !isStr(s.license) ||
    !isStr(s.retrievedAt)) {
    return 'fields';
  }
  if (LANGS.indexOf(s.lang) < 0) {
    return 'enum_lang';
  }
  return '';
}

export function parseSources(text: string): Parsed<SourceRef> {
  return keep<SourceRef>(parseArray<SourceRef>('sources.json', text), 'sources.json', sourceReason,
    (s: SourceRef) => String(s.id));
}

/** Shape check only; content rules are the validator's job (run lazily, memoised). */
function narrationReason(n: Narration): string {
  if (!isNonEmptyStr(n.id) || !isNonEmptyStr(n.poiId) || !isNonEmptyStr(n.personaId)) {
    return 'fields';
  }
  if (LANGS.indexOf(n.lang) < 0) {
    return 'enum_lang';
  }
  if (LENGTHS.indexOf(n.length) < 0) {
    return 'enum_length';
  }
  if (TIERS.indexOf(n.tier) < 0) {
    return 'enum_tier';
  }
  if (!isStrArray(n.sentences) || n.sentences.length === 0) {
    return 'sentences';
  }
  if (!isStrArray(n.sources) || !Array.isArray(n.claims)) {
    return 'sources';
  }
  if (n.generatedBy === undefined || n.generatedBy === null || !isStr(n.generatedBy.kind)) {
    return 'generatedBy';
  }
  return '';
}

export function parseNarrations(file: string, text: string, expectLang: Lang): Parsed<Narration> {
  return keep<Narration>(parseArray<Narration>(file, text), file, (n: Narration) => {
    const r = narrationReason(n);
    return r !== '' ? r : (n.lang !== expectLang ? 'wrong_file_lang' : '');
  }, (n: Narration) => String(n.id));
}

// ---------- routes ----------

export class RoutesResult {
  routes: RouteData = emptyRoutes();
  drops: Drop[] = [];
  error: string = '';
}

export function emptyRoutes(): RouteData {
  const r: RouteData = { nodeIds: [], durationsS: [], distancesM: [], detourFactor: 1.3, legs: [] };
  return r;
}

function isMatrix(m: number[][], n: number): boolean {
  if (!Array.isArray(m) || m.length !== n) {
    return false;
  }
  for (const row of m) {
    if (!isNumArray(row) || row.length !== n) {
      return false;
    }
  }
  return true;
}

function legReason(l: RouteLeg): string {
  if (!isNonEmptyStr(l.fromPoiId) || !isNonEmptyStr(l.toPoiId) || !isNum(l.distanceM) || !isNum(l.durationS)) {
    return 'fields';
  }
  if (!isNumArray(l.geometry) || l.geometry.length % 2 !== 0) {
    return 'geometry';
  }
  if (!Array.isArray(l.steps)) {
    return 'steps';
  }
  for (const s of l.steps) {
    const st: RouteStep = s;
    if (st === undefined || st === null || !isNum(st.distanceM) || !isNum(st.x) || !isNum(st.y)) {
      return 'step';
    }
    if (MANEUVERS.indexOf(st.maneuver) < 0) {
      st.maneuver = Maneuver.OTHER;   // unknown OSRM maneuver: keep the step, speak it generically
    }
  }
  return '';
}

export function parseRoutes(text: string): RoutesResult {
  const out = new RoutesResult();
  let r: RouteData;
  try {
    r = JSON.parse(text) as RouteData;
  } catch (e) {
    out.error = 'routes.json: invalid JSON';
    return out;
  }
  if (r === undefined || r === null || !isStrArray(r.nodeIds) || !isMatrix(r.distancesM, r.nodeIds.length) ||
    !isMatrix(r.durationsS, r.nodeIds.length)) {
    out.error = 'routes.json: bad matrix';
    return out;
  }
  const legs = new Parsed<RouteLeg>();
  legs.items = Array.isArray(r.legs) ? r.legs : [];
  const kept = keep<RouteLeg>(legs, 'routes.json', legReason, (l: RouteLeg) => `${l.fromPoiId}>${l.toPoiId}`);
  const data: RouteData = {
    nodeIds: r.nodeIds, durationsS: r.durationsS, distancesM: r.distancesM,
    detourFactor: isNum(r.detourFactor) && r.detourFactor >= 1 ? r.detourFactor : 1.3, legs: kept.items
  };
  out.routes = data;
  out.drops = kept.drops;
  return out;
}

// ---------- map ----------

export class MapResult {
  map: MapData | undefined = undefined;
  dropped: number = 0;
  error: string = '';
}

function featureOk(f: MapFeature): boolean {
  return f !== undefined && f !== null && isNumArray(f.c) && f.c.length >= 4 && f.c.length % 2 === 0 &&
    isNumArray(f.bb) && f.bb.length === 4 && (f.rings === undefined || f.rings === null || isNumArray(f.rings));
}

export function parseMap(text: string): MapResult {
  const out = new MapResult();
  let m: MapData;
  try {
    m = JSON.parse(text) as MapData;
  } catch (e) {
    out.error = 'map: invalid JSON';
    return out;
  }
  if (m === undefined || m === null || !isLatLng(m.origin) || !isNumArray(m.bounds) || m.bounds.length !== 4 ||
    !Array.isArray(m.layers)) {
    out.error = 'map: bad shape';
    return out;
  }
  const layers: MapLayer[] = [];
  for (const l of m.layers) {
    if (l === undefined || l === null || LAYERS.indexOf(l.id) < 0 || !Array.isArray(l.features)) {
      out.dropped++;
      continue;
    }
    const feats = l.features.filter((f: MapFeature) => featureOk(f));
    out.dropped += l.features.length - feats.length;
    const layer: MapLayer = { id: l.id, geom: l.geom === 'polygon' ? 'polygon' : 'line',
      minScale: isNum(l.minScale) ? l.minScale : 0, features: feats };
    layers.push(layer);
  }
  const data: MapData = { level: isStr(m.level) ? m.level : 'detail', origin: m.origin, bounds: m.bounds,
    layers: layers };
  out.map = data;
  return out;
}

/** Tour stops that reference unknown POIs are removed (and reported), the tour is kept if any stop remains. */
export function pruneTourStops(tours: Tour[], hasPoi: (id: string) => boolean): Drop[] {
  const drops: Drop[] = [];
  for (const t of tours) {
    const kept = t.stops.filter((s: TourStop) => hasPoi(s.poiId));
    for (const s of t.stops) {
      if (!hasPoi(s.poiId)) {
        drops.push(new Drop('tours.json', `${t.id}/${s.poiId}`, 'unknown_poi'));
      }
    }
    t.stops = kept;
  }
  return drops;
}
