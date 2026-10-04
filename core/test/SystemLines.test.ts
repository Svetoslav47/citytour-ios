// Suite: SystemLines.test - modules under test: core/content/Phrases, core/route/Guidance, core/speech/Sha256
// (task A13 phase 3). scripts/voice/system-lines.mjs is a Node port of the engine's fixed sentences (welcome,
// finish, GPS lost, off-route, replan, arrival lines, A9 turn-by-turn cues) used to pre-render them in the studio
// voice (+ samples of the numeric lines: approach, next stop with distance, off-route bearing, which the course
// server's allowed-lines set enumerates). A clip only plays when its text hash equals the hash of the exact sentence the app speaks, so this suite
// calls the real ArkTS functions on every golden case the port wrote (fixtures/SystemLinesGolden.ets) and asserts
// the same text and the same SHA-256 (prefix of Node's crypto hash). A template change in Phrases.ets without
// regenerating the golden (and fixing the port) fails here.
import { describe, it, expect } from 'vitest';
import { Lang, LocalizedText, LookDir, ViewHint } from '../src';
import { RelDir } from '../src';
import {
  approachSentence, arrivalSentences, finishSentences, gpsLostSentence, nextStopSentence, welcomeSentences
} from '../src';
import { continueText, nowText, offRouteSentences, prepareText, replanSentence } from '../src';
import { sha256Hex } from '../src';
import { GOLDEN_CASE_COUNT, GOLDEN_CASES, GoldenCase } from './fixtures/SystemLinesGolden';

const WALK_SPEED_MPS: number = 1.3;   // TourConfig default (the port uses the same)

function viewOf(c: GoldenCase): ViewHint | undefined {
  if (c.s.length < 4) {
    return undefined;
  }
  const v: ViewHint = { look: c.s[2] as LookDir, feature: JSON.parse(c.s[3]) as LocalizedText };
  return v;
}

/** The real call the engine makes for this case. */
function produce(c: GoldenCase): string[] {
  const lang: Lang = c.lang as Lang;
  switch (c.f) {
    case 'welcome':
      return welcomeSentences(lang, c.s[0], c.n[0] === 1);
    case 'finish':
      return finishSentences(lang);
    case 'gpsLost':
      return [gpsLostSentence(lang)];
    case 'offRoute':
      return offRouteSentences(lang, 'X', Number.NaN, RelDir.HERE, WALK_SPEED_MPS, true);
    case 'replan':
      return [replanSentence(lang, c.s[0])];
    case 'nextStopNoDist':
      return [nextStopSentence(lang, c.s[0], Number.NaN, WALK_SPEED_MPS)];
    case 'arrival':
      return arrivalSentences(lang, c.s[0], c.s[1] as RelDir, viewOf(c), c.n[0] === 1);
    case 'prepare':
      return c.step === undefined ? [] : [prepareText(lang, c.step, c.n[0], WALK_SPEED_MPS, c.then)];
    case 'now':
      return c.step === undefined ? [] : [nowText(lang, c.step, c.then)];
    case 'continue':
      return c.step === undefined ? [] : [continueText(lang, c.step, WALK_SPEED_MPS, c.s[0])];
    // Numeric lines (course server allowed-lines set, docs/SERVER.md §4): s = [name, dir], n = [distM, useDir].
    case 'nextStop':
      return [nextStopSentence(lang, c.s[0], c.n[0], WALK_SPEED_MPS)];
    case 'approach':
      return [approachSentence(lang, c.s[0], c.s[1] as RelDir, c.n[0], WALK_SPEED_MPS, c.n[1] === 1)];
    case 'offRouteDist':
      return offRouteSentences(lang, c.s[0], c.n[0], c.s[1] as RelDir, WALK_SPEED_MPS, c.n[1] === 1);
    default:
      return [`unknown case ${c.f}`];
  }
}

function systemLinesTest() {
  describe('SystemLines', () => {
    it('golden covers every group and language', () => {
      expect(GOLDEN_CASES.length).toBe(GOLDEN_CASE_COUNT);
      const fs: string[] = ['welcome', 'finish', 'gpsLost', 'offRoute', 'replan', 'nextStopNoDist', 'arrival', 'prepare',
        'now', 'nextStop', 'approach', 'offRouteDist'];
      for (const f of fs) {
        for (const l of ['en', 'pl', 'zh']) {
          expect(GOLDEN_CASES.some((c: GoldenCase) => c.f === f && c.lang === l)).toBe(true);
        }
      }
      expect(GOLDEN_CASES.some((c: GoldenCase) => c.f === 'now' && c.then !== undefined)).toBe(true);
    });

    it('the Node port produces exactly the ArkTS sentences (text and SHA-256)', () => {
      let bad: number = 0;
      let first: string = '';
      for (const c of GOLDEN_CASES) {
        const got: string[] = produce(c);
        let ok: boolean = got.length === c.out.length && c.sha.length === c.out.length;
        for (let i = 0; ok && i < got.length; i++) {
          ok = got[i] === c.out[i] && sha256Hex(got[i]).substring(0, c.sha[i].length) === c.sha[i];
        }
        if (!ok) {
          bad++;
          if (first === '') {
            first = `${c.f}/${c.lang}: got ${JSON.stringify(got)} want ${JSON.stringify(c.out)}`;
          }
        }
      }
      expect(first).toBe('');
      expect(bad).toBe(0);
    });
  });
}

systemLinesTest();
