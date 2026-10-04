/*
 * Deterministic language check for narration text (ARCHITECTURE §7.4 rule 3, validator spec v1 check `lang`).
 * Pure: no @kit imports. The pipeline (scripts/pack/80-validate.mjs) implements the same rules.
 * - zh: >= 60 % of letters are CJK (U+4E00-U+9FFF).
 * - en: >= 95 % of letters are ASCII A-Z/a-z AND en stopword hits > pl stopword hits.
 * - pl: pl stopword hits > en stopword hits, OR a Polish diacritic is present.
 * Known names of the place (all languages) are removed first, so "Kościół Mariacki" in an English text
 * does not make it look Polish.
 */
import { Lang } from '../../contracts/Model';

export const EN_STOPWORDS: string[] = ['the', 'and', 'of', 'is', 'was', 'in', 'for', 'with', 'on', 'as', 'by', 'from',
  'this', 'that', 'which', 'were', 'are', 'it'];
export const PL_STOPWORDS: string[] = ['się', 'nie', 'jest', 'w', 'z', 'na', 'oraz', 'który', 'która', 'było', 'był',
  'była', 'do', 'że', 'jak', 'przez', 'od', 'po', 'ze'];

const POLISH_DIACRITICS: RegExp = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
const LETTER: RegExp = /\p{L}/u;
const CJK: RegExp = /[一-鿿]/;
const ASCII_LETTER: RegExp = /[A-Za-z]/;

export class LetterStats {
  letters: number = 0;
  cjk: number = 0;
  ascii: number = 0;
}

/** Removes every occurrence of each name (longest first), so names don't skew the counts. */
export function stripNames(text: string, names: string[]): string {
  let out = text;
  const sorted = names.filter((n: string) => n.length > 0).sort((a: string, b: string) => b.length - a.length);
  for (const n of sorted) {
    out = out.split(n).join(' ');
  }
  return out;
}

export function letterStats(text: string): LetterStats {
  const s = new LetterStats();
  for (const ch of Array.from(text)) {
    if (LETTER.test(ch)) {
      s.letters++;
      if (CJK.test(ch)) {
        s.cjk++;
      } else if (ASCII_LETTER.test(ch)) {
        s.ascii++;
      }
    }
  }
  return s;
}

/** Whole-word, lower-case stopword hits. */
export function stopwordHits(text: string, words: string[]): number {
  const tokens = text.toLowerCase().split(/[^\p{L}]+/u).filter((t: string) => t.length > 0);
  let hits = 0;
  for (const t of tokens) {
    if (words.indexOf(t) >= 0) {
      hits++;
    }
  }
  return hits;
}

/** True when `text` reads as `lang` (after removing the place's names). */
export function langMatches(text: string, lang: Lang, names: string[]): boolean {
  const t = stripNames(text, names);
  const st = letterStats(t);
  if (lang === Lang.ZH) {
    return st.letters > 0 && st.cjk / st.letters >= 0.6;
  }
  const en = stopwordHits(t, EN_STOPWORDS);
  const pl = stopwordHits(t, PL_STOPWORDS);
  if (lang === Lang.EN) {
    return st.letters > 0 && st.ascii / st.letters >= 0.95 && en > pl;
  }
  if (lang === Lang.PL) {
    return pl > en || POLISH_DIACRITICS.test(t);
  }
  return false;
}
