// CityTour pack pipeline: which course (= one tour = one pack) a script works on (Node 22+ ESM, stdlib only).
//
// One course per tour (docs/research/new-tours.md §4.4). A course is chosen with `--course <courseId>` or
// `--tour <tourId>`; without either flag every script works on the original course `krakow` (The Royal Route),
// exactly as before, so its pack and audio are reproduced byte-identically.
//
//   tour file    data/tours/<tourId>.json; its `courseId` key names the course (review-only key, never emitted)
//   pack         data/course/<courseId>/packs/<courseId>/       (packId = courseId)
//   audio        data/course/<courseId>/audio/
//   review       scripts/pack/review/<courseId>/<poiId>.<lang>.md
//   raw          shared snapshots stay in data/raw/ (Wikidata, wiki summaries, OSM tiles, ArcGIS). The per-tour
//                snapshots (OSRM table + pairs, wiki stop texts) of the default course stay at their original
//                paths (data/raw/osrm/stops-table-foot.json, data/raw/wiki/stops-text-<lang>.json); every other
//                tour keeps them under data/raw/tours/<tourId>/ with the same relative names, plus its own
//                data/raw/tours/<tourId>/SOURCES.md (its retrieval times count for the pack's builtAt).

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RAW_DIR, REPO_ROOT } from './http.mjs';

export const DEFAULT_COURSE_ID = 'krakow';
export const DEFAULT_TOUR_ID = 'royal-route';
export const TOURS_DIR = join(REPO_ROOT, 'data', 'tours');
export const COURSE_ROOT = join(REPO_ROOT, 'data', 'course');
export const REVIEW_ROOT = join(REPO_ROOT, 'scripts', 'pack', 'review');

/**
 * Which city each course belongs to (city packs, scripts/pack/split-city.mjs). The city pack data/city/<cityId>/
 * carries the city's places (pois, narrations, sources, map); the course's own overlay pack data/course/<id>/tour/
 * carries only its tour. A course missing here belongs to no city and gets no overlay. Explicit on purpose: add a
 * new course here when it is built (and data/city/<cityId>.json when it is a new city).
 */
export const COURSE_CITY = Object.freeze({
  krakow: 'krakow',
  'krakow-scholars': 'krakow',
  'krakow-kazimierz': 'krakow',
});

/** The city id of a course, or null. */
export function cityOfCourse(courseId) {
  return Object.prototype.hasOwnProperty.call(COURSE_CITY, courseId) ? COURSE_CITY[courseId] : null;
}
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Every tour file in data/tours: [{ tourId, courseId, file }] sorted by tourId. */
export function listTours(dir = TOURS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const file = join(dir, f);
      const t = JSON.parse(readFileSync(file, 'utf8'));
      return { tourId: t.id, courseId: t.courseId ?? (t.id === DEFAULT_TOUR_ID ? DEFAULT_COURSE_ID : null), file };
    });
}

/** Paths of one course. Throws on an unknown course or tour, or when --course and --tour disagree. */
export function resolveCourse({ course = null, tour = null } = {}, { toursDir = TOURS_DIR } = {}) {
  if (course === null && tour === null) course = DEFAULT_COURSE_ID;
  for (const [flag, v] of [['--course', course], ['--tour', tour]]) {
    if (v !== null && !ID_RE.test(v)) throw new Error(`${flag} ${v}: expected a lowercase id like krakow-scholars`);
  }
  const tours = listTours(toursDir);
  const hit = tours.find((t) => (tour !== null ? t.tourId === tour : t.courseId === course));
  if (!hit) {
    const known = tours.map((t) => `${t.courseId} (tour ${t.tourId})`).join(', ');
    throw new Error(`unknown ${tour !== null ? `tour ${tour}` : `course ${course}`}; known: ${known}`);
  }
  if (course !== null && tour !== null && hit.courseId !== course) {
    throw new Error(`tour ${tour} belongs to course ${hit.courseId}, not ${course}`);
  }
  return courseInfo(hit.courseId, hit.tourId, hit.file);
}

export function courseInfo(courseId, tourId, tourFile = join(TOURS_DIR, `${tourId}.json`)) {
  const legacy = courseId === DEFAULT_COURSE_ID;
  const rawPrefix = legacy ? '' : `tours/${tourId}/`;
  const courseDir = join(COURSE_ROOT, courseId);
  return Object.freeze({
    courseId,
    packId: courseId,
    tourId,
    tourFile,
    legacy,
    courseDir,
    packDir: join(courseDir, 'packs', courseId),
    audioDir: join(courseDir, 'audio'),
    reviewDir: join(REVIEW_ROOT, courseId),
    /** Raw snapshot path (relative to data/raw) of a per-tour snapshot such as osrm/stops-table-foot.json. */
    rawRel: (rel) => `${rawPrefix}${rel}`,
    /** The tour's own SOURCES.md (null for the default course: its rows are in data/raw/SOURCES.md). */
    sourcesMd: legacy ? null : join(RAW_DIR, 'tours', tourId, 'SOURCES.md'),
  });
}

export function readCourseTour(c) {
  if (!existsSync(c.tourFile)) throw new Error(`missing ${c.tourFile}`);
  return JSON.parse(readFileSync(c.tourFile, 'utf8'));
}

/**
 * Pulls `--course <id>` and `--tour <id>` (also `--course=<id>`) out of argv.
 * Returns { course, tour, rest } where rest keeps every other argument in order.
 */
export function takeCourseArgs(argv) {
  const out = { course: null, tour: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--(course|tour)(?:=(.*))?$/.exec(a);
    if (!m) {
      out.rest.push(a);
      continue;
    }
    const v = m[2] ?? argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`--${m[1]} needs a value`);
    out[m[1]] = v;
  }
  return out;
}

/** takeCourseArgs + resolveCourse. */
export function courseFromArgv(argv) {
  const { course, tour, rest } = takeCourseArgs(argv);
  return { course: resolveCourse({ course, tour }), rest };
}
