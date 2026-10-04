/*
 * Courses screen view model (docs/SERVER.md §6 "Courses screen") and the persisted "Online studio voice" setting.
 * Rows come from the pure core/remote/CourseRules.mergeCourses over CourseRepository's installed courses, its
 * catalog (server or the last verified offline copy). The app ships no built-in course. Each row shows title (UI
 * language), city, stops · km · minutes, languages, size, and its state: Download (size) / progress % + Cancel /
 * Downloaded ✓ / Update / Retry / Delete; selecting a downloaded course makes it the active course for Home and Tour
 * detail. The first download becomes the active course on its own (CourseRepository).
 * States: server disabled (BASE_URL '') -> "No course server"; offline -> cached catalog + "Offline" note + Retry;
 * no cached catalog and offline -> downloaded courses only + note + Retry. Every call is bounded (withTimeout) and
 * never throws.
 * Play now (core/remote/StreamRules): streams a course instead of downloading it ("Preparing…" while its small files
 * are fetched), makes it the active course and goes back to Home; Download stays the offline option (it also upgrades
 * a streamed course, reusing what was already fetched).
 * RemoteSettings persists (platform/Persist connect, the PersistenceV2 port) under 'remoteSettings' (no change to
 * the UserSettings contract).
 */
import { proxy } from 'valtio';
import { connect } from '../platform/Persist';
import { Lang } from '@citytour/core';
import { AppContainer } from '@/main/AppContainer';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';
import {
  CourseRow, CourseState, courseTitle, downloadBytes, InstalledCourse, mergeCourses, progressPct, sizeLabel
} from '@citytour/core';
import { CoverChoice, rowHasCover } from '@citytour/core';
import { StreamCourseSource as CourseSource, courseSource, streamRowActions, StreamRowActions } from '@citytour/core';
import { CatalogSource, CatalogState, OpResult } from '../services/remote/CourseRepository';
import { CancelToken, InstallProgress } from '../services/remote/CourseStore';
import { AppViewModel, PackState } from './AppViewModel';
import { withTimeout } from './Async';
import { MapCache } from './MapViewModel';

/** The active course changed: drop the cached detail map and let Home / About re-read the pack. */
function notifyCourseChanged(): void {
  MapCache.reset();
  AppViewModel.get().courseChanged();
}

export const REMOTE_SETTINGS_KEY: string = 'remoteSettings';

export class RemoteSettings {
  onlineStudioVoice: boolean = true;

  private static inst: RemoteSettings | undefined = undefined;

  static get(): RemoteSettings {
    if (RemoteSettings.inst === undefined) {
      let x: RemoteSettings | undefined = undefined;
      try {
        x = connect(REMOTE_SETTINGS_KEY, () => new RemoteSettings());
      } catch (e) {
        Log.e(LogEvents.UNCAUGHT, `where=RemoteSettings.get ${Log.errKv(e as Object)}`);
      }
      RemoteSettings.inst = x !== undefined ? x : proxy(new RemoteSettings());
    }
    return RemoteSettings.inst;
  }

  /** A course server is configured (RemoteConfig.BASE_URL non-empty). */
  static serverEnabled(): boolean {
    try {
      return AppContainer.courses().serverEnabled();
    } catch (e) {
      return false;
    }
  }

  setOnlineVoice(on: boolean): void {
    this.onlineStudioVoice = on;
    RemoteSettings.apply();
  }

  /** App start + every toggle: push the setting into RemoteVoice. */
  static apply(): void {
    try {
      // Product decision: the studio voice is always on; the built-in voice is only the offline last resort,
      // so there is no user switch (a value saved by an earlier build is ignored).
      AppContainer.remoteVoice().setOnlineVoice(true);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=RemoteSettings.apply ${Log.errKv(e as Object)}`);
    }
  }
}

export enum RowAction { NONE = 'none', DOWNLOAD = 'download', UPDATE = 'update', DOWNLOADING = 'downloading' }

export class CourseItem {
  id: string = '';
  /** Catalog city id ('' = unknown): Home lists the walks of one city. */
  cityId: string = '';
  title: string = '';
  city: string = '';
  stops: number = 0;
  km: string = '';
  minutes: number = 0;
  langs: string = '';
  size: string = '';
  state: CourseState = CourseState.AVAILABLE;
  active: boolean = false;
  canDelete: boolean = false;
  canSelect: boolean = false;
  downloading: boolean = false;
  pct: number = 0;
  cancelling: boolean = false;
  failed: boolean = false;
  /** Play now (stream) is offered (primary); Download is then the secondary action. */
  playNow: boolean = false;
  /** The streamed copy of this course is on the device ("Streaming"). */
  streaming: boolean = false;
  /** Play now is fetching the course's small files. */
  preparing: boolean = false;
  /** Play now failed (offline, server error): a clear message on the row. */
  playFailed: boolean = false;
  /** A cover banner is expected (the catalog names a cover, or the installed course has one). */
  hasCover: boolean = false;
  /** The cover JPEG ('' = placeholder while it loads, or for good when it cannot be fetched). */
  coverPath: string = '';
  coverBlob: string = '';
}

export enum CatalogNote { NONE = 'none', LOADING = 'loading', DISABLED = 'disabled', OFFLINE_CACHED = 'offlineCached',
  OFFLINE_EMPTY = 'offlineEmpty', UNVERIFIED = 'unverified' }

const CATALOG_TIMEOUT_MS: number = 15000;
const SWITCH_TIMEOUT_MS: number = 15000;
const DOWNLOAD_TIMEOUT_MS: number = 30 * 60000;
const PLAY_TIMEOUT_MS: number = 60000;

function uiLangOf(lang: Lang): string {
  return lang === Lang.PL ? 'pl' : lang === Lang.ZH ? 'zh' : 'en';
}

/** One instance for the app session, so a download keeps its row progress when the page is left and reopened. */
export class CoursesViewModel {
  private static inst: CoursesViewModel | undefined = undefined;

  static get(): CoursesViewModel {
    if (CoursesViewModel.inst === undefined) {
      CoursesViewModel.inst = proxy(new CoursesViewModel());
    }
    return CoursesViewModel.inst;
  }

  items: CourseItem[] = [];
  note: CatalogNote = CatalogNote.NONE;
  enabled: boolean = false;
  switchFailed: boolean = false;
  tourRunning: boolean = false;
  busySwitch: boolean = false;
  private lang: Lang = Lang.EN;
  private progress: Map<string, number> = new Map<string, number>();
  private failed: Set<string> = new Set<string>();
  private preparing: Set<string> = new Set<string>();
  private playFailed: Set<string> = new Set<string>();
  /** The Courses page is showing (Play now goes back to Home only from it). */
  visible: boolean = false;
  private cancels: Map<string, CancelToken> = new Map<string, CancelToken>();
  /** Cover lookups by course id (kept across rebuilds, so a row never loses its photo). */
  private covers: Map<string, CoverChoice> = new Map<string, CoverChoice>();
  private coverBusy: Set<string> = new Set<string>();

  /** Page shown: local rows at once, then the catalog from the server. */
  async open(lang: Lang): Promise<void> {
    this.lang = lang;
    try {
      const repo = AppContainer.courses();
      this.enabled = repo.serverEnabled();
      this.tourRunning = AppContainer.tourController().isRunning();
      await withTimeout(repo.init(), CATALOG_TIMEOUT_MS, undefined, 'courses.init');
      this.rebuild();
      if (!this.enabled) {
        this.note = CatalogNote.DISABLED;
        return;
      }
      this.note = CatalogNote.LOADING;
      const fallback = new CatalogState();
      fallback.error = 'timeout';
      const st = await withTimeout(repo.refreshCatalog(), CATALOG_TIMEOUT_MS, fallback, 'courses.catalog');
      this.note = this.noteFor(st);
      this.rebuild();
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=CoursesViewModel.open ${Log.errKv(e as Object)}`);
      this.note = CatalogNote.OFFLINE_EMPTY;
    }
  }

  retry(): void {
    this.open(this.lang);
  }

  private noteFor(st: CatalogState): CatalogNote {
    if (st.source === CatalogSource.SERVER) {
      return CatalogNote.NONE;
    }
    if (st.error === 'bad_signature' || st.error === 'no_public_key' || st.error.startsWith('envelope_') ||
      st.error.startsWith('catalog_')) {
      return st.source === CatalogSource.CACHE ? CatalogNote.OFFLINE_CACHED : CatalogNote.UNVERIFIED;
    }
    return st.source === CatalogSource.CACHE ? CatalogNote.OFFLINE_CACHED : CatalogNote.OFFLINE_EMPTY;
  }

  private rebuild(): void {
    try {
      const repo = AppContainer.courses();
      const cat = repo.catalog().courses;
      const rows: CourseRow[] = mergeCourses(repo.installed(), cat, repo.activeId());
      const downloadedIds: string[] = repo.installed().map((i: InstalledCourse) => i.id);
      const streamedIds: string[] = repo.streamedIds();
      const activeId = repo.activeId();
      const ui = uiLangOf(this.lang);
      const out: CourseItem[] = [];
      for (const r of rows) {
        const it = new CourseItem();
        it.id = r.summary.id;
        it.title = courseTitle(r.summary, ui);
        it.city = repo.cityLabel(r.summary, ui);
        it.cityId = r.summary.cityId;
        it.stops = r.summary.stops;
        it.km = r.summary.km > 0 ? `${r.summary.km}` : '';
        it.minutes = r.summary.minutes;
        it.langs = r.summary.langs.map((l: string) => l === 'zh' ? '中文' : l.toUpperCase()).join(' · ');
        it.size = sizeLabel(r.state === CourseState.DOWNLOADED ? r.summary.bytes :
          downloadBytes(r.summary.bytes, r.summary.cityId, repo.cityBytes(r.summary.cityId), repo.hasCity(r.summary.cityId)));
        it.state = r.state;
        const src: CourseSource = courseSource(it.id, downloadedIds, streamedIds);
        it.active = src === CourseSource.STREAMED ? activeId === it.id : r.active && activeId === it.id;
        const acts: StreamRowActions = streamRowActions(src, it.active, this.enabled);
        it.playNow = acts.playNow;
        it.streaming = acts.streaming;
        it.preparing = this.preparing.has(it.id);
        it.playFailed = this.playFailed.has(it.id);
        it.canDelete = r.canDelete || acts.streaming;
        it.canSelect = r.canSelect;
        const p = this.progress.get(it.id);
        it.downloading = p !== undefined;
        const c = this.cancels.get(it.id);
        it.cancelling = c !== undefined && c.cancelled;
        it.pct = p !== undefined ? p : 0;
        it.failed = this.failed.has(it.id);
        const cover = this.covers.get(it.id);
        it.coverPath = cover !== undefined ? cover.path : '';
        it.coverBlob = r.summary.coverBlob;
        // An installed course may carry its cover in its pack: look before deciding there is no banner.
        it.hasCover = rowHasCover(it.coverBlob, it.coverPath) || (r.canSelect && cover === undefined);
        out.push(it);
      }
      this.items = out;
      this.loadCovers();
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=CoursesViewModel.rebuild ${Log.errKv(e as Object)}`);
    }
  }

  /**
   * Looks up the cover of every row that has none yet (installed pack cover, or the catalog cover fetched from
   * /v1/blobs and verified, CourseRepository.coverFor). Runs in the background; a row without any cover drops its
   * banner, a row whose download failed keeps the placeholder and is tried again on the next open.
   */
  private loadCovers(): void {
    for (const it of this.items) {
      const known = this.covers.get(it.id);
      if (!it.hasCover || (known !== undefined && known.path !== '') || this.coverBusy.has(it.id)) {
        continue;
      }
      const id = it.id;
      this.coverBusy.add(id);
      AppContainer.courses().coverFor(id, this.enabled).then((c: CoverChoice) => {
        this.covers.set(id, c);
        const row = this.item(id);
        if (row !== undefined) {
          row.coverPath = c.path;
          // No photo: keep the placeholder only while the catalog names a cover (it may download next time).
          row.hasCover = rowHasCover(row.coverBlob, c.path);
        }
      }).catch((e: Object) => {
        Log.e(LogEvents.UNCAUGHT, `where=CoursesViewModel.loadCovers ${Log.errKv(e)}`);
      }).finally(() => {
        this.coverBusy.delete(id);
      });
    }
  }

  private item(id: string): CourseItem | undefined {
    return this.items.find((i: CourseItem) => i.id === id);
  }

  /**
   * Play now: stream the course (small files only, clips on demand), make it the active course, then back to Home.
   * A streamed copy that is current (or the server is unreachable) is just made active.
   */
  async play(id: string): Promise<void> {
    this.tourRunning = AppContainer.tourController().isRunning();
    if (this.preparing.has(id) || this.progress.has(id) || this.tourRunning) {
      return;
    }
    this.playFailed.delete(id);
    this.preparing.add(id);
    this.rebuild();
    const cancel = new CancelToken();
    const timedOut = new OpResult();
    timedOut.error = 'timeout';
    let r: OpResult;
    try {
      r = await withTimeout(AppContainer.courses().stream(id, cancel, (p: InstallProgress) => {}), PLAY_TIMEOUT_MS,
        timedOut, 'courses.stream');
    } catch (e) {
      r = new OpResult();
      r.error = 'exception';
    }
    if (r.error === 'timeout') {
      cancel.cancelled = true;
    }
    this.preparing.delete(id);
    if (!r.ok) {
      this.playFailed.add(id);
      Log.w(LogEvents.COURSE, `event=ui_stream_fail id=${id} reason=${r.error}`);
      this.rebuild();
      return;
    }
    Log.i(LogEvents.COURSE, `event=ui_stream_ok id=${id}`);
    this.rebuild();
    notifyCourseChanged();
    if (this.visible) {
      AppViewModel.get().back();   // Home shows the walk, ready to start
    }
  }

  /**
   * Home's one-tap Start: make course `id` the active course (already active and loaded: nothing to do; downloaded:
   * activate; else stream it, "Preparing…" on its card) and wait until its pack is loaded. Resolves true when the
   * walk can be planned. Never rejects; a failure marks the card (playFailed).
   */
  async ensureActive(id: string): Promise<boolean> {
    const app = AppViewModel.get();
    const repo = AppContainer.courses();
    if (repo.activeId() === id && app.packState === PackState.READY) {
      return true;
    }
    if (this.preparing.has(id) || this.progress.has(id) || AppContainer.tourController().isRunning()) {
      return false;
    }
    this.playFailed.delete(id);
    this.failed.delete(id);
    this.preparing.add(id);
    this.rebuild();
    const cancel = new CancelToken();
    const timedOut = new OpResult();
    timedOut.error = 'timeout';
    let r: OpResult;
    try {
      const downloaded = repo.installed().some((i: InstalledCourse) => i.id === id);
      r = downloaded ?
        await withTimeout(repo.activate(id), SWITCH_TIMEOUT_MS, timedOut, 'courses.activate') :
        await withTimeout(repo.stream(id, cancel, (p: InstallProgress) => {}), PLAY_TIMEOUT_MS, timedOut,
          'courses.stream');
    } catch (e) {
      r = new OpResult();
      r.error = 'exception';
    }
    if (r.error === 'timeout') {
      cancel.cancelled = true;
    }
    let ok = r.ok;
    if (ok) {
      MapCache.reset();
      ok = await app.reloadPack();
    }
    this.preparing.delete(id);
    if (!ok) {
      this.playFailed.add(id);
      Log.w(LogEvents.COURSE, `event=ui_start_prepare_fail id=${id} reason=${r.error}`);
    } else {
      Log.i(LogEvents.COURSE, `event=ui_start_prepare_ok id=${id}`);
    }
    this.rebuild();
    return ok;
  }

  /** Home: a Start / Demo walk of `id` failed after the walk was ready (plan / start): mark its card. */
  markFailed(id: string, failed: boolean): void {
    if (failed) {
      this.playFailed.add(id);
    } else {
      this.playFailed.delete(id);
    }
    this.rebuild();
  }

  /** Download or update; progress shows on the row. */
  async download(id: string): Promise<void> {
    if (this.progress.has(id)) {
      return;
    }
    this.failed.delete(id);
    this.playFailed.delete(id);
    this.progress.set(id, 0);
    const cancel = new CancelToken();
    this.cancels.set(id, cancel);
    this.rebuild();
    const onProgress = (p: InstallProgress): void => {
      const pct = progressPct(p.doneBytes, p.totalBytes, p.doneFiles, p.totalFiles);
      this.progress.set(id, pct);
      const it = this.item(id);
      if (it !== undefined) {
        it.pct = pct;
      }
    };
    const timedOut = new OpResult();
    timedOut.error = 'timeout';
    const activeBefore = AppContainer.courses().activeId();
    let r: OpResult;
    try {
      r = await withTimeout(AppContainer.courses().download(id, cancel, onProgress), DOWNLOAD_TIMEOUT_MS, timedOut,
        'courses.download');
    } catch (e) {
      r = new OpResult();
      r.error = 'exception';
    }
    if (r.error === 'timeout') {
      cancel.cancelled = true;
    }
    this.progress.delete(id);
    this.cancels.delete(id);
    if (!r.ok && r.error !== 'cancelled') {
      this.failed.add(id);
      Log.w(LogEvents.COURSE, `event=ui_download_fail id=${id} reason=${r.error}`);
    } else if (!r.ok) {
      Log.i(LogEvents.COURSE, `event=ui_download_cancelled id=${id}`);
    }
    this.rebuild();
    const activeNow = AppContainer.courses().activeId();
    if (r.ok && (activeNow === id || activeNow !== activeBefore)) {
      notifyCourseChanged();   // the first download (now active) or an update of the active course: Home re-reads it
    }
  }

  /** Stops a running download; the partial files are discarded and nothing installed changes. */
  cancel(id: string): void {
    const c = this.cancels.get(id);
    if (c !== undefined) {
      c.cancelled = true;
      const it = this.item(id);
      if (it !== undefined) {
        it.cancelling = true;
      }
      Log.i(LogEvents.COURSE, `event=ui_download_cancel id=${id}`);
    }
  }



  async remove(id: string): Promise<void> {
    if (this.tourRunning && AppContainer.courses().activeId() === id) {
      return;
    }
    const wasActive = AppContainer.courses().activeId() === id;
    const r = await withTimeout(AppContainer.courses().remove(id), SWITCH_TIMEOUT_MS, new OpResult(), 'courses.remove');
    if (!r.ok) {
      Log.w(LogEvents.COURSE, `event=ui_delete_fail id=${id} reason=${r.error}`);
    }
    this.rebuild();
    if (wasActive) {
      notifyCourseChanged();
    }
  }

  /** Make a downloaded course the active one (not during a tour). */
  async select(id: string): Promise<void> {
    this.switchFailed = false;
    this.tourRunning = AppContainer.tourController().isRunning();
    if (this.tourRunning || this.busySwitch || AppContainer.courses().activeId() === id) {
      return;
    }
    this.busySwitch = true;
    try {
      const r = await withTimeout(AppContainer.courses().activate(id), SWITCH_TIMEOUT_MS, new OpResult(),
        'courses.activate');
      this.switchFailed = !r.ok;
      if (r.ok) {
        notifyCourseChanged();
      }
    } finally {
      this.busySwitch = false;
      this.rebuild();
    }
  }
}
