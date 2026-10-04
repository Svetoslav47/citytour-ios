/*
 * Clips of a STREAMED course on demand (docs/SERVER.md §6 "Streaming a course", core/remote/StreamRules).
 * The stream folder (filesDir/stream/<id>/<version>/) holds the course's small files and stream-clips.json: the clip
 * files of the signed course manifest ({path, sha256, bytes}). The clip index (audio/manifest.json) already points at
 * <streamDir>/audio/...; a clip that is not on the device yet is fetched from GET /v1/blobs/<sha256>, checked for size
 * and SHA-256 (async, off the UI thread), written to a .part file and renamed into place, so a half-written clip is
 * never played. It then stays cached (offline replays, and Download reuses it).
 * RemoteVoice asks ensure() before a sentence plays (bounded by STREAM_CLIP_BUDGET_MS: a late clip falls back for that
 * sentence only and is still cached for next time) and prefetch() for the next sentences while one plays.
 * A failed fetch for lack of network skips the wait for STREAM_OFFLINE_BACKOFF_MS (an offline walk never waits 3 s per
 * sentence). Never rejects.
 */
import { Log } from '../../app/Log';
import { LogEvents } from '@citytour/core';
import { CourseFile, safeRelPath, SHA256_RE } from '@citytour/core';
import {
  clipStep, ClipStep, STREAM_CLIP_BUDGET_MS, STREAM_OFFLINE_BACKOFF_MS
} from '@citytour/core';
import { shortSha } from '@citytour/core';
import { FileStore } from './FileStore';
import { RemoteClient } from './RemoteClient';

/** Written next to course.json of a streamed course (CourseRepository.stream). */
export const STREAM_CLIPS_FILE: string = 'stream-clips.json';
/** One clip fetch may run longer than the per-sentence budget (it is then cached for the next time). */
const CLIP_FETCH_DEADLINE_MS: number = 15000;

export type ClipArrivedListener = (file: string) => void;

/** Parses stream-clips.json into absolute path -> file (invalid entries skipped). Pure helper. */
export function parseStreamClips(text: string, root: string): Map<string, CourseFile> {
  const out = new Map<string, CourseFile>();
  try {
    const arr = JSON.parse(text) as Object[];
    if (!Array.isArray(arr)) {
      return out;
    }
    for (const o of arr) {
      if (o === null || typeof o !== 'object') {
        continue;
      }
      const r = o as Record<string, Object>;
      const path = typeof r['path'] === 'string' ? r['path'] as string : '';
      const sha = typeof r['sha256'] === 'string' ? r['sha256'] as string : '';
      const bytes = typeof r['bytes'] === 'number' ? r['bytes'] as number : -1;
      if (!safeRelPath(path) || !SHA256_RE.test(sha) || bytes < 0) {
        continue;
      }
      const f = new CourseFile();
      f.path = path;
      f.sha256 = sha;
      f.bytes = bytes;
      out.set(`${root}/${path}`, f);
    }
  } catch (e) {
    // not a list: no streamed clips (every sentence uses the fallback chain)
  }
  return out;
}

export class StreamClips {
  private readonly client: RemoteClient;
  private byFile: Map<string, CourseFile> = new Map<string, CourseFile>();
  private onDisk: Set<string> = new Set<string>();
  private inflight: Map<string, Promise<boolean>> = new Map<string, Promise<boolean>>();
  private offlineUntil: number = 0;
  private gen: number = 0;
  private courseId: string = '';
  private arrived: ClipArrivedListener | undefined = undefined;
  private fetched: number = 0;
  private failedCount: number = 0;

  constructor(client: RemoteClient) {
    this.client = client;
  }

  /** A clip that arrived after its sentence fell back (NarrationPlayer can use it again). */
  setArrivedListener(l: ClipArrivedListener): void {
    this.arrived = l;
  }

  /** The active course changed: its stream clips ('' root / not streamed = none). Never rejects. */
  async setCourse(id: string, root: string, streamed: boolean): Promise<void> {
    this.gen++;
    const g = this.gen;
    this.byFile = new Map<string, CourseFile>();
    this.onDisk = new Set<string>();
    this.inflight = new Map<string, Promise<boolean>>();
    this.courseId = streamed ? id : '';
    if (!streamed || root === '') {
      return;
    }
    const text = await FileStore.readText(`${root}/${STREAM_CLIPS_FILE}`);
    if (g !== this.gen) {
      return;
    }
    this.byFile = text === undefined ? new Map<string, CourseFile>() : parseStreamClips(text, root);
    Log.i(LogEvents.NARR_AUDIO, `event=stream_clips course=${id} clips=${this.byFile.size}`);
  }

  /** `file` (absolute) is a clip of the streamed active course. */
  isStreamClip(file: string): boolean {
    return this.byFile.has(file);
  }

  /** Known to be on the device (fetched or checked in this session). */
  onDevice(file: string): boolean {
    return this.onDisk.has(file);
  }

  /** Resolves true once the clip is on the device, false when it is not there within `budgetMs`. Never rejects. */
  ensure(file: string, budgetMs: number = STREAM_CLIP_BUDGET_MS): Promise<boolean> {
    if (this.onDisk.has(file)) {
      return Promise.resolve(true);
    }
    const p = this.get(file);
    return Promise.race([p, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), budgetMs))]);
  }

  /** Starts fetching these clips in the background (already cached / unknown ones are skipped). */
  prefetch(files: string[]): void {
    for (const f of files) {
      if (!this.onDisk.has(f) && this.byFile.has(f) && Date.now() >= this.offlineUntil) {
        this.get(f);
      }
    }
  }

  /** HUD / dev panel. */
  stats(): string {
    return this.courseId === '' ? 'not streaming' :
      `streaming ${this.courseId} · ${this.fetched} fetched · ${this.failedCount} failed`;
  }

  private get(file: string): Promise<boolean> {
    const running = this.inflight.get(file);
    if (running !== undefined) {
      return running;
    }
    const p = this.load(file, this.gen).finally(() => {
      this.inflight.delete(file);
    });
    this.inflight.set(file, p);
    return p;
  }

  private async load(file: string, g: number): Promise<boolean> {
    const f = this.byFile.get(file);
    if (f === undefined) {
      return false;
    }
    try {
      if ((await FileStore.size(file)) === f.bytes && (await FileStore.sha256File(file)) === f.sha256) {
        this.onDisk.add(file);   // cached by an earlier session
        return true;
      }
      const t0 = Date.now();
      if (clipStep(false, true, t0, this.offlineUntil) !== ClipStep.FETCH) {
        return false;   // offline back-off: this sentence falls back at once
      }
      const h = await this.client.blob(f.sha256, CLIP_FETCH_DEADLINE_MS);
      if (h.status !== 200 || h.bytes === undefined) {
        if (h.status === 0) {
          this.offlineUntil = Date.now() + STREAM_OFFLINE_BACKOFF_MS;
        }
        return this.fail(f, `http_${h.status}`, t0);
      }
      if (h.bytes.byteLength !== f.bytes || (await FileStore.sha256Bytes(new Uint8Array(h.bytes))) !== f.sha256) {
        return this.fail(f, 'integrity', t0);
      }
      if (g !== this.gen) {
        return false;   // the active course changed meanwhile: its folder may be gone
      }
      const part = `${file}.part`;
      if (!(await FileStore.writeBytes(part, h.bytes)) || !(await FileStore.rename(part, file))) {
        await FileStore.remove(part);
        return this.fail(f, 'write', t0);
      }
      this.onDisk.add(file);
      this.fetched++;
      Log.i(LogEvents.NARR_AUDIO, `event=stream_clip result=ok sha=${shortSha(f.sha256)} bytes=${f.bytes}` +
        ` ms=${Date.now() - t0}`);
      if (this.arrived !== undefined) {
        this.arrived(file);
      }
      return true;
    } catch (e) {
      Log.e(LogEvents.NARR_AUDIO, `event=stream_clip result=fail reason=exception ${Log.errKv(e as Object)}`);
      return false;
    }
  }

  private fail(f: CourseFile, reason: string, t0: number): boolean {
    this.failedCount++;
    Log.w(LogEvents.NARR_AUDIO, `event=stream_clip result=fail reason=${reason} sha=${shortSha(f.sha256)}` +
      ` ms=${Date.now() - t0}`);
    return false;
  }
}
