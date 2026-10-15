// Tests for scripts/pack/70-narrate.mjs (task B7: review files -> pack narrations). node:test, stdlib only.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  assertReviewedHaveReview, DRAFT_TIER, narrationDrafts, narrationsOf, planReviewFiles, readReviewFiles, REVIEWED_TIER,
  sourceIdMap,
} from './70-narrate.mjs';
import { parseReviewFile, scriptHash } from './review/check-drafts.mjs';

const SOURCE_TEXT =
  'The Test Gate is a Gothic gate in the Old Town. It was built of red brick in 1400 and guarded the main road. ' +
  'In 1817 the Senate decided to preserve the gate. A stone eagle was carved above the arch by Jan Kowalski.';
const SOURCES = [
  { id: 'wp_en_Q1', title: 'Test Gate', url: 'https://en.wikipedia.org/wiki/Test_Gate?oldid=123', publisher: 'Wikipedia', lang: 'en' },
  { id: 'wd_Q1', title: 'Test Gate (Wikidata Q1)', url: 'https://www.wikidata.org/wiki/Q1', publisher: 'Wikidata', lang: 'en' },
];
const POI = { id: 'poi_test_1', names: { en: 'Test Gate', pl: 'Brama Testowa', zh: '测试门' } };
const CTX = { pois: [POI], sources: SOURCES, sourceTexts: { wp_en_Q1: SOURCE_TEXT }, stopIds: new Set([POI.id]) };

const TEASER = ['This is the Test Gate, built of red brick in 1400.', 'Look for the stone eagle that sits above its arch, carved by Jan Kowalski.'];
const FULL = [
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
const CLAIMS = [
  '- text: Gothic gate of the Old Town', '  source: wp:en:Test Gate@123', '  quote: "The Test Gate is a Gothic gate in the Old Town."',
  '- text: built in 1400', '  source: wp:en:Test Gate@123', '  quote: "It was built of red brick in 1400 and guarded the main road."',
  '- text: 1817', '  source: wp:en:Test Gate@123', '  quote: "In 1817 the Senate decided to preserve the gate."',
  '- text: eagle', '  source: wp:en:Test Gate@123', '  quote: "A stone eagle was carved above the arch by Jan Kowalski."',
];

function enFile({ reviewed = '', status = 'draft', teaser = TEASER, full = FULL } = {}) {
  return [
    '---', `poiId: ${POI.id}`, 'persona: historian', 'lang: en', 'promptId: historian-v1', 'model: claude-opus-5-5',
    'drafted: 2026-10-03', `reviewed: ${reviewed}   # comment`, `status: ${status}   # comment`, '---',
    '## teaser', ...teaser, '## full', ...full, '## claims', ...CLAIMS,
    '## view hint', 'look: up', 'feature: the stone eagle above the arch', '',
  ].join('\n');
}

function plFile(sourceSha256) {
  return [
    '---', `poiId: ${POI.id}`, 'persona: historian', 'lang: pl', 'generatedBy: mt', 'translatedFrom: en',
    'promptId: translate-v1', 'model: claude-opus-5-5', 'translated: 2026-10-03', `sourceSha256: ${sourceSha256}`,
    'reviewed:', 'status: draft', '---',
    '## teaser', 'To jest Brama Testowa, zbudowana z czerwonej cegły w 1400 roku.', 'Spójrz na kamiennego orła nad łukiem.',
    '## full', 'Stoisz przy Bramie Testowej.', '## claims', '## view hint', 'look: up', 'feature: kamienny orzeł nad łukiem', '',
  ].join('\n');
}

const parsedFiles = (list) => list.map(([file, src]) => ({ file, parsed: parseReviewFile(src) }));
const enHash = (src) => scriptHash(parseReviewFile(src));

function withDir(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'narrate-test-'));
  try {
    for (const [name, src] of files) writeFileSync(join(dir, name), src);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const quiet = { warn: () => {} };

test('an unreviewed EN draft becomes grounded-ai with llm provenance and no reviewedBy', () => {
  const [p] = planReviewFiles(parsedFiles([['poi_test_1.en.md', enFile()]]));
  assert.equal(p.tier, DRAFT_TIER);
  assert.equal(p.review, null);
  assert.deepEqual(p.generatedBy, { kind: 'llm', model: 'claude-opus-5-5', promptId: 'historian-v1', at: '2026-10-03' });
});

test('only reviewed: <initials> <date> + status approved|edited makes tier reviewed, with reviewedBy', () => {
  const [p] = planReviewFiles(parsedFiles([['poi_test_1.en.md', enFile({ reviewed: 'MS 2026-10-03', status: 'edited' })]]));
  assert.equal(p.tier, REVIEWED_TIER);
  assert.deepEqual(p.review, { reviewer: 'MS', at: '2026-10-03', status: 'edited' });
});

test('inconsistent review lines fail loudly instead of being emitted', () => {
  assert.throws(() => planReviewFiles(parsedFiles([['a.en.md', enFile({ status: 'approved' })]])), /refusing to guess/);
  assert.throws(() => planReviewFiles(parsedFiles([['a.en.md', enFile({ reviewed: 'MS 2026-10-03', status: 'draft' })]])), /approved\|edited/);
  assert.throws(() => planReviewFiles(parsedFiles([['a.en.md', enFile({ reviewed: 'MS', status: 'approved' })]])), /initials/);
});

test('a translation inherits the EN review state: draft, reviewed when fresh, grounded-ai when stale', () => {
  const draftEn = enFile();
  const okEn = enFile({ reviewed: 'MS 2026-10-03', status: 'approved' });
  const [, pl1] = planReviewFiles(parsedFiles([['e.en.md', draftEn], ['e.pl.md', plFile(enHash(draftEn))]]));
  assert.equal(pl1.tier, DRAFT_TIER);
  assert.equal(pl1.stale, false);
  assert.deepEqual(pl1.generatedBy, { kind: 'mt', model: 'claude-opus-5-5', promptId: 'translate-v1', at: '2026-10-03', translatedFrom: 'en' });
  assert.equal(pl1.claims.length, 4, 'EN claims are inherited');

  // Approving the EN file without editing its text keeps the hash: the translation becomes reviewed (MT of reviewed EN).
  assert.equal(enHash(okEn), enHash(draftEn));
  const [, pl2] = planReviewFiles(parsedFiles([['e.en.md', okEn], ['e.pl.md', plFile(enHash(draftEn))]]));
  assert.equal(pl2.tier, REVIEWED_TIER);
  assert.deepEqual(pl2.review, { reviewer: 'MS', at: '2026-10-03', status: 'approved' });

  // A human edit of the EN text makes the translation stale: never reviewed until an agent refreshes it.
  const editedEn = enFile({ reviewed: 'MS 2026-10-03', status: 'edited', teaser: [TEASER[0], 'Look for the eagle above the arch, carved by Jan Kowalski.'] });
  const [, pl3] = planReviewFiles(parsedFiles([['e.en.md', editedEn], ['e.pl.md', plFile(enHash(draftEn))]]));
  assert.equal(pl3.stale, true);
  assert.equal(pl3.tier, DRAFT_TIER);
  assert.equal(pl3.review, null);
});

test('a translation without its EN file, or a pl file that is not a translation, fails', () => {
  assert.throws(() => planReviewFiles(parsedFiles([['e.pl.md', plFile('0'.repeat(64))]])), /no poi_test_1.en.md/);
  const notMt = plFile('0'.repeat(64)).replace('generatedBy: mt\n', '');
  assert.throws(() => planReviewFiles(parsedFiles([['e.en.md', enFile()], ['e.pl.md', notMt]])), /machine translation/);
});

test('narrationsOf maps review source ids to pack source ids and keeps the contract key order', () => {
  const [p] = planReviewFiles(parsedFiles([['poi_test_1.en.md', enFile({ reviewed: 'MS 2026-10-03', status: 'approved' })]]));
  const ns = narrationsOf(p, sourceIdMap(SOURCES));
  assert.deepEqual(ns.map((n) => n.id), ['poi_test_1:historian:en:teaser', 'poi_test_1:historian:en:full']);
  assert.deepEqual(Object.keys(ns[0]), ['id', 'poiId', 'personaId', 'lang', 'length', 'sentences', 'tier', 'sources', 'claims',
    'generatedBy', 'reviewedBy', 'validation']);
  assert.deepEqual(ns[0].sources, ['wp_en_Q1']);
  assert.equal(ns[1].sentences.length, 9, 'paragraph breaks are dropped, one sentence per line');
  const bad = { ...p, claims: [{ text: 'x', source: 'wp:en:Test Gate@999', quote: 'Test Gate' }] };
  assert.throws(() => narrationsOf(bad, sourceIdMap(SOURCES)), /not a source of this pack/);
});

test('assertReviewedHaveReview rejects a reviewed narration without a human review', () => {
  assert.throws(() => assertReviewedHaveReview([{ id: 'x', tier: 'reviewed' }]), /without a human review/);
  assert.throws(() => assertReviewedHaveReview([{ id: 'x', tier: 'reviewed', reviewedBy: { reviewer: 'AI', at: '2026-10-03', status: 'draft' } }]));
  assertReviewedHaveReview([{ id: 'x', tier: 'grounded-ai' }]);
});

test('narrationDrafts: valid drafts pass; a failing reviewed script stops the build, a failing draft only warns', () => {
  withDir([['poi_test_1.en.md', enFile()]], (dir) => {
    const ns = narrationDrafts(CTX, { dir, log: quiet });
    assert.equal(ns.length, 2);
    assert.ok(ns.every((n) => n.tier === DRAFT_TIER && n.reviewedBy === undefined));
  });
  const shortTeaser = ['This is the Test Gate.'];
  withDir([['poi_test_1.en.md', enFile({ reviewed: 'MS 2026-10-03', status: 'edited', teaser: shortTeaser })]], (dir) => {
    assert.throws(() => narrationDrafts(CTX, { dir, log: quiet }), /fails validator checks length/);
  });
  withDir([['poi_test_1.en.md', enFile({ teaser: shortTeaser })]], (dir) => {
    const warnings = [];
    narrationDrafts(CTX, { dir, log: { warn: (m) => warnings.push(m) } });
    assert.ok(warnings.some((w) => w.includes('falls back')));
  });
});

test('the committed review files build: a reviewed narration only comes from a file a human filled in', () => {
  const files = readReviewFiles();
  const plans = planReviewFiles(files);
  for (const p of plans) {
    const f = files.find((x) => x.file === p.file);
    const en = files.find((x) => x.parsed.meta.poiId === p.poiId && x.parsed.meta.lang === 'en');
    if (p.tier === REVIEWED_TIER) assert.ok(en.parsed.meta.reviewed, `${p.file}: reviewed without a filled EN review`);
    if (p.lang !== 'en') assert.equal(f.parsed.meta.generatedBy, 'mt', `${p.file} must be labelled machine-translated`);
  }
});
