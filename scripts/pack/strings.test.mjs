// B10 key parity for the app's UI strings: every locale file app/src/i18n/<locale>.json (iOS port of the HarmonyOS
// entry/src/main/resources/<locale>/element/string.json; en is the base)
// has exactly the base keys (none missing, none extra, no duplicates, no empty values), and each value keeps the
// base value's format placeholders (%s, %d, %1$s, ...), so $r('app.string.x', args) formats the same in en, pl and zh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'src', 'i18n');
const REQUIRED = ['pl', 'zh'];

function load(dir) {
  const doc = JSON.parse(readFileSync(join(RES, `${dir === 'base' ? 'en' : dir}.json`), 'utf8'));
  return Object.entries(doc).map(([name, value]) => ({ name, value }));
}

/** Sorted placeholder tokens of a value: '%1$s', '%d', ... ('%%' is a literal percent, not a placeholder). */
export function placeholders(value) {
  return (value.replace(/%%/g, '').match(/%(\d+\$)?[sd]/g) ?? []).sort();
}

const base = load('base');
const baseMap = new Map(base.map((s) => [s.name, s.value]));
const locales = readdirSync(RES).filter((f) => f.endsWith('.json') && f !== 'en.json' && existsSync(join(RES, f)))
  .map((f) => f.replace(/\.json$/, ''));

test('placeholders(): positional and plain tokens, %% ignored', () => {
  assert.deepEqual(placeholders('%1$d h %2$d min'), ['%1$d', '%2$d']);
  assert.deepEqual(placeholders('~%s · 100%%'), ['%s']);
  assert.deepEqual(placeholders('no args'), []);
});

test('base has unique, non-empty keys', () => {
  assert.equal(baseMap.size, base.length, 'duplicate key in base');
  for (const s of base) {
    assert.ok(s.value.trim().length > 0, `base: empty value for ${s.name}`);
  }
});

test('every required UI locale exists', () => {
  for (const l of REQUIRED) {
    assert.ok(locales.includes(l), `missing app/src/i18n/${l}.json`);
  }
});

for (const loc of locales) {
  test(`${loc}: same keys as base, no duplicates, no empty values`, () => {
    const strings = load(loc);
    const names = strings.map((s) => s.name);
    assert.equal(new Set(names).size, names.length, `${loc}: duplicate key`);
    const missing = [...baseMap.keys()].filter((k) => !names.includes(k));
    const extra = names.filter((k) => !baseMap.has(k));
    assert.deepEqual(missing, [], `${loc}: missing keys`);
    assert.deepEqual(extra, [], `${loc}: keys not in base`);
    for (const s of strings) {
      assert.ok(s.value.trim().length > 0, `${loc}: empty value for ${s.name}`);
    }
  });

  test(`${loc}: placeholders match base`, () => {
    for (const s of load(loc)) {
      if (baseMap.has(s.name)) {
        assert.deepEqual(placeholders(s.value), placeholders(baseMap.get(s.name)), `${loc}: placeholders of ${s.name}`);
      }
    }
  });
}
