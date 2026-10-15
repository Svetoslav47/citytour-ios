// Stage 8: narration validator, spec v1 (docs/ARCHITECTURE.md §7.4). Node 22+ ESM, stdlib only.
//
// The app's core/content/NarrationValidator.ets + LangDetect.ets (task B3, merged in PR #56) implement the SAME
// spec; where the spec left a detail open, this file follows the app's choice so both give identical verdicts.
// Shared expectations: scripts/pack/fixtures/validator-cases.json (to be ported to the app's Hypium tests).
// validateNarration() is pure.
//
// validateNarration(n, ctx) -> { ok, failed: [checkId...], firstFailed: checkId | null, applied: [checkId...] }
//   ctx.sourceIds          string[] (or Set): every SourceRef id in the pack
//   ctx.poiNames           string[]: every known name of the POI = the values of Poi.names (all languages)
//   ctx.sourceTexts        { [sourceId]: string } PIPELINE ONLY (the app has no source texts): enables claims_quote
//   ctx.translatedFromTier optional: tier of the narration this one was machine-translated from (see `numbers`)
//
// Definitions used by the checks (aligned check by check with the merged app port, B3, PR #56):
//   text       = sentences joined with ' ' (nothing is stripped: a [pNNN] pause marker counts as a word and its
//                digits count as a number; keep pause markers out of authored scripts or quote the digits)
//   words(s)   = number of whitespace-separated tokens of s (s.split(/\s+/) without empty tokens)
//   cjk(s)     = number of chars of s in [一-鿿] (U+4E00..U+9FFF)
//   size(s)    = cjk(s) for zh, words(s) for en/pl
//   letters(s) = chars of s matching /\p{L}/u
//
// Checks, in this order (a check that does not apply to the narration is skipped and does not count):
//  1 schema          all tiers. id, poiId, personaId are strings and id === `${poiId}:${personaId}:${lang}:${length}`;
//                    lang in en|pl|zh; length in teaser|full|deep; tier in reviewed|grounded-ai|source-extract|
//                    name-only; sentences is a non-empty array of strings that are non-empty after trim(); sources
//                    and claims are arrays; every sources[] id resolves in ctx.sourceIds; every claim is an object
//                    with a string quote and a sourceId that resolves; tier reviewed => reviewedBy with a non-empty
//                    reviewer string, an `at` string and status in approved|edited; generatedBy.kind in
//                    llm|human|extract|template|mt. A schema failure stops validation.
//  2 length          reviewed, grounded-ai. size(text) within: teaser 15-60 words / 40-150 zh chars;
//                    full 120-420 / 300-1000; deep 0-900 / 0-2200 (inclusive bounds).
//  3 sentence_length reviewed, grounded-ai. every sentence: size <= 45 (zh <= 110).
//  4 extract_size    source-extract. sentences.length <= 6 and size(text) <= 160 (zh <= 500).
//  5 total_chars     all tiers. text.length < 10000 (UTF-16 code units, the TTS limit).
//  6 lang            all tiers except name-only. On `text` with every non-empty ctx.poiNames entry (longest first,
//                    case-sensitive, all occurrences) replaced by ' ':
//                      zh: letters > 0 and cjk / letters >= 0.6;
//                      en: letters > 0 and ASCII letters [A-Za-z] / letters >= 0.95 and enStop > plStop;
//                      pl: plStop > enStop or the text contains one of ąćęłńóśźżĄĆĘŁŃÓŚŹŻ.
//                    enStop/plStop = count of the lowercased words (text.toLowerCase().split(/[^\p{L}]+/u))
//                    that are in EN_STOPWORDS / PL_STOPWORDS (whole-word matches, each occurrence counts).
//  7 numbers         reviewed, grounded-ai, and generatedBy.kind === 'mt' when ctx.translatedFromTier ===
//                    'reviewed'. Every number token (/\d+/g) of `text` is a substring of at least one
//                    claims[].quote ("14" is found in a quote that says "1498").
//  8 proper_nouns    reviewed, grounded-ai, in en or pl. For every sentence, tokens = whitespace split, each
//                    stripped of leading/trailing non-letters (/^[^\p{L}]+|[^\p{L}]+$/gu), empty tokens dropped. A
//                    candidate is a token after the first one of its sentence whose first char c is a cased capital
//                    (c === c.toUpperCase() && c !== c.toLowerCase()). At least 85 % of the candidates must be a
//                    case-sensitive substring of a claims[].quote, a ctx.poiNames entry or a PROPER_NOUN_ALLOWLIST
//                    entry. Vacuously true with no candidates. (A possessive is not stripped: "Kraków's" != "Kraków".)
//  9 claims_quote    only when ctx.sourceTexts is given (pipeline). Every claims[].quote is a substring of
//                    ctx.sourceTexts[claim.sourceId] (missing text => fail). Vacuously true with no claims.
// 10 forbidden       all tiers, on text: any of FORBIDDEN_PATTERNS (URL; # * _ ` { }; a '[' that does not start a
//                    [pNNN] marker; TODO as a word; "as an ai", "i cannot" anywhere; the hedges reportedly / it is
//                    said / allegedly / legend has it as words; the absolute directions anywhere, case-insensitive).
//
// Fallback (pipeline, selectNarration): candidates for one POI/persona/lang/length are tried best tier first
// (grounded-ai/reviewed -> source-extract -> name-only); the first that passes is emitted. Its validation is
// { status: 'pass', checks: <applied check ids> } when it was the first candidate, else
// { status: 'fallback', checks: <failed check ids of the rejected candidates, in check order> }.

import { LANGS, LENGTHS, TIER_ORDER } from './schema.mjs';

export const VALIDATOR_VERSION = 1;

export const CHECK_IDS = Object.freeze([
  'schema', 'length', 'sentence_length', 'extract_size', 'total_chars', 'lang', 'numbers', 'proper_nouns', 'claims_quote',
  'forbidden',
]);

export const LENGTH_LIMITS = Object.freeze({
  teaser: { words: [15, 60], zh: [40, 150] },
  full: { words: [120, 420], zh: [300, 1000] },
  deep: { words: [0, 900], zh: [0, 2200] },
});
export const MAX_SENTENCE = Object.freeze({ words: 45, zh: 110 });
export const MAX_EXTRACT = Object.freeze({ sentences: 6, words: 160, zh: 500 });
export const MAX_TOTAL_CHARS = 10000;
export const ZH_MIN_CJK_RATIO = 0.6;
export const EN_MIN_ASCII_RATIO = 0.95;
export const PROPER_NOUN_MIN_RATIO = 0.85;

export const EN_STOPWORDS = Object.freeze([
  'the', 'and', 'of', 'is', 'was', 'in', 'for', 'with', 'on', 'as', 'by', 'from', 'this', 'that', 'which', 'were', 'are', 'it',
]);
export const PL_STOPWORDS = Object.freeze([
  'się', 'nie', 'jest', 'w', 'z', 'na', 'oraz', 'który', 'która', 'było', 'był', 'była', 'do', 'że', 'jak', 'przez', 'od',
  'po', 'ze',
]);
export const PROPER_NOUN_ALLOWLIST = Object.freeze([
  'Kraków', 'Krakow', 'Poland', 'Polish', 'Vistula', 'Wawel', 'Rynek', 'Old Town', 'Main Square', 'UNESCO', 'Royal Route',
  'Gothic', 'Renaissance', 'Baroque', 'Romanesque', 'Catholic', 'Jagiellonian',
]);
/** Same list and same regexes as the app's NarrationValidator.ets (B3). */
export const FORBIDDEN_PATTERNS = Object.freeze([
  /https?:\/\//i,
  /[#*_`{}]/,
  /\[(?!p\d+\])/,
  /\bTODO\b/i, /as an ai/i, /i cannot/i,
  /\breportedly\b/i, /\bit is said\b/i, /\ballegedly\b/i, /\blegend has it\b/i,
  /on your left/i, /on your right/i, /to your left/i, /to your right/i, /behind you/i,
  /po lewej/i, /po prawej/i, /za tobą/i,
  /左边/, /右边/, /左侧/, /右侧/,
]);

const TIERS = new Set(TIER_ORDER);
const PROVENANCE_KINDS = new Set(['llm', 'human', 'extract', 'template', 'mt']);
const REVIEW_STATUSES = new Set(['approved', 'edited']);
const AUTHORED = new Set(['reviewed', 'grounded-ai']);
const EN_SET = new Set(EN_STOPWORDS);
const PL_SET = new Set(PL_STOPWORDS);
const CJK_RE = /[\u4e00-\u9fff]/g;
const LETTER_RE = /\p{L}/gu;
const ASCII_LETTER_RE = /[A-Za-z]/g;
const PL_DIACRITIC_RE = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;

// ---------------------------------------------------------------------------------------------
// Measures (exported: the extract stage sizes its texts with the same functions)

export function wordCount(s) {
  return s.split(/\s+/).filter((t) => t.length > 0).length;
}

export function cjkCount(s) {
  return (s.match(CJK_RE) || []).length;
}

export function sizeOf(s, lang) {
  return lang === 'zh' ? cjkCount(s) : wordCount(s);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

// ---------------------------------------------------------------------------------------------
// Checks

function checkSchema(n, ctx) {
  if (!isObj(n)) return false;
  if (typeof n.id !== 'string' || typeof n.poiId !== 'string' || typeof n.personaId !== 'string') return false;
  if (!LANGS.includes(n.lang) || !LENGTHS.includes(n.length) || !TIERS.has(n.tier)) return false;
  if (n.id !== `${n.poiId}:${n.personaId}:${n.lang}:${n.length}`) return false;
  if (!Array.isArray(n.sentences) || n.sentences.length === 0) return false;
  if (!n.sentences.every((s) => typeof s === 'string' && s.trim().length > 0)) return false;
  if (!Array.isArray(n.sources) || !Array.isArray(n.claims)) return false;
  const ids = ctx.sourceIds instanceof Set ? ctx.sourceIds : new Set(ctx.sourceIds ?? []);
  if (!n.sources.every((id) => ids.has(id))) return false;
  for (const c of n.claims) {
    if (!isObj(c) || typeof c.quote !== 'string' || !ids.has(c.sourceId)) return false;
  }
  if (n.tier === 'reviewed') {
    const r = n.reviewedBy;
    if (!isObj(r) || !nonEmptyString(r.reviewer) || typeof r.at !== 'string' || !REVIEW_STATUSES.has(r.status)) return false;
  }
  if (!isObj(n.generatedBy) || !PROVENANCE_KINDS.has(n.generatedBy.kind)) return false;
  return true;
}

function checkLength(n, text) {
  const [lo, hi] = LENGTH_LIMITS[n.length][n.lang === 'zh' ? 'zh' : 'words'];
  const size = sizeOf(text, n.lang);
  return size >= lo && size <= hi;
}

function checkSentenceLength(n) {
  const max = n.lang === 'zh' ? MAX_SENTENCE.zh : MAX_SENTENCE.words;
  return n.sentences.every((s) => sizeOf(s, n.lang) <= max);
}

function checkExtractSize(n, text) {
  if (n.sentences.length > MAX_EXTRACT.sentences) return false;
  return sizeOf(text, n.lang) <= (n.lang === 'zh' ? MAX_EXTRACT.zh : MAX_EXTRACT.words);
}

export function removeNames(text, names) {
  // Longest first; equal lengths keep their input order (a stable sort, like the app's LangDetect.stripNames).
  const sorted = (names ?? []).filter((s) => typeof s === 'string' && s.length > 0).sort((a, b) => b.length - a.length);
  let out = text;
  for (const name of sorted) out = out.split(name).join(' ');
  return out;
}

/** The lang heuristic on an already name-stripped text (exported for tests and the extract stage). */
export function langMatches(text, lang) {
  const letters = (text.match(LETTER_RE) || []).length;
  if (letters === 0) return false;
  if (lang === 'zh') return cjkCount(text) / letters >= ZH_MIN_CJK_RATIO;
  let en = 0;
  let pl = 0;
  for (const w of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (EN_SET.has(w)) en++;
    if (PL_SET.has(w)) pl++;
  }
  if (lang === 'en') return (text.match(ASCII_LETTER_RE) || []).length / letters >= EN_MIN_ASCII_RATIO && en > pl;
  if (lang === 'pl') return pl > en || PL_DIACRITIC_RE.test(text);
  return false;
}

function checkNumbers(n, text) {
  const quotes = n.claims.map((c) => c.quote);
  return (text.match(/\d+/g) || []).every((m) => quotes.some((q) => q.includes(m)));
}

export function properNounCandidates(sentence) {
  const tokens = sentence
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
    .filter((t) => t.length > 0);
  return tokens.filter((t, i) => {
    const c = t.charAt(0);
    return i > 0 && c === c.toUpperCase() && c !== c.toLowerCase();
  });
}

function checkProperNouns(n, ctx) {
  const candidates = n.sentences.flatMap(properNounCandidates);
  if (candidates.length === 0) return true;
  const hay = [...n.claims.map((c) => c.quote), ...(ctx.poiNames ?? []), ...PROPER_NOUN_ALLOWLIST];
  const found = candidates.filter((t) => hay.some((h) => typeof h === 'string' && h.includes(t))).length;
  return found / candidates.length >= PROPER_NOUN_MIN_RATIO;
}

function checkClaimsQuote(n, ctx) {
  const texts = ctx.sourceTexts;
  const get = (id) => (texts instanceof Map ? texts.get(id) : Object.hasOwn(texts, id) ? texts[id] : undefined);
  return n.claims.every((c) => {
    const t = get(c.sourceId);
    return typeof t === 'string' && t.includes(c.quote);
  });
}

function checkForbidden(text) {
  return !FORBIDDEN_PATTERNS.some((re) => re.test(text));
}

/** Which checks apply to a (schema-valid) narration. */
export function applicableChecks(n, ctx = {}) {
  const out = ['schema'];
  const authored = AUTHORED.has(n.tier);
  if (authored) out.push('length', 'sentence_length');
  if (n.tier === 'source-extract') out.push('extract_size');
  out.push('total_chars');
  if (n.tier !== 'name-only') out.push('lang');
  if (authored || (n.generatedBy?.kind === 'mt' && ctx.translatedFromTier === 'reviewed')) out.push('numbers');
  if (authored && (n.lang === 'en' || n.lang === 'pl')) out.push('proper_nouns');
  if (ctx.sourceTexts != null) out.push('claims_quote');
  out.push('forbidden');
  return out;
}

/** Spec v1. Pure. */
export function validateNarration(n, ctx = {}) {
  if (!checkSchema(n, ctx)) return { ok: false, failed: ['schema'], firstFailed: 'schema', applied: ['schema'] };
  const text = n.sentences.join(' ');
  const applied = applicableChecks(n, ctx);
  const failed = [];
  for (const id of applied) {
    let pass = true;
    switch (id) {
      case 'schema':
        break;
      case 'length':
        pass = checkLength(n, text);
        break;
      case 'sentence_length':
        pass = checkSentenceLength(n);
        break;
      case 'extract_size':
        pass = checkExtractSize(n, text);
        break;
      case 'total_chars':
        pass = text.length < MAX_TOTAL_CHARS;
        break;
      case 'lang':
        pass = langMatches(removeNames(text, ctx.poiNames), n.lang);
        break;
      case 'numbers':
        pass = checkNumbers(n, text);
        break;
      case 'proper_nouns':
        pass = checkProperNouns(n, ctx);
        break;
      case 'claims_quote':
        pass = checkClaimsQuote(n, ctx);
        break;
      case 'forbidden':
        pass = checkForbidden(text);
        break;
      default:
        throw new Error(`unknown check ${id}`);
    }
    if (!pass) failed.push(id);
  }
  return { ok: failed.length === 0, failed, firstFailed: failed[0] ?? null, applied };
}

// ---------------------------------------------------------------------------------------------
// Pipeline: fallback selection and the validation report

/**
 * Picks the first passing candidate (candidates must be ordered best tier first) and stamps its
 * `validation`. Returns { narration | null, attempts: [{ tier, ok, failed }] }.
 */
export function selectNarration(candidates, ctx) {
  const attempts = [];
  const failedIds = new Set();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const r = validateNarration(c, ctx);
    attempts.push({ tier: c?.tier ?? null, ok: r.ok, failed: r.failed });
    if (r.ok) {
      const validation =
        i === 0
          ? { status: 'pass', checks: r.applied, validatorVersion: VALIDATOR_VERSION }
          : { status: 'fallback', checks: CHECK_IDS.filter((id) => failedIds.has(id)), validatorVersion: VALIDATOR_VERSION };
      return { narration: { ...c, validation }, attempts };
    }
    for (const f of r.failed) failedIds.add(f);
  }
  return { narration: null, attempts };
}

/** validation-report.json content (deterministic: entries sorted by narration id). */
export function buildReport(results) {
  const counts = {};
  for (const lang of LANGS) {
    counts[lang] = {};
    for (const t of TIER_ORDER) counts[lang][t] = 0;
  }
  const failures = [];
  const dropped = [];
  const failuresByCheck = Object.fromEntries(CHECK_IDS.map((id) => [id, 0]));
  let pass = 0;
  let fallback = 0;
  for (const r of [...results].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const rejected = r.attempts.filter((a) => !a.ok);
    for (const a of rejected) {
      failures.push({ id: r.id, tier: a.tier, firstFailed: a.failed[0], failed: a.failed, emittedTier: r.narration?.tier ?? null });
      for (const f of a.failed) failuresByCheck[f]++;
    }
    if (!r.narration) {
      dropped.push(r.id);
      continue;
    }
    counts[r.narration.lang][r.narration.tier]++;
    if (r.narration.validation.status === 'pass') pass++;
    else fallback++;
  }
  return {
    validatorVersion: VALIDATOR_VERSION,
    summary: {
      narrations: pass + fallback,
      pass,
      fallback,
      dropped: dropped.length,
      rejectedCandidates: failures.length,
      failuresByCheck,
    },
    counts,
    failures,
    dropped,
  };
}
