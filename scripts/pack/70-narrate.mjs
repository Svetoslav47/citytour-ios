#!/usr/bin/env node
// Stage 7 (task B7): reads the Historian review files scripts/pack/review/<courseId>/<poiId>.<lang>.md into the pack.
// Node 22+ ESM, stdlib only, no network, no LLM call: the scripts and translations are written into the review
// files by an agent (prompts/historian-v1.md, prompts/translate-v1.md) and reviewed by humans there.
//
// 90-emit.mjs calls narrationDrafts(ctx) (its B7 hook) and tries each draft before the extract and name-only
// candidates of the same narration id; 80-validate.mjs decides. So `scripts/pack/build-pack.sh` is the one
// command that rebuilds the narrations after a human edits or approves a review file.
//
// Tier rules (docs/ARCHITECTURE.md §7.1 review loop, §7.4 tiers):
//   en file        tier `reviewed` ONLY when the front matter has `reviewed: <initials> <YYYY-MM-DD>` AND
//                  `status: approved|edited`; reviewedBy = {reviewer, at, status} from those lines.
//                  Otherwise (`reviewed:` empty, `status: draft`) tier `grounded-ai`: an AI draft written only
//                  from the cited source texts, honestly labelled "AI-assisted" in the app, never "reviewed".
//                  provenance {kind: llm, model, promptId, at: drafted}.
//   pl/zh file     a machine translation of the EN file (generatedBy: mt). Inherits the EN review state: tier
//                  `reviewed` (reviewedBy = the EN review) only when the EN file is reviewed AND the translation is
//                  fresh (its sourceSha256 equals scriptHash() of the current EN text). A translation of an
//                  unreviewed or since-edited EN text is `grounded-ai`. provenance {kind: mt, model, promptId,
//                  at: translated, translatedFrom: en}; the app shows the "Machine-translated" chip for kind mt.
//                  Claims = the EN claims + the translation's own (local-language quotes for local name forms).
// Failing loudly:
//   - a review file whose `reviewed:` and `status:` lines disagree (e.g. status approved, reviewed empty) stops the
//     build: it is never quietly emitted as reviewed or as a draft;
//   - every emitted draft is pre-validated (validator spec v1, 80-validate.mjs); a `reviewed` narration that
//     fails stops the build, a `grounded-ai` one that fails prints a WARNING and falls back to the extract tier;
//   - assertReviewedHaveReview() is the last guard: no tier `reviewed` without a reviewedBy from a filled file.
//
// CLI: node scripts/pack/70-narrate.mjs [--course <courseId>]   prints what the next build will emit per stop and language (tier,
//      review, stale translations) without writing anything; exit 1 when the review files cannot be built.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  isTranslation, parseReviewFile, REVIEW_DIR, reviewFiles, reviewState, scriptHash, SECTIONS, translationClaims,
} from './review/check-drafts.mjs';
import { validateNarration } from './80-validate.mjs';
import { isMain } from './lib/http.mjs';
import { courseFromArgv } from './lib/course.mjs';

export const PERSONA_ID = 'historian';
export const DRAFT_TIER = 'grounded-ai';
export const REVIEWED_TIER = 'reviewed';
const WP_ID_RE = /^wp:(en|pl|zh):(.+)@(\d+)$/;

/**
 * Map review-file source id `wp:<lang>:<title>@<revid>` -> pack SourceRef id, from the pack's Wikipedia
 * SourceRefs (title + `oldid=` permalink).
 */
export function sourceIdMap(sources) {
  const map = new Map();
  for (const s of sources) {
    if (s.publisher !== 'Wikipedia') continue;
    const m = /[?&]oldid=(\d+)/.exec(s.url);
    if (m) map.set(`wp:${s.lang}:${s.title}@${m[1]}`, s.id);
  }
  return map;
}

/** Reads and parses every review file: [{ file, parsed }]. Parse errors stop the build. */
export function readReviewFiles(dir = REVIEW_DIR) {
  // reviewFiles() returns [] for a course without a review dir (it then ships extract / name-only narrations).
  return reviewFiles(dir).map((path) => {
    const parsed = parseReviewFile(readFileSync(path, 'utf8'));
    if (parsed.errors.length) throw new Error(`${basename(path)}: ${parsed.errors.join('; ')}`);
    return { file: basename(path), parsed };
  });
}

/**
 * What each review file becomes: [{ file, poiId, lang, tier, review, stale, generatedBy, claims, sections }].
 * Throws on any inconsistency (the pipeline fails loudly instead of guessing a review state).
 */
export function planReviewFiles(files) {
  const en = new Map();
  for (const f of files) {
    if (f.parsed.meta.lang === 'en') {
      if (isTranslation(f.parsed.meta)) throw new Error(`${f.file}: an en file cannot be a translation`);
      en.set(f.parsed.meta.poiId, f);
    }
  }
  const out = [];
  for (const f of files) {
    const { meta } = f.parsed;
    const st = reviewState(meta);
    if (st.error) throw new Error(`${f.file}: ${st.error}; refusing to guess its review state`);
    if (meta.persona !== PERSONA_ID) throw new Error(`${f.file}: persona must be ${PERSONA_ID}`);
    if (!meta.model || !meta.promptId) throw new Error(`${f.file}: model and promptId are required`);
    if (meta.lang === 'en') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.drafted ?? '')) throw new Error(`${f.file}: drafted must be YYYY-MM-DD`);
      out.push({
        file: f.file, poiId: meta.poiId, lang: 'en',
        tier: st.reviewed ? REVIEWED_TIER : DRAFT_TIER,
        review: st.reviewed ? st.review : null,
        stale: false,
        generatedBy: { kind: 'llm', model: meta.model, promptId: meta.promptId, at: meta.drafted },
        claims: f.parsed.claims,
        sections: f.parsed.sections,
      });
      continue;
    }
    if (!isTranslation(meta)) throw new Error(`${f.file}: a ${meta.lang} file must be a machine translation (generatedBy: mt)`);
    if (meta.translatedFrom !== 'en') throw new Error(`${f.file}: translatedFrom must be en`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meta.translated ?? '')) throw new Error(`${f.file}: translated must be YYYY-MM-DD`);
    const src = en.get(meta.poiId);
    if (!src) throw new Error(`${f.file}: no ${meta.poiId}.en.md to inherit the review state from`);
    const enState = reviewState(src.parsed.meta);
    const stale = meta.sourceSha256 !== scriptHash(src.parsed);
    const reviewed = !enState.error && enState.reviewed && !stale;
    out.push({
      file: f.file, poiId: meta.poiId, lang: meta.lang,
      tier: reviewed ? REVIEWED_TIER : DRAFT_TIER,
      review: reviewed ? enState.review : null,
      stale,
      enReviewed: Boolean(enState.reviewed),
      generatedBy: { kind: 'mt', model: meta.model, promptId: meta.promptId, at: meta.translated, translatedFrom: 'en' },
      claims: translationClaims(f.parsed, src.parsed),
      sections: f.parsed.sections,
    });
  }
  return out;
}

/** Narration records (contracts/Model.ets key order) of one planned review file. */
export function narrationsOf(plan, idMap) {
  const claims = plan.claims.map((c) => {
    const sourceId = idMap.get(c.source);
    if (!sourceId) throw new Error(`${plan.file}: claim source ${c.source} is not a source of this pack (title or revision id)`);
    return { text: c.text, sourceId, quote: c.quote };
  });
  const sources = [...new Set(claims.map((c) => c.sourceId))];
  const out = [];
  for (const length of SECTIONS) {
    const sentences = plan.sections[length];
    if (!Array.isArray(sentences) || sentences.length === 0) continue;
    const n = {
      id: `${plan.poiId}:${PERSONA_ID}:${plan.lang}:${length}`,
      poiId: plan.poiId,
      personaId: PERSONA_ID,
      lang: plan.lang,
      length,
      sentences: [...sentences],
      tier: plan.tier,
      sources,
      claims,
      generatedBy: { ...plan.generatedBy },
    };
    if (plan.tier === REVIEWED_TIER) n.reviewedBy = { ...plan.review };
    n.validation = { status: 'pass', checks: [], validatorVersion: 1 };
    out.push(n);
  }
  return out;
}

/** Last guard: a `reviewed` narration needs a reviewedBy taken from a filled-in review file. */
export function assertReviewedHaveReview(narrations) {
  for (const n of narrations) {
    if (n.tier !== REVIEWED_TIER) continue;
    const r = n.reviewedBy;
    if (!r || !r.reviewer || !/^\d{4}-\d{2}-\d{2}$/.test(r.at ?? '') || !['approved', 'edited'].includes(r.status)) {
      throw new Error(`${n.id}: tier reviewed without a human review (reviewedBy); unreviewed scripts are never emitted as reviewed`);
    }
  }
}

/**
 * The 90-emit.mjs hook. ctx = { pois, sources, sourceTexts, stopIds, ... } (see 90-emit.mjs buildPack).
 * Returns Narration[] (tier reviewed / grounded-ai) for the tour stops.
 */
export function narrationDrafts(ctx, { dir = ctx.reviewDir ?? REVIEW_DIR, log = console } = {}) {
  const plans = planReviewFiles(readReviewFiles(dir));
  const idMap = sourceIdMap(ctx.sources);
  const sourceIds = new Set(ctx.sources.map((s) => s.id));
  const poiById = new Map(ctx.pois.map((p) => [p.id, p]));
  const out = [];
  for (const plan of plans) {
    if (ctx.stopIds && !ctx.stopIds.has(plan.poiId)) throw new Error(`${plan.file}: ${plan.poiId} is not a tour stop of this pack`);
    const poi = poiById.get(plan.poiId);
    if (!poi) throw new Error(`${plan.file}: ${plan.poiId} is not a POI of this pack`);
    if (plan.stale) {
      log.warn(`WARNING: ${plan.file} is STALE (the EN text changed since it was translated); emitted as ${plan.tier}. ` +
        'Ask an agent to refresh it (scripts/pack/review/README.md).');
    }
    for (const n of narrationsOf(plan, idMap)) {
      const r = validateNarration(n, { sourceIds, poiNames: Object.values(poi.names), sourceTexts: ctx.sourceTexts });
      if (!r.ok) {
        const msg = `${n.id} (${plan.file}, tier ${n.tier}) fails validator checks ${r.failed.join(',')}`;
        if (n.tier === REVIEWED_TIER) throw new Error(`${msg}; fix the review file (node scripts/pack/review/check-drafts.mjs)`);
        log.warn(`WARNING: ${msg}; the build falls back to the extract tier`);
      }
      out.push(n);
    }
  }
  assertReviewedHaveReview(out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// CLI: status table (no writes)

export function statusLines(plans) {
  const lines = ['file                      tier         review                 note'];
  for (const p of plans) {
    const review = p.review ? `${p.review.reviewer} ${p.review.at} ${p.review.status}` : '-';
    const note = p.lang === 'en'
      ? ''
      : p.stale ? 'STALE translation: ask an agent to refresh it'
        : p.enReviewed ? 'machine-translated, inherits the EN review' : 'machine-translated, EN not reviewed yet';
    lines.push(`${p.file.padEnd(26)}${p.tier.padEnd(13)}${review.padEnd(23)}${note}`);
  }
  const reviewed = plans.filter((p) => p.tier === REVIEWED_TIER).length;
  const stale = plans.filter((p) => p.stale).length;
  lines.push(`${plans.length} review files: ${reviewed} reviewed, ${plans.length - reviewed} AI draft (grounded-ai)` +
    `${stale ? `, ${stale} STALE translation(s)` : ''}. Rebuild the pack: scripts/pack/build-pack.sh`);
  return lines;
}

if (isMain(import.meta.url)) {
  try {
    const { course, rest } = courseFromArgv(process.argv.slice(2));
    if (rest.length) throw new Error(`unknown argument ${rest[0]} (expected --course ID or --tour ID)`);
    console.log(`course ${course.courseId}: ${course.reviewDir}`);
    console.log(statusLines(planReviewFiles(readReviewFiles(course.reviewDir))).join('\n'));
  } catch (e) {
    console.error(`FAILED: ${e.message}`);
    process.exitCode = 1;
  }
}
