/*
 * SIMULATED TourControl for UI development (T0). It does not read location or speak: it replays a canned
 * 11-stop Royal Route snapshot sequence (Walking -> Approaching -> AtStop teaser -> AtStop full -> ... -> Finished)
 * every AppConfig.SCRIPTED_STEP_MS / speed. Every snapshot has source = DEMO, so the UI shows SIMULATED.
 * A7's TourController replaces it in AppContainer.tourControl().
 * iOS port: unchanged behaviour; only the timer handle type differs (React Native setInterval returns an opaque id).
 */
import { ContentTier, Lang } from '@citytour/core';
import { VoiceLabel } from '@citytour/core';
import {
  EngineSnapshot, NextInfo, NowPlaying, PlatformStatus, RelDir, SignalQuality, StopProgress, StopStatus, TourPhase,
  TourPlan, UserPos
} from '@citytour/core';
import { FixSource, SnapshotListener, TourControl } from '@citytour/core';
import { AppConfig } from '@/main/AppConfig';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';

/** Royal Route order (docs/REVIEW.md stop numbering). The first, third and fourth ids match StubPackRepository. */
export const SCRIPTED_ROUTE_IDS: string[] = [
  'poi_stub_barbican', 'poi_stub_florian_gate', 'poi_stub_st_marys', 'poi_stub_cloth_hall', 'poi_stub_mickiewicz',
  'poi_stub_town_hall_tower', 'poi_stub_st_adalbert', 'poi_stub_sts_peter_paul', 'poi_stub_st_andrew',
  'poi_stub_kanonicza', 'poi_stub_wawel'
];

const LEG_M: number = 230;          // ~2,497 m / 11 stops, rounded
const WALK_MPS: number = 1.3;

enum ScriptStep { WALK_FAR = 0, WALK_NEAR = 1, APPROACH = 2, TEASER = 3, FULL = 4 }

const STEPS_PER_STOP: number = 5;

export class ScriptedTourControl implements TourControl {
  private readonly ids: string[];
  private listeners: SnapshotListener[] = [];
  private snapshot: EngineSnapshot;
  private cursor: number = -1;       // index into stops * STEPS_PER_STOP
  private timerId: ReturnType<typeof setInterval> | undefined = undefined;
  private speed: number = AppConfig.DEMO_DEFAULT_SPEED;
  private paused: boolean = false;
  private phaseOverride: TourPhase | undefined = undefined;
  private tourId: string = 'royal-route';

  constructor(ids: string[] = SCRIPTED_ROUTE_IDS) {
    this.ids = ids.length > 0 ? ids : SCRIPTED_ROUTE_IDS;
    this.snapshot = this.build(TourPhase.IDLE);
  }

  plan(tourId: string, budgetMin: number): Promise<TourPlan> {
    this.tourId = tourId;
    this.stopTimer();
    this.cursor = -1;
    this.phaseOverride = undefined;
    const plan: TourPlan = {
      tourId: tourId, order: this.ids.slice(), costS: Math.round(this.ids.length * (LEG_M / WALK_MPS + 90)),
      walkM: LEG_M * (this.ids.length - 1), savedM: 0, exact: true, algo: 'scripted', ms: 0,
      budgetS: Math.max(0, budgetMin) * 60, legs: []
    };
    this.publish(this.build(TourPhase.READY));
    Log.i(LogEvents.TOUR_SCRIPTED, `action=plan tour=${tourId} n=${this.ids.length} src=demo`);
    return Promise.resolve(plan);
  }

  start(): Promise<void> {
    this.phaseOverride = undefined;
    this.paused = false;
    this.cursor = 0;
    this.publish(this.frame());
    this.startTimer();
    Log.i(LogEvents.TOUR_SCRIPTED, `action=start speed=${this.speed} src=demo`);
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.publish(this.frame());
  }

  resume(): void {
    this.paused = false;
    this.publish(this.frame());
  }

  skip(): void {
    this.jumpToNextStop();
  }

  replay(): void {
    const stop = this.stopIdx();
    if (stop >= 0) {
      this.cursor = stop * STEPS_PER_STOP + ScriptStep.TEASER;
      this.publish(this.frame());
    }
  }

  more(): void {
    // No deep narration in the script; keep the current frame.
    this.publish(this.frame());
  }

  end(): void {
    this.stopTimer();
    this.phaseOverride = TourPhase.ABORTED;
    this.publish(this.frame());
    Log.i(LogEvents.TOUR_SCRIPTED, 'action=end src=demo');
  }

  setSource(kind: FixSource): Promise<void> {
    // The script is always SIMULATED; the real source arrives with A5/A7.
    Log.i(LogEvents.TOUR_SCRIPTED, `action=setSource requested=${kind} effective=demo`);
    return Promise.resolve();
  }

  subscribe(l: SnapshotListener): () => void {
    this.listeners.push(l);
    this.safeCall(l, this.snapshot);
    return () => {
      this.listeners = this.listeners.filter((x: SnapshotListener) => x !== l);
    };
  }

  current(): EngineSnapshot {
    return this.snapshot;
  }

  setDemoSpeed(mult: number): void {
    const allowed = mult === 1 || mult === 2 || mult === 4 || mult === 8;
    this.speed = allowed ? mult : AppConfig.DEMO_DEFAULT_SPEED;
    if (this.timerId !== undefined) {
      this.stopTimer();
      this.startTimer();
    }
    Log.i(LogEvents.TOUR_SCRIPTED, `action=speed x=${this.speed} src=demo`);
  }

  demoJumpToNext(): void {
    this.jumpToNextStop();
  }

  /** X2: the scripted stand-in has no stories to switch; logged only. */
  setStoryLang(lang: Lang): void {
    Log.i(LogEvents.LANG_SWITCH, `to=${lang} action=none where=scripted`);
  }

  /** Stops the timer and drops listeners. Called from AppContainer.shutdown(). */
  dispose(): void {
    this.stopTimer();
    this.listeners = [];
  }

  // ---------- internals ----------

  private jumpToNextStop(): void {
    if (this.cursor < 0) {
      return;
    }
    const next = (this.stopIdx() + 1) * STEPS_PER_STOP;
    this.cursor = next;
    this.publish(this.frame());
  }

  private startTimer(): void {
    // 2 s per step at the default speed (x4), 1 s at x8, 8 s at x1.
    const stepMs = Math.max(250, Math.round(AppConfig.SCRIPTED_STEP_MS * AppConfig.DEMO_DEFAULT_SPEED / this.speed));
    this.timerId = setInterval(() => {
      this.tick();
    }, stepMs);
  }

  private stopTimer(): void {
    if (this.timerId !== undefined) {
      clearInterval(this.timerId);
      this.timerId = undefined;
    }
  }

  private tick(): void {
    try {
      if (this.paused || this.cursor < 0) {
        return;
      }
      this.cursor++;
      const f = this.frame();
      this.publish(f);
      if (f.phase === TourPhase.FINISHED) {
        this.stopTimer();
        Log.i(LogEvents.TOUR_SCRIPTED, 'action=finished src=demo');
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=ScriptedTourControl.tick ${Log.errKv(e as Object)}`);
    }
  }

  private stopIdx(): number {
    return this.cursor < 0 ? -1 : Math.floor(this.cursor / STEPS_PER_STOP);
  }

  private frame(): EngineSnapshot {
    if (this.phaseOverride !== undefined) {
      return this.build(this.phaseOverride);
    }
    if (this.cursor < 0) {
      return this.build(TourPhase.READY);
    }
    if (this.stopIdx() >= this.ids.length) {
      return this.build(TourPhase.FINISHED);
    }
    const step = this.cursor % STEPS_PER_STOP;
    if (step === ScriptStep.APPROACH) {
      return this.build(TourPhase.APPROACHING);
    }
    if (step === ScriptStep.TEASER || step === ScriptStep.FULL) {
      return this.build(TourPhase.AT_STOP);
    }
    return this.build(TourPhase.WALKING);
  }

  private build(phase: TourPhase): EngineSnapshot {
    const k = this.stopIdx();
    const step = this.cursor < 0 ? -1 : this.cursor % STEPS_PER_STOP;
    const finished = phase === TourPhase.FINISHED;
    const stops: StopProgress[] = this.ids.map((id: string, i: number) => {
      let status = StopStatus.PENDING;
      if (finished || i < k) {
        status = StopStatus.VISITED;
      } else if (i === k && phase === TourPhase.APPROACHING) {
        status = StopStatus.APPROACHING;
      } else if (i === k && phase === TourPhase.AT_STOP) {
        status = StopStatus.VISITED;
      }
      const sp: StopProgress = { poiId: id, order: i + 1, status: status };
      return sp;
    });
    const remainingStops = finished ? 0 : Math.max(0, this.ids.length - Math.max(0, k));
    const distToStop = step === ScriptStep.WALK_FAR ? LEG_M : step === ScriptStep.WALK_NEAR ? 140 :
      step === ScriptStep.APPROACH ? 60 : 0;
    const platform: PlatformStatus = {
      bgRunning: false, avsActive: false, ttsEngine: 'none', sourceKind: FixSource.DEMO,
      realGpsAccuracyM: Number.NaN, demoHold: phase === TourPhase.AT_STOP
    };
    const snap: EngineSnapshot = {
      phase: phase, tourId: this.tourId, stops: stops, currentStopIdx: finished ? this.ids.length : Math.max(0, k),
      signal: SignalQuality.GOOD, offRoute: false, paused: this.paused, speechText: false,
      plannedOrder: this.ids.slice(), walkedM: Math.max(0, k) * LEG_M + (LEG_M - distToStop),
      remainingM: finished ? 0 : (remainingStops - 1) * LEG_M + distToStop, issues: [],
      voiceLabel: VoiceLabel.FALLBACK_ZH_READS_EN, source: FixSource.DEMO, platform: platform
    };
    if (k >= 0 && k < this.ids.length && !finished && phase !== TourPhase.ABORTED) {
      const poiId = this.ids[k];
      const next: NextInfo = {
        poiId: poiId, distanceM: distToStop, etaS: Math.round(distToStop / WALK_MPS),
        relDir: distToStop === 0 ? RelDir.HERE : RelDir.AHEAD, bearingDeg: 200, maneuverText: 'Continue straight',
        maneuverDistM: distToStop
      };
      snap.next = next;
      const user: UserPos = {
        x: 0, y: 0, lat: 50.0617, lng: 19.9373, accuracyM: 5, courseDeg: 200,
        speedMps: phase === TourPhase.AT_STOP ? 0 : WALK_MPS, source: FixSource.DEMO
      };
      snap.user = user;
      if (phase === TourPhase.AT_STOP) {
        const full = step === ScriptStep.FULL;
        const np: NowPlaying = {
          itemId: `scripted:${poiId}:${full ? 'full' : 'teaser'}`, poiId: poiId, kind: full ? 'fullStory' : 'stopStory',
          sentenceIndex: 0, sentenceCount: full ? 3 : 2,
          caption: `Scripted caption for stop ${k + 1} (${full ? 'full story' : 'teaser'}).`,
          tier: ContentTier.NAME_ONLY, lang: Lang.EN
        };
        snap.nowPlaying = np;
      }
    }
    return snap;
  }

  private publish(s: EngineSnapshot): void {
    this.snapshot = s;
    this.listeners.forEach((l: SnapshotListener) => this.safeCall(l, s));
  }

  private safeCall(l: SnapshotListener, s: EngineSnapshot): void {
    try {
      l(s);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=ScriptedTourControl.listener ${Log.errKv(e as Object)}`);
    }
  }
}
