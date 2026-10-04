/*
 * Tour cover photos on disk (docs/SERVER.md §3 `coverBlob`, core/remote/CoverRules.ets).
 *   - Catalog covers (before a course is downloaded): GET /v1/blobs/<coverBlob> (RemoteClient: connect/read timeouts and
 *     an overall deadline), size-checked and SHA-256-verified (async, off the UI thread), then written to
 *     filesDir/covers/<sha>.jpg via a temp file + rename. A file in the cache is trusted only if its name is its
 *     verified sha. One request per sha at a time; a failed fetch is retried at most once a minute.
 *   - Installed covers: <pack>/cover.jpg + cover.json of the downloaded course (verified with the course).
 * Every method resolves (never rejects); '' / undefined = no cover, and the caller shows its fallback.
 */
import { Log } from '../../app/Log';
import { LogEvents } from '@citytour/core';
import { COVER_JPG, COVER_JSON, coverCacheName, CoverCredit, MAX_COVER_BYTES, parseCoverJson } from '@citytour/core';
import { FileStore } from './FileStore';
import { RemoteClient } from './RemoteClient';

const RETRY_AFTER_FAIL_MS: number = 60000;

export class InstalledCover {
  path: string = '';
  credit: CoverCredit | undefined = undefined;
}

export class CoverStore {
  private readonly client: RemoteClient;
  private readonly dirOf: () => string;
  private inflight: Map<string, Promise<string>> = new Map<string, Promise<string>>();
  private failedAt: Map<string, number> = new Map<string, number>();

  constructor(client: RemoteClient, dirOf: () => string) {
    this.client = client;
    this.dirOf = dirOf;
  }

  private dir(): string {
    const d = this.dirOf();
    return d === '' ? '' : `${d}/covers`;
  }

  /** The cached catalog cover of `sha` ('' when not cached). No network. */
  async cached(sha: string): Promise<string> {
    const name = coverCacheName(sha);
    if (name === '' || this.dir() === '') {
      return '';
    }
    const p = `${this.dir()}/${name}`;
    const size = await FileStore.size(p);
    return size > 0 && size <= MAX_COVER_BYTES ? p : '';
  }

  /** The catalog cover of `sha`: cached, or fetched + verified + cached now ('' when it cannot be had). */
  async ensure(sha: string): Promise<string> {
    const hit = await this.cached(sha);
    if (hit !== '' || coverCacheName(sha) === '' || this.dir() === '' || !this.client.enabled()) {
      return hit;
    }
    const last = this.failedAt.get(sha);
    if (last !== undefined && Date.now() - last < RETRY_AFTER_FAIL_MS) {
      return '';
    }
    const running = this.inflight.get(sha);
    if (running !== undefined) {
      return running;
    }
    const p = this.fetch(sha).finally(() => {
      this.inflight.delete(sha);
    });
    this.inflight.set(sha, p);
    return p;
  }

  private async fetch(sha: string): Promise<string> {
    const t0 = Date.now();
    const h = await this.client.blob(sha);
    let reason = '';
    if (h.status !== 200 || h.bytes === undefined) {
      reason = h.status === 0 ? 'offline' : `http_${h.status}`;
    } else if (h.bytes.byteLength === 0 || h.bytes.byteLength > MAX_COVER_BYTES) {
      reason = `size_${h.bytes.byteLength}`;
    } else if ((await FileStore.sha256Bytes(new Uint8Array(h.bytes))) !== sha) {
      reason = 'sha256_mismatch';
    }
    if (reason === '' && h.bytes !== undefined) {
      const dest = `${this.dir()}/${coverCacheName(sha)}`;
      const tmp = `${dest}.part`;
      if (await FileStore.writeBytes(tmp, h.bytes) && await FileStore.rename(tmp, dest)) {
        this.failedAt.delete(sha);
        Log.i(LogEvents.COURSE, `event=cover_cached sha=${sha.substring(0, 12)} bytes=${h.bytes.byteLength}` +
          ` ms=${Date.now() - t0}`);
        return dest;
      }
      await FileStore.remove(tmp);
      reason = 'write';
    }
    this.failedAt.set(sha, Date.now());
    Log.w(LogEvents.COURSE, `event=cover_fail sha=${sha.substring(0, 12)} reason=${reason} ms=${Date.now() - t0}` +
      ' fallback=placeholder');
    return '';
  }

  /** The cover of an installed course's pack folder (path '' when the pack has none or its credit is unreadable). */
  static async installed(packPath: string): Promise<InstalledCover> {
    const out = new InstalledCover();
    if (packPath === '') {
      return out;
    }
    const jpg = `${packPath}/${COVER_JPG}`;
    const size = await FileStore.size(jpg);
    if (size <= 0 || size > MAX_COVER_BYTES) {
      return out;
    }
    const text = await FileStore.readText(`${packPath}/${COVER_JSON}`);
    const credit = text === undefined ? undefined : parseCoverJson(text);
    if (credit === undefined) {
      Log.w(LogEvents.COURSE, `event=cover_credit_missing pack=${packPath.substring(packPath.lastIndexOf('/') + 1)}` +
        ' fallback=map');
      return out;
    }
    out.path = jpg;
    out.credit = credit;
    return out;
  }
}
