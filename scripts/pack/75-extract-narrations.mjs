// Stage 7 (extractive part): narration candidates for every POI and language (Node 22+ ESM, no network, no LLM).
//
// Tiers built here (docs/ARCHITECTURE.md §7.4):
//   SOURCE_EXTRACT  teaser: the first 1-2 sentences of the Wikipedia REST summary in that language (a 2nd
//                   sentence only when the 1st is short: < 25 words / < 60 CJK chars, and both fit 60 / 150);
//                   full (tour stops only): the first sentences of the longer stop text (data/raw/wiki/stops-text-*),
//                   up to 6 sentences and 160 words / 500 CJK chars (the extract_size limits).
//                   Verbatim except: asides in ( ), （ ） and [ ] are removed (pronunciations, translations,
//                   citation markers [1]: the REST summaries already drop the round ones), whitespace is collapsed
//                   (in zh also the space such a removal leaves between two CJK chars), punctuation left at the
//                   start of a sentence is dropped, heading lines are skipped and the text is cut at the first
//                   fragment that is not a full sentence (list items, "...:" list intros; in zh anything not
//                   ending in 。！？, e.g. a Latin citation line). Attributed via `sources` (the Wikipedia article + revision); provenance kind
//                   'extract', at = the snapshot's retrieval time; claims empty.
//   NAME_ONLY       "{name}, {kind}{, built in {year}}." (en), "{name}, {kind}{, rok powstania: {year}}." (pl),
//                   "{name}，{kind}{，建于{year}年}。" (zh); year = Wikidata P571 at year precision or finer;
//                   name = Poi.names[lang], else the pl name; provenance kind 'template'; sources = the Wikidata item.
// Reviewed / grounded-AI scripts are task B7 (70-narrate.mjs); 90-emit.mjs puts them first in the candidate list,
// and 80-validate.mjs walks the list best tier first (fallback chain).

import { cjkCount, sizeOf } from './80-validate.mjs';
import { wdSourceId } from './40-merge-pois.mjs';

export const PERSONA_ID = 'historian';
export const TEASER_MAX = Object.freeze({ words: 60, zh: 150 });
export const TEASER_SECOND_IF_FIRST_BELOW = Object.freeze({ words: 25, zh: 60 });
export const FULL_MAX = Object.freeze({ sentences: 6, words: 160, zh: 500 });

/** Abbreviations whose trailing '.' never ends a sentence (lowercase, without the final dot). */
export const ABBREVIATIONS = Object.freeze(new Set([
  // en
  'st', 'sts', 'mr', 'mrs', 'ms', 'dr', 'prof', 'rev', 'fr', 'jr', 'sr', 'no', 'nos', 'vs', 'etc', 'ca', 'approx', 'mt',
  'ave', 'gen', 'col', 'lt', 'capt', 'sgt', 'fig', 'vol', 'pp', 'ft', 'km', 'cm', 'mm', 'lit', 'cf', 'ed', 'jan', 'feb',
  'aug', 'sept', 'oct', 'nov', 'dec',
  // pl
  'ul', 'al', 'pl', 'ks', 'bp', 'abp', 'kard', 'płk', 'inż', 'im', 'pw', 'ok', 'ob', 'tzw', 'np', 'wg', 'tj', 'tys',
  'mln', 'zm', 'ur', 'nr', 'cz', 'wyd', 'św', 'ww', 'os', 'zob', 'godz', 'ds', 'hab', 'mgr', 'arch', 'bł', 'kpt', 'por',
  'ppor', 'kpr', 'marsz', 'woj', 'pow', 'gm', 'pn', 'płn', 'płd', 'wsch', 'zach', 'jw', 'ang', 'łac', 'niem', 'fr',
  'gr', 'hebr', 'wł', 'min', 'pt', 'dot', 'kl', 'sp', 'zm', 'ul',
]));

export const KIND_WORDS = Object.freeze({
  en: {
    monument: 'monument', church: 'church', castle: 'castle or fortress', square: 'square', gate: 'gate', museum: 'museum',
    building: 'building', plaque: 'plaque', viewpoint: 'viewpoint', synagogue: 'synagogue', other: 'place',
  },
  pl: {
    monument: 'pomnik', church: 'kościół', castle: 'zamek lub twierdza', square: 'plac', gate: 'brama', museum: 'muzeum',
    building: 'budynek', plaque: 'tablica', viewpoint: 'punkt widokowy', synagogue: 'synagoga', other: 'miejsce',
  },
  zh: {
    monument: '纪念碑', church: '教堂', castle: '城堡或要塞', square: '广场', gate: '城门', museum: '博物馆',
    building: '建筑', plaque: '纪念牌', viewpoint: '观景点', synagogue: '犹太会堂', other: '地点',
  },
});

/**
 * Removes "( ... )", "（ ... ）" and "[ ... ]" asides (innermost first): pronunciations, translations, citation
 * markers like [1] and editorial insertions like [tj. 1597]. Then tidies the spaces they leave.
 */
export function stripParentheticals(s) {
  let out = String(s ?? '');
  for (let prev = null; prev !== out; ) {
    prev = out;
    out = out.replace(/\s*\([^()]*\)/g, '').replace(/\s*（[^（）]*）/g, '').replace(/\s*\[[^[\]]*\]/g, '');
  }
  return out.replace(/[ \t]+([,.;:!?，。；：！？])/g, '$1').replace(/[ \t]{2,}/g, ' ');
}

function isAbbreviation(text, dotIndex) {
  const m = /[\p{L}.]+$/u.exec(text.slice(0, dotIndex));
  if (!m) return false;
  const tok = m[0].toLowerCase();
  return ABBREVIATIONS.has(tok) || /^\p{L}$/u.test(tok) || /^(\p{L}{1,2}\.)+\p{L}{1,3}$/u.test(tok);
}

/**
 * Splits text into sentences. Paragraph breaks always end a sentence; "== Heading ==" lines are skipped.
 * zh: after 。！？ (with closing quotes). en/pl: after . ! ? … when followed by whitespace and an uppercase
 * letter (optionally after an opening quote/bracket), unless the '.' ends an abbreviation, an initial or a
 * dotted abbreviation (m.in, p.n.e, n.p.m, e.g).
 */
export function splitSentences(text, lang) {
  const out = [];
  for (const para of String(text ?? '').split(/\n+/)) {
    const p = para.replace(/\s+/g, ' ').trim();
    if (!p || /^=+.*=+$/.test(p)) continue;
    if (lang === 'zh') {
      for (const m of p.matchAll(/[^。！？]+(?:[。！？]+[」』”"）)]*)?/g)) {
        const s = m[0].trim();
        if (s) out.push(s);
      }
      continue;
    }
    let start = 0;
    const re = /[.!?…]+["'”»)]*(?=\s)/g;
    let m;
    while ((m = re.exec(p))) {
      const end = m.index + m[0].length;
      if (!/^\s*["„“«(]?\p{Lu}/u.test(p.slice(end))) continue;
      if (m[0][0] === '.' && m[0].length === 1 && isAbbreviation(p, m.index)) continue;
      out.push(p.slice(start, end).trim());
      start = end;
    }
    const tail = p.slice(start).trim();
    if (tail) out.push(tail);
  }
  return out;
}

/** A full sentence ends like this (zh: CJK terminal punctuation only, so a Latin citation line ends the text). */
const TERMINAL_RE = { zh: /[。！？…]["'”」』）)]*$/u, other: /[.!?…]["'”»)]*$/u };

/**
 * Sentences of a text after the extract clean-up, cut at the first fragment that is not a full sentence
 * (no terminal punctuation: a list item, a caption, or a list intro ending in ':').
 */
export function extractSentences(text, lang) {
  let t = stripParentheticals(text);
  if (lang === 'zh') t = t.replace(/(?<=[\u4e00-\u9fff])[ \t]+(?=[\u4e00-\u9fff，。、；：！？])/g, '');
  const out = [];
  const terminal = lang === 'zh' ? TERMINAL_RE.zh : TERMINAL_RE.other;
  for (const raw of splitSentences(t, lang)) {
    const s = raw.replace(/^[，、,;；:：\s]+/u, '');
    if (!/\p{L}/u.test(s) || !terminal.test(s)) break;
    out.push(s);
  }
  return out;
}

/** Teaser: first sentence, plus the second when the first is short and both fit the teaser maximum. */
export function teaserSentences(sentences, lang) {
  if (!sentences.length) return [];
  const key = lang === 'zh' ? 'zh' : 'words';
  const s1 = sentences[0];
  if (sentences.length > 1 && sizeOf(s1, lang) < TEASER_SECOND_IF_FIRST_BELOW[key]) {
    const both = `${s1} ${sentences[1]}`;
    if (sizeOf(both, lang) <= TEASER_MAX[key]) return [s1, sentences[1]];
  }
  return [s1];
}

/** Full extract: leading sentences up to FULL_MAX (at least the first sentence). */
export function fullSentences(sentences, lang) {
  const max = lang === 'zh' ? FULL_MAX.zh : FULL_MAX.words;
  const out = [];
  let size = 0;
  for (const s of sentences) {
    const n = sizeOf(s, lang);
    if (out.length >= FULL_MAX.sentences || (out.length > 0 && size + n > max)) break;
    out.push(s);
    size += n;
  }
  return out;
}

export function nameOnlySentence(name, kind, year, lang) {
  const k = KIND_WORDS[lang][kind] ?? KIND_WORDS[lang].other;
  const n = String(name).replace(/[.。]+$/u, '');
  if (lang === 'zh') return year ? `${n}，${k}，建于${year}年。` : `${n}，${k}。`;
  if (lang === 'pl') return year ? `${n}, ${k}, rok powstania: ${year}.` : `${n}, ${k}.`;
  return year ? `${n}, ${k}, built in ${year}.` : `${n}, ${k}.`;
}

function narration(poiId, lang, length, tier, sentences, sources, generatedBy) {
  return {
    id: `${poiId}:${PERSONA_ID}:${lang}:${length}`,
    poiId,
    personaId: PERSONA_ID,
    lang,
    length,
    sentences,
    tier,
    sources,
    claims: [],
    generatedBy,
    validation: { status: 'pass', checks: [], validatorVersion: 1 },
  };
}

/**
 * Candidates per narration key (best tier first), for the extract and name-only tiers.
 *   pois       Poi[] (merged)
 *   stopIds    Set of tour stop poiIds (they also get a `full` narration)
 *   wiki       { summaries: {lang: {meta, pages}}, stopTexts: {lang: {meta, pages}}, stopSourceId(lang, qid) }
 *   years      Map poiId -> inception year | null
 *   wdAt       Wikidata snapshot retrievedAt (provenance time of the template tier)
 * Returns Map key -> Narration[] where key = narration id.
 */
export function buildCandidates({ pois, stopIds, wiki, years, wdAt, wpSourceId }) {
  const out = new Map();
  const push = (n) => {
    if (!out.has(n.id)) out.set(n.id, []);
    out.get(n.id).push(n);
  };
  for (const poi of pois) {
    const qid = poi.wikidataId;
    const lengths = stopIds.has(poi.id) ? ['teaser', 'full'] : ['teaser'];
    for (const lang of ['en', 'pl', 'zh']) {
      const summary = wiki.summaries[lang]?.pages?.[qid];
      const stopText = wiki.stopTexts[lang]?.pages?.[qid];
      for (const length of lengths) {
        if (length === 'teaser' && summary?.extract) {
          const s = teaserSentences(extractSentences(summary.extract, lang), lang);
          if (s.length) {
            push(narration(poi.id, lang, length, 'source-extract', s, [wpSourceId(lang, qid)], {
              kind: 'extract', at: wiki.summaries[lang].meta.retrievedAt,
            }));
          }
        }
        if (length === 'full' && stopText?.text) {
          const s = fullSentences(extractSentences(stopText.text, lang), lang);
          if (s.length) {
            push(narration(poi.id, lang, length, 'source-extract', s, [wiki.stopSourceId(lang, qid)], {
              kind: 'extract', at: wiki.stopTexts[lang].meta.retrievedAt,
            }));
          }
        }
        const name = poi.names[lang] ?? poi.names.pl;
        push(narration(poi.id, lang, length, 'name-only', [nameOnlySentence(name, poi.kind, years.get(poi.id), lang)],
          [wdSourceId(qid)], { kind: 'template', at: wdAt }));
      }
    }
  }
  return out;
}

export { cjkCount };
