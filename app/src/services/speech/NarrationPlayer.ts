/*
 * SpeechPort implementation: one utterance (sentence) in flight, the next one prefetched (ARCHITECTURE §2.5,
 * PLAN §0.4, task A4).
 *
 * iOS port: the built-in system TTS (Core Speech Kit -> PcmPlayer AudioRenderer) is DROPPED (docs/PORTING.md).
 * Per utterance the chain is:
 *   1. clip   a pre-rendered course clip whose textSha256 equals sha256(utf8(u.text)) for the same language and
 *             persona (pure ClipSelection.selectAudio over the active course's audio/manifest.json), played through
 *             ClipPlayer (expo-audio);
 *   2. remote a runtime studio line rendered by the server for a sentence without a clip (RuntimeClipSource =
 *             RemoteVoice, which fetches it before speak(); <filesDir>/tts/<sha>.mp3), played through the same
 *             ClipPlayer and logged NARR_AUDIO src=remote|remote_cache;
 *   3. text   no audio: start/done fire on a reading-time timer (estimateReadingMs), so the tour keeps its pace and
 *             the captions advance exactly like a text-only tour.
 * This holds whatever the plan's speechMode: a 'voice' plan has no engine on iOS (VoiceManager upgrades a text-only
 * plan to 'voice' only so the tour hands sentences to the SpeechPort and RemoteVoice can try the server), so every
 * sentence without studio audio takes path 3.
 * Clip sentences keep the original queue semantics: prefetch(n+1) prepares the next clip while n plays; pause;
 * resume-from-start; preempt (a speak() while another utterance is in flight stops it, logged); stop; exactly one
 * done/error per utterance; a playback watchdog (clip length + WATCHDOG_MARGIN_MS) never lets the tour hang.
 * A clip that fails to open/prepare/play (e.g. deleted from the sandbox) is marked failed and that sentence falls back
 * to text on the spot (NARR_FALLBACK). One NARR_AUDIO line per utterance: src=prerendered|remote|remote_cache|text.
 * A10 (ARCHITECTURE §9 rows 12/13): audio interrupts (PAUSE/STOP/RESUME) and the headphones going away reach an
 * AudioEventListener (AppContainer -> TourController). On iOS, ClipPlayer derives them from expo-audio player status
 * changes it did not cause (see ClipPlayer); without a listener the player still pauses/resumes itself.
 * Courses (docs/SERVER.md §2, §6): the app ships no course; the clip index is the active downloaded course's
 * manifest (setCourseClips; file:// URIs). No course (or no clip manifest) = remote/text only.
 */
import { Lang } from '@citytour/core';
import { SpeechCapabilities, SpeechListener, SpeechPort, Utterance, VoicePlan } from '@citytour/core';
import { estimateReadingMs, SPEECH_MODE_TEXT } from '@citytour/core';
import {
  AUDIO_SRC_PRERENDERED, AUDIO_SRC_TEXT, AudioDecision, ClipEntry, ClipIndex, ClipQuery, ClipReason, selectAudio,
  shortSha
} from '@citytour/core';
import { VoiceLabel } from '@citytour/core';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';
import { ClipPlayer, ClipPlayerListener } from '../audio/ClipPlayer';
import { TtsErr } from './TtsEngines';
import { sha256Hex } from '@citytour/core';
import { VoiceManager } from './VoiceManager';

/** A server-rendered studio line for one sentence (RemoteVoice). */
export class RuntimeClip {
  file: string = '';     // file:// URI, '' = none
  src: string = '';      // 'remote' | 'remote_cache'
  reason: string = '';   // why (or why not), for NARR_AUDIO
}

/** Supplies runtime studio lines (docs/SERVER.md §2 step 2). Synchronous: RemoteVoice fetches before speak(). */
export interface RuntimeClipSource {
  lookup(u: Utterance, sha: string): RuntimeClip | undefined;
  onClipFailed(sha: string, file: string): void;
}

/** What the clip index alone decides for an utterance (RemoteVoice asks before going to the server). */
export class LocalAudio {
  clip: boolean = false;
  optOut: boolean = false;        // the user's text-only or cross-language choice
  platformText: boolean = false;  // the fallback is text (always on iOS: there is no system voice)
  sha: string = '';
  file: string = '';              // the clip's URI when `clip` (a streamed course: maybe not fetched yet)
}

export const WATCHDOG_MARGIN_MS: number = 4000;

// audio.InterruptHint values of HarmonyOS, kept as the hint vocabulary between ClipPlayer and NarrationPlayer.
export const HINT_RESUME: number = 1;
export const HINT_PAUSE: number = 2;
export const HINT_STOP: number = 3;
// audio.AudioStreamDeviceChangeReason.REASON_OLD_DEVICE_UNAVAILABLE (headphones unplugged).
export const REASON_OLD_DEVICE_UNAVAILABLE: number = 2;

/** §9 rows 12/13 hook (not part of SpeechPort). hint: 'PAUSE' | 'STOP' | 'RESUME'. */
export interface AudioEventListener {
  onInterrupt: (hint: string) => void;
  onRouteLost: (devices: string) => void;
}

/** Interrupt hint number -> the engine's hint name; '' for hints the engine ignores (DUCK, UNDUCK, MUTE). */
export function interruptHintName(hint: number): string {
  if (hint === HINT_PAUSE) {
    return 'PAUSE';
  }
  if (hint === HINT_STOP) {
    return 'STOP';
  }
  if (hint === HINT_RESUME) {
    return 'RESUME';
  }
  return '';
}

/** Persona voice parameters (Persona.voice in the pack). Kept for the API; studio audio is not re-tuned on iOS. */
export interface VoiceTuning {
  speed: number;
  pitch: number;
  volume: number;
}

type Timer = ReturnType<typeof setTimeout>;

class Job {
  u: Utterance;
  plan: VoicePlan;
  segId: string;
  started: boolean = false;
  finished: boolean = false;
  t0: number = 0;          // speak() time (UTT latency / duration)
  watchdog: Timer | undefined = undefined;
  textTimer: Timer | undefined = undefined;
  textRemainingMs: number = 0;
  textStartedAt: number = 0;
  clip: ClipEntry | undefined = undefined;   // set = this sentence plays from a clip (course or runtime studio line)
  audioReason: string = '';
  sha: string = '';
  audioLogged: boolean = false;
  pendingFallback: boolean = false;          // the clip failed while paused: resume() starts the text path
  srcOverride: string = '';                  // 'remote' | 'remote_cache' for a runtime studio line

  constructor(u: Utterance, plan: VoicePlan, segId: string) {
    this.u = u;
    this.plan = plan;
    this.segId = segId;
  }

  isClip(): boolean {
    return this.clip !== undefined;
  }

  /** iOS: no system voice, so every sentence without a clip is text (whatever the plan's speechMode). */
  isText(): boolean {
    return this.clip === undefined;
  }

  src(): string {
    if (this.clip !== undefined) {
      return this.srcOverride !== '' ? this.srcOverride : AUDIO_SRC_PRERENDERED;
    }
    return AUDIO_SRC_TEXT;
  }

  label(): VoiceLabel {
    if (this.clip !== undefined) {
      return VoiceLabel.PRERENDERED;
    }
    return this.plan.speechMode === SPEECH_MODE_TEXT ? this.plan.label : VoiceLabel.TEXT_ONLY_PLATFORM;
  }
}

export class NarrationPlayer implements SpeechPort {
  private voice: VoiceManager;
  private clips: ClipPlayer | undefined;
  private clipIndex: ClipIndex | undefined = undefined;
  private courseEntries: ClipEntry[] = [];
  private runtime: RuntimeClipSource | undefined = undefined;
  private clipLoad: Promise<void> = Promise.resolve();
  private listener: SpeechListener | undefined = undefined;
  private audioListener: AudioEventListener | undefined = undefined;
  private current: Job | undefined = undefined;
  private prefetched: Job | undefined = undefined;
  private paused: boolean = false;
  private segSeq: number = 0;
  private tuning: VoiceTuning = { speed: 1, pitch: 1, volume: 1 };

  constructor(voice: VoiceManager, clips?: ClipPlayer) {
    this.voice = voice;
    this.clips = clips;
    if (clips !== undefined) {
      const cl: ClipPlayerListener = {
        onClipStart: (id: string) => this.onClipStart(id),
        onClipDone: (id: string) => this.onClipDone(id),
        onClipError: (id: string, code: number, where: string) => this.onClipError(id, code, where),
        onInterrupt: (hint: number, force: number) => this.onInterrupt(hint, force),
        onRouteChange: (reason: number, devices: string) => this.onRouteChange(reason, devices)
      };
      clips.setListener(cl);
    }
  }

  // ---------- SpeechPort ----------

  /** Reads the clip manifest, then the voice caps (no system voice on iOS), and sets up the audio session. */
  init(): Promise<SpeechCapabilities> {
    const t0 = Date.now();
    // The manifest is read before the caps resolve, so the tour's storyVoicePlan already knows the clip languages.
    return this.loadClipManifest().then(() => this.voice.capabilities()).then((caps: SpeechCapabilities) => {
      const p = this.voice.plan(Lang.EN);
      Log.i(LogEvents.TTS_INIT, `event=speech_init mode=clips_remote_text system_tts=none en_label=${p.label}` +
        ` clips=${this.clipCount()} ms=${Date.now() - t0}`);
      this.clips?.warmUp();
      return caps;
    }).catch((e: unknown) => {
      Log.e(LogEvents.TTS_INIT_FAIL, `where=NarrationPlayer.init ${Log.errKv(e)}`);
      return this.voice.lastCaps();
    });
  }

  /** §9 rows 12/13: who hears about audio interrupts and headphone loss (AppContainer wires the TourController). */
  setAudioEventListener(l: AudioEventListener | undefined): void {
    this.audioListener = l;
  }

  setListener(l: SpeechListener): void {
    this.listener = l;
  }

  /** The VoiceManager this player plans with (RemoteVoice registers its studio-voice source on it). */
  voiceManager(): VoiceManager {
    return this.voice;
  }

  /**
   * Resolves when the active course's clip manifest (if any) has been loaded, so the tour's storyVoicePlan knows the
   * clip languages. Never rejects.
   */
  loadClipManifest(): Promise<void> {
    return this.clipLoad;
  }

  /** AppContainer: the active course's clip manifest is being read. */
  trackClipLoad(p: Promise<void>): void {
    this.clipLoad = p.catch((e: unknown) => {
      Log.e(LogEvents.NARR_AUDIO, `event=manifest_fail ${Log.errKv(e)}`);
    });
  }

  /** The active downloaded course's clips (file:// URIs), [] for no course. Rebuilds the index. */
  setCourseClips(entries: ClipEntry[]): void {
    this.courseEntries = entries;
    this.rebuildIndex();
    Log.i(LogEvents.NARR_AUDIO, `event=course_clips clips=${entries.length} total=${this.clipCount()}`);
  }

  /** The clip index entries of the active course (a streamed course prefetches the next sentences from them). */
  courseClipEntries(): ClipEntry[] {
    return this.courseEntries;
  }

  /** A streamed clip did not arrive in time: this and later sentences of it fall back until it arrives. */
  markClipUnavailable(file: string): void {
    if (this.clipIndex !== undefined) {
      this.clipIndex.markFailed(file);
    }
  }

  /** A streamed clip arrived (late): it plays again from now on. */
  clipAvailable(file: string): void {
    if (this.clipIndex !== undefined) {
      this.clipIndex.clearFailed(file);
    }
  }

  setRuntimeClipSource(src: RuntimeClipSource | undefined): void {
    this.runtime = src;
  }

  /** What the local clips decide for `u` (no side effects, no log). */
  localAudio(u: Utterance): LocalAudio {
    const out = new LocalAudio();
    try {
      const plan = this.voice.plan(u.lang, true);
      out.platformText = true;   // iOS: no system voice, the end of the chain is always text
      const q: ClipQuery = {
        text: u.text, lang: u.lang, personaId: u.personaId, planSpeechMode: plan.speechMode, planLabel: plan.label,
        planReason: plan.reason
      };
      const d = selectAudio(this.clipIndex, q);
      out.clip = d.clip !== undefined;
      out.file = d.clip !== undefined ? d.clip.file : '';
      out.optOut = d.reason === ClipReason.USER_TEXT_ONLY || d.reason === ClipReason.LISTEN_CHOICE;
      out.sha = d.sha !== '' ? d.sha : sha256Hex(u.text);
    } catch (e) {
      out.optOut = true;
      Log.e(LogEvents.UNCAUGHT, `where=NarrationPlayer.localAudio ${Log.errKv(e)}`);
    }
    return out;
  }

  private rebuildIndex(): void {
    const all: ClipEntry[] = [];
    for (const e of this.courseEntries) {
      all.push(e);
    }
    this.clipIndex = all.length > 0 ? new ClipIndex(all) : undefined;
  }

  /** The loaded clip index (undefined until the manifest is read, or when there is none). */
  loadedClips(): ClipIndex | undefined {
    return this.clipIndex;
  }

  /** True when the manifest has clips for this story language (and persona, when given). */
  hasClips(lang: string, personaId?: string): boolean {
    return this.clipIndex !== undefined && this.clipIndex.hasLang(lang, personaId);
  }

  /** Number of usable clips in the manifest (0 = none loaded). */
  clipCount(): number {
    return this.clipIndex !== undefined ? this.clipIndex.size() : 0;
  }

  setTuning(t: VoiceTuning): void {
    this.tuning = t;
  }

  speak(u: Utterance): void {
    try {
      this.speakInternal(u);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NarrationPlayer.speak id=${u.id} ${Log.errKv(e)}`);
      this.emitError(u.id, TtsErr.THREW);
    }
  }

  prefetch(u: Utterance): void {
    try {
      if (this.current !== undefined && this.current.u.id === u.id) {
        return;
      }
      if (this.prefetched !== undefined) {
        if (this.prefetched.u.id === u.id) {
          return;
        }
        this.discard(this.prefetched, 'prefetch_replaced');
        this.prefetched = undefined;
      }
      const job = this.newJob(u);
      this.prefetched = job;
      if (job.isClip()) {
        this.loadClip(job);
      }
      Log.d(LogEvents.STORY_QUEUE, `event=prefetch id=${u.id} label=${job.label()} src=${job.src()}`);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NarrationPlayer.prefetch id=${u.id} ${Log.errKv(e)}`);
    }
  }

  stopNow(): void {
    try {
      if (this.current !== undefined) {
        Log.i(LogEvents.UTT_DONE, `id=${this.current.u.id} result=stopped`);
        this.discard(this.current, 'stop');
        this.current = undefined;
      }
      if (this.prefetched !== undefined) {
        this.discard(this.prefetched, 'stop');
        this.prefetched = undefined;
      }
      if (this.clips !== undefined) {
        this.clips.clear();
      }
      this.paused = false;
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NarrationPlayer.stopNow ${Log.errKv(e)}`);
    }
  }

  pause(): void {
    if (this.paused) {
      return;
    }
    this.paused = true;
    const j = this.current;
    try {
      if (j === undefined) {
        return;
      }
      this.clearWatchdog(j);
      if (j.isClip()) {
        this.clips?.pause(j.segId);
      } else if (j.textTimer !== undefined) {
        clearTimeout(j.textTimer);
        j.textTimer = undefined;
        j.textRemainingMs = Math.max(0, j.textRemainingMs - (Date.now() - j.textStartedAt));
      }
      Log.i(LogEvents.STORY_QUEUE, `event=pause id=${j.u.id}`);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NarrationPlayer.pause ${Log.errKv(e)}`);
    }
  }

  /** Resumes the current sentence from its start (a mid-word resume sounds broken). */
  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    const j = this.current;
    try {
      if (j === undefined) {
        return;
      }
      Log.i(LogEvents.STORY_QUEUE, `event=resume id=${j.u.id}`);
      if (j.pendingFallback) {
        this.startFallback(j);
      } else if (j.isClip()) {
        this.clips?.resume(j.segId);
        if (j.started) {
          this.armWatchdog(j);
        }
      } else {
        this.armTextTimer(j, j.textRemainingMs);
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NarrationPlayer.resume ${Log.errKv(e)}`);
    }
  }

  isSpeaking(): boolean {
    return this.current !== undefined && !this.paused;
  }

  // ---------- extras ----------

  isPaused(): boolean {
    return this.paused;
  }

  /** The live plan for the "Studio voice" / text label: PRERENDERED while a clip plays, text-only otherwise. */
  currentPlan(): VoicePlan | undefined {
    const j = this.current;
    if (j === undefined) {
      return undefined;
    }
    if (!j.isClip()) {
      if (j.plan.speechMode === SPEECH_MODE_TEXT) {
        return j.plan;
      }
      const t: VoicePlan = {
        textLang: j.plan.textLang, speechMode: SPEECH_MODE_TEXT, engineLocale: '', person: 0, languageContext: '',
        label: VoiceLabel.TEXT_ONLY_PLATFORM, reason: j.audioReason
      };
      return t;
    }
    const p: VoicePlan = {
      textLang: j.plan.textLang, speechMode: 'voice', engineLocale: '', person: 0, languageContext: '',
      label: VoiceLabel.PRERENDERED, reason: j.audioReason
    };
    return p;
  }

  dispose(): void {
    this.stopNow();
  }

  // ---------- internals ----------

  private newJob(u: Utterance): Job {
    this.segSeq++;
    const job = new Job(u, this.voice.plan(u.lang), `${u.id}~${this.segSeq}`);
    if (this.clips !== undefined) {
      const q: ClipQuery = {
        text: u.text, lang: u.lang, personaId: u.personaId, planSpeechMode: job.plan.speechMode,
        planLabel: job.plan.label, planReason: job.plan.reason
      };
      let d: AudioDecision;
      try {
        d = selectAudio(this.clipIndex, q);
      } catch (e) {
        Log.e(LogEvents.UNCAUGHT, `where=selectAudio id=${u.id} ${Log.errKv(e)}`);
        d = new AudioDecision();
        d.reason = 'select_threw';
      }
      job.clip = d.clip;
      job.audioReason = d.reason;
      job.sha = d.sha;
      if (d.clip === undefined && this.runtime !== undefined && d.reason !== ClipReason.USER_TEXT_ONLY &&
        d.reason !== ClipReason.LISTEN_CHOICE) {
        this.attachRuntimeClip(job);
      }
    } else {
      job.audioReason = 'no_clip_player';
    }
    return job;
  }

  /** A server-rendered studio line for a sentence without a clip (RemoteVoice already fetched it). */
  private attachRuntimeClip(job: Job): void {
    try {
      const sha = job.sha !== '' ? job.sha : sha256Hex(job.u.text);
      job.sha = sha;
      const rc = this.runtime?.lookup(job.u, sha);
      if (rc === undefined) {
        return;
      }
      if (rc.file === '') {
        job.audioReason = `${job.audioReason} remote=${rc.reason}`;
        return;
      }
      const e: ClipEntry = {
        lang: job.u.lang, poiId: '', personaId: job.u.personaId, length: 'runtime', n: -1, file: rc.file,
        textSha256: sha, durationMs: 0
      };
      job.clip = e;
      job.srcOverride = rc.src;
      job.audioReason = rc.reason;
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NarrationPlayer.attachRuntimeClip ${Log.errKv(e)}`);
    }
  }

  /** One NARR_AUDIO line per utterance, when it starts (prefetch does not count). */
  private logAudio(job: Job): void {
    if (job.audioLogged) {
      return;
    }
    job.audioLogged = true;
    const clip = job.clip !== undefined ? ` clip=${job.clip.file}` : '';
    const plan = job.clip === undefined ? ` plan=${job.plan.label}` : '';
    Log.i(LogEvents.NARR_AUDIO, `src=${job.src()} reason=${job.audioReason} id=${job.u.id} lang=${job.u.lang}` +
      ` persona=${job.u.personaId} sha=${shortSha(job.sha) || 'none'}${clip}${plan}`);
  }

  private loadClip(job: Job): void {
    if (job.clip !== undefined && this.clips !== undefined) {
      this.clips.load(job.segId, job.clip.file);
    }
  }

  private startClip(job: Job): void {
    if (job.clip === undefined || this.clips === undefined) {
      return;
    }
    this.clips.play(job.segId, job.clip.file);
  }

  private speakInternal(u: Utterance): void {
    if (this.current !== undefined) {
      if (this.current.u.id === u.id && !this.current.finished) {
        Log.w(LogEvents.STORY_QUEUE, `event=speak_ignored_same id=${u.id}`);
        return;
      }
      Log.i(LogEvents.UTT_DONE, `id=${this.current.u.id} result=preempted by=${u.id}`);
      const old = this.current;
      this.current = undefined;
      this.discard(old, 'preempt');
    }
    this.paused = false;
    let job: Job;
    if (this.prefetched !== undefined && this.prefetched.u.id === u.id) {
      job = this.prefetched;
      this.prefetched = undefined;
    } else {
      if (this.prefetched !== undefined) {
        this.discard(this.prefetched, 'prefetch_miss');
        this.prefetched = undefined;
      }
      job = this.newJob(u);
    }
    this.current = job;
    job.t0 = Date.now();
    this.logAudio(job);
    if (job.isClip()) {
      this.startClip(job);
    } else {
      this.startText(job);
    }
  }

  private startText(job: Job): void {
    const wasStarted = job.started;
    job.started = true;
    const ms = estimateReadingMs(job.u.text);
    Log.i(LogEvents.UTT_START, `id=${job.u.id} item=${job.u.itemId} lang=${job.u.lang} mode=text label=${job.label()}` +
      ` readMs=${ms}`);
    if (!wasStarted) {
      this.emitStart(job.u.id);
    }
    job.textRemainingMs = ms;
    if (!this.paused) {
      this.armTextTimer(job, ms);
    }
  }

  private armTextTimer(job: Job, ms: number): void {
    job.textStartedAt = Date.now();
    job.textTimer = setTimeout(() => {
      job.textTimer = undefined;
      this.complete(job, 0);
    }, Math.max(0, ms));
  }

  /** code 0 = done; otherwise an error. Exactly once per job. */
  private complete(job: Job, code: number): void {
    if (job.finished) {
      return;
    }
    job.finished = true;
    this.clearWatchdog(job);
    if (job.textTimer !== undefined) {
      clearTimeout(job.textTimer);
      job.textTimer = undefined;
    }
    if (this.current === job) {
      this.current = undefined;
    }
    if (this.clips !== undefined) {
      this.clips.drop(job.segId);
    }
    if (code === 0) {
      Log.i(LogEvents.UTT_DONE, `id=${job.u.id} item=${job.u.itemId} result=ok ms=${Date.now() - job.t0}` +
        ` label=${job.label()} src=${job.src()}`);
      if (!job.started) {
        this.emitStart(job.u.id);
      }
      this.emitDone(job.u.id);
    } else {
      Log.e(LogEvents.UTT_DONE, `id=${job.u.id} item=${job.u.itemId} result=error code=${code}`);
      this.emitError(job.u.id, code);
    }
  }

  /** Cancels a job without reporting it (preempt / stop / prefetch replaced). */
  private discard(job: Job, why: string): void {
    job.finished = true;
    this.clearWatchdog(job);
    if (job.textTimer !== undefined) {
      clearTimeout(job.textTimer);
      job.textTimer = undefined;
    }
    if (this.clips !== undefined) {
      this.clips.drop(job.segId);
    }
    Log.d(LogEvents.STORY_QUEUE, `event=discard id=${job.u.id} why=${why}`);
  }

  /** Playback must end within the clip length + margin; otherwise finish it anyway (never hang the tour). */
  private armWatchdog(job: Job): void {
    this.clearWatchdog(job);
    const known = this.clips !== undefined ? this.clips.durationMs(job.segId) : 0;
    const manifestMs = job.clip !== undefined ? job.clip.durationMs : 0;
    const audioMs = known > 0 ? known : manifestMs > 0 ? manifestMs : estimateReadingMs(job.u.text) * 2;
    const ms = audioMs + WATCHDOG_MARGIN_MS;
    job.watchdog = setTimeout(() => {
      job.watchdog = undefined;
      if (this.current === job && !job.finished && !this.paused) {
        Log.w(LogEvents.TTS_ERR, `id=${job.u.id} code=${TtsErr.WATCHDOG} msg=playback end not seen after ${ms}ms`);
        this.complete(job, 0);
      }
    }, ms);
  }

  private clearWatchdog(job: Job): void {
    if (job.watchdog !== undefined) {
      clearTimeout(job.watchdog);
      job.watchdog = undefined;
    }
  }

  // ---------- clip callbacks ----------

  private onClipStart(segId: string): void {
    const j = this.current;
    if (j === undefined || j.segId !== segId || !j.isClip()) {
      return;
    }
    if (!j.started) {
      j.started = true;
      Log.i(LogEvents.UTT_START, `id=${j.u.id} item=${j.u.itemId} lang=${j.u.lang} mode=clip` +
        ` clip=${j.clip !== undefined ? j.clip.file : ''} label=${j.label()} latencyMs=${Date.now() - j.t0}`);
      this.emitStart(j.u.id);
    }
    if (!this.paused) {
      this.armWatchdog(j);
    }
  }

  private onClipDone(segId: string): void {
    const j = this.current;
    if (j === undefined || j.segId !== segId || !j.isClip()) {
      return;
    }
    this.complete(j, 0);
  }

  /** The clip could not be opened/prepared/played: mark it failed, then show this sentence as text. */
  private onClipError(segId: string, code: number, where: string): void {
    let job: Job | undefined = undefined;
    if (this.current !== undefined && this.current.segId === segId) {
      job = this.current;
    } else if (this.prefetched !== undefined && this.prefetched.segId === segId) {
      job = this.prefetched;
    }
    if (job === undefined || job.clip === undefined || job.finished) {
      return;
    }
    const file = job.clip.file;
    if (job.srcOverride !== '') {
      this.runtime?.onClipFailed(job.sha, file);   // a bad cached mp3 is deleted, the next time asks the server
      job.srcOverride = '';
    } else if (this.clipIndex !== undefined) {
      this.clipIndex.markFailed(file);
    }
    this.clearWatchdog(job);
    job.clip = undefined;
    job.audioReason = `clip_error code=${code} where=${where} clip=${file}`;
    this.segSeq++;
    job.segId = `${job.u.id}~${this.segSeq}`;
    Log.w(LogEvents.NARR_FALLBACK, `id=${job.u.id} from=${VoiceLabel.PRERENDERED} to=${job.label()}` +
      ` reason=clip_error code=${code}`);
    if (this.current === job) {
      job.audioLogged = false;
      if (this.paused) {
        job.pendingFallback = true;
      } else {
        this.startFallback(job);
      }
    }
    // prefetched: nothing to prepare for text; speak() starts it
  }

  private startFallback(job: Job): void {
    job.pendingFallback = false;
    this.logAudio(job);
    this.startText(job);
  }

  private onInterrupt(hint: number, force: number): void {
    try {
      if (hint === HINT_PAUSE || hint === HINT_STOP) {
        this.pause();
      } else if (hint === HINT_RESUME) {
        this.resume();
      }
      const name = interruptHintName(hint);
      const l = this.audioListener;
      if (name !== '' && l !== undefined) {
        l.onInterrupt(name);             // the tour pauses (stopNow) and replays the sentence on RESUME
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NarrationPlayer.onInterrupt hint=${hint} ${Log.errKv(e)}`);
    }
  }

  private onRouteChange(reason: number, devices: string): void {
    try {
      if (reason !== REASON_OLD_DEVICE_UNAVAILABLE) {
        return;
      }
      Log.i(LogEvents.AUDIO_ROUTE, `event=headphones_removed action=pause devices=${devices}` +
        ` speaking=${this.current !== undefined}`);
      if (this.current !== undefined) {
        this.pause();
      }
      const l = this.audioListener;
      if (l !== undefined) {
        l.onRouteLost(devices);          // also when idle: the next story must not start on the loudspeaker
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NarrationPlayer.onRouteChange ${Log.errKv(e)}`);
    }
  }

  private emitStart(id: string): void {
    try {
      this.listener?.onUtteranceStart(id);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=listener.onUtteranceStart ${Log.errKv(e)}`);
    }
  }

  private emitDone(id: string): void {
    try {
      this.listener?.onUtteranceDone(id);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=listener.onUtteranceDone ${Log.errKv(e)}`);
    }
  }

  private emitError(id: string, code: number): void {
    try {
      this.listener?.onUtteranceError(id, code);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=listener.onUtteranceError ${Log.errKv(e)}`);
    }
  }
}
