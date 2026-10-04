// Suite: NarrationValidator.test - module under test: core/content/{NarrationValidator,LangDetect,NarrationSelector}.
// Owner: task B3 (Person B). Validator spec v1 (ARCHITECTURE §7.4): the same cases run in the pipeline
// (scripts/pack/80-validate.mjs, task B2). This is the "incorrect AI output" evidence for the jury.
import { describe, it, expect } from 'vitest';
import { ContentTier, Lang, Narration, NarrationLength, Persona } from '../src';
import { Check, NarrationValidator, validateNarration, ValidationCtx } from '../src';
import { langMatches, stripNames } from '../src';
import { nameOnlyNarration, personaChain, selectNarration } from '../src';
import { ctxBarbican, extractTeaser, reviewedTeaser, withTier } from './fixtures/PackJson';

function has(failed: string[], id: string): boolean {
  return failed.indexOf(id) >= 0;
}

function narrationValidatorTest() {
  describe('NarrationValidator', () => {
    it('valid_reviewed_en_teaser_passes', () => {
      const r = validateNarration(reviewedTeaser(), ctxBarbican());
      expect(r.failed.join(',')).toBe('');
      expect(r.ok).toBe(true);
    });
    it('zh_text_in_en_slot_fails_lang', () => {
      const r = validateNarration(reviewedTeaser(['这是巴比肯，一座建于1498年的圆形砖砌堡垒，用来守卫进城的道路。',
        '它的七座塔楼守望着弗洛里安门，国王们从这里进入克拉科夫前往加冕。']), ctxBarbican());
      expect(r.ok).toBe(false);
      expect(has(r.failed, Check.LANG)).toBe(true);
    });
    it('invented_year_fails_numbers', () => {
      const r = validateNarration(reviewedTeaser([
        'This is the Barbican, a round brick fortress built in 1347 to guard the road into the city.',
        'Its seven turrets watched over the Florian Gate, where kings entered Kraków on the way to their coronation.'
      ]), ctxBarbican());
      expect(r.ok).toBe(false);
      expect(r.firstFailed).toBe(Check.NUMBERS);
    });
    it('absolute_direction_fails_forbidden', () => {
      const r = validateNarration(reviewedTeaser([
        'This is the Barbican, a round brick fortress built in 1498 to guard the road into the city.',
        'On your left, the seven turrets watched over the Florian Gate, where kings entered Kraków to be crowned.'
      ]), ctxBarbican());
      expect(r.firstFailed).toBe(Check.FORBIDDEN);
    });
    it('two_hundred_word_teaser_fails_length', () => {
      const s: string[] = [];
      for (let i = 0; i < 20; i++) {
        s.push('The Barbican guarded the road into the city for the kings of the land.');
      }
      const r = validateNarration(reviewedTeaser(s), ctxBarbican());
      expect(has(r.failed, Check.LENGTH)).toBe(true);
    });
    it('reviewed_without_reviewer_fails_schema', () => {
      const n = reviewedTeaser();
      n.reviewedBy = undefined;
      const r = validateNarration(n, ctxBarbican());
      expect(r.firstFailed).toBe(Check.SCHEMA);
    });
    it('unknown_tier_and_bad_id_fail_schema', () => {
      const n = reviewedTeaser();
      n.tier = 'fabricated' as ContentTier;
      expect(validateNarration(n, ctxBarbican()).firstFailed).toBe(Check.SCHEMA);
      const m = reviewedTeaser();
      m.id = 'wrong-id';
      expect(validateNarration(m, ctxBarbican()).firstFailed).toBe(Check.SCHEMA);
    });
    it('unresolved_source_fails_schema', () => {
      const n = reviewedTeaser();
      n.sources = ['src_does_not_exist'];
      expect(validateNarration(n, ctxBarbican()).firstFailed).toBe(Check.SCHEMA);
    });
    it('markdown_url_and_hedges_fail_forbidden', () => {
      const bad: string[] = ['# The Barbican', 'See https://example.org for more.', 'It is said kings feared it.',
        'The Barbican [citation needed] guards the road.'];
      for (const b of bad) {
        const n = extractTeaser();
        n.sentences = [b, 'The Barbican is a fortified outpost once connected to the city walls.'];
        expect(has(validateNarration(n, ctxBarbican()).failed, Check.FORBIDDEN)).toBe(true);
      }
      const ok = extractTeaser();
      ok.sentences = ['The Barbican is a fortified outpost. [p400]', 'It was connected to the city walls.'];
      expect(has(validateNarration(ok, ctxBarbican()).failed, Check.FORBIDDEN)).toBe(false);
    });
    it('long_sentence_in_reviewed_full_fails_sentence_length', () => {
      const long: string[] = [];
      for (let i = 0; i < 50; i++) {
        long.push('the');
      }
      const s: string[] = [`This is the Barbican and ${long.join(' ')} road.`];
      for (let i = 0; i < 12; i++) {
        s.push('The Barbican guarded the road into the city for the kings and the people of the town.');
      }
      const n = reviewedTeaser(s);
      n.length = NarrationLength.FULL;
      n.id = `${n.poiId}:historian:en:full`;
      expect(has(validateNarration(n, ctxBarbican()).failed, Check.SENTENCE_LENGTH)).toBe(true);
    });
    it('invented_proper_noun_fails', () => {
      const r = validateNarration(reviewedTeaser([
        'This is the Barbican, built in 1498 by Count Dracula and Napoleon Bonaparte to guard the road.',
        'Its seven turrets watched over the Florian Gate, where kings entered Kraków on the way to their coronation.'
      ]), ctxBarbican());
      expect(has(r.failed, Check.PROPER_NOUNS)).toBe(true);
    });
    it('polish_extract_with_diacritics_passes_lang', () => {
      const n = extractTeaser();
      n.lang = Lang.PL;
      n.id = `${n.poiId}:historian:pl:teaser`;
      n.sentences = ['Barbakan krakowski to obiekt obronny, który był połączony z murami miejskimi.'];
      const r = validateNarration(n, ctxBarbican());
      expect(r.ok).toBe(true);
    });
    it('long_extract_fails_extract_size', () => {
      const n = extractTeaser();
      const s: string[] = [];
      for (let i = 0; i < 7; i++) {
        s.push('The Barbican is a fortified outpost once connected to the city walls.');
      }
      n.sentences = s;
      expect(has(validateNarration(n, ctxBarbican()).failed, Check.EXTRACT_SIZE)).toBe(true);
    });
    it('memoises_per_id', () => {
      const v = new NarrationValidator();
      const a = v.validate(reviewedTeaser(), ctxBarbican());
      const b = v.validate(reviewedTeaser(), ctxBarbican());
      expect(a === b).toBe(true);
      expect(v.size()).toBe(1);
    });
    it('never_throws_on_garbage', () => {
      const n = reviewedTeaser();
      n.sentences = ['   '];
      const r = validateNarration(n, new ValidationCtx());
      expect(r.ok).toBe(false);
    });
  });

  describe('LangDetect', () => {
    it('names_do_not_skew_language', () => {
      const t = 'The Kościół Mariacki is the most famous church in the city and it was built of brick.';
      expect(langMatches(t, Lang.EN, ['Kościół Mariacki'])).toBe(true);
      expect(stripNames('a Kościół b', ['Kościół'])).toBe('a   b');
    });
    it('chinese_needs_cjk_majority', () => {
      expect(langMatches('这是克拉科夫最著名的教堂。', Lang.ZH, [])).toBe(true);
      expect(langMatches('This is a church.', Lang.ZH, [])).toBe(false);
    });
  });

  describe('NarrationSelector', () => {
    it('falls_back_to_source_extract_with_reason', () => {
      const grounded = withTier(reviewedTeaser([
        'This is the Barbican, a round brick fortress built in 1347 to guard the road into the city.',
        'Its seven turrets watched over the Florian Gate, where kings entered Kraków on the way to their coronation.'
      ]), ContentTier.GROUNDED_AI);
      grounded.id = `${grounded.poiId}:historian:en:teaser#g`;
      const sel = selectNarration([extractTeaser(), grounded], new NarrationValidator(),
        (n: Narration) => ctxBarbican());
      expect(sel.narration !== undefined && sel.narration.tier === ContentTier.SOURCE_EXTRACT).toBe(true);
      expect(sel.fellBack).toBe(true);
      expect(sel.rejectedTier).toBe(ContentTier.GROUNDED_AI);
    });
    it('prefers_reviewed_when_valid', () => {
      const sel = selectNarration([extractTeaser(), reviewedTeaser()], new NarrationValidator(),
        (n: Narration) => ctxBarbican());
      expect(sel.narration !== undefined && sel.narration.tier === ContentTier.REVIEWED_HISTORIAN).toBe(true);
      expect(sel.fellBack).toBe(false);
    });
    it('none_valid_returns_undefined', () => {
      const n = reviewedTeaser();
      n.reviewedBy = undefined;
      const sel = selectNarration([n], new NarrationValidator(), (x: Narration) => ctxBarbican());
      expect(sel.narration === undefined).toBe(true);
      expect(sel.reason).toBe(Check.SCHEMA);
    });
    it('persona_chain_is_cycle_safe', () => {
      const kids: Persona = { id: 'kids', names: { en: 'Kids' }, voices: [], speed: 1, pitch: 1,
        fallbackPersonaId: 'historian' };
      const hist: Persona = { id: 'historian', names: { en: 'H' }, voices: [], speed: 1, pitch: 1,
        fallbackPersonaId: 'kids' };
      expect(personaChain([kids, hist], 'kids').join(',')).toBe('kids,historian');
    });
    it('name_only_template_is_valid', () => {
      const n = nameOnlyNarration('poi_wd_Q1', 'historian', Lang.EN, NarrationLength.TEASER, 'Cloth Hall');
      expect(n.sentences[0]).toBe('Cloth Hall.');
      expect(validateNarration(n, new ValidationCtx()).ok).toBe(true);
    });
  });
}

narrationValidatorTest();
