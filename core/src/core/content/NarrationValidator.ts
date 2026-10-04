/*
 * Narration validator, spec v1 (ARCHITECTURE §7.4; the "incorrect AI output" defence). Pure: no @kit imports.
 * The same rules run in the pipeline (scripts/pack/80-validate.mjs, task B2) and here, on every narration when it
 * is first about to be spoken or shown (memoised per narration id), so a hand-edited or corrupted pack still
 * can't speak garbage. Check ids, in order:
 *   schema, length, sentence_length, extract_size, total_chars, lang, numbers, proper_nouns, forbidden.
 * The pipeline-only check `claims_quote` (quote is a substring of the stored source text) is not run here:
 * the app does not ship source texts.
 */
import { ContentTier, Lang, Narration, NarrationLength, ProvenanceKind } from '../../contracts/Model';
import { langMatches } from './LangDetect';

export const VALIDATOR_VERSION: number = 1;

export class Check {
  static readonly SCHEMA: string = 'schema';
  static readonly LENGTH: string = 'length';
  static readonly SENTENCE_LENGTH: string = 'sentence_length';
  static readonly EXTRACT_SIZE: string = 'extract_size';
  static readonly TOTAL_CHARS: string = 'total_chars';
  static readonly LANG: string = 'lang';
  static readonly NUMBERS: string = 'numbers';
  static readonly PROPER_NOUNS: string = 'proper_nouns';
  static readonly FORBIDDEN: string = 'forbidden';
}

export class ValidationCtx {
  sourceIds: string[] = [];
  poiNames: string[] = [];
  /** City-specific proper nouns that count as grounded (city.json `properNouns`, e.g. the city's own name). */
  cityNouns: string[] = [];
  /** Tier of the English original when this narration is a machine translation (mt of reviewed => numbers). */
  translatedFromTier: string = '';
}

export class ValidationResult {
  ok: boolean = true;
  failed: string[] = [];
  firstFailed: string = '';
}

const LANGS: string[] = [Lang.EN, Lang.PL, Lang.ZH];
const LENGTHS: string[] = [NarrationLength.TEASER, NarrationLength.FULL, NarrationLength.DEEP];
const TIERS: string[] = [ContentTier.REVIEWED_HISTORIAN, ContentTier.GROUNDED_AI, ContentTier.SOURCE_EXTRACT,
  ContentTier.NAME_ONLY];
const PROV_KINDS: string[] = [ProvenanceKind.LLM, ProvenanceKind.HUMAN, ProvenanceKind.EXTRACT, ProvenanceKind.TEMPLATE,
  ProvenanceKind.MACHINE_TRANSLATION];
const REVIEW_STATUSES: string[] = ['approved', 'edited'];

/** City-independent proper nouns; a city adds its own (city.json `properNouns` -> ValidationCtx.cityNouns). */
export const PROPER_NOUN_ALLOWLIST: string[] = ['Old Town', 'Main Square', 'UNESCO', 'Gothic', 'Renaissance', 'Baroque',
  'Romanesque', 'Catholic'];

const FORBIDDEN_PATTERNS: RegExp[] = [
  /https?:\/\//i,
  /[#*_`{}]/,
  /\[(?!p\d+\])/,
  /\bTODO\b/i, /as an ai/i, /i cannot/i,
  /\breportedly\b/i, /\bit is said\b/i, /\ballegedly\b/i, /\blegend has it\b/i,
  /on your left/i, /on your right/i, /to your left/i, /to your right/i, /behind you/i,
  /po lewej/i, /po prawej/i, /za tobą/i,
  /左边/, /右边/, /左侧/, /右侧/
];

const CJK_CHAR: RegExp = /[一-鿿]/g;

/** Words (en/pl) or CJK characters (zh). */
export function measure(text: string, lang: string): number {
  if (lang === Lang.ZH) {
    const m = text.match(CJK_CHAR);
    return m === null ? 0 : m.length;
  }
  return text.split(/\s+/).filter((w: string) => w.length > 0).length;
}

function isAuthored(tier: string): boolean {
  return tier === ContentTier.REVIEWED_HISTORIAN || tier === ContentTier.GROUNDED_AI;
}

function lengthOk(len: string, lang: string, count: number): boolean {
  const zh = lang === Lang.ZH;
  if (len === NarrationLength.TEASER) {
    return zh ? count >= 40 && count <= 150 : count >= 15 && count <= 60;
  }
  if (len === NarrationLength.FULL) {
    return zh ? count >= 300 && count <= 1000 : count >= 120 && count <= 420;
  }
  return zh ? count <= 2200 : count <= 900;
}

function schemaOk(n: Narration, ctx: ValidationCtx): boolean {
  if (typeof n.id !== 'string' || typeof n.poiId !== 'string' || typeof n.personaId !== 'string') {
    return false;
  }
  if (LANGS.indexOf(n.lang) < 0 || LENGTHS.indexOf(n.length) < 0 || TIERS.indexOf(n.tier) < 0) {
    return false;
  }
  if (n.id !== `${n.poiId}:${n.personaId}:${n.lang}:${n.length}`) {
    return false;
  }
  if (!Array.isArray(n.sentences) || n.sentences.length === 0) {
    return false;
  }
  for (const s of n.sentences) {
    if (typeof s !== 'string' || s.trim().length === 0) {
      return false;
    }
  }
  if (!Array.isArray(n.sources) || !Array.isArray(n.claims)) {
    return false;
  }
  for (const id of n.sources) {
    if (ctx.sourceIds.indexOf(id) < 0) {
      return false;
    }
  }
  for (const c of n.claims) {
    if (c === undefined || c === null || typeof c.quote !== 'string' || ctx.sourceIds.indexOf(c.sourceId) < 0) {
      return false;
    }
  }
  if (n.tier === ContentTier.REVIEWED_HISTORIAN) {
    const r = n.reviewedBy;
    if (r === undefined || r === null || typeof r.reviewer !== 'string' || r.reviewer.length === 0 ||
      typeof r.at !== 'string' || REVIEW_STATUSES.indexOf(r.status) < 0) {
      return false;
    }
  }
  if (n.generatedBy === undefined || n.generatedBy === null || PROV_KINDS.indexOf(n.generatedBy.kind) < 0) {
    return false;
  }
  return true;
}

function numbersGrounded(text: string, quotes: string): boolean {
  const nums = text.match(/\d+/g);
  if (nums === null) {
    return true;
  }
  for (const x of nums) {
    if (quotes.indexOf(x) < 0) {
      return false;
    }
  }
  return true;
}

function properNounsGrounded(sentences: string[], quotes: string, names: string[], cityNouns: string[]): boolean {
  let total = 0;
  let found = 0;
  const haystacks: string[] = [quotes].concat(names).concat(PROPER_NOUN_ALLOWLIST).concat(cityNouns);
  for (const s of sentences) {
    const tokens = s.split(/\s+/).map((t: string) => t.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ''))
      .filter((t: string) => t.length > 0);
    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      const first = t.charAt(0);
      if (first !== first.toUpperCase() || first === first.toLowerCase()) {
        continue;   // not capitalised (or not a cased letter)
      }
      total++;
      if (haystacks.some((h: string) => h.indexOf(t) >= 0)) {
        found++;
      }
    }
  }
  return total === 0 || found / total >= 0.85;
}

/** Runs the v1 checks in order and returns every failed check id (empty = valid). Never throws. */
export function validateNarration(n: Narration, ctx: ValidationCtx): ValidationResult {
  const res = new ValidationResult();
  const fail = (id: string): void => {
    res.failed.push(id);
  };
  try {
    if (!schemaOk(n, ctx)) {
      fail(Check.SCHEMA);
      res.ok = false;
      res.firstFailed = Check.SCHEMA;
      return res;   // nothing else is meaningful on a malformed record
    }
    const text = n.sentences.join(' ');
    const authored = isAuthored(n.tier);
    if (authored && !lengthOk(n.length, n.lang, measure(text, n.lang))) {
      fail(Check.LENGTH);
    }
    if (authored) {
      const max = n.lang === Lang.ZH ? 110 : 45;
      if (n.sentences.some((s: string) => measure(s, n.lang) > max)) {
        fail(Check.SENTENCE_LENGTH);
      }
    }
    if (n.tier === ContentTier.SOURCE_EXTRACT) {
      const tooLong = n.lang === Lang.ZH ? measure(text, n.lang) > 500 : measure(text, n.lang) > 160;
      if (n.sentences.length > 6 || tooLong) {
        fail(Check.EXTRACT_SIZE);
      }
    }
    if (text.length >= 10000) {
      fail(Check.TOTAL_CHARS);
    }
    if (n.tier !== ContentTier.NAME_ONLY && !langMatches(text, n.lang, ctx.poiNames)) {
      fail(Check.LANG);
    }
    const quotes = n.claims.map((c) => c.quote).join(' \n ');
    const mtOfReviewed = n.generatedBy.kind === ProvenanceKind.MACHINE_TRANSLATION &&
      ctx.translatedFromTier === ContentTier.REVIEWED_HISTORIAN;
    if ((authored || mtOfReviewed) && !numbersGrounded(text, quotes)) {
      fail(Check.NUMBERS);
    }
    if (authored && n.lang !== Lang.ZH && !properNounsGrounded(n.sentences, quotes, ctx.poiNames, ctx.cityNouns)) {
      fail(Check.PROPER_NOUNS);
    }
    if (FORBIDDEN_PATTERNS.some((re: RegExp) => re.test(text))) {
      fail(Check.FORBIDDEN);
    }
  } catch (e) {
    if (res.failed.indexOf(Check.SCHEMA) < 0) {
      res.failed.push(Check.SCHEMA);
    }
  }
  res.ok = res.failed.length === 0;
  res.firstFailed = res.ok ? '' : res.failed[0];
  return res;
}

/** Memoised wrapper: each narration id is validated once per process. */
export class NarrationValidator {
  private memo: Map<string, ValidationResult> = new Map<string, ValidationResult>();

  validate(n: Narration, ctx: ValidationCtx): ValidationResult {
    const key = typeof n.id === 'string' ? n.id : '';
    const hit = key === '' ? undefined : this.memo.get(key);
    if (hit !== undefined) {
      return hit;
    }
    const r = validateNarration(n, ctx);
    if (key !== '') {
      this.memo.set(key, r);
    }
    return r;
  }

  size(): number {
    return this.memo.size;
  }
}
