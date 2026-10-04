#!/usr/bin/env node
// Stage 9: builds the offline pack of one course and writes it to data/course/<courseId>/packs/<courseId>/
// (default course krakow = The Royal Route; --course krakow-scholars etc., see scripts/pack/lib/course.mjs)
// (course data for the server; the app bundles no course and downloads it).
// Runs stages 4, 6, 7 and 8 in one process (Node 22+ ESM, stdlib only). Reads ONLY committed files
// (data/raw/**, data/tours/royal-route.json); the network is disabled for the whole run.
//
// Output (docs/ARCHITECTURE.md §7.2; every record is checked against contracts/Model.ets via schema.mjs):
//   manifest.json          PackManifest; files[] = every other pack file with bytes + sha256 (NOT validation-report.json)
//   pois.json              Poi[] sorted by id
//   tours.json             Tour[] (review-only keys of royal-route.json dropped)
//   personas.json          Persona[] (the Historian)
//   sources.json           SourceRef[] sorted by id
//   routes.json            RouteData (65-routes.mjs)
//   map-detail.json        MapData level "detail" (60-mapdata.mjs) of the tour's `mapArea` (MAP_AREAS; default oldtown)
//   narrations/{en,pl,zh}.json  Narration[] of that language, sorted by id, validated (80-validate.mjs)
//   validation-report.json build report of the validator (counts per tier/lang, failures, summary); shipped
//                          next to the pack for transparency but not listed in manifest.files
// Determinism: no clock (builtAt = the newest retrieval time in data/raw/SOURCES.md), stable sorts, fixed
// number formatting, compact JSON with a fixed key order. Two runs give byte-identical files.
//
// Hook for task B7: if scripts/pack/70-narrate.mjs exists and exports narrationDrafts(ctx) -> Narration[]
// (reviewed / grounded-ai / mt drafts), each draft is tried before the extract and name-only candidates of the
// same narration id; a failing draft falls back and is reported (and printed loudly).
//
// Usage: node scripts/pack/90-emit.mjs [--course <courseId> | --tour <tourId>] [--out DIR]   (build-pack.sh is the entry point)

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { isMain, RAW_DIR, readSnapshot, REPO_ROOT } from './lib/http.mjs';
import { resolveCourse, takeCourseArgs } from './lib/course.mjs';
import { copyCover } from './lib/cover.mjs';
import { assertRecords, checkRecord, LANGS, SCHEMA_VERSION, TIER_ORDER } from './schema.mjs';
import { PACK_ORIGIN } from './projection.mjs';
import {
  inceptionYear, mergePois, orderedText, registerIndex, SOURCE_ID_REGISTER, SOURCE_ID_UNESCO, unescoCore, wdSourceId, wpSourceId,
} from './40-merge-pois.mjs';
import { buildMapDetail, MAP_AREAS, parseOsm } from './60-mapdata.mjs';
import { buildRoutes } from './65-routes.mjs';
import { buildCandidates, PERSONA_ID } from './75-extract-narrations.mjs';
import { buildReport, selectNarration, VALIDATOR_VERSION } from './80-validate.mjs';

export const DEFAULT_COURSE = resolveCourse();
export const PACK_ID = DEFAULT_COURSE.packId;
export const DEFAULT_OUT = DEFAULT_COURSE.packDir;
export const NARRATE_HOOK = join(REPO_ROOT, 'scripts', 'pack', '70-narrate.mjs');
const ARCGIS_SERVICES = 'https://services-eu1.arcgis.com/svTzSt3AvH7sK6q9/ArcGIS/rest/services';
const KRAKOW_PUBLISHER = 'City of Kraków (Gmina Miejska Kraków), Zintegrowana Platforma GIS';
const KRAKOW_LICENSE = 'UNVERIFIED (City of Kraków open data)';

export const PERSONAS = Object.freeze([
  {
    id: 'historian',
    names: { en: 'The Historian', pl: 'Historyk', zh: '历史学家' },
    voices: [{ lang: 'en', person: 8 }, { lang: 'zh', person: 13 }],
    speed: 1,
    pitch: 1,
  },
]);

export const LICENSES = Object.freeze([
  'Map data © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)',
  'Walking routes: OSRM (FOSSGIS routing.openstreetmap.de) on OpenStreetMap data, ODbL 1.0',
  'Texts from Wikipedia, Wikipedia contributors, CC BY-SA 4.0 (article and revision in sources.json)',
  'Place data from Wikidata, CC0 1.0',
  'UNESCO zone and heritage register numbers: City of Kraków (Gmina Miejska Kraków), Zintegrowana Platforma GIS; licence UNVERIFIED',
]);

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** builtAt: the newest ISO-8601 UTC timestamp written in data/raw/SOURCES.md (never the clock). */
export function builtAtFromSources(md) {
  const ts = [...md.matchAll(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\b/g)].map((m) => m[1]).sort();
  if (!ts.length) throw new Error('data/raw/SOURCES.md has no retrieval timestamps');
  return ts[ts.length - 1];
}

/** Newest gzip header MTIME of the OSM tiles (the lead's fetch time, per SOURCES.md) as ISO UTC. */
export function gzipMtimeIso(buffers) {
  const t = Math.max(...buffers.map((b) => b.readUInt32LE(4)));
  return new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Tour (contracts) from data/tours/royal-route.json: only contract keys, in contract order. */
export function tourFromCurated(t) {
  const tour = {
    id: t.id,
    personaId: t.personaId,
    titles: orderedText(t.titles),
    summaries: orderedText(t.summaries),
    stops: t.stops.map((s) => {
      const stop = { poiId: s.poiId, dwellS: s.dwellS, prize: s.prize };
      if (s.triggerRadiusM !== undefined) stop.triggerRadiusM = s.triggerRadiusM;
      if (s.approachRadiusM !== undefined) stop.approachRadiusM = s.approachRadiusM;
      return stop;
    }),
  };
  if (t.fixedStartPoiId) tour.fixedStartPoiId = t.fixedStartPoiId;
  if (t.fixedEndPoiId) tour.fixedEndPoiId = t.fixedEndPoiId;
  tour.estMinutes = t.estMinutes;
  return tour;
}

function sourceRef(id, title, url, publisher, license, retrievedAt, lang) {
  return { id, title, url, publisher, license, retrievedAt, lang };
}

function permalink(url, rev) {
  return rev ? `${url}${url.includes('?') ? '&' : '?'}oldid=${rev}` : url;
}

/**
 * Reads every committed input of one course (default: krakow). Shared snapshots come from data/raw; the tour file,
 * its OSRM snapshots and its wiki stop texts are the course's own (lib/course.mjs). A non-default course appends its
 * data/raw/tours/<tourId>/SOURCES.md to sourcesMd, so its retrieval times count for builtAt.
 */
export function loadInputs(rawDir = RAW_DIR, course = DEFAULT_COURSE) {
  const wiki = { summaries: {}, stopTexts: {} };
  for (const lang of LANGS) {
    wiki.summaries[lang] = readSnapshot(`wiki/summaries-${lang}.json`);
    wiki.stopTexts[lang] = readSnapshot(course.rawRel(`wiki/stops-text-${lang}.json`));
  }
  let sourcesMd = readFileSync(join(rawDir, 'SOURCES.md'), 'utf8');
  if (course.sourcesMd) sourcesMd += `\n${readFileSync(course.sourcesMd, 'utf8')}`;
  const tourRaw = JSON.parse(readFileSync(course.tourFile, 'utf8'));
  // The map area of the course (tour key `mapArea`, review-only; default the Old Town of the Royal Route).
  const mapArea = tourRaw.mapArea ?? 'oldtown';
  if (!MAP_AREAS[mapArea]) throw new Error(`${course.tourFile}: unknown mapArea ${mapArea} (known: ${Object.keys(MAP_AREAS).join(', ')})`);
  const tileBuffers = MAP_AREAS[mapArea].map((rel) => readFileSync(join(rawDir, rel)));
  return {
    course,
    sourcesMd,
    tourRaw,
    mapArea,
    wd: readSnapshot('wikidata/krakow-items.json'),
    unesco: readSnapshot('arcgis/unesco.geojson'),
    register: readSnapshot('arcgis/eoz-zabytki-zbiorcza-polygon.geojson'),
    wiki,
    table: readSnapshot(course.rawRel('osrm/stops-table-foot.json')),
    pairs: readSnapshot(course.rawRel('osrm/stop-pairs-foot.json')),
    osmXml: tileBuffers.map((b) => gunzipSync(b).toString('utf8')),
    osmFetchedAt: gzipMtimeIso(tileBuffers),
  };
}

/** Builds every pack file in memory. Returns { files: [{path, json}], report, counts, info }. */
export async function buildPack(inputs, { hookPath = NARRATE_HOOK } = {}) {
  const builtAt = builtAtFromSources(inputs.sourcesMd);
  const { wd, tourRaw, wiki } = inputs;
  const course = inputs.course ?? DEFAULT_COURSE;
  const itemByQid = new Map(wd.items.map((i) => [i.qid, i]));

  // Stage 4: POIs
  const register = registerIndex(inputs.register);
  const merged = mergePois({
    items: wd.items,
    tour: tourRaw,
    unesco: unescoCore(inputs.unesco),
    register,
    wikiPages: Object.fromEntries(LANGS.map((l) => [l, wiki.summaries[l].pages])),
  });
  const pois = merged.pois;
  const stopIds = new Set(merged.stopIds);

  // Sources
  const sources = new Map();
  const sourceTexts = {};
  const addText = (id, t) => {
    if (typeof t === 'string' && t.length) sourceTexts[id] = sourceTexts[id] ? `${sourceTexts[id]}\n${t}` : t;
  };
  for (const p of pois) {
    const item = itemByQid.get(p.wikidataId);
    sources.set(wdSourceId(item.qid), sourceRef(wdSourceId(item.qid), `${item.labels.en ?? item.labels.pl ?? p.names.pl} (Wikidata ${item.qid})`,
      `https://www.wikidata.org/wiki/${item.qid}`, 'Wikidata', 'CC0', wd.meta.retrievedAt, 'en'));
    for (const lang of LANGS) {
      const s = wiki.summaries[lang].pages[item.qid];
      if (!s) continue;
      const id = wpSourceId(lang, item.qid);
      sources.set(id, sourceRef(id, s.title, permalink(s.url, s.revision), 'Wikipedia', 'CC BY-SA 4.0', wiki.summaries[lang].meta.retrievedAt, lang));
      addText(id, s.extract);
    }
  }
  const stopSourceId = (lang, qid) => {
    const s = wiki.summaries[lang].pages[qid];
    const t = wiki.stopTexts[lang].pages[qid];
    return s && String(s.revision) === String(t.revid) ? wpSourceId(lang, qid) : `${wpSourceId(lang, qid)}_r${t.revid}`;
  };
  for (const lang of LANGS) {
    for (const [qid, t] of Object.entries(wiki.stopTexts[lang].pages)) {
      const id = stopSourceId(lang, qid);
      if (!sources.has(id)) {
        sources.set(id, sourceRef(id, t.title, permalink(t.url, t.revid), 'Wikipedia', 'CC BY-SA 4.0', wiki.stopTexts[lang].meta.retrievedAt, lang));
      }
      addText(id, t.text);
    }
  }
  sources.set(SOURCE_ID_UNESCO, sourceRef(SOURCE_ID_UNESCO, 'UNESCO World Heritage zone, Historic Centre of Kraków (UNESCO_4f365)',
    `${ARCGIS_SERVICES}/UNESCO_4f365/FeatureServer/0`, KRAKOW_PUBLISHER, KRAKOW_LICENSE, inputs.unesco.meta.retrievedAt, 'pl'));
  sources.set(SOURCE_ID_REGISTER, sourceRef(SOURCE_ID_REGISTER, 'Gminna ewidencja zabytków, warstwa zbiorcza (EOZ_Zabytki)',
    `${ARCGIS_SERVICES}/EOZ_Zabytki___Warstwa_zbiorcza___AKTUALNA/FeatureServer/1`, KRAKOW_PUBLISHER, KRAKOW_LICENSE,
    inputs.register.meta.retrievedAt, 'pl'));
  const mapArea = inputs.mapArea ?? 'oldtown';
  const osmSourceId = `osm_${mapArea}`;
  sources.set(osmSourceId, sourceRef(osmSourceId, mapArea === 'oldtown' ? 'OpenStreetMap map data, Kraków Old Town (OSM API, 9 tiles)'
    : `OpenStreetMap map data, Kraków ${mapArea[0].toUpperCase()}${mapArea.slice(1)} (OSM API, ${MAP_AREAS[mapArea].length} tiles)`,
    'https://www.openstreetmap.org/copyright', 'OpenStreetMap contributors', 'ODbL 1.0', inputs.osmFetchedAt, 'en'));
  sources.set('osrm_foot', sourceRef('osrm_foot', `OSRM foot routes between the ${course.legacy ? 'Royal Route' : tourRaw.titles.en} stops (FOSSGIS demo server)`,
    'https://routing.openstreetmap.de/routed-foot', 'OSRM, FOSSGIS e.V.', 'ODbL 1.0 (derived from OSM)', inputs.pairs.meta.retrievedAt, 'en'));
  const sourceList = [...sources.values()].sort(byId);
  const sourceIds = new Set(sources.keys());

  // Stage 7 + 8: narration candidates, validation, fallback
  const years = new Map(pois.map((p) => [p.id, inceptionYear(itemByQid.get(p.wikidataId))]));
  const candidates = buildCandidates({ pois, stopIds, wiki: { ...wiki, stopSourceId }, years, wdAt: wd.meta.retrievedAt, wpSourceId });
  let drafts = [];
  if (hookPath && existsSync(hookPath)) {
    const hook = await import(pathToFileURL(hookPath).href);
    if (typeof hook.narrationDrafts === 'function') {
      drafts = (await hook.narrationDrafts({ pois, sources: sourceList, sourceTexts, stopIds, rawDir: RAW_DIR, builtAt, reviewDir: course.reviewDir })) ?? [];
    }
  }
  const draftsById = new Map();
  for (const d of drafts) {
    if (!draftsById.has(d.id)) draftsById.set(d.id, []);
    draftsById.get(d.id).push(d);
  }
  const ids = [...new Set([...candidates.keys(), ...draftsById.keys()])].sort();
  const poiById = new Map(pois.map((p) => [p.id, p]));
  const results = [];
  const narrations = Object.fromEntries(LANGS.map((l) => [l, []]));
  for (const id of ids) {
    const chain = [...(draftsById.get(id) ?? []).sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier)), ...(candidates.get(id) ?? [])];
    const poi = poiById.get(chain[0]?.poiId);
    const ctx = { sourceIds, poiNames: poi ? Object.values(poi.names) : [], sourceTexts };
    const r = selectNarration(chain, ctx);
    results.push({ id, attempts: r.attempts, narration: r.narration });
    if (r.narration) narrations[r.narration.lang].push(r.narration);
  }
  const report = buildReport(results);
  const loud = report.failures.filter((f) => f.tier === 'reviewed' || f.tier === 'grounded-ai');
  for (const f of loud) console.error(`WARNING: ${f.tier} narration ${f.id} failed ${f.failed.join(',')}; emitted ${f.emittedTier ?? 'nothing'}`);

  // POI tier = best tier among its emitted narrations
  const best = new Map();
  for (const lang of LANGS) {
    for (const n of narrations[lang]) {
      const cur = best.get(n.poiId);
      if (!cur || TIER_ORDER.indexOf(n.tier) < TIER_ORDER.indexOf(cur)) best.set(n.poiId, n.tier);
    }
  }
  for (const p of pois) p.tier = best.get(p.id) ?? 'name-only';

  // Stage 6: routes and map
  const tour = tourFromCurated(tourRaw);
  const routes = buildRoutes({ table: inputs.table, pairs: inputs.pairs, tour: tourRaw });
  const { map, stats: mapStats } = buildMapDetail({ osm: parseOsm(inputs.osmXml), unescoGeojson: inputs.unesco });

  // Schema checks (contracts/Model.ets)
  assertRecords('Poi', pois, 'pois');
  assertRecords('Tour', [tour], 'tours');
  assertRecords('Persona', PERSONAS, 'personas');
  assertRecords('SourceRef', sourceList, 'sources');
  assertRecords('RouteData', [routes], 'routes');
  assertRecords('MapData', [map], 'map-detail');
  for (const lang of LANGS) assertRecords('Narration', narrations[lang], `narrations/${lang}`);
  for (const s of tour.stops) if (!poiById.has(s.poiId)) throw new Error(`tour stop ${s.poiId} has no POI`);
  for (const p of pois) for (const id of p.sourceIds) if (!sourceIds.has(id)) throw new Error(`${p.id}: unknown source ${id}`);

  const lats = pois.map((p) => p.lat);
  const lngs = pois.map((p) => p.lng);
  const files = [
    { path: 'pois.json', json: pois },
    { path: 'tours.json', json: [tour] },
    { path: 'personas.json', json: PERSONAS },
    { path: 'sources.json', json: sourceList },
    { path: 'routes.json', json: routes },
    { path: 'map-detail.json', json: map },
    ...LANGS.map((l) => ({ path: `narrations/${l}.json`, json: narrations[l] })),
  ].map((f) => ({ path: f.path, bytes: Buffer.from(JSON.stringify(f.json), 'utf8') }));
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const packFiles = files.map((f) => ({ path: f.path, bytes: f.bytes.length, sha256: sha256(f.bytes) }));
  const counts = {
    pois: pois.length,
    narrations_en: narrations.en.length,
    narrations_pl: narrations.pl.length,
    narrations_zh: narrations.zh.length,
    legs: routes.legs.length,
  };
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    packId: course.packId,
    version: `${builtAt.slice(0, 10).replace(/-/g, '.')}-${sha256(Buffer.from(packFiles.map((f) => `${f.path}:${f.sha256}`).join('\n'))).slice(0, 8)}`,
    builtAt,
    origin: { lat: PACK_ORIGIN.lat, lng: PACK_ORIGIN.lng },
    bbox: [floor6(Math.min(...lats)), floor6(Math.min(...lngs)), ceil6(Math.max(...lats)), ceil6(Math.max(...lngs))],
    files: packFiles,
    counts,
    licenses: [...LICENSES],
  };
  const merrs = checkRecord('PackManifest', manifest);
  if (merrs.length) throw new Error(`manifest: ${merrs.join('; ')}`);
  files.push({ path: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest), 'utf8') });
  report.counts.narrationsPerLength = countBy(LANGS.flatMap((l) => narrations[l]), (n) => `${n.lang}:${n.length}`);
  report.counts.poisPerTier = countBy(pois, (p) => p.tier);
  report.counts.poisPerKind = countBy(pois, (p) => p.kind);
  report.build = {
    builtAt,
    validatorVersion: VALIDATOR_VERSION,
    drafts: drafts.length,
    poisExcluded: merged.excluded,
    poisMerged: merged.merged.length,
    registerPolygons: register.size,
    map: mapStats,
  };
  files.push({ path: 'validation-report.json', bytes: Buffer.from(JSON.stringify(report, null, 1) + '\n', 'utf8') });
  return { files, manifest, report, counts, merged };
}

/** 6-decimal bounds that still contain the extreme value. */
const floor6 = (v) => Math.floor(v * 1e6) / 1e6;
const ceil6 = (v) => Math.ceil(v * 1e6) / 1e6;

function countBy(list, key) {
  const out = {};
  for (const x of list) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Replaces the generated JSON files in `outDir` (only *.json and narrations/*.json; nothing else is touched). */
export function writePack(outDir, files) {
  mkdirSync(join(outDir, 'narrations'), { recursive: true });
  for (const dir of [outDir, join(outDir, 'narrations')]) {
    for (const f of readdirSync(dir)) if (f.endsWith('.json')) rmSync(join(dir, f));
  }
  for (const f of files) writeFileSync(join(outDir, f.path), f.bytes);
}

function fmt(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;
}

async function main() {
  const { course: courseId, tour: tourId, rest: argv } = takeCourseArgs(process.argv.slice(2));
  const course = resolveCourse({ course: courseId, tour: tourId });
  let outDir = course.packDir;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') outDir = argv[++i];
    else throw new Error(`unknown argument ${argv[i]} (expected --course ID, --tour ID or --out DIR)`);
  }
  // No network in the pack build: any fetch is a bug.
  globalThis.fetch = () => {
    throw new Error('network access is disabled in the pack build');
  };
  const t0 = performance.now();
  const { files, report, counts, merged } = await buildPack(loadInputs(RAW_DIR, course));
  writePack(outDir, files);
  // The cover photo (lib/cover.mjs): copied as is next to the pack files, not listed in manifest.json.
  const cover = copyCover(course.courseDir, outDir);
  console.log(cover ? `  cover.jpg + cover.json   ${fmt(cover.jpg.length).padStart(10)} (${cover.meta.author}, ${cover.meta.license})` : '  no cover photo');
  const total = files.reduce((s, f) => s + f.bytes.length, 0);
  for (const f of files) console.log(`  ${f.path.padEnd(24)} ${fmt(f.bytes.length).padStart(10)}`);
  console.log(`course ${course.courseId} (tour ${course.tourId})`);
  console.log(`pack ${relative(REPO_ROOT, outDir) || outDir}: ${files.length} files, ${fmt(total)}`);
  console.log(`counts: pois=${counts.pois} narrations en=${counts.narrations_en} pl=${counts.narrations_pl} zh=${counts.narrations_zh} legs=${counts.legs}`);
  for (const lang of LANGS) {
    console.log(`  narrations ${lang}: ${TIER_ORDER.map((t) => `${t}=${report.counts[lang][t]}`).join(' ')}`);
  }
  const s = report.summary;
  const fails = Object.entries(s.failuresByCheck).filter(([, n]) => n).map(([k, n]) => `${k}=${n}`).join(' ') || 'none';
  console.log(`validation: pass=${s.pass} fallback=${s.fallback} dropped=${s.dropped} rejected candidates by check: ${fails}`);
  console.log(`pois: merged duplicates=${merged.merged.length} excluded=${JSON.stringify(merged.excluded)}`);
  console.log(`built in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

if (isMain(import.meta.url)) {
  main().catch((e) => {
    console.error(`FAILED: ${e?.stack ?? e}`);
    process.exitCode = 1;
  });
}
