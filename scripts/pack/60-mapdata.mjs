// Stage 6a: map-detail.json (MapData, level "detail") from the committed OSM tiles (Node 22+ ESM, no network).
//
// Input:  data/raw/osm/oldtown-tile{1..9}.osm.gz   OSM API 0.6 `map` responses, 3 x 3 tiles over the Old Town
//                                                  (lon 19.929-19.947, lat 50.0525-50.0675); edges overlap, so
//                                                  elements are deduplicated by id
//         data/raw/arcgis/unesco.geojson           UNESCO core zone polygon (City of Kraków ArcGIS)
// Output: MapData { level: 'detail', origin, bounds (metres, the tiles' extent), layers in draw order }:
//   water      natural=water, water=*, waterway=riverbank, landuse=reservoir|basin       polygon, minScale 0
//   river      waterway=river|canal|stream (centre lines)                              line,    minScale 0
//   green      leisure=park|garden, landuse=grass|forest|meadow|recreation_ground|village_green|flowerbed|cemetery,
//              natural=wood|scrub|grassland|shrubbery|heath (the Planty ring is park/grass) polygon, minScale 0
//   unesco     the ArcGIS "Granice obszaru UNESCO" core zone (outline)                  polygon, minScale 0
//   buildings  building=* (not "no"), ways and multipolygon relations                    polygon, minScale 0
//   paths      highway=footway|path|steps|cycleway|bridleway|track                       line,    minScale 1 (s > 1, §3.2)
//   minor      highway=residential|living_street|pedestrian|service|unclassified|road  line,    minScale 0
//   major      highway=primary|secondary|tertiary|trunk|motorway (+ _link), with name   line,    minScale 0
// Highways tagged area=yes or indoor=yes are not drawn. Multipolygon rings are assembled from the member ways
// present in the tiles; rings that cannot be closed are dropped (counted in the stats).
// Geometry: projected (projection.mjs), Douglas-Peucker 0.8 m, flat integer decimetres. Polygons carry
// `rings` = start offsets into `c` of every ring (first is 0; ring 0 outer, then holes; even-odd fill) and do not
// repeat the first vertex. Features are sorted by OSM element (ways by id, then relations by id).
// The whole-city `map-overview.json` is not built: the committed OSM data covers only these 9 tiles.

import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { bboxOf, douglasPeucker, PACK_ORIGIN, pointInRing, project, projectX, projectY, round1, toDm } from './projection.mjs';
import { projectedPolygons, UNESCO_CORE_NAME } from './40-merge-pois.mjs';

export const MAP_TOLERANCE_M = 0.8;

/** Draw order, bottom to top (ARCHITECTURE §3.2), with geometry kind and the minimum camera scale (px/m). */
export const LAYERS = Object.freeze([
  { id: 'water', geom: 'polygon', minScale: 0 },
  { id: 'river', geom: 'line', minScale: 0 },
  { id: 'green', geom: 'polygon', minScale: 0 },
  { id: 'unesco', geom: 'polygon', minScale: 0 },
  { id: 'buildings', geom: 'polygon', minScale: 0 },
  { id: 'paths', geom: 'line', minScale: 1 },
  { id: 'minor', geom: 'line', minScale: 0 },
  { id: 'major', geom: 'line', minScale: 0 },
]);

const MAJOR = new Set(['primary', 'secondary', 'tertiary', 'trunk', 'motorway'].flatMap((h) => [h, `${h}_link`]));
const MINOR = new Set(['residential', 'living_street', 'pedestrian', 'service', 'unclassified', 'road']);
const PATHS = new Set(['footway', 'path', 'steps', 'cycleway', 'bridleway', 'track']);
const GREEN_LEISURE = new Set(['park', 'garden']);
const GREEN_LANDUSE = new Set(['grass', 'forest', 'meadow', 'recreation_ground', 'village_green', 'flowerbed', 'cemetery']);
const GREEN_NATURAL = new Set(['wood', 'scrub', 'grassland', 'shrubbery', 'heath']);
const RIVER = new Set(['river', 'canal', 'stream']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e],
  );
}

/**
 * Parses OSM XML documents (as produced by the OSM API) into nodes/ways/relations, first occurrence wins
 * (overlapping tiles hold identical copies). Returns { nodes: Map<id,[lat,lon]>, ways, relations, bounds[] }.
 */
export function parseOsm(xmls) {
  const nodes = new Map();
  const ways = new Map();
  const relations = new Map();
  const bounds = [];
  for (const xml of xmls) {
    const b = /<bounds\s+minlat="([\d.-]+)"\s+minlon="([\d.-]+)"\s+maxlat="([\d.-]+)"\s+maxlon="([\d.-]+)"/.exec(xml);
    if (b) bounds.push({ minLat: Number(b[1]), minLon: Number(b[2]), maxLat: Number(b[3]), maxLon: Number(b[4]) });
    const re = /<(node|way|relation)\s+id="(\d+)"([^>]*?)(\/?)>/g;
    let m;
    while ((m = re.exec(xml))) {
      const [, type, id, attrs, selfClose] = m;
      let body = '';
      if (!selfClose) {
        const end = xml.indexOf(`</${type}>`, re.lastIndex);
        if (end < 0) throw new Error(`OSM XML: unterminated <${type} id="${id}">`);
        body = xml.slice(re.lastIndex, end);
        re.lastIndex = end;
      }
      if (type === 'node') {
        if (nodes.has(id)) continue;
        const lat = /\slat="([\d.-]+)"/.exec(attrs);
        const lon = /\slon="([\d.-]+)"/.exec(attrs);
        if (lat && lon) nodes.set(id, [Number(lat[1]), Number(lon[1])]);
        continue;
      }
      const map = type === 'way' ? ways : relations;
      if (map.has(id)) continue;
      const tags = {};
      for (const t of body.matchAll(/<tag\s+k="([^"]*)"\s+v="([^"]*)"\s*\/>/g)) tags[decodeXml(t[1])] = decodeXml(t[2]);
      if (type === 'way') ways.set(id, { id, nds: [...body.matchAll(/<nd\s+ref="(\d+)"\s*\/>/g)].map((x) => x[1]), tags });
      else {
        const members = [...body.matchAll(/<member\s+type="(\w+)"\s+ref="(\d+)"\s+role="([^"]*)"\s*\/>/g)].map((x) => ({
          type: x[1], ref: x[2], role: decodeXml(x[3]),
        }));
        relations.set(id, { id, members, tags });
      }
    }
  }
  return { nodes, ways, relations, bounds };
}

/** Layer id for an element's tags (closed = closed way or multipolygon), or null. */
export function layerOf(tags, closed) {
  if (tags.building && tags.building !== 'no') return closed ? 'buildings' : null;
  if (tags.natural === 'water' || tags.water || tags.waterway === 'riverbank' || tags.landuse === 'reservoir' || tags.landuse === 'basin') {
    return closed ? 'water' : null;
  }
  if (RIVER.has(tags.waterway)) return closed ? null : 'river';
  if (GREEN_LEISURE.has(tags.leisure) || GREEN_LANDUSE.has(tags.landuse) || GREEN_NATURAL.has(tags.natural)) return closed ? 'green' : null;
  if (tags.highway) {
    if (tags.area === 'yes' || tags.indoor === 'yes') return null;
    if (MAJOR.has(tags.highway)) return 'major';
    if (MINOR.has(tags.highway)) return 'minor';
    if (PATHS.has(tags.highway)) return 'paths';
  }
  return null;
}

/** Joins node-id lists into closed rings (deterministic: input order). Returns { rings, open }. */
export function assembleRings(lists) {
  const pool = lists.filter((l) => l.length >= 2).map((l) => [...l]);
  const rings = [];
  let open = 0;
  while (pool.length) {
    let cur = pool.shift();
    while (cur[0] !== cur[cur.length - 1]) {
      const last = cur[cur.length - 1];
      const i = pool.findIndex((l) => l[0] === last || l[l.length - 1] === last);
      if (i < 0) break;
      const next = pool.splice(i, 1)[0];
      cur = cur.concat((next[0] === last ? next : [...next].reverse()).slice(1));
    }
    if (cur[0] === cur[cur.length - 1] && cur.length >= 4) rings.push(cur);
    else open++;
  }
  return { rings, open };
}

function projectNodes(ids, nodes) {
  const flat = [];
  for (const id of ids) {
    const n = nodes.get(id);
    if (!n) return null;
    flat.push(projectX(n[1]), projectY(n[0]));
  }
  return flat;
}

/** Flat metres -> flat decimetre ints without consecutive duplicates. */
function toDmFlat(flat) {
  const out = [];
  for (let k = 0; k < flat.length; k += 2) {
    const x = toDm(flat[k]);
    const y = toDm(flat[k + 1]);
    if (out.length && out[out.length - 2] === x && out[out.length - 1] === y) continue;
    out.push(x, y);
  }
  return out;
}

/** Closed ring (first point repeated) in metres -> simplified dm ring without the repeat, or null. */
export function simplifyRing(flat, tol = MAP_TOLERANCE_M) {
  const s = toDmFlat(douglasPeucker(flat, tol));
  if (s.length >= 4 && s[0] === s[s.length - 2] && s[1] === s[s.length - 1]) s.length -= 2;
  return s.length >= 6 ? s : null;
}

export function simplifyLine(flat, tol = MAP_TOLERANCE_M) {
  const s = toDmFlat(douglasPeucker(flat, tol));
  return s.length >= 4 ? s : null;
}

/** Polygon feature from dm rings (outer first). */
export function polygonFeature(rings, name) {
  const c = [];
  const offsets = [];
  for (const r of rings) {
    offsets.push(c.length);
    c.push(...r);
  }
  const f = { c, rings: offsets, bb: bboxOf(c) };
  if (name) f.name = name;
  return f;
}

export function lineFeature(c, name) {
  const f = { c, bb: bboxOf(c) };
  if (name) f.name = name;
  return f;
}

/**
 * OSM tile files (relative to data/raw/) of each map area. `oldtown` is the Royal Route (`krakow`) map; `kazimierz`
 * (course krakow-kazimierz) is the Old Town's southern row (tiles 1-3, Wawel) plus the five Kazimierz tiles of
 * 20-fetch-osm-tiles.mjs: lon 19.929-19.953, lat 50.0475-50.0575.
 */
export const MAP_AREAS = Object.freeze({
  oldtown: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => `osm/oldtown-tile${k}.osm.gz`)),
  kazimierz: Object.freeze([
    ...[1, 2, 3].map((k) => `osm/oldtown-tile${k}.osm.gz`),
    ...[1, 2, 3, 4, 5].map((k) => `osm/kazimierz-tile${k}.osm.gz`),
  ]),
});

/** Reads gzipped OSM XML files (paths relative to rawDir) as strings. */
export function readOsmFiles(rawDir, rels) {
  return rels.map((rel) => gunzipSync(readFileSync(`${rawDir}/${rel}`)).toString('utf8'));
}

export function readOsmTiles(rawDir, n = 9) {
  const xmls = [];
  for (let k = 1; k <= n; k++) xmls.push(gunzipSync(readFileSync(`${rawDir}/osm/oldtown-tile${k}.osm.gz`)).toString('utf8'));
  return xmls;
}

/** Builds MapData (level detail) + stats. */
export function buildMapDetail({ osm, unescoGeojson }) {
  const { nodes, ways, relations, bounds } = osm;
  const feats = Object.fromEntries(LAYERS.map((l) => [l.id, []]));
  const stats = { ways: 0, relations: 0, openRings: 0, droppedTiny: 0 };
  const wayIds = [...ways.keys()].sort((a, b) => Number(a) - Number(b));
  for (const id of wayIds) {
    const w = ways.get(id);
    const closed = w.nds.length >= 4 && w.nds[0] === w.nds[w.nds.length - 1];
    const layer = layerOf(w.tags, closed);
    if (!layer) continue;
    const flat = projectNodes(w.nds, nodes);
    if (!flat) continue;
    const def = LAYERS.find((l) => l.id === layer);
    if (def.geom === 'polygon') {
      const ring = simplifyRing(flat);
      if (!ring) { stats.droppedTiny++; continue; }
      feats[layer].push(polygonFeature([ring]));
    } else {
      const line = simplifyLine(flat);
      if (!line) { stats.droppedTiny++; continue; }
      feats[layer].push(lineFeature(line, layer === 'major' ? w.tags.name : undefined));
    }
    stats.ways++;
  }
  const relIds = [...relations.keys()].sort((a, b) => Number(a) - Number(b));
  for (const id of relIds) {
    const r = relations.get(id);
    if (r.tags.type !== 'multipolygon') continue;
    const layer = layerOf(r.tags, true);
    if (!layer || LAYERS.find((l) => l.id === layer).geom !== 'polygon') continue;
    const lists = (role) =>
      r.members.filter((m) => m.type === 'way' && (role === 'inner' ? m.role === 'inner' : m.role !== 'inner') && ways.has(m.ref)).map((m) => ways.get(m.ref).nds);
    const outer = assembleRings(lists('outer'));
    const inner = assembleRings(lists('inner'));
    stats.openRings += outer.open + inner.open;
    const innerM = inner.rings.map((ids) => projectNodes(ids, nodes)).filter(Boolean);
    for (const ids of outer.rings) {
      const o = projectNodes(ids, nodes);
      if (!o) continue;
      const ring = simplifyRing(o);
      if (!ring) { stats.droppedTiny++; continue; }
      const holes = innerM.filter((h) => pointInRing(h[0], h[1], o)).map((h) => simplifyRing(h)).filter(Boolean);
      feats[layer].push(polygonFeature([ring, ...holes]));
    }
    stats.relations++;
  }
  for (const f of unescoGeojson?.features ?? []) {
    if (f.properties?.UNESCO !== UNESCO_CORE_NAME) continue;
    for (const rings of projectedPolygons(f.geometry)) {
      const rs = rings.map((r) => simplifyRing(r)).filter(Boolean);
      if (rs.length) feats.unesco.push(polygonFeature(rs));
    }
  }
  const minLon = Math.min(...bounds.map((b) => b.minLon));
  const minLat = Math.min(...bounds.map((b) => b.minLat));
  const maxLon = Math.max(...bounds.map((b) => b.maxLon));
  const maxLat = Math.max(...bounds.map((b) => b.maxLat));
  const sw = project(minLat, minLon);
  const ne = project(maxLat, maxLon);
  const map = {
    level: 'detail',
    origin: { lat: PACK_ORIGIN.lat, lng: PACK_ORIGIN.lng },
    bounds: [round1(sw.x), round1(sw.y), round1(ne.x), round1(ne.y)],
    layers: LAYERS.map((l) => ({ id: l.id, geom: l.geom, minScale: l.minScale, features: feats[l.id] })),
  };
  stats.features = Object.fromEntries(LAYERS.map((l) => [l.id, feats[l.id].length]));
  return { map, stats };
}
