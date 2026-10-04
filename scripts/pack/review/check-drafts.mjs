#!/usr/bin/env node
// B7 self-check for the Historian review files scripts/pack/review/<courseId>/<poiId>.<lang>.md (format:
// scripts/pack/prompts/historian-v1.md §9). Node 22+ ESM, stdlib only.
//
// Usage: node scripts/pack/review/check-drafts.mjs [--course <courseId>] [file.md ...]
//        node scripts/pack/review/check-drafts.mjs [--course <courseId>] --hash <poiId> ...   (sourceSha256 for a fresh translation)
//   --course (default krakow) picks the tour, its review dir scripts/pack/review/<courseId>/ and its wiki stop texts
//   (scripts/pack/lib/course.mjs). No file arguments: every <poiId>.<lang>.md of that course, plus coverage (every tour stop has an en
//   file, >= 3 en files have a deep section). Prints a per-file PASS/FAIL table; exit 1 on any failure.
//
// Each teaser/full/deep section is checked with validator spec v1 (docs/ARCHITECTURE.md §7.4, the same
// rules as scripts/pack/80-validate.mjs and the app's NarrationValidator), using the file's claims:
//   length          teaser 15-60, full 120-420, deep 0-900 (en/pl words; zh: 40-150 / 300-1000 / 0-2200 CJK chars)
//   sentence_length every sentence <= 45 words (zh <= 110 chars)
//   total_chars     raw text < 10000 chars
//   lang            after removing the stop's names: en = ASCII letters >= 95 % and en stopwords > pl stopwords
//   numbers         every /\d+/ token of the text equals a /\d+/ token of some claim quote
//   proper_nouns    (en, pl) >= 85 % of capitalised non-sentence-initial tokens are a substring of a claim
//                   quote, a stop name or an allowlist entry
//   forbidden       URLs, # * _ ` { }, '[' other than [pNNN], TODO, "As an AI", "I cannot", hedges, absolute
//                   directions
// plus review-file checks:
//   one_sentence    each line of a section is one sentence ending in . ! or ? (the build splits on lines)
//   claims_quote    every quote is an exact substring of the cited source text (data/raw/wiki/stops-text-<lang>.json
//                   or summaries-<lang>.json, matched by title + revision id) and has >= 2 words
//   meta / format   front matter, required sections, review state (empty reviewed => status draft; filled
//                   reviewed "<initials> <YYYY-MM-DD>" => status approved|edited), view hint
//   tone            only for stops marked `"sensitive": true` in the tour file (review-only key; the Kazimierz
//                   synagogues, docs/research/new-tours.md §2.2): no exclamation mark and none of SENSITIVE_FORBIDDEN
//                   (trivia, joke, superlative-hype and game/prize words, en/pl/zh) in any section or the view hint
//
// Machine translations (<poiId>.pl.md / .zh.md with `generatedBy: mt`, prompt scripts/pack/prompts/translate-v1.md):
//   the same section checks, run with the EN file's claims plus the translation's own (optional) claims; front
//   matter needs translatedFrom: en, translated: <YYYY-MM-DD> and sourceSha256 = scriptHash() of the EN text it
//   was translated from. When the EN text has changed since (a human edited it), the file is reported as STALE
//   (a warning, not a failure): ask an agent to refresh that translation (scripts/pack/review/README.md).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { courseFromArgv, resolveCourse } from '../lib/course.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../../..');
/** Review dir of the default course (krakow = The Royal Route). */
export const REVIEW_DIR = join(HERE, 'krakow');
const DEFAULT_COURSE = resolveCourse();

// ---------------------------------------------------------------------------------------------
// Validator spec v1 constants (identical to scripts/pack/80-validate.mjs)

export const LENGTH_LIMITS = Object.freeze({
  teaser: { words: [15, 60], zh: [40, 150] },
  full: { words: [120, 420], zh: [300, 1000] },
  deep: { words: [0, 900], zh: [0, 2200] },
});
export const MAX_SENTENCE = Object.freeze({ words: 45, zh: 110 });
export const MAX_TOTAL_CHARS = 10000;
export const EN_MIN_ASCII_RATIO = 0.95;
export const ZH_MIN_CJK_RATIO = 0.6;
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
export const FORBIDDEN_WORDS = Object.freeze([
  'TODO', 'As an AI', 'I cannot',
  'reportedly', 'it is said', 'allegedly', 'legend has it',
  'on your left', 'on your right', 'to your left', 'to your right', 'behind you', 'po lewej', 'po prawej', 'za tobą',
  '左边', '右边', '左侧', '右侧',
]);

/**
 * Tone rule for sensitive stops (Holocaust, pogrom, places of worship and remembrance; docs/research/new-tours.md
 * §2.2): words that frame the place as trivia, entertainment or a game. Matched case-insensitively; ASCII entries as
 * whole-word prefixes (so "joke" also catches "jokes"), others as substrings. Exclamation marks are rejected too.
 */
export const SENSITIVE_FORBIDDEN = Object.freeze([
  'fun fact', 'funny', 'joke', 'trivia', 'did you know', 'amazing', 'incredible', 'awesome', 'exciting',
  'fascinating', 'thrilling', 'spooky', 'prize', 'reward', 'bonus', 'points', 'unlock', 'badge',
  'ciekawostk', 'zabawn', 'żart', 'niesamowit', 'nagrod', 'bonus', 'odblokuj', 'ekscytując', 'fascynując',
  '趣闻', '有趣', '好玩', '笑话', '奖品', '奖励', '积分', '解锁', '惊人', '神奇', '刺激',
]);
const SENSITIVE_RES = [...new Set(SENSITIVE_FORBIDDEN)].map((w) =>
  /^[\x20-\x7e]+$/.test(w)
    ? { word: w, test: (raw) => new RegExp(`\\b${w}`, 'i').test(raw) }
    : { word: w, test: (raw) => raw.toLowerCase().includes(w.toLowerCase()) },
);

/** Tone hits (sensitive stops only): exclamation marks and SENSITIVE_FORBIDDEN words in `raw`. */
export function toneHits(raw) {
  const hits = [];
  if (/[!！]/.test(raw)) hits.push('exclamation mark');
  for (const r of SENSITIVE_RES) if (r.test(raw)) hits.push(`"${r.word}"`);
  return hits;
}

export const SECTIONS = Object.freeze(['teaser', 'full', 'deep']);
export const LANGS = Object.freeze(['en', 'pl', 'zh']);
export const STATUSES_REVIEWED = Object.freeze(['approved', 'edited']);
export const LOOKS = Object.freeze(['up', 'level', 'down']);
export const MIN_DEEP_FILES = 3;

const EN_SET = new Set(EN_STOPWORDS);
const PL_SET = new Set(PL_STOPWORDS);
const PAUSE_RE = /\[p\d+\]/g;
const CJK_RE = /[一-鿿]/g;
const LETTER_RE = /\p{L}/gu;
const ASCII_LETTER_RE = /[A-Za-z]/g;
const PL_DIACRITIC_RE = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;
const SOURCE_ID_RE = /^wp:(en|pl|zh):(.+)@(\d+)$/;
const FILE_RE = /^([A-Za-z0-9_]+)\.(en|pl|zh)\.md$/;
const FORBIDDEN_RES = FORBIDDEN_WORDS.map((w) =>
  /^[\x20-\x7e]+$/.test(w)
    ? { word: w, test: (raw) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(raw) }
    : { word: w, test: (raw) => raw.toLowerCase().includes(w.toLowerCase()) },
);

// ---------------------------------------------------------------------------------------------
// Measures (same definitions as 80-validate.mjs)

export const stripPauses = (s) => s.replace(PAUSE_RE, ' ');
export const wordCount = (s) => s.split(/\s+/).filter((t) => t.length > 0).length;
export const cjkCount = (s) => (s.match(CJK_RE) || []).length;
export const sizeOf = (s, lang) => (lang === 'zh' ? cjkCount(s) : wordCount(s));

export function removeNames(text, names) {
  const sorted = [...new Set((names ?? []).filter((s) => typeof s === 'string' && s.length > 0))].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  let out = text;
  for (const name of sorted) out = out.split(name).join(' ');
  return out;
}

export function stopwordCounts(text) {
  let en = 0;
  let pl = 0;
  for (const w of text.toLowerCase().split(/[^\p{L}]+/u)) {
    if (EN_SET.has(w)) en++;
    if (PL_SET.has(w)) pl++;
  }
  return { en, pl };
}

export function langMatches(text, lang) {
  const letters = (text.match(LETTER_RE) || []).length;
  if (letters === 0) return false;
  if (lang === 'zh') return cjkCount(text) / letters >= ZH_MIN_CJK_RATIO;
  const { en, pl } = stopwordCounts(text);
  if (lang === 'en') return (text.match(ASCII_LETTER_RE) || []).length / letters >= EN_MIN_ASCII_RATIO && en > pl;
  if (lang === 'pl') return pl > en || PL_DIACRITIC_RE.test(text);
  return false;
}

export function properNounCandidates(sentence) {
  const tokens = stripPauses(sentence)
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').replace(/['’]s$/u, ''))
    .filter((t) => t.length > 0);
  return tokens.filter((t, i) => i > 0 && /^\p{Lu}/u.test(t));
}

// ---------------------------------------------------------------------------------------------
// Review state and translation freshness (shared with scripts/pack/70-narrate.mjs)

export const REVIEWED_RE = /^(\S+) (\d{4}-\d{2}-\d{2})$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * The review state of a file's front matter: { reviewed: false } for a draft, { reviewed: true, review:
 * {reviewer, at, status} } for a human-reviewed file, or { error } when the two lines disagree (a filled
 * `reviewed:` without approved|edited, or approved|edited without a filled `reviewed:`).
 */
export function reviewState(meta) {
  const reviewed = meta.reviewed ?? '';
  const status = meta.status ?? '';
  if (reviewed === '') {
    if (status !== 'draft') return { error: `reviewed is empty, so status must be draft (got ${status || '(empty)'})` };
    return { reviewed: false };
  }
  const m = REVIEWED_RE.exec(reviewed);
  if (!m) return { error: 'reviewed must be "<initials> <YYYY-MM-DD>"' };
  if (!STATUSES_REVIEWED.includes(status)) return { error: `a reviewed file needs status approved|edited (got ${status || '(empty)'})` };
  return { reviewed: true, review: { reviewer: m[1], at: m[2], status } };
}

/** True when the file is a machine translation (front matter `generatedBy: mt`). */
export const isTranslation = (meta) => meta.generatedBy === 'mt';

/**
 * SHA-256 (hex) of the script text of a parsed EN file: the teaser, full and deep sentences, in order. Claims,
 * notes, view hint and front matter are not part of it, so approving a file without editing it keeps its
 * translations fresh, and a text edit makes them stale.
 */
export function scriptHash(parsed) {
  const body = JSON.stringify(SECTIONS.map((s) => parsed.sections[s] ?? []));
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Claims a translation is checked (and emitted) with: the EN file's claims, then the translation's own. */
export function translationClaims(parsed, enParsed) {
  return [...(enParsed?.claims ?? []), ...parsed.claims];
}

// ---------------------------------------------------------------------------------------------
// Parsing

function sectionKey(heading) {
  return heading.replace(/\(.*\)\s*$/, '').trim().toLowerCase();
}

/**
 * Parses a review file. Returns { meta, sections: {teaser, full, deep}: string[] (sentences, one per line),
 * paragraphs: {teaser, full, deep}: string[][], claims: [{text, source, quote, line}], view: {look, feature},
 * notes: {drafting, reviewer}, errors: string[] }.
 */
export function parseReviewFile(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const errors = [];
  const meta = {};
  const out = { meta, sections: {}, paragraphs: {}, claims: [], view: {}, notes: {}, errors };
  if (lines[0] !== '---') {
    errors.push('front matter must start with a "---" line');
    return out;
  }
  const end = lines.indexOf('---', 1);
  if (end < 0) {
    errors.push('front matter is not closed with a "---" line');
    return out;
  }
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const m = /^([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (!m) {
      errors.push(`front matter line ${i + 1} is not "key: value"`);
      continue;
    }
    let v = m[2];
    const hash = v.search(/(^|\s)#/);
    if (hash >= 0) v = v.slice(0, hash);
    meta[m[1]] = v.trim();
  }

  const bodies = new Map();
  let current = null;
  for (let i = end + 1; i < lines.length; i++) {
    const h = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (h) {
      current = sectionKey(h[1]);
      if (bodies.has(current)) errors.push(`section "## ${current}" appears twice`);
      bodies.set(current, []);
      continue;
    }
    if (current === null) {
      if (lines[i].trim() !== '') errors.push(`line ${i + 1} is outside any "## section"`);
      continue;
    }
    bodies.get(current).push({ text: lines[i], line: i + 1 });
  }

  for (const s of SECTIONS) {
    if (!bodies.has(s)) continue;
    const paras = [];
    let para = [];
    for (const { text } of bodies.get(s)) {
      const t = text.trim();
      if (t === '') {
        if (para.length) paras.push(para);
        para = [];
      } else para.push(t);
    }
    if (para.length) paras.push(para);
    out.paragraphs[s] = paras;
    out.sections[s] = paras.flat();
  }

  if (bodies.has('claims')) {
    let claim = null;
    for (const { text, line } of bodies.get('claims')) {
      if (text.trim() === '') continue;
      const m = /^(\s*-\s+|\s+)(text|source|quote):\s?(.*)$/.exec(text);
      if (!m) {
        errors.push(`claims line ${line} is not "- text:", "  source:" or "  quote:"`);
        continue;
      }
      const [, lead, key, rawValue] = m;
      if (lead.trim() === '-') {
        claim = { line };
        out.claims.push(claim);
      } else if (claim === null) {
        errors.push(`claims line ${line}: "${key}" before the first "- text:"`);
        continue;
      }
      if (key in claim) errors.push(`claims line ${line}: duplicate "${key}"`);
      let value = rawValue.trim();
      if (key === 'quote') {
        if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
          errors.push(`claims line ${line}: quote must be wrapped in double quotes`);
          continue;
        }
        value = rawValue.trim().slice(1, -1);
      }
      claim[key] = value;
    }
  }

  if (bodies.has('view hint')) {
    for (const { text, line } of bodies.get('view hint')) {
      if (text.trim() === '') continue;
      const m = /^(look|feature):\s*(.*)$/.exec(text.trim());
      if (!m) errors.push(`view hint line ${line} is not "look:" or "feature:"`);
      else out.view[m[1]] = m[2].trim();
    }
  }
  for (const [key, name] of [['drafting notes', 'drafting'], ['reviewer notes', 'reviewer']]) {
    if (bodies.has(key)) out.notes[name] = bodies.get(key).map((l) => l.text).join('\n').trim();
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Context: sources and tour

/** Map sourceId -> string[] (stop text and/or summary extract with that title + revision). */
export function loadSources(repo = REPO, course = DEFAULT_COURSE) {
  const map = new Map();
  const add = (id, text) => {
    if (typeof text !== 'string') return;
    if (!map.has(id)) map.set(id, []);
    map.get(id).push(text);
  };
  for (const lang of LANGS) {
    const stops = JSON.parse(readFileSync(join(repo, 'data/raw', course.rawRel(`wiki/stops-text-${lang}.json`)), 'utf8'));
    for (const p of Object.values(stops.pages)) add(`wp:${lang}:${p.title}@${p.revid}`, p.text);
    const sums = JSON.parse(readFileSync(join(repo, `data/raw/wiki/summaries-${lang}.json`), 'utf8'));
    for (const p of Object.values(sums.pages)) add(`wp:${lang}:${p.title}@${p.revision}`, p.extract);
  }
  return map;
}

/** Map poiId -> tour stop (from the course's tour file, default data/tours/royal-route.json), in tour order. */
export function loadStops(repo = REPO, course = DEFAULT_COURSE) {
  const tour = JSON.parse(readFileSync(join(repo, 'data/tours', basename(course.tourFile)), 'utf8'));
  return new Map(tour.stops.map((s) => [s.poiId, s]));
}

// ---------------------------------------------------------------------------------------------
// Checks

/** Spec v1 checks of one section. Returns [{check, detail}]. */
export function checkSection(length, sentences, lang, claims, names) {
  const fails = [];
  const fail = (check, detail) => fails.push({ check, detail });
  const raw = sentences.join(' ');
  const text = stripPauses(raw);
  const unit = lang === 'zh' ? 'zh' : 'words';

  const [lo, hi] = LENGTH_LIMITS[length][unit];
  const size = sizeOf(text, lang);
  if (sentences.length === 0) fail('length', 'section is empty');
  else if (size < lo || size > hi) fail('length', `${size} ${unit === 'zh' ? 'chars' : 'words'}, allowed ${lo}-${hi}`);

  const maxS = MAX_SENTENCE[unit];
  sentences.forEach((s, i) => {
    const n = sizeOf(stripPauses(s), lang);
    if (n > maxS) fail('sentence_length', `sentence ${i + 1} has ${n} (max ${maxS})`);
  });

  if (raw.length >= MAX_TOTAL_CHARS) fail('total_chars', `${raw.length} chars`);

  // One sentence per line, ending with . ! or ? (optionally followed by a closing quote).
  sentences.forEach((s, i) => {
    const t = stripPauses(s).trim();
    if (lang !== 'zh') {
      if (!/[.!?]["'’”]?$/.test(t)) fail('one_sentence', `line ${i + 1} does not end with . ! or ?`);
      if (/[.!?]["'’”)]?\s+["'“‘(]?\p{Lu}/u.test(t)) fail('one_sentence', `line ${i + 1} holds more than one sentence`);
    } else if (!/[。！？]["'’”」]?$/.test(t)) fail('one_sentence', `line ${i + 1} does not end with 。！？`);
  });

  const stripped = removeNames(text, names);
  if (!langMatches(stripped, lang)) {
    const letters = (stripped.match(LETTER_RE) || []).length;
    const ascii = (stripped.match(ASCII_LETTER_RE) || []).length;
    const sw = stopwordCounts(stripped);
    fail('lang', `not ${lang}: ascii ${letters ? Math.round((100 * ascii) / letters) : 0} %, stopwords en ${sw.en} / pl ${sw.pl}`);
  }

  const allowed = new Set();
  for (const c of claims) for (const m of (c.quote ?? '').match(/\d+/g) || []) allowed.add(m);
  const missing = [...new Set((text.match(/\d+/g) || []).filter((m) => !allowed.has(m)))];
  if (missing.length) fail('numbers', `not in any claim quote: ${missing.join(', ')}`);

  if (lang === 'en' || lang === 'pl') {
    const candidates = sentences.flatMap(properNounCandidates);
    if (candidates.length) {
      const hay = [...claims.map((c) => c.quote ?? ''), ...names, ...PROPER_NOUN_ALLOWLIST];
      const unknown = candidates.filter((t) => !hay.some((h) => h.includes(t)));
      const ratio = (candidates.length - unknown.length) / candidates.length;
      if (ratio < PROPER_NOUN_MIN_RATIO) {
        fail('proper_nouns', `${Math.round(ratio * 100)} % grounded (min 85 %); ungrounded: ${[...new Set(unknown)].join(', ')}`);
      }
    }
  }

  const hits = [];
  if (/https?:\/\//i.test(raw)) hits.push('URL');
  for (const ch of raw.match(/[#*_`{}]/g) || []) hits.push(`"${ch}"`);
  if (raw.replace(PAUSE_RE, '').includes('[')) hits.push('"[" (only [pNNN] allowed)');
  for (const r of FORBIDDEN_RES) if (r.test(raw)) hits.push(`"${r.word}"`);
  if (hits.length) fail('forbidden', [...new Set(hits)].join(', '));
  return fails;
}

/**
 * Checks one parsed review file. ctx = { fileName, stops: Map, sources: Map }.
 * Returns { failures: [{where, check, detail}], words: {teaser, full, deep}, claims }.
 */
export function checkReview(parsed, ctx) {
  const failures = [];
  const fail = (where, check, detail) => failures.push({ where, check, detail });
  for (const e of parsed.errors) fail('file', 'format', e);
  const { meta } = parsed;

  // Front matter.
  const fm = FILE_RE.exec(ctx.fileName ?? '');
  if (!fm) fail('file', 'meta', `file name must be <poiId>.<en|pl|zh>.md, got ${ctx.fileName}`);
  const stop = ctx.stops.get(meta.poiId);
  if (!stop) fail('meta', 'meta', `poiId ${meta.poiId || '(empty)'} is not a stop of data/tours/royal-route.json`);
  if (fm && meta.poiId !== fm[1]) fail('meta', 'meta', `poiId ${meta.poiId} does not match the file name`);
  if (!LANGS.includes(meta.lang)) fail('meta', 'meta', `lang must be en|pl|zh, got ${meta.lang || '(empty)'}`);
  else if (fm && meta.lang !== fm[2]) fail('meta', 'meta', `lang ${meta.lang} does not match the file name`);
  if (meta.persona !== 'historian') fail('meta', 'meta', `persona must be historian, got ${meta.persona || '(empty)'}`);
  if (!meta.promptId) fail('meta', 'meta', 'promptId is empty');
  if (!meta.model) fail('meta', 'meta', 'model is empty');
  const mt = isTranslation(meta);
  const warnings = [];
  if (!mt) {
    if (meta.lang !== undefined && meta.lang !== 'en') fail('meta', 'meta', 'a pl/zh file must be a translation (generatedBy: mt)');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.drafted ?? '')) fail('meta', 'meta', 'drafted must be YYYY-MM-DD');
  } else {
    if (meta.lang === 'en') fail('meta', 'meta', 'an en file cannot be a translation');
    if (meta.translatedFrom !== 'en') fail('meta', 'meta', `translatedFrom must be en, got ${meta.translatedFrom || '(empty)'}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.translated ?? '')) fail('meta', 'meta', 'translated must be YYYY-MM-DD');
    if (!SHA256_RE.test(meta.sourceSha256 ?? '')) fail('meta', 'meta', 'sourceSha256 must be the 64-hex scriptHash of the EN text');
    if (!ctx.enParsed) fail('meta', 'meta', `no EN source file ${meta.poiId}.en.md for this translation`);
    else {
      const current = scriptHash(ctx.enParsed);
      if (SHA256_RE.test(meta.sourceSha256 ?? '') && meta.sourceSha256 !== current) {
        warnings.push(`STALE: the EN text changed since this translation (sourceSha256 ${meta.sourceSha256.slice(0, 12)}…, EN now ` +
          `${current.slice(0, 12)}…); ask an agent to refresh it (scripts/pack/review/README.md)`);
      }
      for (const s of SECTIONS) {
        const has = (p) => Array.isArray(p.sections[s]) && p.sections[s].length > 0;
        if (has(ctx.enParsed) !== has(parsed)) fail(s, 'format', `section "## ${s}" must be present exactly when the EN file has it`);
        else if (has(parsed) && parsed.sections[s].length !== ctx.enParsed.sections[s].length) {
          warnings.push(`${s}: ${parsed.sections[s].length} sentences, EN has ${ctx.enParsed.sections[s].length}`);
        }
      }
    }
  }
  if (!('reviewed' in meta)) fail('meta', 'meta', 'reviewed line is missing (leave it empty until a human reviews)');
  else {
    const st = reviewState(meta);
    if (st.error) fail('meta', 'review', st.error);
  }

  // Claims (a translation is checked with the EN claims plus its own).
  const claims = mt ? translationClaims(parsed, ctx.enParsed) : parsed.claims;
  if (claims.length === 0) fail('claims', 'claims_quote', 'no claims');
  parsed.claims.forEach((c, i) => {
    const where = `claim ${i + 1}`;
    for (const k of ['text', 'source', 'quote']) if (!c[k]) fail(where, 'claims_quote', `"${k}" is missing or empty`);
    if (!c.source || !c.quote) return;
    if (!SOURCE_ID_RE.test(c.source)) {
      fail(where, 'claims_quote', `source must be wp:<lang>:<title>@<revid>, got ${c.source}`);
      return;
    }
    const texts = ctx.sources.get(c.source);
    if (!texts) fail(where, 'claims_quote', `unknown source ${c.source} (title or revision id not in data/raw/wiki)`);
    else if (!texts.some((t) => t.includes(c.quote))) fail(where, 'claims_quote', `quote is not an exact substring of ${c.source}: "${c.quote.slice(0, 60)}"`);
    if (wordCount(c.quote) < 2) fail(where, 'claims_quote', `quote "${c.quote}" is shorter than 2 words`);
  });

  // Sections.
  const names = stop ? Object.values(stop.names ?? {}).filter((n) => typeof n === 'string') : [];
  const words = {};
  for (const s of SECTIONS) {
    const sentences = parsed.sections[s];
    const present = Array.isArray(sentences) && sentences.length > 0;
    if (!present) {
      if (s !== 'deep') fail(s, 'format', `section "## ${s}" is missing or empty`);
      continue;
    }
    words[s] = sizeOf(stripPauses(sentences.join(' ')), meta.lang);
    if (!LANGS.includes(meta.lang)) continue;
    for (const f of checkSection(s, sentences, meta.lang, claims, names)) fail(s, f.check, f.detail);
    if (stop?.sensitive === true) {
      const hits = toneHits(sentences.join(' '));
      if (hits.length) fail(s, 'tone', `sensitive stop: ${hits.join(', ')}`);
    }
  }

  // View hint.
  if (!LOOKS.includes(parsed.view.look)) fail('view hint', 'view', `look must be up|level|down, got ${parsed.view.look ?? '(missing)'}`);
  if (!parsed.view.feature) fail('view hint', 'view', 'feature is missing or empty');
  else {
    const raw = parsed.view.feature;
    if (/[#*_`{}[]/.test(raw) || FORBIDDEN_RES.some((r) => r.test(raw))) fail('view hint', 'view', 'feature contains a forbidden pattern');
    if (stop?.sensitive === true && toneHits(raw).length) fail('view hint', 'tone', `sensitive stop: ${toneHits(raw).join(', ')}`);
  }
  return { failures, warnings, words, claims: claims.length };
}

/** Repository-level coverage for one language: every tour stop has a file; >= 3 files have deep. */
export function checkCoverage(results, stops, lang = 'en') {
  const failures = [];
  const ofLang = results.filter((r) => r.lang === lang);
  for (const poiId of stops.keys()) {
    if (!ofLang.some((r) => r.poiId === poiId)) failures.push(`missing ${poiId}.${lang}.md`);
  }
  const deep = ofLang.filter((r) => r.words.deep !== undefined).length;
  if (deep < MIN_DEEP_FILES) failures.push(`only ${deep} ${lang} file(s) have a deep section (min ${MIN_DEEP_FILES})`);
  return failures;
}

export function reviewFiles(dir = REVIEW_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/** The parsed EN file next to a translation (null when there is none). */
export function enSourceOf(path, parsed) {
  if (!isTranslation(parsed.meta) || !parsed.meta.poiId) return null;
  const enPath = join(dirname(path), `${parsed.meta.poiId}.en.md`);
  return existsSync(enPath) ? parseReviewFile(readFileSync(enPath, 'utf8')) : null;
}

export function checkFile(path, ctx) {
  const fileName = basename(path);
  const parsed = parseReviewFile(readFileSync(path, 'utf8'));
  const enParsed = enSourceOf(path, parsed);
  const r = checkReview(parsed, { ...ctx, fileName, enParsed });
  // A translation's effective review state is its EN source's (the pack tier follows the EN review).
  const status = enParsed ? `${enParsed.meta.status}*` : parsed.meta.status;
  return { file: fileName, poiId: parsed.meta.poiId, lang: parsed.meta.lang, status, ...r };
}

// ---------------------------------------------------------------------------------------------
// CLI

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

export function main(argv = process.argv.slice(2), repo = REPO) {
  const { course, rest } = courseFromArgv(argv);
  argv = rest;
  const ctx = { stops: loadStops(repo, course), sources: loadSources(repo, course) };
  const all = argv.length === 0;
  const files = all ? reviewFiles(course.reviewDir) : argv.map((a) => resolve(a));
  const results = files.map((f) => checkFile(f, ctx));
  const order = [...ctx.stops.keys()];
  results.sort((a, b) => order.indexOf(a.poiId) - order.indexOf(b.poiId) || (a.file < b.file ? -1 : 1));

  const lines = [];
  lines.push(`${pad('file', 26)}${pad('stop', 28)}${pad('result', 8)}${pad('status', 9)}${pad('teaser', 8)}${pad('full', 6)}${pad('deep', 6)}claims`);
  for (const r of results) {
    const stop = ctx.stops.get(r.poiId);
    lines.push(
      `${pad(r.file, 26)}${pad(stop?.names?.en ?? '?', 28)}${pad(r.failures.length ? 'FAIL' : 'PASS', 8)}${pad(r.status ?? '?', 9)}` +
        `${pad(r.words.teaser ?? '-', 8)}${pad(r.words.full ?? '-', 6)}${pad(r.words.deep ?? '-', 6)}${r.claims}`,
    );
  }
  for (const r of results) for (const f of r.failures) lines.push(`  ${r.file}  [${f.where}] ${f.check}: ${f.detail}`);
  for (const r of results) for (const w of r.warnings ?? []) lines.push(`  ${r.file}  warning: ${w}`);
  if (results.some((r) => String(r.status).endsWith('*'))) lines.push('* translation: review state of its EN source (the pack tier follows it)');
  const notes = results.filter((r) => r.lang !== 'zh' && (r.words.full ?? 0) > 200).map((r) => `${r.file} full=${r.words.full}`);
  if (notes.length) lines.push(`note: full above the ~200-word demo target (REVIEW rec. 4, not a failure): ${notes.join(', ')}`);
  const coverage = all ? LANGS.flatMap((l) => (l === 'en' || results.some((r) => r.lang === l) ? checkCoverage(results, ctx.stops, l) : [])) : [];
  for (const c of coverage) lines.push(`  coverage: ${c}`);
  const failed = results.filter((r) => r.failures.length).length;
  const reviewed = results.filter((r) => STATUSES_REVIEWED.includes(String(r.status).replace(/\*$/, ''))).length;
  const stale = results.filter((r) => (r.warnings ?? []).some((w) => w.startsWith('STALE'))).length;
  lines.push(
    `${failed === 0 && coverage.length === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed}/${results.length} files pass` +
      `, ${reviewed} reviewed, ${results.length - reviewed} draft${stale ? `, ${stale} stale translation(s)` : ''}` +
      `${coverage.length ? `, ${coverage.length} coverage problem(s)` : ''}`,
  );
  return { ok: failed === 0 && coverage.length === 0, output: lines.join('\n'), results, coverage };
}

/** `--hash <poiId>...`: scriptHash of each EN file, the sourceSha256 a fresh translation records. */
export function hashLines(poiIds, dir = REVIEW_DIR) {
  return poiIds.map((id) => `${id} ${scriptHash(parseReviewFile(readFileSync(join(dir, `${id}.en.md`), 'utf8')))}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { course, rest } = courseFromArgv(process.argv.slice(2));
  if (rest[0] === '--hash') {
    console.log(hashLines(rest.slice(1), course.reviewDir).join('\n'));
    process.exit(0);
  }
  const { ok, output } = main();
  console.log(output);
  process.exitCode = ok ? 0 : 1;
}
