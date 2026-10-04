/*
 * "No course installed" (the app ships no built-in course; docs/SERVER.md §6). ActivePackRepository forwards to this
 * until the first course is downloaded, and again after the last one is deleted. Every query answers empty, so a
 * screen that reads the pack shows less instead of throwing; load() fails with the NO_COURSE_DETAIL issue, and the
 * UI shows the "Download your first walk" empty state (AppViewModel PackState.NO_COURSE).
 */
import { IssueCode, IssueSeverity } from '@citytour/core';
import { Lang, MapData, Narration, NarrationLength, Persona, Poi, RouteData, SourceRef, Tour } from '@citytour/core';
import { PackLoadResult, PackRepository } from '@citytour/core';
import { emptyRoutes } from '@citytour/core';

/** PackLoadResult issue detail when no course is installed. */
export const NO_COURSE_DETAIL: string = 'no_course';

export class EmptyPackRepository implements PackRepository {
  load(): Promise<PackLoadResult> {
    const r: PackLoadResult = {
      ok: false,
      issues: [{ code: IssueCode.PACK_ERR, severity: IssueSeverity.INFO, detail: NO_COURSE_DETAIL }]
    };
    return Promise.resolve(r);
  }

  pois(): Poi[] {
    return [];
  }

  poi(id: string): Poi | undefined {
    return undefined;
  }

  tours(): Tour[] {
    return [];
  }

  personas(): Persona[] {
    return [];
  }

  routes(): RouteData {
    return emptyRoutes();
  }

  map(level: string): MapData {
    const m: MapData = { level: level, origin: { lat: 50.06143, lng: 19.93658 }, bounds: [0, 0, 0, 0], layers: [] };
    return m;
  }

  narration(poiId: string, personaId: string, lang: Lang, len: NarrationLength): Narration | undefined {
    return undefined;
  }

  source(id: string): SourceRef | undefined {
    return undefined;
  }
}
