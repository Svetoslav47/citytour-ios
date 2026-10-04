// Tests for 60-mapdata.mjs: OSM XML parsing, layer rules, ring assembly, decimetre features.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleRings, buildMapDetail, decodeXml, LAYERS, layerOf, parseOsm, simplifyRing } from './60-mapdata.mjs';
import { ENUMS } from './schema.mjs';
import { projectX, projectY } from './projection.mjs';

const node = (id, lat, lon) => `<node id="${id}" visible="true" version="1" lat="${lat}" lon="${lon}"/>`;
const way = (id, nds, tags) =>
  `<way id="${id}" visible="true">${nds.map((n) => `<nd ref="${n}"/>`).join('')}${Object.entries(tags).map(([k, v]) => `<tag k="${k}" v="${v}"/>`).join('')}</way>`;
const doc = (body, b = [50.06, 19.93, 50.062, 19.94]) =>
  `<?xml version="1.0"?><osm version="0.6"><bounds minlat="${b[0]}" minlon="${b[1]}" maxlat="${b[2]}" maxlon="${b[3]}"/>${body}</osm>`;

test('layers: ids and order are contract values, paths need scale > 1', () => {
  const ids = new Set(Object.values(ENUMS.MapLayerId));
  assert.deepEqual(LAYERS.map((l) => l.id).sort(), [...ids].sort());
  assert.deepEqual(LAYERS.map((l) => l.id), ['water', 'river', 'green', 'unesco', 'buildings', 'paths', 'minor', 'major']);
  assert.equal(LAYERS.find((l) => l.id === 'paths').minScale, 1);
});

test('layerOf rules', () => {
  assert.equal(layerOf({ building: 'yes' }, true), 'buildings');
  assert.equal(layerOf({ building: 'no', highway: 'footway' }, false), 'paths');
  assert.equal(layerOf({ leisure: 'park' }, true), 'green');
  assert.equal(layerOf({ landuse: 'grass' }, false), null);
  assert.equal(layerOf({ natural: 'water', water: 'river' }, true), 'water');
  assert.equal(layerOf({ waterway: 'river' }, false), 'river');
  assert.equal(layerOf({ highway: 'tertiary', name: 'Straszewskiego' }, false), 'major');
  assert.equal(layerOf({ highway: 'pedestrian' }, false), 'minor');
  assert.equal(layerOf({ highway: 'pedestrian', area: 'yes' }, true), null);
  assert.equal(layerOf({ highway: 'steps' }, false), 'paths');
  assert.equal(layerOf({ highway: 'construction' }, false), null);
});

test('decodeXml and parseOsm: entities, dedupe across overlapping tiles, members', () => {
  assert.equal(decodeXml('Plac &quot;Na Groblach&quot; &amp; &#322;&#x105;'), 'Plac "Na Groblach" & łą');
  const a = doc(node(1, 50.06, 19.93) + node(2, 50.061, 19.931) + way(10, [1, 2], { highway: 'primary', name: 'A &amp; B' }));
  const b = doc(node(2, 50.061, 19.931) + way(10, [1, 2], { highway: 'primary', name: 'changed' }) +
    '<relation id="5"><member type="way" ref="10" role="outer"/><tag k="type" v="multipolygon"/></relation>');
  const osm = parseOsm([a, b]);
  assert.equal(osm.nodes.size, 2);
  assert.equal(osm.ways.get('10').tags.name, 'A & B');
  assert.deepEqual(osm.ways.get('10').nds, ['1', '2']);
  assert.deepEqual(osm.relations.get('5').members, [{ type: 'way', ref: '10', role: 'outer' }]);
  assert.equal(osm.bounds.length, 2);
});

test('assembleRings joins and reverses member ways, reports open chains', () => {
  const r = assembleRings([['1', '2', '3'], ['5', '4', '3'], ['5', '1'], ['7', '8']]);
  assert.deepEqual(r.rings, [['1', '2', '3', '4', '5', '1']]);
  assert.equal(r.open, 1);
});

test('simplifyRing drops the repeated first vertex and degenerate rings', () => {
  assert.deepEqual(simplifyRing([0, 0, 10, 0, 10, 10, 0, 10, 0, 0]), [0, 0, 100, 0, 100, 100, 0, 100]);
  assert.equal(simplifyRing([0, 0, 0.01, 0, 0, 0.01, 0, 0]), null);
});

test('buildMapDetail: building with a hole, named major street, unnamed path, bounds in metres', () => {
  const nodes = [
    [1, 50.0600, 19.9300], [2, 50.0600, 19.9310], [3, 50.0610, 19.9310], [4, 50.0610, 19.9300],
    [5, 50.0603, 19.9303], [6, 50.0603, 19.9306], [7, 50.0606, 19.9306], [8, 50.0606, 19.9303],
    [9, 50.0615, 19.9300], [10, 50.0615, 19.9320], [11, 50.0616, 19.9320],
  ];
  const body = nodes.map(([id, lat, lon]) => node(id, lat, lon)).join('') +
    way(100, [1, 2, 3], {}) + way(101, [3, 4, 1], {}) + way(102, [5, 6, 7, 8, 5], {}) +
    way(103, [9, 10], { highway: 'secondary', name: 'Podwale' }) + way(104, [10, 11], { highway: 'footway', name: 'x' }) +
    '<relation id="7"><member type="way" ref="100" role="outer"/><member type="way" ref="101" role="outer"/>' +
    '<member type="way" ref="102" role="inner"/><tag k="type" v="multipolygon"/><tag k="building" v="yes"/></relation>';
  const { map, stats } = buildMapDetail({ osm: parseOsm([doc(body)]), unescoGeojson: { features: [] } });
  assert.equal(map.level, 'detail');
  assert.deepEqual(map.bounds, [
    Math.round(projectX(19.93) * 10) / 10, Math.round(projectY(50.06) * 10) / 10,
    Math.round(projectX(19.94) * 10) / 10, Math.round(projectY(50.062) * 10) / 10,
  ]);
  const layer = (id) => map.layers.find((l) => l.id === id);
  const [bld] = layer('buildings').features;
  assert.deepEqual(bld.rings, [0, 8]);
  assert.equal(bld.c.length, 16);
  assert.ok(bld.c.every(Number.isInteger));
  assert.deepEqual(bld.bb, [Math.min(...bld.c.filter((_, i) => i % 2 === 0)), Math.min(...bld.c.filter((_, i) => i % 2)),
    Math.max(...bld.c.filter((_, i) => i % 2 === 0)), Math.max(...bld.c.filter((_, i) => i % 2))]);
  assert.equal(bld.c[0], Math.round(projectX(19.93) * 10));
  const [street] = layer('major').features;
  assert.equal(street.name, 'Podwale');
  assert.equal(street.rings, undefined);
  assert.equal(layer('paths').features[0].name, undefined);
  assert.equal(stats.relations, 1);
});
