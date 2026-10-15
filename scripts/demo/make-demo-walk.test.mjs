// Tests for make-demo-walk.mjs: the committed SIMULATED Demo walk tracks are current and PLAIN (predictable for a
// live demo): stop 1 first, the stops in the planner's order, one 40 s hold segment at every stop, walking pace, and
// the Royal Route's single scripted moment (the detour) only. Node 22+, stdlib only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts/demo/make-demo-walk.mjs');
const COURSES = ['krakow', 'krakow-scholars', 'krakow-kazimierz'];
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const track = (c) => JSON.parse(read(`data/course/${c}/demo-walk.json`));

test('the committed tracks are current (run: node scripts/demo/make-demo-walk.mjs [--course ID])', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'demo-walk-'));
  try {
    for (const c of COURSES) {
      const out = join(tmp, `${c}.json`);
      execFileSync(process.execPath, [SCRIPT, '--course', c, '--out', out], { stdio: 'pipe' });
      assert.equal(readFileSync(out, 'utf8'), read(`data/course/${c}/demo-walk.json`), c);
      // the course pack ships the same bytes (split-city.mjs copies it into tour/)
      assert.equal(read(`data/course/${c}/tour/demo-walk.json`), read(`data/course/${c}/demo-walk.json`), `${c} tour/`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

for (const c of COURSES) {
  test(`${c}: plain walk - starts at stop 1, one hold segment per stop in planned order`, () => {
    const t = track(c);
    assert.equal(t.simulated, true);
    const n = t.stops.length;
    assert.deepEqual(t.stops.map((s) => s.n), Array.from({ length: n }, (_, i) => i + 1));
    assert.ok(t.stops.every((s) => s.mode === 'dwell'), 'a dwell at every stop');
    // the tour's planned order starts at the tour's fixed start
    const tour = JSON.parse(read(`data/course/${c}/packs/${c}/tours.json`))[0];
    if (tour.fixedStartPoiId) assert.equal(t.stops[0].poiId, tour.fixedStartPoiId);
    assert.deepEqual([...t.stops.map((s) => s.poiId)].sort(), tour.stops.map((s) => s.poiId).sort());
    // hold segments: 1, 2, ..., n, each exactly dwellS samples, nothing else holds
    const segs = [];
    t.fixes.forEach((f, i) => {
      if (f.hold && (i === 0 || !t.fixes[i - 1].hold || t.fixes[i - 1].stop !== f.stop)) segs.push({ stop: f.stop, len: 0 });
      if (f.hold) segs[segs.length - 1].len++;
    });
    assert.deepEqual(segs.map((s) => s.stop), t.stops.map((s) => s.n));
    assert.ok(segs.every((s) => s.len === t.params.dwellS), 'each hold lasts dwellS');
    // the walker starts at stop 1 (no walk before its hold, only the warm-up)
    const firstHold = t.fixes.findIndex((f) => f.hold);
    assert.equal(firstHold, t.params.warmupS);
    assert.ok(t.fixes.slice(0, firstHold).every((f) => f.speedMps < 0.5), 'standing during the warm-up');
  });

  test(`${c}: realistic pace, GPS-like accuracy, order self-check passed`, () => {
    const t = track(c);
    const walking = t.fixes.filter((f) => !f.hold && f.speedMps > 0.5);
    const mean = walking.reduce((a, f) => a + f.speedMps, 0) / walking.length;
    assert.ok(mean > 1.1 && mean < 1.5, `mean walking speed ${mean.toFixed(2)} m/s`);
    assert.ok(t.fixes.every((f) => f.speedMps <= 2.2), 'no running');
    assert.ok(t.fixes.slice(t.params.warmupS).every((f) => f.accuracyM <= 10), 'trigger-grade accuracy');
    for (let i = 1; i < t.fixes.length; i++) assert.equal(t.fixes[i].tRelMs - t.fixes[i - 1].tRelMs, 1000);
    // written only when no later stop's zone is reachable before the planned one (see the script's self-check)
    assert.ok(Number.isFinite(t.summary.minLaterStopClearanceM));
    assert.ok(t.summary.minLaterStopClearanceM >= t.params.orderMarginM);
  });
}

test('krakow: the only scripted moment is the detour between stops 7 and 8', () => {
  const t = track('krakow');
  assert.deepEqual(t.events.map((e) => e.kind), ['warmup', 'detour']);
  const d = t.events[1];
  const s7 = t.stops.find((s) => s.n === 7);
  const s8 = t.stops.find((s) => s.n === 8);
  assert.ok(d.fromMs > s7.departMs && d.toMs < s8.arrivalMs, 'detour on the leg 7 -> 8');
  assert.ok(d.maxOffRouteM >= 50 && d.maxOffRouteM <= 100, `max ${d.maxOffRouteM} m off the route`);
  for (const c of ['krakow-scholars', 'krakow-kazimierz']) {
    assert.deepEqual(track(c).events.map((e) => e.kind), ['warmup'], c);
  }
});
