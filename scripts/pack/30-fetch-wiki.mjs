#!/usr/bin/env node
// Stage 4: Wikipedia text for the tour stops and the most notable Kraków places -> data/raw/wiki/
//
//   summaries-{en,pl,zh}.json(.gz)   REST page summaries (lead extract, description, revision) for
//                                    the 11 tour stops + the top 300 other items by sitelink count
//   stops-text-{en,pl,zh}.json       fuller article text of the 11 tour stops (up to ~6,000 chars),
//                                    the only source task B7 may use to draft cited narrations
//
// Article titles come from the Wikidata snapshot (schema:about sitelinks), so this script needs
// data/raw/wikidata/krakow-items.json(.gz) first. Chinese is requested in simplified script:
// `Accept-Language: zh-hans` for REST and `variant=zh-hans` for the action API.
// Texts are CC BY-SA 4.0 ("Wikipedia contributors"); revision ids are kept for attribution.
//
// Courses (scripts/pack/lib/course.mjs): the summaries are shared by every course; the stop texts are per tour
// (default course: data/raw/wiki/stops-text-*.json; others: data/raw/tours/<tourId>/wiki/stops-text-*.json).
//
// A tour may list `sourceQids` (review-only key of data/tours/<tourId>.json): extra articles a stop story cites
// (e.g. the Ethnographic Museum for the Kazimierz Town Hall). Their full texts go into the same stop-text files,
// after the stops.
//
// Usage: node scripts/pack/30-fetch-wiki.mjs [--offline | --refresh] [--course <courseId> | --tour <tourId>]

import { resolveCourse } from './lib/course.mjs';
import { createHttp, ensureSnapshot, HttpError, isMain, nowIso, readSnapshot, readTour, runMain } from './lib/http.mjs';

export const LANGS = ['en', 'pl', 'zh'];
export const TOP_N = 300;
export const MAX_STOP_CHARS = 6000;
export const CITY_QID = 'Q31487'; // the city item itself is not a place to visit
/** Kraków city area (generous): drops items "located in Kraków" whose coordinates point elsewhere. */
export const CITY_BOX = { minLat: 49.97, maxLat: 50.13, minLng: 19.79, maxLng: 20.22 };
const LICENCE = 'CC BY-SA 4.0, Wikipedia contributors';

/** Tour stops first (tour order), then the top `n` other in-city items by sitelinks (ties: lower QID). */
export function selectQids(items, stopQids, n = TOP_N, box = CITY_BOX) {
  const stops = new Set(stopQids);
  const others = items
    .filter((i) => !stops.has(i.qid) && i.qid !== CITY_QID)
    .filter((i) => i.lat >= box.minLat && i.lat <= box.maxLat && i.lng >= box.minLng && i.lng <= box.maxLng)
    .sort((a, b) => b.sitelinks - a.sitelinks || Number(a.qid.slice(1)) - Number(b.qid.slice(1)))
    .slice(0, n)
    .map((i) => i.qid);
  return [...stopQids, ...others];
}

export function restSummaryUrl(lang, title) {
  return `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

export function extractsUrl(lang, title) {
  const q = new URLSearchParams({
    action: 'query',
    prop: 'extracts|revisions|info',
    explaintext: '1',
    exsectionformat: 'wiki', // keeps "== Heading ==" lines so trailing reference sections can be cut
    rvprop: 'ids|timestamp',
    inprop: 'url',
    redirects: '1',
    format: 'json',
    formatversion: '2',
    titles: title,
  });
  if (lang === 'zh') q.set('variant', 'zh-hans');
  return `https://${lang}.wikipedia.org/w/api.php?${q}`;
}

export function langHeaders(lang) {
  return lang === 'zh' ? { 'Accept-Language': 'zh-hans' } : {};
}

/** Headings from which an article is only lists of links and references. */
const TAIL_SECTIONS = new Set([
  'see also', 'references', 'notes', 'footnotes', 'further reading', 'external links', 'bibliography', 'sources', 'gallery',
  'zobacz też', 'przypisy', 'bibliografia', 'linki zewnętrzne', 'galeria', 'uwagi',
  '参见', '參見', '参考文献', '參考文獻', '参考资料', '參考資料', '外部链接', '外部連結', '注释', '註釋', '延伸阅读', '图集',
]);

/** Drops trailing link/reference sections and caps the text at `max` chars on a paragraph or sentence end. */
export function trimArticle(text, max = MAX_STOP_CHARS) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  for (const line of lines) {
    const h = /^=+\s*(.*?)\s*=+$/.exec(line.trim());
    if (h && TAIL_SECTIONS.has(h[1].toLowerCase())) break;
    out.push(line);
  }
  let body = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const fullChars = body.length;
  if (body.length <= max) return { text: body, chars: body.length, fullChars, truncated: false };
  let cut = body.slice(0, max);
  const para = cut.lastIndexOf('\n\n');
  if (para > max * 0.6) cut = cut.slice(0, para);
  else {
    const ends = [...cut.matchAll(/[.!?](?=\s)|[。！？]/g)];
    const last = ends.length ? ends[ends.length - 1].index + 1 : -1;
    if (last > max * 0.6) cut = cut.slice(0, last);
  }
  body = cut.trim();
  return { text: body, chars: body.length, fullChars, truncated: true };
}

export function summaryRecord(qid, requestedTitle, s) {
  return {
    qid,
    title: s.title ?? requestedTitle,
    ...(s.title && s.title.replace(/_/g, ' ') !== requestedTitle ? { requestedTitle } : {}),
    description: s.description ?? null,
    extract: s.extract ?? '',
    type: s.type ?? null,
    url: s.content_urls?.desktop?.page ?? null,
    pageid: s.pageid ?? null,
    revision: s.revision ?? null,
    timestamp: s.timestamp ?? null,
  };
}

async function fetchSummaries(http, lang, qids, byQ) {
  const pages = {};
  const missing = [];
  const todo = qids.filter((q) => byQ.get(q)?.wikipedia?.[lang]);
  console.error(`  fetch  ${lang} summaries: ${todo.length} articles`);
  for (const qid of todo) {
    const title = byQ.get(qid).wikipedia[lang];
    try {
      const s = await http.getJson(restSummaryUrl(lang, title), langHeaders(lang));
      pages[qid] = summaryRecord(qid, title, s);
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) missing.push({ qid, title, status: 404 });
      else throw e;
    }
  }
  return {
    meta: {
      source: `${lang}.wikipedia.org REST API page summary`,
      endpoint: `https://${lang}.wikipedia.org/api/rest_v1/page/summary/{title}`,
      headers: langHeaders(lang),
      selection: `11 tour stops + top ${TOP_N} other in-city Wikidata items by sitelink count (titles from the Wikidata snapshot)`,
      retrievedAt: nowIso(),
      licence: LICENCE,
      count: Object.keys(pages).length,
      missing,
    },
    pages,
  };
}

async function fetchStopTexts(http, lang, stopQids, byQ) {
  const pages = {};
  const missing = [];
  for (const qid of stopQids) {
    const title = byQ.get(qid)?.wikipedia?.[lang];
    if (!title) {
      missing.push({ qid, reason: `no ${lang} article` });
      continue;
    }
    const json = await http.getJson(extractsUrl(lang, title));
    const p = json?.query?.pages?.[0];
    if (!p || p.missing || typeof p.extract !== 'string') {
      missing.push({ qid, title, reason: 'page missing' });
      continue;
    }
    const t = trimArticle(p.extract);
    pages[qid] = {
      qid,
      title: p.title,
      pageid: p.pageid,
      revid: p.revisions?.[0]?.revid ?? null,
      timestamp: p.revisions?.[0]?.timestamp ?? null,
      url: p.fullurl ?? null,
      ...t,
    };
  }
  return {
    meta: {
      source: `${lang}.wikipedia.org action API, prop=extracts (plain text) + revisions + info`,
      endpoint: extractsUrl(lang, '{title}').replace('%7Btitle%7D', '{title}'),
      processing: `whole article as plain text with "== Heading ==" lines; trailing link/reference sections dropped; capped at ${MAX_STOP_CHARS} chars on a paragraph or sentence end (truncated=true)`,
      retrievedAt: nowIso(),
      licence: LICENCE,
      count: Object.keys(pages).length,
      missing,
    },
    pages,
  };
}

async function main(args) {
  const course = resolveCourse(args);
  const tour = readTour(course.tourFile);
  const stopQids = tour.stops.map((s) => s.wikidataId);
  const textQids = [...stopQids, ...(tour.sourceQids ?? []).filter((q) => !stopQids.includes(q))];
  const wd = readSnapshot('wikidata/krakow-items.json');
  const byQ = new Map(wd.items.map((i) => [i.qid, i]));
  const qids = selectQids(wd.items, stopQids);
  const http = createHttp();
  for (const lang of LANGS) {
    const s = await ensureSnapshot(`wiki/summaries-${lang}.json`, args, () => fetchSummaries(http, lang, qids, byQ));
    console.log(`wiki ${lang} summaries ${s.meta.count} (missing ${s.meta.missing.length}), retrieved ${s.meta.retrievedAt}`);
  }
  for (const lang of LANGS) {
    const s = await ensureSnapshot(course.rawRel(`wiki/stops-text-${lang}.json`), args, () => fetchStopTexts(http, lang, textQids, byQ));
    const chars = Object.values(s.pages).map((p) => p.chars);
    console.log(`wiki ${lang} stop texts ${s.meta.count}/${textQids.length} (${chars.length ? Math.min(...chars) : 0}-${chars.length ? Math.max(...chars) : 0} chars), missing: ${s.meta.missing.map((m) => m.qid).join(' ') || 'none'}`);
  }
}

if (isMain(import.meta.url)) runMain(main);
