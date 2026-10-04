// Stage 4: merged POIs for all of Kraków (Node 22+ ESM, stdlib only, no network).
//
// Input (committed snapshots, see data/raw/SOURCES.md):
//   data/raw/wikidata/krakow-items.json(.gz)               4,365 items located in Kraków (the POI set)
//   data/tours/royal-route.json                             curated tour stops: kind, names, lat/lng, radius, view
//   data/raw/arcgis/unesco.geojson                          UNESCO core zone polygon ("Granice obszaru UNESCO")
//   data/raw/arcgis/eoz-zabytki-zbiorcza-polygon.geojson.gz municipal heritage register polygons (NUMER_REJ_)
//   data/raw/wiki/summaries-{en,pl,zh}.json                 which POIs have a Wikipedia article (sourceIds)
//
// Rules:
//   - ids "poi_wd_<QID>"; one POI per QID; the city item Q31487, items outside the city box, items without
//     any label and items that are only tram/bus stops are left out (EXCLUDED_P31).
//   - dedupe: same normalised primary (pl) name within 30 m -> one POI (tour stop first, then more sitelinks,
//     then the lower QID wins). ArcGIS adds no POIs: `Pomnik` has no names, `Zabytkowe_tablice_SIM` are street
//     signs and the register's NAZWA is a fragment ("- budynek mieszkalny"), not a name (B1 findings).
//   - kind: the first PoiKind in KIND_PRECEDENCE that one of the item's P31 classes maps to (KIND_BY_P31).
//   - names: pl always present (pl label, else en, else zh); tour stops use the curated names of the tour.
//   - heritage { registerNo?, unesco }: unesco = inside the UNESCO core zone or P1435 = Q9259; registerNo = the
//     NUMER_REJ_ of the smallest register polygon that contains the POI (spatial join, ArcGIS).
//   - importance = round3(0.6 * min(1, ln(1 + sitelinks) / ln(51)) + 0.25 * heritage + 0.15 * unesco), where
//     heritage = 1 if P1435 is set or a register number was joined, unesco = 1 as above.
//   - tour stops: lat/lng, kind, names, triggerRadiusM and view {look, feature} from royal-route.json
//     (review-only keys dropped); everyone else triggerRadiusM 30 and no view.
//   - tier is filled in by 90-emit.mjs after narration selection (best tier among the POI's narrations).

import { PoiKind } from './schema.mjs';
import { haversineM, pointInPolygon, project, ringArea, round1, round3 } from './projection.mjs';

export const CITY_QID = 'Q31487';
/** Same generous city box as 30-fetch-wiki.mjs. */
export const CITY_BOX = Object.freeze({ minLat: 49.97, maxLat: 50.13, minLng: 19.79, maxLng: 20.22 });
export const DEFAULT_TRIGGER_RADIUS_M = 30;
export const DEDUPE_RADIUS_M = 30;
/** Items whose P31 classes are all in this set are not places to visit. */
export const EXCLUDED_P31 = Object.freeze(new Set(['Q2175765' /* tram stop */, 'Q953806' /* bus stop */]));
export const UNESCO_CORE_NAME = 'Granice obszaru UNESCO';
export const WORLD_HERITAGE_QID = 'Q9259';

/** Highest priority first: an item that is a church and a museum is a church. */
export const KIND_PRECEDENCE = Object.freeze([
  'synagogue', 'church', 'castle', 'gate', 'museum', 'monument', 'plaque', 'square', 'viewpoint', 'building', 'other',
]);

/** Wikidata P31 class -> PoiKind (classes not listed map to nothing; an item with no mapped class is 'other'). */
export const KIND_BY_P31 = Object.freeze({
  // Every QID below was checked against the snapshot's own valueLabels (en | pl) on 2026-10-03.
  // synagogue
  Q34627: 'synagogue', // synagogue | synagoga
  // church: church buildings, chapels, monasteries, shrines, crypts (parishes are organisations: 'other')
  Q16970: 'church', Q317557: 'church', Q108325: 'church', Q120560: 'church', Q744296: 'church', Q56395672: 'church',
  Q2977: 'church', Q1088552: 'church', Q44613: 'church', Q14552192: 'church', Q200334: 'church', Q2031836: 'church',
  Q192619: 'church',
  // castle: castles and fortifications (forts, towers of the walls, bastions, batteries, moats, caponiers)
  Q23413: 'castle', Q57821: 'castle', Q1785071: 'castle', Q81917: 'castle', Q81851: 'castle', Q91203: 'castle',
  Q56344492: 'castle', Q88480: 'castle', Q9334489: 'castle', Q131263: 'castle', Q91122: 'castle', Q89441: 'castle',
  // gate (incl. tollhouses, "rogatka")
  Q53060: 'gate', Q82117: 'gate', Q7814332: 'gate',
  // museum (incl. galleries)
  Q33506: 'museum', Q207694: 'museum', Q2772772: 'museum', Q10624527: 'museum', Q3329412: 'museum', Q17431399: 'museum',
  Q24699794: 'museum', Q1007870: 'museum', Q1595639: 'museum', Q756102: 'museum', Q26958726: 'museum',
  // monument (incl. sculptures, statues, memorials, graves, mounds, tombstones)
  Q4989906: 'monument', Q860861: 'monument', Q179700: 'monument', Q5003624: 'monument', Q173387: 'monument',
  Q1584134: 'monument', Q34023: 'monument', Q203443: 'monument',
  // plaque
  Q721747: 'plaque',
  // square (incl. market squares and garden squares, "skwer")
  Q174782: 'square', Q13033698: 'square', Q2026833: 'square',
  // viewpoint: no class in the snapshot maps here (hills and mounds are not all viewpoints)
  // building
  Q1723032: 'building', Q3947: 'building', Q41176: 'building', Q3950: 'building', Q16560: 'building', Q488654: 'building',
  Q11755880: 'building', Q1497364: 'building', Q2282602: 'building', Q27686: 'building', Q1497375: 'building',
  Q16974307: 'building', Q1244442: 'building', Q28843623: 'building', Q39364723: 'building', Q183061: 'building',
  Q24354: 'building', Q12518: 'building', Q114768: 'building', Q294422: 'building', Q811979: 'building',
  Q19844914: 'building', Q63099748: 'building', Q1662011: 'building', Q19691007: 'building', Q2519340: 'building',
  Q214252: 'building', Q879050: 'building', Q961082: 'building', Q1021645: 'building', Q623525: 'building',
  Q543654: 'building', Q4156067: 'building', Q19860854: 'building', Q811165: 'building', Q41253: 'building',
  Q55488: 'building', Q16917: 'building', Q7075: 'building', Q170477: 'building', Q1254933: 'building',
});

export function wdSourceId(qid) {
  return `wd_${qid}`;
}

export function wpSourceId(lang, qid) {
  return `wp_${lang}_${qid}`;
}

export const SOURCE_ID_UNESCO = 'krk_unesco';
export const SOURCE_ID_REGISTER = 'krk_eoz';

const qnum = (q) => Number(String(q).slice(1));

export function kindFor(p31s) {
  let best = KIND_PRECEDENCE.length - 1;
  for (const q of p31s ?? []) {
    const k = KIND_BY_P31[q];
    if (k) best = Math.min(best, KIND_PRECEDENCE.indexOf(k));
  }
  return KIND_PRECEDENCE[best];
}

/** Lowercase, no diacritics (ł -> l), punctuation and whitespace runs collapsed to one space. */
export function normaliseName(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function importanceOf(sitelinks, heritage, unesco) {
  const s = Math.min(1, Math.log(1 + Math.max(0, sitelinks)) / Math.log(51));
  return round3(0.6 * s + 0.25 * (heritage ? 1 : 0) + 0.15 * (unesco ? 1 : 0));
}

export function inCityBox(lat, lng, box = CITY_BOX) {
  return lat >= box.minLat && lat <= box.maxLat && lng >= box.minLng && lng <= box.maxLng;
}

/** GeoJSON Polygon/MultiPolygon -> list of polygons, each a list of projected flat rings. */
export function projectedPolygons(geometry) {
  if (!geometry) return [];
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polys.map((rings) =>
    rings.map((ring) => {
      const flat = [];
      for (const [lng, lat] of ring) {
        const p = project(lat, lng);
        flat.push(p.x, p.y);
      }
      return flat;
    }),
  );
}

/** The UNESCO core-zone polygons (projected) from the ArcGIS UNESCO layer. */
export function unescoCore(unescoGeojson) {
  const f = (unescoGeojson?.features ?? []).filter((x) => x.properties?.UNESCO === UNESCO_CORE_NAME);
  return f.flatMap((x) => projectedPolygons(x.geometry));
}

/**
 * State register numbers from the free-text NUMER_REJ_ field ("A-3 /25.03.1931/  18.03.1973, A-178/M",
 * "A - 468, 23.04.1968", "A--1260/M (13.06.2011 r.)", "A1304/M"): every "<A|B|C>-<n>[/M]", normalised and
 * deduplicated in order, joined with ", " ("A-3, A-178/M"). '' when none is found (the polygon still counts
 * as a heritage register entry).
 */
export function registerNumbers(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(/\b([ABC])\s*-*\s*(\d+)(\s*\/\s*M\b)?/g)) {
    const no = `${m[1]}-${m[2]}${m[3] ? '/M' : ''}`;
    if (!out.includes(no)) out.push(no);
  }
  return out.join(', ');
}

/**
 * Register polygons with a state register number, indexed on a 100 m grid of their bboxes.
 * lookup(x, y) -> NUMER_REJ_ of the smallest-area polygon containing the point, or null.
 */
export function registerIndex(registerGeojson, cell = 100) {
  const items = [];
  for (const f of registerGeojson?.features ?? []) {
    if (!String(f.properties?.NUMER_REJ_ ?? '').trim()) continue;
    const no = registerNumbers(f.properties.NUMER_REJ_);
    for (const rings of projectedPolygons(f.geometry)) {
      if (!rings.length || rings[0].length < 6) continue;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let k = 0; k < rings[0].length; k += 2) {
        minX = Math.min(minX, rings[0][k]); maxX = Math.max(maxX, rings[0][k]);
        minY = Math.min(minY, rings[0][k + 1]); maxY = Math.max(maxY, rings[0][k + 1]);
      }
      items.push({ no, rings, area: Math.abs(ringArea(rings[0])), bb: [minX, minY, maxX, maxY], fid: f.properties?.FID ?? 0 });
    }
  }
  const grid = new Map();
  items.forEach((it, i) => {
    for (let gx = Math.floor(it.bb[0] / cell); gx <= Math.floor(it.bb[2] / cell); gx++)
      for (let gy = Math.floor(it.bb[1] / cell); gy <= Math.floor(it.bb[3] / cell); gy++) {
        const key = `${gx},${gy}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(i);
      }
  });
  return {
    size: items.length,
    lookup(x, y) {
      let best = null;
      for (const i of grid.get(`${Math.floor(x / cell)},${Math.floor(y / cell)}`) ?? []) {
        const it = items[i];
        if (x < it.bb[0] || x > it.bb[2] || y < it.bb[1] || y > it.bb[3]) continue;
        if (!pointInPolygon(x, y, it.rings)) continue;
        if (!best || it.area < best.area || (it.area === best.area && it.fid < best.fid)) best = it;
      }
      return best ? best.no : null; // '' = in the register, number not parseable
    },
  };
}

function labelNames(labels) {
  const names = {};
  if (labels.en) names.en = labels.en;
  const pl = labels.pl ?? labels.en ?? labels.zh;
  if (pl) names.pl = pl;
  if (labels.zh) names.zh = labels.zh;
  return names;
}

/** LocalizedText in the contract's key order (en, pl, zh). */
export function orderedText(t) {
  const out = {};
  for (const k of ['en', 'pl', 'zh']) if (typeof t?.[k] === 'string' && t[k].length) out[k] = t[k];
  return out;
}

/**
 * Builds the POI list. `wikiPages` = { en: {QID: page}, pl: {...}, zh: {...} } (summaries) for sourceIds.
 * Returns { pois (sorted by id), stopIds, merged: [{ kept, dropped, name, distM }], excluded: {reason: n} }.
 */
export function mergePois({ items, tour, unesco = [], register = null, wikiPages = {} }) {
  const stops = new Map(tour.stops.map((s) => [s.wikidataId, s]));
  const excluded = { city: 0, outsideBox: 0, noName: 0, transitOnly: 0 };
  const cands = [];
  for (const it of items) {
    const stop = stops.get(it.qid);
    if (!stop) {
      if (it.qid === CITY_QID) { excluded.city++; continue; }
      if (!inCityBox(it.lat, it.lng)) { excluded.outsideBox++; continue; }
      if (it.instanceOf.length && it.instanceOf.every((q) => EXCLUDED_P31.has(q))) { excluded.transitOnly++; continue; }
    }
    const names = stop ? orderedText(stop.names) : labelNames(it.labels);
    if (!names.pl) { excluded.noName++; continue; }
    cands.push({ it, stop, names, lat: stop ? stop.lat : it.lat, lng: stop ? stop.lng : it.lng });
  }
  const missingStops = [...stops.keys()].filter((q) => !cands.some((c) => c.it.qid === q));
  if (missingStops.length) throw new Error(`tour stops missing from the Wikidata snapshot: ${missingStops.join(', ')}`);

  // Dedupe: same normalised pl name within 30 m. Rank: tour stop, sitelinks desc, lower QID.
  cands.sort((a, b) => (b.stop ? 1 : 0) - (a.stop ? 1 : 0) || b.it.sitelinks - a.it.sitelinks || qnum(a.it.qid) - qnum(b.it.qid));
  const byName = new Map();
  const kept = [];
  const merged = [];
  for (const c of cands) {
    const key = normaliseName(c.names.pl);
    const group = byName.get(key) ?? [];
    const twin = group.find((k) => haversineM(k.lat, k.lng, c.lat, c.lng) <= DEDUPE_RADIUS_M);
    if (twin && !c.stop) {
      merged.push({ kept: twin.it.qid, dropped: c.it.qid, name: c.names.pl, distM: round1(haversineM(twin.lat, twin.lng, c.lat, c.lng)) });
      continue;
    }
    group.push(c);
    byName.set(key, group);
    kept.push(c);
  }

  const pois = kept.map((c) => {
    const { it, stop } = c;
    const xy = project(c.lat, c.lng);
    const registerNo = register ? register.lookup(xy.x, xy.y) : null; // null = no register polygon
    const inCore = unesco.some((rings) => pointInPolygon(xy.x, xy.y, rings));
    const isUnesco = inCore || it.heritage.includes(WORLD_HERITAGE_QID);
    const isHeritage = it.heritage.length > 0 || registerNo !== null;
    const sourceIds = [wdSourceId(it.qid)];
    for (const lang of ['en', 'pl', 'zh']) if (wikiPages[lang]?.[it.qid]) sourceIds.push(wpSourceId(lang, it.qid));
    if (registerNo !== null) sourceIds.push(SOURCE_ID_REGISTER);
    if (inCore) sourceIds.push(SOURCE_ID_UNESCO);
    const poi = {
      id: `poi_wd_${it.qid}`,
      kind: stop ? stop.kind : kindFor(it.instanceOf),
      lat: c.lat,
      lng: c.lng,
      x: round1(xy.x),
      y: round1(xy.y),
      names: c.names,
      wikidataId: it.qid,
      importance: importanceOf(it.sitelinks, isHeritage, isUnesco),
      tier: 'name-only',
      triggerRadiusM: stop ? stop.triggerRadiusM : DEFAULT_TRIGGER_RADIUS_M,
    };
    if (stop?.view) poi.view = { look: stop.view.look, feature: orderedText(stop.view.feature) };
    if (isHeritage || isUnesco) poi.heritage = registerNo ? { registerNo, unesco: isUnesco } : { unesco: isUnesco };
    poi.sourceIds = sourceIds;
    return poi;
  });
  pois.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  merged.sort((a, b) => qnum(a.dropped) - qnum(b.dropped));
  return { pois, stopIds: tour.stops.map((s) => s.poiId), merged, excluded };
}

/** Facts the name-only template may use: the inception year (P571, precision year or finer, CE only). */
export function inceptionYear(item) {
  const years = (item?.inception ?? [])
    .filter((x) => x.precision >= 9 && /^\d{4}-/.test(x.time))
    .map((x) => Number(x.time.slice(0, 4)));
  return years.length ? Math.min(...years) : null;
}

export const KIND_SET = new Set(Object.values(PoiKind));
