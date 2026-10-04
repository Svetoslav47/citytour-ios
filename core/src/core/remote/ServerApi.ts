/*
 * The app's ONE adapter for the server's wire format (docs/SERVER.md §3, API v1). Pure: no @kit imports, unit-tested
 * in entry/src/test/RemoteEnvelope.test.ets. Every response is validated here before any other code sees it; anything
 * malformed is rejected with a short reason (never thrown).
 *
 * Readings of points SERVER.md leaves open (the simplest reading, all in this file):
 *  R1 Envelope: `{payload: <object>, sig: <base64 Ed25519 signature, 64 bytes>}`; the signed bytes are
 *     utf8(canonicalJson(payload)) (CanonicalJson.ets). Standard or URL-safe base64 are both accepted.
 *  R2 `expiresAt` of POST /v1/installs: epoch seconds, epoch milliseconds (>= 1e12) or an ISO-8601 string.
 *  R3 Course layout (SERVER.md §3.1): CourseManifest.files[].path is the course layout (repo data/course/<id>/):
 *     `packs/<packId>/<file>` (or `tour/<file>` for a course of a city) and `audio/...`. The pack manifest is the first
 *     of `packs/<packId>/manifest.json`, `tour/manifest.json`, `manifest.json`, `pack/manifest.json` that is listed; the pack's other files sit next to it. The clip manifest
 *     is `audio.manifestPath` (default `audio/manifest.json`) and its clip paths (`audio/...`) are relative to the
 *     course root (the app bundles no course; everything is downloaded into filesDir/courses/<id>/<version>/).
 *  R6 Course version (SERVER.md §3.1): `<pack version>-a<first 8 hex of sha256(audio/manifest.json)>`
 *     (courseVersion), plus `-c<8 hex>` with a cover photo, so it changes when the pack, the clips or the cover change.
 *  R4 Version: an opaque string; a catalog version different from the installed one is an update.
 *  R7 Cities (additive): a catalog `cities[]` row and a course's `cityId` name the city places pack (all places of the
 *     city, their stories and the city map; GET /v1/cities/:id/manifest, paths relative to the city root). A course
 *     without `cityId` is a self-contained older pack.
 *  R5 Ids and versions become folder names, so they are restricted to [A-Za-z0-9._-] (no '..').
 */
import { base64Decode, canonicalJson } from './CanonicalJson';

export const SHA256_RE: RegExp = new RegExp('^[a-f0-9]{64}$');
const ID_RE: RegExp = new RegExp('^[a-z0-9][a-z0-9_-]{0,63}$');
const VERSION_RE: RegExp = new RegExp('^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$');
const PATH_RE: RegExp = new RegExp('^[A-Za-z0-9_][A-Za-z0-9_./-]{0,255}$');
export const ED25519_SIG_BYTES: number = 64;
export const MAX_COURSE_FILES: number = 20000;
export const DEFAULT_AUDIO_MANIFEST: string = 'audio/manifest.json';

export class CourseTitle {
  en: string = '';
  pl: string = '';
  zh: string = '';
}

export class CourseSummary {
  id: string = '';
  version: string = '';
  title: CourseTitle = new CourseTitle();
  city: string = '';
  stops: number = 0;
  km: number = 0;
  minutes: number = 0;
  langs: string[] = [];
  bytes: number = 0;
  coverBlob: string = '';
  /** "<author>, <licence>" of the cover photo (catalog `coverCredit`, SERVER.md §3); '' when none. */
  coverCredit: string = '';
  /** The city whose places pack this course uses (catalog `cityId`); '' = a self-contained (older) course pack. */
  cityId: string = '';
}

/** Catalog `cities[]` (SERVER.md §3): a city's places pack, downloaded with the first course of that city. */
export class CitySummary {
  id: string = '';
  version: string = '';
  names: CourseTitle = new CourseTitle();
  places: number = 0;
  bytes: number = 0;
}

export class CourseFile {
  path: string = '';
  sha256: string = '';
  bytes: number = 0;
}

export class CourseManifest {
  schemaVersion: number = 1;
  courseId: string = '';
  version: string = '';
  publishedAt: string = '';
  packId: string = '';
  files: CourseFile[] = [];
  audioManifestPath: string = DEFAULT_AUDIO_MANIFEST;
  audioClips: number = 0;
  allowedTtsSha: string = '';
  /** The course's city ('' = none). For a CITY manifest (parseCityManifest) `courseId` holds the city id. */
  cityId: string = '';
}

export class EnvelopeParse {
  payload: Object | undefined = undefined;
  /** utf16 text whose utf8 bytes were signed. */
  canonical: string = '';
  sig: number[] = [];
  error: string = '';
}

export class CatalogParse {
  courses: CourseSummary[] = [];
  cities: CitySummary[] = [];
  dropped: number = 0;
  error: string = '';
}

export class ManifestParse {
  manifest: CourseManifest | undefined = undefined;
  error: string = '';
}

function isRecord(v: Object | null | undefined): boolean {
  return v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);
}

function str(r: Record<string, Object>, k: string): string {
  const v: Object | undefined = r[k];
  return typeof v === 'string' ? v as string : '';
}

function num(r: Record<string, Object>, k: string): number {
  const v: Object | undefined = r[k];
  return typeof v === 'number' && Number.isFinite(v as number) ? v as number : Number.NaN;
}

export function validId(id: string): boolean {
  return ID_RE.test(id);
}

export function validVersion(v: string): boolean {
  return VERSION_RE.test(v) && v.indexOf('..') < 0;
}

/** A relative path that cannot escape its folder. */
export function safeRelPath(p: string): boolean {
  if (!PATH_RE.test(p) || p.indexOf('..') >= 0 || p.indexOf('//') >= 0 || p.endsWith('/')) {
    return false;
  }
  return true;
}

/** R1. Parses `{payload, sig}`; the caller verifies `sig` over utf8(`canonical`). */
export function parseEnvelope(text: string): EnvelopeParse {
  const out = new EnvelopeParse();
  let raw: Object | null = null;
  try {
    raw = JSON.parse(text) as Object;
  } catch (e) {
    out.error = 'json';
    return out;
  }
  if (!isRecord(raw)) {
    out.error = 'not_object';
    return out;
  }
  const r = raw as Record<string, Object>;
  const payload: Object | undefined = r['payload'];
  if (!isRecord(payload)) {
    out.error = 'no_payload';
    return out;
  }
  const sigText = str(r, 'sig');
  if (sigText === '') {
    out.error = 'no_sig';
    return out;
  }
  const sig = base64Decode(sigText);
  if (sig === undefined || sig.length !== ED25519_SIG_BYTES) {
    out.error = 'bad_sig_encoding';
    return out;
  }
  out.payload = payload;
  out.canonical = canonicalJson(payload);
  out.sig = sig;
  return out;
}

function parseSummary(v: Object | undefined): CourseSummary | undefined {
  if (!isRecord(v)) {
    return undefined;
  }
  const r = v as Record<string, Object>;
  const c = new CourseSummary();
  c.id = str(r, 'id');
  c.version = str(r, 'version');
  if (!validId(c.id) || !validVersion(c.version)) {
    return undefined;
  }
  const t: Object | undefined = r['title'];
  if (isRecord(t)) {
    const tr = t as Record<string, Object>;
    c.title.en = str(tr, 'en');
    c.title.pl = str(tr, 'pl');
    c.title.zh = str(tr, 'zh');
  }
  if (c.title.en === '' && c.title.pl === '' && c.title.zh === '') {
    c.title.en = c.id;
  }
  c.city = str(r, 'city');
  const stops = num(r, 'stops');
  const km = num(r, 'km');
  const minutes = num(r, 'minutes');
  const bytes = num(r, 'bytes');
  c.stops = Number.isFinite(stops) && stops >= 0 ? Math.round(stops) : 0;
  c.km = Number.isFinite(km) && km >= 0 ? km : 0;
  c.minutes = Number.isFinite(minutes) && minutes >= 0 ? Math.round(minutes) : 0;
  c.bytes = Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes) : 0;
  const langs: Object | undefined = r['langs'];
  if (Array.isArray(langs)) {
    for (const l of langs as Object[]) {
      if (typeof l === 'string' && (l as string).length > 0 && (l as string).length <= 8) {
        c.langs.push(l as string);
      }
    }
  }
  const cover = str(r, 'coverBlob');
  c.coverBlob = SHA256_RE.test(cover) ? cover : '';
  const credit = str(r, 'coverCredit');
  c.coverCredit = c.coverBlob !== '' && credit.length <= 160 ? credit : '';
  const city = str(r, 'cityId');
  c.cityId = validId(city) ? city : '';
  return c;
}

function parseCity(v: Object | undefined): CitySummary | undefined {
  if (!isRecord(v)) {
    return undefined;
  }
  const r = v as Record<string, Object>;
  const c = new CitySummary();
  c.id = str(r, 'id');
  c.version = str(r, 'version');
  if (!validId(c.id) || !validVersion(c.version)) {
    return undefined;
  }
  const t: Object | undefined = r['names'];
  if (isRecord(t)) {
    const tr = t as Record<string, Object>;
    c.names.en = str(tr, 'en');
    c.names.pl = str(tr, 'pl');
    c.names.zh = str(tr, 'zh');
  }
  const places = num(r, 'places');
  const bytes = num(r, 'bytes');
  c.places = Number.isFinite(places) && places >= 0 ? Math.round(places) : 0;
  c.bytes = Number.isFinite(bytes) && bytes >= 0 ? Math.round(bytes) : 0;
  return c;
}

/** A city's display name in the UI language, falling back to English, then any name, then the id. */
export function cityName(names: CourseTitle, id: string, uiLang: string): string {
  const t = uiLang === 'pl' ? names.pl : uiLang === 'zh' ? names.zh : names.en;
  if (t !== '') {
    return t;
  }
  return names.en !== '' ? names.en : names.pl !== '' ? names.pl : names.zh !== '' ? names.zh : id;
}

/** GET /v1/catalog payload `{courses: CourseSummary[]}`. Malformed rows are dropped and counted. */
export function parseCatalog(payload: Object | undefined): CatalogParse {
  const out = new CatalogParse();
  if (!isRecord(payload)) {
    out.error = 'not_object';
    return out;
  }
  const list: Object | undefined = (payload as Record<string, Object>)['courses'];
  if (!Array.isArray(list)) {
    out.error = 'no_courses';
    return out;
  }
  const seen = new Set<string>();
  for (const item of list as Object[]) {
    const c = parseSummary(item);
    if (c === undefined || seen.has(c.id)) {
      out.dropped++;
      continue;
    }
    seen.add(c.id);
    out.courses.push(c);
  }
  // `cities` is additive (older catalogs have none); malformed rows are dropped.
  const cities: Object | undefined = (payload as Record<string, Object>)['cities'];
  if (Array.isArray(cities)) {
    const seenCity = new Set<string>();
    for (const item of cities as Object[]) {
      const c = parseCity(item);
      if (c === undefined || seenCity.has(c.id)) {
        out.dropped++;
        continue;
      }
      seenCity.add(c.id);
      out.cities.push(c);
    }
  }
  return out;
}

/** GET /v1/courses/:id/manifest payload. `expectId` must match courseId. */
export function parseCourseManifest(payload: Object | undefined, expectId: string): ManifestParse {
  const out = new ManifestParse();
  if (!isRecord(payload)) {
    out.error = 'not_object';
    return out;
  }
  const r = payload as Record<string, Object>;
  const m = new CourseManifest();
  m.schemaVersion = num(r, 'schemaVersion');
  if (m.schemaVersion !== 1) {
    out.error = `schema_${String(m.schemaVersion)}`;
    return out;
  }
  m.courseId = str(r, 'courseId');
  m.version = str(r, 'version');
  m.publishedAt = str(r, 'publishedAt');
  m.packId = str(r, 'packId');
  if (!validId(m.courseId) || m.courseId !== expectId) {
    out.error = 'course_id';
    return out;
  }
  if (!validVersion(m.version)) {
    out.error = 'version';
    return out;
  }
  if (m.packId !== '' && !validId(m.packId)) {
    out.error = 'pack_id';
    return out;
  }
  const fe = parseFiles(r['files'], m);
  if (fe !== '') {
    out.error = fe;
    return out;
  }
  const audio: Object | undefined = r['audio'];
  if (isRecord(audio)) {
    const ar = audio as Record<string, Object>;
    const mp = str(ar, 'manifestPath');
    if (mp !== '') {
      if (!safeRelPath(mp)) {
        out.error = 'audio_manifest_path';
        return out;
      }
      m.audioManifestPath = mp;
    }
    const clips = num(ar, 'clips');
    m.audioClips = Number.isFinite(clips) && clips >= 0 ? Math.round(clips) : 0;
  }
  const allowed = str(r, 'allowedTtsSha').toLowerCase();
  m.allowedTtsSha = SHA256_RE.test(allowed) ? allowed : '';
  const city = str(r, 'cityId');
  if (city !== '' && !validId(city)) {
    out.error = 'city_id';
    return out;
  }
  m.cityId = city;
  if (packManifestPath(m) === '') {
    out.error = 'no_pack_manifest';
    return out;
  }
  out.manifest = m;
  return out;
}

/** The `files` list of a course or city manifest into `m.files`; '' or the error. */
function parseFiles(files: Object | undefined, m: CourseManifest): string {
  if (!Array.isArray(files) || (files as Object[]).length === 0 || (files as Object[]).length > MAX_COURSE_FILES) {
    return 'files';
  }
  const seen = new Set<string>();
  for (const f of files as Object[]) {
    if (!isRecord(f)) {
      return 'file_entry';
    }
    const fr = f as Record<string, Object>;
    const cf = new CourseFile();
    cf.path = str(fr, 'path');
    cf.sha256 = str(fr, 'sha256').toLowerCase();
    const b = num(fr, 'bytes');
    cf.bytes = Number.isFinite(b) && b >= 0 ? Math.round(b) : -1;
    if (!safeRelPath(cf.path) || !SHA256_RE.test(cf.sha256) || cf.bytes < 0 || seen.has(cf.path)) {
      return `file_entry ${cf.path}`;
    }
    seen.add(cf.path);
    m.files.push(cf);
  }
  return '';
}

/**
 * GET /v1/cities/:id/manifest payload `{schemaVersion:1, cityId, version, publishedAt, packId, files}` (the city's
 * places pack; paths relative to the city root, the pack manifest is `manifest.json`). Returned as a CourseManifest
 * whose `courseId` is the city id and which has no clips, so the same verified installer (CourseStore) installs it.
 */
export function parseCityManifest(payload: Object | undefined, expectId: string): ManifestParse {
  const out = new ManifestParse();
  if (!isRecord(payload)) {
    out.error = 'not_object';
    return out;
  }
  const r = payload as Record<string, Object>;
  const m = new CourseManifest();
  m.schemaVersion = num(r, 'schemaVersion');
  if (m.schemaVersion !== 1) {
    out.error = `schema_${String(m.schemaVersion)}`;
    return out;
  }
  m.courseId = str(r, 'cityId');
  m.cityId = m.courseId;
  m.version = str(r, 'version');
  m.publishedAt = str(r, 'publishedAt');
  m.packId = str(r, 'packId');
  m.audioManifestPath = '';
  if (!validId(m.courseId) || m.courseId !== expectId) {
    out.error = 'city_id';
    return out;
  }
  if (!validVersion(m.version)) {
    out.error = 'version';
    return out;
  }
  if (m.packId !== '' && !validId(m.packId)) {
    out.error = 'pack_id';
    return out;
  }
  const fe = parseFiles(r['files'], m);
  if (fe !== '') {
    out.error = fe;
    return out;
  }
  if (packManifestPath(m) === '') {
    out.error = 'no_pack_manifest';
    return out;
  }
  out.manifest = m;
  return out;
}

/** R3: the course-relative path of the pack manifest, '' when none is listed. */
export function packManifestPath(m: CourseManifest): string {
  const candidates: string[] = [];
  if (m.packId !== '') {
    candidates.push(`packs/${m.packId}/manifest.json`);
  }
  candidates.push('tour/manifest.json');   // a course of a city: only its tour-specific files (SERVER.md §3.1)
  candidates.push('manifest.json');
  candidates.push('pack/manifest.json');
  for (const c of candidates) {
    if (m.files.some((f: CourseFile) => f.path === c)) {
      return c;
    }
  }
  return '';
}

/** R3: the pack folder ('' = course root, else 'pack/' or 'packs/<id>/'), always '' or ending in '/'. */
export function packDir(m: CourseManifest): string {
  const p = packManifestPath(m);
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.substring(0, i + 1);
}

/** Sum of the listed file sizes (bytes). */
export function manifestBytes(m: CourseManifest): number {
  let n = 0;
  for (const f of m.files) {
    n += f.bytes;
  }
  return n;
}

/** R2: POST /v1/installs `expiresAt` -> epoch ms; NaN when unusable. */
export function parseExpiresAt(v: Object | null | undefined): number {
  if (typeof v === 'number' && Number.isFinite(v as number)) {
    const n = v as number;
    return n >= 1e12 ? n : n * 1000;
  }
  if (typeof v === 'string') {
    const t = Date.parse(v as string);
    return Number.isFinite(t) ? t : Number.NaN;
  }
  return Number.NaN;
}

export class InstallToken {
  token: string = '';
  expiresAtMs: number = 0;
}

/** POST /v1/installs body `{token, expiresAt}`; undefined when malformed. */
export function parseInstall(text: string): InstallToken | undefined {
  let raw: Object | null = null;
  try {
    raw = JSON.parse(text) as Object;
  } catch (e) {
    return undefined;
  }
  if (!isRecord(raw)) {
    return undefined;
  }
  const r = raw as Record<string, Object>;
  const t = new InstallToken();
  t.token = str(r, 'token');
  t.expiresAtMs = parseExpiresAt(r['expiresAt']);
  if (t.token === '' || t.token.length > 2048 || !Number.isFinite(t.expiresAtMs)) {
    return undefined;
  }
  return t;
}

/** Refresh a token a day before it expires (or when unknown). */
export const TOKEN_REFRESH_MARGIN_MS: number = 24 * 3600 * 1000;

export function tokenUsable(t: InstallToken | undefined, nowMs: number): boolean {
  return t !== undefined && t.token !== '' && t.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > nowMs;
}

/** POST /v1/tts limits (SERVER.md §3.1): text 1..400 chars, body at most 2 KB (Chinese is 3 bytes per char). */
export const TTS_MAX_TEXT_CHARS: number = 400;
export const TTS_MAX_BODY_BYTES: number = 2048;

/**
 * R6: a course's catalog version, from its pack version and the sha256 of its clip manifest, plus `-c<8 hex>` when the
 * pack has a cover photo (`coverTag`, SERVER.md §3.1). The app treats versions as opaque; this mirrors the server.
 */
export function courseVersion(packVersion: string, audioManifestSha: string, coverTag: string = ''): string {
  if (!SHA256_RE.test(audioManifestSha)) {
    return packVersion;
  }
  const c = new RegExp('^[a-f0-9]{8}$').test(coverTag) ? `-c${coverTag}` : '';
  return `${packVersion}-a${audioManifestSha.substring(0, 8)}${c}`;
}

export class TtsBody {
  courseId: string = '';
  lang: string = '';
  text: string = '';
}

/** The JSON body for POST /v1/tts, or '' when the line cannot be sent (too long, bad lang). */
export function ttsBodyJson(courseId: string, lang: string, text: string, utf8Len: (s: string) => number): string {
  if (lang !== 'en' && lang !== 'pl' && lang !== 'zh') {
    return '';
  }
  if (text.length === 0 || text.length > TTS_MAX_TEXT_CHARS || !validId(courseId)) {
    return '';
  }
  const b = new TtsBody();
  b.courseId = courseId;
  b.lang = lang;
  b.text = text;
  const json = JSON.stringify(b);
  return utf8Len(json) <= TTS_MAX_BODY_BYTES ? json : '';
}
