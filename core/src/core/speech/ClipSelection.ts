/*
 * Pure clip selection for pre-rendered stop stories (task A13). No @kit imports: unit-tested in
 * entry/src/test/ClipSelection.test.ets.
 *
 * The course's audio/manifest.json (downloaded with the course) is written by scripts/voice/render-elevenlabs.mjs: one entry per sentence
 * {lang, poiId, personaId, length, n, file, textSha256, durationMs, voiceId, model, ...}.
 * For every utterance NarrationPlayer asks selectAudio():
 *   prerendered  when the manifest has an entry with textSha256 == sha256(utf8(Utterance.text)) for the same
 *                language and persona, and that clip has not failed before;
 *   tts / text   otherwise, as the VoicePlan says (the native TTS path, or text-only).
 * Matching on the hash of the exact sentence (not on poi/sentence index) is deliberate: a stop item is the arrival
 * lines plus the story sentences (TourEngine.enqueue), so indexes shift; a sentence whose text changed after
 * rendering simply has no match and falls back to TTS; lines with live numbers (approach, "about N metres") never match.
 * The user's explicit "text only" choice (VoiceLabel.TEXT_ONLY_USER) is respected: no clip then either.
 * A text-only plan for lack of a platform voice (Polish) does use a clip: that is the point of pre-rendering.
 * The user's cross-language choice ("listen in English, read in Polish") is respected too: no clip, one voice.
 *
 * Phase 2 (tour level):
 *   storyVoicePlan(base, clipsForLang) is the plan a tour and the UI use: when the manifest has clips for the
 *   story language (and the user has not chosen text only or a cross-language voice) the label becomes
 *   PRERENDERED ("Studio voice") and the mode 'voice', so the engine emits SPEAK and Polish is spoken. The base
 *   plan (engine/person) still voices the dynamic lines and any sentence without a clip.
 *   storyClipCoverage() + ClipIndex.exclude(): where the fallback is text (Polish), a story whose sentences are
 *   only partly covered plays entirely as text, never half spoken / half silent. en/zh fall back per sentence.
 *
 * Phase 3 (system lines): the manifest may also hold clips of the engine's fixed lines (welcome, finish, GPS lost,
 * arrival lines, A9 turn-by-turn cues; scripts/voice/system-lines.mjs), with poiId '' and length system|arrival|nav.
 * selectAudio() plays them by hash like any sentence (also in Polish, whose fallback is text). They do not count for
 * hasLang(): the "Studio voice" story plan needs story clips, not just a few direction cues.
 */
import { VoiceLabel } from '../../contracts/Settings';
import { VoicePlan } from '../../contracts/Ports';
import { sha256Hex } from './Sha256';
import { isListenChoice, LISTEN_REASON_PREFIX, SPEECH_MODE_TEXT, SPEECH_MODE_VOICE } from './VoicePolicy';

export const AUDIO_SRC_PRERENDERED: string = 'prerendered';
export const AUDIO_SRC_TTS: string = 'tts';
export const AUDIO_SRC_TEXT: string = 'text';

/** Reasons in the NARR_AUDIO log line. */
export class ClipReason {
  static readonly HASH_MATCH: string = 'hash_match';
  static readonly NO_MANIFEST: string = 'no_manifest';
  static readonly NO_CLIP: string = 'no_clip';                 // no entry with this text hash (or text changed)
  static readonly LANG_MISMATCH: string = 'lang_mismatch';     // the text hash exists, for another language
  static readonly PERSONA_MISMATCH: string = 'persona_mismatch';
  static readonly CLIP_FAILED: string = 'clip_failed';         // the clip failed to open/play earlier (e.g. deleted)
  static readonly USER_TEXT_ONLY: string = 'user_text_only';
  static readonly LISTEN_CHOICE: string = 'listen_choice';     // the user picked a voice in another language
  static readonly STORY_INCOMPLETE: string = 'story_incomplete'; // excluded: the story is not fully covered
}

export interface ClipEntry {
  lang: string;
  poiId: string;
  personaId: string;
  length: string;
  n: number;
  file: string;          // course-relative in the manifest (absolute once loaded), e.g. 'audio/en/poi_wd_Q807309/full_0.mp3'
  textSha256: string;
  durationMs: number;    // 0 when unknown
}

export class ClipManifestParse {
  entries: ClipEntry[] = [];
  dropped: number = 0;   // malformed entries skipped
  error: string = '';    // '' when the file parsed (even with 0 entries)
  voiceId: string = '';
  model: string = '';
}

interface RawClipEntry {
  lang?: string;
  poiId?: string;
  personaId?: string;
  length?: string;
  n?: number;
  file?: string;
  textSha256?: string;
  durationMs?: number;
}

interface RawClipManifest {
  schemaVersion?: number;
  voiceId?: string;
  model?: string;
  clips?: RawClipEntry[];
}

function isStr(v: string | null | undefined): boolean {
  return typeof v === 'string' && (v as string).length > 0;
}

const SHA_RE: RegExp = new RegExp('^[0-9a-f]{64}$');
const FILE_RE: RegExp = new RegExp('^audio/[A-Za-z0-9_./-]+\\.(mp3|m4a|aac)$');

/** Parses and validates manifest.json. Never throws; malformed entries are dropped and counted. */
export function parseClipManifest(json: string): ClipManifestParse {
  const out = new ClipManifestParse();
  let raw: RawClipManifest;
  try {
    raw = JSON.parse(json) as RawClipManifest;
  } catch (e) {
    out.error = 'json';
    return out;
  }
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    out.error = 'not_object';
    return out;
  }
  out.voiceId = typeof raw.voiceId === 'string' ? raw.voiceId as string : '';
  out.model = typeof raw.model === 'string' ? raw.model as string : '';
  const clips = raw.clips;
  if (clips === undefined || clips === null || !Array.isArray(clips)) {
    out.error = 'no_clips';
    return out;
  }
  for (let i = 0; i < clips.length; i++) {
    const r = clips[i];
    if (r === null || r === undefined || typeof r !== 'object' || !isStr(r.lang) || !isStr(r.personaId) ||
      !isStr(r.file) || !isStr(r.textSha256)) {
      out.dropped++;
      continue;
    }
    const sha = (r.textSha256 as string).toLowerCase();
    const file = r.file as string;
    if (!SHA_RE.test(sha) || !FILE_RE.test(file) || file.indexOf('..') >= 0) {
      out.dropped++;
      continue;
    }
    const e: ClipEntry = {
      lang: r.lang as string,
      poiId: isStr(r.poiId) ? r.poiId as string : '',
      personaId: r.personaId as string,
      length: isStr(r.length) ? r.length as string : '',
      n: typeof r.n === 'number' && Number.isFinite(r.n as number) ? r.n as number : -1,
      file: file,
      textSha256: sha,
      durationMs: typeof r.durationMs === 'number' && Number.isFinite(r.durationMs as number) && (r.durationMs as number) > 0 ?
        r.durationMs as number : 0
    };
    out.entries.push(e);
  }
  return out;
}

/** A clip of a fixed engine line (no stop): system-lines.mjs writes poiId '' and length system|arrival|nav. */
export function isSystemClip(e: ClipEntry): boolean {
  return e.poiId === '';
}

export class ClipLookup {
  entry?: ClipEntry;
  reason: string = ClipReason.NO_CLIP;
}

/** Hash -> entries index, plus the set of clips that failed at runtime (missing file, decoder error). */
export class ClipIndex {
  private byHash: Map<string, ClipEntry[]> = new Map<string, ClipEntry[]>();
  private failed: Set<string> = new Set<string>();
  private excluded: Set<string> = new Set<string>();
  private count: number = 0;
  private systemCount: number = 0;

  constructor(entries: ClipEntry[]) {
    for (const e of entries) {
      if (isSystemClip(e)) {
        this.systemCount++;
      }
      const list = this.byHash.get(e.textSha256);
      if (list === undefined) {
        this.byHash.set(e.textSha256, [e]);
      } else {
        list.push(e);
      }
      this.count++;
    }
  }

  size(): number {
    return this.count;
  }

  /** Clips of fixed system / arrival / nav lines (phase 3). */
  systemSize(): number {
    return this.systemCount;
  }

  /** True when at least one story clip exists for this language (and persona, when given). System lines do not count. */
  hasLang(lang: string, personaId?: string): boolean {
    let found = false;
    this.byHash.forEach((list: ClipEntry[]) => {
      if (!found && list.some((e: ClipEntry) => e.lang === lang && !isSystemClip(e) &&
        (personaId === undefined || personaId === '' || e.personaId === personaId))) {
        found = true;
      }
    });
    return found;
  }

  markFailed(file: string): void {
    this.failed.add(file);
  }

  /** A clip that failed only for lack of time (a streamed clip that arrived late) can play again. */
  clearFailed(file: string): void {
    this.failed.delete(file);
  }

  isFailed(file: string): boolean {
    return this.failed.has(file);
  }

  /** Never play the clip of this sentence hash (its story is only partly covered, see storyClipCoverage). */
  exclude(sha: string): void {
    this.excluded.add(sha);
  }

  isExcluded(sha: string): boolean {
    return this.excluded.has(sha);
  }

  /** Clears the exclusions (a new tour recomputes them). Failed clips stay failed. */
  clearExclusions(): void {
    this.excluded.clear();
  }

  /** Exact text hash + language + persona; skips clips that already failed. */
  find(sha: string, lang: string, personaId: string): ClipLookup {
    const out = new ClipLookup();
    const list = this.byHash.get(sha);
    if (list === undefined || list.length === 0) {
      out.reason = ClipReason.NO_CLIP;
      return out;
    }
    const sameLang = list.filter((e: ClipEntry) => e.lang === lang);
    if (sameLang.length === 0) {
      out.reason = ClipReason.LANG_MISMATCH;
      return out;
    }
    const samePersona = sameLang.filter((e: ClipEntry) => e.personaId === personaId);
    if (samePersona.length === 0) {
      out.reason = ClipReason.PERSONA_MISMATCH;
      return out;
    }
    if (this.excluded.has(sha)) {
      out.reason = ClipReason.STORY_INCOMPLETE;
      return out;
    }
    for (const e of samePersona) {
      if (!this.failed.has(e.file)) {
        out.entry = e;
        out.reason = ClipReason.HASH_MATCH;
        return out;
      }
    }
    out.reason = ClipReason.CLIP_FAILED;
    return out;
  }
}

/** What NarrationPlayer needs to know about one utterance (subset of contracts Utterance + VoicePlan). */
export interface ClipQuery {
  text: string;
  lang: string;
  personaId: string;
  planSpeechMode: string;   // VoicePlan.speechMode: 'voice' | 'text'
  planLabel: VoiceLabel;
  planReason?: string;      // VoicePlan.reason: a cross-language listen choice gets no clip
}

export class AudioDecision {
  src: string = AUDIO_SRC_TTS;
  reason: string = '';
  clip?: ClipEntry;
  sha: string = '';
}

/** The one decision function: prerendered clip, else the plan's own path (tts or text). Never throws. */
export function selectAudio(index: ClipIndex | undefined, q: ClipQuery): AudioDecision {
  const d = new AudioDecision();
  const fallback: string = q.planSpeechMode === 'text' ? AUDIO_SRC_TEXT : AUDIO_SRC_TTS;
  d.src = fallback;
  if (q.planLabel === VoiceLabel.TEXT_ONLY_USER) {
    d.reason = ClipReason.USER_TEXT_ONLY;
    return d;
  }
  if (q.planReason !== undefined && isListenReason(q.planReason)) {
    d.reason = ClipReason.LISTEN_CHOICE;
    return d;
  }
  if (index === undefined || index.size() === 0) {
    d.reason = ClipReason.NO_MANIFEST;
    return d;
  }
  d.sha = sha256Hex(q.text);
  const l = index.find(d.sha, q.lang, q.personaId);
  d.reason = l.reason;
  if (l.entry !== undefined) {
    d.src = AUDIO_SRC_PRERENDERED;
    d.clip = l.entry;
  }
  return d;
}

function isListenReason(reason: string): boolean {
  return reason.startsWith(LISTEN_REASON_PREFIX);
}

/**
 * The plan for stop stories (tour engine, Now Walking, Settings, onboarding): base unchanged unless the story
 * language has clips and the user wants a voice in that language; then 'voice' + PRERENDERED. Pure and total.
 */
export function storyVoicePlan(base: VoicePlan, clipsForLang: boolean): VoicePlan {
  if (!clipsForLang || base.label === VoiceLabel.TEXT_ONLY_USER || isListenChoice(base)) {
    return base;
  }
  const p: VoicePlan = {
    textLang: base.textLang, speechMode: SPEECH_MODE_VOICE, engineLocale: base.engineLocale, person: base.person,
    languageContext: base.languageContext, label: VoiceLabel.PRERENDERED,
    reason: `${base.reason} clips=${base.textLang} fallback=${base.label}`
  };
  return p;
}

/** True when a sentence without a clip would be silent (text): stories must then be all clips or none. */
export function storiesAllOrNothing(base: VoicePlan): boolean {
  return base.speechMode === SPEECH_MODE_TEXT;
}

export enum StoryClips { ALL = 'all', PARTIAL = 'partial', NONE = 'none' }

export class StoryCoverage {
  total: number = 0;
  matched: number = 0;
  shas: string[] = [];      // hashes of the sentences that have a clip
  state: StoryClips = StoryClips.NONE;
}

/** How many sentences of one story have a playable clip in this language/persona. Never throws. */
export function storyClipCoverage(index: ClipIndex | undefined, sentences: string[], lang: string,
  personaId: string): StoryCoverage {
  const c = new StoryCoverage();
  c.total = sentences.length;
  if (index === undefined || index.size() === 0) {
    return c;
  }
  for (const s of sentences) {
    const sha = sha256Hex(s);
    const l = index.find(sha, lang, personaId);
    if (l.entry !== undefined) {
      c.matched++;
      c.shas.push(sha);
    }
  }
  c.state = c.total > 0 && c.matched === c.total ? StoryClips.ALL : c.matched > 0 ? StoryClips.PARTIAL :
    StoryClips.NONE;
  return c;
}

/** Short hash prefix for logs. */
export function shortSha(sha: string): string {
  return sha.length > 12 ? sha.substring(0, 12) : sha;
}
