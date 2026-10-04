// Tests for 40-merge-pois.mjs: kind mapping, names, dedupe, importance, heritage joins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  importanceOf, inceptionYear, kindFor, KIND_BY_P31, KIND_PRECEDENCE, mergePois, normaliseName, registerIndex, registerNumbers,
  unescoCore,
} from './40-merge-pois.mjs';
import { ENUMS } from './schema.mjs';
import { project } from './projection.mjs';

const item = (qid, over = {}) => ({
  qid, lat: 50.06, lng: 19.94, sitelinks: 0, labels: { en: null, pl: `Obiekt ${qid}`, zh: null }, wikipedia: {},
  instanceOf: [], heritage: [], architects: [], styles: [], inception: [], ...over,
});
const stop = (qid, over = {}) => ({
  n: 1, poiId: `poi_wd_${qid}`, wikidataId: qid, kind: 'gate', names: { en: 'Gate', pl: 'Brama', zh: '门' }, lat: 50.065, lng: 19.94,
  coordinateSource: 'wikidata:P625', coordinateCheck: {}, dwellS: 60, prize: 2, triggerRadiusM: 35, approachRadiusM: 110,
  view: { look: 'up', feature: { en: 'the tower' }, basis: { quote: 'x' }, review: 'to review' }, ...over,
});
const tour = (stops) => ({ id: 't', stops });

test('kind map: only contract kinds; precedence church > building; unknown -> other', () => {
  const kinds = new Set(Object.values(ENUMS.PoiKind));
  for (const k of [...Object.values(KIND_BY_P31), ...KIND_PRECEDENCE]) assert.ok(kinds.has(k), k);
  assert.equal(kindFor(['Q16970', 'Q811165']), 'church'); // church building + architectural heritage monument
  assert.equal(kindFor(['Q33506', 'Q16560']), 'museum'); // museum in a palace
  assert.equal(kindFor(['Q79007']), 'other'); // street
  assert.equal(kindFor([]), 'other');
});

test('normaliseName folds case, diacritics, ł and punctuation', () => {
  assert.equal(normaliseName('  Kościół Św. Wojciecha '), 'kosciol sw wojciecha');
  assert.equal(normaliseName('Wieża Ratuszowa'), normaliseName('wieza-ratuszowa'));
  assert.equal(normaliseName('Łobzowska'), 'lobzowska');
});

test('importance formula: 0.6 * sitelinks part + 0.25 heritage + 0.15 UNESCO', () => {
  assert.equal(importanceOf(0, false, false), 0);
  assert.equal(importanceOf(50, false, false), 0.6);
  assert.equal(importanceOf(185, true, true), 1);
  assert.equal(importanceOf(1, true, false), 0.356);
  assert.ok(importanceOf(37, true, true) > importanceOf(10, true, true));
});

test('registerNumbers normalises the free-text NUMER_REJ_ field', () => {
  assert.equal(registerNumbers('A-3 /25.03.1931/  18.03.1973, A-178/M'), 'A-3, A-178/M');
  assert.equal(registerNumbers('A - 468, 23.04.1968'), 'A-468');
  assert.equal(registerNumbers('A--1260/M (13.06.2011 r.)'), 'A-1260/M');
  assert.equal(registerNumbers('A1304/M (11.07.2012 r.)'), 'A-1304/M');
  assert.equal(registerNumbers('A-618, 26.V.1982, A-231/M, A-618'), 'A-618, A-231/M');
  assert.equal(registerNumbers('decyzja w toku'), '');
});

test('inceptionYear: year precision or finer, CE only, earliest', () => {
  assert.equal(inceptionYear({ inception: [{ time: '1498-01-01T00:00:00Z', precision: 9 }] }), 1498);
  assert.equal(inceptionYear({ inception: [{ time: '1400-01-01T00:00:00Z', precision: 7 }] }), null);
  assert.equal(inceptionYear({ inception: [{ time: '1932-05-01T00:00:00Z', precision: 10 }, { time: '1901-01-01T00:00:00Z', precision: 9 }] }), 1901);
  assert.equal(inceptionYear({ inception: [{ time: '-0500-01-01T00:00:00Z', precision: 9 }] }), null);
});

test('mergePois: stops override Wikidata, review keys dropped, exclusions, dedupe within 30 m only', () => {
  const items = [
    item('Q1', { lat: 50.0001, lng: 19.9, labels: { en: 'Wikidata Gate', pl: 'Brama WD', zh: null }, instanceOf: ['Q53060'] }),
    item('Q31487', { sitelinks: 185 }), // the city itself
    item('Q2', { lat: 52.2, lng: 21.0 }), // outside the city box
    item('Q3', { labels: { en: null, pl: null, zh: null } }), // no name
    item('Q4', { instanceOf: ['Q2175765'] }), // tram stop only
    item('Q5', { labels: { en: 'House', pl: 'Kamienica', zh: null }, sitelinks: 1 }),
    item('Q6', { lat: 50.06015, labels: { en: null, pl: 'kamienica!', zh: null }, sitelinks: 3 }), // 16.6 m away: merged, wins
    item('Q7', { lat: 50.0605, labels: { en: null, pl: 'Kamienica', zh: null } }), // 55 m away: kept
    item('Q8', { labels: { en: 'Only English', pl: null, zh: '只有' } }),
  ];
  const r = mergePois({ items, tour: tour([stop('Q1')]), wikiPages: { en: { Q5: {} } } });
  const ids = r.pois.map((p) => p.id);
  assert.deepEqual(ids, ['poi_wd_Q1', 'poi_wd_Q6', 'poi_wd_Q7', 'poi_wd_Q8']);
  assert.deepEqual(r.excluded, { city: 1, outsideBox: 1, noName: 1, transitOnly: 1 });
  assert.deepEqual(r.merged, [{ kept: 'Q6', dropped: 'Q5', name: 'Kamienica', distM: 16.7 }]);
  const gate = r.pois[0];
  assert.equal(gate.lat, 50.065); // curated tour coordinates, not Wikidata
  assert.deepEqual(gate.names, { en: 'Gate', pl: 'Brama', zh: '门' });
  assert.deepEqual(gate.view, { look: 'up', feature: { en: 'the tower' } });
  assert.equal(gate.triggerRadiusM, 35);
  const p = project(50.065, 19.94);
  assert.deepEqual([gate.x, gate.y], [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
  assert.deepEqual(r.pois[3].names, { en: 'Only English', pl: 'Only English', zh: '只有' });
  assert.equal(r.pois[1].triggerRadiusM, 30);
  assert.equal(r.pois[1].view, undefined);
  assert.throws(() => mergePois({ items: [], tour: tour([stop('Q9')]) }), /tour stops missing/);
});

test('heritage: UNESCO core zone polygon and the smallest register polygon containing the POI', () => {
  const sq = (lng0, lat0, d) => [[[lng0, lat0], [lng0 + d, lat0], [lng0 + d, lat0 + d], [lng0, lat0 + d], [lng0, lat0]]];
  const unesco = { features: [
    { properties: { UNESCO: 'Granice obszaru UNESCO' }, geometry: { type: 'Polygon', coordinates: sq(19.93, 50.05, 0.02) } },
    { properties: { UNESCO: 'Granice strefy buforowej' }, geometry: { type: 'Polygon', coordinates: sq(19.8, 49.9, 0.5) } },
  ] };
  const register = registerIndex({ features: [
    { properties: { FID: 1, NUMER_REJ_: 'A-1, 1931' }, geometry: { type: 'Polygon', coordinates: sq(19.935, 50.055, 0.01) } },
    { properties: { FID: 2, NUMER_REJ_: 'A-2/M' }, geometry: { type: 'Polygon', coordinates: sq(19.939, 50.059, 0.002) } },
    { properties: { FID: 3, NUMER_REJ_: ' ' }, geometry: { type: 'Polygon', coordinates: sq(19.939, 50.059, 0.002) } },
  ] });
  assert.equal(register.size, 2);
  const items = [item('Q1', { lat: 50.06, lng: 19.94 }), item('Q2', { lat: 50.056, lng: 19.936 }), item('Q3', { lat: 50.1, lng: 20.1, heritage: ['Q9259'] })];
  const r = mergePois({ items, tour: tour([]), unesco: unescoCore(unesco), register });
  const h = Object.fromEntries(r.pois.map((p) => [p.id, [p.heritage, p.sourceIds]]));
  assert.deepEqual(h.poi_wd_Q1, [{ registerNo: 'A-2/M', unesco: true }, ['wd_Q1', 'krk_eoz', 'krk_unesco']]);
  assert.deepEqual(h.poi_wd_Q2, [{ registerNo: 'A-1', unesco: true }, ['wd_Q2', 'krk_eoz', 'krk_unesco']]);
  assert.deepEqual(h.poi_wd_Q3, [{ unesco: true }, ['wd_Q3']]); // Wikidata P1435 = World Heritage Site
});
