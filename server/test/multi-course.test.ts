// Two courses (krakow + krakow-scholars) published one after the other into one temp DATA_DIR and seed dir with a
// TEST key: the signed catalog lists both, both manifests verify, the HTTP API serves both, and a fresh disk is
// seeded from a per-course files root (data/course/<id>/), as the Docker image does.
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { sha256Hex, verifyEnvelope } from '../src/canonical.js';
import { createLogger } from '../src/log.js';
import { CourseManifest, publishCourse } from '../src/publish.js';
import { courseFilesRoot, seedDataDir } from '../src/seed.js';
import { DataStore } from '../src/store.js';
import { CircuitBreaker } from '../src/tts/breaker.js';
import { TtsService } from '../src/tts/service.js';
import { MockSynth, SECRET } from './helpers.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const SYSTEM_LINES = join(REPO, 'scripts/voice/system-lines.mjs');
const SCHOLARS_PACK = join(REPO, 'data/course/krakow-scholars/packs/krakow-scholars');
const silent = pino({ level: 'silent' });

/** A course root like data/course/: krakow -> the repo's course; krakow-scholars -> its pack + rendered or empty audio. */
function courseRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'citytour-courses-'));
  symlinkSync(join(REPO, 'data/course/krakow'), join(root, 'krakow'), 'dir');
  const sch = join(root, 'krakow-scholars');
  mkdirSync(join(sch, 'packs'), { recursive: true });
  cpSync(SCHOLARS_PACK, join(sch, 'packs', 'krakow-scholars'), { recursive: true });
  const rendered = join(REPO, 'data/course/krakow-scholars/audio');
  if (existsSync(join(rendered, 'manifest.json'))) {
    cpSync(rendered, join(sch, 'audio'), { recursive: true });
  } else {
    // Not rendered yet (the lead renders the studio voice): a course can be published with no clips.
    mkdirSync(join(sch, 'audio'), { recursive: true });
    writeFileSync(join(sch, 'audio', 'manifest.json'), JSON.stringify({ schemaVersion: 1, clips: [] }));
  }
  return root;
}

describe.skipIf(!existsSync(join(SCHOLARS_PACK, 'manifest.json')))('two courses: krakow + krakow-scholars', () => {
  it('publishes both into one data dir; catalog lists both; both manifests verify; API + seeding serve both', async () => {
    const root = courseRoot();
    const data = mkdtempSync(join(tmpdir(), 'citytour-pub2-'));
    const seed = mkdtempSync(join(tmpdir(), 'citytour-seed2-'));
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');   // a TEST key, never the lead's
    const publish = (courseId: string) => publishCourse({
      courseId, packDir: join(root, courseId, 'packs', courseId), audioDir: join(root, courseId, 'audio'),
      dataDir: data, seedDir: seed, privateKey, systemLinesPath: SYSTEM_LINES, city: 'Kraków',
      publishedAt: '2026-10-03T00:00:00.000Z'
    });
    const k = await publish('krakow');
    const s = await publish('krakow-scholars');
    expect(k.clipsNotAllowed).toBe(0);
    expect(s.clipsNotAllowed).toBe(0);

    // catalog: both courses, signed, sorted by id
    for (const dir of [data, seed]) {
      const cat = JSON.parse(readFileSync(join(dir, 'catalog.json'), 'utf8'));
      expect(verifyEnvelope(cat, publicKey)).toBe(true);
      expect(cat.payload.courses.map((c: { id: string }) => c.id)).toEqual(['krakow', 'krakow-scholars']);
      expect(cat.payload.courses[1]).toMatchObject({
        id: 'krakow-scholars', city: 'Kraków', stops: 10, minutes: 52, km: 2.2, langs: ['en', 'pl', 'zh'],
        title: { en: 'Scholars and Saints', pl: 'Uczeni i święci', zh: '学者与圣徒' }
      });
      expect(cat.payload.courses[0]).toMatchObject({ id: 'krakow', stops: 11, title: { en: 'The Royal Route' } });
    }

    // both manifests verify and list their own pack
    for (const [id, packId] of [['krakow', 'krakow'], ['krakow-scholars', 'krakow-scholars']] as const) {
      const env = JSON.parse(readFileSync(join(data, 'courses', id, 'manifest.json'), 'utf8'));
      expect(verifyEnvelope(env, publicKey)).toBe(true);
      const m = env.payload as CourseManifest;
      expect(m.courseId).toBe(id);
      expect(m.packId).toBe(packId);
      expect(m.files.some((f) => f.path === `packs/${packId}/tours.json`)).toBe(true);
      expect(m.files.some((f) => f.path === 'audio/manifest.json')).toBe(true);
      for (const f of m.files.filter((x) => x.path.startsWith('packs/'))) {
        expect(sha256Hex(readFileSync(join(data, 'blobs', f.sha256)))).toBe(f.sha256);
      }
      const allowed = readFileSync(join(data, 'courses', id, 'allowed.json'));
      expect(sha256Hex(allowed)).toBe(m.allowedTtsSha);
    }
    // the scholars allowed set has its own welcome line and story sentences, not the Royal Route's
    const sha = (t: string): string => sha256Hex(Buffer.from(t, 'utf8'));
    const allowedOf = (id: string) => new Set(JSON.parse(readFileSync(join(data, 'courses', id, 'allowed.json'), 'utf8')) as string[]);
    const schAllowed = allowedOf('krakow-scholars');
    expect(schAllowed.has(sha('Welcome! Today\'s walk: Scholars and Saints.'))).toBe(true);
    expect(schAllowed.has(sha('Welcome! Today\'s walk: The Royal Route.'))).toBe(false);
    expect(allowedOf('krakow').has(sha('Welcome! Today\'s walk: The Royal Route.'))).toBe(true);
    const en = JSON.parse(readFileSync(join(SCHOLARS_PACK, 'narrations/en.json'), 'utf8')) as { id: string; sentences: string[] }[];
    const story = en.find((n) => n.id === 'poi_wd_Q616675:historian:en:full');
    expect(story).toBeDefined();
    expect(schAllowed.has(sha(String(story!.sentences[0])))).toBe(true);

    // HTTP: catalog + both manifests (signed envelopes) and a scholars pack blob
    const store = new DataStore(data);
    await store.init();
    const log = createLogger('silent');
    const tts = new TtsService(store, new MockSynth(), new CircuitBreaker(), 1000, log);
    const app = createApp({
      store, tts, log, tokenSecret: SECRET, version: 'test', trustProxy: false, rateInstallsPerHour: 100, rateTtsPer10Min: 100
    });
    const cat = await request(app).get('/v1/catalog').expect(200);
    expect(verifyEnvelope(cat.body, publicKey)).toBe(true);
    expect(cat.body.payload.courses).toHaveLength(2);
    for (const id of ['krakow', 'krakow-scholars']) {
      const r = await request(app).get(`/v1/courses/${id}/manifest`).expect(200);
      expect(verifyEnvelope(r.body, publicKey)).toBe(true);
      expect(r.body.payload.courseId).toBe(id);
    }
    const toursFile = (JSON.parse(readFileSync(join(data, 'courses/krakow-scholars/manifest.json'), 'utf8')).payload as CourseManifest)
      .files.find((f) => f.path === 'packs/krakow-scholars/tours.json');
    const blob = await request(app).get(`/v1/blobs/${toursFile!.sha256}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(JSON.parse((blob.body as Buffer).toString('utf8'))[0].id).toBe('scholars-saints');

    // seeding a fresh disk from the seed dir + a per-course files root (Docker: COPY data/course ./seed-files)
    expect(courseFilesRoot(root, 'krakow-scholars')).toBe(join(root, 'krakow-scholars'));
    expect(courseFilesRoot(join(root, 'krakow'), 'krakow')).toBe(join(root, 'krakow'));   // older single-course image
    const fresh = mkdtempSync(join(tmpdir(), 'citytour-fresh-'));
    const r = await seedDataDir(new DataStore(fresh), seed, root, silent);
    expect(r.blobsCopied).toBeGreaterThan(20);
    for (const id of ['krakow', 'krakow-scholars']) {
      const m = JSON.parse(readFileSync(join(fresh, 'courses', id, 'manifest.json'), 'utf8')).payload as CourseManifest;
      for (const f of m.files) {
        expect(existsSync(join(fresh, 'blobs', f.sha256)), `${id} ${f.path}`).toBe(true);
      }
    }
  }, 180_000);
});
