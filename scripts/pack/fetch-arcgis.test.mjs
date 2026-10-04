// Tests for the pure helpers of 10-fetch-arcgis.mjs and a sanity check of the committed snapshots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAYERS, licenceStatus, pageOffsets, queryParams, stripHtml } from './10-fetch-arcgis.mjs';
import { findSnapshot, readSnapshot } from './lib/http.mjs';

test('pageOffsets covers every record, at least one page', () => {
  assert.deepEqual(pageOffsets(0, 1000), [0]);
  assert.deepEqual(pageOffsets(395, 1000), [0]);
  assert.deepEqual(pageOffsets(1000, 1000), [0]);
  assert.deepEqual(pageOffsets(2001, 1000), [0, 1000, 2000]);
});

test('queryParams asks for every field as GeoJSON in WGS-84, ordered and paged', () => {
  const q = new URLSearchParams(queryParams('FID', 2000, 1000));
  assert.equal(q.get('where'), '1=1');
  assert.equal(q.get('outFields'), '*');
  assert.equal(q.get('f'), 'geojson');
  assert.equal(q.get('outSR'), '4326');
  assert.equal(q.get('orderByFields'), 'FID ASC');
  assert.equal(q.get('resultOffset'), '2000');
  assert.equal(q.get('resultRecordCount'), '1000');
});

test('licenceStatus is UNVERIFIED unless the item publishes terms', () => {
  assert.equal(licenceStatus({ licenseInfo: '', accessInformation: null }), 'UNVERIFIED');
  assert.equal(licenceStatus({ licenseInfo: '<p>CC BY 4.0</p>' }), 'CC BY 4.0');
  assert.equal(stripHtml('<b>a</b>&nbsp; b'), 'a b');
});

test('committed ArcGIS snapshots exist and match their recorded counts', () => {
  for (const L of LAYERS) {
    const rel = `arcgis/${L.slug}.geojson`;
    assert.ok(findSnapshot(rel), `missing data/raw/${rel}`);
    const fc = readSnapshot(rel);
    assert.equal(fc.type, 'FeatureCollection');
    assert.equal(fc.features.length, fc.meta.count, rel);
    assert.match(fc.meta.retrievedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  }
  assert.equal(readSnapshot('arcgis/pomnik.geojson').features.length, 395);
});
