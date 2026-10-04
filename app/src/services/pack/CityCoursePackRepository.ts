/*
 * A course of a city (docs/SERVER.md §3, ServerApi R7, core/content/CityPack): the course's own pack
 * (filesDir/courses/<id>/<version>/tour/: tours, routes, personas, its stops' records and stories, maybe its own map
 * and a Demo walk track) layered over the city's places pack (filesDir/cities/<cityId>/<version>/: every place, its
 * stories, sources, the city map, city.json). A record of the course wins over the city record with the same id, so
 * the tour keeps its curated stops while "All places" and the place cards read the whole city. Both packs are
 * verified file by file against their own manifests (SourcePackRepository) after the signed download (CourseStore).
 */
import { Lang, MapData, Narration, NarrationLength, Persona, Poi, RouteData, SourceRef, Tour } from '@citytour/core';
import { PackLoadResult, PackRepository } from '@citytour/core';
import { AppIssue, IssueCode, IssueSeverity } from '@citytour/core';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';
import { CityInfo, layerManifests, layerPois, parseCityJson } from '@citytour/core';
import { FilePackSource } from './FilePackRepository';
import { SourcePackRepository } from './SourcePackRepository';

export const CITY_JSON: string = 'city.json';

export class CityCoursePackRepository implements PackRepository {
  private readonly city: SourcePackRepository;
  private readonly course: SourcePackRepository;
  private loading: Promise<PackLoadResult> | undefined = undefined;
  private poiList: Poi[] = [];
  private info: CityInfo | undefined = undefined;

  /**
   * cityDir / courseDir: absolute pack folders (no trailing '/'). `streamedCity`: the city folder holds only what a
   * streamed course needs (StreamRules: manifest, city.json, map), not its places.
   */
  constructor(cityDir: string, courseDir: string, streamedCity: boolean = false) {
    this.city = new SourcePackRepository(new FilePackSource(cityDir), true, streamedCity);
    this.course = new SourcePackRepository(new FilePackSource(courseDir));
  }

  /** city.json of the city pack (undefined before load or when it is missing/invalid). */
  cityInfo(): CityInfo | undefined {
    return this.info;
  }

  /** The course pack (Demo walk track, file checks). */
  coursePack(): SourcePackRepository {
    return this.course;
  }

  load(): Promise<PackLoadResult> {
    if (this.loading === undefined) {
      this.loading = this.doLoad();
    }
    return this.loading;
  }

  private async doLoad(): Promise<PackLoadResult> {
    const t0 = Date.now();
    const both: PackLoadResult[] = await Promise.all([this.city.load(), this.course.load()]);
    const c: PackLoadResult = both[0];
    const k: PackLoadResult = both[1];
    const issues: AppIssue[] = c.issues.concat(k.issues);
    const cm = this.city.manifest();
    const km = this.course.manifest();
    if (!c.ok || !k.ok || cm === undefined || km === undefined) {
      Log.e(LogEvents.PACK_ERR, `file=layered reason=${!c.ok ? 'city' : 'course'}_load blocking=true`);
      const bad: PackLoadResult = { ok: false, issues: issues };
      return bad;
    }
    const cityText = await this.city.readVerifiedText(CITY_JSON);
    this.info = cityText === undefined ? undefined : parseCityJson(cityText);
    if (this.info === undefined) {
      Log.w(LogEvents.PACK_ERR, `file=${CITY_JSON} reason=missing_or_invalid blocking=false`);
    }
    this.city.usePersonas(this.course.personas());   // a city pack has no personas of its own
    const nouns: string[] = this.info !== undefined ? this.info.properNouns : [];
    this.city.useCityNouns(nouns);
    this.course.useCityNouns(nouns);
    this.poiList = layerPois(this.city.pois(), this.course.pois());
    const lm = layerManifests(cm, km, this.poiList.length);
    if (lm.manifest === undefined) {
      Log.e(LogEvents.PACK_ERR, `file=manifest.json reason=${lm.error} blocking=true`);
      issues.push({ code: IssueCode.PACK_ERR, severity: IssueSeverity.BLOCKING, detail: `layered: ${lm.error}` });
      const bad: PackLoadResult = { ok: false, issues: issues };
      return bad;
    }
    Log.i(LogEvents.PACK_LOAD, `where=layered city=${cm.packId}@${cm.version} course=${km.packId}@${km.version}` +
      ` pois=${this.poiList.length} cityPois=${this.city.pois().length} coursePois=${this.course.pois().length}` +
      ` ms=${Date.now() - t0}`);
    const ok: PackLoadResult = { ok: true, manifest: lm.manifest, issues: issues };
    return ok;
  }

  pois(): Poi[] {
    return this.poiList;
  }

  poi(id: string): Poi | undefined {
    const p = this.course.poi(id);
    return p !== undefined ? p : this.city.poi(id);
  }

  tours(): Tour[] {
    return this.course.tours();
  }

  personas(): Persona[] {
    return this.course.personas();
  }

  routes(): RouteData {
    return this.course.routes();
  }

  /** The course's own map when it ships one (a tour outside the city map), else the city map. */
  map(level: string): MapData {
    return this.course.hasFile(`map-${level}.json`) ? this.course.map(level) : this.city.map(level);
  }

  narration(poiId: string, personaId: string, lang: Lang, len: NarrationLength): Narration | undefined {
    if (this.course.poi(poiId) !== undefined) {
      const n = this.course.narration(poiId, personaId, lang, len);
      if (n !== undefined) {
        return n;
      }
    }
    return this.city.narration(poiId, personaId, lang, len);
  }

  source(id: string): SourceRef | undefined {
    const s = this.course.source(id);
    return s !== undefined ? s : this.city.source(id);
  }
}
