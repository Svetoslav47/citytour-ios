// Tests for 80-validate.mjs (validator spec v1) and the shared fixture scripts/pack/fixtures/validator-cases.json,
// which task B3 ports to the app's NarrationValidator.ets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHECK_IDS,
  VALIDATOR_VERSION,
  applicableChecks,
  buildReport,
  langMatches,
  properNounCandidates,
  removeNames,
  selectNarration,
  validateNarration,
} from './80-validate.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/validator-cases.json', import.meta.url), 'utf8'));

test('fixture: at least 14 app-shared cases, none uses sourceTexts, every check id is exercised', () => {
  assert.equal(fixture.validatorVersion, VALIDATOR_VERSION);
  assert.ok(fixture.cases.length >= 14);
  const firstFailed = new Set();
  for (const c of fixture.cases) {
    assert.equal(c.ctx.sourceTexts, undefined, `${c.name}: claims_quote is pipeline-only`);
    for (const k of ['name', 'narration', 'ctx', 'expectOk', 'expectFirstFailed']) assert.ok(k in c, `${c.name}: missing ${k}`);
    if (c.expectFirstFailed) firstFailed.add(c.expectFirstFailed);
  }
  for (const id of CHECK_IDS.filter((x) => x !== 'claims_quote')) assert.ok(firstFailed.has(id), `no case fails first on ${id}`);
});

for (const c of fixture.cases) {
  test(`fixture case: ${c.name}`, () => {
    const r = validateNarration(c.narration, c.ctx);
    assert.equal(r.ok, c.expectOk);
    assert.equal(r.firstFailed, c.expectFirstFailed);
    if (c.expectFailed) assert.deepEqual(r.failed, c.expectFailed);
  });
}

const ok = fixture.cases[0].narration;
const ctx = fixture.cases[0].ctx;

test('claims_quote runs only with ctx.sourceTexts and checks substrings of the stored text', () => {
  assert.ok(!applicableChecks(ok, ctx).includes('claims_quote'));
  const texts = { wp_en_Q807309: 'The Barbican was built around 1498 as a fortified outpost.' };
  assert.equal(validateNarration(ok, { ...ctx, sourceTexts: texts }).ok, false); // 2nd quote is not verbatim
  texts.wp_en_Q807309 += ' It is one of the few remaining fortified outposts in Europe.';
  assert.equal(validateNarration(ok, { ...ctx, sourceTexts: texts }).ok, true);
  assert.equal(validateNarration(ok, { ...ctx, sourceTexts: {} }).firstFailed, 'claims_quote');
  assert.equal(validateNarration(ok, { ...ctx, sourceTexts: new Map(Object.entries(texts)) }).ok, true);
});

test('applicable checks per tier', () => {
  const t = (tier, lang = 'en') => applicableChecks({ ...ok, tier, lang }, ctx);
  assert.deepEqual(t('reviewed'), ['schema', 'length', 'sentence_length', 'total_chars', 'lang', 'numbers', 'proper_nouns', 'forbidden']);
  assert.deepEqual(t('reviewed', 'zh'), ['schema', 'length', 'sentence_length', 'total_chars', 'lang', 'numbers', 'forbidden']);
  assert.deepEqual(t('source-extract'), ['schema', 'extract_size', 'total_chars', 'lang', 'forbidden']);
  assert.deepEqual(t('name-only'), ['schema', 'total_chars', 'forbidden']);
  const mt = { ...ok, tier: 'source-extract', generatedBy: { kind: 'mt', at: 'x', translatedFrom: 'en' } };
  assert.ok(applicableChecks(mt, { ...ctx, translatedFromTier: 'reviewed' }).includes('numbers'));
  assert.ok(!applicableChecks(mt, ctx).includes('numbers'));
});

test('lang heuristics and helpers', () => {
  assert.equal(langMatches('This is the gate of the city.', 'en'), true);
  assert.equal(langMatches('To jest brama miasta, która stoi od wieków.', 'pl'), true);
  assert.equal(langMatches('这是城门。', 'zh'), true);
  assert.equal(langMatches('   ', 'en'), false);
  assert.equal(removeNames('Brama Floriańska stoi.', ['Brama', 'Brama Floriańska']).trim(), 'stoi.');
  assert.deepEqual(properNounCandidates('The Barbican’s walls near "Kraków", [p300] Old Town 1498 Éire.'), ['Barbican’s', 'Kraków', 'Old', 'Town', 'Éire']);
});

test('selectNarration: first passing candidate wins; fallback records the failed checks', () => {
  const bad = { ...ok, sentences: ['The Barbican is on your left, built around 1498 near the city.', ok.sentences[1]] };
  const extract = {
    ...ok, tier: 'source-extract', claims: [], reviewedBy: undefined, generatedBy: { kind: 'extract', at: '2026-10-03T14:01:44Z' },
    sentences: ['The Barbican is a fortified outpost that was once connected to the city walls.'],
  };
  delete extract.reviewedBy;
  const pass = selectNarration([extract], ctx);
  assert.equal(pass.narration.validation.status, 'pass');
  assert.deepEqual(pass.narration.validation.checks, ['schema', 'extract_size', 'total_chars', 'lang', 'forbidden']);
  const fb = selectNarration([bad, extract], ctx);
  assert.equal(fb.narration.tier, 'source-extract');
  assert.deepEqual(fb.narration.validation, { status: 'fallback', checks: ['forbidden'], validatorVersion: 1 });
  const none = selectNarration([bad], ctx);
  assert.equal(none.narration, null);

  const report = buildReport([
    { id: 'b', attempts: fb.attempts, narration: fb.narration },
    { id: 'a', attempts: pass.attempts, narration: pass.narration },
    { id: 'c', attempts: none.attempts, narration: null },
  ]);
  assert.deepEqual(report.summary, {
    narrations: 2, pass: 1, fallback: 1, dropped: 1, rejectedCandidates: 2,
    failuresByCheck: { ...Object.fromEntries(CHECK_IDS.map((id) => [id, 0])), forbidden: 2 },
  });
  assert.equal(report.counts.en['source-extract'], 2);
  assert.deepEqual(report.dropped, ['c']);
  assert.deepEqual(report.failures.map((f) => [f.id, f.firstFailed, f.emittedTier]), [['b', 'forbidden', 'source-extract'], ['c', 'forbidden', null]]);
});
