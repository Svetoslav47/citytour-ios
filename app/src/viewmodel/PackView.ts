/*
 * Read-only helpers that turn PackRepository data into what the tour screens show. Every pack access is guarded:
 * a missing or broken record shows less, it never throws into a build().
 */
import { ContentTier, Lang, NarrationLength, Poi, RouteData, Tour } from '@citytour/core';
import { PackRepository } from '@citytour/core';
import { Log } from '../app/Log';
import { LogEvents } from '@citytour/core';
import { PlaqueState } from '../views/common/Plaque';
import { PreviewPoint } from '../views/common/RoutePreview';
import { StopRow } from '../views/common/StopList';
import { localName, storyMinutes } from './Format';

export function findTour(pack: PackRepository, tourId: string): Tour | undefined {
  try {
    const tours = pack.tours();
    if (tourId === '') {
      return tours.length > 0 ? tours[0] : undefined;
    }
    return tours.find((t: Tour) => t.id === tourId);
  } catch (e) {
    Log.e(LogEvents.UNCAUGHT, `where=PackView.findTour ${Log.errKv(e as Object)}`);
    return undefined;
  }
}

export function safePoi(pack: PackRepository, poiId: string): Poi | undefined {
  try {
    return pack.poi(poiId);
  } catch (e) {
    return undefined;
  }
}

export function poiName(pack: PackRepository, poiId: string, lang: Lang): string {
  const p = safePoi(pack, poiId);
  return p === undefined ? '' : localName(p.names, lang);
}

export function personaName(pack: PackRepository, personaId: string, lang: Lang): string {
  try {
    const p = pack.personas().find((x) => x.id === personaId);
    return p === undefined ? '' : localName(p.names, lang);
  } catch (e) {
    return '';
  }
}

/** Rows in the given order; story length comes from the FULL narration when one exists. */
export function stopRows(pack: PackRepository, poiIds: string[], personaId: string, lang: Lang): StopRow[] {
  return poiIds.map((id: string, i: number) => {
    let minutes = 0;
    try {
      const n = pack.narration(id, personaId, lang, NarrationLength.FULL);
      if (n !== undefined && n.tier !== ContentTier.NAME_ONLY) {
        minutes = storyMinutes(n.sentences, n.lang);
      }
    } catch (e) {
      minutes = 0;
    }
    return new StopRow(i + 1, id, poiName(pack, id, lang), minutes, PlaqueState.UPCOMING);
  });
}

export function previewPoints(pack: PackRepository, poiIds: string[]): PreviewPoint[] {
  const out: PreviewPoint[] = [];
  poiIds.forEach((id: string, i: number) => {
    const p = safePoi(pack, id);
    if (p !== undefined && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      out.push(new PreviewPoint(p.x, p.y, i + 1));
    }
  });
  return out;
}

/** Walking metres between two stops from the pack matrix; 0 when unknown. */
export function legMetres(routes: RouteData | undefined, fromId: string, toId: string): number {
  if (routes === undefined) {
    return 0;
  }
  const a = routes.nodeIds.indexOf(fromId);
  const b = routes.nodeIds.indexOf(toId);
  if (a < 0 || b < 0 || a >= routes.distancesM.length || b >= routes.distancesM[a].length) {
    return 0;
  }
  const d = routes.distancesM[a][b];
  return Number.isFinite(d) && d > 0 ? d : 0;
}

export function safeRoutes(pack: PackRepository): RouteData | undefined {
  try {
    return pack.routes();
  } catch (e) {
    return undefined;
  }
}

/** Walking distance of the listed order; 0 if any leg is unknown (then nothing is claimed). */
export function listedMetres(pack: PackRepository, poiIds: string[]): number {
  const routes = safeRoutes(pack);
  let sum = 0;
  for (let i = 1; i < poiIds.length; i++) {
    const d = legMetres(routes, poiIds[i - 1], poiIds[i]);
    if (d <= 0) {
      return 0;
    }
    sum += d;
  }
  return sum;
}

