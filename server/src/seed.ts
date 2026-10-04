// Boot-time seeding of DATA_DIR from the image (server/README.md "How the course data reaches the disk").
// SEED_DIR holds the signed metadata written by `npm run publish-course -- --seed seed` (committed: public, signed,
// no secrets): catalog.json, courses/<id>/{manifest,allowed}.json, tts-index.json (shipped clips only).
// SEED_FILES_DIR holds the course files copied into the image: the repo's data/course, one folder per course id, so the
// files of course <id> are read from SEED_FILES_DIR/<id>/ (manifest file paths are relative to it: packs/<packId>/...,
// audio/...). When SEED_FILES_DIR/<id>/ does not exist, SEED_FILES_DIR itself is that course's root (the older
// single-course image, which copied data/course/krakow). On boot:
//   - catalog and course files are copied when missing or different (the image = the latest publish);
//   - every manifest file missing from blobs/ is copied from SEED_FILES_DIR after its sha256 is verified;
//   - seed tts-index entries are merged into the disk's index (runtime-rendered entries are kept).
// City packs (publish-city): SEED_DIR/cities/<cityId>/manifest.json is copied the same way, and its files are read from
// SEED_CITY_FILES_DIR/<cityId>/ (the repo's data/city; manifest paths are relative to the city root: city.json,
// pois.json, narrations/<lang>.json, ...), with the same fallback (no <cityId>/ folder = SEED_CITY_FILES_DIR is the root).
// The private key is never in the image: the envelopes were signed on the maintainer's machine.
import { existsSync, statSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { sha256Hex } from './canonical.js';
import { COURSE_ID_RE, DataStore, SHA256_RE, TtsIndex, writeFileAtomic } from './store.js';

interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

async function copyIfChanged(src: string, dst: string): Promise<boolean> {
  const data = await readFile(src);
  if (existsSync(dst) && (await readFile(dst)).equals(data)) {
    return false;
  }
  await writeFileAtomic(dst, data);
  return true;
}

/** The folder that holds course `id`'s files: <filesDir>/<id> (one folder per course), else <filesDir> (one course). */
export function courseFilesRoot(filesDir: string | undefined, id: string): string | undefined {
  if (!filesDir) {
    return undefined;
  }
  const perCourse = join(filesDir, id);
  return existsSync(perCourse) && statSync(perCourse).isDirectory() ? perCourse : filesDir;
}

/** Copies every file of a seeded manifest that is missing from blobs/ out of `root`, after verifying its sha256. */
async function copyMissingBlobs(store: DataStore, manifestPath: string, root: string | undefined, what: string,
  envName: string): Promise<number> {
  const env = JSON.parse(await readFile(manifestPath, 'utf8')) as { payload?: { files?: ManifestFile[] } };
  let copied = 0;
  for (const f of env.payload?.files ?? []) {
    if (!SHA256_RE.test(f.sha256) || (await store.hasBlob(f.sha256))) {
      continue;
    }
    if (!root || f.path.includes('..') || f.path.startsWith('/')) {
      throw new Error(`seed: ${what} blob ${f.sha256} (${f.path}) missing and no ${envName} to copy it from`);
    }
    const data = await readFile(join(root, f.path));
    if (sha256Hex(data) !== f.sha256) {
      throw new Error(`seed: ${what} file ${f.path} does not match its manifest sha256 (the image and the seed are out of sync)`);
    }
    await store.putBlob(f.sha256, data);
    copied++;
  }
  return copied;
}

export async function seedDataDir(store: DataStore, seedDir: string, filesDir: string | undefined, log: Logger,
  cityFilesDir?: string): Promise<{ metaCopied: number; blobsCopied: number; indexAdded: number }> {
  const out = { metaCopied: 0, blobsCopied: 0, indexAdded: 0 };
  if (!existsSync(join(seedDir, 'catalog.json'))) {
    log.warn({ evt: 'SEED', seedDir }, 'no catalog.json in the seed dir, skipping');
    return out;
  }
  await store.init();
  if (await copyIfChanged(join(seedDir, 'catalog.json'), join(store.dataDir, 'catalog.json'))) {
    out.metaCopied++;
  }
  const coursesDir = join(seedDir, 'courses');
  const ids = existsSync(coursesDir) ? (await readdir(coursesDir)).filter((d) => COURSE_ID_RE.test(d)) : [];
  for (const id of ids) {
    await mkdir(join(store.dataDir, 'courses', id), { recursive: true });
    for (const f of ['manifest.json', 'allowed.json']) {
      const src = join(coursesDir, id, f);
      if (existsSync(src) && (await copyIfChanged(src, join(store.dataDir, 'courses', id, f)))) {
        out.metaCopied++;
      }
    }
    out.blobsCopied += await copyMissingBlobs(store, join(coursesDir, id, 'manifest.json'), courseFilesRoot(filesDir, id),
      `course ${id}`, 'SEED_FILES_DIR');
  }
  const citiesDir = join(seedDir, 'cities');
  const cityIds = existsSync(citiesDir) ? (await readdir(citiesDir)).filter((d) => COURSE_ID_RE.test(d)) : [];
  for (const id of cityIds) {
    const src = join(citiesDir, id, 'manifest.json');
    if (!existsSync(src)) {
      continue;
    }
    await mkdir(join(store.dataDir, 'cities', id), { recursive: true });
    if (await copyIfChanged(src, join(store.dataDir, 'cities', id, 'manifest.json'))) {
      out.metaCopied++;
    }
    out.blobsCopied += await copyMissingBlobs(store, src, courseFilesRoot(cityFilesDir, id), `city ${id}`, 'SEED_CITY_FILES_DIR');
  }
  const idxPath = join(seedDir, 'tts-index.json');
  if (existsSync(idxPath)) {
    const seedIdx = JSON.parse(await readFile(idxPath, 'utf8')) as TtsIndex;
    const add: TtsIndex = {};
    for (const [textSha, e] of Object.entries(seedIdx)) {
      const cur = await store.ttsLookup(textSha);
      // Keep a line already rendered at runtime; add or refresh shipped ones.
      if ((!cur || cur.blob !== e.blob) && !(cur && cur.source === 'runtime')) {
        add[textSha] = e;
      }
    }
    out.indexAdded = Object.keys(add).length;
    if (out.indexAdded > 0) {
      await store.ttsRecordMany(add);
    }
  }
  log.info({ evt: 'SEED', ...out, courses: ids, cities: cityIds }, 'data dir seeded from the image');
  return out;
}
