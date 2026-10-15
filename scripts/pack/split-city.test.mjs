// City packs + course overlays (scripts/pack/split-city.mjs): the committed outputs equal a fresh split, the city
// files are byte-identical copies of the source course's full pack, and every overlay carries its tour's stops with
// their narrations and sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOverlay, CITY_COPY, CITY_ROOT, diffDir, LANGS, listTag, readCityMeta, sha256, splitAll, writeDir } from './split-city.mjs';
import { COURSE_ROOT } from './lib/course.mjs';

const { cities, overlays } = splitAll();
const fileOf = (out, p) => out.files.find((f) => f.path === p);
const parse = (out, p) => JSON.parse(fileOf(out, p).bytes.toString('utf8'));
const fullPack = (id) => join(COURSE_ROOT, id, 'packs', id);

test('there is a krakow city pack and an overlay for each krakow course', () => {
  assert.deepEqual(cities.map((c) => c.cityId), ['krakow']);
  assert.deepEqual(overlays.map((o) => o.courseId), ['krakow', 'krakow-kazimierz', 'krakow-scholars']);
  for (const o of overlays) assert.equal(o.cityId, 'krakow');
});

test('the committed city packs and overlays equal a fresh split (node scripts/pack/split-city.mjs)', () => {
  for (const out of [...cities, ...overlays]) assert.deepEqual(diffDir(out.dir, out.files), [], out.dir);
});

test('the split is deterministic', () => {
  const again = splitAll();
  for (const [a, b] of [[cities, again.cities], [overlays, again.overlays]]) {
    assert.equal(a.length, b.length);
    a.forEach((x, i) => {
      assert.deepEqual(x.files.map((f) => f.path), b[i].files.map((f) => f.path));
      x.files.forEach((f, j) => assert.ok(f.bytes.equals(b[i].files[j].bytes), f.path));
    });
  }
});

test('city files are byte-identical to the source course pack; city.json + manifest as specified', () => {
  const c = cities[0];
  const meta = readCityMeta('krakow');
  const src = fullPack(meta.sourceCourse);
  const srcManifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
  for (const p of CITY_COPY) assert.ok(fileOf(c, p).bytes.equals(readFileSync(join(src, p))), p);
  assert.deepEqual(parse(c, 'city.json'), {
    schemaVersion: 1, cityId: 'krakow', names: { en: 'Kraków', pl: 'Kraków', zh: '克拉科夫' },
    origin: srcManifest.origin, bbox: srcManifest.bbox, defaultBounds: [50.0525, 19.929, 50.0675, 19.947],
    properNouns: ['Kraków', 'Krakow', 'Poland', 'Polish', 'Vistula', 'Wawel', 'Rynek', 'Royal Route', 'Jagiellonian'],
  });
  assert.deepEqual(parse(c, 'city.json').properNouns, meta.properNouns);
  const m = c.manifest;
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.packId, 'krakow');
  assert.equal(m.cityId, 'krakow');
  assert.equal(m.builtAt, srcManifest.builtAt);
  assert.deepEqual(m.licenses, srcManifest.licenses);
  assert.deepEqual(m.counts, { pois: srcManifest.counts.pois, narrations_en: srcManifest.counts.narrations_en,
    narrations_pl: srcManifest.counts.narrations_pl, narrations_zh: srcManifest.counts.narrations_zh });
  assert.deepEqual(m.files.map((f) => f.path), ['city.json', ...CITY_COPY].sort());
  assert.match(m.version, /^2026\.10\.03-[0-9a-f]{8}$/);
  assert.equal(m.version.slice(-8), listTag(m.files));
});

test('manifests: every listed file has the right bytes and sha256; nothing else but cover.* is unlisted', () => {
  for (const out of [...cities, ...overlays]) {
    const m = JSON.parse(fileOf(out, 'manifest.json').bytes.toString('utf8'));
    assert.deepEqual(m, out.manifest);
    for (const e of m.files) {
      const f = fileOf(out, e.path);
      assert.ok(f, `${out.dir}: ${e.path} listed but not generated`);
      assert.equal(e.bytes, f.bytes.length, e.path);
      assert.equal(e.sha256, sha256(f.bytes), e.path);
    }
    const unlisted = out.files.map((f) => f.path).filter((p) => p !== 'manifest.json' && !m.files.some((e) => e.path === p));
    assert.deepEqual(unlisted.filter((p) => !p.startsWith('cover.')), [], out.dir);
  }
});

for (const o of overlays) {
  test(`${o.courseId} overlay: tour files copied, every stop + its narrations (en/pl/zh) + referenced sources`, () => {
    const src = fullPack(o.courseId);
    for (const p of ['tours.json', 'routes.json', 'personas.json']) assert.ok(fileOf(o, p).bytes.equals(readFileSync(join(src, p))), p);
    const tours = parse(o, 'tours.json');
    const stops = tours.flatMap((t) => t.stops.map((s) => s.poiId));
    const pois = parse(o, 'pois.json');
    assert.deepEqual(pois.map((p) => p.id).sort(), [...new Set(stops)].sort());
    // same records, same order as the full pack
    const full = JSON.parse(readFileSync(join(src, 'pois.json'), 'utf8'));
    assert.deepEqual(pois, full.filter((p) => stops.includes(p.id)));
    const sourceIds = new Set(parse(o, 'sources.json').map((s) => s.id));
    const fullSources = new Set(JSON.parse(readFileSync(join(src, 'sources.json'), 'utf8')).map((s) => s.id));
    const refs = new Set(pois.flatMap((p) => p.sourceIds));
    for (const lang of LANGS) {
      const narr = parse(o, `narrations/${lang}.json`);
      const fullNarr = JSON.parse(readFileSync(join(src, `narrations/${lang}.json`), 'utf8'));
      assert.deepEqual(narr, fullNarr.filter((n) => stops.includes(n.poiId)), lang);
      for (const id of stops) {
        for (const length of ['teaser', 'full']) assert.ok(narr.some((n) => n.id === `${id}:historian:${lang}:${length}`), `${id} ${lang} ${length}`);
      }
      for (const n of narr) {
        for (const s of n.sources) refs.add(s);
        for (const c of n.claims ?? []) refs.add(c.sourceId);
      }
      assert.equal(o.manifest.counts[`narrations_${lang}`], narr.length);
    }
    for (const id of refs) if (fullSources.has(id)) assert.ok(sourceIds.has(id), `source ${id} missing`);
    for (const id of sourceIds) assert.ok(refs.has(id), `source ${id} not referenced`);
    assert.equal(o.manifest.counts.pois, pois.length);
    assert.equal(o.manifest.counts.legs, JSON.parse(readFileSync(join(src, 'routes.json'), 'utf8')).legs.length);
    const pm = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
    assert.match(o.manifest.version, new RegExp(`^${pm.version.replace(/\./g, '\\.')}-t[0-9a-f]{8}$`));
    assert.ok(o.manifest.version.length <= 40);
    assert.equal(o.manifest.packId, o.courseId);
    assert.equal(o.manifest.cityId, 'krakow');
    for (const k of ['builtAt', 'origin', 'bbox', 'licenses']) assert.deepEqual(o.manifest[k], pm[k], k);
  });

  test(`${o.courseId} overlay: own map only when it differs from the city's; demo walk and cover copied`, () => {
    const src = fullPack(o.courseId);
    const cityMap = readFileSync(join(CITY_ROOT, 'krakow', 'map-detail.json'));
    const own = readFileSync(join(src, 'map-detail.json'));
    assert.equal(Boolean(fileOf(o, 'map-detail.json')), !own.equals(cityMap));
    const walk = join(COURSE_ROOT, o.courseId, 'demo-walk.json');
    assert.equal(Boolean(fileOf(o, 'demo-walk.json')), existsSync(walk));
    if (existsSync(walk)) assert.ok(fileOf(o, 'demo-walk.json').bytes.equals(readFileSync(walk)));
    for (const f of ['cover.jpg', 'cover.json']) {
      if (existsSync(join(src, f))) assert.ok(fileOf(o, f).bytes.equals(readFileSync(join(src, f))), f);
      assert.ok(!o.manifest.files.some((e) => e.path === f));
    }
  });
}

test('only krakow-kazimierz keeps its own map', () => {
  assert.deepEqual(overlays.filter((o) => fileOf(o, 'map-detail.json')).map((o) => o.courseId), ['krakow-kazimierz']);
});

test('no demo-walk.json in the overlay when the course has none; writeDir removes stale files', () => {
  const root = mkdtempSync(join(tmpdir(), 'split-city-'));
  mkdirSync(join(root, 'krakow-scholars'));
  symlinkSync(join(COURSE_ROOT, 'krakow-scholars', 'packs'), join(root, 'krakow-scholars', 'packs'), 'dir');
  const cityMap = readFileSync(join(CITY_ROOT, 'krakow', 'map-detail.json'));
  const o = buildOverlay('krakow-scholars', 'krakow', cityMap, { courseRoot: root });
  assert.ok(!o.files.some((f) => f.path === 'demo-walk.json'));
  assert.ok(!o.manifest.files.some((f) => f.path === 'demo-walk.json'));
  const withWalk = overlays.find((x) => x.courseId === 'krakow-scholars');
  assert.notEqual(o.manifest.version, withWalk.manifest.version);
  const out = join(root, 'out');
  writeDir(out, withWalk.files);
  assert.deepEqual(diffDir(out, withWalk.files), []);
  writeDir(out, o.files);
  assert.deepEqual(diffDir(out, o.files), []);
  assert.ok(!existsSync(join(out, 'demo-walk.json')));
});
