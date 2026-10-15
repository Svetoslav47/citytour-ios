// Tests for scripts/pack/lib/course.mjs (node:test, stdlib only).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { courseFromArgv, DEFAULT_COURSE_ID, listTours, resolveCourse, takeCourseArgs } from './lib/course.mjs';
import { REPO_ROOT } from './lib/http.mjs';

test('no flag = the default course krakow with the original raw paths', () => {
  const c = resolveCourse();
  assert.equal(c.courseId, DEFAULT_COURSE_ID);
  assert.equal(c.tourId, 'royal-route');
  assert.equal(c.packId, 'krakow');
  assert.equal(c.packDir, join(REPO_ROOT, 'data/course/krakow/packs/krakow'));
  assert.equal(c.audioDir, join(REPO_ROOT, 'data/course/krakow/audio'));
  assert.equal(c.reviewDir, join(REPO_ROOT, 'scripts/pack/review/krakow'));
  assert.equal(c.rawRel('osrm/stops-table-foot.json'), 'osrm/stops-table-foot.json');
  assert.equal(c.sourcesMd, null);
  assert.equal(resolveCourse({ tour: 'royal-route' }).packDir, resolveCourse({ course: 'krakow' }).packDir);
});

test('another course: tour file names its courseId, raw snapshots under data/raw/tours/<tourId>/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'course-test-'));
  try {
    writeFileSync(join(dir, 'royal-route.json'), JSON.stringify({ id: 'royal-route' }));
    writeFileSync(join(dir, 'x-walk.json'), JSON.stringify({ id: 'x-walk', courseId: 'krakow-x' }));
    writeFileSync(join(dir, 'orphan.json'), JSON.stringify({ id: 'orphan' }));
    assert.deepEqual(listTours(dir).map((t) => [t.tourId, t.courseId]), [['orphan', null], ['royal-route', 'krakow'], ['x-walk', 'krakow-x']]);
    const c = resolveCourse({ course: 'krakow-x' }, { toursDir: dir });
    assert.equal(c.tourId, 'x-walk');
    assert.equal(c.packDir, join(REPO_ROOT, 'data/course/krakow-x/packs/krakow-x'));
    assert.equal(c.rawRel('wiki/stops-text-en.json'), 'tours/x-walk/wiki/stops-text-en.json');
    assert.equal(c.sourcesMd, join(REPO_ROOT, 'data/raw/tours/x-walk/SOURCES.md'));
    assert.equal(resolveCourse({ tour: 'x-walk' }, { toursDir: dir }).courseId, 'krakow-x');
    assert.throws(() => resolveCourse({ course: 'krakow', tour: 'x-walk' }, { toursDir: dir }), /belongs to course krakow-x/);
    assert.throws(() => resolveCourse({ course: 'nope' }, { toursDir: dir }), /unknown course nope/);
    assert.throws(() => resolveCourse({ course: '../etc' }, { toursDir: dir }), /lowercase id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takeCourseArgs / courseFromArgv keep the other arguments in order', () => {
  assert.deepEqual(takeCourseArgs(['--out', 'x', '--course', 'krakow', '--tour=royal-route']),
    { course: 'krakow', tour: 'royal-route', rest: ['--out', 'x'] });
  assert.throws(() => takeCourseArgs(['--course']), /needs a value/);
  assert.throws(() => takeCourseArgs(['--course', '--out']), /needs a value/);
  const { course, rest } = courseFromArgv(['a.md', '--course', 'krakow']);
  assert.equal(course.tourId, 'royal-route');
  assert.deepEqual(rest, ['a.md']);
});
