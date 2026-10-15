// Tests for 30-fetch-wiki.mjs helpers and the committed Wikipedia snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGS, extractsUrl, restSummaryUrl, selectQids, summaryRecord, trimArticle } from './30-fetch-wiki.mjs';
import { findSnapshot, readSnapshot, readTour } from './lib/http.mjs';

const item = (qid, sitelinks, lat = 50.06, lng = 19.94) => ({ qid, sitelinks, lat, lng });

test('selectQids: stops first, then top-N in-city items by sitelinks, no city item', () => {
  const items = [item('Q31487', 185), item('Q5', 10), item('Q4', 10), item('Q9', 50, 49.6, 20.9), item('Q7', 3), item('Q1', 99)];
  assert.deepEqual(selectQids(items, ['Q1'], 2), ['Q1', 'Q4', 'Q5']);
  assert.deepEqual(selectQids(items, [], 10), ['Q1', 'Q4', 'Q5', 'Q7']);
});

test('URLs: REST title with underscores, extracts without exintro, zh in simplified script', () => {
  assert.equal(restSummaryUrl('en', "St. Florian's Gate"), "https://en.wikipedia.org/api/rest_v1/page/summary/St._Florian's_Gate");
  assert.equal(restSummaryUrl('zh', '圣母圣殿 (克拉科夫)'), 'https://zh.wikipedia.org/api/rest_v1/page/summary/%E5%9C%A3%E6%AF%8D%E5%9C%A3%E6%AE%BF_(%E5%85%8B%E6%8B%89%E7%A7%91%E5%A4%AB)');
  const en = new URL(extractsUrl('en', 'Kraków Barbican'));
  assert.equal(en.searchParams.has('exintro'), false); // any value of exintro, even 0, means intro only
  assert.equal(en.searchParams.get('explaintext'), '1');
  assert.equal(en.searchParams.get('titles'), 'Kraków Barbican');
  assert.equal(en.searchParams.has('variant'), false);
  assert.equal(new URL(extractsUrl('zh', 'x')).searchParams.get('variant'), 'zh-hans');
});

test('trimArticle drops reference sections and caps on a paragraph boundary', () => {
  const t = trimArticle('Intro one.\n\n== History ==\nBuilt in 1498.\n\n\n\n== See also ==\nList\n== References ==\n1. x');
  assert.equal(t.text, 'Intro one.\n\n== History ==\nBuilt in 1498.');
  assert.equal(t.truncated, false);
  const pl = trimArticle('Wstęp.\n== Przypisy ==\n[1]');
  assert.equal(pl.text, 'Wstęp.');
  const long = `${'A'.repeat(70)}.\n\n${'B'.repeat(20)}. ${'C'.repeat(40)}`;
  const cut = trimArticle(long, 100);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, `${'A'.repeat(70)}.`);
  assert.equal(cut.fullChars, long.length);
  const zh = trimArticle(`${'甲'.repeat(70)}。${'乙'.repeat(40)}`, 100);
  assert.equal(zh.text, `${'甲'.repeat(70)}。`);
});

test('summaryRecord keeps revision data and notes redirects', () => {
  const r = summaryRecord('Q1', 'Old title', {
    title: 'New title', extract: 'Text.', revision: '123', timestamp: '2026-01-01T00:00:00Z', pageid: 5, type: 'standard',
    content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/New_title' } },
  });
  assert.equal(r.requestedTitle, 'Old title');
  assert.equal(r.revision, '123');
  assert.equal(r.url, 'https://en.wikipedia.org/wiki/New_title');
  assert.equal(summaryRecord('Q1', 'Same', { title: 'Same' }).requestedTitle, undefined);
});

test('committed Wikipedia snapshots cover every tour stop with an article', () => {
  const tour = readTour();
  const wd = new Map(readSnapshot('wikidata/krakow-items.json').items.map((i) => [i.qid, i]));
  for (const lang of LANGS) {
    assert.ok(findSnapshot(`wiki/summaries-${lang}.json`), `summaries-${lang}`);
    const sum = readSnapshot(`wiki/summaries-${lang}.json`);
    const txt = readSnapshot(`wiki/stops-text-${lang}.json`);
    for (const s of tour.stops) {
      if (!wd.get(s.wikidataId).wikipedia[lang]) continue;
      assert.ok(sum.pages[s.wikidataId]?.extract, `${lang} summary ${s.wikidataId}`);
      const t = txt.pages[s.wikidataId];
      assert.ok(t && t.text.length > 100 && t.chars <= 6000, `${lang} text ${s.wikidataId}`);
      assert.ok(t.revid, `${lang} revid ${s.wikidataId}`);
    }
  }
});
