// Tests for 75-extract-narrations.mjs: sentence splitting, clean-up, teaser/full selection, name-only templates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCandidates, extractSentences, fullSentences, nameOnlySentence, splitSentences, stripParentheticals, teaserSentences,
} from './75-extract-narrations.mjs';
import { validateNarration } from './80-validate.mjs';

test('splitSentences: en abbreviations and initials do not end a sentence', () => {
  assert.deepEqual(splitSentences("St. Florian's Gate is in Kraków. It was built c. 1300 by J. Smith. Is it old? Yes!", 'en'), [
    "St. Florian's Gate is in Kraków.", 'It was built c. 1300 by J. Smith.', 'Is it old?', 'Yes!',
  ]);
  assert.deepEqual(splitSentences('It is 80 m tall. the end', 'en'), ['It is 80 m tall. the end']);
});

test('splitSentences: pl abbreviations (ul., św., w., r., m.in.) and paragraphs', () => {
  assert.deepEqual(splitSentences('Kościół św. Wojciecha stoi przy ul. Grodzkiej. Powstał w XI w. Według m.in. Długosza był stary.\nNowy akapit', 'pl'), [
    'Kościół św. Wojciecha stoi przy ul. Grodzkiej.', 'Powstał w XI w. Według m.in. Długosza był stary.', 'Nowy akapit',
  ]);
  assert.deepEqual(splitSentences('== Historia ==\nTekst.', 'pl'), ['Tekst.']);
});

test('splitSentences: zh', () => {
  assert.deepEqual(splitSentences('瓦维尔山是一座小山。山上有城堡！有人吗？最后', 'zh'), ['瓦维尔山是一座小山。', '山上有城堡！', '有人吗？', '最后']);
});

test('stripParentheticals removes (…), （…） and […] asides incl. nested ones and citation markers', () => {
  assert.equal(stripParentheticals('The Cloth Hall (Polish: Sukiennice, pronounced [sukʲɛˈɲːit͡sɛ]), is a hall.'), 'The Cloth Hall, is a hall.');
  assert.equal(stripParentheticals('纺织会馆（波兰语：Sukiennice）是建筑。'), '纺织会馆是建筑。');
  assert.equal(stripParentheticals('instytucja kultury[1], powstał [tj. 1597] tutaj.'), 'instytucja kultury, powstał tutaj.');
});

test('extractSentences cuts at list intros, fragments and (zh) Latin citation lines', () => {
  assert.deepEqual(extractSentences('Wzgórze ma 228 m.\nNa wzgórzu są dwa zespoły:\nZamek Królewski\nKatedra.', 'pl'), ['Wzgórze ma 228 m.']);
  assert.deepEqual(extractSentences('瓮城是建筑。，建于1498年。\n\n== 参考 ==\n\nMarek Ż., "Barbakan", Kraków, 1991.', 'zh'), ['瓮城是建筑。', '建于1498年。']);
  assert.deepEqual(extractSentences('纺织会馆 是建筑。', 'zh'), ['纺织会馆是建筑。']);
});

test('teaser: one sentence, a second only when the first is short and both fit', () => {
  const short = 'The Barbican is a gate.';
  const long = Array.from({ length: 30 }, () => 'word').join(' ') + '.';
  assert.deepEqual(teaserSentences([short, 'It has seven turrets.', 'Third.'], 'en'), [short, 'It has seven turrets.']);
  assert.deepEqual(teaserSentences([long, 'Second.'], 'en'), [long]);
  assert.deepEqual(teaserSentences([short, `${long} ${long}`], 'en'), [short]);
  assert.deepEqual(teaserSentences([], 'en'), []);
});

test('full: up to 6 sentences and 160 words (zh 500 chars), at least one', () => {
  const s = (n) => Array.from({ length: n }, () => 'w').join(' ') + '.';
  assert.equal(fullSentences([s(10), s(10), s(10), s(10), s(10), s(10), s(10)], 'en').length, 6);
  assert.equal(fullSentences([s(100), s(50), s(20)], 'en').length, 2);
  assert.equal(fullSentences([s(200), s(5)], 'en').length, 1);
  assert.equal(fullSentences(['字'.repeat(300) + '。', '字'.repeat(250) + '。'], 'zh').length, 1);
});

test('name-only templates', () => {
  assert.equal(nameOnlySentence('Barbican', 'gate', 1498, 'en'), 'Barbican, gate, built in 1498.');
  assert.equal(nameOnlySentence('Ulica Kanonicza.', 'other', null, 'pl'), 'Ulica Kanonicza, miejsce.');
  assert.equal(nameOnlySentence('Barbakan', 'gate', 1498, 'pl'), 'Barbakan, brama, rok powstania: 1498.');
  assert.equal(nameOnlySentence('克拉科夫瓮城', 'gate', 1498, 'zh'), '克拉科夫瓮城，城门，建于1498年。');
});

test('buildCandidates: extract first, then name-only; full only for tour stops; all candidates validate', () => {
  const pois = [
    { id: 'poi_wd_Q1', wikidataId: 'Q1', kind: 'gate', names: { en: 'Barbican', pl: 'Barbakan' } },
    { id: 'poi_wd_Q2', wikidataId: 'Q2', kind: 'other', names: { pl: 'Plac' } },
  ];
  const meta = { retrievedAt: '2026-10-03T14:00:00Z' };
  const wiki = {
    summaries: { en: { meta, pages: { Q1: { extract: 'The Barbican (Polish: Barbakan) is a fortified outpost of the old city walls.' } } }, pl: { meta, pages: {} }, zh: { meta, pages: {} } },
    stopTexts: { en: { meta, pages: { Q1: { text: 'The Barbican is a fortified outpost. It was built around 1498.' } } }, pl: { meta, pages: {} }, zh: { meta, pages: {} } },
    stopSourceId: (lang, qid) => `wp_${lang}_${qid}`,
  };
  const c = buildCandidates({
    pois, stopIds: new Set(['poi_wd_Q1']), wiki, years: new Map([['poi_wd_Q1', 1498]]), wdAt: '2026-10-03T13:44:06Z',
    wpSourceId: (lang, qid) => `wp_${lang}_${qid}`,
  });
  assert.deepEqual([...c.keys()].sort(), [
    'poi_wd_Q1:historian:en:full', 'poi_wd_Q1:historian:en:teaser', 'poi_wd_Q1:historian:pl:full', 'poi_wd_Q1:historian:pl:teaser',
    'poi_wd_Q1:historian:zh:full', 'poi_wd_Q1:historian:zh:teaser', 'poi_wd_Q2:historian:en:teaser', 'poi_wd_Q2:historian:pl:teaser',
    'poi_wd_Q2:historian:zh:teaser',
  ]);
  const t = c.get('poi_wd_Q1:historian:en:teaser');
  assert.deepEqual(t.map((n) => n.tier), ['source-extract', 'name-only']);
  assert.deepEqual(t[0].sentences, ['The Barbican is a fortified outpost of the old city walls.']);
  assert.deepEqual(t[0].sources, ['wp_en_Q1']);
  assert.deepEqual(t[0].generatedBy, { kind: 'extract', at: '2026-10-03T14:00:00Z' });
  assert.deepEqual(t[1].sentences, ['Barbican, gate, built in 1498.']);
  assert.deepEqual(t[1].generatedBy, { kind: 'template', at: '2026-10-03T13:44:06Z' });
  assert.deepEqual(c.get('poi_wd_Q1:historian:en:full')[0].sentences, ['The Barbican is a fortified outpost.', 'It was built around 1498.']);
  assert.deepEqual(c.get('poi_wd_Q2:historian:zh:teaser')[0].sentences, ['Plac，地点。']);
  const ctx = { sourceIds: ['wp_en_Q1', 'wd_Q1', 'wd_Q2'], poiNames: ['Barbican', 'Barbakan'] };
  for (const list of c.values()) for (const n of list) assert.ok(validateNarration(n, ctx).ok, n.id);
});
