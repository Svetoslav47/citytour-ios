// Suite: ClipSelection.test - modules under test: core/speech/ClipSelection and core/speech/Sha256 (task A13).
// Cases: SHA-256 equals Node's crypto (the render script's hash) for ASCII, Polish, CJK, emoji and [pN] markup;
// manifest parsing (malformed JSON / entries dropped, path safety); selection: hash match, missing clip,
// changed text, language, persona, failed (deleted) clip, the user's text-only choice, no manifest, and Polish
// (platform text-only) getting a clip.
// Phase 2: storyVoicePlan (studio upgrade only with clips, never over the user's text-only or cross-language
// choice), hasLang per persona, storyClipCoverage all/partial/none, exclusion of partly covered stories, and the
// cross-language listen choice getting no clip.
import { describe, it, expect } from 'vitest';
import { Lang } from '../src';
import { VoicePlan } from '../src';
import { VoiceLabel } from '../src';
import { sha256Hex, utf8Bytes } from '../src';
import {
  AUDIO_SRC_PRERENDERED, AUDIO_SRC_TEXT, AUDIO_SRC_TTS, ClipEntry, ClipIndex, ClipQuery, ClipReason,
  parseClipManifest, selectAudio, shortSha, storiesAllOrNothing, StoryClips, storyClipCoverage, storyVoicePlan
} from '../src';

function vplan(lang: Lang, mode: string, label: VoiceLabel, reason: string, engine: string = ''): VoicePlan {
  const p: VoicePlan = {
    textLang: lang, speechMode: mode, engineLocale: engine, person: engine === '' ? 0 : 13, languageContext: engine,
    label: label, reason: reason
  };
  return p;
}

// Vectors from Node: crypto.createHash('sha256').update(s, 'utf8').digest('hex') (= render-elevenlabs.mjs).
const VECTORS: string[][] = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['This is Barbican.', '6b57aa9020f95bb52345b5d986292da081ea900be66916d2410916c350c39573'],
  ['Zażółć gęślą jaźń', 'bc5348fd7c2dd8bbf411f0b9268265f7c2e0d31ebf314695882b8170c7e1e9d7'],
  ['您已到达巴比肯。', 'b4dd57599ef12b156c3d84f959d5b49433a231c88c8a80f8afeabd5585cc5318'],
  ['emoji \uD83C\uDFF0 ok', 'b0e0fdd9c6bc7d9fec4cbf074f691364edd1b91a86a0a3bae589b77bf221fe3a'],
  ['Look up.[p300] Done', '1b5ef90f5e6c6e06c082df8c9bef4e3e2910c3c44be3d85c1de88cd7a4f83087']
];

const SHA_BARBICAN: string = '6b57aa9020f95bb52345b5d986292da081ea900be66916d2410916c350c39573';
const SHA_PL: string = 'd22ea7a8f6db4277e1e47e56d03abf4c007f9bb3f198523cba8e06e94a14c3b4'; // 'To jest Barbakan.'

function entry(lang: string, persona: string, sha: string, file: string): ClipEntry {
  const e: ClipEntry = {
    lang: lang, poiId: 'poi_stub_barbican', personaId: persona, length: 'full', n: 0, file: file, textSha256: sha,
    durationMs: 1500
  };
  return e;
}

function query(text: string, lang: string, mode: string, label: VoiceLabel, persona: string = 'historian'): ClipQuery {
  const q: ClipQuery = { text: text, lang: lang, personaId: persona, planSpeechMode: mode, planLabel: label };
  return q;
}

function index(): ClipIndex {
  return new ClipIndex([
    entry('en', 'historian', SHA_BARBICAN, 'audio/en/poi_stub_barbican/full_0.mp3'),
    entry('pl', 'historian', SHA_PL, 'audio/pl/poi_stub_barbican/full_0.mp3')
  ]);
}

const MANIFEST: string = '{"schemaVersion":1,"model":"eleven_multilingual_v2","voiceId":"voice123","clips":[' +
  `{"lang":"en","poiId":"poi_stub_barbican","personaId":"historian","length":"full","n":0,` +
  `"file":"audio/en/poi_stub_barbican/full_0.mp3","textSha256":"${SHA_BARBICAN.toUpperCase()}","durationMs":1400},` +
  '{"lang":"en","personaId":"historian","file":"audio/en/x/full_1.mp3","textSha256":"not-a-hash"},' +
  `{"lang":"en","personaId":"historian","file":"audio/../../etc/passwd.mp3","textSha256":"${SHA_PL}"},` +
  `{"lang":"en","personaId":"historian","file":"packs/krakow/pois.json","textSha256":"${SHA_PL}"},` +
  `{"lang":"en","file":"audio/en/x/full_2.mp3","textSha256":"${SHA_PL}"},` +
  'null]}';

function clipSelectionTest() {
  describe('ClipSelection', () => {
    it('sha256_matches_node_crypto', () => {
      for (const v of VECTORS) {
        expect(sha256Hex(v[0])).toBe(v[1]);
      }
    });

    it('utf8_bytes_multibyte_and_surrogates', () => {
      expect(utf8Bytes('ż').length).toBe(2);
      expect(utf8Bytes('巴').length).toBe(3);
      expect(utf8Bytes('\uD83C\uDFF0').length).toBe(4);
      expect(utf8Bytes('\uD800').length).toBe(3);   // lone surrogate -> U+FFFD
    });

    it('parse_manifest_keeps_valid_drops_malformed', () => {
      const p = parseClipManifest(MANIFEST);
      expect(p.error).toBe('');
      expect(p.entries.length).toBe(1);
      expect(p.dropped).toBe(5);
      expect(p.entries[0].textSha256).toBe(SHA_BARBICAN);   // normalised to lowercase
      expect(p.entries[0].durationMs).toBe(1400);
      expect(p.voiceId).toBe('voice123');
      expect(p.model).toBe('eleven_multilingual_v2');
    });

    it('parse_manifest_bad_input_never_throws', () => {
      expect(parseClipManifest('{not json').error).toBe('json');
      expect(parseClipManifest('null').error).toBe('not_object');
      expect(parseClipManifest('{"clips":5}').error).toBe('no_clips');
      expect(parseClipManifest('{"clips":[]}').entries.length).toBe(0);
    });

    it('hash_match_plays_clip', () => {
      const d = selectAudio(index(), query('This is Barbican.', 'en', 'voice', VoiceLabel.FALLBACK_ZH_READS_EN));
      expect(d.src).toBe(AUDIO_SRC_PRERENDERED);
      expect(d.reason).toBe(ClipReason.HASH_MATCH);
      expect(d.clip !== undefined && d.clip.file === 'audio/en/poi_stub_barbican/full_0.mp3').toBe(true);
      expect(shortSha(d.sha)).toBe('6b57aa9020f9');
    });

    it('missing_or_changed_text_falls_back_to_tts', () => {
      const dyn = selectAudio(index(), query('Turn left in 50 metres.', 'en', 'voice', VoiceLabel.NATIVE));
      expect(dyn.src).toBe(AUDIO_SRC_TTS);
      expect(dyn.reason).toBe(ClipReason.NO_CLIP);
      const changed = selectAudio(index(), query('This is the Barbican.', 'en', 'voice', VoiceLabel.NATIVE));
      expect(changed.src).toBe(AUDIO_SRC_TTS);
      const ws = selectAudio(index(), query('This is Barbican. ', 'en', 'voice', VoiceLabel.NATIVE));
      expect(ws.src).toBe(AUDIO_SRC_TTS);   // exact text only
    });

    it('language_must_match', () => {
      const d = selectAudio(index(), query('This is Barbican.', 'zh', 'voice', VoiceLabel.NATIVE));
      expect(d.src).toBe(AUDIO_SRC_TTS);
      expect(d.reason).toBe(ClipReason.LANG_MISMATCH);
    });

    it('persona_must_match', () => {
      const d = selectAudio(index(), query('This is Barbican.', 'en', 'voice', VoiceLabel.NATIVE, 'kids-legends'));
      expect(d.src).toBe(AUDIO_SRC_TTS);
      expect(d.reason).toBe(ClipReason.PERSONA_MISMATCH);
    });

    it('failed_clip_falls_back_and_stays_failed', () => {
      const ix = index();
      ix.markFailed('audio/en/poi_stub_barbican/full_0.mp3');
      const d = selectAudio(ix, query('This is Barbican.', 'en', 'voice', VoiceLabel.NATIVE));
      expect(d.src).toBe(AUDIO_SRC_TTS);
      expect(d.reason).toBe(ClipReason.CLIP_FAILED);
      expect(ix.isFailed('audio/en/poi_stub_barbican/full_0.mp3')).toBe(true);
    });

    it('user_text_only_choice_wins', () => {
      const d = selectAudio(index(), query('This is Barbican.', 'en', 'text', VoiceLabel.TEXT_ONLY_USER));
      expect(d.src).toBe(AUDIO_SRC_TEXT);
      expect(d.reason).toBe(ClipReason.USER_TEXT_ONLY);
    });

    it('polish_platform_text_only_gets_the_clip', () => {
      const d = selectAudio(index(), query('To jest Barbakan.', 'pl', 'text', VoiceLabel.TEXT_ONLY_PLATFORM));
      expect(d.src).toBe(AUDIO_SRC_PRERENDERED);
      const none = selectAudio(index(), query('Inne zdanie.', 'pl', 'text', VoiceLabel.TEXT_ONLY_PLATFORM));
      expect(none.src).toBe(AUDIO_SRC_TEXT);
      expect(index().hasLang('pl')).toBe(true);
      expect(index().hasLang('zh')).toBe(false);
    });

    it('story_plan_polish_becomes_studio_voice_with_clips', () => {
      const base = vplan(Lang.PL, 'text', VoiceLabel.TEXT_ONLY_PLATFORM, 'no_voice_for_lang=pl');
      const p = storyVoicePlan(base, true);
      expect(p.label).toBe(VoiceLabel.PRERENDERED);
      expect(p.speechMode).toBe('voice');
      expect(p.engineLocale).toBe('');          // no TTS engine behind it: the rest stays text
      expect(p.reason.indexOf('fallback=text-only-platform') >= 0).toBe(true);
      expect(storiesAllOrNothing(base)).toBe(true);
      const without = storyVoicePlan(base, false);
      expect(without.label).toBe(VoiceLabel.TEXT_ONLY_PLATFORM);
      expect(without.speechMode).toBe('text');
    });

    it('story_plan_english_keeps_the_fallback_engine_for_other_lines', () => {
      const base = vplan(Lang.EN, 'voice', VoiceLabel.FALLBACK_ZH_READS_EN, 'en_status=DOWNLOADABLE', 'zh-CN');
      const p = storyVoicePlan(base, true);
      expect(p.label).toBe(VoiceLabel.PRERENDERED);
      expect(p.engineLocale).toBe('zh-CN');
      expect(p.person).toBe(13);
      expect(storiesAllOrNothing(base)).toBe(false);  // en/zh fall back per sentence
    });

    it('story_plan_respects_text_only_and_listen_choices', () => {
      const user = vplan(Lang.EN, 'text', VoiceLabel.TEXT_ONLY_USER, 'strategy=text-only');
      expect(storyVoicePlan(user, true).label).toBe(VoiceLabel.TEXT_ONLY_USER);
      const listen = vplan(Lang.PL, 'voice', VoiceLabel.NATIVE, 'pl_listen_en en_status=INSTALLED', 'en-US');
      expect(storyVoicePlan(listen, true).label).toBe(VoiceLabel.NATIVE);
      const q: ClipQuery = {
        text: 'To jest Barbakan.', lang: 'pl', personaId: 'historian', planSpeechMode: 'voice',
        planLabel: VoiceLabel.NATIVE, planReason: listen.reason
      };
      const d = selectAudio(index(), q);
      expect(d.src).toBe(AUDIO_SRC_TTS);
      expect(d.reason).toBe(ClipReason.LISTEN_CHOICE);
    });

    it('has_lang_per_persona', () => {
      expect(index().hasLang('en', 'historian')).toBe(true);
      expect(index().hasLang('en', 'kids-legends')).toBe(false);
      expect(index().hasLang('en', '')).toBe(true);
    });

    it('story_coverage_all_partial_none', () => {
      const ix = index();
      const all = storyClipCoverage(ix, ['This is Barbican.'], 'en', 'historian');
      expect(all.state).toBe(StoryClips.ALL);
      const part = storyClipCoverage(ix, ['This is Barbican.', 'Not rendered.'], 'en', 'historian');
      expect(part.state).toBe(StoryClips.PARTIAL);
      expect(part.matched).toBe(1);
      expect(part.total).toBe(2);
      expect(part.shas[0]).toBe(SHA_BARBICAN);
      expect(storyClipCoverage(ix, ['Nope.'], 'en', 'historian').state).toBe(StoryClips.NONE);
      expect(storyClipCoverage(ix, [], 'en', 'historian').state).toBe(StoryClips.NONE);
      expect(storyClipCoverage(undefined, ['This is Barbican.'], 'en', 'historian').state).toBe(StoryClips.NONE);
    });

    it('excluded_story_sentence_gets_no_clip_until_cleared', () => {
      const ix = index();
      ix.exclude(SHA_PL);
      const d = selectAudio(ix, query('To jest Barbakan.', 'pl', 'text', VoiceLabel.TEXT_ONLY_PLATFORM));
      expect(d.src).toBe(AUDIO_SRC_TEXT);
      expect(d.reason).toBe(ClipReason.STORY_INCOMPLETE);
      expect(ix.isExcluded(SHA_PL)).toBe(true);
      ix.clearExclusions();
      const again = selectAudio(ix, query('To jest Barbakan.', 'pl', 'text', VoiceLabel.TEXT_ONLY_PLATFORM));
      expect(again.src).toBe(AUDIO_SRC_PRERENDERED);
    });

    it('system_line_clips_play_by_hash_but_do_not_make_a_studio_story_language', () => {
      // Phase 3: system-lines.mjs writes poiId '' and length system|arrival|nav.
      const nav: string = 'Teraz skręć w lewo (Grodzka).';
      const welcome: string = 'Welcome! Today\'s walk: The Royal Route.';
      const m: string = '{"schemaVersion":1,"clips":[' +
        `{"lang":"pl","poiId":"","personaId":"historian","length":"nav","n":0,` +
        `"file":"audio/pl/_nav/${sha256Hex(nav).substring(0, 16)}.mp3","textSha256":"${sha256Hex(nav)}"},` +
        `{"lang":"zh","personaId":"historian","length":"system","n":0,` +
        `"file":"audio/zh/_system/abc.mp3","textSha256":"${sha256Hex('欢迎！今天的路线是皇家之路。')}"},` +
        `{"lang":"en","poiId":"","personaId":"historian","length":"system","n":0,` +
        `"file":"audio/en/_system/def.mp3","textSha256":"${sha256Hex(welcome)}"}]}`;
      const parsed = parseClipManifest(m);
      expect(parsed.entries.length).toBe(3);
      const ix = new ClipIndex(parsed.entries.concat([entry('en', 'historian', SHA_BARBICAN, 'audio/en/b/full_0.mp3')]));
      expect(ix.systemSize()).toBe(3);
      expect(ix.hasLang('pl')).toBe(false);          // nav cues alone are no "Studio voice" story language
      expect(ix.hasLang('zh')).toBe(false);
      expect(ix.hasLang('en')).toBe(true);
      const pl = selectAudio(ix, query(nav, 'pl', 'text', VoiceLabel.TEXT_ONLY_PLATFORM));
      expect(pl.src).toBe(AUDIO_SRC_PRERENDERED);  // Polish directions become spoken
      const en = selectAudio(ix, query(welcome, 'en', 'voice', VoiceLabel.FALLBACK_ZH_READS_EN));
      expect(en.src).toBe(AUDIO_SRC_PRERENDERED);  // the welcome no longer goes to the zh voice
      const live = selectAudio(ix, query('Next stop: Barbican, about 300 metres from here.', 'en', 'voice',
        VoiceLabel.FALLBACK_ZH_READS_EN));
      expect(live.src).toBe(AUDIO_SRC_TTS);      // live numbers stay on TTS
    });

    it('no_manifest_keeps_current_behaviour', () => {
      const a = selectAudio(undefined, query('This is Barbican.', 'en', 'voice', VoiceLabel.NATIVE));
      expect(a.src).toBe(AUDIO_SRC_TTS);
      expect(a.reason).toBe(ClipReason.NO_MANIFEST);
      const b = selectAudio(new ClipIndex([]), query('This is Barbican.', 'pl', 'text', VoiceLabel.TEXT_ONLY_PLATFORM));
      expect(b.src).toBe(AUDIO_SRC_TEXT);
    });
  });
}

clipSelectionTest();
