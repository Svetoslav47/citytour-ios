// Tests for the SPARQL result parsing in 15-fetch-wikidata.mjs and the committed snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REL,
  applyInception,
  applyProps,
  applyTitles,
  foldCore,
  foldLabels,
  parseWktPoint,
  pickZh,
  qidOf,
} from './15-fetch-wikidata.mjs';
import { readSnapshot, readTour } from './lib/http.mjs';

const uri = (q) => ({ type: 'uri', value: `http://www.wikidata.org/entity/${q}` });
const lit = (v, lang) => ({ type: 'literal', value: String(v), ...(lang ? { 'xml:lang': lang } : {}) });

test('qidOf accepts entity URIs only', () => {
  assert.equal(qidOf('http://www.wikidata.org/entity/Q31487'), 'Q31487');
  assert.equal(qidOf('http://www.wikidata.org/.well-known/genid/abc'), null);
  assert.equal(qidOf(undefined), null);
});

test('parseWktPoint reads Point(lng lat) and rejects junk', () => {
  assert.deepEqual(parseWktPoint('Point(19.9416 50.0655)'), { lat: 50.0655, lng: 19.9416 });
  assert.deepEqual(parseWktPoint(' Point(-0.5 1e-3) '), { lat: 0.001, lng: -0.5 });
  assert.equal(parseWktPoint('<http://www.wikidata.org/entity/Q405> Point(1 2)'), null); // Moon globe
  assert.equal(parseWktPoint('Point(200 50)'), null);
  assert.equal(parseWktPoint(null), null);
});

test('pickZh prefers simplified Chinese', () => {
  assert.deepEqual(pickZh({ zh: '亞', zhHans: '亚' }), { zh: '亚', zhFrom: 'zh-hans' });
  assert.deepEqual(pickZh({ zh: '亞', zhCn: '亚' }), { zh: '亚', zhFrom: 'zh-cn' });
  assert.deepEqual(pickZh({ zh: '亞' }), { zh: '亞', zhFrom: 'zh' });
  assert.deepEqual(pickZh({}), { zh: null, zhFrom: null });
});

test('foldCore merges duplicate rows, keeps all coordinates, sorts by QID', () => {
  const rows = [
    { item: uri('Q20'), coord: lit('Point(19.9 50.1)'), sitelinks: lit(3), pl: lit('B', 'pl') },
    { item: uri('Q3'), coord: lit('Point(19.5 50.0)'), sitelinks: lit(7), en: lit('A', 'en'), zh: lit('甲', 'zh') },
    { item: uri('Q20'), coord: lit('Point(19.8 50.0)'), sitelinks: lit(3), pl: lit('B', 'pl') },
    { item: uri('Q9'), coord: lit('not a point'), sitelinks: lit(1) },
  ];
  const items = foldCore(rows);
  assert.deepEqual(items.map((i) => i.qid), ['Q3', 'Q20']);
  const q20 = items[1];
  assert.deepEqual([q20.lat, q20.lng], [50.0, 19.8]);
  assert.deepEqual(q20.otherCoords, [{ lat: 50.1, lng: 19.9 }]);
  assert.deepEqual(items[0].labels, { en: 'A', pl: null, zh: '甲' });
  assert.equal(items[0].sitelinks, 7);
});

test('applyTitles, applyProps and applyInception attach values and skip unknowns', () => {
  const items = foldCore([{ item: uri('Q1'), coord: lit('Point(19.9 50.0)'), sitelinks: lit(2) }]);
  applyTitles(items, [{ item: uri('Q1'), plwiki: lit('Barbakan w Krakowie', 'pl') }]);
  assert.deepEqual(items[0].wikipedia, { en: null, pl: 'Barbakan w Krakowie', zh: null });
  const values = applyProps(items, [
    { item: uri('Q1'), prop: lit('P1435'), value: uri('Q21438156') },
    { item: uri('Q1'), prop: lit('P31'), value: uri('Q16970') },
    { item: uri('Q1'), prop: lit('P31'), value: uri('Q16970') },
    { item: uri('Q1'), prop: lit('P84'), value: { type: 'bnode', value: 't1' } },
    { item: uri('Q999'), prop: lit('P31'), value: uri('Q5') },
  ]);
  assert.deepEqual(items[0].instanceOf, ['Q16970']);
  assert.deepEqual(items[0].heritage, ['Q21438156']);
  assert.deepEqual(items[0].architects, []);
  assert.deepEqual([...values].sort(), ['Q16970', 'Q21438156']); // Q999 is not in the item set
  applyInception(items, [
    { item: uri('Q1'), time: lit('1498-01-01T00:00:00Z'), precision: lit(9) },
    { item: uri('Q1'), time: lit('1498-01-01T00:00:00Z'), precision: lit(9) },
  ]);
  assert.deepEqual(items[0].inception, [{ time: '1498-01-01T00:00:00Z', precision: 9 }]);
});

test('foldLabels resolves zh like the items', () => {
  assert.deepEqual(foldLabels([{ v: uri('Q16970'), en: lit('church building'), zhHans: lit('教堂建筑') }]), {
    Q16970: { en: 'church building', pl: null, zh: '教堂建筑' },
  });
});

test('committed Wikidata snapshot holds every tour stop at the tour coordinates', () => {
  const snap = readSnapshot(REL);
  assert.ok(snap.items.length > 4000, `only ${snap.items.length} items`);
  const byQ = new Map(snap.items.map((i) => [i.qid, i]));
  for (const s of readTour().stops) {
    const it = byQ.get(s.wikidataId);
    assert.ok(it, `${s.wikidataId} missing`);
    assert.ok(it.labels.pl, `${s.wikidataId} has no pl label`);
    if (s.coordinateSource === 'wikidata:P625') {
      assert.equal(s.lat, it.lat, `${s.wikidataId} lat`);
      assert.equal(s.lng, it.lng, `${s.wikidataId} lng`);
    }
  }
});
