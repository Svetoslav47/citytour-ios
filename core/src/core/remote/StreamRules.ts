/*
 * Stream a course ("Play now") instead of downloading it (docs/SERVER.md §6 "Streaming a course"). Pure: no @kit
 * imports, unit-tested in entry/src/test/StreamRules.test.ets.
 *
 * A STREAMED course is verified exactly like a download (signed catalog, signed course + city manifests, every file
 * by sha256), but only the small files a walk needs are fetched up front:
 *   - the course: every file except the clips (its tour/ overlay: tours, routes, the stops' records and stories, the
 *     Demo walk track, the cover) plus audio/manifest.json (the clip index);
 *   - the city: only manifest.json, city.json and the map (map-*.json); NOT its thousands of places and their
 *     stories (the course overlay already holds every record and story of its stops). "All places" needs the full
 *     city: it is offered after a Download.
 * Each clip is then fetched on demand from /v1/blobs/<sha of the clip file> (verified, cached in the stream folder)
 * with the next sentences prefetched; a clip that does not arrive in time falls back for that sentence only.
 * A downloaded course always wins over a streamed copy of the same course. Download after streaming reuses the
 * already verified files of the stream folder.
 */
import { CourseFile } from './ServerApi';
import { InstalledCourse } from './CourseRules';

/** How the app holds a course. */
export enum CourseSource { NONE = 'none', STREAMED = 'streamed', DOWNLOADED = 'downloaded' }

/** City pack files a streamed course needs (the rest of the city is "All places", offered after a Download). */
export function isStreamCityFile(path: string): boolean {
  return path === 'manifest.json' || path === 'city.json' || (path.startsWith('map-') && path.endsWith('.json'));
}

/** A clip file of the course (fetched on demand while streaming): under audio/, except the clip index itself. */
export function isClipFile(path: string, audioManifestPath: string): boolean {
  return path.startsWith('audio/') && path !== audioManifestPath;
}

/** The course files fetched before a streamed walk starts: everything but the clips. */
export function streamCourseFiles(files: CourseFile[], audioManifestPath: string): CourseFile[] {
  return files.filter((f: CourseFile) => !isClipFile(f.path, audioManifestPath));
}

/** The clip files of a course (path -> sha256 + bytes kept with the stream, fetched one by one). */
export function streamClipFiles(files: CourseFile[], audioManifestPath: string): CourseFile[] {
  return files.filter((f: CourseFile) => isClipFile(f.path, audioManifestPath));
}

/** The city files fetched for a streamed course. */
export function streamCityFiles(files: CourseFile[]): CourseFile[] {
  return files.filter((f: CourseFile) => isStreamCityFile(f.path));
}

/** Where course `id` comes from: a download wins over a stream of the same course. */
export function courseSource(id: string, downloaded: string[], streamed: string[]): CourseSource {
  if (id === '') {
    return CourseSource.NONE;
  }
  if (downloaded.indexOf(id) >= 0) {
    return CourseSource.DOWNLOADED;
  }
  return streamed.indexOf(id) >= 0 ? CourseSource.STREAMED : CourseSource.NONE;
}

/**
 * The courses that can be the active one: the downloaded ones, then the streamed ones that are not also downloaded
 * (a streamed walk keeps working after a restart, offline with the clips it already played).
 */
export function activeCandidates(downloaded: InstalledCourse[], streamed: InstalledCourse[]): InstalledCourse[] {
  const out: InstalledCourse[] = downloaded.slice();
  for (const s of streamed) {
    if (!downloaded.some((d: InstalledCourse) => d.id === s.id)) {
      out.push(s);
    }
  }
  return out;
}

/**
 * "Play now" must prepare (fetch) the stream: nothing streamed yet, or the catalog lists another version. An unknown
 * catalog version ('' offline) keeps the streamed copy.
 */
export function streamNeedsPrepare(streamedVersion: string, catalogVersion: string): boolean {
  if (streamedVersion === '') {
    return true;
  }
  return catalogVersion !== '' && catalogVersion !== streamedVersion;
}

/** "All places" (the whole city) is available: the course has no city (self-contained pack) or the city is downloaded. */
export function allPlacesAvailable(cityId: string, cityDownloaded: boolean): boolean {
  return cityId === '' || cityDownloaded;
}

/** Files of a download that the stream folder already holds (copied in, then re-verified by the installer). */
export function reusableForDownload(files: CourseFile[], streamedPaths: string[]): CourseFile[] {
  const have = new Set<string>(streamedPaths);
  return files.filter((f: CourseFile) => have.has(f.path));
}

/** The Courses row's buttons for a course that is not downloaded. */
export class StreamRowActions {
  /** "Play now" (stream) is the primary action. */
  playNow: boolean = false;
  /** "Download" (offline) is the secondary action. */
  download: boolean = false;
  /** The row says the walk streams (it is the streamed copy). */
  streaming: boolean = false;
}

export function streamRowActions(source: CourseSource, active: boolean, serverEnabled: boolean): StreamRowActions {
  const a = new StreamRowActions();
  if (source === CourseSource.DOWNLOADED) {
    return a;
  }
  a.streaming = source === CourseSource.STREAMED;
  a.playNow = serverEnabled ? !(a.streaming && active) : (a.streaming && !active);
  a.download = serverEnabled;
  return a;
}

// ---------- clips on demand ----------

/** What a sentence whose clip streams does now. */
export enum ClipStep {
  PLAY = 'play',            // the clip is on the device (played or prefetched before): play it
  FETCH = 'fetch',          // fetch it (within the per-clip budget), then play it, or fall back
  FALLBACK = 'fallback'     // skip the clip for this sentence: live studio voice, built-in voice, or text
}

/** Per-clip wait before the sentence falls back (the fetch goes on in the background and is cached). */
export const STREAM_CLIP_BUDGET_MS: number = 3000;
/** How many following sentences of the same story are prefetched while one plays. */
export const STREAM_PREFETCH: number = 3;
/** After a failed clip fetch (offline), later sentences skip the wait for this long. */
export const STREAM_OFFLINE_BACKOFF_MS: number = 30000;

export function clipStep(onDevice: boolean, knownClip: boolean, nowMs: number, offlineUntilMs: number): ClipStep {
  if (onDevice) {
    return ClipStep.PLAY;
  }
  if (!knownClip || nowMs < offlineUntilMs) {
    return ClipStep.FALLBACK;
  }
  return ClipStep.FETCH;
}

/** One clip of the clip index (the fields the prefetch needs). */
export class StreamClip {
  lang: string = '';
  poiId: string = '';
  personaId: string = '';
  length: string = '';
  n: number = 0;
  file: string = '';
}

/**
 * The clips to prefetch after `cur`: the next `k` sentences of the same story (same language, place, persona and
 * length), in order. System lines (poiId '') are fetched when needed only.
 */
export function prefetchAfter(all: StreamClip[], cur: StreamClip, k: number = STREAM_PREFETCH): string[] {
  if (cur.poiId === '' || k <= 0) {
    return [];
  }
  const next = all.filter((e: StreamClip) => e.lang === cur.lang && e.poiId === cur.poiId &&
    e.personaId === cur.personaId && e.length === cur.length && e.n > cur.n);
  next.sort((a: StreamClip, b: StreamClip) => a.n - b.n);
  return next.slice(0, k).map((e: StreamClip) => e.file);
}
