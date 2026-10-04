// CityTour pack pipeline: the course cover photo (Node 22+ ESM, stdlib only).
//
// Source (committed, curated by hand from Wikimedia Commons, see data/ATTRIBUTION.md "Tour cover photos"):
//   data/course/<courseId>/cover/cover.jpg    1280x800 JPEG (16:10), at most MAX_COVER_BYTES
//   data/course/<courseId>/cover/cover.json   the credit: author, licence, licence URL, Commons page, our changes
// build-pack.sh copies both, byte for byte, into the pack folder (packs/<courseId>/cover.jpg, cover.json). They are
// NOT listed in the pack's manifest.json (so every other pack file stays byte-identical); publish-course signs every
// file of the pack folder into the course manifest and names the cover's sha256 in the catalog (`coverBlob`).
// A course without a cover/ folder simply has no cover (the app shows its map preview instead).

import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const COVER_DIR = 'cover';
export const COVER_JPG = 'cover.jpg';
export const COVER_JSON = 'cover.json';
export const MAX_COVER_BYTES = 250 * 1024;
const LICENSES = new Set(['CC0 1.0', 'Public domain', 'CC BY 2.0', 'CC BY 3.0', 'CC BY 4.0', 'CC BY-SA 2.0', 'CC BY-SA 2.5',
  'CC BY-SA 3.0', 'CC BY-SA 3.0 pl', 'CC BY-SA 4.0']);
const LANGS = ['en', 'pl', 'zh'];

/** Problems of a cover.json record ([] = fine). Attribution must be complete (CC BY-SA: author, licence + URL, source, changes). */
export function checkCoverMeta(m) {
  const errs = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['not an object'];
  if (m.schemaVersion !== 1) errs.push('schemaVersion must be 1');
  if (m.file !== COVER_JPG) errs.push(`file must be ${COVER_JPG}`);
  for (const k of ['author', 'license', 'licenseUrl', 'sourceTitle', 'sourceUrl', 'publisher', 'changes', 'retrievedAt']) {
    if (typeof m[k] !== 'string' || m[k].trim() === '') errs.push(`missing ${k}`);
  }
  if (typeof m.author === 'string' && m.author.length > 80) errs.push('author longer than 80 chars');
  if (typeof m.license === 'string' && !LICENSES.has(m.license)) errs.push(`licence ${m.license} is not an allowed reuse licence`);
  if (typeof m.licenseUrl === 'string' && !/^https?:\/\/(creativecommons\.org|commons\.wikimedia\.org)\//.test(m.licenseUrl)) {
    errs.push('licenseUrl must point to creativecommons.org or commons.wikimedia.org');
  }
  if (typeof m.sourceUrl === 'string' && !m.sourceUrl.startsWith('https://commons.wikimedia.org/wiki/File:')) {
    errs.push('sourceUrl must be a Wikimedia Commons file page');
  }
  if (typeof m.retrievedAt === 'string' && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.retrievedAt)) {
    errs.push('retrievedAt must be ISO-8601 UTC');
  }
  if (m.width !== 1280 || m.height !== 800) errs.push('width x height must be 1280 x 800');
  for (const l of LANGS) {
    if (typeof m.subject?.[l] !== 'string' || m.subject[l].trim() === '') errs.push(`missing subject.${l}`);
  }
  return errs;
}

/** Width x height of a baseline/progressive JPEG (SOF0..SOF15 except DHT/JPG/DAC), or null. */
export function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
    }
    i += 2 + len;
  }
  return null;
}

/** The checked cover of a course ({ jpg: Buffer, json: Buffer, meta }) or null when it has none. Throws when it is broken. */
export function readCover(courseDir) {
  const dir = join(courseDir, COVER_DIR);
  const jpgPath = join(dir, COVER_JPG);
  const jsonPath = join(dir, COVER_JSON);
  if (!existsSync(jpgPath) && !existsSync(jsonPath)) return null;
  if (!existsSync(jpgPath) || !existsSync(jsonPath)) throw new Error(`${dir}: needs both ${COVER_JPG} and ${COVER_JSON}`);
  const jpg = readFileSync(jpgPath);
  const json = readFileSync(jsonPath);
  const meta = JSON.parse(json.toString('utf8'));
  const errs = checkCoverMeta(meta);
  const size = jpegSize(jpg);
  if (!size) errs.push(`${COVER_JPG} is not a JPEG`);
  else if (size.width !== meta.width || size.height !== meta.height) errs.push(`${COVER_JPG} is ${size.width}x${size.height}, cover.json says ${meta.width}x${meta.height}`);
  if (jpg.length > MAX_COVER_BYTES) errs.push(`${COVER_JPG} is ${jpg.length} bytes (max ${MAX_COVER_BYTES})`);
  if (errs.length) throw new Error(`${dir}: ${errs.join('; ')}`);
  return { jpg, json, meta };
}

/** Copies the course's cover into the pack folder (or removes a stale one). Returns the cover or null. */
export function copyCover(courseDir, packDir) {
  const cover = readCover(courseDir);
  for (const f of [COVER_JPG, COVER_JSON]) {
    const dst = join(packDir, f);
    if (cover) copyFileSync(join(courseDir, COVER_DIR, f), dst);
    else rmSync(dst, { force: true });
  }
  return cover;
}
