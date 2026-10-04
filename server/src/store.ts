// DATA_DIR access (docs/SERVER.md §5). The API never takes a path from a request: blobs are addressed by a
// validated sha256, courses and cities by a validated id, everything else is a fixed name.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const SHA256_RE = /^[a-f0-9]{64}$/;
export const COURSE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface TtsIndexEntry {
  blob: string;          // sha256 of the mp3 bytes (blobs/<blob>)
  chars: number;
  lang?: string;
  source: 'shipped' | 'runtime';
  renderedAt: string;
}

export type TtsIndex = Record<string, TtsIndexEntry>;

/** Atomic write: temp file in the same directory, then rename. */
export async function writeFileAtomic(path: string, data: string | Buffer): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

interface Cached<T> {
  mtimeMs: number;
  size: number;
  value: T;
}

export class DataStore {
  readonly blobsDir: string;
  private readonly fileCache = new Map<string, Cached<Buffer>>();
  private readonly allowedCache = new Map<string, Cached<Set<string>>>();
  private index: TtsIndex | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(readonly dataDir: string) {
    this.blobsDir = join(dataDir, 'blobs');
  }

  async init(): Promise<void> {
    await mkdir(this.blobsDir, { recursive: true });
    await mkdir(join(this.dataDir, 'usage'), { recursive: true });
    await mkdir(join(this.dataDir, 'courses'), { recursive: true });
  }

  /** Raw bytes of a small file, re-read only when its mtime/size change (catalog, manifests). */
  private async cachedFile(path: string): Promise<Buffer | null> {
    let st;
    try {
      st = await stat(path);
    } catch {
      return null;
    }
    const c = this.fileCache.get(path);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) {
      return c.value;
    }
    const value = await readFile(path);
    this.fileCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  }

  catalog(): Promise<Buffer | null> {
    return this.cachedFile(join(this.dataDir, 'catalog.json'));
  }

  manifest(courseId: string): Promise<Buffer | null> {
    if (!COURSE_ID_RE.test(courseId)) {
      return Promise.resolve(null);
    }
    return this.cachedFile(join(this.dataDir, 'courses', courseId, 'manifest.json'));
  }

  /** Signed manifest of a city pack (cities live in their own namespace: city krakow and course krakow coexist). */
  cityManifest(cityId: string): Promise<Buffer | null> {
    if (!COURSE_ID_RE.test(cityId)) {
      return Promise.resolve(null);
    }
    return this.cachedFile(join(this.dataDir, 'cities', cityId, 'manifest.json'));
  }

  /** The allowed-lines set of a course (null = unknown course). */
  async allowed(courseId: string): Promise<Set<string> | null> {
    if (!COURSE_ID_RE.test(courseId)) {
      return null;
    }
    const path = join(this.dataDir, 'courses', courseId, 'allowed.json');
    let st;
    try {
      st = await stat(path);
    } catch {
      return null;
    }
    const c = this.allowedCache.get(courseId);
    if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) {
      return c.value;
    }
    const list = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!Array.isArray(list) || !list.every((x) => typeof x === 'string' && SHA256_RE.test(x))) {
      throw new Error(`malformed allowed.json for course ${courseId}`);
    }
    const value = new Set<string>(list as string[]);
    this.allowedCache.set(courseId, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  }

  /** Absolute path of a blob, or null when the id is not a sha256 (no path input reaches the filesystem). */
  blobPath(sha: string): string | null {
    return SHA256_RE.test(sha) ? join(this.blobsDir, sha) : null;
  }

  async hasBlob(sha: string): Promise<boolean> {
    const p = this.blobPath(sha);
    return p !== null && existsSync(p);
  }

  async putBlob(sha: string, data: Buffer): Promise<void> {
    const p = this.blobPath(sha);
    if (p === null) {
      throw new Error('bad blob id');
    }
    if (!existsSync(p)) {
      await mkdir(this.blobsDir, { recursive: true });
      await writeFileAtomic(p, data);
    }
  }

  // ---------------------------------------------------------------- tts-index.json

  async ttsIndex(): Promise<TtsIndex> {
    if (this.index === null) {
      const p = join(this.dataDir, 'tts-index.json');
      this.index = existsSync(p) ? (JSON.parse(await readFile(p, 'utf8')) as TtsIndex) : {};
    }
    return this.index;
  }

  async ttsLookup(textSha: string): Promise<TtsIndexEntry | null> {
    const idx = await this.ttsIndex();
    return Object.prototype.hasOwnProperty.call(idx, textSha) ? (idx[textSha] ?? null) : null;
  }

  /** Serialised read-modify-write of the index (one writer per process). */
  ttsRecord(textSha: string, entry: TtsIndexEntry): Promise<void> {
    return this.ttsRecordMany({ [textSha]: entry });
  }

  ttsRecordMany(entries: TtsIndex): Promise<void> {
    const run = async (): Promise<void> => {
      const idx = await this.ttsIndex();
      Object.assign(idx, entries);
      await writeFileAtomic(join(this.dataDir, 'tts-index.json'), JSON.stringify(idx));
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  // ---------------------------------------------------------------- usage/<yyyy-mm-dd>.json

  private usagePath(day: string): string {
    return join(this.dataDir, 'usage', `${day}.json`);
  }

  async usage(day: string): Promise<number> {
    try {
      const u = JSON.parse(await readFile(this.usagePath(day), 'utf8')) as { chars?: unknown };
      return typeof u.chars === 'number' ? u.chars : 0;
    } catch {
      return 0;
    }
  }

  addUsage(day: string, chars: number): Promise<void> {
    const run = async (): Promise<void> => {
      await mkdir(join(this.dataDir, 'usage'), { recursive: true });
      const prev = await this.usage(day);
      const now = { day, chars: prev + chars, updatedAt: new Date().toISOString() };
      await writeFileAtomic(this.usagePath(day), JSON.stringify(now));
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }
}

/** UTC day key for the usage files and the budget. */
export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}
