// Tests for projection.mjs: the projection must equal the app's core/geo/Projection.ets (task A1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  M_PER_DEG_LAT,
  M_PER_DEG_LNG_EQUATOR,
  PACK_ORIGIN_LAT,
  PACK_ORIGIN_LNG,
  bboxOf,
  douglasPeucker,
  douglasPeuckerIndices,
  haversineM,
  pointInPolygon,
  pointInRing,
  project,
  ringArea,
  round1,
  toDm,
  unproject,
} from './projection.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/http.mjs';

const near = (a, e, tol, msg) => assert.ok(Math.abs(a - e) <= tol, `${msg ?? ''} ${a} != ${e} (tol ${tol})`);

test('constants equal docs/ARCHITECTURE.md §3.2 and core/geo/Projection.ets', () => {
  assert.equal(PACK_ORIGIN_LAT, 50.06143);
  assert.equal(PACK_ORIGIN_LNG, 19.93658);
  assert.equal(M_PER_DEG_LNG_EQUATOR, 111320.0);
  assert.equal(M_PER_DEG_LAT, 110574.0);
  // The app's file declares the same literals (it lives on main once A1 is merged; skip if absent).
  let ets = null;
  try {
    ets = readFileSync(join(REPO_ROOT, 'common/src/main/ets/core/geo/Projection.ets'), 'utf8');
  } catch {
    return;
  }
  const lit = (name) => Number(new RegExp(`${name}: number = ([\\d.]+);`).exec(ets)?.[1]);
  assert.equal(lit('PACK_ORIGIN_LAT'), PACK_ORIGIN_LAT);
  assert.equal(lit('PACK_ORIGIN_LNG'), PACK_ORIGIN_LNG);
  assert.equal(lit('M_PER_DEG_LNG_EQUATOR'), M_PER_DEG_LNG_EQUATOR);
  assert.equal(lit('M_PER_DEG_LAT'), M_PER_DEG_LAT);
});

test('reference points: the same numbers GeoMath.test.ets pins (origin, Wawel, Barbican)', () => {
  const o = project(50.06143, 19.93658);
  near(o.x, 0, 1e-9, 'origin x');
  near(o.y, 0, 1e-9, 'origin y');
  const w = project(50.054, 19.9354);
  near(w.x, -84.3271, 0.001, 'Wawel x');
  near(w.y, -821.5648, 0.001, 'Wawel y');
  const b = project(50.0655, 19.9417);
  near(b.x, 365.8939, 0.001, 'Barbican x');
  near(b.y, 450.0362, 0.001, 'Barbican y');
  // the formula written out, in the app's operation order
  const k = Math.cos(50.06143 * Math.PI / 180) * 111320.0;
  assert.equal(b.x, (19.9417 - 19.93658) * k);
  assert.equal(b.y, (50.0655 - 50.06143) * 110574.0);
  // as emitted in the pack (1 decimal)
  assert.deepEqual([round1(w.x), round1(w.y), round1(b.x), round1(b.y)], [-84.3, -821.6, 365.9, 450]);
});

test('unproject round-trips under 1 mm and haversine agrees with the plane within 1 % (as GeoMath.test.ets)', () => {
  for (const [lat, lng] of [[50.054, 19.9354], [50.0655, 19.9417], [50.047, 19.945], [50.072, 19.915]]) {
    const p = project(lat, lng);
    const back = unproject(p.x, p.y);
    assert.ok(haversineM(lat, lng, back.lat, back.lng) < 0.001);
    const plane = Math.hypot(p.x, p.y);
    const sphere = haversineM(PACK_ORIGIN_LAT, PACK_ORIGIN_LNG, lat, lng);
    assert.ok(Math.abs(plane - sphere) / sphere < 0.01, `${plane} vs ${sphere}`);
  }
});

test('round1 / toDm: fixed formatting, no negative zero', () => {
  assert.equal(round1(-0.04), 0);
  assert.ok(!Object.is(round1(-0.04), -0));
  assert.equal(round1(12.345), 12.3);
  assert.equal(toDm(-0.04), 0);
  assert.equal(toDm(1.26), 13);
});

test('douglasPeucker drops collinear points, keeps corners and forced vertices', () => {
  const line = [0, 0, 1, 0.01, 2, 0, 3, 0, 3, 5];
  assert.deepEqual(douglasPeuckerIndices(line, 0.5), [0, 3, 4]);
  assert.deepEqual(douglasPeuckerIndices(line, 0.5, new Set([1])), [0, 1, 3, 4]);
  assert.deepEqual(douglasPeucker([0, 0, 5, 5], 1), [0, 0, 5, 5]);
  // closed ring (first == last) keeps its shape
  const sq = [0, 0, 10, 0, 10, 10, 0, 10, 0, 0];
  assert.deepEqual(douglasPeucker(sq, 0.8), sq);
});

test('ring helpers: area sign, bbox, point in ring / polygon with a hole', () => {
  const outer = [0, 0, 10, 0, 10, 10, 0, 10];
  const hole = [4, 4, 6, 4, 6, 6, 4, 6];
  assert.equal(ringArea(outer), 100);
  assert.equal(ringArea([0, 10, 10, 10, 10, 0, 0, 0]), -100);
  assert.deepEqual(bboxOf(outer), [0, 0, 10, 10]);
  assert.equal(pointInRing(5, 5, outer), true);
  assert.equal(pointInRing(11, 5, outer), false);
  assert.equal(pointInPolygon(5, 5, [outer, hole]), false);
  assert.equal(pointInPolygon(2, 2, [outer, hole]), true);
});
