// publish-course on the real Kraków pack (into a temp dir) and boot seeding from server/seed/.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { sha256Hex, verifyEnvelope } from '../src/canonical.js';
import { courseVersion, CourseManifest, publishCourse, readCover } from '../src/publish.js';
import { seedDataDir } from '../src/seed.js';
import { DataStore } from '../src/store.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const RAW = join(REPO, 'data/course/krakow');
const SYSTEM_LINES = join(REPO, 'scripts/voice/system-lines.mjs');
const silent = pino({ level: 'silent' });
const sha = (s: string): string => sha256Hex(Buffer.from(s, 'utf8'));

describe('publishCourse (krakow)', () => {
  it('writes verified blobs, a signed manifest + catalog, the allowed set and pre-seeded shipped clips', async () => {
    const data = mkdtempSync(join(tmpdir(), 'citytour-pub-'));
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const r = await publishCourse({
      courseId: 'krakow', packDir: join(RAW, 'packs/krakow'), audioDir: join(RAW, 'audio'), dataDir: data,
      privateKey, systemLinesPath: SYSTEM_LINES, city: 'Kraków', publishedAt: '2026-10-03T00:00:00.000Z'
    });
    const env = JSON.parse(readFileSync(join(data, 'courses/krakow/manifest.json'), 'utf8'));
    expect(verifyEnvelope(env, publicKey)).toBe(true);
    const m = env.payload as CourseManifest;
    expect(m.packId).toBe('krakow');
    expect(m.files.some((f) => f.path === 'packs/krakow/tours.json')).toBe(true);
    expect(m.files.some((f) => f.path === 'audio/manifest.json')).toBe(true);
    expect(m.files.filter((f) => f.path.endsWith('.mp3'))).toHaveLength(m.audio.clips);
    for (const f of m.files.slice(0, 50)) {
      expect(sha256Hex(readFileSync(join(data, 'blobs', f.sha256)))).toBe(f.sha256);
    }
    const allowedBytes = readFileSync(join(data, 'courses/krakow/allowed.json'));
    expect(sha256Hex(allowedBytes)).toBe(m.allowedTtsSha);
    const allowed = new Set(JSON.parse(allowedBytes.toString('utf8')) as string[]);
    // system, numeric (every bucket edge, every direction) and narration lines in en/pl/zh
    for (const t of [
      'Welcome! Today\'s walk: The Royal Route.', 'Witaj! Dzisiejsza trasa: Droga Królewska.',
      'In about 100 metres, ahead on your left: Barbican.', 'In about 500 metres: Barbican.',
      'Next stop: Barbican, about 60 minutes from here.', 'Barbican is about 6 minutes behind you, on the left.',
      'Barbakan: około 450 metrów, za Tobą.'
    ]) {
      expect(allowed.has(sha(t)), t).toBe(true);
    }
    expect(allowed.has(sha('Next stop: Barbican, about 61 minutes from here.'))).toBe(false);
    expect(allowed.has(sha('Read me the news.'))).toBe(false);
    const narr = JSON.parse(readFileSync(join(RAW, 'packs/krakow/narrations/zh.json'), 'utf8')) as { sentences: string[] }[];
    expect(allowed.has(sha(String(narr[0]?.sentences[0])))).toBe(true);
    expect(r.clipsNotAllowed).toBe(0);
    const cat = JSON.parse(readFileSync(join(data, 'catalog.json'), 'utf8'));
    expect(verifyEnvelope(cat, publicKey)).toBe(true);
    expect(cat.payload.courses[0]).toMatchObject({ id: 'krakow', city: 'Kraków', stops: 11,
      title: { en: 'The Royal Route', pl: 'Droga Królewska', zh: '皇家之路' }, langs: ['en', 'pl', 'zh'] });
    // cover photo: signed into the manifest, named in the catalog (coverBlob + credit), served as a blob, and part of
    // the version (adding or changing it is an update)
    const coverSha = sha256Hex(readFileSync(join(RAW, 'packs/krakow/cover.jpg')));
    expect(m.files.find((f) => f.path === 'packs/krakow/cover.jpg')?.sha256).toBe(coverSha);
    expect(m.files.some((f) => f.path === 'packs/krakow/cover.json')).toBe(true);
    expect(existsSync(join(data, 'blobs', coverSha))).toBe(true);
    expect(cat.payload.courses[0].coverBlob).toBe(coverSha);
    expect(cat.payload.courses[0].coverCredit).toBe('Jakub Hałun, CC BY-SA 4.0');
    expect(m.version).toMatch(/-a[0-9a-f]{8}-c[0-9a-f]{8}$/);
    expect(cat.payload.courses[0].version).toBe(m.version);
    const idx = JSON.parse(readFileSync(join(data, 'tts-index.json'), 'utf8'));
    const audio = JSON.parse(readFileSync(join(RAW, 'audio/manifest.json'), 'utf8')) as {
      clips: { textSha256: string; file: string }[];
    };
    const c0 = audio.clips[0];
    expect(c0).toBeDefined();
    expect(idx[c0!.textSha256].source).toBe('shipped');
    expect(idx[c0!.textSha256].blob).toBe(sha256Hex(readFileSync(join(RAW, c0!.file))));
  }, 60_000);
});

describe('cover photo', () => {
  it('courseVersion adds -c<tag> only with a cover', () => {
    expect(courseVersion('2026.10.03-41e1482c', 'f'.repeat(64))).toBe('2026.10.03-41e1482c-affffffff');
    expect(courseVersion('2026.10.03-41e1482c', 'f'.repeat(64), '0123abcd')).toBe('2026.10.03-41e1482c-affffffff-c0123abcd');
  });

  it('readCover: none, both files, or an error for half a cover / a credit without author', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'citytour-cover-'));
    expect(await readCover(dir)).toBeUndefined();
    writeFileSync(join(dir, 'cover.jpg'), 'jpeg-bytes');
    await expect(readCover(dir)).rejects.toThrow(/both/);
    writeFileSync(join(dir, 'cover.json'), JSON.stringify({ license: 'CC BY-SA 4.0' }));
    await expect(readCover(dir)).rejects.toThrow(/author/);
    writeFileSync(join(dir, 'cover.json'), JSON.stringify({ author: 'A. Author', license: 'CC BY 4.0' }));
    const c = await readCover(dir);
    expect(c).toMatchObject({ sha: sha('jpeg-bytes'), credit: 'A. Author, CC BY 4.0' });
    expect(c?.versionTag).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('seedDataDir (server/seed + data/course + data/city, as in the Docker image)', () => {
  const seed = join(REPO, 'server/seed');

  it.skipIf(!existsSync(join(seed, 'catalog.json')))('the committed seed matches the repo files and seeds an empty disk', async () => {
    const data = mkdtempSync(join(tmpdir(), 'citytour-seed-'));
    const store = new DataStore(data);
    // The Docker image layout: every course under data/course/<id>/, every city under data/city/<id>/.
    const courses = join(REPO, 'data/course');
    const cities = join(REPO, 'data/city');
    const r = await seedDataDir(store, seed, courses, silent, cities);   // throws if any file no longer matches its sha256
    expect(r.blobsCopied).toBeGreaterThan(1000);
    expect(r.indexAdded).toBeGreaterThan(1000);
    // idempotent: a second boot copies nothing
    const r2 = await seedDataDir(new DataStore(data), seed, courses, silent, cities);
    expect(r2).toEqual({ metaCopied: 0, blobsCopied: 0, indexAdded: 0 });
  }, 120_000);

  it('refuses a seed whose files do not match (stale image)', async () => {
    const data = mkdtempSync(join(tmpdir(), 'citytour-seed-'));
    const seedDir = mkdtempSync(join(tmpdir(), 'citytour-seedsrc-'));
    const files = mkdtempSync(join(tmpdir(), 'citytour-files-'));
    writeFileSync(join(files, 'a.json'), 'changed');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(seedDir, 'courses/c1'), { recursive: true });
    writeFileSync(join(seedDir, 'catalog.json'), '{"payload":{"courses":[]},"sig":"x"}');
    writeFileSync(join(seedDir, 'courses/c1/manifest.json'), JSON.stringify({ payload: { files: [
      { path: 'a.json', sha256: sha('original'), bytes: 8 }] }, sig: 'x' }));
    await expect(seedDataDir(new DataStore(data), seedDir, files, silent)).rejects.toThrow(/does not match/);
  });
});
