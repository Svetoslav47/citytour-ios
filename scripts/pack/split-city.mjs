#!/usr/bin/env node
// City packs: splits the full course packs into one CITY PACK per city plus a small COURSE OVERLAY per course
// (Node 22+ ESM, stdlib only; deterministic and idempotent: no clock, every byte derives from committed files).
//
// Why: every full course pack (data/course/<id>/packs/<id>/, built by 90-emit.mjs) carries the whole city (~4300
// POIs, their narrations, sources and the map); courses differ only in their own tour stops. The city's places are
// now a separately signed download (server: publish-city), and a course carries only its tour.
//
// Inputs (committed):
//   data/city/<cityId>.json                 hand-written city meta: {cityId, names{en,pl,zh}, sourceCourse,
//                                           defaultBounds[minLat,minLng,maxLat,maxLng], properNouns?: string[]}
//   data/course/<id>/packs/<id>/            the full course packs (pipeline output, never modified here)
//   data/course/<id>/demo-walk.json         the SIMULATED Demo walk track (scripts/demo/make-demo-walk.mjs), optional
//   lib/course.mjs COURSE_CITY              which city each course belongs to (explicit map)
//
// Outputs (generated, committed; every file of each folder is generated, stale files are removed):
//   data/city/<cityId>/      CITY PACK: pois.json, narrations/{en,pl,zh}.json, sources.json, map-detail.json
//                            byte-identical to the sourceCourse's full pack (git and the blob store dedupe them),
//                            city.json {schemaVersion, cityId, names, origin, bbox, defaultBounds, properNouns?} and manifest.json
//                            (course-pack manifest format + cityId; version <YYYY.MM.DD of builtAt>-<8 hex>).
//   data/course/<id>/tour/   COURSE OVERLAY: tours/routes/personas.json byte-identical; pois.json = the full pack's
//                            records of the tour stops; narrations/<lang>.json = the stops' narrations; sources.json =
//                            every source those reference; map-detail.json only when it differs from the city's;
//                            demo-walk.json when present; cover.jpg + cover.json (not in the manifest, as before);
//                            manifest.json (packId = courseId, version <full pack version>-t<8 hex>, + cityId).
//
// Usage: node scripts/pack/split-city.mjs           write every city pack and overlay
//        node scripts/pack/split-city.mjs --check   exit 1 when a committed output differs from a fresh split

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { cityOfCourse, COURSE_ROOT } from './lib/course.mjs';
import { isMain, REPO_ROOT } from './lib/http.mjs';

export const CITY_ROOT = join(REPO_ROOT, 'data', 'city');
export const LANGS = Object.freeze(['en', 'pl', 'zh']);
/** Files of the city pack copied byte for byte from the source course's full pack. */
export const CITY_COPY = Object.freeze(['map-detail.json', ...LANGS.map((l) => `narrations/${l}.json`), 'pois.json', 'sources.json']);
/** Files of the overlay copied byte for byte from the course's full pack. */
export const TOUR_COPY = Object.freeze(['personas.json', 'routes.json', 'tours.json']);
export const OVERLAY_DIR = 'tour';
const COVER_FILES = Object.freeze(['cover.jpg', 'cover.json']);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const json = (v) => Buffer.from(JSON.stringify(v), 'utf8');

/** Manifest file entries in the pipeline's shape ({path, bytes, sha256}), sorted by path. */
function fileEntries(files) {
  return files.map((f) => ({ path: f.path, bytes: f.bytes.length, sha256: sha256(f.bytes) })).sort(byPath);
}

/** 8 hex of sha256 over the sorted "path:sha256" lines (the same hash 90-emit.mjs puts into a pack version). */
export function listTag(entries) {
  return sha256(Buffer.from(entries.map((f) => `${f.path}:${f.sha256}`).join('\n'))).slice(0, 8);
}

function readPack(packDir) {
  const mPath = join(packDir, 'manifest.json');
  if (!existsSync(mPath)) throw new Error(`missing ${mPath}`);
  const manifest = JSON.parse(readFileSync(mPath, 'utf8'));
  const shaOf = new Map((manifest.files ?? []).map((f) => [f.path, f.sha256]));
  const read = (p) => {
    const bytes = readFileSync(join(packDir, p));
    const want = shaOf.get(p);
    if (want !== undefined && want !== sha256(bytes)) throw new Error(`${packDir}/${p} does not match its pack manifest`);
    return bytes;
  };
  /** Parses a JSON array file and checks that re-serialising it gives the same bytes (so filtered files keep the style). */
  const records = (p) => {
    const bytes = read(p);
    const list = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(list)) throw new Error(`${packDir}/${p} is not a JSON array`);
    if (!json(list).equals(bytes)) throw new Error(`${packDir}/${p} is not in the pipeline's compact JSON style`);
    return list;
  };
  return { packDir, manifest, read, records };
}

/** The hand-written meta of one city (data/city/<cityId>.json), validated. */
export function readCityMeta(cityId, cityRoot = CITY_ROOT) {
  const meta = JSON.parse(readFileSync(join(cityRoot, `${cityId}.json`), 'utf8'));
  if (meta.cityId !== cityId || !ID_RE.test(cityId)) throw new Error(`data/city/${cityId}.json: cityId must be ${cityId}`);
  for (const l of LANGS) {
    if (typeof meta.names?.[l] !== 'string' || meta.names[l] === '') throw new Error(`data/city/${cityId}.json: names.${l} missing`);
  }
  if (!ID_RE.test(String(meta.sourceCourse))) throw new Error(`data/city/${cityId}.json: bad sourceCourse`);
  const b = meta.defaultBounds;
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite) || b[0] >= b[2] || b[1] >= b[3]) {
    throw new Error(`data/city/${cityId}.json: defaultBounds must be [minLat, minLng, maxLat, maxLng]`);
  }
  const pn = meta.properNouns;
  if (pn !== undefined && (!Array.isArray(pn) || !pn.every((x) => typeof x === 'string' && x.trim() !== ''))) {
    throw new Error(`data/city/${cityId}.json: properNouns must be an array of non-empty strings`);
  }
  return meta;
}

/** City ids with a meta file in data/city (sorted). */
export function listCities(cityRoot = CITY_ROOT) {
  if (!existsSync(cityRoot)) return [];
  return readdirSync(cityRoot).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter((id) => ID_RE.test(id)).sort();
}

/** Course ids that have a full pack and belong to a city (sorted). */
export function listCityCourses(courseRoot = COURSE_ROOT, cityOf = cityOfCourse) {
  if (!existsSync(courseRoot)) return [];
  return readdirSync(courseRoot)
    .filter((id) => ID_RE.test(id) && existsSync(join(courseRoot, id, 'packs', id, 'manifest.json')) && cityOf(id) !== null)
    .sort();
}

/** Builds the city pack in memory: { cityId, files: [{path, bytes}] (incl. manifest.json), manifest }. */
export function buildCity(meta, { courseRoot = COURSE_ROOT } = {}) {
  const src = readPack(join(courseRoot, meta.sourceCourse, 'packs', meta.sourceCourse));
  const sm = src.manifest;
  const files = CITY_COPY.map((p) => ({ path: p, bytes: src.read(p) }));
  const city = {
    schemaVersion: 1,
    cityId: meta.cityId,
    names: { en: meta.names.en, pl: meta.names.pl, zh: meta.names.zh },
    origin: sm.origin,
    bbox: sm.bbox,
    defaultBounds: meta.defaultBounds,
  };
  // Optional: the city-specific proper nouns of the app's NarrationValidator allowlist (the generic part is in the app).
  if (meta.properNouns !== undefined) city.properNouns = meta.properNouns;
  files.push({ path: 'city.json', bytes: json(city) });
  files.sort(byPath);
  const entries = fileEntries(files);
  const manifest = {
    schemaVersion: 1,
    packId: meta.cityId,
    version: `${sm.builtAt.slice(0, 10).replace(/-/g, '.')}-${listTag(entries)}`,
    builtAt: sm.builtAt,
    origin: sm.origin,
    bbox: sm.bbox,
    files: entries,
    counts: {
      pois: sm.counts.pois,
      narrations_en: sm.counts.narrations_en,
      narrations_pl: sm.counts.narrations_pl,
      narrations_zh: sm.counts.narrations_zh,
    },
    licenses: sm.licenses,
    cityId: meta.cityId,
  };
  files.push({ path: 'manifest.json', bytes: json(manifest) });
  return { cityId: meta.cityId, files, manifest };
}

/**
 * Builds the overlay of one course in memory: { courseId, cityId, files (incl. manifest.json and the cover), manifest }.
 * `cityMap` = the bytes of the city's map-detail.json (the overlay keeps its own map only when it differs).
 */
export function buildOverlay(courseId, cityId, cityMap, { courseRoot = COURSE_ROOT } = {}) {
  const pack = readPack(join(courseRoot, courseId, 'packs', courseId));
  const pm = pack.manifest;
  const files = TOUR_COPY.map((p) => ({ path: p, bytes: pack.read(p) }));
  const tours = JSON.parse(pack.read('tours.json').toString('utf8'));
  const stopIds = new Set(tours.flatMap((t) => t.stops.map((s) => s.poiId)));
  const pois = pack.records('pois.json').filter((p) => stopIds.has(p.id));
  for (const id of stopIds) {
    if (!pois.some((p) => p.id === id)) throw new Error(`${courseId}: tour stop ${id} has no POI in the full pack`);
  }
  files.push({ path: 'pois.json', bytes: json(pois) });
  const refs = new Set(pois.flatMap((p) => p.sourceIds ?? []));
  const counts = { pois: pois.length };
  for (const l of LANGS) {
    const list = pack.records(`narrations/${l}.json`).filter((n) => stopIds.has(n.poiId));
    for (const n of list) {
      for (const s of n.sources ?? []) refs.add(s);
      for (const c of n.claims ?? []) if (c.sourceId) refs.add(c.sourceId);
    }
    files.push({ path: `narrations/${l}.json`, bytes: json(list) });
    counts[`narrations_${l}`] = list.length;
  }
  files.push({ path: 'sources.json', bytes: json(pack.records('sources.json').filter((s) => refs.has(s.id))) });
  const map = pack.read('map-detail.json');
  if (!map.equals(cityMap)) files.push({ path: 'map-detail.json', bytes: map });
  const walk = join(courseRoot, courseId, 'demo-walk.json');
  if (existsSync(walk)) files.push({ path: 'demo-walk.json', bytes: readFileSync(walk) });
  files.sort(byPath);
  counts.legs = JSON.parse(pack.read('routes.json').toString('utf8')).legs.length;
  const entries = fileEntries(files);
  const manifest = {
    schemaVersion: 1,
    packId: courseId,
    version: `${pm.version}-t${listTag(entries)}`,
    builtAt: pm.builtAt,
    origin: pm.origin,
    bbox: pm.bbox,
    files: entries,
    counts,
    licenses: pm.licenses,
    cityId,
  };
  if (manifest.version.length > 40) throw new Error(`${courseId}: overlay version ${manifest.version} is longer than 40 chars`);
  files.push({ path: 'manifest.json', bytes: json(manifest) });
  // The cover photo: copied as is, not listed in the manifest (publish-course signs every file of the folder).
  const cover = COVER_FILES.filter((f) => existsSync(join(pack.packDir, f)));
  if (cover.length === 1) throw new Error(`${courseId}: a cover needs both cover.jpg and cover.json`);
  for (const f of cover) files.push({ path: f, bytes: readFileSync(join(pack.packDir, f)) });
  return { courseId, cityId, files, manifest };
}

/** Every city pack and overlay, in memory, with their output folders. */
export function splitAll({ cityRoot = CITY_ROOT, courseRoot = COURSE_ROOT, cityOf = cityOfCourse } = {}) {
  const cities = listCities(cityRoot).map((id) => ({ ...buildCity(readCityMeta(id, cityRoot), { courseRoot }), dir: join(cityRoot, id) }));
  const overlays = listCityCourses(courseRoot, cityOf).map((courseId) => {
    const cityId = cityOf(courseId);
    const city = cities.find((c) => c.cityId === cityId);
    if (!city) throw new Error(`course ${courseId} belongs to city ${cityId}, which has no data/city/${cityId}.json`);
    const cityMap = city.files.find((f) => f.path === 'map-detail.json').bytes;
    return { ...buildOverlay(courseId, cityId, cityMap, { courseRoot }), dir: join(courseRoot, courseId, OVERLAY_DIR) };
  });
  return { cities, overlays };
}

function walkFiles(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p, base));
    else if (e.isFile() && e.name !== '.DS_Store') out.push(relative(base, p).split('\\').join('/'));
  }
  return out.sort();
}

/** Differences between a generated folder in memory and on disk: ["<path>: missing|stale|extra"]. */
export function diffDir(dir, files) {
  const want = new Map(files.map((f) => [f.path, f.bytes]));
  const out = [];
  for (const [p, bytes] of want) {
    const abs = join(dir, p);
    if (!existsSync(abs)) out.push(`${p}: missing`);
    else if (!readFileSync(abs).equals(bytes)) out.push(`${p}: stale`);
  }
  for (const p of walkFiles(dir)) if (!want.has(p)) out.push(`${p}: extra`);
  return out;
}

/** Writes a generated folder: changed files are rewritten, files that are no longer generated are removed. */
export function writeDir(dir, files) {
  const want = new Set(files.map((f) => f.path));
  for (const p of walkFiles(dir)) if (!want.has(p)) rmSync(join(dir, p));
  let written = 0;
  for (const f of files) {
    const abs = join(dir, f.path);
    if (existsSync(abs) && readFileSync(abs).equals(f.bytes)) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.bytes);
    written++;
  }
  return written;
}

const total = (files) => files.reduce((n, f) => n + f.bytes.length, 0);
const fmt = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);

function main(argv) {
  let check = false;
  for (const a of argv) {
    if (a === '--check') check = true;
    else throw new Error(`unknown argument ${a} (expected --check)`);
  }
  const { cities, overlays } = splitAll();
  let bad = 0;
  for (const out of [...cities, ...overlays]) {
    const name = relative(REPO_ROOT, out.dir);
    const label = `${name}: ${out.files.length} files, ${fmt(total(out.files))}, version ${out.manifest.version}`;
    if (check) {
      const d = diffDir(out.dir, out.files);
      if (d.length) {
        bad++;
        console.error(`split-city: ${name} differs from a fresh split (run node scripts/pack/split-city.mjs):\n  ${d.join('\n  ')}`);
      } else {
        console.log(`ok ${label}`);
      }
    } else {
      const n = writeDir(out.dir, out.files);
      console.log(`${label} (${n} written)`);
    }
  }
  return bad ? 1 : 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`split-city: ${e?.stack ?? e}`);
    process.exitCode = 1;
  }
}
