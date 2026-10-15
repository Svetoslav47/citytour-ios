/*
 * CourseRepository (docs/SERVER.md §6): the downloaded courses (filesDir/courses/<id>/<version>/, CourseStore). The
 * app ships NO built-in course: until the first download there is no active course and Home shows "Download your
 * first walk". It owns:
 *   - the catalog: fetched from the server (signed, verified) and kept as the last good copy for offline use;
 *   - download / update / delete of courses, with progress and cancel;
 *   - the ACTIVE course ('' = none): which pack ActivePackRepository forwards to (Home, Tour detail, the tour itself)
 *     and which clip manifest NarrationPlayer loads (listeners). The first successful download becomes active.
 *   - the CITY places packs (filesDir/cities/<cityId>/<version>/, SERVER.md §3 R7): a course with a `cityId` is layered
 *     over its city's pack (CityCoursePackRepository). The city is downloaded with the first course of that city (one
 *     progress bar for both), updated with a course when the catalog has a newer city, and removed with the last
 *     course that uses it.
 * STREAMED courses ("Play now", core/remote/StreamRules, SERVER.md §6): filesDir/stream/<id>/<version>/ holds a
 * course's small files (no clips; the clips stream on demand, StreamClips) and filesDir/stream-cities/<cityId>/<version>/
 * only the city's manifest, city.json and map. Verified and installed with the same atomic installer as a download.
 * A streamed course can be the active one (it survives a restart); a download of the same course wins, reuses the
 * stream's verified files and then removes the stream. Delete removes both.
 * The merge/state rules are the pure core/remote/CourseRules. Nothing here blocks the UI thread: all IO is async.
 * With BASE_URL '' (RemoteConfig) the network is never used; downloaded courses (if any) still work.
 */
import { PackLoadResult } from '@citytour/core';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';
import { activeAfterInstall, InstalledCourse, resolveActive } from '@citytour/core';
import { chooseCover, CoverChoice, CoverCredit } from '@citytour/core';
import {
  cityName, CitySummary, CourseFile, CourseManifest, CourseSummary, manifestBytes
} from '@citytour/core';
import { cityNeedsDownload, orphanCities } from '@citytour/core';
import {
  activeCandidates, allPlacesAvailable, streamCityFiles, streamClipFiles, streamCourseFiles, streamNeedsPrepare
} from '@citytour/core';
import { PackRepository } from '@citytour/core';
import { ActivePackRepository, PackChoice } from '../pack/ActivePackRepository';
import { CityCoursePackRepository } from '../pack/CityCoursePackRepository';
import { FilePackRepository } from '../pack/FilePackRepository';
import { CancelToken, CourseRecord, CourseStore, InstallOptions, InstallProgress } from './CourseStore';
import { STREAM_CLIPS_FILE } from './StreamClips';
import { CoverStore, InstalledCover } from './CoverStore';
import { RemoteClient } from './RemoteClient';

/** What the speech side needs to know about the active course. */
export class ActiveCourse {
  /** '' = no course installed. */
  id: string = '';
  /** Absolute course root ('' = no course). */
  root: string = '';
  /** Course-relative clip manifest path ('' = none). */
  audioManifestPath: string = '';
  /** A streamed course ("Play now"): its clips are fetched on demand (StreamClips). */
  streamed: boolean = false;
}

export type ActiveCourseListener = (c: ActiveCourse) => void;

export enum CatalogSource { NONE = 'none', SERVER = 'server', CACHE = 'cache' }

export class CatalogState {
  source: CatalogSource = CatalogSource.NONE;
  courses: CourseSummary[] | undefined = undefined;
  /** Catalog `cities` (empty for an older catalog). */
  cities: CitySummary[] = [];
  /** '' = fine; else why the server could not be used (offline, bad_signature, no_public_key, disabled ...). */
  error: string = '';
  fetchedAt: number = 0;
}

/** The full cover credit of an installed course (About & licences). */
export class CourseCoverCredit {
  id: string = '';
  summary: CourseSummary = new CourseSummary();
  credit: CoverCredit = new CoverCredit();
}

export class OpResult {
  ok: boolean = false;
  error: string = '';
  /** remove(): the city places pack removed with the last course of that city ('' = none). */
  cityRemoved: string = '';
}

export class CourseRepository {
  private readonly client: RemoteClient;
  private readonly store: CourseStore;
  private readonly pack: ActivePackRepository;
  private readonly covers: CoverStore | undefined;
  private readonly cityStore: CourseStore | undefined;
  private readonly streamStore: CourseStore | undefined;
  private readonly streamCityStore: CourseStore | undefined;
  private records: CourseRecord[] = [];
  private cityRecords: CourseRecord[] = [];
  private streamRecords: CourseRecord[] = [];
  private streamCityRecords: CourseRecord[] = [];
  private catalogState: CatalogState = new CatalogState();
  private listeners: ActiveCourseListener[] = [];
  private initP: Promise<void> | undefined = undefined;
  private busy: Set<string> = new Set<string>();

  constructor(client: RemoteClient, store: CourseStore, pack: ActivePackRepository, covers?: CoverStore,
    cityStore?: CourseStore, streamStore?: CourseStore, streamCityStore?: CourseStore) {
    this.client = client;
    this.store = store;
    this.pack = pack;
    this.covers = covers;
    this.cityStore = cityStore;
    this.streamStore = streamStore;
    this.streamCityStore = streamCityStore;
  }

  private isStreamRec(rec: CourseRecord): boolean {
    return this.streamRecords.indexOf(rec) >= 0;
  }

  /** The store a record lives in (a streamed course: the stream folder). */
  private storeOf(rec: CourseRecord): CourseStore {
    return this.isStreamRec(rec) && this.streamStore !== undefined ? this.streamStore : this.store;
  }

  /**
   * The pack of an installed course: its own pack layered over its city's places pack when it has a city (a missing
   * city pack fails to load: Home shows the error state and the Courses screen can re-download), else its own pack.
   */
  private packFor(rec: CourseRecord): PackRepository {
    const store = this.storeOf(rec);
    if (rec.cityId === '' || this.cityStore === undefined) {
      return new FilePackRepository(store.packPath(rec));
    }
    const city = this.cityRecord(rec.cityId);
    // A streamed course without the downloaded city: the stream's partial city (manifest, city.json, map).
    const sc = city === undefined && this.isStreamRec(rec) ? this.streamCityRecord(rec.cityId) : undefined;
    if (sc !== undefined && this.streamCityStore !== undefined) {
      return new CityCoursePackRepository(this.streamCityStore.packPath(sc), store.packPath(rec), true);
    }
    const cityDir = city !== undefined ? this.cityStore.packPath(city) : `${this.cityStore.root()}/${rec.cityId}/missing`;
    if (city === undefined) {
      Log.e(LogEvents.COURSE, `event=city_missing id=${rec.id} city=${rec.cityId}`);
    }
    return new CityCoursePackRepository(cityDir, store.packPath(rec));
  }

  private streamCityRecord(id: string): CourseRecord | undefined {
    return this.streamCityRecords.find((r: CourseRecord) => r.id === id);
  }

  private streamRecord(id: string): CourseRecord | undefined {
    return this.streamRecords.find((r: CourseRecord) => r.id === id);
  }

  /** Streamed (not downloaded) course ids. */
  streamedIds(): string[] {
    return this.streamRecords.filter((r: CourseRecord) => this.downloadedRecord(r.id) === undefined)
      .map((r: CourseRecord) => r.id);
  }

  /** The active course streams (its clips come on demand, its city's places are not on the device). */
  activeIsStreamed(): boolean {
    const rec = this.record(this.pack.activeId());
    return rec !== undefined && this.isStreamRec(rec);
  }

  /** "All places" (the whole city) can be shown for the active course: its city pack is downloaded (or it has none). */
  allPlacesReady(): boolean {
    const rec = this.record(this.pack.activeId());
    return rec === undefined || allPlacesAvailable(rec.cityId, this.cityStore === undefined || this.hasCity(rec.cityId));
  }

  /** The active course's city ('' = none, or a self-contained course). */
  activeCityId(): string {
    const rec = this.record(this.pack.activeId());
    return rec !== undefined ? rec.cityId : '';
  }

  private cityRecord(id: string): CourseRecord | undefined {
    return this.cityRecords.find((r: CourseRecord) => r.id === id);
  }

  /** A course's city for its row: the catalog city's name in `uiLang`, else the summary's display name. */
  cityLabel(s: CourseSummary, uiLang: string): string {
    const c = this.catalogState.cities.find((x: CitySummary) => x.id === s.cityId);
    return c !== undefined ? cityName(c.names, s.city !== '' ? s.city : c.id, uiLang) : s.city;
  }

  /** The city places pack `id` is installed. */
  hasCity(id: string): boolean {
    return this.cityRecord(id) !== undefined;
  }

  /** The catalog size of city `id`'s places pack (0 = unknown). */
  cityBytes(id: string): number {
    const c = this.catalogState.cities.find((x: CitySummary) => x.id === id);
    return c !== undefined ? c.bytes : 0;
  }

  /** Installed city places packs (id@version), for logs and the dev panel. */
  installedCities(): string[] {
    return this.cityRecords.map((r: CourseRecord) => `${r.id}@${r.version}`);
  }

  /**
   * Start-up (AppContainer.init): reads the installed courses and the active id, hands ActivePackRepository the
   * pack to load first (none when nothing is installed), and announces the active course once it has loaded.
   * Never rejects.
   */
  start(): void {
    let saved = '';
    const chosen: Promise<PackChoice | undefined> = this.init().then(async (): Promise<PackChoice | undefined> => {
      saved = await this.store.readActive();
      const id = resolveActive(saved, activeCandidates(this.installed(), this.streamedInstalled()));
      const rec = this.record(id);
      if (rec === undefined) {
        return undefined;
      }
      return new PackChoice(this.packFor(rec), id);
    });
    this.pack.setStartupChoice(chosen);
    chosen.then(async () => {
      await this.pack.load();
      const now = this.pack.activeId();
      if (now !== saved) {
        await this.store.writeActive(now);   // the saved course is gone: another installed one, or none
      }
      this.announce();
    }).catch((e: Object) => {
      Log.e(LogEvents.COURSE, `event=start_fail ${Log.errKv(e)}`);
      this.announce();
    });
  }

  init(): Promise<void> {
    if (this.initP === undefined) {
      this.initP = this.doInit();
    }
    return this.initP;
  }

  private async doInit(): Promise<void> {
    try {
      await this.store.cleanTemp();
      this.records = await this.store.installed();
      if (this.cityStore !== undefined) {
        await this.cityStore.cleanTemp();
        this.cityRecords = await this.cityStore.installed();
      }
      if (this.streamStore !== undefined) {
        await this.streamStore.cleanTemp();
        this.streamRecords = await this.streamStore.installed();
      }
      if (this.streamCityStore !== undefined) {
        await this.streamCityStore.cleanTemp();
        this.streamCityRecords = await this.streamCityStore.installed();
      }
      const cached = await this.store.readCatalog();
      if (cached !== undefined && this.client.canVerify()) {
        const r = await this.client.acceptCatalog(cached);
        if (r.ok) {
          this.catalogState.source = CatalogSource.CACHE;
          this.catalogState.courses = r.courses;
          this.catalogState.cities = r.cities;
        }
      }
      Log.i(LogEvents.COURSE, `event=init installed=${this.records.length}` +
        ` ids=${this.records.map((r: CourseRecord) => `${r.id}@${r.version}`).join(',') || 'none'}` +
        ` cities=${this.installedCities().join(',') || 'none'}` +
        ` streamed=${this.streamRecords.map((r: CourseRecord) => `${r.id}@${r.version}`).join(',') || 'none'} cachedCatalog=${this.catalogState.source === CatalogSource.CACHE}`);
    } catch (e) {
      Log.e(LogEvents.COURSE, `event=init_fail ${Log.errKv(e as Object)}`);
    }
  }

  serverEnabled(): boolean {
    return this.client.enabled();
  }

  installed(): InstalledCourse[] {
    return this.records.map((r: CourseRecord) => CourseStore.toInstalled(r));
  }

  private streamedInstalled(): InstalledCourse[] {
    return this.streamRecords.map((r: CourseRecord) => CourseStore.toInstalled(r));
  }

  catalog(): CatalogState {
    return this.catalogState;
  }

  activeId(): string {
    return this.pack.activeId();
  }

  hasCourse(): boolean {
    return this.pack.hasCourse();
  }

  isBusy(id: string): boolean {
    return this.busy.has(id);
  }

  addListener(l: ActiveCourseListener): void {
    this.listeners.push(l);
  }

  activeCourse(): ActiveCourse {
    const c = new ActiveCourse();
    c.id = this.pack.activeId();
    const rec = this.record(c.id);
    if (rec === undefined) {
      c.id = '';
      return c;
    }
    c.root = this.storeOf(rec).courseDir(rec.id, rec.version);
    c.audioManifestPath = rec.audioManifestPath;
    c.streamed = this.isStreamRec(rec);
    return c;
  }

  /** GET /v1/catalog; on success the envelope becomes the offline copy. On failure the cached copy stays. */
  async refreshCatalog(): Promise<CatalogState> {
    await this.init();
    if (!this.client.enabled()) {
      this.catalogState.error = 'disabled';
      return this.catalogState;
    }
    const r = await this.client.catalog();
    if (r.ok) {
      const s = new CatalogState();
      s.source = CatalogSource.SERVER;
      s.courses = r.courses;
      s.cities = r.cities;
      s.fetchedAt = Date.now();
      this.catalogState = s;
      await this.store.writeCatalog(r.text);
    } else {
      this.catalogState.error = r.error;
      Log.w(LogEvents.COURSE, `event=catalog_fail reason=${r.error} keep=${this.catalogState.source}`);
    }
    return this.catalogState;
  }

  /** Download (or update) a course from the catalog. Never rejects. */
  async download(id: string, cancel: CancelToken, onProgress: (p: InstallProgress) => void): Promise<OpResult> {
    const out = new OpResult();
    await this.init();
    if (this.busy.has(id)) {
      out.error = 'busy';
      return out;
    }
    const courses = this.catalogState.courses;
    const summary = courses === undefined ? undefined : courses.find((c: CourseSummary) => c.id === id);
    if (summary === undefined) {
      out.error = 'not_in_catalog';
      return out;
    }
    this.busy.add(id);
    try {
      const m = await this.client.manifest(id);
      if (!m.ok || m.manifest === undefined) {
        out.error = m.error;
        Log.w(LogEvents.COURSE, `event=manifest_fail id=${id} reason=${m.error}`);
        return out;
      }
      const cm = m.manifest;
      // A course of a city: fetch the city's places pack first when it is missing or the catalog has a newer one.
      // One progress bar covers both (city bytes first, then the course's).
      let cityManifest: CourseManifest | undefined = undefined;
      const cityRec = cm.cityId !== '' ? this.cityRecord(cm.cityId) : undefined;
      const catCity = this.catalogState.cities.find((c: CitySummary) => c.id === cm.cityId);
      if (cm.cityId !== '' && this.cityStore !== undefined &&
        cityNeedsDownload(cityRec !== undefined ? cityRec.version : '', catCity !== undefined ? catCity.version : '')) {
        const cmr = await this.client.cityManifest(cm.cityId);
        if (!cmr.ok || cmr.manifest === undefined) {
          if (cityRec === undefined) {
            out.error = `city_${cmr.error}`;
            Log.w(LogEvents.COURSE, `event=city_manifest_fail id=${id} city=${cm.cityId} reason=${cmr.error}`);
            return out;
          }
          // An installed (older) city still works: keep it, update the course.
          Log.w(LogEvents.COURSE, `event=city_update_skip city=${cm.cityId} reason=${cmr.error}`);
        } else if (cityRec === undefined || cmr.manifest.version !== cityRec.version) {
          cityManifest = cmr.manifest;
        }
      }
      const cityBytes = cityManifest !== undefined ? manifestBytes(cityManifest) : 0;
      const cityFiles = cityManifest !== undefined ? cityManifest.files.length : 0;
      const allBytes = cityBytes + manifestBytes(cm);
      const allFiles = cityFiles + cm.files.length;
      if (cityManifest !== undefined) {
        const cityErr = await this.installCity(cityManifest, catCity, cancel,
          (p: InstallProgress) => onProgress(CourseRepository.offset(p, 0, 0, allBytes, allFiles)), id);
        if (cityErr !== '') {
          out.error = `city_${cityErr}`;
          return out;
        }
      }
      // Download after Play now: the stream's verified files (small files + every clip already played) are reused.
      const opts = new InstallOptions();
      const st = this.streamRecord(id);
      opts.seedDir = st !== undefined && this.streamStore !== undefined ? this.streamStore.courseDir(st.id, st.version) : '';
      const res = await this.store.install(this.client, cm, summary, cancel,
        (p: InstallProgress) => onProgress(CourseRepository.offset(p, cityBytes, cityFiles, allBytes, allFiles)), opts);
      if (!res.ok || res.record === undefined) {
        out.error = res.error;
        return out;
      }
      const rec: CourseRecord = res.record;
      this.records = this.records.filter((r: CourseRecord) => r.id !== id);
      this.records.push(rec);
      // An update of the active course: switch to the new version now (the old folder is gone). The first course
      // downloaded becomes the active one.
      const before = this.pack.activeId();
      if (before === id || activeAfterInstall(before, id) === id) {
        const a = await this.activate(id);
        if (!a.ok) {
          out.error = `activate_${a.error}`;
          return out;
        }
      }
      if (st !== undefined) {
        await this.dropStream(id);   // the download (now the active copy when it was playing) replaces the stream
      }
      out.ok = true;
      return out;
    } catch (e) {
      out.error = `exception ${Log.errKv(e as Object)}`;
      Log.e(LogEvents.COURSE, `event=download_fail id=${id} ${out.error}`);
      return out;
    } finally {
      this.busy.delete(id);
    }
  }

  /**
   * Installs city places pack `cityManifest` (seeded from the stream city's verified files) and, when the active
   * course is another course of that city, reloads it on the new city folder (`forId` = the course being downloaded,
   * '' = none). Resolves '' on success, else the error.
   */
  private async installCity(cityManifest: CourseManifest, catCity: CitySummary | undefined, cancel: CancelToken,
    onProgress: (p: InstallProgress) => void, forId: string): Promise<string> {
    if (this.cityStore === undefined) {
      return 'no_city_store';
    }
    const cityStore: CourseStore = this.cityStore;
    const citySummary = new CourseSummary();
    citySummary.id = cityManifest.courseId;
    citySummary.version = cityManifest.version;
    citySummary.cityId = cityManifest.courseId;
    if (catCity !== undefined) {
      citySummary.title = catCity.names;
      citySummary.city = catCity.names.en;
      citySummary.bytes = catCity.bytes;
    }
    const cityOpts = new InstallOptions();
    const sc = this.streamCityRecord(cityManifest.courseId);
    cityOpts.seedDir = sc !== undefined && this.streamCityStore !== undefined ?
      this.streamCityStore.courseDir(sc.id, sc.version) : '';
    const cr = await cityStore.install(this.client, cityManifest, citySummary, cancel, onProgress, cityOpts);
    if (!cr.ok || cr.record === undefined) {
      return cr.error !== '' ? cr.error : 'install_failed';
    }
    const newCity: CourseRecord = cr.record;
    this.cityRecords = this.cityRecords.filter((r: CourseRecord) => r.id !== newCity.id);
    this.cityRecords.push(newCity);
    Log.i(LogEvents.COURSE, `event=city_installed city=${newCity.id} version=${newCity.version} for=${forId || 'explore'}`);
    // The active course of this city was reading the old (or the stream's partial) city folder: reload it on the new one.
    const act = this.record(this.pack.activeId());
    if (act !== undefined && act.id !== forId && act.cityId === newCity.id) {
      await this.activate(act.id);
    }
    return '';
  }

  /**
   * Home "Explore" on a streamed walk (or right after Explore made one active): downloads only the city's places pack
   * (every place, for the full map), not a whole walk. Already installed and current: nothing to do. The active course
   * of that city is reloaded on it. Never rejects.
   */
  async downloadCity(cityId: string, cancel: CancelToken, onProgress: (p: InstallProgress) => void): Promise<OpResult> {
    const out = new OpResult();
    await this.init();
    const key = `city:${cityId}`;
    if (cityId === '' || this.cityStore === undefined) {
      out.error = cityId === '' ? 'no_city' : 'no_city_store';
      return out;
    }
    if (this.busy.has(key)) {
      out.error = 'busy';
      return out;
    }
    const cityRec = this.cityRecord(cityId);
    const catCity = this.catalogState.cities.find((c: CitySummary) => c.id === cityId);
    if (cityRec !== undefined &&
      !cityNeedsDownload(cityRec.version, catCity !== undefined ? catCity.version : '')) {
      out.ok = true;
      return out;
    }
    if (!this.client.enabled()) {
      out.error = 'disabled';
      return out;
    }
    this.busy.add(key);
    const t0 = Date.now();
    try {
      const cmr = await this.client.cityManifest(cityId);
      if (!cmr.ok || cmr.manifest === undefined) {
        out.error = `city_${cmr.error}`;
        Log.w(LogEvents.COURSE, `event=city_manifest_fail city=${cityId} reason=${cmr.error} for=explore`);
        return out;
      }
      const err = await this.installCity(cmr.manifest, catCity, cancel, onProgress, '');
      if (err !== '') {
        out.error = `city_${err}`;
        Log.w(LogEvents.COURSE, `event=city_download_fail city=${cityId} reason=${err} for=explore`);
        return out;
      }
      Log.i(LogEvents.COURSE, `event=city_download_ok city=${cityId} bytes=${manifestBytes(cmr.manifest)}` +
        ` ms=${Date.now() - t0} for=explore`);
      out.ok = true;
      return out;
    } catch (e) {
      out.error = `exception ${Log.errKv(e as Object)}`;
      Log.e(LogEvents.COURSE, `event=city_download_fail city=${cityId} ${out.error}`);
      return out;
    } finally {
      this.busy.delete(key);
    }
  }

  /** A course-install progress shifted behind the city pack's bytes/files, out of the total of both. */
  private static offset(p: InstallProgress, bytes: number, files: number, allBytes: number,
    allFiles: number): InstallProgress {
    const q = new InstallProgress();
    q.resumedFiles = p.resumedFiles;
    q.doneBytes = bytes + p.doneBytes;
    q.doneFiles = files + p.doneFiles;
    q.totalBytes = Math.max(allBytes, q.doneBytes);
    q.totalFiles = Math.max(allFiles, q.doneFiles);
    return q;
  }

  /**
   * Deletes a downloaded and/or streamed course. When it was the active one, another course becomes active (CourseRules
   * resolveActive over the downloaded, then the streamed courses), or none: Home goes back to its empty state.
   */
  async remove(id: string): Promise<OpResult> {
    const out = new OpResult();
    await this.init();
    const dl = this.downloadedRecord(id);
    const st = this.streamRecord(id);
    if ((dl === undefined && st === undefined) || this.busy.has(id)) {
      out.error = this.busy.has(id) ? 'busy' : 'not_installed';
      return out;
    }
    const wasActive = this.pack.activeId() === id;
    this.records = this.records.filter((r: CourseRecord) => r.id !== id);
    this.streamRecords = this.streamRecords.filter((r: CourseRecord) => r.id !== id);
    if (wasActive) {
      const next = resolveActive('', activeCandidates(this.installed(), this.streamedInstalled()));
      const rec = this.record(next);
      let switched = false;
      if (rec !== undefined) {
        switched = (await this.pack.switchTo(this.packFor(rec), next)).ok;
      }
      if (!switched) {
        await this.pack.switchToNone();
      }
      await this.store.writeActive(this.pack.activeId());
      this.announce();
    }
    out.ok = true;
    if (dl !== undefined) {
      out.ok = await this.store.remove(id);
    }
    if (st !== undefined && this.streamStore !== undefined) {
      out.ok = (await this.streamStore.remove(id)) && out.ok;
    }
    if (!out.ok) {
      out.error = 'remove_failed';
    }
    // The last course of a city is gone: its places pack goes too (nothing else reads it).
    if (this.cityStore !== undefined) {
      const used: string[] = this.records.concat(this.streamRecords).map((r: CourseRecord) => r.cityId);
      for (const c of orphanCities(this.cityRecords.map((r: CourseRecord) => r.id), used)) {
        if (await this.cityStore.remove(c)) {
          this.cityRecords = this.cityRecords.filter((r: CourseRecord) => r.id !== c);
          out.cityRemoved = c;
          Log.i(LogEvents.COURSE, `event=city_removed city=${c} after=${id}`);
        }
      }
    }
    await this.pruneStreamCities();
    return out;
  }

  /** Removes the stream of `id` (after a Download replaced it). The active course is never the stream here. */
  private async dropStream(id: string): Promise<void> {
    this.streamRecords = this.streamRecords.filter((r: CourseRecord) => r.id !== id);
    if (this.streamStore !== undefined) {
      await this.streamStore.remove(id);
    }
    await this.pruneStreamCities();
    Log.i(LogEvents.COURSE, `event=stream_removed id=${id} reason=downloaded`);
  }

  /** Stream cities no streamed course uses any more. */
  private async pruneStreamCities(): Promise<void> {
    if (this.streamCityStore === undefined) {
      return;
    }
    const used: string[] = this.streamRecords.map((r: CourseRecord) => r.cityId);
    for (const c of orphanCities(this.streamCityRecords.map((r: CourseRecord) => r.id), used)) {
      if (await this.streamCityStore.remove(c)) {
        this.streamCityRecords = this.streamCityRecords.filter((r: CourseRecord) => r.id !== c);
      }
    }
  }

  /**
   * "Play now": streams course `id` (StreamRules). Verifies the signed manifests like a download, fetches only the
   * small files (the course without its clips, the city's manifest, city.json and map) into the stream folder, then
   * makes it the active course. A downloaded course, or an up-to-date stream, is just activated (works offline).
   * Never rejects.
   */
  async stream(id: string, cancel: CancelToken, onProgress: (p: InstallProgress) => void): Promise<OpResult> {
    const out = new OpResult();
    await this.init();
    if (this.busy.has(id)) {
      out.error = 'busy';
      return out;
    }
    const courses = this.catalogState.courses;
    const summary = courses === undefined ? undefined : courses.find((c: CourseSummary) => c.id === id);
    const existing = this.streamRecord(id);
    if (this.downloadedRecord(id) !== undefined ||
      (existing !== undefined && !streamNeedsPrepare(existing.version, summary !== undefined ? summary.version : ''))) {
      return this.activate(id);
    }
    if (summary === undefined || this.streamStore === undefined) {
      out.error = summary === undefined ? 'not_in_catalog' : 'no_stream_store';
      return out;
    }
    if (!this.client.enabled()) {
      out.error = 'disabled';
      return out;
    }
    const streamStore: CourseStore = this.streamStore;
    this.busy.add(id);
    const t0 = Date.now();
    try {
      const m = await this.client.manifest(id);
      if (!m.ok || m.manifest === undefined) {
        Log.w(LogEvents.COURSE, `event=stream_manifest_fail id=${id} reason=${m.error}`);
        if (existing !== undefined) {
          this.busy.delete(id);
          return this.activate(id);   // an older stream still plays
        }
        out.error = m.error;
        return out;
      }
      const cm = m.manifest;
      // The city: the downloaded one when there is one, else a partial stream city (manifest, city.json, map).
      let cityM: CourseManifest | undefined = undefined;
      if (cm.cityId !== '' && !this.hasCity(cm.cityId) && this.streamCityStore !== undefined) {
        const sc = this.streamCityRecord(cm.cityId);
        const catCity = this.catalogState.cities.find((c: CitySummary) => c.id === cm.cityId);
        if (cityNeedsDownload(sc !== undefined ? sc.version : '', catCity !== undefined ? catCity.version : '')) {
          const cmr = await this.client.cityManifest(cm.cityId);
          if (cmr.ok && cmr.manifest !== undefined) {
            if (sc === undefined || cmr.manifest.version !== sc.version) {
              cityM = CourseRepository.withFiles(cmr.manifest, streamCityFiles(cmr.manifest.files));
            }
          } else if (sc === undefined) {
            out.error = `city_${cmr.error}`;
            Log.w(LogEvents.COURSE, `event=stream_city_fail id=${id} city=${cm.cityId} reason=${cmr.error}`);
            return out;
          }
        }
      }
      const courseM = CourseRepository.withFiles(cm, streamCourseFiles(cm.files, cm.audioManifestPath));
      const clips = streamClipFiles(cm.files, cm.audioManifestPath);
      const cityBytes = cityM !== undefined ? manifestBytes(cityM) : 0;
      const cityFiles = cityM !== undefined ? cityM.files.length : 0;
      const allBytes = cityBytes + manifestBytes(courseM);
      const allFiles = cityFiles + courseM.files.length;
      if (cityM !== undefined && this.streamCityStore !== undefined) {
        const citySummary = new CourseSummary();
        citySummary.id = cityM.courseId;
        citySummary.version = cityM.version;
        citySummary.cityId = cityM.courseId;
        const cr = await this.streamCityStore.install(this.client, cityM, citySummary, cancel,
          (p: InstallProgress) => onProgress(CourseRepository.offset(p, 0, 0, allBytes, allFiles)));
        if (!cr.ok || cr.record === undefined) {
          out.error = `city_${cr.error}`;
          return out;
        }
        const newCity: CourseRecord = cr.record;
        this.streamCityRecords = this.streamCityRecords.filter((r: CourseRecord) => r.id !== newCity.id);
        this.streamCityRecords.push(newCity);
      }
      const opts = new InstallOptions();
      opts.extraFiles.set(STREAM_CLIPS_FILE, JSON.stringify(clips));
      const res = await streamStore.install(this.client, courseM, summary, cancel,
        (p: InstallProgress) => onProgress(CourseRepository.offset(p, cityBytes, cityFiles, allBytes, allFiles)), opts);
      if (!res.ok || res.record === undefined) {
        out.error = res.error;
        return out;
      }
      const rec: CourseRecord = res.record;
      this.streamRecords = this.streamRecords.filter((r: CourseRecord) => r.id !== id);
      this.streamRecords.push(rec);
      Log.i(LogEvents.COURSE, `event=stream_ready id=${id} version=${rec.version} files=${courseM.files.length}` +
        ` cityFiles=${cityFiles} bytes=${allBytes} clipsOnDemand=${clips.length} ms=${Date.now() - t0}`);
      this.busy.delete(id);
      const a = await this.activate(id);
      if (!a.ok) {
        out.error = `activate_${a.error}`;
        return out;
      }
      out.ok = true;
      return out;
    } catch (e) {
      out.error = `exception ${Log.errKv(e as Object)}`;
      Log.e(LogEvents.COURSE, `event=stream_fail id=${id} ${out.error}`);
      return out;
    } finally {
      this.busy.delete(id);
    }
  }

  /** A copy of a signed manifest with only `files` (what a stream fetches up front). */
  private static withFiles(m: CourseManifest, files: CourseFile[]): CourseManifest {
    const c = new CourseManifest();
    c.schemaVersion = m.schemaVersion;
    c.courseId = m.courseId;
    c.version = m.version;
    c.publishedAt = m.publishedAt;
    c.packId = m.packId;
    c.files = files;
    c.audioManifestPath = m.audioManifestPath;
    c.audioClips = m.audioClips;
    c.allowedTtsSha = m.allowedTtsSha;
    c.cityId = m.cityId;
    return c;
  }

  /** Makes a downloaded course the active one. Never rejects. */
  async activate(id: string): Promise<OpResult> {
    const out = new OpResult();
    await this.init();
    const rec = this.record(id);
    if (rec === undefined) {
      out.error = 'not_installed';
      return out;
    }
    const r: PackLoadResult = await this.pack.switchTo(this.packFor(rec), id);
    if (!r.ok) {
      out.error = 'load_failed';
      return out;
    }
    await this.store.writeActive(id);
    this.announce();
    out.ok = true;
    return out;
  }

  // ---------- cover photos (core/remote/CoverRules.ets) ----------

  /**
   * The cover of course `id`: the installed pack's own cover, else the catalog cover (from the cache; fetched and
   * verified first when `fetch` is true), else none (CoverSource.NONE: the caller shows its fallback). Never rejects.
   */
  async coverFor(id: string, fetch: boolean): Promise<CoverChoice> {
    try {
      await this.init();
      const rec = this.record(id);
      const inst: InstalledCover = rec === undefined ? new InstalledCover() :
        await CoverStore.installed(this.storeOf(rec).packPath(rec));
      const courses = this.catalogState.courses;
      const cat = courses === undefined ? undefined : courses.find((c: CourseSummary) => c.id === id);
      const summary: CourseSummary | undefined = cat !== undefined ? cat : rec?.summary;
      let cached = '';
      if (inst.path === '' && summary !== undefined && summary.coverBlob !== '' && this.covers !== undefined) {
        cached = fetch ? await this.covers.ensure(summary.coverBlob) : await this.covers.cached(summary.coverBlob);
      }
      return chooseCover(inst.path, inst.credit, cached, summary !== undefined ? summary.coverCredit : '');
    } catch (e) {
      Log.e(LogEvents.COURSE, `event=cover_lookup_fail id=${id} ${Log.errKv(e as Object)}`);
      return new CoverChoice();
    }
  }

  /** The full cover credits of the installed courses that have a cover (About & licences). Never rejects. */
  async coverCredits(): Promise<CourseCoverCredit[]> {
    const out: CourseCoverCredit[] = [];
    try {
      await this.init();
      for (const rec of this.records) {
        const inst = await CoverStore.installed(this.store.packPath(rec));
        if (inst.path !== '' && inst.credit !== undefined) {
          const c = new CourseCoverCredit();
          c.id = rec.id;
          c.summary = rec.summary;
          c.credit = inst.credit;
          out.push(c);
        }
      }
    } catch (e) {
      Log.e(LogEvents.COURSE, `event=cover_credits_fail ${Log.errKv(e as Object)}`);
    }
    return out;
  }

  /** The course's record: the download when there is one, else the stream. */
  private record(id: string): CourseRecord | undefined {
    const d = this.downloadedRecord(id);
    return d !== undefined ? d : this.streamRecord(id);
  }

  private downloadedRecord(id: string): CourseRecord | undefined {
    return this.records.find((r: CourseRecord) => r.id === id);
  }

  private announce(): void {
    const c = this.activeCourse();
    Log.i(LogEvents.COURSE, `event=active_course id=${c.id || 'none'}` +
      ` clips=${c.audioManifestPath !== '' ? c.audioManifestPath : 'none'}`);
    for (const l of this.listeners) {
      try {
        l(c);
      } catch (e) {
        Log.e(LogEvents.UNCAUGHT, `where=CourseRepository.announce ${Log.errKv(e as Object)}`);
      }
    }
  }
}
