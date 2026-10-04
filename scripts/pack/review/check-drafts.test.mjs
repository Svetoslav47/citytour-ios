// Tests for scripts/pack/review/check-drafts.mjs (node:test, stdlib only).
// Run: node --test scripts/pack/review/check-drafts.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkCoverage,
  checkReview,
  checkSection,
  main,
  parseReviewFile,
  properNounCandidates,
  reviewFiles,
  loadStops,
  toneHits,
} from './check-drafts.mjs';
import { resolveCourse } from '../lib/course.mjs';

// A self-contained fixture: one fake stop, one fake source text.
const SOURCE_ID = 'wp:en:Test Gate@123';
const SOURCE_TEXT =
  'The Test Gate is a Gothic gate in the Old Town. It was built of red brick in 1400 and guarded the main road. ' +
  'In 1817 the Senate decided to preserve the gate. A stone eagle was carved above the arch by Jan Kowalski.';
const STOP = { poiId: 'poi_test_1', names: { en: 'Test Gate', pl: 'Brama Testowa', zh: '测试门' } };
const ctx = {
  fileName: 'poi_test_1.en.md',
  stops: new Map([[STOP.poiId, STOP]]),
  sources: new Map([[SOURCE_ID, [SOURCE_TEXT]]]),
};

const FULL_LINES = [
  'You are standing at the Test Gate, a Gothic gate of the Old Town.',
  'It was built of red brick in 1400, and it guarded the main road into the town.',
  'Look at the arch, where a stone eagle sits above the passage for everyone who walks through it.',
  'The eagle was carved by Jan Kowalski, and it has watched this road for a long time now.',
  '',
  'In 1817, the Senate decided to preserve the gate, so the brick walls are still here for you today.',
  'Many other gates and walls of the town were not so lucky, and this one is a rare survivor of them.',
  'Take a moment to look at the red brick, and at the stone eagle above the arch, before you walk on.',
  'The gate is small, but it tells the story of the whole town and of the people who built it with care.',
  'It is a good place to stop, to listen, and to imagine the road as it was in the time of the builders.',
];

function fixture({ teaser, full, deep, claims, meta = {}, view } = {}) {
  const m = {
    poiId: 'poi_test_1',
    persona: 'historian',
    lang: 'en',
    promptId: 'historian-v1',
    model: 'claude-opus-5-5',
    drafted: '2026-10-03',
    reviewed: '           # left EMPTY; the human writes "<initials> <YYYY-MM-DD>"',
    status: 'draft        # human sets approved | edited',
    ...meta,
  };
  const claimLines = claims ?? [
    '- text: Gothic gate of the Old Town',
    `  source: ${SOURCE_ID}`,
    '  quote: "The Test Gate is a Gothic gate in the Old Town."',
    '- text: built of red brick in 1400',
    `  source: ${SOURCE_ID}`,
    '  quote: "It was built of red brick in 1400 and guarded the main road."',
    '- text: preserved by the Senate in 1817',
    `  source: ${SOURCE_ID}`,
    '  quote: "In 1817 the Senate decided to preserve the gate."',
    '- text: stone eagle by Jan Kowalski',
    `  source: ${SOURCE_ID}`,
    '  quote: "A stone eagle was carved above the arch by Jan Kowalski."',
  ];
  return [
    '---',
    ...Object.entries(m).map(([k, v]) => `${k}: ${v}`),
    '---',
    '## teaser',
    ...(teaser ?? ['This is the Test Gate, built of red brick in 1400.', 'Look for the stone eagle that sits above its arch, carved by Jan Kowalski.']),
    '## full',
    ...(full ?? FULL_LINES),
    ...(deep ? ['## deep', ...deep] : []),
    '## claims',
    ...claimLines,
    '## view hint (proposed, for review)',
    ...(view ?? ['look: up', 'feature: the stone eagle above the arch']),
    '## drafting notes',
    'nothing to add',
    '## reviewer notes',
    '',
  ].join('\n');
}

const run = (opts) => checkReview(parseReviewFile(fixture(opts)), ctx);
const checksOf = (r) => r.failures.map((f) => f.check);

test('parser: front matter comments stripped, sections, paragraphs, claims, view hint', () => {
  const p = parseReviewFile(fixture());
  assert.deepEqual(p.errors, []);
  assert.equal(p.meta.reviewed, '');
  assert.equal(p.meta.status, 'draft');
  assert.equal(p.meta.poiId, 'poi_test_1');
  assert.equal(p.sections.teaser.length, 2);
  assert.equal(p.sections.full.length, 9);
  assert.equal(p.paragraphs.full.length, 2);
  assert.equal(p.sections.deep, undefined);
  assert.equal(p.claims.length, 4);
  assert.equal(p.claims[1].quote, 'It was built of red brick in 1400 and guarded the main road.');
  assert.deepEqual(p.view, { look: 'up', feature: 'the stone eagle above the arch' });
  assert.equal(p.notes.drafting, 'nothing to add');
  assert.equal(p.notes.reviewer, '');
});

test('parser: a quote keeps inner double quotes verbatim (first to last quote)', () => {
  const p = parseReviewFile(fixture({ claims: ['- text: x', `  source: ${SOURCE_ID}`, '  quote: "a "wild stone" tower"'] }));
  assert.equal(p.claims[0].quote, 'a "wild stone" tower');
});

test('parser: reports a missing front matter and malformed claim lines', () => {
  assert.ok(parseReviewFile('## teaser\nHello.').errors[0].includes('front matter'));
  const p = parseReviewFile(fixture({ claims: ['- text: x', 'source without indent'] }));
  assert.ok(p.errors.some((e) => e.includes('claims line')));
});

test('a valid draft passes and reports word counts', () => {
  const r = run();
  assert.deepEqual(r.failures, []);
  assert.equal(r.words.teaser, 25);
  assert.ok(r.words.full >= 120);
  assert.equal(r.claims, 4);
});

test('claims_quote: a quote that is not an exact substring fails', () => {
  const claims = ['- text: built 1400', `  source: ${SOURCE_ID}`, '  quote: "It was built of red bricks in 1400"'];
  assert.ok(checksOf(run({ claims })).includes('claims_quote'));
});

test('claims_quote: an unknown source id or a one-word quote fails', () => {
  const unknown = ['- text: gate', '  source: wp:en:Test Gate@999', '  quote: "The Test Gate"'];
  assert.ok(run({ claims: unknown }).failures.some((f) => f.detail.includes('unknown source')));
  const short = ['- text: gate', `  source: ${SOURCE_ID}`, '  quote: "1400"'];
  assert.ok(run({ claims: short }).failures.some((f) => f.detail.includes('shorter than 2 words')));
});

test('numbers: a year that is in no claim quote fails', () => {
  const teaser = ['This is the Test Gate, built of red brick in 1401.', 'Look for the stone eagle that sits above its arch, carved by Jan Kowalski.'];
  const r = run({ teaser });
  assert.deepEqual(checksOf(r), ['numbers']);
  assert.ok(r.failures[0].detail.includes('1401'));
});

test('numbers: token equality, "14" is not covered by a quote that only has "1400"', () => {
  const fails = checkSection('teaser', ['It was built in the 14th century, of red brick, with an eagle and an arch and a gate.'], 'en',
    [{ quote: 'built of red brick in 1400' }], []);
  assert.deepEqual(fails.map((f) => f.check), ['numbers']);
});

test('proper_nouns: below 85 % grounded fails, sentence-initial and possessive tokens handled', () => {
  assert.deepEqual(properNounCandidates("Saint Mary's tower faces the Cloth Hall's roof."), ['Mary', 'Cloth', 'Hall']);
  const teaser = ['This is the Test Gate, built by Peter Smith and Anna Brown in 1400.', 'It stands beside the Old Town of Kraków in Poland.'];
  const r = run({ teaser });
  assert.deepEqual(checksOf(r), ['proper_nouns']);
  assert.ok(r.failures[0].detail.includes('Smith'));
});

test('length: teaser below 15 words and full above 420 words fail; deep is optional', () => {
  assert.ok(checksOf(run({ teaser: ['This is the Test Gate of 1400.'] })).includes('length'));
  const long = Array.from({ length: 30 }, () => 'The Test Gate was built of red brick in 1400 and it guarded the main road.');
  assert.ok(run({ full: long }).failures.some((f) => f.where === 'full' && f.check === 'length'));
  assert.deepEqual(run({ deep: FULL_LINES.filter((l) => l) }).failures, []);
});

test('sentence_length: a sentence above 45 words fails', () => {
  const s = `It was built of red brick in 1400 ${'and it guarded the main road '.repeat(7)}for all.`;
  const r = run({ full: [...FULL_LINES, s] });
  assert.ok(r.failures.some((f) => f.check === 'sentence_length' && f.where === 'full'));
});

test('forbidden: absolute directions, hedges, markdown and brackets fail; [pNNN] is allowed', () => {
  const base = 'This is the Test Gate, built of red brick in 1400, with a stone eagle above the arch.';
  const cases = [
    ['The stone eagle is on your left, above the arch.', '"on your left"'],
    ['Behind you is the Old Town, where the stone eagle was carved.', '"behind you"'],
    ['The eagle was reportedly carved by Jan Kowalski.', '"reportedly"'],
    ['Legend has it that the eagle was carved by Jan Kowalski.', '"legend has it"'],
    ['The *stone* eagle sits above the arch of the gate.', '"*"'],
    ['The stone eagle sits above the arch of the gate [1].', '"[" (only [pNNN] allowed)'],
    ['See https://example.org for the stone eagle above the arch.', 'URL'],
  ];
  for (const [line, expected] of cases) {
    const fails = checkSection('teaser', [base, line], 'en', [{ quote: SOURCE_TEXT }], ['Test Gate']);
    const f = fails.find((x) => x.check === 'forbidden');
    assert.ok(f, `expected forbidden for: ${line}`);
    assert.ok(f.detail.includes(expected), `${f.detail} should mention ${expected}`);
  }
  const ok = checkSection('teaser', [base, '[p300] The stone eagle sits above the arch, carved by Jan Kowalski.'], 'en',
    [{ quote: SOURCE_TEXT }], ['Test Gate']);
  assert.deepEqual(ok, []);
});

test('lang: Polish text in an en file fails; names are removed before the ASCII ratio', () => {
  const pl = ['To jest brama, która była zbudowana z cegły w 1400 roku i jest na drodze do miasta.'];
  assert.ok(checkSection('teaser', pl, 'en', [{ quote: 'w 1400 roku' }], []).some((f) => f.check === 'lang'));
  const withName = ['Brama Testowa ŻŻŻŻŻ is the Polish name of the gate that was built in 1400 and it is old.'];
  assert.ok(checkSection('teaser', withName, 'en', [{ quote: 'in 1400' }], ['Brama Testowa ŻŻŻŻŻ']).every((f) => f.check !== 'lang'));
  assert.ok(checkSection('teaser', withName, 'en', [{ quote: 'in 1400' }], []).some((f) => f.check === 'lang'));
});

test('one_sentence: two sentences on one line, or a line without an end mark, fail', () => {
  const two = run({ teaser: ['This is the Test Gate. It was built of red brick in 1400 and guarded the road.', 'Look at the stone eagle.'] });
  assert.ok(two.failures.some((f) => f.check === 'one_sentence' && f.detail.includes('more than one')));
  const open = run({ teaser: ['This is the Test Gate, built of red brick in 1400 and guarding the road', 'Look at the stone eagle above the arch.'] });
  assert.ok(open.failures.some((f) => f.check === 'one_sentence' && f.detail.includes('does not end')));
});

test('review state: empty reviewed needs draft; filled reviewed needs approved|edited and a date', () => {
  assert.deepEqual(run({ meta: { reviewed: '', status: 'approved' } }).failures.map((f) => f.check), ['review']);
  assert.deepEqual(run({ meta: { reviewed: 'TS 2026-10-03', status: 'draft' } }).failures.map((f) => f.check), ['review']);
  assert.deepEqual(run({ meta: { reviewed: 'TS', status: 'edited' } }).failures.map((f) => f.check), ['review']);
  assert.deepEqual(run({ meta: { reviewed: 'TS 2026-10-03', status: 'edited' } }).failures, []);
  assert.deepEqual(run({ meta: { reviewed: 'TS 2026-10-03   # a comment', status: 'approved   # x' } }).failures, []);
});

test('meta: poiId must be a tour stop and match the file name; view hint must be complete', () => {
  assert.ok(run({ meta: { poiId: 'poi_other' } }).failures.some((f) => f.check === 'meta'));
  assert.ok(run({ meta: { persona: 'kids' } }).failures.some((f) => f.detail.includes('persona')));
  assert.ok(run({ view: ['look: sideways', 'feature: x y'] }).failures.some((f) => f.check === 'view'));
  assert.ok(run({ view: ['look: up'] }).failures.some((f) => f.detail.includes('feature')));
});

test('coverage: a missing stop file and fewer than 3 deep sections are reported', () => {
  const stops = new Map([['a', {}], ['b', {}], ['c', {}]]);
  const results = [
    { poiId: 'a', lang: 'en', words: { deep: 300 } },
    { poiId: 'b', lang: 'en', words: { deep: 300 } },
  ];
  const f = checkCoverage(results, stops, 'en');
  assert.ok(f.some((x) => x.includes('missing c.en.md')));
  assert.ok(f.some((x) => x.includes('only 2')));
  results.push({ poiId: 'c', lang: 'en', words: { deep: 10 } });
  assert.deepEqual(checkCoverage(results, stops, 'en'), []);
});

const noDrafts = reviewFiles().length === 0 && 'no review files committed yet';
test('the committed review files: all 11 tour stops have an en draft and every file passes', { skip: noDrafts }, () => {
  const { ok, output, results } = main([]);
  assert.ok(ok, output);
  assert.equal(results.filter((r) => r.lang === 'en').length, 11);
});

test('translations: EN claims inherited, translation meta required, STALE warning when the EN text changed', async () => {
  const { scriptHash, reviewState } = await import('./check-drafts.mjs');
  const en = parseReviewFile(fixture());
  const pl = (sha, extra = []) => [
    '---', 'poiId: poi_test_1', 'persona: historian', 'lang: pl', 'generatedBy: mt', 'translatedFrom: en',
    'promptId: translate-v1', 'model: claude-opus-5-5', 'translated: 2026-10-03', `sourceSha256: ${sha}`, 'reviewed:', 'status: draft',
    '---', '## teaser',
    'To jest Test Gate, zbudowana z czerwonej cegły w 1400 roku, przy głównej drodze do miasta.',
    'Spójrz na kamiennego orła nad łukiem, którego wyrzeźbił Jan Kowalski.',
    '## full', ...FULL_LINES, '## claims', ...extra, '## view hint', 'look: up', 'feature: kamienny orzeł nad łukiem', '',
  ].join('\n');
  const plCtx = { ...ctx, fileName: 'poi_test_1.pl.md', enParsed: en };
  const fresh = checkReview(parseReviewFile(pl(scriptHash(en))), plCtx);
  assert.equal(fresh.claims, 4, 'EN claims are inherited');
  assert.ok(!fresh.failures.some((f) => f.check === 'meta' || f.check === 'claims_quote' || f.check === 'numbers'));
  assert.ok(!fresh.warnings.some((w) => w.startsWith('STALE')));
  const stale = checkReview(parseReviewFile(pl('a'.repeat(64))), plCtx);
  assert.ok(stale.warnings.some((w) => w.startsWith('STALE')));
  assert.ok(checkReview(parseReviewFile(pl('nothex')), plCtx).failures.some((f) => f.detail.includes('sourceSha256')));
  assert.ok(checkReview(parseReviewFile(pl(scriptHash(en))), { ...plCtx, enParsed: null }).failures.some((f) => f.detail.includes('no EN source')));
  // Approving the EN file does not change its script hash; editing the text does.
  assert.equal(scriptHash(parseReviewFile(fixture({ meta: { reviewed: 'MS 2026-10-03', status: 'approved' } }))), scriptHash(en));
  assert.notEqual(scriptHash(parseReviewFile(fixture({ teaser: ['This is the Test Gate, built of red brick in 1400, by the road.'] }))), scriptHash(en));
  assert.deepEqual(reviewState({ reviewed: 'MS 2026-10-03', status: 'edited' }), { reviewed: true, review: { reviewer: 'MS', at: '2026-10-03', status: 'edited' } });
  assert.ok(reviewState({ reviewed: '', status: 'approved' }).error);
});

test('tone: a sensitive stop rejects exclamation marks and trivia or prize words; other stops are not affected', () => {
  assert.deepEqual(toneHits('He refused, and he was shot dead.'), []);
  assert.deepEqual(toneHits('A funeral was held, and the fund paid for it.'), []);          // "fun" is not a hit
  assert.ok(toneHits('Fun fact: the doors were moved!').includes('exclamation mark'));
  assert.ok(toneHits('Did you know the synagogue had a prize?').includes('"did you know"'));
  assert.ok(toneHits('Ciekawostka: synagoga.').includes('"ciekawostk"'));
  assert.ok(toneHits('这是一个有趣的故事。').includes('"有趣"'));
  const teaser = ['This is the Test Gate, built of red brick in 1400!', 'Look for the stone eagle that sits above its arch, carved by Jan Kowalski.'];
  const sensitive = { ...STOP, sensitive: true };
  const r = checkReview(parseReviewFile(fixture({ teaser })), { ...ctx, stops: new Map([[STOP.poiId, sensitive]]) });
  assert.ok(r.failures.some((f) => f.check === 'tone' && f.where === 'teaser'), JSON.stringify(r.failures));
  assert.ok(!checksOf(run({ teaser })).includes('tone'));
});

test('the Kazimierz review files pass, synagogue stops (6-11) are marked sensitive', () => {
  const { ok, output, results } = main(['--course', 'krakow-kazimierz']);
  assert.ok(ok, output);
  assert.equal(results.filter((r) => r.lang === 'en').length, 11);
  const stops = [...loadStops(undefined, resolveCourse({ course: 'krakow-kazimierz' })).values()];
  assert.deepEqual(stops.map((s) => s.sensitive === true), stops.map((s) => s.kind === 'synagogue'));
  assert.equal(stops.filter((s) => s.sensitive).length, 6);
});
