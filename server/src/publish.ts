// Course publishing (docs/SERVER.md §3, §4 "No free-text TTS", §5). Runs on the maintainer's machine only; it is
// the only code that touches the private key. See cli/publish-course.ts for the command line.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicKey, type KeyObject } from 'node:crypto';
import { Envelope, sha256Hex, signPayload, verifyEnvelope } from './canonical.js';
import { COURSE_ID_RE, TtsIndex, writeFileAtomic } from './store.js';

export interface FileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface CourseManifest {
  schemaVersion: 1;
  courseId: string;
  version: string;
  publishedAt: string;
  packId: string;
  files: FileEntry[];
  audio: { manifestPath: string; clips: number };
  allowedTtsSha: string;
  cityId?: string;        // the city pack the course's places come from (absent for a self-contained course)
}

/** Signed `cities/<cityId>/manifest.json`: the city pack's files, paths relative to the city root. */
export interface CityManifest {
  schemaVersion: 1;
  cityId: string;
  version: string;
  publishedAt: string;
  packId: string;
  files: FileEntry[];
}

export interface CitySummary {
  id: string;
  version: string;
  names: { en: string; pl: string; zh: string };
  places: number;         // counts.pois of the city pack
  bytes: number;          // sum of the city files
}

export interface CourseSummary {
  id: string;
  version: string;
  title: { en: string; pl: string; zh: string };
  city: string;
  cityId?: string;        // present when the course's places come from a published city pack
  stops: number;
  km: number;
  minutes: number;
  langs: string[];
  bytes: number;
  coverBlob?: string;     // sha256 of the pack's cover.jpg (served by /v1/blobs/:sha256), absent without a cover
  coverCredit?: string;   // "<author>, <licence>" from the pack's cover.json (shown on the photo before download)
}

export interface Catalog {
  courses: CourseSummary[];
  cities?: CitySummary[];   // absent in catalogs written before city packs
}

export interface PublishOptions {
  courseId: string;
  packDir: string;
  audioDir: string;          // the course audio dir, data/course/<id>/audio (contains manifest.json and <lang>/... clips)
  courseRoot?: string;       // manifest paths are relative to it; default dirname(audioDir) (data/course/<id>)
  cityId?: string;           // the course's city (published first with publishCity): its narrations join the allowed set
  dataDir: string;
  seedDir?: string;
  privateKey: KeyObject;
  systemLinesPath: string;   // scripts/voice/system-lines.mjs
  city?: string;             // catalog display name; default the published city's names.en (required without cityId)
  publishedAt?: string;
  log?: (s: string) => void;
}

export interface PublishResult {
  manifest: CourseManifest;
  summary: CourseSummary;
  allowedCount: number;
  allowedBreakdown: { narration: number; system: number; numeric: number; cityNarration: number };
  clipsNotAllowed: number;
  blobsWritten: number;
  shippedIndexed: number;
}

// The subset of scripts/voice/system-lines.mjs used here (plain JS module, imported at runtime).
interface SystemLinesModule {
  loadPack(packDir: string, tourId: string): unknown;
  enumerateCases(pack: unknown, opts: Record<string, unknown>): unknown[];
  numericCases(names: Record<string, string[]>, opts?: Record<string, unknown>): unknown[];
  stopNames(pack: unknown): Record<string, string[]>;
  linesFromCases(cases: unknown[]): { lang: string; text: string; textSha256: string }[];
}

interface AudioClip {
  lang: string;
  file: string;
  textSha256: string;
  chars: number;
  bytes: number;
  renderedAt?: string;
}

interface Tour {
  id: string;
  titles?: Record<string, string>;
  stops: { poiId: string }[];
  estMinutes?: number;
}

const AUDIO_FILE_RE = /^audio\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

async function readJson<T>(p: string): Promise<T> {
  return JSON.parse(await readFile(p, 'utf8')) as T;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) {
      continue;
    }
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(p)));
    } else if (e.isFile()) {
      out.push(p);
    }
  }
  return out;
}

/** Stores a file as blobs/<sha256> and re-reads the blob to verify it. */
async function putVerified(blobsDir: string, data: Buffer, sha: string): Promise<boolean> {
  const p = join(blobsDir, sha);
  let wrote = false;
  if (!existsSync(p)) {
    await writeFileAtomic(p, data);
    wrote = true;
  }
  if (sha256Hex(await readFile(p)) !== sha) {
    throw new Error(`blob ${sha} failed verification after write`);
  }
  return wrote;
}

/**
 * Course version (docs/SERVER.md §3.1): `<pack version>-a<8 hex of sha256(audio/manifest.json)>`, plus
 * `-c<8 hex>` when the pack has a cover photo, so adding or changing the cover is an update for installed apps.
 */
export function courseVersion(packVersion: string, audioSha: string, coverTag?: string): string {
  return `${packVersion}-a${audioSha.slice(0, 8)}${coverTag ? `-c${coverTag}` : ''}`;
}

export interface CoverInfo {
  sha: string;          // sha256 of cover.jpg
  credit: string;       // "<author>, <licence>"
  versionTag: string;   // 8 hex of sha256(cover.jpg sha + cover.json sha)
}

/** The pack's cover photo, or undefined when it has none. Throws when only one of the two files is there. */
export async function readCover(packDir: string): Promise<CoverInfo | undefined> {
  const jpg = join(packDir, 'cover.jpg');
  const json = join(packDir, 'cover.json');
  if (!existsSync(jpg) && !existsSync(json)) {
    return undefined;
  }
  if (!existsSync(jpg) || !existsSync(json)) {
    throw new Error(`${packDir}: a cover needs both cover.jpg and cover.json`);
  }
  const jsonBytes = await readFile(json);
  const meta = JSON.parse(jsonBytes.toString('utf8')) as { author?: unknown; license?: unknown };
  const author = typeof meta.author === 'string' ? meta.author.trim() : '';
  const license = typeof meta.license === 'string' ? meta.license.trim() : '';
  if (author === '' || license === '') {
    throw new Error(`${packDir}/cover.json: author and license are required`);
  }
  const sha = sha256Hex(await readFile(jpg));
  return {
    sha,
    credit: `${author}, ${license}`,
    versionTag: sha256Hex(Buffer.from(`${sha}:${sha256Hex(jsonBytes)}`, 'utf8')).slice(0, 8)
  };
}

export function bucketKm(m: number): number {
  return Math.round(m / 100) / 10;
}

const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function addSentences(set: Set<string>, list: { sentences?: string[] }[]): void {
  for (const n of list) {
    for (const s of n.sentences ?? []) {
      if (s.length > 0) {
        set.add(sha256Hex(Buffer.from(s, 'utf8')));
      }
    }
  }
}

interface PackManifestFile {
  packId: string;
  version: string;
  files?: FileEntry[];
  counts?: { pois?: number };
}

/**
 * Stores every file of a pack folder as a verified blob. Files listed in the folder's own manifest.json must match
 * its sha256 and must all exist; unlisted files (manifest.json itself, the cover) are signed as they are.
 * Returns the entries with `prefix` + the path inside the folder, sorted by path.
 */
async function putPackFolder(packDir: string, blobsDir: string, prefix: string):
  Promise<{ manifest: PackManifestFile; files: FileEntry[]; blobsWritten: number }> {
  const manifest = await readJson<PackManifestFile>(join(packDir, 'manifest.json'));
  if (!/^[a-z0-9-]{1,64}$/.test(manifest.packId)) {
    throw new Error(`bad packId ${manifest.packId}`);
  }
  const expected = new Map((manifest.files ?? []).map((f) => [f.path, f.sha256]));
  const files: FileEntry[] = [];
  let blobsWritten = 0;
  for (const abs of (await walk(packDir)).sort()) {
    const rel = relative(packDir, abs).split(sep).join('/');
    const data = await readFile(abs);
    const sha = sha256Hex(data);
    const want = expected.get(rel);
    if (want !== undefined && want !== sha) {
      throw new Error(`pack file ${rel}: sha256 ${sha} != pack manifest ${want}`);
    }
    if (await putVerified(blobsDir, data, sha)) {
      blobsWritten++;
    }
    files.push({ path: `${prefix}${rel}`, sha256: sha, bytes: data.length });
  }
  for (const p of expected.keys()) {
    if (!files.some((f) => f.path === `${prefix}${p}`)) {
      throw new Error(`pack manifest lists ${p} but the file is missing`);
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { manifest, files, blobsWritten };
}

/** Re-signs `<root>/catalog.json` after `edit`, starting from `<from>/catalog.json` (courses and cities preserved). */
async function updateCatalog(root: string, from: string, key: KeyObject, edit: (c: Catalog) => void): Promise<void> {
  const catPath = join(from, 'catalog.json');
  const prev = existsSync(catPath) ? (await readJson<Envelope<Catalog>>(catPath)).payload : { courses: [] };
  const cat: Catalog = { courses: [...(prev.courses ?? [])] };
  if (prev.cities !== undefined) {
    cat.cities = [...prev.cities];
  }
  edit(cat);
  await writeFileAtomic(join(root, 'catalog.json'), JSON.stringify(signPayload<Catalog>(cat, key)));
}

interface PublishedCity {
  cityId: string;
  version: string;
  names: { en: string; pl: string; zh: string };
  narrations: { sentences?: string[] }[][];
}

/** A city already published into dataDir: its signed manifest (verified with the publishing key) and narrations. */
async function readPublishedCity(dataDir: string, cityId: string, key: KeyObject): Promise<PublishedCity> {
  if (!COURSE_ID_RE.test(cityId)) {
    throw new Error(`bad city id ${cityId}`);
  }
  const p = join(dataDir, 'cities', cityId, 'manifest.json');
  if (!existsSync(p)) {
    throw new Error(`city ${cityId} is not published in ${dataDir}: publish the city first (npm run publish-city -- --city ${cityId} ...)`);
  }
  const env = await readJson<Envelope<CityManifest>>(p);
  if (!verifyEnvelope(env, createPublicKey(key))) {
    throw new Error(`${p}: signature does not verify with this signing key (publish the city again with the same key)`);
  }
  const m = env.payload;
  const blob = async (f: FileEntry): Promise<Buffer> => {
    const data = await readFile(join(dataDir, 'blobs', f.sha256));
    if (sha256Hex(data) !== f.sha256) {
      throw new Error(`city ${cityId}: blob of ${f.path} does not match its sha256`);
    }
    return data;
  };
  const cityJson = m.files.find((f) => f.path === 'city.json');
  if (!cityJson) {
    throw new Error(`city ${cityId}: the manifest has no city.json`);
  }
  const meta = JSON.parse((await blob(cityJson)).toString('utf8')) as { names: PublishedCity['names'] };
  const narrations: PublishedCity['narrations'] = [];
  for (const f of m.files.filter((x) => /^narrations\/[a-z]{2}\.json$/.test(x.path))) {
    narrations.push(JSON.parse((await blob(f)).toString('utf8')) as { sentences?: string[] }[]);
  }
  return { cityId, version: m.version, names: meta.names, narrations };
}

export interface PublishCityOptions {
  cityId: string;
  packDir: string;          // the city pack folder, data/city/<cityId>
  dataDir: string;
  seedDir?: string;
  privateKey: KeyObject;
  publishedAt?: string;
  log?: (s: string) => void;
}

export interface PublishCityResult {
  manifest: CityManifest;
  summary: CitySummary;
  blobsWritten: number;
}

/**
 * Publishes a city pack (docs/SERVER.md §3.1 "City packs"): every file of the folder as a verified blob, the signed
 * `cities/<cityId>/manifest.json` and the city's entry in the catalog's `cities` (courses are kept). Re-publishing
 * an unchanged city keeps its publishedAt, so the signed files stay byte-identical.
 */
export async function publishCity(o: PublishCityOptions): Promise<PublishCityResult> {
  const log = o.log ?? (() => undefined);
  if (!COURSE_ID_RE.test(o.cityId)) {
    throw new Error(`bad city id ${o.cityId}`);
  }
  const blobsDir = join(o.dataDir, 'blobs');
  await mkdir(blobsDir, { recursive: true });
  const pack = await putPackFolder(o.packDir, blobsDir, '');
  const pm = pack.manifest as PackManifestFile & { cityId?: string };
  if (pm.cityId !== undefined && pm.cityId !== o.cityId) {
    throw new Error(`${o.packDir} is the city pack of ${pm.cityId}, not ${o.cityId}`);
  }
  const cityJson = join(o.packDir, 'city.json');
  if (!existsSync(cityJson)) {
    throw new Error(`${o.packDir} has no city.json (build it with node scripts/pack/split-city.mjs)`);
  }
  const meta = await readJson<{ cityId?: string; names?: Partial<CitySummary['names']> }>(cityJson);
  const names = meta.names ?? {};
  if (meta.cityId !== o.cityId || !names.en || !names.pl || !names.zh) {
    throw new Error(`${cityJson}: cityId must be ${o.cityId} and names need en, pl and zh`);
  }
  log(`city pack ${pm.packId} ${pm.version}: ${pack.files.length} files verified`);

  const sameAsBefore = async (root: string): Promise<string | undefined> => {
    const p = join(root, 'cities', o.cityId, 'manifest.json');
    if (!existsSync(p)) {
      return undefined;
    }
    const prev = (await readJson<Envelope<CityManifest>>(p)).payload;
    return prev.version === pm.version && JSON.stringify(prev.files) === JSON.stringify(pack.files) ? prev.publishedAt : undefined;
  };
  const publishedAt = o.publishedAt ?? (await sameAsBefore(o.dataDir)) ?? new Date().toISOString();
  const manifest: CityManifest = {
    schemaVersion: 1, cityId: o.cityId, version: pm.version, publishedAt, packId: pm.packId, files: pack.files
  };
  const env = JSON.stringify(signPayload(manifest, o.privateKey));
  const summary: CitySummary = {
    id: o.cityId,
    version: pm.version,
    names: { en: names.en, pl: names.pl, zh: names.zh },
    places: pm.counts?.pois ?? 0,
    bytes: pack.files.reduce((n, f) => n + f.bytes, 0)
  };
  for (const root of o.seedDir ? [o.dataDir, o.seedDir] : [o.dataDir]) {
    await mkdir(join(root, 'cities', o.cityId), { recursive: true });
    await writeFileAtomic(join(root, 'cities', o.cityId, 'manifest.json'), env);
    await updateCatalog(root, root, o.privateKey, (cat) => {
      cat.cities = (cat.cities ?? []).filter((c) => c.id !== o.cityId);
      cat.cities.push(summary);
      cat.cities.sort(byId);
    });
  }
  log(`city ${o.cityId} ${pm.version}: ${pack.files.length} files, ${summary.bytes} bytes, ${summary.places} places`);
  return { manifest, summary, blobsWritten: pack.blobsWritten };
}

export async function publishCourse(o: PublishOptions): Promise<PublishResult> {
  const log = o.log ?? (() => undefined);
  if (!COURSE_ID_RE.test(o.courseId)) {
    throw new Error(`bad course id ${o.courseId}`);
  }
  const blobsDir = join(o.dataDir, 'blobs');
  await mkdir(blobsDir, { recursive: true });
  await mkdir(join(o.dataDir, 'courses', o.courseId), { recursive: true });

  // ---- the city (published first): its narrations join the allowed set, its name is the catalog's city
  const city = o.cityId !== undefined ? await readPublishedCity(o.dataDir, o.cityId, o.privateKey) : undefined;
  const cityName = o.city ?? city?.names.en;
  if (cityName === undefined) {
    throw new Error('a city display name is needed: pass city (--city) or cityId (--city-id)');
  }

  // ---- pack files, under the pack folder's path relative to the course root (packs/<packId>/... or tour/...)
  const courseRoot = o.courseRoot ?? dirname(o.audioDir);
  const prefix = relative(courseRoot, o.packDir).split(sep).join('/');
  if (prefix === '' || prefix.startsWith('..') || isAbsolute(prefix) || !/^[A-Za-z0-9_.\/-]+$/.test(prefix)) {
    throw new Error(`the pack folder ${o.packDir} is not inside the course root ${courseRoot}`);
  }
  const pack = await putPackFolder(o.packDir, blobsDir, `${prefix}/`);
  const packManifest = pack.manifest;
  const packId = packManifest.packId;
  const files: FileEntry[] = pack.files;
  let blobsWritten = pack.blobsWritten;
  log(`pack ${packId} ${packManifest.version}: ${files.length} files verified (${prefix}/)`);

  // ---- audio manifest + clips (paths relative to the course root, as the clip manifest writes them)
  const audioManifestBytes = await readFile(join(o.audioDir, 'manifest.json'));
  const audioManifest = JSON.parse(audioManifestBytes.toString('utf8')) as { clips?: AudioClip[] };
  const clips = audioManifest.clips ?? [];
  const audioSha = sha256Hex(audioManifestBytes);
  if (await putVerified(blobsDir, audioManifestBytes, audioSha)) {
    blobsWritten++;
  }
  files.push({ path: 'audio/manifest.json', sha256: audioSha, bytes: audioManifestBytes.length });
  const shipped: TtsIndex = {};
  const seenClip = new Set<string>();
  for (const c of clips) {
    if (!AUDIO_FILE_RE.test(c.file) || c.file.includes('..')) {
      throw new Error(`bad clip path ${c.file}`);
    }
    const data = await readFile(join(o.audioDir, c.file.slice('audio/'.length)));
    if (data.length !== c.bytes) {
      throw new Error(`clip ${c.file}: ${data.length} bytes != manifest ${c.bytes}`);
    }
    const sha = sha256Hex(data);
    if (await putVerified(blobsDir, data, sha)) {
      blobsWritten++;
    }
    if (!seenClip.has(c.file)) {
      seenClip.add(c.file);
      files.push({ path: c.file, sha256: sha, bytes: data.length });
    }
    shipped[c.textSha256] = {
      blob: sha, chars: c.chars, lang: c.lang, source: 'shipped', renderedAt: c.renderedAt ?? ''
    };
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  log(`audio: manifest + ${seenClip.size} clips verified`);

  // ---- allowed-lines set
  const narration = new Set<string>();
  const narrDir = join(o.packDir, 'narrations');
  for (const f of existsSync(narrDir) ? (await readdir(narrDir)).filter((x) => x.endsWith('.json')).sort() : []) {
    addSentences(narration, await readJson<{ sentences?: string[] }[]>(join(narrDir, f)));
  }
  let cityNarration = 0;
  if (city) {
    // The app plays the city's places with this course's courseId, so their sentences are allowed too.
    const before = narration.size;
    for (const list of city.narrations) {
      addSentences(narration, list);
    }
    cityNarration = narration.size - before;
    log(`city ${city.cityId} ${city.version}: ${cityNarration} narration sentences allowed that the course pack does not have`);
  }
  const sl = (await import(pathToFileURL(o.systemLinesPath).href)) as SystemLinesModule;
  const toursRaw = await readJson<Tour[] | { tours: Tour[] }>(join(o.packDir, 'tours.json'));
  const tours = Array.isArray(toursRaw) ? toursRaw : toursRaw.tours;
  if (!tours || tours.length === 0) {
    throw new Error('no tours in tours.json');
  }
  const system = new Set<string>();
  const numeric = new Set<string>();
  for (const t of tours) {
    const pack = sl.loadPack(o.packDir, t.id);
    for (const l of sl.linesFromCases(sl.enumerateCases(pack, { navLegs: 'all' }))) {
      system.add(l.textSha256);
    }
    for (const l of sl.linesFromCases(sl.numericCases(sl.stopNames(pack)))) {
      numeric.add(l.textSha256);
    }
  }
  const allowedList = [...new Set([...narration, ...system, ...numeric])].sort();
  const allowedSet = new Set(allowedList);
  const clipsNotAllowed = Object.keys(shipped).filter((s) => !allowedSet.has(s)).length;
  const allowedBytes = Buffer.from(JSON.stringify(allowedList), 'utf8');
  log(`allowed lines: ${allowedList.length} (narration ${narration.size}, system ${system.size}, numeric ${numeric.size})`);

  // ---- cover photo (scripts/pack/lib/cover.mjs: packs/<id>/cover.jpg + cover.json, already signed into `files`)
  const cover = await readCover(o.packDir);
  if (cover) {
    log(`cover ${cover.sha.slice(0, 12)} (${cover.credit})`);
  }

  // ---- manifest
  const version = courseVersion(packManifest.version, audioSha, cover?.versionTag);
  const manifest: CourseManifest = {
    schemaVersion: 1,
    courseId: o.courseId,
    version,
    publishedAt: o.publishedAt ?? new Date().toISOString(),
    packId,
    files,
    audio: { manifestPath: 'audio/manifest.json', clips: seenClip.size },
    allowedTtsSha: sha256Hex(allowedBytes)
  };
  if (o.cityId !== undefined) {
    manifest.cityId = o.cityId;
  }
  const manifestEnv = signPayload(manifest, o.privateKey);

  // ---- catalog summary (the first tour of the pack is the course's tour)
  const tour = tours[0] as Tour;
  const routes = existsSync(join(o.packDir, 'routes.json')) ?
    await readJson<{ legs?: { fromPoiId: string; toPoiId: string; distanceM: number }[] }>(join(o.packDir, 'routes.json')) :
    { legs: [] };
  let meters = 0;
  for (let i = 0; i + 1 < tour.stops.length; i++) {
    const a = tour.stops[i]?.poiId;
    const b = tour.stops[i + 1]?.poiId;
    const leg = (routes.legs ?? []).find((l) => l.fromPoiId === a && l.toPoiId === b);
    meters += leg ? leg.distanceM : 0;
  }
  const langs = existsSync(narrDir) ?
    (await readdir(narrDir)).filter((x) => /^[a-z]{2}\.json$/.test(x)).map((x) => x.slice(0, 2)).sort() : [];
  const titles = tour.titles ?? {};
  const summary: CourseSummary = {
    id: o.courseId,
    version,
    title: { en: titles.en ?? tour.id, pl: titles.pl ?? titles.en ?? tour.id, zh: titles.zh ?? titles.en ?? tour.id },
    city: cityName,
    stops: tour.stops.length,
    km: bucketKm(meters),
    minutes: tour.estMinutes ?? Math.round(meters / 1.3 / 60),
    langs,
    bytes: files.reduce((n, f) => n + f.bytes, 0)
  };
  if (cover) {
    summary.coverBlob = cover.sha;
    summary.coverCredit = cover.credit;
  }
  if (o.cityId !== undefined) {
    summary.cityId = o.cityId;
  }

  // ---- write the data dir: allowed, manifest, catalog, tts-index (shipped clips pre-seeded: never cost credits)
  const writeCourse = async (root: string, catalogFrom: string): Promise<void> => {
    await mkdir(join(root, 'courses', o.courseId), { recursive: true });
    await writeFileAtomic(join(root, 'courses', o.courseId, 'allowed.json'), allowedBytes);
    await writeFileAtomic(join(root, 'courses', o.courseId, 'manifest.json'), JSON.stringify(manifestEnv));
    await updateCatalog(root, catalogFrom, o.privateKey, (cat) => {
      cat.courses = cat.courses.filter((c) => c.id !== o.courseId);
      cat.courses.push(summary);
      cat.courses.sort(byId);
    });
    const idxPath = join(root, 'tts-index.json');
    const idx: TtsIndex = existsSync(idxPath) ? await readJson<TtsIndex>(idxPath) : {};
    for (const [k, e] of Object.entries(shipped)) {
      if (!(idx[k] && idx[k].source === 'runtime')) {
        idx[k] = e;
      }
    }
    await writeFileAtomic(idxPath, JSON.stringify(idx));
  };
  await writeCourse(o.dataDir, o.dataDir);
  if (o.seedDir) {
    await mkdir(o.seedDir, { recursive: true });
    await writeCourse(o.seedDir, o.seedDir);
    log(`seed metadata written to ${o.seedDir}`);
  }
  const st = await stat(join(o.dataDir, 'courses', o.courseId, 'manifest.json'));
  log(`course ${o.courseId} ${version}: ${files.length} files, ${summary.bytes} bytes, manifest ${st.size} bytes`);
  return {
    manifest, summary, allowedCount: allowedList.length,
    allowedBreakdown: { narration: narration.size, system: system.size, numeric: numeric.size, cityNarration },
    clipsNotAllowed, blobsWritten, shippedIndexed: Object.keys(shipped).length
  };
}
