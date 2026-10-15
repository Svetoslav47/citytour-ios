/*
 * MediaSessionPort implementation (docs/ARCHITECTURE.md §2.6, task A6).
 *
 * iOS port: HarmonyOS AVSession -> the iOS Now Playing card (lock screen / Control Center) driven by expo-audio
 * (~1.1): player.setActiveForLockScreen(true, metadata) / updateLockScreenMetadata(). expo-audio ties the card to ONE
 * AudioPlayer and handles the remote commands itself (MPRemoteCommandCenter play / pause / toggle / scrub on the
 * active player); it has no JS command callback. So:
 *   - LockScreen (below) is the small shared hook between ClipPlayer and this service: ClipPlayer hands it the
 *     player of each sentence clip that starts playing (claim) and asks it before removing a finished player
 *     (retain). The last clip's player is kept, muted and rewound, as the card's anchor between sentences, so the card
 *     does not vanish after every sentence.
 *   - A play/pause the app did not cause (seen by ClipPlayer as a playbackStatusUpdate it did not ask for, or a play
 *     on the anchor) is reported through LockScreen.external() and dispatched as MediaCommand PLAY / PAUSE, logged
 *     AVS_CMD like the original.
 * Limits (documented in README "iOS differences"): no next / previous / favorite / stop buttons (expo-audio 1.1 only
 * enables play, pause, toggle and scrubbing; scrubbing just seeks inside the sentence); the card exists only after
 * the first clip or studio line has played (a text-only tour has no card); the card's play/pause state mirrors the
 * clip player, not the tour (setState() is logged only). An audio-session interruption or headphone removal also
 * pauses the player natively and is indistinguishable from a lock-screen pause, so it reaches the tour as PAUSE.
 * Every platform call is wrapped; failures log AVS_FAIL and the tour continues with in-app controls only (§9 row 15).
 */
import { setIsAudioActiveAsync } from 'expo-audio';
import type { AudioMetadata, AudioPlayer, AudioStatus } from 'expo-audio';
import { EngineEventType, MediaMeta, MediaPlayState } from '@citytour/core';
import { MediaCommand, MediaCommandListener, MediaSessionPort } from '@citytour/core';
import { VoiceLabel } from '@citytour/core';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';

export const AVS_TAG: string = 'CityTour';
export const AVS_ARTIST_BASE: string = 'CityTour · Historian';

/** ARCHITECTURE §2.6 command table. TourController (A7) dispatches these; `stop` only pauses the tour. */
export function engineEventForCommand(cmd: MediaCommand): EngineEventType {
  switch (cmd) {
    case MediaCommand.PLAY:
      return EngineEventType.USER_RESUME;
    case MediaCommand.NEXT:
      return EngineEventType.USER_SKIP;
    case MediaCommand.PREVIOUS:
      return EngineEventType.USER_REPLAY;
    case MediaCommand.FAVORITE:
      return EngineEventType.USER_MORE;
    default:
      return EngineEventType.USER_PAUSE; // PAUSE and STOP: we never end a tour from the lock screen
  }
}

/** "CityTour · Historian" (+ " · DEMO" for the simulated Demo walk). The voice type is not shown to the listener. */
export function artistLine(meta: MediaMeta): string {
  let a = meta.artist !== undefined && meta.artist.length > 0 ? meta.artist : AVS_ARTIST_BASE;
  if (meta.demo) {
    a += ' · DEMO';
  }
  return a;
}

export type LockScreenCommand = 'play' | 'pause';

interface Sub {
  remove(): void;
}

/**
 * The shared lock-screen hook between ClipPlayer (who owns the players) and MediaSessionService (who owns the
 * session). All static: there is one Now Playing card per app. Every call is guarded and never throws.
 */
export class LockScreen {
  private static enabled: boolean = false;
  private static meta: AudioMetadata = { title: 'CityTour', artist: AVS_ARTIST_BASE, albumTitle: 'CityTour' };
  private static owner: AudioPlayer | undefined = undefined;   // the player the card follows
  private static held: AudioPlayer | undefined = undefined;    // a finished clip player kept as the card's anchor
  private static heldSub: Sub | undefined = undefined;
  private static onCmd: ((c: LockScreenCommand) => void) | undefined = undefined;

  static isEnabled(): boolean {
    return LockScreen.enabled;
  }

  /** MediaSessionService.init(): the card follows the next clip that plays. */
  static enable(meta: AudioMetadata, onCmd: (c: LockScreenCommand) => void): void {
    LockScreen.enabled = true;
    LockScreen.meta = meta;
    LockScreen.onCmd = onCmd;
  }

  /** MediaSessionService.destroy(): clears the card and frees the anchor player. */
  static disable(): void {
    LockScreen.enabled = false;
    LockScreen.onCmd = undefined;
    const o = LockScreen.owner;
    LockScreen.owner = undefined;
    if (o !== undefined) {
      try {
        o.setActiveForLockScreen(false);
      } catch (e) {
        Log.w(LogEvents.AVS_FAIL, `where=lockscreen_off ${Log.errKv(e)}`);
      }
    }
    LockScreen.dropHeld();
  }

  static setMetadata(md: AudioMetadata): void {
    LockScreen.meta = md;
    const o = LockScreen.owner;
    if (!LockScreen.enabled || o === undefined) {
      return;
    }
    try {
      o.updateLockScreenMetadata(md);
    } catch (e) {
      Log.w(LogEvents.AVS_FAIL, `where=updateLockScreenMetadata ${Log.errKv(e)}`);
    }
  }

  /** ClipPlayer: `p` has started playing a sentence; the card follows it. */
  static claim(p: AudioPlayer): void {
    if (!LockScreen.enabled) {
      return;
    }
    if (LockScreen.owner !== p) {
      try {
        p.setActiveForLockScreen(true, LockScreen.meta);
        LockScreen.owner = p;
      } catch (e) {
        Log.w(LogEvents.AVS_FAIL, `where=setActiveForLockScreen ${Log.errKv(e)}`);
        return;
      }
    }
    if (LockScreen.held !== p) {
      LockScreen.dropHeld();   // the new owner took over: the old anchor can go
    }
  }

  /**
   * ClipPlayer is about to remove `p` (its sentence ended, failed or was dropped). True = the card's owner is kept
   * as the anchor (paused, muted, rewound) and removed later by the hook; false = the caller removes it.
   */
  static retain(p: AudioPlayer): boolean {
    if (!LockScreen.enabled || LockScreen.owner !== p) {
      return false;
    }
    if (LockScreen.held === p) {
      return true;
    }
    LockScreen.dropHeld();
    LockScreen.held = p;
    try {
      p.pause();
      p.muted = true;   // a lock-screen "play" on the anchor must not replay the old sentence aloud
      p.seekTo(0).catch((e: unknown) => Log.w(LogEvents.AVS_FAIL, `where=anchor_seek ${Log.errKv(e)}`));
      LockScreen.heldSub = p.addListener('playbackStatusUpdate', (st: AudioStatus) => {
        if (!st.playing || LockScreen.held !== p) {
          return;
        }
        try {
          p.pause();
          p.seekTo(0).catch(() => undefined);
        } catch (e) {
          Log.w(LogEvents.AVS_FAIL, `where=anchor_pause ${Log.errKv(e)}`);
        }
        LockScreen.external('play');
      });
    } catch (e) {
      Log.w(LogEvents.AVS_FAIL, `where=anchor ${Log.errKv(e)}`);
    }
    return true;
  }

  /** ClipPlayer: a play/pause it did not cause. True = dispatched as a lock-screen MediaCommand. */
  static external(cmd: LockScreenCommand): boolean {
    const l = LockScreen.onCmd;
    if (!LockScreen.enabled || l === undefined) {
      return false;
    }
    try {
      l(cmd);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=LockScreen.external cmd=${cmd} ${Log.errKv(e)}`);
    }
    return true;
  }

  private static dropHeld(): void {
    const h = LockScreen.held;
    const sub = LockScreen.heldSub;
    LockScreen.held = undefined;
    LockScreen.heldSub = undefined;
    try {
      sub?.remove();
    } catch (e) {
      Log.w(LogEvents.AVS_FAIL, `where=anchor_unsub ${Log.errKv(e)}`);
    }
    if (h === undefined) {
      return;
    }
    if (LockScreen.owner === h) {
      LockScreen.owner = undefined;
    }
    try {
      h.pause();
      h.remove();
    } catch (e) {
      Log.w(LogEvents.AVS_FAIL, `where=anchor_remove ${Log.errKv(e)}`);
    }
  }
}

const COMMANDS: MediaCommand[] = [MediaCommand.PLAY, MediaCommand.PAUSE];

export class MediaSessionService implements MediaSessionPort {
  private active: boolean = false;
  private onCommand: MediaCommandListener = (cmd: MediaCommand) => {};
  private lastTitle: string = '';
  private lastArtist: string = '';
  private lastAlbum: string = '';
  private lastState: MediaPlayState | undefined = undefined;
  private pendingMeta: MediaMeta | undefined = undefined;
  private lastCmd: string = '';

  isActive(): boolean {
    return this.active;
  }

  /** Last command as "cmd=… ev=…" for the DevPanel, '' if none yet. */
  lastCommandLine(): string {
    return this.lastCmd;
  }

  init(onCommand: MediaCommandListener): Promise<boolean> {
    this.onCommand = onCommand;
    if (this.active) {
      return Promise.resolve(true);
    }
    try {
      const meta: MediaMeta = this.pendingMeta !== undefined ? this.pendingMeta :
        { title: 'CityTour', artist: AVS_ARTIST_BASE, voiceLabel: VoiceLabel.NATIVE, demo: false };
      LockScreen.enable(this.toMetadata(meta), (c: LockScreenCommand) => {
        this.dispatch(c === 'play' ? MediaCommand.PLAY : MediaCommand.PAUSE);
      });
      this.active = true;
      this.applyMeta(meta);
      Log.i(LogEvents.AVS_META, `event=active session=${AVS_TAG} type=audio src=expo-audio_lockscreen` +
        ` cmds=${COMMANDS.join(',')}`);
      return Promise.resolve(true);
    } catch (e) {
      Log.e(LogEvents.AVS_FAIL, `where=init ${Log.errKv(e)}`);
      return Promise.resolve(false);
    }
  }

  private dispatch(cmd: MediaCommand): void {
    this.lastCmd = `cmd=${cmd} ev=${engineEventForCommand(cmd)}`;
    Log.i(LogEvents.AVS_CMD, `cmd=${cmd} ev=${engineEventForCommand(cmd)}`);
    try {
      this.onCommand(cmd);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=MediaSessionService.onCommand cmd=${cmd} ${Log.errKv(e)}`);
    }
  }

  setMeta(meta: MediaMeta): void {
    this.pendingMeta = meta;
    if (!this.active) {
      return; // applied by init()
    }
    this.applyMeta(meta);
  }

  private toMetadata(meta: MediaMeta): AudioMetadata {
    return {
      title: meta.title, artist: artistLine(meta),
      albumTitle: meta.album !== undefined && meta.album !== '' ? meta.album : 'CityTour'
    };
  }

  private applyMeta(meta: MediaMeta): void {
    const md = this.toMetadata(meta);
    const artist = md.artist ?? '';
    const album = md.albumTitle ?? '';
    if (meta.title === this.lastTitle && artist === this.lastArtist && album === this.lastAlbum) {
      return;
    }
    try {
      LockScreen.setMetadata(md);
      this.lastTitle = meta.title;
      this.lastArtist = artist;
      this.lastAlbum = album;
      Log.i(LogEvents.AVS_META, `title="${meta.title}" artist="${artist}"`);
    } catch (e) {
      Log.e(LogEvents.AVS_FAIL, `where=setAVMetadata ${Log.errKv(e)}`);
    }
  }

  /** The iOS card mirrors the clip player itself; the requested state is only recorded and logged. */
  setState(state: MediaPlayState): void {
    if (state === this.lastState) {
      return;
    }
    this.lastState = state;
    Log.i(LogEvents.AVS_META, `state=${state}`);
  }

  async destroy(): Promise<void> {
    const was = this.active;
    this.active = false;
    this.lastTitle = '';
    this.lastArtist = '';
    this.lastAlbum = '';
    this.lastState = undefined;
    this.pendingMeta = undefined;
    LockScreen.disable();
    if (!was) {
      return;
    }
    try {
      await setIsAudioActiveAsync(false);   // lets other apps' audio resume after the tour
      Log.i(LogEvents.AVS_META, 'event=destroyed');
    } catch (e) {
      Log.w(LogEvents.AVS_FAIL, `where=destroy ${Log.errKv(e)}`);
    }
  }
}
