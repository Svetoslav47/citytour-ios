/*
 * Downloaded courses on disk (docs/SERVER.md §3 "A course is installed to a temp folder, then swapped in atomically",
 * §6). Layout under the app's filesDir:
 *   courses/<id>/<version>/            one installed course (the files of its signed manifest, by their paths)
 *   courses/<id>/<version>/course.json what the app needs without the network: summary, pack folder, clip manifest
 *   courses/.tmp/<id>-<version>/       a download in progress (kept after a failure so Retry resumes it; deleted
 *                                      on cancel, after the swap and at start-up)
 *   courses/catalog.json               the last catalog envelope that verified (offline Courses screen)
 *   courses/active.json                {"id": "..."} the active course ('' or missing = none installed yet)
 *   cities/<cityId>/<version>/         a city's places pack (same installer: a second CourseStore with the folder
 *                                      'cities'; downloaded with the first course of that city, SERVER.md §3 R7)
 * Install: every file is fetched by its sha256 (GET /v1/blobs/:sha), its size and SHA-256 are checked (async, off
 * the UI thread), it is written into the temp folder; only when ALL files verified is the temp folder renamed to
 * courses/<id>/<version> (one rename), and only then are older versions of that course removed. A failed, cancelled
 * or partial download never touches a working course. Each file is tried up to 1 + BLOB_RETRIES times with a short
 * backoff; a file already in the temp folder with the right size and SHA-256 (an earlier attempt) is not fetched
 * again, so Retry after a network drop resumes instead of starting over (a course of ~1200 files, ~10 MB, plus its city places pack of ~8 MB once).
 */
import { Log } from '../../app/Log';
import { LogEvents } from '@citytour/core';
import { InstalledCourse } from '@citytour/core';
import {
  CourseFile, CourseManifest, CourseSummary, DEFAULT_AUDIO_MANIFEST, manifestBytes, packDir, safeRelPath, SHA256_RE,
  validId, validVersion
} from '@citytour/core';
import { FileStore } from './FileStore';
import { RemoteClient } from './RemoteClient';

const PARALLEL: number = 6;
const BLOB_RETRIES: number = 2;
const RETRY_BACKOFF_MS: number = 700;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** courses/<id>/<version>/course.json */
export class CourseRecord {
  id: string = '';
  version: string = '';
  installedAt: number = 0;
  packDir: string = '';                       // '' or 'pack/' ... (ends in '/')
  audioManifestPath: string = DEFAULT_AUDIO_MANIFEST;
  summary: CourseSummary = new CourseSummary();
  /** The course's city (signed manifest `cityId`); '' = a self-contained pack (or this record IS a city). */
  cityId: string = '';
}

export class InstallProgress {
  /** Files found complete in the temp folder of an earlier attempt (not fetched again). */
  resumedFiles: number = 0;
  doneBytes: number = 0;
  totalBytes: number = 0;
  doneFiles: number = 0;
  totalFiles: number = 0;
}

export class InstallResult {
  ok: boolean = false;
  error: string = '';
  record: CourseRecord | undefined = undefined;
}

/** install() extras: small text files written next to course.json, and a folder of already verified files to reuse. */
export class InstallOptions {
  extraFiles: Map<string, string> = new Map<string, string>();
  /** Absolute folder whose files (same paths) are copied instead of fetched when their size + SHA-256 match. */
  seedDir: string = '';
}

export class CancelToken {
  cancelled: boolean = false;
}

function str(r: Record<string, Object>, k: string): string {
  const v: Object | undefined = r[k];
  return typeof v === 'string' ? v as string : '';
}

/** Rebuilds a CourseSummary from JSON written by this app (plain field copy, validated). */
function summaryFrom(v: Object | undefined): CourseSummary {
  const s = new CourseSummary();
  if (v === undefined || v === null || typeof v !== 'object') {
    return s;
  }
  const r = v as Record<string, Object>;
  s.id = str(r, 'id');
  s.version = str(r, 'version');
  s.city = str(r, 'city');
  const t: Object | undefined = r['title'];
  if (t !== undefined && t !== null && typeof t === 'object') {
    const tr = t as Record<string, Object>;
    s.title.en = str(tr, 'en');
    s.title.pl = str(tr, 'pl');
    s.title.zh = str(tr, 'zh');
  }
  s.stops = typeof r['stops'] === 'number' ? r['stops'] as number : 0;
  s.km = typeof r['km'] === 'number' ? r['km'] as number : 0;
  s.minutes = typeof r['minutes'] === 'number' ? r['minutes'] as number : 0;
  s.bytes = typeof r['bytes'] === 'number' ? r['bytes'] as number : 0;
  const langs: Object | undefined = r['langs'];
  if (Array.isArray(langs)) {
    for (const l of langs as Object[]) {
      if (typeof l === 'string') {
        s.langs.push(l as string);
      }
    }
  }
  const cover = str(r, 'coverBlob');
  s.coverBlob = SHA256_RE.test(cover) ? cover : '';
  s.coverCredit = s.coverBlob !== '' ? str(r, 'coverCredit') : '';
  const city = str(r, 'cityId');
  s.cityId = validId(city) ? city : '';
  return s;
}

export class CourseStore {
  private readonly dirOf: () => string;
  private readonly folder: string;

  /** folder: 'courses' (default) or 'cities' (city places packs). */
  constructor(dirOf: () => string, folder: string = 'courses') {
    this.dirOf = dirOf;
    this.folder = folder;
  }

  root(): string {
    const d = this.dirOf();
    return d === '' ? '' : `${d}/${this.folder}`;
  }

  courseDir(id: string, version: string): string {
    return `${this.root()}/${id}/${version}`;
  }

  /** Removes leftovers of interrupted downloads. */
  async cleanTemp(): Promise<void> {
    if (this.root() === '') {
      return;
    }
    await FileStore.remove(`${this.root()}/.tmp`);
  }

  /** Installed courses (one version per id: the newest record wins, the others are removed). */
  async installed(): Promise<CourseRecord[]> {
    const root = this.root();
    if (root === '') {
      return [];
    }
    const out: CourseRecord[] = [];
    for (const id of await FileStore.list(root)) {
      if (!validId(id)) {
        continue;
      }
      let best: CourseRecord | undefined = undefined;
      const stale: string[] = [];
      for (const version of await FileStore.list(`${root}/${id}`)) {
        if (!validVersion(version)) {
          continue;
        }
        const rec = await this.readRecord(id, version);
        if (rec === undefined) {
          stale.push(version);   // a folder without a valid course.json is not a complete install
          continue;
        }
        if (best === undefined || rec.installedAt > best.installedAt) {
          if (best !== undefined) {
            stale.push(best.version);
          }
          best = rec;
        } else {
          stale.push(version);
        }
      }
      for (const v of stale) {
        Log.w(LogEvents.COURSE, `event=prune id=${id} version=${v}`);
        await FileStore.remove(`${root}/${id}/${v}`);
      }
      if (best !== undefined) {
        out.push(best);
      }
    }
    return out;
  }

  private async readRecord(id: string, version: string): Promise<CourseRecord | undefined> {
    const text = await FileStore.readText(`${this.courseDir(id, version)}/course.json`);
    if (text === undefined) {
      return undefined;
    }
    try {
      const r = JSON.parse(text) as Record<string, Object>;
      const rec = new CourseRecord();
      rec.id = str(r, 'id');
      rec.version = str(r, 'version');
      rec.installedAt = typeof r['installedAt'] === 'number' ? r['installedAt'] as number : 0;
      rec.packDir = str(r, 'packDir');
      rec.audioManifestPath = str(r, 'audioManifestPath');
      rec.summary = summaryFrom(r['summary']);
      const city = str(r, 'cityId');
      rec.cityId = validId(city) ? city : '';
      if (rec.id !== id || rec.version !== version || (rec.packDir !== '' && !safeRelPath(rec.packDir + 'x')) ||
        (rec.audioManifestPath !== '' && !safeRelPath(rec.audioManifestPath))) {
        return undefined;
      }
      if (rec.summary.id === '') {
        rec.summary.id = id;
        rec.summary.version = version;
        rec.summary.title.en = id;
      }
      return rec;
    } catch (e) {
      return undefined;
    }
  }

  static toInstalled(r: CourseRecord): InstalledCourse {
    const i = new InstalledCourse();
    i.id = r.id;
    i.version = r.version;
    i.summary = r.summary;
    return i;
  }

  /** Absolute folder of the pack of an installed course. */
  packPath(r: CourseRecord): string {
    const d = this.courseDir(r.id, r.version);
    return r.packDir === '' ? d : `${d}/${r.packDir.substring(0, r.packDir.length - 1)}`;
  }

  // ---------- catalog + active course ----------

  async readCatalog(): Promise<string | undefined> {
    return this.root() === '' ? undefined : FileStore.readText(`${this.root()}/catalog.json`);
  }

  async writeCatalog(text: string): Promise<void> {
    if (this.root() !== '') {
      await FileStore.writeText(`${this.root()}/catalog.json`, text);
    }
  }

  async readActive(): Promise<string> {
    if (this.root() === '') {
      return '';
    }
    const t = await FileStore.readText(`${this.root()}/active.json`);
    if (t === undefined) {
      return '';
    }
    try {
      const id = str(JSON.parse(t) as Record<string, Object>, 'id');
      return validId(id) ? id : '';
    } catch (e) {
      return '';
    }
  }

  async writeActive(id: string): Promise<void> {
    if (this.root() !== '') {
      const o: Record<string, string> = { 'id': id };
      await FileStore.writeText(`${this.root()}/active.json`, JSON.stringify(o));
    }
  }

  // ---------- install / delete ----------

  async remove(id: string): Promise<boolean> {
    if (!validId(id) || this.root() === '') {
      return false;
    }
    const ok = await FileStore.remove(`${this.root()}/${id}`);
    Log.i(LogEvents.COURSE, `event=delete id=${id} ok=${ok}`);
    return ok;
  }

  /**
   * Downloads and verifies every file of `m` into a temp folder, then swaps it in with one rename.
   * `summary` is the catalog row (stored for the offline list). Never rejects.
   */
  async install(client: RemoteClient, m: CourseManifest, summary: CourseSummary, cancel: CancelToken,
    onProgress: (p: InstallProgress) => void, opts?: InstallOptions): Promise<InstallResult> {
    const res = new InstallResult();
    const root = this.root();
    if (root === '') {
      res.error = 'no_context';
      return res;
    }
    const t0 = Date.now();
    const tmp = `${root}/.tmp/${m.courseId}-${m.version}`;
    if (!(await FileStore.mkdirs(tmp))) {
      res.error = 'mkdir';
      return res;
    }
    const prog = new InstallProgress();
    prog.totalBytes = manifestBytes(m);
    prog.totalFiles = m.files.length;
    onProgress(prog);
    Log.i(LogEvents.COURSE, `event=download_start id=${m.courseId} version=${m.version} files=${m.files.length}` +
      ` bytes=${prog.totalBytes}`);
    let failure = '';
    let next = 0;
    const worker = async (): Promise<void> => {
      while (failure === '' && !cancel.cancelled) {
        const i = next++;
        if (i >= m.files.length) {
          return;
        }
        const f = m.files[i];
        const dest = `${tmp}/${f.path}`;
        let err = '';
        if (await CourseStore.alreadyThere(f, dest)) {
          prog.resumedFiles++;
        } else if (opts !== undefined && opts.seedDir !== '' && await CourseStore.copyVerified(f,
          `${opts.seedDir}/${f.path}`, dest)) {
          prog.resumedFiles++;   // already verified in the stream folder (Download after Play now)
        } else {
          err = await this.fetchVerified(client, f, dest, cancel);
        }
        if (err === 'cancelled') {
          return;
        }
        if (err !== '') {
          failure = `${err} file=${f.path}`;
          return;
        }
        prog.doneBytes += f.bytes;
        prog.doneFiles++;
        try {
          onProgress(prog);
        } catch (e) {
          // progress listener errors never abort the download
        }
      }
    };
    const workers: Promise<void>[] = [];
    for (let k = 0; k < PARALLEL; k++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    if (cancel.cancelled && failure === '') {
      failure = 'cancelled';
    }
    if (failure === '') {
      const rec = new CourseRecord();
      rec.id = m.courseId;
      rec.version = m.version;
      rec.installedAt = Date.now();
      rec.packDir = packDir(m);
      rec.audioManifestPath = m.files.some((f: CourseFile) => f.path === m.audioManifestPath) ? m.audioManifestPath : '';
      rec.summary = summary;
      rec.cityId = m.cityId;
      let extrasOk = true;
      if (opts !== undefined) {
        for (const name of Array.from(opts.extraFiles.keys())) {
          extrasOk = extrasOk && await FileStore.writeText(`${tmp}/${name}`, opts.extraFiles.get(name) as string);
        }
      }
      if (!extrasOk || !(await FileStore.writeText(`${tmp}/course.json`, JSON.stringify(rec)))) {
        failure = 'write_record';
      } else {
        const dest = this.courseDir(m.courseId, m.version);
        await FileStore.remove(dest);   // a broken earlier copy of this exact version
        if (!(await FileStore.mkdirs(`${root}/${m.courseId}`)) || !(await FileStore.rename(tmp, dest))) {
          failure = 'rename';
        } else {
          for (const v of await FileStore.list(`${root}/${m.courseId}`)) {
            if (v !== m.version) {
              await FileStore.remove(`${root}/${m.courseId}/${v}`);
            }
          }
          res.ok = true;
          res.record = rec;
        }
      }
    }
    if (!res.ok) {
      // Cancel: forget the partial download. Any other failure: keep it, so Retry only fetches the missing files.
      const keep = failure !== 'cancelled' && failure !== 'rename' && failure !== 'write_record';
      if (!keep) {
        await FileStore.remove(tmp);
      }
      res.error = failure;
      Log.e(LogEvents.COURSE, `event=download_fail id=${m.courseId} version=${m.version} reason=${failure}` +
        ` done=${prog.doneFiles}/${prog.totalFiles} resumed=${prog.resumedFiles} keepTmp=${keep} ms=${Date.now() - t0}`);
    } else {
      Log.i(LogEvents.COURSE, `event=installed id=${m.courseId} version=${m.version} files=${m.files.length}` +
        ` bytes=${prog.totalBytes} resumed=${prog.resumedFiles} ms=${Date.now() - t0}`);
    }
    return res;
  }

  /** A file left by an earlier attempt with the right size and SHA-256 (async hash, off the UI thread). */
  private static async alreadyThere(f: CourseFile, path: string): Promise<boolean> {
    if ((await FileStore.size(path)) !== f.bytes) {
      return false;
    }
    return (await FileStore.sha256File(path)) === f.sha256;
  }

  /** Copies `from` to `dest` when `from` has the right size and SHA-256 (a file a stream already verified). */
  private static async copyVerified(f: CourseFile, from: string, dest: string): Promise<boolean> {
    if (!(await CourseStore.alreadyThere(f, from))) {
      return false;
    }
    const bytes = await FileStore.readBytes(from);
    if (bytes === undefined) {
      return false;
    }
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return (await FileStore.writeBytes(dest, buf)) && (await CourseStore.alreadyThere(f, dest));
  }

  /** '' when the file is on disk with the right size and SHA-256. */
  private async fetchVerified(client: RemoteClient, f: CourseFile, dest: string, cancel: CancelToken): Promise<string> {
    let last = '';
    for (let attempt = 0; attempt <= BLOB_RETRIES; attempt++) {
      if (cancel.cancelled) {
        return 'cancelled';
      }
      if (attempt > 0) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
      const h = await client.blob(f.sha256);
      if (h.status !== 200 || h.bytes === undefined) {
        last = h.status === 0 ? 'offline' : `http_${h.status}`;
        if (h.status === 404) {
          return last;
        }
        continue;
      }
      if (h.bytes.byteLength !== f.bytes) {
        last = `size expected=${f.bytes} got=${h.bytes.byteLength}`;
        continue;
      }
      const sha = await FileStore.sha256Bytes(new Uint8Array(h.bytes));
      if (sha !== f.sha256) {
        last = 'sha256_mismatch';
        continue;
      }
      if (!(await FileStore.writeBytes(dest, h.bytes))) {
        return 'write';
      }
      return '';
    }
    return last;
  }
}
