/*
 * Plays pre-rendered sentence clips and runtime studio lines (task A13; docs/SERVER.md §2, §6).
 *
 * iOS port: HarmonyOS AVPlayer over sandbox fds -> expo-audio (~1.1) createAudioPlayer({ uri }) with the file:// URI
 * of the downloaded course clip or the cached studio line (<filesDir>/tts/<sha>.mp3). The design is unchanged: one
 * player per clip "slot" (keyed by NarrationPlayer's segment id), so the next sentence can be prepared while the
 * current one plays; a slot is released when its clip completes, fails or is dropped; nothing is kept between
 * sentences (except the lock-screen anchor, see MediaSessionService LockScreen).
 *
 * Flow per slot: file exists? -> createAudioPlayer (AVPlayer item loads) -> isLoaded ('prepared': first
 * playbackStatusUpdate with isLoaded, or the 100 ms load poll) -> play() once armed -> playing / currentTime moving
 * (onClipStart, LockScreen.claim) -> playbackStatusUpdate didJustFinish (onClipDone).
 * Every failure reports onClipError exactly once, so NarrationPlayer can fall back (to text on iOS) for that sentence:
 *   - file missing / empty                  -> ClipErr.OPEN 'open_file' (checked before the player is created);
 *   - decode error / unreadable file        -> expo-audio emits no error event (the item just never becomes ready),
 *                                              so it surfaces as ClipErr.PREPARE_TIMEOUT after CLIP_PREPARE_TIMEOUT_MS;
 *   - play() not reaching 'playing' in time -> the same timeout; any thrown native call -> ClipErr.PLAYER.
 * pause() pauses; resume() restarts the sentence from 0 (a mid-word resume sounds broken).
 *
 * Audio session (warmUp, once): setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: true,
 * interruptionMode: 'doNotMix' }) = AVAudioSession category .playback, so the guide talks with the ringer switch off
 * and with the screen locked (UIBackgroundModes audio). Players are created with keepAudioSessionActive so a pause
 * between sentences does not deactivate the session (MediaSessionService.destroy() releases it after the tour).
 *
 * Interruptions / route loss (§9 rows 12/13): expo-audio 1.1 handles AVAudioSession interruptions and
 * oldDeviceUnavailable route changes natively (it pauses, and on .shouldResume plays, its players) and exposes NO JS
 * event for either. What JS can see is a player that pauses or plays without us asking. Such an "external" change of
 * an active slot is logged AUDIO_INTERRUPT src=clip hint=external_pause|external_play and goes:
 *   - to LockScreen.external() when the lock-screen card is active (it is then a MediaCommand PAUSE / PLAY), else
 *   - to the listener's onInterrupt(HINT_PAUSE | HINT_RESUME), i.e. the same path as a HarmonyOS audioInterrupt.
 * A headphone removal cannot be told apart from an interruption, so onRouteChange is never fed by expo-audio 1.1; the
 * hook stays in ClipPlayerListener (and NarrationPlayer handles it) so it can be wired to a native route event later.
 */
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import type { AudioPlayer, AudioStatus } from 'expo-audio';
import { File } from 'expo-file-system';
import { Log } from '../../app/Log';
import { LogEvents } from '@citytour/core';
import { toUri } from '../remote/FileStore';
import { LockScreen } from '../media/MediaSessionService';

export const CLIP_PREPARE_TIMEOUT_MS: number = 4000;
const LOAD_POLL_MS: number = 100;
const STATUS_INTERVAL_MS: number = 250;
/** A pause we did not ask for is confirmed after this long (the end of a clip also stops the player briefly). */
const EXTERNAL_CONFIRM_MS: number = 300;
/** A pause this close to the end is the clip ending, not an interruption. */
const END_SLACK_S: number = 0.3;

// Interrupt hints as NarrationPlayer understands them (HarmonyOS audio.InterruptHint numbers).
const HINT_RESUME: number = 1;
const HINT_PAUSE: number = 2;

/** Our error codes (negative, never collide with platform codes). */
export class ClipErr {
  static readonly NO_CONTEXT: number = -11;
  static readonly OPEN: number = -12;        // the clip file is missing or empty
  static readonly PREPARE_TIMEOUT: number = -13;
  static readonly PLAYER: number = -14;      // a native player call threw
}

export interface ClipPlayerListener {
  onClipStart: (id: string) => void;
  onClipDone: (id: string) => void;
  onClipError: (id: string, code: number, where: string) => void;
  onInterrupt: (hint: number, forceType: number) => void;
  /** reason 2 = old device unavailable (headphones removed). Not fed by expo-audio 1.1 (see header). */
  onRouteChange?: (reason: number, devices: string) => void;
}

type Timer = ReturnType<typeof setTimeout>;
type Interval = ReturnType<typeof setInterval>;

interface Sub {
  remove(): void;
}

class ClipSlot {
  id: string;
  path: string;
  player: AudioPlayer | undefined = undefined;
  sub: Sub | undefined = undefined;
  prepared: boolean = false;
  armed: boolean = false;
  paused: boolean = false;
  started: boolean = false;
  ended: boolean = false;      // completed, failed or dropped: no more callbacks
  durationMs: number = 0;
  timer: Timer | undefined = undefined;
  poll: Interval | undefined = undefined;
  extCheck: Timer | undefined = undefined;
  t0: number = 0;

  constructor(id: string, path: string) {
    this.id = id;
    this.path = path;
  }
}

function codeOf(e: unknown): number {
  if (e === undefined || e === null) {
    return ClipErr.PLAYER;
  }
  const c = (e as { code?: unknown }).code;
  return typeof c === 'number' ? c : ClipErr.PLAYER;
}

export class ClipPlayer {
  private static modeSet: Promise<void> | undefined = undefined;
  private listener: ClipPlayerListener | undefined = undefined;
  private slots: Map<string, ClipSlot> = new Map<string, ClipSlot>();

  setListener(l: ClipPlayerListener): void {
    this.listener = l;
  }

  /** Configures the audio session once (playback category, background, no mixing). Never throws. */
  warmUp(): Promise<void> {
    if (ClipPlayer.modeSet === undefined) {
      ClipPlayer.modeSet = setAudioModeAsync({
        playsInSilentMode: true, shouldPlayInBackground: true, interruptionMode: 'doNotMix'
      }).then(() => {
        Log.i(LogEvents.NARR_AUDIO, 'event=audio_mode category=playback background=1 interruption=doNotMix');
      }).catch((e: unknown) => {
        ClipPlayer.modeSet = undefined;   // try again with the next clip
        Log.e(LogEvents.NARR_AUDIO, `event=audio_mode_fail ${Log.errKv(e)}`);
      });
    }
    return ClipPlayer.modeSet;
  }

  has(id: string): boolean {
    return this.slots.has(id);
  }

  /** Creates the player and prepares the clip without playing it (prefetch). Idempotent per id. */
  load(id: string, path: string): void {
    if (this.slots.has(id)) {
      return;
    }
    const slot = new ClipSlot(id, path);
    slot.t0 = Date.now();
    this.slots.set(id, slot);
    this.armTimer(slot);
    this.warmUp();
    const uri = toUri(path);
    let exists = false;
    try {
      const f = new File(uri);
      exists = f.exists && f.size > 0;
    } catch (e) {
      exists = false;
    }
    if (!exists) {
      setTimeout(() => this.fail(slot, ClipErr.OPEN, 'open_file'), 0);   // async, like the original fs.open
      return;
    }
    let p: AudioPlayer;
    try {
      p = createAudioPlayer({ uri: uri }, { updateInterval: STATUS_INTERVAL_MS, keepAudioSessionActive: true });
    } catch (e) {
      setTimeout(() => this.fail(slot, codeOf(e), 'create'), 0);
      return;
    }
    slot.player = p;
    try {
      slot.sub = p.addListener('playbackStatusUpdate', (st: AudioStatus) => this.onStatus(slot, st));
    } catch (e) {
      setTimeout(() => this.fail(slot, codeOf(e), 'listen'), 0);
      return;
    }
    // The ready event may have been emitted before we listened: poll isLoaded until prepared (or the timeout).
    slot.poll = setInterval(() => {
      if (slot.ended || slot.prepared || slot.player === undefined) {
        this.clearPoll(slot);
        return;
      }
      try {
        if (slot.player.isLoaded) {
          this.onPrepared(slot);
        }
      } catch (e) {
        this.fail(slot, codeOf(e), 'poll');
      }
    }, LOAD_POLL_MS);
  }

  /** Plays the clip (loading it first if needed); starts as soon as it is prepared. */
  play(id: string, path: string): void {
    if (!this.slots.has(id)) {
      this.load(id, path);
    }
    const slot = this.slots.get(id);
    if (slot === undefined || slot.ended) {
      return;
    }
    slot.armed = true;
    slot.paused = false;
    if (slot.prepared) {
      this.start(slot);
    }
  }

  pause(id: string): void {
    const slot = this.slots.get(id);
    if (slot === undefined || slot.ended) {
      return;
    }
    slot.paused = true;
    this.clearExt(slot);
    if (slot.player !== undefined && slot.started) {
      try {
        slot.player.pause();
      } catch (e) {
        Log.w(LogEvents.NARR_AUDIO, `where=pause ${Log.errKv(e)}`);
      }
    }
  }

  /** Restarts the sentence from its beginning. */
  resume(id: string): void {
    const slot = this.slots.get(id);
    if (slot === undefined || slot.ended) {
      return;
    }
    slot.paused = false;
    this.clearExt(slot);
    if (!slot.armed || !slot.prepared || slot.player === undefined) {
      return;  // it starts once prepared
    }
    if (!slot.started) {
      this.start(slot);
      return;
    }
    const p = slot.player;
    p.seekTo(0).catch((e: unknown) => {
      Log.w(LogEvents.NARR_AUDIO, `where=seek ${Log.errKv(e)}`);
    }).finally(() => {
      if (!slot.ended && !slot.paused && slot.player === p) {
        this.start(slot);
      }
    });
  }

  durationMs(id: string): number {
    const slot = this.slots.get(id);
    return slot !== undefined ? slot.durationMs : 0;
  }

  /** Stops and releases one clip; no callback follows. */
  drop(id: string): void {
    const slot = this.slots.get(id);
    if (slot !== undefined) {
      this.release(slot);
    }
  }

  clear(): void {
    const all: ClipSlot[] = Array.from(this.slots.values());
    for (const s of all) {
      this.release(s);
    }
  }

  // ---------- internals ----------

  private onPrepared(slot: ClipSlot): void {
    if (slot.prepared || slot.ended || slot.player === undefined) {
      return;
    }
    slot.prepared = true;
    this.clearPoll(slot);
    let dur = 0;
    try {
      dur = slot.player.duration;
    } catch (e) {
      dur = 0;
    }
    slot.durationMs = dur > 0 && Number.isFinite(dur) ? Math.round(dur * 1000) : 0;
    Log.d(LogEvents.NARR_AUDIO, `event=clip_prepared id=${slot.id} durMs=${slot.durationMs}` +
      ` ms=${Date.now() - slot.t0}`);
    if (!slot.armed) {
      this.clearTimer(slot);   // prefetched: waits for play() without a deadline
    } else if (!slot.paused) {
      this.start(slot);
    }
  }

  private onStatus(slot: ClipSlot, st: AudioStatus): void {
    if (slot.ended || slot.player === undefined) {
      return;
    }
    try {
      if (st.isLoaded && !slot.prepared) {
        this.onPrepared(slot);
      }
      if (st.didJustFinish) {
        if (!slot.started) {
          this.markStarted(slot);   // a very short clip may end before a 'playing' status was seen
        }
        slot.ended = true;
        const id = slot.id;
        this.release(slot);
        this.listener?.onClipDone(id);
        return;
      }
      const moving = st.playing || st.currentTime > 0;
      if (slot.armed && !slot.paused && !slot.started && moving) {
        this.clearTimer(slot);
        this.markStarted(slot);
        return;
      }
      if (!slot.started) {
        return;
      }
      if (st.playing && (slot.paused || !slot.armed)) {
        this.suspect(slot, 'play');
      } else if (!st.playing && !slot.paused && !st.isBuffering) {
        this.suspect(slot, 'pause');
      }
    } catch (e) {
      this.fail(slot, codeOf(e), 'status');
    }
  }

  private markStarted(slot: ClipSlot): void {
    slot.started = true;
    const p = slot.player;
    if (p !== undefined) {
      LockScreen.claim(p);
    }
    this.listener?.onClipStart(slot.id);
  }

  /**
   * A play/pause we did not ask for. Status events can trail our own pause()/play() calls, so the player is checked
   * again after EXTERNAL_CONFIRM_MS; a stop at the very end of the clip is its ending, not a pause.
   */
  private suspect(slot: ClipSlot, cmd: 'pause' | 'play'): void {
    if (slot.extCheck !== undefined) {
      return;
    }
    slot.extCheck = setTimeout(() => {
      slot.extCheck = undefined;
      const p = slot.player;
      if (slot.ended || p === undefined) {
        return;
      }
      try {
        if (cmd === 'pause') {
          const nearEnd = p.duration > 0 && p.currentTime >= p.duration - END_SLACK_S;
          if (!slot.paused && p.paused && !p.playing && !nearEnd) {
            this.onExternal(slot, 'pause');
          }
        } else if ((slot.paused || !slot.armed) && !p.paused) {
          this.onExternal(slot, 'play');
        }
      } catch (e) {
        Log.w(LogEvents.NARR_AUDIO, `where=ext_check ${Log.errKv(e)}`);
      }
    }, EXTERNAL_CONFIRM_MS);
  }

  /** The system (interruption, route loss) or the lock screen paused / played this clip. */
  private onExternal(slot: ClipSlot, cmd: 'pause' | 'play'): void {
    Log.i(LogEvents.AUDIO_INTERRUPT, `src=clip hint=external_${cmd} id=${slot.id} lockscreen=${LockScreen.isEnabled()}`);
    if (cmd === 'pause') {
      slot.paused = true;
      this.clearTimer(slot);
    } else if (slot.player !== undefined) {
      // We are paused: hold the player; the tour's resume() restarts the sentence from its start.
      try {
        slot.player.pause();
      } catch (e) {
        Log.w(LogEvents.NARR_AUDIO, `where=ext_play_hold ${Log.errKv(e)}`);
      }
    }
    if (LockScreen.external(cmd)) {
      return;
    }
    try {
      this.listener?.onInterrupt(cmd === 'pause' ? HINT_PAUSE : HINT_RESUME, 0);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=ClipPlayer.onInterrupt ${Log.errKv(e)}`);
    }
  }

  private start(slot: ClipSlot): void {
    if (slot.player === undefined || slot.ended) {
      return;
    }
    if (!slot.started) {
      this.armTimer(slot);   // play() must reach 'playing' in time, or we fall back
    }
    this.clearExt(slot);
    try {
      slot.player.muted = false;
      slot.player.play();
    } catch (e) {
      this.fail(slot, codeOf(e), 'play');
    }
  }

  private armTimer(slot: ClipSlot): void {
    this.clearTimer(slot);
    slot.timer = setTimeout(() => {
      slot.timer = undefined;
      // A paused, prepared slot waits for resume() (which re-arms this timer via start()).
      if (!slot.ended && !slot.started && !(slot.paused && slot.prepared) && (slot.armed || !slot.prepared)) {
        this.fail(slot, ClipErr.PREPARE_TIMEOUT, `timeout_${CLIP_PREPARE_TIMEOUT_MS}ms`);
      }
    }, CLIP_PREPARE_TIMEOUT_MS);
  }

  private clearTimer(slot: ClipSlot): void {
    if (slot.timer !== undefined) {
      clearTimeout(slot.timer);
      slot.timer = undefined;
    }
  }

  private clearPoll(slot: ClipSlot): void {
    if (slot.poll !== undefined) {
      clearInterval(slot.poll);
      slot.poll = undefined;
    }
  }

  private clearExt(slot: ClipSlot): void {
    if (slot.extCheck !== undefined) {
      clearTimeout(slot.extCheck);
      slot.extCheck = undefined;
    }
  }

  private fail(slot: ClipSlot, code: number, where: string): void {
    if (slot.ended) {
      return;
    }
    Log.w(LogEvents.NARR_AUDIO, `event=clip_error id=${slot.id} path=${slot.path} code=${code} where=${where}`);
    const id = slot.id;
    this.release(slot);
    try {
      this.listener?.onClipError(id, code, where);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=ClipPlayer.onClipError ${Log.errKv(e)}`);
    }
  }

  private release(slot: ClipSlot): void {
    slot.ended = true;
    this.clearTimer(slot);
    this.clearPoll(slot);
    this.clearExt(slot);
    if (this.slots.get(slot.id) === slot) {
      this.slots.delete(slot.id);
    }
    const sub = slot.sub;
    slot.sub = undefined;
    try {
      sub?.remove();
    } catch (e) {
      Log.w(LogEvents.NARR_AUDIO, `where=off ${Log.errKv(e)}`);
    }
    const p = slot.player;
    slot.player = undefined;
    if (p === undefined) {
      return;
    }
    if (LockScreen.retain(p)) {
      return;   // kept as the lock-screen anchor; LockScreen removes it when the next clip takes over
    }
    try {
      p.pause();
      p.remove();
    } catch (e) {
      Log.w(LogEvents.NARR_AUDIO, `where=release ${Log.errKv(e)}`);
    }
  }
}
