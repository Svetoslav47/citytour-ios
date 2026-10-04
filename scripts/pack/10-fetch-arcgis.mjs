#!/usr/bin/env node
// Stage 1: Kraków city open data from ArcGIS Online -> data/raw/arcgis/*.geojson(.gz)
//
// Org: "Zintegrowana Platforma GIS - Gmina Miejska Kraków" (gmk-2.maps.arcgis.com, org id
// svTzSt3AvH7sK6q9). Discovered on 2026-10-03 through the ArcGIS Online search API
// (`q=Zabytkowe_tablice_SIM`, `q=EOZ_Zabytki`) and the org's services directory.
// Each layer is queried with where=1=1, all fields, GeoJSON in EPSG:4326, coordinates rounded to
// 6 decimals (~0.1 m), paged by resultOffset in OBJECTID order, and the page total is checked
// against returnCountOnly. The item metadata (owner, licenseInfo, accessInformation) is stored
// with each layer so SOURCES.md can state the terms (none were published: "UNVERIFIED").
//
// Usage: node scripts/pack/10-fetch-arcgis.mjs [--offline | --refresh]

import { createHttp, ensureSnapshot, isMain, nowIso, runMain } from './lib/http.mjs';

export const ORG_SERVICES = 'https://services-eu1.arcgis.com/svTzSt3AvH7sK6q9/ArcGIS/rest/services';
export const ITEM_API = 'https://www.arcgis.com/sharing/rest/content/items';

export const LAYERS = [
  { slug: 'pomnik', service: 'Pomnik', layer: 0, what: 'monuments (pomniki) as surveyed points of the city base map; no name attribute (2 of 395 carry a REMARKS note)' },
  { slug: 'zabytkowe-tablice-sim', service: 'Zabytkowe_tablice_SIM', layer: 0, what: 'historic enamel street-name signs kept by the City Information System (SIM), layer inwentaryzacja_ulicowki_; panel_1..5 = sign text (street names), not memorial plaques' },
  { slug: 'eoz-zabytki-zbiorcza-line', service: 'EOZ_Zabytki___Warstwa_zbiorcza___AKTUALNA', layer: 0, what: 'municipal heritage register (EOZ), combined layer, line features' },
  { slug: 'eoz-zabytki-zbiorcza-polygon', service: 'EOZ_Zabytki___Warstwa_zbiorcza___AKTUALNA', layer: 1, what: 'municipal heritage register (EOZ), combined layer, polygons (buildings, sites)' },
  { slug: 'eoz-zabytki-archeologia-point', service: 'EOZ_Zabytki___Archeologia', layer: 0, what: 'municipal heritage register (EOZ), archaeology, points' },
  { slug: 'eoz-zabytki-archeologia-polygon', service: 'EOZ_Zabytki___Archeologia', layer: 1, what: 'municipal heritage register (EOZ), archaeology, polygons' },
  { slug: 'otwarte-dane-eoz', service: 'otwarte_dane_eoz', layer: 0, what: 'municipal heritage register (EOZ), open-data point view with a slim schema' },
  { slug: 'unesco', service: 'UNESCO_4f365', layer: 0, what: 'UNESCO World Heritage zone (Historic Centre of Kraków) polygons' },
];

/** Services that match EOZ_Zabytki_* but are not downloaded; their layer counts are still recorded. */
export const COUNT_ONLY = [
  { service: 'EOZ_Zabytki___Archeologia__2_', layers: [0, 1], reason: 'same layer names, fields and counts as EOZ_Zabytki___Archeologia (a copy owned by another org member); not downloaded' },
];

export const PAGE_SIZE = 1000;

export function layerUrl(service, layer) {
  return `${ORG_SERVICES}/${service}/FeatureServer/${layer}`;
}

/** Offsets for paging `total` records `pageSize` at a time (always at least one page). */
export function pageOffsets(total, pageSize) {
  const out = [];
  for (let o = 0; o < Math.max(total, 1); o += pageSize) out.push(o);
  return out;
}

export function queryParams(oidField, offset, pageSize) {
  return new URLSearchParams({
    where: '1=1',
    outFields: '*',
    f: 'geojson',
    outSR: '4326',
    geometryPrecision: '6',
    orderByFields: `${oidField} ASC`,
    resultOffset: String(offset),
    resultRecordCount: String(pageSize),
  }).toString();
}

export function stripHtml(s) {
  return String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "UNVERIFIED" unless the item publishes licence or access terms. */
export function licenceStatus(item) {
  const terms = [stripHtml(item.licenseInfo), stripHtml(item.accessInformation)].filter(Boolean);
  return terms.length ? terms.join(' / ') : 'UNVERIFIED';
}

/** ArcGIS reports query errors as HTTP 200 with an `error` body. */
function check(json, what) {
  if (json && json.error) throw new Error(`ArcGIS error for ${what}: ${JSON.stringify(json.error).slice(0, 300)}`);
  return json;
}

async function fetchItem(http, service) {
  const svc = check(await http.getJson(`${ORG_SERVICES}/${service}/FeatureServer?f=json`), service);
  const itemId = svc.serviceItemId;
  const item = itemId ? check(await http.getJson(`${ITEM_API}/${itemId}?f=json`), `item ${itemId}`) : {};
  return {
    itemId: itemId ?? null,
    itemPage: itemId ? `https://www.arcgis.com/home/item.html?id=${itemId}` : null,
    title: item.title ?? null,
    owner: item.owner ?? null,
    access: item.access ?? null,
    modified: item.modified ? new Date(item.modified).toISOString() : null,
    licenseInfo: stripHtml(item.licenseInfo) || null,
    accessInformation: stripHtml(item.accessInformation) || null,
    licence: licenceStatus(item),
  };
}

async function countOf(http, url) {
  return check(await http.getJson(`${url}/query?where=1%3D1&returnCountOnly=true&f=json`), url).count;
}

async function fetchLayer(http, L) {
  const url = layerUrl(L.service, L.layer);
  console.error(`  fetch  ${L.service}/${L.layer} (${L.what})`);
  const info = check(await http.getJson(`${url}?f=json`), url);
  const item = await fetchItem(http, L.service);
  const total = await countOf(http, url);
  const oid = info.objectIdField || 'OBJECTID';
  const pageSize = Math.min(info.maxRecordCount || PAGE_SIZE, PAGE_SIZE);
  const features = [];
  for (const offset of pageOffsets(total, pageSize)) {
    const page = check(await http.getJson(`${url}/query?${queryParams(oid, offset, pageSize)}`), url);
    features.push(...(page.features ?? []));
  }
  if (features.length !== total) throw new Error(`${L.service}/${L.layer}: got ${features.length} features, count says ${total}`);
  features.sort((a, b) => (a.properties?.[oid] ?? 0) - (b.properties?.[oid] ?? 0));
  return {
    type: 'FeatureCollection',
    meta: {
      source: 'Kraków municipal ArcGIS Online (Zintegrowana Platforma GIS - Gmina Miejska Kraków)',
      what: L.what,
      service: L.service,
      layerId: L.layer,
      layerName: info.name ?? null,
      geometryType: info.geometryType ?? null,
      url,
      query: queryParams(oid, 0, pageSize).replace(/resultOffset=0/, 'resultOffset=<paged>'),
      objectIdField: oid,
      count: features.length,
      retrievedAt: nowIso(),
      item,
    },
    features,
  };
}

async function main(args) {
  const http = createHttp();
  const summary = [];
  for (const L of LAYERS) {
    const fc = await ensureSnapshot(`arcgis/${L.slug}.geojson`, args, () => fetchLayer(http, L));
    summary.push({ slug: L.slug, service: L.service, layerId: L.layer, count: fc.features.length, licence: fc.meta.item.licence, retrievedAt: fc.meta.retrievedAt });
  }
  const index = await ensureSnapshot('arcgis/index.json', args, async () => {
    const countOnly = [];
    for (const c of COUNT_ONLY) {
      const item = await fetchItem(http, c.service);
      const counts = {};
      for (const l of c.layers) counts[l] = await countOf(http, layerUrl(c.service, l));
      countOnly.push({ ...c, url: `${ORG_SERVICES}/${c.service}/FeatureServer`, counts, item, retrievedAt: nowIso() });
    }
    return { org: 'Zintegrowana Platforma GIS - Gmina Miejska Kraków (gmk-2.maps.arcgis.com)', servicesDirectory: ORG_SERVICES, layers: summary, countOnly };
  });
  for (const s of summary) console.log(`arcgis ${s.slug.padEnd(34)} ${String(s.count).padStart(6)}  licence=${s.licence}`);
  for (const c of index.countOnly) console.log(`arcgis (count only) ${c.service} ${JSON.stringify(c.counts)}`);
}

if (isMain(import.meta.url)) runMain(main);
