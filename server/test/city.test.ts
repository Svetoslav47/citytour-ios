// City packs (docs/SERVER.md §3.1 "City packs"): publish-city on the real data/city/krakow, publish-course with
// --city-id on the krakow overlay (data/course/krakow/tour), the catalog keeping both lists in either order, the
// city manifest endpoint and boot seeding of cities. Every key here is a throwaway TEST key.
import { generateKeyPairSync, KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pino from 'pino';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { sha256Hex, signPayload, verifyEnvelope } from '../src/canonical.js';
import { createLogger } from '../src/log.js';
import { Catalog, CityManifest, CourseManifest, publishCity, publishCourse } from '../src/publish.js';
import { seedDataDir } from '../src/seed.js';
import { DataStore } from '../src/store.js';
import { CircuitBreaker } from '../src/tts/breaker.js';
import { TtsService } from '../src/tts/service.js';
import { MockSynth, SECRET } from './helpers.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const CITY = join(REPO, 'data/city/krakow');
const COURSE = join(REPO, 'data/course/krakow');
const SYSTEM_LINES = join(REPO, 'scripts/voice/system-lines.mjs');
const AT = '2026-10-04T00:00:00.000Z';
const silent = pino({ level: 'silent' });
const sha = (s: string): string => sha256Hex(Buffer.from(s, 'utf8'));
const readEnv = <T>(p: string): { payload: T; sig: string } => JSON.parse(readFileSync(p, 'utf8'));
const tmp = (p: string): string => mkdtempSync(join(tmpdir(), p));

function keys(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync('ed25519');
}

const cityOpts = (dataDir: string, privateKey: KeyObject, seedDir?: string) => ({
  cityId: 'krakow', packDir: CITY, dataDir, seedDir, privateKey, publishedAt: AT
});
const overlayOpts = (dataDir: string, privateKey: KeyObject, seedDir?: string) => ({
  courseId: 'krakow', packDir: join(COURSE, 'tour'), audioDir: join(COURSE, 'audio'), cityId: 'krakow', dataDir, seedDir,
  privateKey, systemLinesPath: SYSTEM_LINES, publishedAt: AT
});

describe.skipIf(!existsSync(join(CITY, 'manifest.json')))('city packs', () => {
  const { privateKey, publicKey } = keys();
  const data = tmp('citytour-city-');
  const seed = tmp('citytour-cityseed-');
  let cityManifest: CityManifest;

  beforeAll(async () => {
    await publishCity(cityOpts(data, privateKey, seed));
    cityManifest = readEnv<CityManifest>(join(data, 'cities/krakow/manifest.json')).payload;
  }, 60_000);

  it('publish-city: verified blobs, a signed city manifest with city-root paths, a catalog city entry', async () => {
    const env = readEnv<CityManifest>(join(data, 'cities/krakow/manifest.json'));
    expect(verifyEnvelope(env, publicKey)).toBe(true);
    const m = env.payload;
    const packManifest = JSON.parse(readFileSync(join(CITY, 'manifest.json'), 'utf8'));
    expect(m).toMatchObject({ schemaVersion: 1, cityId: 'krakow', packId: 'krakow', version: packManifest.version, publishedAt: AT });
    expect(m.files.map((f) => f.path)).toEqual(['city.json', 'manifest.json', 'map-detail.json', 'narrations/en.json',
      'narrations/pl.json', 'narrations/zh.json', 'pois.json', 'sources.json']);
    for (const f of m.files) {
      const disk = readFileSync(join(CITY, f.path));
      expect(f.sha256).toBe(sha256Hex(disk));
      expect(f.bytes).toBe(disk.length);
      expect(sha256Hex(readFileSync(join(data, 'blobs', f.sha256)))).toBe(f.sha256);
    }
    for (const dir of [data, seed]) {
      const cat = readEnv<Catalog>(join(dir, 'catalog.json'));
      expect(verifyEnvelope(cat, publicKey)).toBe(true);
      expect(cat.payload.courses).toEqual([]);
      expect(cat.payload.cities).toEqual([{ id: 'krakow', version: m.version, names: { en: 'Kraków', pl: 'Kraków', zh: '克拉科夫' },
        places: packManifest.counts.pois, bytes: m.files.reduce((n, f) => n + f.bytes, 0) }]);
      expect(readFileSync(join(dir, 'cities/krakow/manifest.json'), 'utf8')).toBe(readFileSync(join(data, 'cities/krakow/manifest.json'), 'utf8'));
    }
  });

  it('re-publishing an unchanged city writes nothing new and keeps publishedAt (byte-identical manifest)', async () => {
    const before = readFileSync(join(data, 'cities/krakow/manifest.json'));
    const r = await publishCity({ ...cityOpts(data, privateKey), publishedAt: undefined });
    expect(r.blobsWritten).toBe(0);
    expect(readFileSync(join(data, 'cities/krakow/manifest.json')).equals(before)).toBe(true);
    expect(readEnv<Catalog>(join(data, 'catalog.json')).payload.cities).toHaveLength(1);
  });

  it('publish-course --city-id on the krakow overlay: tour/ paths, cityId, city name, city narrations allowed', async () => {
    const r = await publishCourse(overlayOpts(data, privateKey, seed));
    expect(r.clipsNotAllowed).toBe(0);
    const env = readEnv<CourseManifest>(join(data, 'courses/krakow/manifest.json'));
    expect(verifyEnvelope(env, publicKey)).toBe(true);
    const m = env.payload;
    expect(m.cityId).toBe('krakow');
    expect(m.packId).toBe('krakow');
    expect(m.files.some((f) => f.path === 'tour/tours.json')).toBe(true);
    expect(m.files.some((f) => f.path === 'tour/manifest.json')).toBe(true);
    expect(m.files.some((f) => f.path === 'tour/demo-walk.json')).toBe(true);
    expect(m.files.some((f) => f.path === 'tour/cover.jpg')).toBe(true);
    expect(m.files.some((f) => f.path.startsWith('packs/'))).toBe(false);
    expect(m.files.some((f) => f.path === 'tour/map-detail.json')).toBe(false);   // the city's map
    expect(m.files.some((f) => f.path === 'audio/manifest.json')).toBe(true);
    // the allowed set includes a sentence of a place that is only in the city pack (not a stop of the tour)
    const allowed = new Set(JSON.parse(readFileSync(join(data, 'courses/krakow/allowed.json'), 'utf8')) as string[]);
    const tourStops = new Set((JSON.parse(readFileSync(join(COURSE, 'tour/tours.json'), 'utf8')) as { stops: { poiId: string }[] }[])
      .flatMap((t) => t.stops.map((s) => s.poiId)));
    const cityNarr = JSON.parse(readFileSync(join(CITY, 'narrations/pl.json'), 'utf8')) as { poiId: string; sentences: string[] }[];
    const place = cityNarr.find((n) => !tourStops.has(n.poiId) && n.sentences.length > 0);
    expect(place).toBeDefined();
    expect(allowed.has(sha(String(place!.sentences[0])))).toBe(true);
    expect(allowed.has(sha('Welcome! Today\'s walk: The Royal Route.'))).toBe(true);
    expect(r.allowedBreakdown.cityNarration).toBeGreaterThan(1000);
    for (const dir of [data, seed]) {
      const cat = readEnv<Catalog>(join(dir, 'catalog.json'));
      expect(verifyEnvelope(cat, publicKey)).toBe(true);
      expect(cat.payload.cities?.map((c) => c.id)).toEqual(['krakow']);    // publishing a course keeps the cities
      expect(cat.payload.courses).toHaveLength(1);
      expect(cat.payload.courses[0]).toMatchObject({ id: 'krakow', cityId: 'krakow', city: 'Kraków', stops: 11, version: m.version });
      expect(cat.payload.courses[0]?.bytes).toBe(m.files.reduce((n, f) => n + f.bytes, 0));
    }
  }, 120_000);

  it('the overlay + city allow exactly the lines the old full krakow pack allowed', async () => {
    const legacy = tmp('citytour-legacy-');
    await publishCourse({
      courseId: 'krakow', packDir: join(COURSE, 'packs/krakow'), audioDir: join(COURSE, 'audio'), dataDir: legacy, privateKey,
      systemLinesPath: SYSTEM_LINES, city: 'Kraków', publishedAt: AT
    });
    const a = readFileSync(join(legacy, 'courses/krakow/allowed.json'));
    const b = readFileSync(join(data, 'courses/krakow/allowed.json'));
    expect(b.equals(a)).toBe(true);
    // the legacy pack keeps its packs/<id>/ paths
    const m = readEnv<CourseManifest>(join(legacy, 'courses/krakow/manifest.json')).payload;
    expect(m.files.some((f) => f.path === 'packs/krakow/tours.json')).toBe(true);
    expect(m.cityId).toBeUndefined();
  }, 120_000);

  it('publish-course --city-id fails when the city is not published (or signed with another key)', async () => {
    const empty = tmp('citytour-nocity-');
    await expect(publishCourse(overlayOpts(empty, privateKey))).rejects.toThrow(/publish the city first/);
    await expect(publishCourse(overlayOpts(data, keys().privateKey))).rejects.toThrow(/does not verify/);
  });

  it('the catalog keeps both lists when the city is published after a course', async () => {
    const d = tmp('citytour-order-');
    await publishCourse({
      courseId: 'krakow', packDir: join(COURSE, 'packs/krakow'), audioDir: join(COURSE, 'audio'), dataDir: d, privateKey,
      systemLinesPath: SYSTEM_LINES, city: 'Kraków', publishedAt: AT
    });
    expect(readEnv<Catalog>(join(d, 'catalog.json')).payload.cities).toBeUndefined();   // old shape until a city exists
    await publishCity(cityOpts(d, privateKey));
    const cat = readEnv<Catalog>(join(d, 'catalog.json'));
    expect(verifyEnvelope(cat, publicKey)).toBe(true);
    expect(cat.payload.courses.map((c) => c.id)).toEqual(['krakow']);
    expect(cat.payload.cities?.map((c) => c.id)).toEqual(['krakow']);
  }, 120_000);

  it('GET /v1/cities/:id/manifest: 200 signed envelope; 404 for an unknown or bad id; city and course krakow coexist', async () => {
    const store = new DataStore(data);
    await store.init();
    const log = createLogger('silent');
    const app = createApp({
      store, tts: new TtsService(store, new MockSynth(), new CircuitBreaker(), 1000, log), log, tokenSecret: SECRET,
      version: 'test', trustProxy: false, rateInstallsPerHour: 100, rateTtsPer10Min: 100
    });
    const r = await request(app).get('/v1/cities/krakow/manifest').expect(200);
    expect(r.headers['cache-control']).toBe('public, max-age=60, must-revalidate');
    expect(verifyEnvelope(r.body, publicKey)).toBe(true);
    expect(r.body.payload.cityId).toBe('krakow');
    const c = await request(app).get('/v1/courses/krakow/manifest').expect(200);
    expect(c.body.payload.courseId).toBe('krakow');
    for (const bad of ['nowhere', 'Krakow', '..%2Fcourses', '-x', 'a'.repeat(65)]) {
      const res = await request(app).get(`/v1/cities/${bad}/manifest`).expect(404);
      expect(res.body).toEqual({ error: 'not_found' });
    }
    const cat = await request(app).get('/v1/catalog').expect(200);
    expect(verifyEnvelope(cat.body, publicKey)).toBe(true);
    expect(cat.body.payload.cities[0].id).toBe('krakow');
    const pois = cityManifest.files.find((f) => f.path === 'pois.json');
    const blob = await request(app).get(`/v1/blobs/${pois!.sha256}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (x: Buffer) => chunks.push(x));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(sha256Hex(blob.body as Buffer)).toBe(pois!.sha256);
  });

  it('seeding: city manifest + blobs from SEED_CITY_FILES_DIR (per-city folder), idempotent', async () => {
    const fresh = tmp('citytour-cityfresh-');
    const r = await seedDataDir(new DataStore(fresh), seed, join(REPO, 'data/course'), silent, join(REPO, 'data/city'));
    expect(r.blobsCopied).toBeGreaterThan(8);
    expect(readFileSync(join(fresh, 'cities/krakow/manifest.json'), 'utf8')).toBe(readFileSync(join(seed, 'cities/krakow/manifest.json'), 'utf8'));
    for (const f of cityManifest.files) {
      expect(existsSync(join(fresh, 'blobs', f.sha256)), f.path).toBe(true);
    }
    const course = readEnv<CourseManifest>(join(fresh, 'courses/krakow/manifest.json')).payload;
    for (const f of course.files) {
      expect(existsSync(join(fresh, 'blobs', f.sha256)), f.path).toBe(true);
    }
    const r2 = await seedDataDir(new DataStore(fresh), seed, join(REPO, 'data/course'), silent, join(REPO, 'data/city'));
    expect(r2).toEqual({ metaCopied: 0, blobsCopied: 0, indexAdded: 0 });
  }, 120_000);

  it('seeding refuses a city file that does not match its manifest, or a missing SEED_CITY_FILES_DIR', async () => {
    const seedDir = tmp('citytour-cityseedsrc-');
    const files = tmp('citytour-cityfiles-');
    mkdirSync(join(seedDir, 'cities/c1'), { recursive: true });
    mkdirSync(join(files, 'c1'), { recursive: true });
    writeFileSync(join(files, 'c1', 'pois.json'), 'changed');
    writeFileSync(join(seedDir, 'catalog.json'), JSON.stringify(signPayload({ courses: [] }, privateKey)));
    writeFileSync(join(seedDir, 'cities/c1/manifest.json'), JSON.stringify({ payload: { files: [
      { path: 'pois.json', sha256: sha('original'), bytes: 8 }] }, sig: 'x' }));
    await expect(seedDataDir(new DataStore(tmp('citytour-s1-')), seedDir, undefined, silent, files)).rejects.toThrow(/does not match/);
    await expect(seedDataDir(new DataStore(tmp('citytour-s2-')), seedDir, undefined, silent)).rejects.toThrow(/SEED_CITY_FILES_DIR/);
  });
});
