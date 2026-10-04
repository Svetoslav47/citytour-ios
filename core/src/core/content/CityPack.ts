/*
 * City places packs (docs/SERVER.md §3, ServerApi R7). Pure: no @kit imports, unit-tested in
 * entry/src/test/CityPack.test.ets.
 *
 * A city pack (data/city/<cityId>/, downloaded once per city) holds ALL places of the city: pois.json, their stories
 * (narrations/<lang>.json), sources.json, the city map and city.json (names, projection origin, bbox, default map
 * bounds). A course of that city carries only what is its own: tours, routes, personas, its stops' records (curated
 * names, trigger radii, grounded stories), its map when it differs, cover, clips and an optional SIMULATED Demo walk
 * track. The app layers the course over the city (CityCoursePackRepository): a course record wins over the city
 * record with the same id. Nothing in the app is specific to one city: names, projection, bounds and the out-of-area
 * check all come from here.
 */
import { LatLng, PackFile, PackManifest, Poi } from '../../contracts/Model';
import { Projection } from '../geo/Projection';

/** Localised city names (city.json `names`). */
export class CityNames {
  en: string = '';
  pl: string = '';
  zh: string = '';
}

/** city.json of a city pack. */
export class CityInfo {
  id: string = '';
  names: CityNames = new CityNames();
  origin: LatLng = { lat: 0, lng: 0 };
  /** [minLat, minLng, maxLat, maxLng]; [] = unknown. */
  bbox: number[] = [];
  /** Where the "All places" map opens, [minLat, minLng, maxLat, maxLng]; [] = the map's own bounds. */
  defaultBounds: number[] = [];
  /** City-specific proper nouns the narration check treats as grounded (e.g. the city's and river's names). */
  properNouns: string[] = [];
}

function isRec(v: Object | null | undefined): boolean {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
}

function sv(r: Record<string, Object>, k: string): string {
  const v: Object | undefined = r[k];
  return typeof v === 'string' ? (v as string).trim() : '';
}

function fin(v: Object | undefined): boolean {
  return typeof v === 'number' && Number.isFinite(v as number);
}

/** A [minLat, minLng, maxLat, maxLng] box with min < max and valid degrees, else []. */
export function latLngBox(v: Object | undefined): number[] {
  if (!Array.isArray(v)) {
    return [];
  }
  const a = v as Object[];
  if (a.length !== 4 || !a.every((x: Object) => fin(x))) {
    return [];
  }
  const b = a.map((x: Object) => x as number);
  if (Math.abs(b[0]) > 90 || Math.abs(b[2]) > 90 || Math.abs(b[1]) > 180 || Math.abs(b[3]) > 180 ||
    b[0] >= b[2] || b[1] >= b[3]) {
    return [];
  }
  return b;
}

/** Parses city.json; undefined when it is not a usable city (no id, no name, no origin). */
export function parseCityJson(text: string): CityInfo | undefined {
  let raw: Object | null = null;
  try {
    raw = JSON.parse(text) as Object;
  } catch (e) {
    return undefined;
  }
  if (!isRec(raw)) {
    return undefined;
  }
  const r = raw as Record<string, Object>;
  const c = new CityInfo();
  c.id = sv(r, 'cityId');
  const n: Object | undefined = r['names'];
  if (isRec(n)) {
    const nr = n as Record<string, Object>;
    c.names.en = sv(nr, 'en');
    c.names.pl = sv(nr, 'pl');
    c.names.zh = sv(nr, 'zh');
  }
  const o: Object | undefined = r['origin'];
  if (!isRec(o)) {
    return undefined;
  }
  const or = o as Record<string, Object>;
  if (!fin(or['lat']) || !fin(or['lng']) || Math.abs(or['lat'] as number) > 90 || Math.abs(or['lng'] as number) > 180) {
    return undefined;
  }
  c.origin = { lat: or['lat'] as number, lng: or['lng'] as number };
  c.bbox = latLngBox(r['bbox']);
  c.defaultBounds = latLngBox(r['defaultBounds']);
  const pn: Object | undefined = r['properNouns'];
  if (Array.isArray(pn)) {
    for (const x of pn as Object[]) {
      if (typeof x === 'string' && (x as string).trim().length > 0 && (x as string).length <= 64) {
        c.properNouns.push((x as string).trim());
      }
    }
  }
  for (const n of [c.names.en, c.names.pl]) {
    if (n !== '' && c.properNouns.indexOf(n) < 0) {
      c.properNouns.push(n);   // the city's own name is always grounded
    }
  }
  if (c.id === '' || (c.names.en === '' && c.names.pl === '' && c.names.zh === '')) {
    return undefined;
  }
  return c;
}

/**
 * The city's name for the UI language: city.json names, else the catalog's display name (`fallback`, e.g. a course
 * summary's `city`), else ''. Names are stored per language and never inflected: strings put them in a slot where
 * the nominative works in every language ("Wszystkie miejsca: Kraków").
 */
export function cityDisplayName(info: CityInfo | undefined, uiLang: string, fallback: string): string {
  if (info !== undefined) {
    const t = uiLang === 'pl' ? info.names.pl : uiLang === 'zh' ? info.names.zh : info.names.en;
    if (t !== '') {
      return t;
    }
    const any = info.names.en !== '' ? info.names.en : info.names.pl !== '' ? info.names.pl : info.names.zh;
    if (any !== '') {
      return any;
    }
  }
  return fallback;
}

/** A lat/lng box [minLat, minLng, maxLat, maxLng] as a world box [minX, minY, maxX, maxY] in `p`; [] if none. */
export function worldBox(box: number[], p: Projection): number[] {
  if (box.length !== 4) {
    return [];
  }
  return [p.x(box[1]), p.y(box[0]), p.x(box[3]), p.y(box[2])];
}

/** City places with the course's records layered on top (same id: the course wins); city order, then new ones. */
export function layerPois(city: Poi[], course: Poi[]): Poi[] {
  const over = new Map<string, Poi>();
  for (const p of course) {
    over.set(p.id, p);
  }
  const out: Poi[] = [];
  const seen = new Set<string>();
  for (const p of city) {
    const o = over.get(p.id);
    out.push(o !== undefined ? o : p);
    seen.add(p.id);
  }
  for (const p of course) {
    if (!seen.has(p.id)) {
      out.push(p);
      seen.add(p.id);
    }
  }
  return out;
}

/** Origins closer than this (degrees) are the same projection. */
const ORIGIN_EPS_DEG: number = 1e-7;

export class LayeredManifest {
  manifest: PackManifest | undefined = undefined;
  error: string = '';
}

/**
 * The manifest the app sees for a course layered over its city: the course's id/version/build, the city's bbox
 * (the out-of-area check), files of both (storage sizes), the layered place count, licences of both. Both packs
 * must share one projection origin: every record's x/y is in that frame.
 */
export function layerManifests(city: PackManifest, course: PackManifest, places: number): LayeredManifest {
  const out = new LayeredManifest();
  if (Math.abs(city.origin.lat - course.origin.lat) > ORIGIN_EPS_DEG ||
    Math.abs(city.origin.lng - course.origin.lng) > ORIGIN_EPS_DEG) {
    out.error = 'origin_mismatch';
    return out;
  }
  const files: PackFile[] = [];
  for (const f of course.files) {
    files.push(f);
  }
  for (const f of city.files) {
    const c: PackFile = { path: `city/${f.path}`, bytes: f.bytes, sha256: f.sha256 };
    files.push(c);
  }
  const licenses: string[] = [];
  for (const l of (course.licenses ?? []).concat(city.licenses ?? [])) {
    if (typeof l === 'string' && licenses.indexOf(l) < 0) {
      licenses.push(l);
    }
  }
  const cc = course.counts;
  const m: PackManifest = {
    schemaVersion: course.schemaVersion,
    packId: course.packId,
    version: course.version,
    builtAt: course.builtAt,
    origin: course.origin,
    bbox: Array.isArray(city.bbox) && city.bbox.length === 4 ? city.bbox : course.bbox,
    files: files,
    counts: {
      pois: places,
      narrations_en: cc !== undefined && cc !== null ? cc.narrations_en : 0,
      narrations_pl: cc !== undefined && cc !== null ? cc.narrations_pl : 0,
      narrations_zh: cc !== undefined && cc !== null ? cc.narrations_zh : 0,
      legs: cc !== undefined && cc !== null ? cc.legs : 0
    },
    licenses: licenses
  };
  out.manifest = m;
  return out;
}

/** The media session album: "{city} · {tour title}", either one alone when the other is unknown, else "CityTour". */
export function albumLine(city: string, tourTitle: string): string {
  const c = city.trim();
  const t = tourTitle.trim();
  if (c !== '' && t !== '') {
    return `${c} · ${t}`;
  }
  return c !== '' ? c : t !== '' ? t : 'CityTour';
}

/** The pack file of a course's SIMULATED Demo walk track (scripts/demo/make-demo-walk.mjs). */
export const DEMO_WALK_FILE: string = 'demo-walk.json';
