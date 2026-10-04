/*
 * Course list rules (docs/SERVER.md §6 "CourseRepository" and "Courses screen"). Pure: no @kit imports, unit-tested
 * in entry/src/test/CourseRules.test.ets.
 *
 * The app ships NO built-in course and knows no city: every course is downloaded from the course server, and a course
 * of a city brings that city's places pack with it (SERVER.md §3 R7).
 * - A downloaded course is listed even when the catalog is unavailable (offline) or no longer lists it.
 * - A catalog version different from the installed one is an update.
 * - The active course is '' (none: Home shows "Download your first walk") until a course is installed. The first
 *   successful download becomes the active course. Deleting the active course makes another installed course
 *   active, or none when it was the last one.
 * - The Demo walk (a SIMULATED track) is offered for any active course whose pack ships a demo-walk.json track.
 * - A city places pack is downloaded when missing or when the catalog lists another version, and removed when no
 *   installed course uses it any more.
 */
import { CourseSummary } from './ServerApi';

export enum CourseState {
  AVAILABLE = 'available',     // on the server, not downloaded: "Download"
  DOWNLOADED = 'downloaded',   // installed and current (or the server is unknown): "Downloaded ✓"
  UPDATE = 'update'            // installed but the server has another version: "Update"
}

export class InstalledCourse {
  id: string = '';
  version: string = '';
  summary: CourseSummary = new CourseSummary();
}

export class CourseRow {
  summary: CourseSummary = new CourseSummary();   // what the row shows (catalog when known, else the local copy)
  state: CourseState = CourseState.AVAILABLE;
  installedVersion: string = '';                  // '' = not downloaded
  canDelete: boolean = false;
  canSelect: boolean = false;                     // downloaded: can be the active course
  active: boolean = false;
}

function find(list: CourseSummary[] | undefined, id: string): CourseSummary | undefined {
  if (list === undefined) {
    return undefined;
  }
  return list.find((c: CourseSummary) => c.id === id);
}

function findInstalled(list: InstalledCourse[], id: string): InstalledCourse | undefined {
  return list.find((c: InstalledCourse) => c.id === id);
}

/** The id the app should use as its active course: the saved one when installed, else the first installed, else ''. */
export function resolveActive(activeId: string, installed: InstalledCourse[]): string {
  if (activeId !== '' && findInstalled(installed, activeId) !== undefined) {
    return activeId;
  }
  return installed.length > 0 ? installed[0].id : '';
}

/** The active course after `installedId` was downloaded: the first download becomes active, else no change. */
export function activeAfterInstall(activeId: string, installedId: string): string {
  return activeId === '' ? installedId : activeId;
}

/** The Demo walk (SIMULATED track) is offered while a course is active and its pack ships a demo track. */
export function demoWalkOffered(activeId: string, hasDemoTrack: boolean): boolean {
  return activeId !== '' && hasDemoTrack;
}

/**
 * Whether a course download must also fetch its city's places pack: none installed (''), or the catalog lists
 * another version. An unknown catalog version ('': offline, older catalog) keeps the installed city.
 */
export function cityNeedsDownload(installedVersion: string, catalogVersion: string): boolean {
  if (installedVersion === '') {
    return true;
  }
  return catalogVersion !== '' && catalogVersion !== installedVersion;
}

/**
 * Bytes a Download fetches: the course, plus its city's places pack when that city is not installed yet (the first
 * course of a city brings it; the next ones share it). `cityBytes` 0 = unknown (older catalog).
 */
export function downloadBytes(courseBytes: number, cityId: string, cityBytes: number, cityInstalled: boolean): number {
  return courseBytes + (cityId !== '' && !cityInstalled && cityBytes > 0 ? cityBytes : 0);
}

/** Installed city packs that no installed course uses any more (removed with the last course of the city). */
export function orphanCities(installedCities: string[], usedCityIds: string[]): string[] {
  return installedCities.filter((c: string) => usedCityIds.indexOf(c) < 0);
}

/** What Home shows. */
export enum HomeMode { LOADING = 'loading', NO_COURSE = 'noCourse', READY = 'ready', ERROR = 'error' }

/**
 * Home's mode from the pack load: still loading; no course installed (empty state "Download your first walk");
 * a course that loaded; a course that is installed but failed to load (error state, the Courses screen can
 * re-download or delete it).
 */
export function homeMode(loading: boolean, hasCourse: boolean, loadOk: boolean): HomeMode {
  if (loading) {
    return HomeMode.LOADING;
  }
  if (!hasCourse) {
    return HomeMode.NO_COURSE;
  }
  return loadOk ? HomeMode.READY : HomeMode.ERROR;
}

/**
 * The Courses screen rows. `catalog` undefined = the server was never reached and nothing is cached (offline,
 * disabled): only installed courses are listed.
 */
export function mergeCourses(installed: InstalledCourse[], catalog: CourseSummary[] | undefined,
  activeId: string): CourseRow[] {
  const active = resolveActive(activeId, installed);
  const rows: CourseRow[] = [];
  // Catalog order first, then installed courses the catalog does not list.
  const done = new Set<string>();
  const ordered: string[] = [];
  if (catalog !== undefined) {
    for (const c of catalog) {
      if (!done.has(c.id)) {
        ordered.push(c.id);
        done.add(c.id);
      }
    }
  }
  for (const i of installed) {
    if (!done.has(i.id)) {
      ordered.push(i.id);
      done.add(i.id);
    }
  }
  for (const id of ordered) {
    const inst = findInstalled(installed, id);
    const cat = find(catalog, id);
    const r = new CourseRow();
    if (inst !== undefined) {
      r.summary = cat !== undefined ? cat : inst.summary;
      r.installedVersion = inst.version;
      r.canDelete = true;
      r.canSelect = true;
      r.state = cat !== undefined && cat.version !== inst.version ? CourseState.UPDATE : CourseState.DOWNLOADED;
      r.active = active === id;
    } else if (cat !== undefined) {
      r.summary = cat;
      r.state = CourseState.AVAILABLE;
    } else {
      continue;
    }
    rows.push(r);
  }
  return rows;
}

/** The installed list after a successful download (replaces an older version of the same course). */
export function afterInstall(installed: InstalledCourse[], c: InstalledCourse): InstalledCourse[] {
  const out = installed.filter((i: InstalledCourse) => i.id !== c.id);
  out.push(c);
  return out;
}

/** The installed list after a delete; the active course after it (another installed course, or none). */
export class DeleteResult {
  installed: InstalledCourse[] = [];
  activeId: string = '';
  allowed: boolean = true;
}

export function afterDelete(installed: InstalledCourse[], id: string, activeId: string): DeleteResult {
  const r = new DeleteResult();
  if (findInstalled(installed, id) === undefined) {
    r.allowed = false;   // an unknown id is never deleted
    r.installed = installed;
    r.activeId = resolveActive(activeId, installed);
    return r;
  }
  r.installed = installed.filter((i: InstalledCourse) => i.id !== id);
  r.activeId = resolveActive(activeId === id ? '' : activeId, r.installed);
  return r;
}

/** Title in the UI language, falling back to English, then any title, then the id. */
export function courseTitle(c: CourseSummary, uiLang: string): string {
  const t = uiLang === 'pl' ? c.title.pl : uiLang === 'zh' ? c.title.zh : c.title.en;
  if (t !== '') {
    return t;
  }
  return c.title.en !== '' ? c.title.en : c.title.pl !== '' ? c.title.pl : c.title.zh !== '' ? c.title.zh : c.id;
}

/** "12.3 MB" / "850 KB" for the Download button. */
export function sizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }
  if (bytes >= 1024 * 1024) {
    return `${(Math.round(bytes / (1024 * 1024) * 10) / 10).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Download progress 0..100 from bytes done / total (files count as a fallback when sizes are 0). */
export function progressPct(doneBytes: number, totalBytes: number, doneFiles: number, totalFiles: number): number {
  if (totalBytes > 0) {
    return Math.max(0, Math.min(100, Math.floor(doneBytes * 100 / totalBytes)));
  }
  if (totalFiles > 0) {
    return Math.max(0, Math.min(100, Math.floor(doneFiles * 100 / totalFiles)));
  }
  return 0;
}
