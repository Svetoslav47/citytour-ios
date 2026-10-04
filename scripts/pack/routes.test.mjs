// Tests for 65-routes.mjs: OSRM -> RouteData (what core/route/Planner.ets and the turn-by-turn tracker read).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoutes, legFromOsrm, maneuverOf, median } from './65-routes.mjs';
import { ENUMS } from './schema.mjs';
import { haversineM, project } from './projection.mjs';
import { readSnapshot, readTour } from './lib/http.mjs';

test('maneuver mapping covers the contract enum and folds the rest into other', () => {
  const values = new Set(Object.values(ENUMS.Maneuver));
  for (const t of ['depart', 'arrive', 'turn', 'continue', 'new name', 'fork', 'end of road', 'roundabout']) assert.equal(maneuverOf(t), t);
  assert.equal(maneuverOf('rotary'), 'roundabout');
  assert.equal(maneuverOf('exit roundabout'), 'roundabout');
  assert.equal(maneuverOf('merge'), 'other');
  assert.equal(maneuverOf('notification'), 'other');
  for (const t of ['merge', 'on ramp', 'use lane', 'rotary']) assert.ok(values.has(maneuverOf(t)));
});

test('median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

test('legFromOsrm keeps maneuver vertices through simplification and maps geomIndex to the new vertex list', () => {
  // A straight line with collinear points and a turn at the 4th point.
  const coords = [[19.94, 50.06], [19.9401, 50.06], [19.9402, 50.06], [19.9403, 50.06], [19.9403, 50.0601], [19.9403, 50.0602]];
  const response = {
    code: 'Ok',
    routes: [{
      distance: 43.21, duration: 31.04, geometry: { type: 'LineString', coordinates: coords },
      legs: [{ steps: [
        { maneuver: { type: 'depart', modifier: 'right', location: coords[0] }, name: '', distance: 21.4, duration: 15 },
        { maneuver: { type: 'continue', modifier: 'straight', location: coords[2] }, name: 'Grodzka', distance: 7.1, duration: 5 },
        { maneuver: { type: 'turn', modifier: 'left', location: coords[3] }, name: 'Kanonicza', distance: 22.2, duration: 16 },
        { maneuver: { type: 'arrive', location: coords[5] }, name: 'Kanonicza', distance: 0, duration: 0 },
      ] }],
    }],
  };
  const leg = legFromOsrm('a', 'b', response);
  assert.equal(leg.geometry.length / 2, 4); // 0, 2 (forced), 3 (corner), 5; 1 and 4 dropped
  assert.deepEqual(leg.steps.map((s) => s.geomIndex), [0, 1, 2, 3]);
  assert.deepEqual(leg.steps.map((s) => [s.maneuver, s.modifier, s.streetName]), [
    ['depart', 'right', ''], ['continue', 'straight', 'Grodzka'], ['turn', 'left', 'Kanonicza'], ['arrive', '', 'Kanonicza'],
  ]);
  for (const s of leg.steps) assert.deepEqual([s.x, s.y], [leg.geometry[2 * s.geomIndex], leg.geometry[2 * s.geomIndex + 1]]);
  const p = project(50.06, 19.9401);
  assert.equal(leg.distanceM, 43.2);
  assert.equal(leg.durationS, 31);
  assert.ok(Math.abs(p.x - project(50.06, 19.94).x - 7.17) < 0.1);
  assert.throws(() => legFromOsrm('a', 'b', { code: 'NoRoute' }), /no route/);
});

test('buildRoutes on the committed snapshots: what Planner.ets needs', () => {
  const tour = readTour();
  const r = buildRoutes({ table: readSnapshot('osrm/stops-table-foot.json'), pairs: readSnapshot('osrm/stop-pairs-foot.json'), tour });
  const ids = tour.stops.map((s) => s.poiId);
  assert.deepEqual(r.nodeIds, ids);
  assert.equal(r.durationsS.length, 11);
  assert.ok(r.distancesM.every((row, i) => row.length === 11 && row[i] === 0 && row.every((v) => Number.isFinite(v) && v >= 0)));
  assert.ok(r.detourFactor > 1 && r.detourFactor < 2, `detour ${r.detourFactor}`);
  assert.equal(r.legs.length, 110);
  const seen = new Set(r.legs.map((l) => `${l.fromPoiId}>${l.toPoiId}`));
  for (const a of ids) for (const b of ids) if (a !== b) assert.ok(seen.has(`${a}>${b}`), `${a}>${b}`);
  for (const leg of r.legs) {
    assert.equal(leg.steps[0].maneuver, 'depart');
    assert.equal(leg.steps.at(-1).maneuver, 'arrive');
    assert.equal(leg.steps.at(-1).geomIndex, leg.geometry.length / 2 - 1);
    for (let k = 1; k < leg.steps.length; k++) assert.ok(leg.steps[k].geomIndex >= leg.steps[k - 1].geomIndex);
    for (const s of leg.steps) assert.deepEqual([s.x, s.y], [leg.geometry[2 * s.geomIndex], leg.geometry[2 * s.geomIndex + 1]]);
    for (const v of leg.geometry) assert.equal(v, Math.round(v * 10) / 10);
  }
  // The listed-order legs start within the OSRM snap distance (<= 30 m) of their stop.
  for (let i = 0; i + 1 < ids.length; i++) {
    const leg = r.legs.find((l) => l.fromPoiId === ids[i] && l.toPoiId === ids[i + 1]);
    const s = project(tour.stops[i].lat, tour.stops[i].lng);
    assert.ok(Math.hypot(leg.geometry[0] - s.x, leg.geometry[1] - s.y) < 30, `leg ${i} start`);
  }
  assert.ok(haversineM(tour.stops[0].lat, tour.stops[0].lng, tour.stops[10].lat, tour.stops[10].lng) > 1000);
});
