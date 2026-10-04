// End-to-end tests for the pack build (90-emit.mjs): determinism, the committed pack is up to date, manifest
// integrity, cross-references, size budget, and the fields the app's planner and engine read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPack, builtAtFromSources, DEFAULT_OUT, loadInputs, sha256, tourFromCurated } from './90-emit.mjs';
import { checkRecord, LANGS } from './schema.mjs';
import { project } from './projection.mjs';
import { readTour } from './lib/http.mjs';

const BUDGET_BYTES = 15 * 1024 * 1024;
const inputs = loadInputs();
const first = await buildPack(inputs); // with the B7 hook (70-narrate.mjs), exactly as build-pack.sh
const file = (p) => JSON.parse(first.files.find((f) => f.path === p).bytes.toString('utf8'));

test('builtAt comes from SOURCES.md (newest timestamp), never the clock', () => {
  assert.equal(builtAtFromSources('a 2026-10-03T13:24:08Z b 2026-10-03T14:11:07Z c 2026-10-03T12:06:48Z'), '2026-10-03T14:11:07Z');
  assert.throws(() => builtAtFromSources('nothing'), /no retrieval timestamps/);
  assert.equal(first.manifest.builtAt, builtAtFromSources(readFileSync(join(import.meta.dirname, '../../data/raw/SOURCES.md'), 'utf8')));
});

test('two builds are byte-identical', async () => {
  const second = await buildPack(inputs);
  assert.deepEqual(second.files.map((f) => [f.path, sha256(f.bytes)]), first.files.map((f) => [f.path, sha256(f.bytes)]));
});

test('the committed pack equals a fresh build (run scripts/pack/build-pack.sh after changing data or pipeline)', (t) => {
  if (!existsSync(join(DEFAULT_OUT, 'manifest.json'))) return t.skip('no committed pack');
  for (const f of first.files) {
    const p = join(DEFAULT_OUT, f.path);
    assert.ok(existsSync(p), `missing ${f.path}`);
    assert.equal(sha256(readFileSync(p)), sha256(f.bytes), `${f.path} is stale`);
  }
});

test('manifest: schema, every pack file with bytes + sha256 (not the report), counts, bbox, size budget', () => {
  const m = first.manifest;
  assert.deepEqual(checkRecord('PackManifest', m), []);
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.packId, 'krakow');
  assert.deepEqual(m.origin, { lat: 50.06143, lng: 19.93658 });
  const listed = m.files.map((f) => f.path);
  assert.deepEqual(listed, first.files.map((f) => f.path).filter((p) => p !== 'manifest.json' && p !== 'validation-report.json'));
  assert.deepEqual(listed, ['map-detail.json', 'narrations/en.json', 'narrations/pl.json', 'narrations/zh.json', 'personas.json',
    'pois.json', 'routes.json', 'sources.json', 'tours.json']);
  for (const f of m.files) {
    const b = first.files.find((x) => x.path === f.path).bytes;
    assert.equal(f.bytes, b.length);
    assert.equal(f.sha256, sha256(b));
  }
  const pois = file('pois.json');
  assert.equal(m.counts.pois, pois.length);
  for (const l of LANGS) assert.equal(m.counts[`narrations_${l}`], file(`narrations/${l}.json`).length);
  assert.equal(m.counts.legs, 110);
  assert.ok(pois.every((p) => p.lat >= m.bbox[0] && p.lng >= m.bbox[1] && p.lat <= m.bbox[2] && p.lng <= m.bbox[3]));
  const total = first.files.reduce((s, f) => s + f.bytes.length, 0);
  assert.ok(total <= BUDGET_BYTES, `pack is ${total} bytes`);
});

test('POIs: all of Kraków, unique ids, projected x/y, every source resolves, tour stops curated', () => {
  const pois = file('pois.json');
  const sources = new Set(file('sources.json').map((s) => s.id));
  assert.ok(pois.length > 3000, `${pois.length} POIs`);
  assert.equal(new Set(pois.map((p) => p.id)).size, pois.length);
  for (const p of pois) {
    assert.ok(p.names.pl, `${p.id} has no pl name`);
    const xy = project(p.lat, p.lng);
    assert.ok(Math.abs(p.x - xy.x) <= 0.05 && Math.abs(p.y - xy.y) <= 0.05, p.id);
    assert.ok(p.importance >= 0 && p.importance <= 1);
    for (const id of p.sourceIds) assert.ok(sources.has(id), `${p.id} -> ${id}`);
  }
  const byId = new Map(pois.map((p) => [p.id, p]));
  for (const s of readTour().stops) {
    const p = byId.get(s.poiId);
    assert.ok(p, s.poiId);
    assert.deepEqual([p.lat, p.lng, p.kind, p.triggerRadiusM], [s.lat, s.lng, s.kind, s.triggerRadiusM]);
    assert.deepEqual(p.view, { look: s.view.look, feature: s.view.feature });
    // B7 Historian scripts: reviewed once a human approved the EN file, else an AI draft (grounded-ai).
    assert.ok(['reviewed', 'grounded-ai'].includes(p.tier), `${p.id} tier ${p.tier}`);
  }
});

test('tours.json: contract keys only, stops reference POIs, review metadata dropped', () => {
  const [tour] = file('tours.json');
  assert.deepEqual(tour, tourFromCurated(readTour()));
  assert.deepEqual(checkRecord('Tour', tour), []);
  const text = JSON.stringify(tour);
  for (const k of ['$comment', 'summariesReview', 'coordinatesConfirmedBy', 'radiiNote', 'coordinateCheck', 'basis', 'review', '"n"']) {
    assert.ok(!text.includes(k), k);
  }
  assert.equal(tour.stops.length, 11);
  assert.equal(tour.fixedStartPoiId, tour.stops[0].poiId);
  assert.equal(tour.fixedEndPoiId, tour.stops[10].poiId);
});

test('narrations: one teaser per POI per language, a full for every tour stop, all validated', () => {
  const pois = file('pois.json');
  const stops = readTour().stops.map((s) => s.poiId);
  const sources = new Set(file('sources.json').map((s) => s.id));
  for (const lang of LANGS) {
    const list = file(`narrations/${lang}.json`);
    assert.ok(list.every((n) => n.lang === lang));
    const ids = new Set(list.map((n) => n.id));
    for (const p of pois) assert.ok(ids.has(`${p.id}:historian:${lang}:teaser`), `${p.id} ${lang} teaser`);
    for (const s of stops) {
      const full = list.find((n) => n.id === `${s}:historian:${lang}:full`);
      assert.ok(full, `${s} ${lang} full`);
    }
    for (const n of list) {
      assert.ok(['pass', 'fallback'].includes(n.validation.status));
      assert.equal(n.validation.validatorVersion, 1);
      for (const id of n.sources) assert.ok(sources.has(id));
    }
  }
  const report = JSON.parse(first.files.find((f) => f.path === 'validation-report.json').bytes.toString('utf8'));
  assert.equal(report.summary.narrations, first.counts.narrations_en + first.counts.narrations_pl + first.counts.narrations_zh);
  assert.equal(report.summary.dropped, 0);
});

test('routes.json works with core/route/Planner.ets: nodeIds are POIs, square matrices, a leg per ordered pair', () => {
  const routes = file('routes.json');
  const poiIds = new Set(file('pois.json').map((p) => p.id));
  assert.ok(routes.nodeIds.every((id) => poiIds.has(id)));
  const n = routes.nodeIds.length;
  assert.ok(routes.durationsS.length === n && routes.distancesM.every((r) => r.length === n));
  assert.equal(routes.legs.length, n * (n - 1));
  assert.ok(routes.detourFactor > 1);
});

test('map-detail.json: all 8 layers, decimetre ints, Old Town extent', () => {
  const map = file('map-detail.json');
  assert.deepEqual(checkRecord('MapData', map), []);
  assert.equal(map.layers.length, 8);
  for (const l of map.layers) for (const f of l.features) assert.ok(f.c.every(Number.isInteger) && f.bb.every(Number.isInteger));
  const count = (id) => map.layers.find((l) => l.id === id).features.length;
  assert.ok(count('buildings') > 1000 && count('paths') > 500 && count('unesco') === 1);
  const wawel = project(50.054, 19.9354);
  assert.ok(wawel.x >= map.bounds[0] && wawel.x <= map.bounds[2] && wawel.y >= map.bounds[1] && wawel.y <= map.bounds[3]);
});
