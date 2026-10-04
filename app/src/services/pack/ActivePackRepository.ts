/*
 * The PackRepository the whole app holds (AppContainer.packRepository()): it forwards to the ACTIVE course's pack, a
 * downloaded course (FilePackRepository) chosen on the Courses screen (docs/SERVER.md §6), or to EmptyPackRepository
 * when no course is installed (the app ships no built-in course). Nothing else in the app needs to know which one.
 *
 * - load(): waits (bounded) for the start-up choice of the active course, then loads it. A downloaded course that
 *   fails to load stays active and reports the failure (Home shows the error state; the Courses screen can delete or
 *   re-download it).
 * - switchTo(): loads the new pack first and swaps only when it loaded; the old pack stays active otherwise.
 * - switchToNone(): back to "no course" (the last course was deleted).
 */
import { Lang, MapData, Narration, NarrationLength, Persona, Poi, RouteData, SourceRef, Tour } from '@citytour/core';
import { PackLoadResult, PackRepository } from '@citytour/core';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';
import { CityInfo, DEMO_WALK_FILE } from '@citytour/core';
import { CityCoursePackRepository } from './CityCoursePackRepository';
import { EmptyPackRepository } from './EmptyPackRepository';
import { SourcePackRepository } from './SourcePackRepository';

const STARTUP_CHOICE_TIMEOUT_MS: number = 3000;

/** The start-up choice: a course's pack and its id. */
export class PackChoice {
  repo: PackRepository;
  id: string;

  constructor(repo: PackRepository, id: string) {
    this.repo = repo;
    this.id = id;
  }
}

export class ActivePackRepository implements PackRepository {
  private readonly none: PackRepository = new EmptyPackRepository();
  private current: PackRepository = this.none;
  private currentId: string = '';
  private startup: Promise<void> = Promise.resolve();
  private loading: Promise<PackLoadResult> | undefined = undefined;
  private chosen: boolean = false;   // the start-up choice was applied (or timed out); later choices are ignored

  /** The active course id, '' when no course is installed. */
  activeId(): string {
    return this.currentId;
  }

  hasCourse(): boolean {
    return this.currentId !== '';
  }

  /** city.json of the active course's city (undefined: no course, an older self-contained pack, or not loaded). */
  cityInfo(): CityInfo | undefined {
    return this.current instanceof CityCoursePackRepository ? (this.current as CityCoursePackRepository).cityInfo() :
      undefined;
  }

  /** The active course's own pack (where its Demo walk track lives). */
  private ownPack(): SourcePackRepository | undefined {
    if (this.current instanceof CityCoursePackRepository) {
      return (this.current as CityCoursePackRepository).coursePack();
    }
    return this.current instanceof SourcePackRepository ? this.current as SourcePackRepository : undefined;
  }

  /** The active course ships a SIMULATED Demo walk track (demo-walk.json listed in its pack manifest). */
  hasDemoTrack(): boolean {
    const p = this.ownPack();
    return p !== undefined && p.hasFile(DEMO_WALK_FILE);
  }

  /** The active course's demo-walk.json, verified against its pack manifest; undefined when it has none. */
  async demoTrack(): Promise<string | undefined> {
    const p = this.ownPack();
    return p === undefined ? undefined : p.readVerifiedText(DEMO_WALK_FILE);
  }

  /**
   * Start-up: `choose` resolves the installed course to use (undefined = none) before the first load(). Called once
   * by CourseRepository.start().
   */
  setStartupChoice(choose: Promise<PackChoice | undefined>): void {
    this.startup = choose.then((c: PackChoice | undefined) => {
      if (c !== undefined && !this.chosen) {
        this.current = c.repo;
        this.currentId = c.id;
        Log.i(LogEvents.COURSE, `event=active_restore id=${c.id}`);
      }
    }).catch((e: Object) => {
      Log.e(LogEvents.COURSE, `event=active_restore_fail ${Log.errKv(e)}`);
    });
  }

  load(): Promise<PackLoadResult> {
    if (this.loading === undefined) {
      this.loading = this.doLoad();
    }
    return this.loading;
  }

  /** Loads `repo`, then makes it active. Resolves the load result; on failure the previous pack stays active. */
  async switchTo(repo: PackRepository, id: string): Promise<PackLoadResult> {
    let r: PackLoadResult;
    try {
      r = await repo.load();
    } catch (e) {
      Log.e(LogEvents.COURSE, `event=switch_fail id=${id} ${Log.errKv(e as Object)}`);
      const bad: PackLoadResult = { ok: false, issues: [] };
      return bad;
    }
    if (!r.ok) {
      Log.e(LogEvents.COURSE, `event=switch_fail id=${id} issues=${r.issues.length} keep=${this.currentId || 'none'}`);
      return r;
    }
    this.chosen = true;
    this.current = repo;
    this.currentId = id;
    this.loading = Promise.resolve(r);
    Log.i(LogEvents.COURSE, `event=active id=${id} pack=${r.manifest !== undefined ? r.manifest.packId : ''}` +
      ` version=${r.manifest !== undefined ? r.manifest.version : ''}`);
    return r;
  }

  /** No course any more (the active one was deleted and no other is installed). */
  switchToNone(): Promise<PackLoadResult> {
    this.chosen = true;
    this.current = this.none;
    this.currentId = '';
    this.loading = this.none.load();
    Log.i(LogEvents.COURSE, 'event=active id=none');
    return this.loading;
  }

  private async doLoad(): Promise<PackLoadResult> {
    await Promise.race([this.startup, new Promise<void>((resolve) => setTimeout(resolve, STARTUP_CHOICE_TIMEOUT_MS))]);
    this.chosen = true;
    const repo = this.current;
    try {
      return await repo.load();
    } catch (e) {
      Log.e(LogEvents.COURSE, `event=load_fail id=${this.currentId || 'none'} ${Log.errKv(e as Object)}`);
      const bad: PackLoadResult = { ok: false, issues: [] };
      return bad;
    }
  }

  pois(): Poi[] {
    return this.current.pois();
  }

  poi(id: string): Poi | undefined {
    return this.current.poi(id);
  }

  tours(): Tour[] {
    return this.current.tours();
  }

  personas(): Persona[] {
    return this.current.personas();
  }

  routes(): RouteData {
    return this.current.routes();
  }

  map(level: string): MapData {
    return this.current.map(level);
  }

  narration(poiId: string, personaId: string, lang: Lang, len: NarrationLength): Narration | undefined {
    return this.current.narration(poiId, personaId, lang, len);
  }

  source(id: string): SourceRef | undefined {
    return this.current.source(id);
  }
}
