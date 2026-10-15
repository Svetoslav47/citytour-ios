// Every course other than the default krakow (scripts/pack/lib/course.mjs): its committed pack equals a fresh build,
// it is a pack of its own tour, and every stop has validated Historian stories in en/pl/zh.
// (The default course is covered in detail by pack.test.mjs.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPack, loadInputs, sha256 } from './90-emit.mjs';
import { courseInfo, DEFAULT_COURSE_ID, listTours, readCourseTour } from './lib/course.mjs';
import { RAW_DIR } from './lib/http.mjs';
import { LANGS } from './schema.mjs';

const courses = listTours()
  .filter((t) => t.courseId && t.courseId !== DEFAULT_COURSE_ID)
  .map((t) => courseInfo(t.courseId, t.tourId, t.file))
  .filter((c) => existsSync(join(c.packDir, 'manifest.json')));

for (const c of courses) {
  const built = await buildPack(loadInputs(RAW_DIR, c));
  const file = (p) => JSON.parse(built.files.find((f) => f.path === p).bytes.toString('utf8'));
  const tour = readCourseTour(c);

  test(`${c.courseId}: the committed pack equals a fresh build (scripts/pack/build-pack.sh --course ${c.courseId})`, () => {
    for (const f of built.files) {
      const p = join(c.packDir, f.path);
      assert.ok(existsSync(p), `missing ${f.path}`);
      assert.equal(sha256(readFileSync(p)), sha256(f.bytes), `${f.path} is stale`);
    }
  });

  test(`${c.courseId}: packId, its one tour, a complete routes matrix`, () => {
    assert.equal(built.manifest.packId, c.courseId);
    const tours = file('tours.json');
    assert.equal(tours.length, 1);
    assert.equal(tours[0].id, c.tourId);
    assert.deepEqual(tours[0].stops.map((s) => s.poiId), tour.stops.map((s) => s.poiId));
    const n = tour.stops.length;
    const routes = file('routes.json');
    assert.deepEqual(routes.nodeIds, tour.stops.map((s) => s.poiId));
    assert.equal(routes.legs.length, n * (n - 1));
  });

  test(`${c.courseId}: every stop has a validated grounded-ai teaser and full story in en, pl and zh`, () => {
    for (const lang of LANGS) {
      const byId = new Map(file(`narrations/${lang}.json`).map((x) => [x.id, x]));
      for (const s of tour.stops) {
        for (const length of ['teaser', 'full']) {
          const nar = byId.get(`${s.poiId}:historian:${lang}:${length}`);
          assert.ok(nar, `${s.poiId} ${lang} ${length} missing`);
          assert.equal(nar.tier, 'grounded-ai', `${nar.id} fell back to ${nar.tier}`);
          assert.ok(nar.claims.length > 0, `${nar.id} has no claims`);
          assert.equal(nar.generatedBy.kind, lang === 'en' ? 'llm' : 'mt');
          assert.equal(nar.reviewedBy, undefined, 'no human review in this build');
        }
      }
    }
    const report = file('validation-report.json');
    assert.equal(report.failures.filter((f) => f.tier === 'grounded-ai' || f.tier === 'reviewed').length, 0);
  });
}
