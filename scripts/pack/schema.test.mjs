// Tests for schema.mjs: the pipeline's copy of contracts/Model.ets must match the ArkTS file exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib/http.mjs';
import { ENUMS, INTERFACES, checkRecord, checkType, fieldsOf } from './schema.mjs';

/** Minimal parser for the declarations in Model.ets (enums with string values, interfaces with fields). */
export function parseModelEts(src) {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const enums = {};
  for (const m of code.matchAll(/export enum (\w+)\s*\{([^}]*)\}/g)) {
    enums[m[1]] = {};
    for (const e of m[2].matchAll(/(\w+)\s*=\s*'([^']*)'/g)) enums[m[1]][e[1]] = e[2];
  }
  const interfaces = {};
  for (const m of code.matchAll(/export interface (\w+)\s*\{([^}]*)\}/g)) {
    interfaces[m[1]] = {};
    for (const f of m[2].matchAll(/(\w+)(\??)\s*:\s*([^;]+);/g)) interfaces[m[1]][f[1] + f[2]] = f[3].trim();
  }
  return { enums, interfaces };
}

const model = parseModelEts(readFileSync(join(REPO_ROOT, 'core/src/contracts/Model.ts'), 'utf8'));

test('every enum and value of Model.ets is mirrored exactly', () => {
  assert.ok(Object.keys(model.enums).length >= 8);
  assert.deepEqual(Object.keys(ENUMS).sort(), Object.keys(model.enums).sort());
  for (const [name, values] of Object.entries(model.enums)) assert.deepEqual(ENUMS[name], values, `enum ${name}`);
});

test('every interface, field, optional marker and type text of Model.ets is mirrored exactly', () => {
  assert.ok(Object.keys(model.interfaces).length >= 24);
  assert.deepEqual(Object.keys(INTERFACES).sort(), Object.keys(model.interfaces).sort());
  for (const [name, fields] of Object.entries(model.interfaces)) assert.deepEqual(INTERFACES[name], fields, `interface ${name}`);
});

test('checkRecord accepts a valid Poi and rejects extra keys, bad enums, missing fields', () => {
  const poi = {
    id: 'poi_wd_Q1', kind: 'gate', lat: 50, lng: 19.9, x: 1.5, y: -2, names: { pl: 'Brama' }, importance: 0.5,
    tier: 'name-only', triggerRadiusM: 30, sourceIds: ['wd_Q1'],
  };
  assert.deepEqual(checkRecord('Poi', poi), []);
  assert.deepEqual(checkRecord('Poi', { ...poi, view: { look: 'up', feature: { en: 'tower' } } }), []);
  assert.match(checkRecord('Poi', { ...poi, review: 'to review' })[0], /review: not a field of Poi/);
  assert.match(checkRecord('Poi', { ...poi, kind: 'tower' })[0], /is not a PoiKind/);
  const { tier, ...noTier } = poi;
  assert.match(checkRecord('Poi', noTier)[0], /tier: required/);
  assert.match(checkRecord('Poi', { ...poi, x: NaN })[0], /finite number/);
  assert.match(checkRecord('Poi', { ...poi, view: { look: 'up', feature: {}, basis: {} } })[0], /basis: not a field of ViewHint/);
});

test('checkType handles nested arrays', () => {
  assert.deepEqual(checkType('number[][]', [[1, 2], [3]]), []);
  assert.equal(checkType('number[][]', [[1, 'x']]).length, 1);
  assert.deepEqual(fieldsOf('TourStop').filter((f) => f.optional).map((f) => f.name), ['triggerRadiusM', 'approachRadiusM']);
});
