/*
 * Picks the narration to speak/show for one slot (poi, persona, lang, length): the best tier that passes the
 * validator, falling back along REVIEWED -> GROUNDED_AI -> SOURCE_EXTRACT -> NAME_ONLY (ARCHITECTURE §7.4 rule 6),
 * and along Persona.fallbackPersonaId (§7.5). Pure: no @kit imports; logging is the caller's job (NARR_FALLBACK).
 */
import { ContentTier, Lang, Narration, NarrationLength, Persona, ProvenanceKind } from '../../contracts/Model';
import { NarrationValidator, ValidationCtx, VALIDATOR_VERSION } from './NarrationValidator';

export const TIER_CHAIN: string[] = [ContentTier.REVIEWED_HISTORIAN, ContentTier.GROUNDED_AI,
  ContentTier.SOURCE_EXTRACT, ContentTier.NAME_ONLY];

export class Selection {
  narration: Narration | undefined = undefined;
  /** True when a better-tier candidate failed validation (or none was valid). */
  fellBack: boolean = false;
  /** First failed check of the best rejected candidate, e.g. "numbers"; '' when nothing failed. */
  reason: string = '';
  /** Tier of the best rejected candidate ('' when nothing failed). */
  rejectedTier: string = '';
}

function tierRank(tier: string): number {
  const i = TIER_CHAIN.indexOf(tier);
  return i < 0 ? TIER_CHAIN.length : i;
}

/** Best valid candidate; `ctxFor` builds the validation context (source ids, names) per narration. */
export function selectNarration(candidates: Narration[], validator: NarrationValidator,
  ctxFor: (n: Narration) => ValidationCtx): Selection {
  const sel = new Selection();
  const sorted = candidates.slice().sort((a: Narration, b: Narration) => tierRank(a.tier) - tierRank(b.tier));
  for (const n of sorted) {
    const r = validator.validate(n, ctxFor(n));
    if (r.ok) {
      sel.narration = n;
      return sel;
    }
    if (!sel.fellBack) {
      sel.fellBack = true;
      sel.reason = r.firstFailed;
      sel.rejectedTier = n.tier;
    }
  }
  return sel;
}

/** Persona ids to try, starting with `personaId` and following fallbackPersonaId (cycle-safe). */
export function personaChain(personas: Persona[], personaId: string): string[] {
  const out: string[] = [];
  let cur: string | undefined = personaId;
  while (cur !== undefined && cur !== '' && out.indexOf(cur) < 0) {
    out.push(cur);
    const p = personas.find((x: Persona) => x.id === cur);
    cur = p !== undefined ? p.fallbackPersonaId : undefined;
  }
  return out;
}

/**
 * Last resort for a POI with no valid text in this language: one sentence with the place's name ("Basic info"
 * tier). Built in the app, never claims a fact.
 */
export function nameOnlyNarration(poiId: string, personaId: string, lang: Lang, len: NarrationLength,
  name: string): Narration {
  const sentence = lang === Lang.ZH ? `${name}。` : `${name}.`;
  const n: Narration = {
    id: `${poiId}:${personaId}:${lang}:${len}`, poiId: poiId, personaId: personaId, lang: lang, length: len,
    sentences: [sentence], tier: ContentTier.NAME_ONLY, sources: [], claims: [],
    generatedBy: { kind: ProvenanceKind.TEMPLATE, at: '' },
    validation: { status: 'fallback', checks: ['app_name_only'], validatorVersion: VALIDATOR_VERSION }
  };
  return n;
}
