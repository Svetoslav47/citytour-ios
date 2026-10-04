// Suite: TourController.test - module under test: services/tour/TourController (task A7).
// The controller has no @kit import, so it runs here against fake ports: a manual clock + scheduler, a speech fake
// that finishes each sentence after 2 s (or synchronously), a demo and a real location source, background and
// AVSession fakes, and a recording logger.
// Cases: pure helpers (bbox distance, demo speed, utterance id prediction); a full MiniPack demo walk with voice
// (log order PACK_LOAD -> ROUTE_PLAN algo=heldkarp -> LOC_SOURCE kind=demo -> POI_ENTER -> STORY_START ->
// STATE to=finished, teardown of source/background/AVSession, prefetch ids that match what is spoken next);
// out of area (§9 row 8); missing services are one-line no-ops and FIX_TIMEOUT/LOC_NOFIX fire; text-only pacing
// by TICK (no SPEAK); lock-screen pause/play; synchronous speech callbacks (no re-entrant reduce); snapshot
// throttle; end() mid-tour.
// A10 error matrix (ARCHITECTURE §9): location error mapping (rows 1/3/7) and clearing, approximate-only and
// out-of-area on the first real fix (rows 2/8), voice plan issues (rows 9/10), audio interrupt / route loss from
// the speech service (rows 12/13), background failure keeps the screen on (row 14), notifications refused
// (row 16), pack failures (row 17).
// A13 phase 2: clips for the story language turn a platform text-only plan into a spoken PRERENDERED tour (SPEAK
// effects, "Studio voice" label), partly covered stories are excluded where the fallback is text, and the
// snapshot label follows what is audible (live label from the speech service).
import { describe, it, expect } from 'vitest';
import {
  DemoControls, TourController, TourControllerDeps, enStatusOf, kmOutsideBbox, locationErrorIssue,
  controllerNormalizeDemoSpeed as normalizeDemoSpeed, predictNextUtteranceId, voiceIssueFor
} from '../src';
import { Scheduler } from '../src';
import { CORRUPT_PACK_DETAIL, CorruptPackRepository } from '../src';
import {
  AppIssue, EngineSnapshot, IssueCode, IssueSeverity, MediaMeta, MediaPlayState, NextNotice, TourPhase, TourPlan
} from '../src';
import {
  BackgroundListener, BackgroundPort, Clock, Fix, FixListener, FixSource, HapticsPort, LocationErrorListener,
  LocationSource, LoggerPort, MediaCommand, MediaCommandListener, MediaSessionPort, NotifierPort, PackLoadResult,
  PackRepository, PermissionPort, PermissionState, SpeechCapabilities, SpeechListener, SpeechPort, Utterance,
  VoicePlan, VoicePort, VoiceState
} from '../src';
import {
  Lang, MapData, Narration, NarrationLength, PackManifest, Persona, Poi, RouteData, SourceRef, Tour
} from '../src';
import { EnVoiceStrategy, VoiceLabel } from '../src';
import { ClipEntry, ClipIndex } from '../src';
import { sha256Hex } from '../src';
import {
  MINI_BARBICAN, MINI_CLOTH_HALL, MINI_ST_MARYS, MINI_TOUR_ID, miniNarrations, miniPersona, miniPois, miniRoutes,
  miniTour
} from './fixtures/MiniPack';

const T0: number = 1000000;
const M_PER_DEG_LAT: number = 111195;
const KRAKOW_BBOX: number[] = [50.0525, 19.929, 50.0675, 19.947];
const BEIJING_LAT: number = 40.0;
const BEIJING_LNG: number = 116.0;

// ---------------------------------------------------------------- fakes

class FakeClock implements Clock {
  t: number = T0;

  nowMs(): number {
    return this.t;
  }
}

class Timer {
  id: number;
  at: number;
  period: number;
  fn: () => void;

  constructor(id: number, at: number, period: number, fn: () => void) {
    this.id = id;
    this.at = at;
    this.period = period;
    this.fn = fn;
  }
}

class FakeScheduler implements Scheduler {
  private clock: FakeClock;
  private timers: Timer[] = [];
  private seq: number = 0;

  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  after(ms: number, fn: () => void): number {
    this.seq++;
    this.timers.push(new Timer(this.seq, this.clock.t + Math.max(0, ms), 0, fn));
    return this.seq;
  }

  every(ms: number, fn: () => void): number {
    this.seq++;
    this.timers.push(new Timer(this.seq, this.clock.t + ms, ms, fn));
    return this.seq;
  }

  cancel(id: number): void {
    this.timers = this.timers.filter((t: Timer) => t.id !== id);
  }

  count(): number {
    return this.timers.length;
  }

  /** Fires every timer due within `ms`, in time order, moving the clock along. */
  advance(ms: number): void {
    const end: number = this.clock.t + ms;
    for (let guard = 0; guard < 100000; guard++) {
      let next: Timer | undefined = undefined;
      for (const t of this.timers) {
        if (t.at <= end && (next === undefined || t.at < next.at || (t.at === next.at && t.id < next.id))) {
          next = t;
        }
      }
      if (next === undefined) {
        break;
      }
      const due: Timer = next;
      this.clock.t = Math.max(this.clock.t, due.at);
      if (due.period > 0) {
        due.at += due.period;
      } else {
        this.timers = this.timers.filter((t: Timer) => t.id !== due.id);
      }
      due.fn();
    }
    this.clock.t = end;
  }
}

class FakeLog implements LoggerPort {
  lines: string[] = [];

  info(event: string, kv: string): void {
    this.lines.push(`${event} ${kv}`);
  }

  warn(event: string, kv: string): void {
    this.lines.push(`${event} ${kv}`);
  }

  error(event: string, kv: string): void {
    this.lines.push(`${event} ${kv}`);
  }

  count(prefix: string): number {
    return this.lines.filter((l: string) => l.indexOf(prefix) === 0).length;
  }

  /** Index of the first line at or after `from` that starts with `prefix` and contains `part`; -1 if none. */
  find(prefix: string, part: string, from: number): number {
    for (let i = Math.max(0, from); i < this.lines.length; i++) {
      if (this.lines[i].indexOf(prefix) === 0 && this.lines[i].indexOf(part) >= 0) {
        return i;
      }
    }
    return -1;
  }
}

class FakeSpeech implements SpeechPort {
  listener: SpeechListener | undefined = undefined;
  spoken: string[] = [];
  spokenIds: string[] = [];
  prefetched: string[] = [];
  stops: number = 0;
  inFlight: Utterance | undefined = undefined;
  sync: boolean = false;
  sentenceMs: number = 2000;
  private sched: FakeScheduler;

  constructor(sched: FakeScheduler) {
    this.sched = sched;
  }

  init(): Promise<SpeechCapabilities> {
    const c: SpeechCapabilities = { en: VoiceState.DOWNLOADABLE, zh: VoiceState.INSTALLED };
    return Promise.resolve(c);
  }

  setListener(l: SpeechListener): void {
    this.listener = l;
  }

  speak(u: Utterance): void {
    this.spoken.push(u.text);
    this.spokenIds.push(u.id);
    this.inFlight = u;
    const l: SpeechListener | undefined = this.listener;
    if (l === undefined) {
      return;
    }
    l.onUtteranceStart(u.id);
    if (this.sync) {
      this.inFlight = undefined;
      l.onUtteranceDone(u.id);
      return;
    }
    const id: string = u.id;
    this.sched.after(this.sentenceMs, () => {
      if (this.inFlight !== undefined && this.inFlight.id === id) {
        this.inFlight = undefined;
        l.onUtteranceDone(id);
      }
    });
  }

  prefetch(u: Utterance): void {
    this.prefetched.push(u.id);
  }

  stopNow(): void {
    this.stops++;
    this.inFlight = undefined;
  }

  pause(): void {
  }

  resume(): void {
  }

  isSpeaking(): boolean {
    return this.inFlight !== undefined;
  }
}

class FakeVoice implements VoicePort {
  text: boolean;
  override: VoicePlan | undefined = undefined;

  constructor(text: boolean) {
    this.text = text;
  }

  capabilities(): Promise<SpeechCapabilities> {
    const c: SpeechCapabilities = { en: VoiceState.DOWNLOADABLE, zh: VoiceState.INSTALLED };
    return Promise.resolve(c);
  }

  plan(textLang: Lang): VoicePlan {
    if (this.override !== undefined) {
      return this.override;
    }
    const v: VoicePlan = {
      textLang: textLang, speechMode: this.text ? 'text' : 'voice', engineLocale: this.text ? '' : 'zh-CN',
      person: this.text ? 0 : 13, languageContext: this.text ? '' : 'en-US',
      label: this.text ? VoiceLabel.TEXT_ONLY_USER : VoiceLabel.FALLBACK_ZH_READS_EN, reason: 'test'
    };
    return v;
  }

  downloadEnglish(onProgress: (pct: number) => void): Promise<boolean> {
    return Promise.resolve(false);
  }

  setStrategy(s: EnVoiceStrategy): void {
  }
}

class FakePack implements PackRepository {
  loads: number = 0;
  fail: string = '';                   // '' | 'not_ok' | 'throw'

  load(): Promise<PackLoadResult> {
    this.loads++;
    if (this.fail === 'throw') {
      return Promise.reject(new Error('rawfile read failed'));
    }
    if (this.fail === 'not_ok') {
      const bad: PackLoadResult = {
        ok: false, issues: [{ code: IssueCode.PACK_ERR, severity: IssueSeverity.BLOCKING, detail: 'pois.json parse' }]
      };
      return Promise.resolve(bad);
    }
    const m: PackManifest = {
      schemaVersion: 1, packId: 'mini', version: '0', builtAt: '2026-10-03T00:00:00Z',
      origin: { lat: 50.06143, lng: 19.93658 }, bbox: KRAKOW_BBOX, files: [],
      counts: { pois: 4, narrations_en: 2, narrations_pl: 0, narrations_zh: 0, legs: 0 }, licenses: []
    };
    const r: PackLoadResult = { ok: true, manifest: m, issues: [] };
    return Promise.resolve(r);
  }

  pois(): Poi[] {
    return miniPois();
  }

  poi(id: string): Poi | undefined {
    return miniPois().find((p: Poi) => p.id === id);
  }

  tours(): Tour[] {
    return [miniTour()];
  }

  personas(): Persona[] {
    return [miniPersona()];
  }

  routes(): RouteData {
    return miniRoutes();
  }

  map(level: string): MapData {
    const d: MapData = { level: level, origin: { lat: 50.0617, lng: 19.9373 }, bounds: [], layers: [] };
    return d;
  }

  translate: boolean = false;          // X2: serve pl/zh copies of the en fixture ("[zh] ..."), same counts

  narration(poiId: string, personaId: string, lang: Lang, len: NarrationLength): Narration | undefined {
    const n: Narration | undefined =
      miniNarrations().find((x: Narration) => x.poiId === poiId && x.length === len && x.lang === lang);
    if (n !== undefined || !this.translate) {
      return n;
    }
    const en: Narration | undefined =
      miniNarrations().find((x: Narration) => x.poiId === poiId && x.length === len && x.lang === Lang.EN);
    if (en === undefined) {
      return undefined;
    }
    en.lang = lang;
    en.sentences = en.sentences.map((x: string) => `[${lang}] ${x}`);
    return en;
  }

  source(id: string): SourceRef | undefined {
    return undefined;
  }
}

class FakeSource implements LocationSource {
  readonly kind: FixSource;
  running: boolean = false;
  starts: number = 0;
  stops: number = 0;
  emitOnStart: Fix | undefined = undefined;
  private onFix: FixListener | undefined = undefined;
  private onError: LocationErrorListener | undefined = undefined;

  constructor(kind: FixSource) {
    this.kind = kind;
  }

  start(onFix: FixListener, onError: LocationErrorListener): Promise<void> {
    this.running = true;
    this.starts++;
    this.onFix = onFix;
    this.onError = onError;
    if (this.emitOnStart !== undefined) {
      onFix(this.emitOnStart);
    }
    return Promise.resolve();
  }

  stop(): void {
    this.running = false;
    this.stops++;
  }

  isRunning(): boolean {
    return this.running;
  }

  emit(f: Fix): void {
    if (this.running && this.onFix !== undefined) {
      this.onFix(f);
    }
  }

  fail(code: number): void {
    if (this.onError !== undefined) {
      this.onError(code, `test ${code}`);
    }
  }
}

class FakeDemo implements DemoControls {
  speed: number = 0;
  jumps: number = 0;
  rewinds: number = 0;
  hold: () => boolean = () => false;

  isHolding(): boolean {
    return this.hold();
  }

  rewind(): void {
    this.rewinds++;
  }

  setSpeed(mult: number): void {
    this.speed = mult;
  }

  jumpToNextStop(): void {
    this.jumps++;
  }

  /** "poiId@plannedIdx" of every jumpToStop call. */
  stopJumps: string[] = [];

  jumpToStop(poiId: string, plannedIdx: number): void {
    this.stopJumps.push(`${poiId}@${plannedIdx}`);
  }

  setHoldPredicate(p: () => boolean): void {
    this.hold = p;
  }
}

class FakeBackground implements BackgroundPort {
  running: boolean = false;
  starts: number = 0;
  stops: number = 0;

  ok: boolean = true;

  start(): Promise<boolean> {
    this.running = this.ok;
    this.starts++;
    return Promise.resolve(this.ok);
  }

  stop(): Promise<void> {
    this.running = false;
    this.stops++;
    return Promise.resolve();
  }

  isRunning(): boolean {
    return this.running;
  }

  listener: BackgroundListener | undefined = undefined;

  setListener(l: BackgroundListener): void {
    this.listener = l;
  }
}

class FakeMedia implements MediaSessionPort {
  active: boolean = false;
  destroyed: number = 0;
  metas: MediaMeta[] = [];
  states: MediaPlayState[] = [];
  onCommand: MediaCommandListener | undefined = undefined;

  ok: boolean = true;

  init(onCommand: MediaCommandListener): Promise<boolean> {
    this.onCommand = onCommand;
    this.active = this.ok;
    return Promise.resolve(this.ok);
  }

  setMeta(meta: MediaMeta): void {
    this.metas.push(meta);
  }

  setState(state: MediaPlayState): void {
    this.states.push(state);
  }

  isActive(): boolean {
    return this.active;
  }

  destroy(): Promise<void> {
    this.active = false;
    this.destroyed++;
    return Promise.resolve();
  }
}

class FakePerms implements PermissionPort {
  state: PermissionState;

  constructor(state: PermissionState) {
    this.state = state;
  }

  locationState(): Promise<PermissionState> {
    return Promise.resolve(this.state);
  }

  requestLocation(): Promise<PermissionState> {
    return Promise.resolve(this.state);
  }

  openLocationSettings(): Promise<PermissionState> {
    return Promise.resolve(this.state);
  }

  isLocationSwitchOn(): boolean {
    return true;
  }

  requestLocationSwitch(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

class FakeNotifier implements NotifierPort {
  allow: boolean = true;
  published: number = 0;

  requestEnable(): Promise<boolean> {
    return Promise.resolve(this.allow);
  }

  publishNext(notice: NextNotice): Promise<void> {
    this.published++;
    return Promise.resolve();
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

/** Lets resolved promise callbacks run. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------- harness

class Harness {
  clock: FakeClock = new FakeClock();
  sched: FakeScheduler;
  log: FakeLog = new FakeLog();
  speech: FakeSpeech;
  pack: FakePack = new FakePack();
  demo: FakeSource = new FakeSource(FixSource.DEMO);
  real: FakeSource = new FakeSource(FixSource.REAL);
  demoCtl: FakeDemo = new FakeDemo();
  bg: FakeBackground = new FakeBackground();
  media: FakeMedia = new FakeMedia();
  perms: FakePerms = new FakePerms(PermissionState.UNKNOWN);
  voice: FakeVoice;
  notifier: FakeNotifier | undefined = undefined;
  clips: ClipIndex | undefined = undefined;
  live: VoiceLabel | undefined = undefined;
  screen: boolean[] = [];
  withSources: boolean = true;
  withPlatform: boolean = true;
  ctrl: TourController;
  lat: number = 0;
  lng: number = 0;
  acc: number = 5;

  constructor(text: boolean, withSources: boolean, withPlatform: boolean) {
    this.sched = new FakeScheduler(this.clock);
    this.speech = new FakeSpeech(this.sched);
    this.voice = new FakeVoice(text);
    this.withSources = withSources;
    this.withPlatform = withPlatform;
    const deps: TourControllerDeps = {
      pack: this.pack, speech: this.speech, voice: this.voice, log: this.log, clock: this.clock,
      scheduler: this.sched,
      sourceFor: (kind: FixSource): LocationSource | undefined => !this.withSources ? undefined :
        (kind === FixSource.DEMO ? this.demo : this.real),
      demoControls: (): DemoControls | undefined => this.withSources ? this.demoCtl : undefined,
      background: (): BackgroundPort | undefined => this.withPlatform ? this.bg : undefined,
      media: (): MediaSessionPort | undefined => this.withPlatform ? this.media : undefined,
      notifier: (): NotifierPort | undefined => this.notifier,
      haptics: (): HapticsPort | undefined => undefined,
      permissions: (): PermissionPort | undefined => this.perms,
      keepScreenOn: (on: boolean) => {
        this.screen.push(on);
      },
      clips: (): ClipIndex | undefined => this.clips,
      liveVoiceLabel: (): VoiceLabel | undefined => this.live
    };
    this.ctrl = new TourController(deps);
  }

  fixAt(lat: number, lng: number, speed: number, course: number, src: FixSource): Fix {
    const f: Fix = {
      lat: lat, lng: lng, accuracyM: this.acc, speedMps: speed, courseDeg: course, courseAccuracyDeg: Number.NaN,
      timestampMs: this.clock.t, provider: 0, source: src
    };
    return f;
  }

  /** One second: timers fire (TICK, speech), then the demo source emits a fix at the walker's position. */
  second(speed: number, course: number): void {
    this.sched.advance(1000);
    this.demo.emit(this.fixAt(this.lat, this.lng, speed, course, FixSource.DEMO));
  }

  placeNear(poiId: string, metres: number, fromBearingDeg: number): void {
    const p: Poi = this.pack.poi(poiId) as Poi;
    const b: number = fromBearingDeg * Math.PI / 180;
    this.lat = p.lat + metres * Math.cos(b) / M_PER_DEG_LAT;
    this.lng = p.lng + metres * Math.sin(b) / (M_PER_DEG_LAT * Math.cos(p.lat * Math.PI / 180));
  }

  walkTo(poiId: string, speed: number): void {
    const p: Poi = this.pack.poi(poiId) as Poi;
    const k: number = M_PER_DEG_LAT * Math.cos(p.lat * Math.PI / 180);
    const dx: number = (p.lng - this.lng) * k;
    const dy: number = (p.lat - this.lat) * M_PER_DEG_LAT;
    const dist: number = Math.hypot(dx, dy);
    const course: number = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
    const steps: number = Math.floor(dist / speed);
    const lat0: number = this.lat;
    const lng0: number = this.lng;
    for (let i = 1; i <= steps; i++) {
      const f: number = i * speed / dist;
      this.lat = lat0 + dy * f / M_PER_DEG_LAT;
      this.lng = lng0 + dx * f / k;
      this.second(speed, course);
    }
    this.lat = p.lat;
    this.lng = p.lng;
  }

  /** Stands still until the controller left the stop and nothing is queued (max `max` s). */
  dwellUntilQuiet(max: number): void {
    for (let i = 0; i < max; i++) {
      const s: EngineSnapshot = this.ctrl.current();
      if (s.phase !== TourPhase.AT_STOP && s.nowPlaying === undefined && i > 2) {
        return;
      }
      this.second(0, Number.NaN);
    }
  }

  hasIssue(code: IssueCode): boolean {
    return this.ctrl.current().issues.some((i: AppIssue) => i.code === code);
  }

  issue(code: IssueCode): AppIssue | undefined {
    return this.ctrl.current().issues.find((i: AppIssue) => i.code === code);
  }
}

/** Asserts the log events appear in this order (each `[prefix, part]` after the previous match). */
function clip(poiId: string, len: string, n: number, text: string): ClipEntry {
  const e: ClipEntry = {
    lang: 'en', poiId: poiId, personaId: 'historian', length: len, n: n,
    file: `audio/en/${poiId}/${len}_${n}.mp3`, textSha256: sha256Hex(text), durationMs: 1000
  };
  return e;
}

/** St Mary's teaser fully covered, Cloth Hall full story only partly (sentence one). */
function miniClips(): ClipIndex {
  return new ClipIndex([
    clip(MINI_ST_MARYS, 'teaser', 0, 'Fixture teaser sentence one.'),
    clip(MINI_ST_MARYS, 'teaser', 1, 'Fixture teaser sentence two.'),
    clip(MINI_CLOTH_HALL, 'full', 0, 'Fixture full sentence one.')
  ]);
}

function inOrder(log: FakeLog, steps: string[][]): number {
  let at: number = -1;
  for (const s of steps) {
    const i: number = log.find(s[0], s[1], at + 1);
    if (i < 0) {
      return -1;
    }
    at = i;
  }
  return at;
}

function tourControllerTest() {
  describe('TourController', () => {
    it('kmOutsideBbox is 0 inside, ~6900 km for Beijing, NaN for a bad bbox', () => {
      expect(kmOutsideBbox(50.0617, 19.9373, KRAKOW_BBOX)).toBe(0);
      const km: number = kmOutsideBbox(BEIJING_LAT, BEIJING_LNG, KRAKOW_BBOX);
      expect(km > 6500 && km < 7500).toBe(true);
      const near: number = kmOutsideBbox(50.0675 + 0.009, 19.94, KRAKOW_BBOX);   // ~1 km north of the bbox
      expect(near > 0.9 && near < 1.1).toBe(true);
      expect(Number.isNaN(kmOutsideBbox(50, 19, [1, 2]))).toBe(true);
    });

    it('normalizeDemoSpeed snaps to 1/2/4/8 and predictNextUtteranceId follows the queue id scheme', () => {
      expect(normalizeDemoSpeed(8)).toBe(8);
      expect(normalizeDemoSpeed(5)).toBe(4);
      expect(normalizeDemoSpeed(100)).toBe(8);
      expect(normalizeDemoSpeed(Number.NaN)).toBe(4);
      expect(predictNextUtteranceId('it3.0#7', 'it3.1')).toBe('it3.1#8');
      expect(predictNextUtteranceId('noseq', 'it3.1')).toBe('');
    });

    it('demo walk with voice: plan, start, 3 stops, finish and teardown, logs in order', async () => {
      const h: Harness = new Harness(false, true, true);
      await h.ctrl.setSource(FixSource.DEMO);
      const p: TourPlan = await h.ctrl.plan(MINI_TOUR_ID, 0);
      expect(p.algo).toBe('heldkarp');
      expect(p.order.length).toBe(3);
      expect(p.order[0]).toBe(MINI_BARBICAN);
      expect(h.ctrl.current().phase).toBe(TourPhase.READY);
      h.placeNear(MINI_BARBICAN, 120, 0);
      await h.ctrl.start();
      expect(h.ctrl.isRunning()).toBe(true);
      expect(h.bg.starts).toBe(1);
      expect(h.media.active).toBe(true);
      expect(h.demo.starts).toBe(1);
      expect(h.demoCtl.speed).toBe(4);
      expect(h.demoCtl.rewinds).toBe(1);                        // a new tour walks from the start
      expect(h.speech.spoken.length > 0).toBe(true);          // the welcome line starts at once
      for (const id of p.order) {
        h.walkTo(id, 1.3);
        h.dwellUntilQuiet(120);
      }
      for (let i = 0; i < 30 && h.ctrl.isRunning(); i++) {
        h.second(0, Number.NaN);
      }
      const s: EngineSnapshot = h.ctrl.current();
      expect(s.phase).toBe(TourPhase.FINISHED);
      expect(h.ctrl.isRunning()).toBe(false);
      expect(inOrder(h.log, [
        ['PACK_LOAD', 'pois=4'], ['ROUTE_PLAN', 'algo=heldkarp'], ['LOC_SOURCE', 'kind=demo'],
        ['STATE', 'to=walking'], ['POI_ENTER', `id=${MINI_BARBICAN}`], ['STORY_START', `poi=${MINI_BARBICAN}`],
        ['POI_ENTER', `id=${MINI_ST_MARYS}`], ['STORY_START', `poi=${MINI_ST_MARYS}`],
        ['POI_ENTER', `id=${MINI_CLOTH_HALL}`],
        ['STATE', 'to=finished'], ['STATE', 'ev=TEARDOWN why=finished']
      ]) >= 0).toBe(true);
      const enterSm: number = h.log.find('POI_ENTER', `id=${MINI_ST_MARYS}`, 0);
      const narrSm: number = h.log.find('NARR_SOURCE', `poi=${MINI_ST_MARYS} len=teaser`, 0);
      expect(narrSm > enterSm && enterSm >= 0).toBe(true);          // logged after the arrival, not inside reduce
      expect(h.log.lines[narrSm].indexOf('tier=reviewed') >= 0 || h.log.lines[narrSm].indexOf('sources=1') >= 0)
        .toBe(true);
      expect(h.speech.spoken.indexOf('Fixture teaser sentence one.') >= 0).toBe(true);
      expect(h.speech.spoken.indexOf('Fixture full sentence three.') >= 0).toBe(true);
      // Prefetch guesses: at least one prefetched id was spoken next, and none of them was wrong in this walk.
      const hits: number = h.speech.prefetched.filter((id: string) => h.speech.spokenIds.indexOf(id) >= 0).length;
      expect(hits > 0).toBe(true);
      expect(hits).toBe(h.speech.prefetched.length);
      // Platform: AVSession got titles and play..stop, then everything was released.
      expect(h.media.metas.length > 0).toBe(true);
      expect(h.media.states[0]).toBe(MediaPlayState.PLAY);
      expect(h.media.states[h.media.states.length - 1]).toBe(MediaPlayState.STOP);
      expect(h.media.destroyed).toBe(1);
      expect(h.bg.stops).toBe(1);
      expect(h.demo.running).toBe(false);
      expect(h.log.count('UNCAUGHT')).toBe(0);
      expect(h.log.count('NOTIF_PUBLISH')).toBe(1);            // A8 not wired: one no-op line per tour
      expect(h.log.count('HAPTIC kind=arrive')).toBe(1);
      expect(h.sched.count()).toBe(0);                          // no timer left behind
    });

    it('out of area: a Beijing fix at plan time logs LOC_OUT_OF_AREA and plans from the tour start', async () => {
        const h: Harness = new Harness(false, true, true);
        h.perms.state = PermissionState.GRANTED;
        h.real.emitOnStart = h.fixAt(BEIJING_LAT, BEIJING_LNG, 0, Number.NaN, FixSource.REAL);
        const p: TourPlan = await h.ctrl.plan(MINI_TOUR_ID, 0);
        expect(h.real.starts).toBe(1);
        expect(h.log.find('LOC_SOURCE', 'kind=real role=origin', 0) >= 0).toBe(true);
        const i: number = h.log.find('LOC_OUT_OF_AREA', 'km=', 0);
        expect(i >= 0).toBe(true);
        expect(h.log.lines[i].indexOf('src=real') >= 0).toBe(true);
        expect(h.hasIssue(IssueCode.LOC_OUT_OF_AREA)).toBe(true);
        expect(p.order[0]).toBe(MINI_BARBICAN);
        expect(h.ctrl.current().platform.realGpsAccuracyM).toBe(5);
        h.ctrl.shutdown();
        expect(h.real.running).toBe(false);
      });

    it('permission not granted: plan never starts the real source', async () => {
      const h: Harness = new Harness(false, true, true);
      await h.ctrl.plan(MINI_TOUR_ID, 0);
      expect(h.real.starts).toBe(0);
      expect(h.log.count('LOC_OUT_OF_AREA')).toBe(0);
    });

    it('missing services: one no-op line each, LOC_SOURCE available=false, FIX_TIMEOUT and LOC_NOFIX', async () => {
        const h: Harness = new Harness(false, false, false);
        await h.ctrl.setSource(FixSource.DEMO);
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        await h.ctrl.start();
        expect(h.ctrl.isRunning()).toBe(true);
        expect(h.log.find('LOC_SOURCE', 'kind=demo available=false', 0) >= 0).toBe(true);
        expect(h.log.find('BG_START', 'noop=no_service', 0) >= 0).toBe(true);
        expect(h.hasIssue(IssueCode.LOC_UNAVAILABLE)).toBe(true);
        h.sched.advance(26000);
        expect(h.log.count('LOC_LOST')).toBe(1);
        h.sched.advance(5000);
        expect(h.log.count('LOC_NOFIX')).toBe(1);
        h.sched.advance(30000);
        expect(h.log.count('LOC_LOST')).toBe(1);
        expect(h.log.count('BG_START')).toBe(1);
        expect(h.log.count('AVS_META noop')).toBe(1);
        h.ctrl.setDemoSpeed(8);
        h.ctrl.setDemoSpeed(2);
        expect(h.log.count('LOC_SOURCE kind=demo action=speed')).toBe(1);
        expect(h.log.count('UNCAUGHT')).toBe(0);
        h.ctrl.end();
        expect(h.ctrl.isRunning()).toBe(false);
        expect(h.sched.count()).toBe(0);
      });

    it('text only: no SPEAK, captions advance on TICK, the tour still reaches the first stop', async () => {
        const h: Harness = new Harness(true, true, true);
        await h.ctrl.setSource(FixSource.DEMO);
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        h.placeNear(MINI_BARBICAN, 60, 0);
        await h.ctrl.start();
        const first: string = h.ctrl.current().nowPlaying?.caption ?? '';
        expect(first.length > 0).toBe(true);
        h.walkTo(MINI_BARBICAN, 1.3);
        h.dwellUntilQuiet(120);
        expect(h.speech.spoken.length).toBe(0);
        expect(h.log.find('POI_ENTER', `id=${MINI_BARBICAN}`, 0) >= 0).toBe(true);
        expect(h.log.find('STORY_START', 'mode=text', 0) >= 0).toBe(true);
        expect(h.ctrl.current().platform.ttsEngine).toBe('none');
        h.ctrl.end();
      });

    it('A13: clips turn a platform text-only plan into a spoken studio-voice tour; partial stories excluded', async () => {
        const h: Harness = new Harness(true, true, true);
        const base: VoicePlan = {
          textLang: Lang.EN, speechMode: 'text', engineLocale: '', person: 0, languageContext: '',
          label: VoiceLabel.TEXT_ONLY_PLATFORM, reason: 'no_voice_for_lang=en'
        };
        h.voice.override = base;
        const ix: ClipIndex = miniClips();
        h.clips = ix;
        await h.ctrl.setSource(FixSource.DEMO);
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        expect(h.ctrl.current().voiceLabel).toBe(VoiceLabel.PRERENDERED);
        expect(h.ctrl.current().speechText).toBe(false);
        expect(h.log.find('NARR_AUDIO', 'event=story_voice lang=en clips=yes', 0) >= 0).toBe(true);
        expect(h.log.find('NARR_AUDIO', `event=story_incomplete poi=${MINI_CLOTH_HALL}`, 0) >= 0).toBe(true);
        expect(ix.isExcluded(sha256Hex('Fixture full sentence one.'))).toBe(true);
        expect(ix.isExcluded(sha256Hex('Fixture teaser sentence one.'))).toBe(false);
        h.placeNear(MINI_BARBICAN, 60, 0);
        await h.ctrl.start();
        h.walkTo(MINI_BARBICAN, 1.3);
        h.dwellUntilQuiet(120);
        expect(h.speech.spoken.length > 0).toBe(true);        // SPEAK effects: the speech service decides clip/text
        expect(h.log.find('STORY_START', 'mode=voice', 0) >= 0).toBe(true);
        h.ctrl.end();
      });

    it('A13: no clips for the language keeps the plan; the label follows the voice heard at UTT_START', async () => {
        const h: Harness = new Harness(false, true, true);
        h.clips = new ClipIndex([]);
        await h.ctrl.setSource(FixSource.DEMO);
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        expect(h.ctrl.current().voiceLabel).toBe(VoiceLabel.FALLBACK_ZH_READS_EN);
        h.clips = miniClips();
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        expect(h.ctrl.current().voiceLabel).toBe(VoiceLabel.PRERENDERED);
        expect(h.log.find('NARR_AUDIO', 'action=tts_per_sentence', 0) >= 0).toBe(true); // en/zh: no exclusion
        h.placeNear(MINI_BARBICAN, 200, 0);
        h.speech.sentenceMs = 3000;
        h.live = VoiceLabel.FALLBACK_ZH_READS_EN;          // the welcome line has no clip: the zh voice reads it
        await h.ctrl.start();
        expect(h.speech.spoken.length).toBe(1);
        expect(h.ctrl.current().voiceLabel).toBe(VoiceLabel.FALLBACK_ZH_READS_EN);
        const metas: MediaMeta[] = h.media.metas;
        expect(metas[metas.length - 1].voiceLabel).toBe(VoiceLabel.FALLBACK_ZH_READS_EN); // no "Studio voice"
        expect(h.log.find('NARR_AUDIO', 'event=voice_label from=plan to=fallback', 0) >= 0).toBe(true);
        h.live = undefined;                                // between sentences: no flicker back to the plan label
        expect(h.ctrl.current().voiceLabel).toBe(VoiceLabel.FALLBACK_ZH_READS_EN);
        h.live = VoiceLabel.PRERENDERED;                   // the next sentence plays a studio clip
        h.sched.advance(3000);
        expect(h.speech.spoken.length).toBe(2);
        expect(h.ctrl.current().voiceLabel).toBe(VoiceLabel.PRERENDERED);
        expect(h.media.metas[h.media.metas.length - 1].voiceLabel).toBe(VoiceLabel.PRERENDERED);
        const n: number = h.media.metas.length;
        h.live = VoiceLabel.TEXT_ONLY_PLATFORM;            // a silent text sentence keeps the last heard label
        h.sched.advance(3000);
        expect(h.speech.spoken.length).toBe(3);
        expect(h.ctrl.current().voiceLabel).toBe(VoiceLabel.PRERENDERED);
        expect(h.media.metas.length).toBe(n);       // unchanged label: no AVSession update
        h.ctrl.end();
      });

    it('lock-screen commands: pause stops speech and play re-speaks the sentence; demo hold while at a stop', async () => {
        const h: Harness = new Harness(false, true, true);
        await h.ctrl.setSource(FixSource.DEMO);
        const plan: TourPlan = await h.ctrl.plan(MINI_TOUR_ID, 0);
        h.placeNear(MINI_BARBICAN, 200, 0);
        await h.ctrl.start();
        const cmd: MediaCommandListener = h.media.onCommand as MediaCommandListener;
        const n: number = h.speech.spoken.length;
        cmd(MediaCommand.PAUSE);
        expect(h.speech.stops).toBe(1);
        expect(h.ctrl.current().paused).toBe(true);
        expect(h.media.states[h.media.states.length - 1]).toBe(MediaPlayState.PAUSE);
        cmd(MediaCommand.PLAY);
        expect(h.ctrl.current().paused).toBe(false);
        expect(h.speech.spoken.length).toBe(n + 1);
        expect(h.speech.spoken[n]).toBe(h.speech.spoken[n - 1]);
        expect(h.demoCtl.hold()).toBe(false);
        h.speech.sentenceMs = 1000000;                                 // keep the stop story from ending
        h.walkTo(MINI_BARBICAN, 1.3);
        h.second(0, Number.NaN);
        expect(h.ctrl.current().phase).toBe(TourPhase.AT_STOP);
        expect(h.demoCtl.hold()).toBe(true);
        expect(h.ctrl.current().platform.demoHold).toBe(true);
        // "Demo assist: jump" goes to the tour's next open stop (planned order), not just the track's next hold
        h.ctrl.demoJumpToNext();
        expect(h.demoCtl.jumps).toBe(0);
        expect(h.demoCtl.stopJumps.join(',')).toBe(`${plan.order[1]}@1`);
        h.ctrl.end();
      });

    it('demo walk: Skip moves the walker to the tour\'s new target stop; no jump on real GPS or at a stop', async () => {
        const h: Harness = new Harness(false, true, true);
        await h.ctrl.setSource(FixSource.DEMO);
        const plan: TourPlan = await h.ctrl.plan(MINI_TOUR_ID, 0);
        h.placeNear(MINI_BARBICAN, 200, 0);
        await h.ctrl.start();
        h.speech.sentenceMs = 1000000;                                 // keep the stop story from ending
        h.walkTo(MINI_BARBICAN, 1.3);
        h.second(0, Number.NaN);
        expect(h.ctrl.current().phase).toBe(TourPhase.AT_STOP);
        expect(h.demoCtl.hold()).toBe(true);                         // the walker waits while the story plays
        for (let i = 0; i < 5 && h.ctrl.current().phase === TourPhase.AT_STOP; i++) {
          expect(h.demoCtl.stopJumps.length).toBe(0);         // nothing moves while still at the stop
          h.ctrl.skip();                                               // skip the Barbican lines: next stop
        }
        expect(h.ctrl.current().phase).toBe(TourPhase.WALKING);
        expect(h.demoCtl.hold()).toBe(false);                        // released
        expect(h.demoCtl.stopJumps.join(',')).toBe(`${plan.order[1]}@1`);
        expect(h.log.find('LOC_SOURCE', `action=jump to=${plan.order[1]} idx=1 why=skip`, 0) >= 0).toBe(true);
        h.ctrl.skip();                                                 // Skip while walking: (again) to the target
        expect(h.demoCtl.stopJumps.length).toBe(2);
        expect(h.demoCtl.stopJumps[1]).toBe(`${plan.order[1]}@1`);
        h.ctrl.end();
        // real GPS: Skip never moves anything
        const g: Harness = new Harness(false, true, true);
        await g.ctrl.setSource(FixSource.REAL);
        await g.ctrl.plan(MINI_TOUR_ID, 0);
        g.placeNear(MINI_BARBICAN, 200, 0);
        await g.ctrl.start();
        g.ctrl.skip();
        expect(g.demoCtl.stopJumps.length).toBe(0);
        g.ctrl.end();
      });

    it('background cancelled mid-sentence pauses the tour; AVSession artist is CityTour + persona', async () => {
        const h: Harness = new Harness(false, true, true);
        await h.ctrl.setSource(FixSource.DEMO);
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        h.placeNear(MINI_BARBICAN, 200, 0);
        await h.ctrl.start();
        expect(h.media.metas.length > 0).toBe(true);
        expect(h.media.metas[0].artist).toBe('CityTour · Historian');
        expect(h.media.metas[0].demo).toBe(true);
        expect(h.media.metas[0].voiceLabel).toBe(VoiceLabel.FALLBACK_ZH_READS_EN);
        h.speech.stopNow();                                            // the runner stops audio with the task
        (h.bg.listener as BackgroundListener).onCancelled('USER_CANCEL');
        expect(h.ctrl.current().paused).toBe(true);
        expect(h.hasIssue(IssueCode.BG_FAIL)).toBe(true);
        expect(h.log.find('BG_CANCEL', 'action=pause_tour', 0) >= 0).toBe(true);
        const n: number = h.speech.spoken.length;
        h.ctrl.resume();
        expect(h.speech.spoken.length).toBe(n + 1);             // the cut sentence restarts
        h.ctrl.end();
      });

    it('synchronous speech callbacks are queued, not re-entrant', async () => {
      const h: Harness = new Harness(false, true, true);
      h.speech.sync = true;
      await h.ctrl.setSource(FixSource.DEMO);
      await h.ctrl.plan(MINI_TOUR_ID, 0);
      h.placeNear(MINI_BARBICAN, 200, 0);
      await h.ctrl.start();
      expect(h.speech.spoken.length >= 2).toBe(true);                // whole welcome item in one dispatch
      expect(h.ctrl.current().nowPlaying === undefined).toBe(true);
      expect(h.log.count('UNCAUGHT')).toBe(0);
      h.ctrl.end();
    });

    it('snapshots are throttled to 4 Hz and end() mid-tour tears everything down', async () => {
      const h: Harness = new Harness(false, true, true);
      await h.ctrl.setSource(FixSource.DEMO);
      await h.ctrl.plan(MINI_TOUR_ID, 0);
      let published: number = 0;
      const unsub: () => void = h.ctrl.subscribe((s: EngineSnapshot) => {
        published++;
      });
      expect(published).toBe(1);                                // subscribe() delivers the current one
      h.placeNear(MINI_BARBICAN, 300, 0);
      await h.ctrl.start();
      const before: number = published;
      for (let i = 0; i < 10; i++) {
        h.demo.emit(h.fixAt(h.lat, h.lng, 1.3, 180, FixSource.DEMO));  // 10 fixes in the same millisecond
      }
      expect(published - before <= 1).toBe(true);
      h.sched.advance(300);
      expect(published - before <= 2).toBe(true);
      h.ctrl.end();
      expect(h.ctrl.current().phase).toBe(TourPhase.ABORTED);
      expect(h.ctrl.isRunning()).toBe(false);
      expect(h.demo.running).toBe(false);
      expect(h.bg.stops).toBe(1);
      expect(h.media.destroyed).toBe(1);
      const lines: number = h.log.lines.length;
      h.demo.running = true;                                           // a late fix from the stopped source
      h.demo.emit(h.fixAt(h.lat, h.lng, 1.3, 180, FixSource.DEMO));
      expect(h.log.lines.length).toBe(lines);
      unsub();
    });

    it('A10 pure: location error codes map to rows 1/3/7, voice plans to rows 9/10', () => {
      expect(locationErrorIssue(-2, FixSource.REAL).code).toBe(IssueCode.PERM_DENIED);
      expect(locationErrorIssue(201, FixSource.REAL).severity).toBe(IssueSeverity.BLOCKING);
      expect(locationErrorIssue(-4, FixSource.REAL).code).toBe(IssueCode.LOC_SWITCH_OFF);
      expect(locationErrorIssue(3301100, FixSource.REAL).code).toBe(IssueCode.LOC_SWITCH_OFF);
      const u: AppIssue = locationErrorIssue(3301000, FixSource.REAL);
      expect(u.code).toBe(IssueCode.LOC_UNAVAILABLE);
      expect(u.severity).toBe(IssueSeverity.BLOCKING);
      expect(u.detail).toBe('real code=3301000');
      expect(locationErrorIssue(801, FixSource.REAL).code).toBe(IssueCode.LOC_UNAVAILABLE);
      expect(locationErrorIssue(-1, FixSource.REAL).severity).toBe(IssueSeverity.WARN);
      const base: VoicePlan = {
        textLang: Lang.EN, speechMode: 'text', engineLocale: '', person: 0, languageContext: '',
        label: VoiceLabel.TEXT_ONLY_PLATFORM, reason: 'en_status=DOWNLOADABLE zh_status=UNAVAILABLE strategy=x'
      };
      expect(voiceIssueFor(base)?.code).toBe(IssueCode.TTS_INIT_FAIL);
      const pl: VoicePlan = {
        textLang: Lang.PL, speechMode: 'text', engineLocale: '', person: 0, languageContext: '',
        label: VoiceLabel.TEXT_ONLY_PLATFORM, reason: 'no_voice_for_lang=pl'
      };
      expect(voiceIssueFor(pl) === undefined).toBe(true);              // Polish text by design, not a failure
      const user: VoicePlan = {
        textLang: Lang.EN, speechMode: 'text', engineLocale: '', person: 0, languageContext: '',
        label: VoiceLabel.TEXT_ONLY_USER, reason: 'strategy=text-only'
      };
      expect(voiceIssueFor(user) === undefined).toBe(true);
      const zh: VoicePlan = {
        textLang: Lang.EN, speechMode: 'voice', engineLocale: 'zh-CN', person: 13, languageContext: 'en-US',
        label: VoiceLabel.FALLBACK_ZH_READS_EN, reason: 'en_status=DOWNLOADABLE zh_status=INSTALLED'
      };
      const vi: AppIssue | undefined = voiceIssueFor(zh);
      expect(vi?.code).toBe(IssueCode.VOICE_UNAVAILABLE);
      expect(vi?.severity).toBe(IssueSeverity.INFO);
      expect(enStatusOf(zh.reason)).toBe('DOWNLOADABLE');
      expect(enStatusOf('none')).toBe('');
    });

    it('A10 rows 1/3/7: real source errors become issues with the row log line and clear on a fix or demo', async () => {
        const h: Harness = new Harness(false, true, true);
        h.perms.state = PermissionState.DENIED;
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        await h.ctrl.start();
        expect(h.ctrl.isRunning()).toBe(true);
        h.real.fail(-2);
        expect(h.issue(IssueCode.PERM_DENIED)?.severity).toBe(IssueSeverity.BLOCKING);
        expect(h.log.find('PERM_DENIED', 'perm=LOCATION src=real code=-2', 0) >= 0).toBe(true);
        h.real.fail(3301100);
        expect(h.hasIssue(IssueCode.LOC_SWITCH_OFF)).toBe(true);
        expect(h.log.find('LOC_SWITCH_OFF', 'code=3301100', 0) >= 0).toBe(true);
        h.real.fail(3301000);
        expect(h.issue(IssueCode.LOC_UNAVAILABLE)?.severity).toBe(IssueSeverity.BLOCKING);
        expect(h.log.find('LOC_UNAVAILABLE', 'code=3301000', 0) >= 0).toBe(true);
        h.real.emit(h.fixAt(50.0617, 19.9373, 0, Number.NaN, FixSource.REAL));    // the switch came back on
        expect(h.hasIssue(IssueCode.PERM_DENIED) || h.hasIssue(IssueCode.LOC_SWITCH_OFF) ||
          h.hasIssue(IssueCode.LOC_UNAVAILABLE)).toBe(false);
        h.real.fail(-2);
        await h.ctrl.setSource(FixSource.DEMO);                          // [Try Demo walk]
        expect(h.hasIssue(IssueCode.PERM_DENIED)).toBe(false);
        expect(h.log.count('UNCAUGHT')).toBe(0);
        h.ctrl.end();
      });

    it('A10 rows 2/8: first real fix in Beijing with approximate permission => OUT_OF_AREA + APPROX_ONLY', async () => {
        const h: Harness = new Harness(false, true, true);
        await h.ctrl.plan(MINI_TOUR_ID, 0);                              // UNKNOWN: plan never asks
        h.perms.state = PermissionState.APPROX_ONLY;
        await h.ctrl.start();
        h.acc = 1500;
        h.real.emit(h.fixAt(BEIJING_LAT, BEIJING_LNG, 0, Number.NaN, FixSource.REAL));
        h.real.emit(h.fixAt(BEIJING_LAT, BEIJING_LNG, 0, Number.NaN, FixSource.REAL));
        await settle();
        expect(h.hasIssue(IssueCode.LOC_OUT_OF_AREA)).toBe(true);
        expect(h.log.count('LOC_OUT_OF_AREA')).toBe(1);           // once per tour
        expect(h.log.find('LOC_OUT_OF_AREA', 'action=suggest_demo', 0) >= 0).toBe(true);
        expect(h.issue(IssueCode.PERM_APPROX_ONLY)?.severity).toBe(IssueSeverity.WARN);
        expect(h.log.count('PERM_APPROX_ONLY')).toBe(1);
        expect(h.log.count('POI_ENTER')).toBe(0);
        h.ctrl.end();
      });

    it('A10 rows 9/10: a text-only platform plan => TTS_INIT_FAIL; the zh fallback => VOICE_UNAVAILABLE', async () => {
        const h: Harness = new Harness(false, true, true);
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        expect(h.issue(IssueCode.VOICE_UNAVAILABLE)?.severity).toBe(IssueSeverity.INFO);
        expect(h.log.find('VOICE_STATUS', 'lang=en person=8 status=unknown action=fallback_voice', 0) >= 0)
          .toBe(true);
        const t: VoicePlan = {
          textLang: Lang.EN, speechMode: 'text', engineLocale: '', person: 0, languageContext: '',
          label: VoiceLabel.TEXT_ONLY_PLATFORM, reason: 'en_status=DOWNLOADABLE zh_status=UNAVAILABLE'
        };
        h.voice.override = t;
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        expect(h.hasIssue(IssueCode.VOICE_UNAVAILABLE)).toBe(false);   // issues reset per plan
        expect(h.issue(IssueCode.TTS_INIT_FAIL)?.severity).toBe(IssueSeverity.WARN);
        expect(h.log.find('TTS_INIT_FAIL', 'lang=en', 0) >= 0).toBe(true);
        expect(h.ctrl.current().speechText).toBe(true);
        await h.ctrl.setSource(FixSource.DEMO);
        h.placeNear(MINI_BARBICAN, 60, 0);
        await h.ctrl.start();
        expect(h.speech.spoken.length).toBe(0);                    // text only, the tour still runs
        expect((h.ctrl.current().nowPlaying?.caption ?? '').length > 0).toBe(true);
        h.ctrl.end();
      });

    it('A10 rows 12/13: speech-service interrupts and headphone loss reach the engine; ignored with no tour', async () => {
        const h: Harness = new Harness(false, true, true);
        h.ctrl.onAudioInterrupt('PAUSE');                                // no tour yet
        expect(h.log.find('AUDIO_INTERRUPT', 'action=ignored reason=no_tour', 0) >= 0).toBe(true);
        await h.ctrl.setSource(FixSource.DEMO);
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        h.placeNear(MINI_BARBICAN, 200, 0);
        await h.ctrl.start();
        const n: number = h.speech.spoken.length;
        const stops: number = h.speech.stops;
        h.ctrl.onAudioInterrupt('PAUSE');
        expect(h.ctrl.current().paused).toBe(true);
        expect(h.speech.stops).toBe(stops + 1);
        expect(h.hasIssue(IssueCode.AUDIO_INTERRUPT)).toBe(true);
        expect(h.media.states[h.media.states.length - 1]).toBe(MediaPlayState.PAUSE);
        expect(h.log.find('AUDIO_INTERRUPT', 'hint=PAUSE action=pause', 0) >= 0).toBe(true);
        h.ctrl.onAudioInterrupt('RESUME');
        expect(h.ctrl.current().paused).toBe(false);
        expect(h.speech.spoken.length).toBe(n + 1);
        expect(h.speech.spoken[n]).toBe(h.speech.spoken[n - 1]);  // the interrupted sentence again
        h.ctrl.onAudioRouteLost('2');
        expect(h.ctrl.current().paused).toBe(true);
        expect(h.issue(IssueCode.AUDIO_ROUTE_LOST)?.severity).toBe(IssueSeverity.WARN);
        expect(h.log.find('AUDIO_ROUTE', 'device=SPEAKER action=pause', 0) >= 0).toBe(true);
        h.ctrl.onAudioInterrupt('RESUME');
        expect(h.ctrl.current().paused).toBe(true);                     // never resumes on the loudspeaker
        h.ctrl.resume();
        expect(h.hasIssue(IssueCode.AUDIO_ROUTE_LOST)).toBe(false);
        h.ctrl.end();
        h.ctrl.onAudioRouteLost('2');
        expect(h.log.find('AUDIO_ROUTE', 'action=ignored reason=no_tour', 0) >= 0).toBe(true);
        expect(h.log.count('UNCAUGHT')).toBe(0);
      });

    it('A10 rows 14/16: BG start refused keeps the screen on until teardown; notifications refused stay off', async () => {
        const h: Harness = new Harness(false, true, true);
        h.bg.ok = false;
        const nt: FakeNotifier = new FakeNotifier();
        nt.allow = false;
        h.notifier = nt;
        await h.ctrl.setSource(FixSource.DEMO);
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        h.placeNear(MINI_BARBICAN, 120, 0);
        await h.ctrl.start();
        await settle();
        expect(h.ctrl.isRunning()).toBe(true);                         // the tour continues in the foreground
        expect(h.hasIssue(IssueCode.BG_FAIL)).toBe(true);
        expect(h.log.find('BG_FAIL', 'action=foreground_only', 0) >= 0).toBe(true);
        expect(h.screen.join(',')).toBe('true');
        expect(h.issue(IssueCode.NOTIF_DENIED)?.severity).toBe(IssueSeverity.INFO);
        expect(h.log.count('NOTIF_DENIED')).toBe(1);
        h.walkTo(MINI_BARBICAN, 1.3);
        h.dwellUntilQuiet(120);
        expect(h.log.find('POI_ENTER', `id=${MINI_BARBICAN}`, 0) >= 0).toBe(true);
        expect(nt.published).toBe(0);                             // no next-stop notice, nothing else changes
        h.ctrl.end();
        expect(h.screen.join(',')).toBe('true,false');
      });

    it('A10 row 14: a cancelled continuous task keeps the screen on; a granted one never touches it', async () => {
        const h: Harness = new Harness(false, true, true);
        h.notifier = new FakeNotifier();
        await h.ctrl.setSource(FixSource.DEMO);
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        await h.ctrl.start();
        await settle();
        expect(h.screen.length).toBe(0);
        expect(h.hasIssue(IssueCode.NOTIF_DENIED)).toBe(false);
        (h.bg.listener as BackgroundListener).onCancelled('SYSTEM_CANCEL');
        expect(h.screen.join(',')).toBe('true');
        h.ctrl.end();
        expect(h.screen.join(',')).toBe('true,false');
      });

    it('A10 row 17: a pack that fails or throws gives an empty plan and a BLOCKING PACK_ERR, never a crash', async () => {
        const h: Harness = new Harness(false, true, true);
        h.pack.fail = 'not_ok';
        const p: TourPlan = await h.ctrl.plan(MINI_TOUR_ID, 0);
        expect(p.order.length).toBe(0);
        expect(h.issue(IssueCode.PACK_ERR)?.severity).toBe(IssueSeverity.BLOCKING);
        expect(h.log.find('PACK_ERR', 'reason=not_ok', 0) >= 0).toBe(true);
        await h.ctrl.start();                                            // a start without a plan is ignored
        expect(h.ctrl.isRunning()).toBe(false);
        h.pack.fail = 'throw';
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        expect(h.log.find('PACK_ERR', 'reason=load_threw', 0) >= 0).toBe(true);
        expect(h.hasIssue(IssueCode.PACK_ERR)).toBe(true);
        h.pack.fail = '';
        const ok: TourPlan = await h.ctrl.plan(MINI_TOUR_ID, 0);         // recovers once the pack loads
        expect(ok.order.length).toBe(3);
        expect(h.hasIssue(IssueCode.PACK_ERR)).toBe(false);
        expect(h.log.count('UNCAUGHT')).toBe(0);
      });

    it('A10 row 17 demo: CorruptPackRepository (AppConfig.DEBUG_CORRUPT_PACK) => BLOCKING PACK_ERR src=debug', async () => {
        const h: Harness = new Harness(false, true, true);
        const bad: CorruptPackRepository = new CorruptPackRepository(h.log);
        const deps: TourControllerDeps = {
          pack: bad, speech: h.speech, voice: h.voice, log: h.log, clock: h.clock, scheduler: h.sched,
          sourceFor: (kind: FixSource): LocationSource | undefined => kind === FixSource.DEMO ? h.demo : h.real,
          demoControls: (): DemoControls | undefined => h.demoCtl,
          background: (): BackgroundPort | undefined => h.bg,
          media: (): MediaSessionPort | undefined => h.media,
          notifier: (): NotifierPort | undefined => undefined,
          haptics: (): HapticsPort | undefined => undefined,
          permissions: (): PermissionPort | undefined => h.perms
        };
        const c: TourController = new TourController(deps);
        const p: TourPlan = await c.plan('royal-route', 0);
        expect(p.order.length).toBe(0);
        const i: AppIssue | undefined = c.current().issues.find((x: AppIssue) => x.code === IssueCode.PACK_ERR);
        expect(i?.severity).toBe(IssueSeverity.BLOCKING);
        expect(i?.detail).toBe(CORRUPT_PACK_DETAIL);
        expect(h.log.find('PACK_ERR', 'file=pois.json reason=parse src=debug', 0) >= 0).toBe(true);
        await c.start();
        expect(c.isRunning()).toBe(false);
        expect(bad.tours().length + bad.pois().length + bad.routes().legs.length).toBe(0);
        expect(bad.narration('x', 'y', Lang.EN, NarrationLength.TEASER) === undefined).toBe(true);
        expect(h.log.count('UNCAUGHT')).toBe(0);
        c.shutdown();
      });

    it('A10 row 15: AVSession refused => AVS_FAIL (INFO), the tour runs with in-app controls', async () => {
        const h: Harness = new Harness(false, true, true);
        h.media.ok = false;
        await h.ctrl.setSource(FixSource.DEMO);
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        h.placeNear(MINI_BARBICAN, 120, 0);
        await h.ctrl.start();
        expect(h.ctrl.isRunning()).toBe(true);
        expect(h.issue(IssueCode.AVS_FAIL)?.severity).toBe(IssueSeverity.INFO);
        expect(h.log.find('AVS_FAIL', 'where=controller result=false', 0) >= 0).toBe(true);
        expect(h.ctrl.current().platform.avsActive).toBe(false);
        h.ctrl.pause();
        expect(h.ctrl.current().paused).toBe(true);                    // in-app controls still work
        h.ctrl.resume();
        h.walkTo(MINI_BARBICAN, 1.3);
        expect(h.log.find('POI_ENTER', `id=${MINI_BARBICAN}`, 0) >= 0).toBe(true);
        h.ctrl.end();
      });

    it('A13+X2: after a language switch the label follows the sentence actually playing', async () => {
        const h: Harness = new Harness(false, true, true);
        h.pack.translate = true;
        h.clips = miniClips();
        await h.ctrl.setSource(FixSource.DEMO);
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        h.placeNear(MINI_BARBICAN, 200, 0);
        h.speech.sentenceMs = 3000;
        h.live = VoiceLabel.PRERENDERED;                   // the welcome plays a studio clip
        await h.ctrl.start();
        expect(h.ctrl.current().voiceLabel).toBe(VoiceLabel.PRERENDERED);
        h.ctrl.setStoryLang(Lang.ZH);                      // no zh clips: the zh voice from the next sentence on
        expect(h.ctrl.current().voiceLabel).toBe(VoiceLabel.PRERENDERED);   // the clip is still playing
        expect(h.media.metas[h.media.metas.length - 1].voiceLabel).toBe(VoiceLabel.PRERENDERED);
        h.live = VoiceLabel.NATIVE;                        // the next (zh) sentence: native zh voice
        h.sched.advance(3000);
        expect(h.ctrl.current().voiceLabel).toBe(VoiceLabel.NATIVE);
        expect(h.media.metas[h.media.metas.length - 1].voiceLabel).toBe(VoiceLabel.NATIVE);
        h.ctrl.end();
      });

    it('X2: setStoryLang mid-story re-runs the voice plan, continues in 中文 at the next sentence, prefetch follows', async () => {
        const h: Harness = new Harness(false, true, true);
        h.pack.translate = true;
        h.clips = miniClips();                                   // English studio clips only
        h.ctrl.setStoryLang(Lang.EN);                            // no tour yet: saved for the next plan
        expect(h.log.find('LANG_SWITCH', 'where=next_plan', 0) >= 0).toBe(true);
        await h.ctrl.setSource(FixSource.DEMO);
        await h.ctrl.plan(MINI_TOUR_ID, 0);
        expect(h.ctrl.current().voiceLabel).toBe(VoiceLabel.PRERENDERED);
        h.placeNear(MINI_BARBICAN, 60, 0);
        await h.ctrl.start();
        h.walkTo(MINI_BARBICAN, 1.3);
        h.dwellUntilQuiet(120);
        h.speech.sentenceMs = 1000000;                           // sentences end only when the test says so
        h.walkTo(MINI_ST_MARYS, 1.3);
        const listener: SpeechListener = h.speech.listener as SpeechListener;
        for (let i = 0; i < 20; i++) {
          const u: Utterance | undefined = h.speech.inFlight;
          if (u !== undefined && u.text === 'Fixture teaser sentence one.') {
            break;
          }
          if (u !== undefined) {
            h.speech.inFlight = undefined;
            listener.onUtteranceDone(u.id);
          } else {
            h.second(0, Number.NaN);
          }
        }
        expect((h.speech.inFlight as Utterance).text).toBe('Fixture teaser sentence one.');
        const metas: number = h.media.metas.length;
        h.ctrl.setStoryLang(Lang.ZH);
        expect(h.log.find('NARR_AUDIO', 'event=story_voice lang=zh clips=no', 0) >= 0).toBe(true);
        expect(h.log.find('LANG_SWITCH', 'from=en to=zh', 0) >= 0).toBe(true);
        expect(h.ctrl.options().lang).toBe(Lang.ZH);
        expect(h.ctrl.current().voiceLabel).toBe(VoiceLabel.FALLBACK_ZH_READS_EN);   // honest: no zh clips
        expect(h.media.metas.length > metas).toBe(true);                                  // lock screen relabelled
        const pre: string = h.speech.prefetched[h.speech.prefetched.length - 1];
        expect(pre.indexOf('.zh#') > 0).toBe(true);
        const cur: Utterance = h.speech.inFlight as Utterance;
        h.speech.inFlight = undefined;
        listener.onUtteranceDone(cur.id);
        expect(h.speech.spoken[h.speech.spoken.length - 1]).toBe('[zh] Fixture teaser sentence two.');
        expect(h.speech.spokenIds[h.speech.spokenIds.length - 1]).toBe(pre);        // the prefetch is used
        expect(h.ctrl.current().nowPlaying?.caption).toBe('[zh] Fixture teaser sentence two.');
        const n: number = h.log.count('LANG_SWITCH');
        h.ctrl.setStoryLang(Lang.ZH);                                                       // same language + voice
        expect(h.log.find('LANG_SWITCH', 'reason=same_lang_and_voice', 0) >= 0).toBe(true);
        expect(h.log.count('LANG_SWITCH')).toBe(n + 1);
        h.ctrl.end();
      });
  });
}

tourControllerTest();
