// Course cover photos (scripts/pack/lib/cover.mjs): complete attribution, the right size, and the copy in each pack.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCoverMeta, copyCover, jpegSize, MAX_COVER_BYTES, readCover } from './lib/cover.mjs';
import { courseInfo, listTours } from './lib/course.mjs';

const good = () => ({
  schemaVersion: 1, file: 'cover.jpg', width: 1280, height: 800,
  subject: { en: 'Wawel', pl: 'Wawel', zh: '瓦维尔' },
  author: 'Jakub Hałun', license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0',
  sourceTitle: 'File:X.jpg', sourceUrl: 'https://commons.wikimedia.org/wiki/File:X.jpg', publisher: 'Wikimedia Commons',
  changes: 'Cropped', retrievedAt: '2026-10-03T22:01:58Z',
});

// Smallest JPEG header with an SOF0 segment: SOI, SOF0 (len 11, precision 8, height, width, 1 component).
function fakeJpeg(w, h) {
  const b = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9]);
  return b;
}

test('checkCoverMeta: a complete record passes; missing credit fields, non-reuse licences and bad URLs fail', () => {
  assert.deepEqual(checkCoverMeta(good()), []);
  for (const k of ['author', 'license', 'licenseUrl', 'sourceUrl', 'changes']) {
    const m = good();
    delete m[k];
    assert.ok(checkCoverMeta(m).some((e) => e.includes(k)), k);
  }
  assert.ok(checkCoverMeta({ ...good(), license: 'All rights reserved' }).some((e) => e.includes('licence')));
  assert.ok(checkCoverMeta({ ...good(), sourceUrl: 'https://example.com/x.jpg' }).length > 0);
  assert.ok(checkCoverMeta({ ...good(), subject: { en: 'x' } }).some((e) => e.includes('subject.pl')));
  assert.ok(checkCoverMeta({ ...good(), width: 1600 }).length > 0);
  assert.deepEqual(checkCoverMeta(null), ['not an object']);
});

test('jpegSize reads the SOF dimensions; non-JPEG bytes give null', () => {
  assert.deepEqual(jpegSize(fakeJpeg(1280, 800)), { width: 1280, height: 800 });
  assert.equal(jpegSize(Buffer.from('not a jpeg')), null);
});

test('readCover/copyCover: no cover folder = null and a stale pack copy is removed; a half cover throws', () => {
  const root = mkdtempSync(join(tmpdir(), 'cover-'));
  const course = join(root, 'course');
  const pack = join(root, 'pack');
  mkdirSync(pack, { recursive: true });
  writeFileSync(join(pack, 'cover.jpg'), 'stale');
  assert.equal(copyCover(course, pack), null);
  assert.equal(existsSync(join(pack, 'cover.jpg')), false);
  mkdirSync(join(course, 'cover'), { recursive: true });
  writeFileSync(join(course, 'cover', 'cover.jpg'), fakeJpeg(1280, 800));
  assert.throws(() => readCover(course), /needs both/);
  writeFileSync(join(course, 'cover', 'cover.json'), JSON.stringify(good()));
  const c = copyCover(course, pack);
  assert.equal(c.meta.author, 'Jakub Hałun');
  assert.deepEqual(readFileSync(join(pack, 'cover.jpg')), fakeJpeg(1280, 800));
  writeFileSync(join(course, 'cover', 'cover.jpg'), fakeJpeg(1600, 1000));
  assert.throws(() => readCover(course), /1600x1000/);
});

const courses = listTours().filter((t) => t.courseId).map((t) => courseInfo(t.courseId, t.tourId, t.file));
for (const c of courses) {
  if (!existsSync(join(c.courseDir, 'cover'))) continue;
  test(`${c.courseId}: committed cover is valid, at most ${MAX_COVER_BYTES} bytes, copied byte for byte into the pack and not in manifest.json`, () => {
    const cover = readCover(c.courseDir);
    assert.ok(cover);
    assert.deepEqual(readFileSync(join(c.packDir, 'cover.jpg')), cover.jpg, 'run scripts/pack/build-pack.sh --course ' + c.courseId);
    assert.deepEqual(readFileSync(join(c.packDir, 'cover.json')), cover.json);
    const manifest = JSON.parse(readFileSync(join(c.packDir, 'manifest.json'), 'utf8'));
    assert.ok(!manifest.files.some((f) => f.path.startsWith('cover.')), 'the pack manifest stays unchanged');
  });
}
