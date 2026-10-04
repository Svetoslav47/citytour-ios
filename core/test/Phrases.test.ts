// Suite: Phrases.test - module under test: core/content/Phrases (task A3; A9 adds the maneuver templates).
// Cases from docs/ARCHITECTURE.md §11.1 that A3 owns: every phrase key x language has a template, no `{}`
// left after formatting. Plus: every RelDir has wording in en/zh/pl, sentences are short and spoken-style
// (DESIGN §5.1: <= 20 words), end with a full stop, zh templates carry no Latin words, distance rounding
// (DESIGN §5.4), the arrival line with RelDir and the look clause, the G9 fallback without left/right,
// the simulated welcome line, and the localized-name fallback chain.
import { describe, it, expect } from 'vitest';
import {
  ALL_LANGS, ALL_MANEUVERS, ALL_MODIFIERS, ALL_PHRASE_KEYS, ALL_REL_DIRS, PhraseKey, actionWithStreet,
  approachSentence, arrivalSentences, distancePhrase, finishSentences, gpsLostSentence, localized, maneuverAction,
  nextStopSentence, phrase, phraseTemplate, relDirPhrase, welcomeSentences
} from '../src';
import { RelDir } from '../src';
import { Lang, LocalizedText, LookDir, Maneuver, RouteStep, ViewHint } from '../src';
import { maneuverUiText, nowText, prepareText } from '../src';

const LONG_NAME: string = 'Saint Mary\'s Basilica';

function wordCount(s: string): number {
  return s.split(/\s+/).filter((w: string) => w.length > 0).length;
}

function towerView(look: LookDir): ViewHint {
  const v: ViewHint = { look: look, feature: { en: 'the taller tower', zh: '较高的塔楼', pl: 'wyższa wieża' } };
  return v;
}

/** Every phrase of every key in a language, filled with realistic values. */
function allFilled(lang: Lang): string[] {
  const out: string[] = [];
  for (const k of ALL_PHRASE_KEYS) {
    out.push(phrase(k, lang, {
      name: LONG_NAME, dir: relDirPhrase(RelDir.BEHIND_RIGHT, lang), dist: distancePhrase(430, lang, 1.3),
      feature: 'the taller tower', tour: 'The Royal Route',
      action: maneuverAction(Maneuver.END_OF_ROAD, 'sharp left', lang),
      next: maneuverAction(Maneuver.FORK, 'slight right', lang), street: 'Floriańska'
    }));
  }
  return out;
}

function phrasesTest() {
  describe('Phrases', () => {
    it('every_key_and_reldir_has_text_in_every_language', () => {
      for (const lang of ALL_LANGS) {
        for (const k of ALL_PHRASE_KEYS) {
          expect(phraseTemplate(k, lang).length).toBeGreaterThan(0);
        }
        const seen: Set<string> = new Set<string>();
        for (const d of ALL_REL_DIRS) {
          const p: string = relDirPhrase(d, lang);
          expect(p.length).toBeGreaterThan(0);
          seen.add(p);
        }
        expect(seen.size).toBe(ALL_REL_DIRS.length);   // all nine distinct
      }
    });

    it('no_placeholder_left_after_formatting', () => {
      for (const lang of ALL_LANGS) {
        for (const s of allFilled(lang)) {
          expect(s.indexOf('{') < 0 && s.indexOf('}') < 0).toBe(true);
        }
      }
      // the helper functions fill everything too
      const helpers: string[] = [
        approachSentence(Lang.EN, LONG_NAME, RelDir.LEFT, 80, 1.3, true),
        approachSentence(Lang.ZH, LONG_NAME, RelDir.HERE, 80, 1.3, true),
        nextStopSentence(Lang.PL, LONG_NAME, Number.NaN, 1.3),
        gpsLostSentence(Lang.ZH)
      ];
      for (const s of helpers) {
        expect(s.indexOf('{') < 0).toBe(true);
      }
    });

    it('sentences_are_short_and_end_with_a_full_stop', () => {
      for (const lang of [Lang.EN, Lang.PL]) {
        for (const s of allFilled(lang)) {
          expect(wordCount(s)).toBeLessThanOrEqual(20);
          const last: string = s.charAt(s.length - 1);
          expect(last === '.' || last === '!').toBe(true);
        }
      }
      for (const s of allFilled(Lang.ZH)) {
        expect(s.length).toBeLessThanOrEqual(60);
        expect(s.charAt(s.length - 1)).toBe('。');
      }
    });

    it('zh_templates_have_no_latin_words', () => {
      for (const k of ALL_PHRASE_KEYS) {
        const t: string = phraseTemplate(k, Lang.ZH).replace(/\{[a-z]+\}/g, '').replace('GPS', '');
        expect(/[A-Za-z]/.test(t)).toBe(false);
      }
    });

    it('distance_rounding_rules', () => {
      expect(distancePhrase(3, Lang.EN, 1.3)).toBe('10 metres');     // at least 10
      expect(distancePhrase(43, Lang.EN, 1.3)).toBe('40 metres');    // < 100: to 10
      expect(distancePhrase(45, Lang.EN, 1.3)).toBe('50 metres');
      expect(distancePhrase(120, Lang.EN, 1.3)).toBe('100 metres');  // < 500: to 50
      expect(distancePhrase(230, Lang.EN, 1.3)).toBe('250 metres');
      expect(distancePhrase(600, Lang.EN, 1.3)).toBe('8 minutes');   // 600 / 1.3 / 60 = 7.7
      expect(distancePhrase(600, Lang.EN, 10)).toBe('1 minute');
      expect(distancePhrase(80, Lang.ZH, 1.3)).toBe('80米');
      expect(distancePhrase(600, Lang.ZH, 1.3)).toBe('8分钟');
      expect(distancePhrase(80, Lang.PL, 1.3)).toBe('80 metrów');
      expect(distancePhrase(600, Lang.PL, 1.3)).toBe('8 minut');
      expect(distancePhrase(600, Lang.PL, 10)).toBe('minuty');       // "około minuty"
    });

    it('arrival_line_with_direction_and_look_clause', () => {
      const en: string[] = arrivalSentences(Lang.EN, LONG_NAME, RelDir.LEFT, towerView(LookDir.UP), true);
      expect(en.length).toBe(2);
      expect(en[0]).toBe('Saint Mary\'s Basilica is on your left.');
      expect(en[1]).toBe('Look up at the taller tower.');
      const zh: string[] = arrivalSentences(Lang.ZH, '圣玛丽大教堂', RelDir.AHEAD_RIGHT, towerView(LookDir.UP), true);
      expect(zh[0]).toBe('圣玛丽大教堂在右前方。');
      expect(zh[1]).toBe('请抬头看较高的塔楼。');
      const pl: string[] = arrivalSentences(Lang.PL, 'Bazylika Mariacka', RelDir.BEHIND, towerView(LookDir.DOWN), true);
      expect(pl[0]).toBe('Bazylika Mariacka jest za Tobą.');
      expect(pl[1]).toBe('Spójrz w dół: wyższa wieża.');
      // HERE (closer than 15 m or course unknown) and no view
      const here: string[] = arrivalSentences(Lang.EN, 'Cloth Hall', RelDir.HERE, undefined, true);
      expect(here.length).toBe(1);
      expect(here[0]).toBe('You\'re at Cloth Hall.');
    });

    it('g9_fallback_has_no_left_or_right', () => {
      const s: string[] = arrivalSentences(Lang.EN, LONG_NAME, RelDir.LEFT, towerView(LookDir.UP), false);
      expect(s[0]).toBe('You\'re at Saint Mary\'s Basilica.');
      expect(s[1]).toBe('Look for the taller tower.');
      const joined: string = s.join(' ');
      expect(joined.indexOf('left') < 0 && joined.indexOf('right') < 0).toBe(true);
      expect(approachSentence(Lang.EN, 'Cloth Hall', RelDir.RIGHT, 90, 1.3, false))
        .toBe('In about 90 metres: Cloth Hall.');
    });

    it('approach_next_welcome_finish_lines', () => {
      expect(approachSentence(Lang.EN, LONG_NAME, RelDir.LEFT, 78, 1.3, true))
        .toBe('In about 80 metres, on your left: Saint Mary\'s Basilica.');
      expect(approachSentence(Lang.ZH, '圣玛丽大教堂', RelDir.LEFT, 78, 1.3, true))
        .toBe('再走大约80米，圣玛丽大教堂在您左侧。');
      expect(nextStopSentence(Lang.EN, 'Cloth Hall', 240, 1.3))
        .toBe('Next stop: Cloth Hall, about 250 metres from here.');
      expect(nextStopSentence(Lang.EN, 'Cloth Hall', Number.NaN, 1.3)).toBe('Next stop: Cloth Hall.');
      const sim: string[] = welcomeSentences(Lang.EN, 'The Royal Route', true);
      expect(sim.length).toBe(3);
      expect(sim[2].indexOf('simulated') >= 0).toBe(true);
      expect(welcomeSentences(Lang.ZH, '皇家之路', false).length).toBe(2);
      expect(finishSentences(Lang.PL).length).toBe(2);
      expect(gpsLostSentence(Lang.EN)).toBe('I\'ve lost the GPS signal. I\'ll continue when it\'s back.');
      expect(phrase(PhraseKey.WELCOME, Lang.EN, { tour: 'The Royal Route' }))
        .toBe('Welcome! Today\'s walk: The Royal Route.');
    });

    it('every_maneuver_x_modifier_x_lang_has_a_short_action', () => {
      for (const lang of ALL_LANGS) {
        for (const m of ALL_MANEUVERS) {
          for (const mod of ALL_MODIFIERS) {
            const a: string = maneuverAction(m, mod, lang);
            expect(a.length).toBeGreaterThan(0);
            expect(a.indexOf('{') < 0 && a.indexOf('}') < 0).toBe(true);
            if (lang === Lang.ZH) {
              expect(/[A-Za-z]/.test(a)).toBe(false);
              expect(a.length).toBeLessThanOrEqual(12);
            } else {
              expect(wordCount(a)).toBeLessThanOrEqual(9);
            }
            const st: RouteStep = {
              maneuver: m, modifier: mod, streetName: 'Floriańska', distanceM: 40, durationS: 30, geomIndex: 0, x: 0,
              y: 0
            };
            const lines: string[] = [prepareText(lang, st, 28, 1.3, undefined), nowText(lang, st, st),
              maneuverUiText(lang, st, 120, 1.3, 8)];
            for (const l of lines) {
              expect(l.indexOf('{') < 0).toBe(true);
            }
          }
        }
        // left and right never read the same
        expect(maneuverAction(Maneuver.TURN, 'left', lang) === maneuverAction(Maneuver.TURN, 'right', lang))
          .toBe(false);
        expect(maneuverAction(Maneuver.FORK, 'slight left', lang) ===
          maneuverAction(Maneuver.FORK, 'slight right', lang)).toBe(false);
      }
    });

    it('zh_omits_polish_street_names_en_and_pl_keep_them', () => {
      const st: RouteStep = {
        maneuver: Maneuver.TURN, modifier: 'left', streetName: 'Floriańska', distanceM: 40, durationS: 30, geomIndex: 0,
        x: 0, y: 0
      };
      expect(prepareText(Lang.ZH, st, 30, 1.3, undefined).indexOf('Floriańska') < 0).toBe(true);
      expect(nowText(Lang.ZH, st, undefined)).toBe('现在左转。');
      expect(nowText(Lang.EN, st, undefined)).toBe('Now turn left onto Floriańska.');
      expect(nowText(Lang.PL, st, undefined)).toBe('Teraz skręć w lewo (Floriańska).');
      expect(actionWithStreet('左转', 'Floriańska', Lang.ZH)).toBe('左转');
      expect(actionWithStreet('turn left', '', Lang.EN)).toBe('turn left');
    });

    it('localized_falls_back_en_pl_zh', () => {
      const plOnly: LocalizedText = { pl: 'Sukiennice' };
      const enPl: LocalizedText = { en: 'Cloth Hall', pl: 'Sukiennice' };
      const all: LocalizedText = { en: 'Cloth Hall', pl: 'Sukiennice', zh: '纺织会馆' };
      const zhOnly: LocalizedText = { en: '', zh: '纺织会馆' };
      expect(localized(plOnly, Lang.EN)).toBe('Sukiennice');
      expect(localized(enPl, Lang.ZH)).toBe('Cloth Hall');
      expect(localized(all, Lang.ZH)).toBe('纺织会馆');
      expect(localized(zhOnly, Lang.PL)).toBe('纺织会馆');
      expect(localized(undefined, Lang.EN)).toBe('');
    });
  });
}

phrasesTest();
