#!/usr/bin/env node
// Stage 2 (replaces Overpass, which was down on 2026-10-03): Wikidata items located in Kraków
// -> data/raw/wikidata/krakow-items.json(.gz)
//
// Item set: everything with coordinates (P625) that is located in Kraków (P131*, transitively, so
// districts count). Tour stops from data/tours/royal-route.json that are not in that set are
// fetched by QID with the same queries (a UNION in one query made it 6x slower).
// Several small SPARQL queries (~3 s each) instead of one big join that risks the timeout:
//   core      coordinates, sitelink count, labels en/pl/zh/zh-hans/zh-cn
//   titles    en/pl/zh Wikipedia article titles (schema:about sitelinks)
//   props     P31 instance of, P1435 heritage designation, P84 architect, P149 architectural style
//   inception P571 with its precision (best-rank statements)
//   labels    en/pl/zh labels of every value QID used by `props` (batches of 300)
// No coordinate filter is applied: a few items located in Kraków have coordinates elsewhere
// (e.g. artworks with the coordinates of their origin); the pack build filters by bbox.
//
// Usage: node scripts/pack/15-fetch-wikidata.mjs [--offline | --refresh]

import { resolveCourse } from './lib/course.mjs';
import { createHttp, ensureSnapshot, isMain, nowIso, readTour, runMain } from './lib/http.mjs';

export const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
export const REL = 'wikidata/krakow-items.json';
export const KRAKOW = 'Q31487';
export const LABEL_BATCH = 300;

/** The item set: located in Kraków (transitively), or an explicit QID list. */
export function inKrakow() {
  return `?item wdt:P131* wd:${KRAKOW} .`;
}

export function byQids(qids) {
  return `VALUES ?item { ${qids.map((q) => `wd:${q}`).join(' ')} }`;
}

export function coreQuery(set) {
  return `SELECT ?item ?coord ?sitelinks ?en ?pl ?zh ?zhHans ?zhCn WHERE {
  ${set}
  ?item wdt:P625 ?coord ; wikibase:sitelinks ?sitelinks .
  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?item rdfs:label ?pl FILTER(LANG(?pl) = "pl") }
  OPTIONAL { ?item rdfs:label ?zh FILTER(LANG(?zh) = "zh") }
  OPTIONAL { ?item rdfs:label ?zhHans FILTER(LANG(?zhHans) = "zh-hans") }
  OPTIONAL { ?item rdfs:label ?zhCn FILTER(LANG(?zhCn) = "zh-cn") }
}`;
}

export function titlesQuery(set) {
  return `SELECT ?item ?enwiki ?plwiki ?zhwiki WHERE {
  ${set}
  ?item wdt:P625 [] .
  OPTIONAL { ?enA schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?enwiki }
  OPTIONAL { ?plA schema:about ?item ; schema:isPartOf <https://pl.wikipedia.org/> ; schema:name ?plwiki }
  OPTIONAL { ?zhA schema:about ?item ; schema:isPartOf <https://zh.wikipedia.org/> ; schema:name ?zhwiki }
}`;
}

export function propsQuery(set) {
  return `SELECT ?item ?prop ?value WHERE {
  ${set}
  ?item wdt:P625 [] .
  VALUES (?prop ?p) { ("P31" wdt:P31) ("P1435" wdt:P1435) ("P84" wdt:P84) ("P149" wdt:P149) }
  ?item ?p ?value .
}`;
}

export function inceptionQuery(set) {
  return `SELECT ?item ?time ?precision WHERE {
  ${set}
  ?item wdt:P625 [] ; p:P571 ?st . ?st a wikibase:BestRank ; psv:P571 ?tv .
  ?tv wikibase:timeValue ?time ; wikibase:timePrecision ?precision .
}`;
}

export function labelsQuery(qids) {
  return `SELECT ?v ?en ?pl ?zh ?zhHans ?zhCn WHERE {
  VALUES ?v { ${qids.map((q) => `wd:${q}`).join(' ')} }
  OPTIONAL { ?v rdfs:label ?en FILTER(LANG(?en) = "en") }
  OPTIONAL { ?v rdfs:label ?pl FILTER(LANG(?pl) = "pl") }
  OPTIONAL { ?v rdfs:label ?zh FILTER(LANG(?zh) = "zh") }
  OPTIONAL { ?v rdfs:label ?zhHans FILTER(LANG(?zhHans) = "zh-hans") }
  OPTIONAL { ?v rdfs:label ?zhCn FILTER(LANG(?zhCn) = "zh-cn") }
}`;
}

/** 'http://www.wikidata.org/entity/Q123' -> 'Q123'; anything else (blank node, literal) -> null. */
export function qidOf(uri) {
  const m = /^http:\/\/www\.wikidata\.org\/entity\/(Q\d+)$/.exec(uri ?? '');
  return m ? m[1] : null;
}

/** WKT 'Point(lng lat)' -> { lat, lng }; null for non-Earth globes or malformed values. */
export function parseWktPoint(wkt) {
  const m = /^Point\(\s*(-?[\d.]+(?:e-?\d+)?)\s+(-?[\d.]+(?:e-?\d+)?)\s*\)$/i.exec(String(wkt ?? '').trim());
  if (!m) return null;
  const lng = Number(m[1]);
  const lat = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** Simplified Chinese first: zh-hans, then zh-cn, then the generic zh label. */
export function pickZh(l) {
  if (l.zhHans) return { zh: l.zhHans, zhFrom: 'zh-hans' };
  if (l.zhCn) return { zh: l.zhCn, zhFrom: 'zh-cn' };
  if (l.zh) return { zh: l.zh, zhFrom: 'zh' };
  return { zh: null, zhFrom: null };
}

const val = (b, k) => (b[k] ? b[k].value : null);
const qnum = (q) => Number(q.slice(1));

/**
 * Folds SPARQL rows into one record per QID. Several rows per item happen when an item has more
 * than one best-rank coordinate; the coordinates are kept sorted and the first one is lat/lng.
 */
export function foldCore(bindings) {
  const byQ = new Map();
  for (const b of bindings) {
    const qid = qidOf(val(b, 'item'));
    const pt = parseWktPoint(val(b, 'coord'));
    if (!qid || !pt) continue;
    let r = byQ.get(qid);
    if (!r) {
      r = { qid, coords: [], sitelinks: Number(val(b, 'sitelinks') ?? 0), l: {} };
      byQ.set(qid, r);
    }
    if (!r.coords.some((c) => c.lat === pt.lat && c.lng === pt.lng)) r.coords.push(pt);
    for (const k of ['en', 'pl', 'zh', 'zhHans', 'zhCn']) r.l[k] ??= val(b, k);
  }
  const items = [];
  for (const r of byQ.values()) {
    r.coords.sort((a, b) => a.lat - b.lat || a.lng - b.lng);
    const { zh, zhFrom } = pickZh(r.l);
    const item = {
      qid: r.qid,
      lat: r.coords[0].lat,
      lng: r.coords[0].lng,
      sitelinks: r.sitelinks,
      labels: { en: r.l.en ?? null, pl: r.l.pl ?? null, zh },
      zhLabelFrom: zhFrom,
      wikipedia: { en: null, pl: null, zh: null },
      instanceOf: [],
      heritage: [],
      architects: [],
      styles: [],
      inception: [],
    };
    if (r.coords.length > 1) item.otherCoords = r.coords.slice(1);
    items.push(item);
  }
  items.sort((a, b) => qnum(a.qid) - qnum(b.qid));
  return items;
}

/** Adds the en/pl/zh Wikipedia article titles (schema:about sitelinks). */
export function applyTitles(items, bindings) {
  const byQ = new Map(items.map((i) => [i.qid, i]));
  for (const b of bindings) {
    const item = byQ.get(qidOf(val(b, 'item')));
    if (!item) continue;
    for (const k of ['en', 'pl', 'zh']) item.wikipedia[k] ??= val(b, `${k}wiki`);
  }
}

const PROP_FIELD = { P31: 'instanceOf', P1435: 'heritage', P84: 'architects', P149: 'styles' };

/** Adds P31/P1435/P84/P149 values; returns the set of value QIDs that need labels. */
export function applyProps(items, bindings) {
  const byQ = new Map(items.map((i) => [i.qid, i]));
  const valueQids = new Set();
  for (const b of bindings) {
    const item = byQ.get(qidOf(val(b, 'item')));
    const field = PROP_FIELD[val(b, 'prop')];
    const v = qidOf(val(b, 'value'));
    if (!item || !field || !v) continue; // unknown/no value statements have no QID
    if (!item[field].includes(v)) item[field].push(v);
    valueQids.add(v);
  }
  for (const i of items) for (const f of Object.values(PROP_FIELD)) i[f].sort((a, b) => qnum(a) - qnum(b));
  return valueQids;
}

/** Adds P571 inception values as { time, precision } (9 = year, 8 = decade, 7 = century). */
export function applyInception(items, bindings) {
  const byQ = new Map(items.map((i) => [i.qid, i]));
  for (const b of bindings) {
    const item = byQ.get(qidOf(val(b, 'item')));
    const time = val(b, 'time');
    if (!item || !time) continue;
    const precision = Number(val(b, 'precision'));
    if (!item.inception.some((x) => x.time === time && x.precision === precision)) item.inception.push({ time, precision });
  }
  for (const i of items) i.inception.sort((a, b) => a.time.localeCompare(b.time));
}

export function foldLabels(bindings) {
  const out = {};
  for (const b of bindings) {
    const q = qidOf(val(b, 'v'));
    if (!q) continue;
    const l = { zh: val(b, 'zh'), zhHans: val(b, 'zhHans'), zhCn: val(b, 'zhCn') };
    out[q] ??= { en: val(b, 'en'), pl: val(b, 'pl'), zh: pickZh(l).zh };
  }
  return out;
}

async function sparql(http, query) {
  const json = await http.postFormJson(SPARQL_ENDPOINT, { query, format: 'json' }, { Accept: 'application/sparql-results+json' });
  if (!json?.results?.bindings) throw new Error('SPARQL: no results.bindings in response');
  return json.results.bindings;
}

async function fetchSet(http, set, label) {
  console.error(`  fetch  SPARQL core ${label} (coordinates, labels, sitelink count)`);
  const items = foldCore(await sparql(http, coreQuery(set)));
  console.error(`         ${items.length} items`);
  console.error(`  fetch  SPARQL Wikipedia titles ${label}`);
  applyTitles(items, await sparql(http, titlesQuery(set)));
  console.error(`  fetch  SPARQL props ${label} (P31, P1435, P84, P149)`);
  const valueQids = applyProps(items, await sparql(http, propsQuery(set)));
  console.error(`  fetch  SPARQL inception ${label} (P571 + precision)`);
  applyInception(items, await sparql(http, inceptionQuery(set)));
  return { items, valueQids };
}

async function fetchAll(http, stopQids) {
  const main = await fetchSet(http, inKrakow(), 'in Kraków');
  let items = main.items;
  const valueQids = main.valueQids;
  const extra = stopQids.filter((q) => !items.some((i) => i.qid === q));
  if (extra.length) {
    const more = await fetchSet(http, byQids(extra), `for ${extra.length} tour stops outside the P131* set`);
    items = [...items, ...more.items].sort((a, b) => qnum(a.qid) - qnum(b.qid));
    for (const v of more.valueQids) valueQids.add(v);
  }
  const vq = [...valueQids].sort((a, b) => qnum(a) - qnum(b));
  const valueLabels = {};
  for (let k = 0; k < vq.length; k += LABEL_BATCH) {
    console.error(`  fetch  SPARQL labels ${k + 1}-${Math.min(k + LABEL_BATCH, vq.length)} of ${vq.length}`);
    Object.assign(valueLabels, foldLabels(await sparql(http, labelsQuery(vq.slice(k, k + LABEL_BATCH)))));
  }
  const missing = stopQids.filter((q) => !items.some((i) => i.qid === q));
  if (missing.length) throw new Error(`tour stops missing from the Wikidata result: ${missing.join(', ')}`);
  const set = inKrakow();
  return {
    meta: {
      source: 'Wikidata Query Service',
      endpoint: SPARQL_ENDPOINT,
      scope: `items with P625 located in Kraków (wdt:P131* wd:${KRAKOW}); tour stops outside that set are added by QID (${extra.length ? extra.join(', ') : 'none were needed'})`,
      queries: {
        core: coreQuery(set),
        titles: titlesQuery(set),
        props: propsQuery(set),
        inception: inceptionQuery(set),
        labels: labelsQuery(['Q0']).replace('wd:Q0', `<value QIDs, batches of ${LABEL_BATCH}>`),
      },
      retrievedAt: nowIso(),
      licence: 'CC0 1.0 (Wikidata)',
      count: items.length,
      notes: 'labels.zh prefers zh-hans, then zh-cn, then zh (zhLabelFrom says which). inception precision: 11 day, 10 month, 9 year, 8 decade, 7 century, 6 millennium. valueLabels holds the labels of the QIDs used in instanceOf/heritage/architects/styles.',
    },
    items,
    valueLabels,
  };
}

async function main(args) {
  // The snapshot is shared by every course; --course/--tour only choose which tour's stops must be in it.
  const stopQids = readTour(resolveCourse(args).tourFile).stops.map((s) => s.wikidataId);
  const http = createHttp();
  const snap = await ensureSnapshot(REL, args, () => fetchAll(http, stopQids));
  const n = (f) => snap.items.filter(f).length;
  console.log(`wikidata items ${snap.items.length} (retrieved ${snap.meta.retrievedAt})`);
  console.log(`  with en/pl/zh label: ${n((i) => i.labels.en)}/${n((i) => i.labels.pl)}/${n((i) => i.labels.zh)}`);
  console.log(`  with en/pl/zh Wikipedia article: ${n((i) => i.wikipedia.en)}/${n((i) => i.wikipedia.pl)}/${n((i) => i.wikipedia.zh)}`);
  console.log(`  heritage ${n((i) => i.heritage.length)}, inception ${n((i) => i.inception.length)}, architect ${n((i) => i.architects.length)}, style ${n((i) => i.styles.length)}; value labels ${Object.keys(snap.valueLabels).length}`);
  const missing = stopQids.filter((q) => !snap.items.some((i) => i.qid === q));
  if (missing.length) throw new Error(`tour stops missing from the snapshot: ${missing.join(', ')}`);
}

if (isMain(import.meta.url)) runMain(main);
