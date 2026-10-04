// Tests for 20-fetch-osm-tiles.mjs: the tiling must reproduce the lead's committed tiles exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allTiles, gzipWithMtime, kazimierzTiles, parseBounds, sameBbox, osmStats, tileUrl, tiles } from './20-fetch-osm-tiles.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { MAP_AREAS } from './60-mapdata.mjs';
import { rawPath } from './lib/http.mjs';

test('tiles(): 3x3 grid, row-major from the south-west, existing file names', () => {
  const t = tiles();
  assert.equal(t.length, 9);
  assert.deepEqual(t[0], { n: 1, rel: 'osm/oldtown-tile1.osm.gz', bbox: [19.929, 50.0525, 19.935, 50.0575] });
  assert.deepEqual(t[2].bbox, [19.941, 50.0525, 19.947, 50.0575]);
  assert.deepEqual(t[3].bbox, [19.929, 50.0575, 19.935, 50.0625]);
  assert.deepEqual(t[8], { n: 9, rel: 'osm/oldtown-tile9.osm.gz', bbox: [19.941, 50.0625, 19.947, 50.0675] });
});

test('tileUrl uses the OSM API map call with lon,lat,lon,lat at 4 decimals', () => {
  assert.equal(tileUrl([19.929, 50.0525, 19.935, 50.0575]), 'https://api.openstreetmap.org/api/0.6/map?bbox=19.9290,50.0525,19.9350,50.0575');
});

test('parseBounds / sameBbox / osmStats', () => {
  const xml = '<osm><bounds minlat="50.0525000" minlon="19.9290000" maxlat="50.0575000" maxlon="19.9350000"/>' +
    '<node id="1" timestamp="2026-01-01T00:00:00Z"/><node id="2" timestamp="2026-10-02T21:09:38Z"/><way id="3"/></osm>';
  const b = parseBounds(xml);
  assert.deepEqual(b, [19.929, 50.0525, 19.935, 50.0575]);
  assert.ok(sameBbox(b, tiles()[0].bbox));
  assert.ok(!sameBbox(b, tiles()[1].bbox));
  assert.equal(parseBounds('<osm/>'), null);
  assert.deepEqual(osmStats(xml), { nodes: 2, ways: 1, relations: 0, newestEdit: '2026-10-02T21:09:38Z' });
});

test('kazimierzTiles(): the row south of the Old Town plus one tile east of tile 3, on the same grid', () => {
  const k = kazimierzTiles();
  assert.equal(k.length, 5);
  assert.deepEqual(k[0], { n: 1, rel: 'osm/kazimierz-tile1.osm.gz', bbox: [19.929, 50.0475, 19.935, 50.0525] });
  assert.deepEqual(k[3].bbox, [19.947, 50.0475, 19.953, 50.0525]);
  assert.deepEqual(k[4], { n: 5, rel: 'osm/kazimierz-tile5.osm.gz', bbox: [19.947, 50.0525, 19.953, 50.0575] });
  assert.equal(allTiles().length, 14);
  assert.equal(new Set(allTiles().map((t) => t.rel)).size, 14);
});

test('committed tiles: every map area file exists and its <bounds> match the tiling', () => {
  const byRel = new Map(allTiles().map((t) => [t.rel, t]));
  for (const [area, rels] of Object.entries(MAP_AREAS)) {
    for (const rel of rels) {
      assert.ok(byRel.has(rel), `${area}: ${rel} is not a tile of 20-fetch-osm-tiles.mjs`);
      const p = rawPath(rel);
      assert.ok(existsSync(p), `missing data/raw/${rel}`);
      const head = gunzipSync(readFileSync(p)).toString('utf8', 0, 600);
      assert.ok(sameBbox(parseBounds(head), byRel.get(rel).bbox), `${rel} bounds`);
    }
  }
});

test('gzipWithMtime stores the fetch time in the gzip header and stays valid gzip', () => {
  const gz = gzipWithMtime(Buffer.from('<osm/>'), Date.UTC(2026, 9, 3, 21, 20, 5, 900));
  assert.equal(new Date(gz.readUInt32LE(4) * 1000).toISOString(), '2026-10-03T21:20:05.000Z');
  assert.equal(gunzipSync(gz).toString(), '<osm/>');
});

test('committed Kazimierz tiles carry their fetch time (gzip MTIME)', () => {
  for (const t of kazimierzTiles()) {
    const ms = readFileSync(rawPath(t.rel)).readUInt32LE(4) * 1000;
    assert.ok(ms > Date.UTC(2026, 9, 3), `${t.rel} has no gzip MTIME`);
  }
});
