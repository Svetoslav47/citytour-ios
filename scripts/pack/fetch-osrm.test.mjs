// Tests for 50-fetch-osrm.mjs helpers and the committed OSRM snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PAIRS_REL,
  TABLE_REL,
  coordString,
  directedPairs,
  listedOrderTotals,
  sameStops,
  stopsOf,
  stripHints,
} from './50-fetch-osrm.mjs';
import { readSnapshot, readTour } from './lib/http.mjs';

test('directedPairs: n*(n-1) ordered pairs without self-pairs', () => {
  const p = directedPairs(11);
  assert.equal(p.length, 110);
  assert.ok(p.every(([i, j]) => i !== j));
  assert.equal(new Set(p.map(([i, j]) => `${i},${j}`)).size, 110);
  assert.deepEqual(directedPairs(3), [[0, 1], [0, 2], [1, 0], [1, 2], [2, 0], [2, 1]]);
});

test('coordString is lng,lat with 6 decimals joined by ;', () => {
  assert.equal(coordString([{ lat: 50.1, lng: 19.9 }, { lat: 50.0654321, lng: 19.94165556 }]), '19.900000,50.100000;19.941656,50.065432');
});

test('stripHints drops waypoint hints only', () => {
  const r = stripHints({ code: 'Ok', waypoints: [{ hint: 'x', name: 'A', location: [1, 2] }], sources: [{ hint: 'y', distance: 3 }] });
  assert.deepEqual(r, { code: 'Ok', waypoints: [{ name: 'A', location: [1, 2] }], sources: [{ distance: 3 }] });
});

test('sameStops detects moved or reordered stops', () => {
  const a = [{ poiId: 'a', lat: 50, lng: 19 }, { poiId: 'b', lat: 50.1, lng: 19.1 }];
  assert.equal(sameStops(a, a.map((s) => ({ ...s }))), true);
  assert.equal(sameStops(a, [a[1], a[0]]), false);
  assert.equal(sameStops(a, [a[0], { ...a[1], lat: 50.10001 }]), false);
});

test('committed OSRM snapshots match the tour and are complete', () => {
  const stops = stopsOf(readTour());
  const table = readSnapshot(TABLE_REL);
  const pairs = readSnapshot(PAIRS_REL);
  assert.ok(sameStops(table.meta.stops, stops), 'table fetched for other coordinates');
  assert.ok(sameStops(pairs.meta.stops, stops), 'pairs fetched for other coordinates');
  assert.equal(table.response.durations.length, stops.length);
  assert.equal(table.response.distances[0].length, stops.length);
  assert.equal(pairs.routes.length, stops.length * (stops.length - 1));
  for (const r of pairs.routes) {
    assert.equal(r.response.code, 'Ok');
    assert.equal(r.response.routes[0].geometry.type, 'LineString');
    assert.ok(r.response.routes[0].legs[0].steps.length > 0, `${r.from}>${r.to} has no steps`);
  }
  const [d, t] = listedOrderTotals(pairs);
  assert.ok(d > 1500 && d < 3500, `listed order ${d} m`);
  assert.ok(t > 15 * 60 && t < 45 * 60, `listed order ${t} s`);
});
