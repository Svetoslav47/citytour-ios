// Tests for system-lines.mjs (task A13 phase 3). The exactness of the port is checked on the ArkTS side
// (entry/src/test/SystemLines.test.ets runs the real Phrases/Guidance functions on the golden); here: the golden is
// current, and the enumeration covers what the engine can say for the Royal Route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GOLDEN_PATH, distancePhrase, enumerateCases, followUp, goldenCases, goldenSource, linesFromCases, loadPack,
  maneuverAction, nowText, prepareText, sha256Hex, stepAlongs, stepCueKind, welcomeSentences
} from './system-lines.mjs';

const pack = loadPack();

test('the ArkTS golden fixture is up to date (run: node scripts/voice/system-lines.mjs --write-golden)', () => {
  assert.equal(readFileSync(GOLDEN_PATH, 'utf8'), goldenSource(goldenCases(pack)));
});

test('welcome uses the real tour title per language', () => {
  assert.deepEqual(welcomeSentences('en', 'The Royal Route', true), [
    'Welcome! Today\'s walk: The Royal Route.',
    'Put your phone away. I\'ll tell you where to go and where to look.',
    'This is a simulated walk, so I\'ll move you along the route myself.'
  ]);
  const lines = linesFromCases(enumerateCases(pack, { groups: ['system'] }));
  assert.ok(lines.some((l) => l.lang === 'pl' && l.text === 'Witaj! Dzisiejsza trasa: Droga Królewska.'));
  assert.ok(lines.some((l) => l.lang === 'zh' && l.text === '欢迎！今天的路线是皇家之路。'));
  assert.ok(lines.some((l) => l.lang === 'en' && l.text === 'That\'s the end of our walk.'));
});

test('distancePhrase and the prepare distances (8 m < d <= 30 m => 10/20/30 m)', () => {
  assert.equal(distancePhrase(8.1, 'en'), '10 metres');
  assert.equal(distancePhrase(25, 'en'), '30 metres');
  assert.equal(distancePhrase(30, 'pl'), '30 metrów');
  assert.equal(distancePhrase(300, 'zh'), '300米');
  assert.equal(distancePhrase(780, 'en'), '10 minutes');
  assert.equal(distancePhrase(80, 'pl', 1.3), '80 metrów');
});

test('maneuver actions and cue forms', () => {
  const s = { maneuver: 'turn', modifier: 'left', streetName: 'Grodzka', distanceM: 40 };
  const t = { maneuver: 'end of road', modifier: 'right', streetName: '', distanceM: 10 };
  assert.equal(prepareText('en', s, 30, null), 'In 30 metres, turn left onto Grodzka.');
  assert.equal(nowText('en', s, t), 'Now turn left onto Grodzka, then turn right at the end of the street.');
  assert.equal(nowText('pl', s, null), 'Teraz skręć w lewo (Grodzka).');
  assert.equal(nowText('zh', s, null), '现在左转。');                        // zh never speaks Polish street names
  assert.equal(maneuverAction('fork', 'slight right', 'en'), 'keep right at the fork');
  assert.equal(stepCueKind({ maneuver: 'depart', modifier: 'right', streetName: '', distanceM: 9 }), 'none');
  assert.equal(stepCueKind({ maneuver: 'new name', modifier: 'straight', streetName: '', distanceM: 300 }), 'continue');
});

test('followUp folds the next turn within the coalesce distance', () => {
  const leg = {
    geometry: [0, 0, 10, 0, 30, 0, 100, 0],
    steps: [
      { maneuver: 'depart', modifier: '', streetName: '', distanceM: 10, geomIndex: 0, x: 0, y: 0 },
      { maneuver: 'turn', modifier: 'left', streetName: '', distanceM: 20, geomIndex: 1, x: 10, y: 0 },
      { maneuver: 'turn', modifier: 'right', streetName: '', distanceM: 70, geomIndex: 2, x: 30, y: 0 },
      { maneuver: 'turn', modifier: 'left', streetName: '', distanceM: 0, geomIndex: 3, x: 100, y: 0 }
    ]
  };
  const alongs = stepAlongs(leg);
  assert.deepEqual(alongs, [0, 10, 30, 100]);
  const cues = leg.steps.map((x) => stepCueKind(x));
  assert.equal(followUp(leg, alongs, cues, 1), 2);
  assert.equal(followUp(leg, alongs, cues, 2), -1);
});

test('Royal Route enumeration: every group and language, unique texts, nav cues of the pack legs', () => {
  const lines = linesFromCases(enumerateCases(pack, {}));
  for (const lang of ['en', 'pl', 'zh']) {
    for (const g of ['system', 'arrival', 'nav']) {
      assert.ok(lines.some((l) => l.lang === lang && l.group === g), `${lang} ${g}`);
    }
  }
  const keys = new Set(lines.map((l) => `${l.lang}|${l.text}`));
  assert.equal(keys.size, lines.length);
  assert.ok(lines.every((l) => l.textSha256 === sha256Hex(l.text) && !/[{}]/.test(l.text)));
  assert.ok(lines.some((l) => l.lang === 'en' && /^Now .*, then /.test(l.text)));
  const tourOnly = linesFromCases(enumerateCases(pack, { navLegs: 'tour', groups: ['nav'] }));
  const all = lines.filter((l) => l.group === 'nav');
  assert.ok(tourOnly.length > 0 && tourOnly.length <= all.length);
});

test('numeric lines: distance buckets and every stop x direction x bucket (course server allowed set)', async () => {
  const { distanceBuckets, numericCases, stopNames, approachSentence, nextStopSentence, offRouteSentences } =
    await import('./system-lines.mjs');
  const en = distanceBuckets('en').map((b) => b.text);
  assert.equal(en[0], '10 metres');
  assert.ok(en.includes('100 metres') && en.includes('500 metres') && en.includes('6 minutes'));
  assert.equal(en[en.length - 1], '60 minutes');
  assert.equal(en.length, 10 + 8 + 55);
  assert.equal(distanceBuckets('pl').length, en.length);
  assert.equal(approachSentence('en', 'Barbican', 'left', 80, true), 'In about 80 metres, on your left: Barbican.');
  assert.equal(approachSentence('zh', '瓮城', 'here', 80, true), '再走大约80米，就到瓮城。');
  assert.equal(nextStopSentence('pl', 'Barbakan', 600), 'Następny przystanek: Barbakan, około 8 minut stąd.');
  assert.deepEqual(offRouteSentences('en', 'Cloth Hall', 200, 'behindRight', true),
    ['You\'ve left the route.', 'Cloth Hall is about 200 metres behind you, on the right.']);
  const names = stopNames(pack);
  const cases = numericCases(names);
  // per lang: stops x buckets x (nextStop + 10 approach + 10 offRoute: 9 dirs + directions off)
  assert.equal(cases.length, 3 * names.en.length * en.length * 21);
});
