// Suite: LangSwitch.test - modules under test: core/tour/LangSwitch (pure sentence remap) and
// TourEngine.switchLang (task X2, issue #37: mid-tour story language switch at the next sentence boundary).
// Cases: index mapping and its edge cases (in-flight sentence, arrival lines, count mismatch, a system line, nothing
// left); the menu helpers; engine: mid-story EN -> 中文 (the in-flight sentence finishes in English, the next one
// is Chinese with lang zh and a new id, captions follow), switching while paused (the cut sentence restarts in the
// new language), switching between stories (the next stop's story is in the new language, stop names relocalized),
// voice -> text (Polish without clips: captions on TICK), text -> voice (the caption finishes its reading time),
// a story with no translation (partial Polish coverage) keeps its language.
import { describe, it, expect } from 'vitest';
import {
  LIVE_LANGS, RemapResult, firstUnplayedIndex, isStoryTail, liveLangName, matchStory, otherLiveLangs,
  remapItemTexts, storyLangForLive
} from '../src';
import { EngineLog, NarrationFn, StepResult, TourEngine, TourInput, TourState } from '../src';
import { TourConfig } from '../src';
import {
  Effect, EffectType, EngineEvent, EngineEventType, NowPlaying, TourPhase, TourPlan
} from '../src';
import { Fix, FixSource, Utterance, VoicePlan } from '../src';
import { Lang, Narration, NarrationLength, Poi } from '../src';
import { VoiceLabel } from '../src';
import { StoryLang } from '../src';
import {
  MINI_BARBICAN, MINI_CLOTH_HALL, MINI_PERSONA_ID, MINI_ST_MARYS, MINI_TOUR_ID, miniNarrations, miniPois, miniTour
} from './fixtures/MiniPack';

const T0: number = 2000000;
const TEASER_1: string = 'Fixture teaser sentence one.';
const TEASER_2: string = 'Fixture teaser sentence two.';

/** The fixture story "translated": same sentence count (B7), every sentence tagged with the language. */
function tr(lang: Lang, s: string): string {
  return lang === Lang.EN ? s : `[${lang}] ${s}`;
}

/** Narration lookup for one language; `missing` POIs have no translation (partial coverage). */
function narrFor(lang: Lang, missing: string[]): NarrationFn {
  return (poiId: string, len: NarrationLength): Narration | undefined => {
    if (lang !== Lang.EN && missing.indexOf(poiId) >= 0) {
      return undefined;
    }
    for (const n of miniNarrations()) {
      if (n.poiId === poiId && n.length === len) {
        const c: Narration = {
          id: n.id, poiId: n.poiId, personaId: n.personaId, lang: lang, length: n.length,
          sentences: n.sentences.map((x: string) => tr(lang, x)), tier: n.tier, sources: n.sources, claims: n.claims,
          generatedBy: n.generatedBy, validation: n.validation
        };
        return c;
      }
    }
    return undefined;
  };
}

function plan(lang: Lang, text: boolean, label: VoiceLabel): VoicePlan {
  const v: VoicePlan = {
    textLang: lang, speechMode: text ? 'text' : 'voice', engineLocale: text ? '' : (lang === Lang.ZH ? 'zh-CN' : ''),
    person: text ? 0 : 13, languageContext: '', label: label, reason: 'test'
  };
  return v;
}

function poi(id: string): Poi {
  return miniPois().find((p: Poi) => p.id === id) as Poi;
}

/** Minimal reducer driver: the walker stands at a POI, speech finishes only when told to. */
class Drv {
  st: TourState;
  t: number = T0;
  lat: number = 0;
  lng: number = 0;
  speaking: Utterance | undefined = undefined;
  spoken: Utterance[] = [];
  logs: string[] = [];
  metas: string[] = [];

  constructor(lang: Lang, text: boolean, label: VoiceLabel, missing: string[]) {
    const inp: TourInput = {
      tour: miniTour(), pois: miniPois(), lang: lang, personaId: MINI_PERSONA_ID, narration: narrFor(lang, missing),
      voice: plan(lang, text, label), adaptiveLength: true, spokenDirections: true, source: FixSource.DEMO
    };
    this.st = TourEngine.init(inp, new TourConfig());
  }

  take(effects: Effect[]): void {
    for (const x of effects) {
      if (x.type === EffectType.LOG) {
        this.logs.push(`${x.logCode} ${x.logKv}`);
      } else if (x.type === EffectType.SPEAK && x.utterance !== undefined) {
        this.speaking = x.utterance;
        this.spoken.push(x.utterance);
      } else if (x.type === EffectType.STOP_SPEECH && x.afterCurrent === false) {
        this.speaking = undefined;
      } else if (x.type === EffectType.SET_MEDIA_META && x.meta !== undefined) {
        this.metas.push(`${x.meta.title}|${x.meta.voiceLabel}`);
      }
    }
  }

  send(e: EngineEvent): void {
    const r: StepResult = TourEngine.reduce(this.st, e);
    this.st = r.state;
    this.take(r.effects);
  }

  ev(type: EngineEventType): void {
    const e: EngineEvent = { type: type, nowMs: this.t };
    this.send(e);
  }

  at(id: string): void {
    this.lat = poi(id).lat;
    this.lng = poi(id).lng;
  }

  fix(): void {
    this.t += 1000;
    const f: Fix = {
      lat: this.lat, lng: this.lng, accuracyM: 5, speedMps: 0, courseDeg: Number.NaN, courseAccuracyDeg: Number.NaN,
      timestampMs: this.t, provider: 0, source: FixSource.DEMO
    };
    const e: EngineEvent = { type: EngineEventType.FIX, nowMs: this.t, fix: f };
    this.send(e);
  }

  start(order: string[]): void {
    this.ev(EngineEventType.START_PLANNING);
    const p: TourPlan = {
      tourId: MINI_TOUR_ID, order: order, costS: 600, walkM: 700, savedM: 0, exact: true, algo: 'heldkarp', ms: 1,
      budgetS: 0, legs: []
    };
    const e: EngineEvent = { type: EngineEventType.PLAN_READY, nowMs: this.t, plan: p };
    this.send(e);
    this.fix();
    this.ev(EngineEventType.START_TOUR);
  }

  done(): void {
    const u: Utterance | undefined = this.speaking;
    if (u === undefined) {
      return;
    }
    this.speaking = undefined;
    const e: EngineEvent = { type: EngineEventType.UTTERANCE_DONE, nowMs: this.t, utteranceId: u.id };
    this.send(e);
  }

  /** Fixes at the current spot until the engine is AT_STOP (max 10 s). */
  arrive(): void {
    for (let i = 0; i < 10 && this.st.phase !== TourPhase.AT_STOP; i++) {
      this.fix();
    }
  }

  /** Finishes sentences until `text` is in flight (max 30). */
  speakUntil(text: string): void {
    for (let i = 0; i < 30; i++) {
      if (this.speaking !== undefined && this.speaking.text === text) {
        return;
      }
      if (this.speaking === undefined) {
        this.fix();
      } else {
        this.done();
      }
    }
  }

  switchTo(lang: Lang, text: boolean, label: VoiceLabel, missing: string[]): void {
    this.take(TourEngine.switchLang(this.st, lang, narrFor(lang, missing), plan(lang, text, label), this.t));
  }

  caption(): string {
    const np: NowPlaying | undefined = TourEngine.snapshot(this.st).nowPlaying;
    return np === undefined ? '' : np.caption;
  }

  log(code: string): string {
    const l: string | undefined = this.logs.find((x: string) => x.indexOf(`${code} `) === 0);
    return l === undefined ? '' : l;
  }
}

function langSwitchTest() {
  describe('LangSwitch', () => {
    it('pure: first unplayed index and story tail matching', () => {
      expect(firstUnplayedIndex(0, false)).toBe(0);
      expect(firstUnplayedIndex(2, true)).toBe(3);
      expect(firstUnplayedIndex(Number.NaN, true)).toBe(1);
      expect(isStoryTail(['a', 's1', 's2'], ['s1', 's2'])).toBe(true);
      expect(isStoryTail(['a', 's1', 's2'], ['s1'])).toBe(false);
      expect(isStoryTail(['s1'], [])).toBe(false);
      expect(matchStory(['a', 'f1', 'f2'], [['t1'], ['f1', 'f2'], ['d1']])).toBe(1);
      expect(matchStory(['Turn left.'], [['t1'], []])).toBe(-1);
    });

    it('pure: mid-story the in-flight and earlier sentences stay, the rest maps by index', () => {
      const r: RemapResult = remapItemTexts(['a1', 'a2', 's1', 's2', 's3'], 4, ['s1', 's2', 's3'],
        ['z1', 'z2', 'z3'], ['za1', 'za2']);
      expect(r.reason).toBe('ok');
      expect(r.texts.join(',')).toBe('a1,a2,s1,s2,z3');
      expect(r.changed).toBe(1);
    });

    it('pure: during the arrival lines the rest of them and the whole story switch', () => {
      const r: RemapResult = remapItemTexts(['a1', 'a2', 's1', 's2'], 1, ['s1', 's2'], ['z1', 'z2'], ['za1', 'za2']);
      expect(r.texts.join(',')).toBe('a1,za2,z1,z2');
      const k: RemapResult = remapItemTexts(['a1', 'a2', 's1', 's2'], 1, ['s1', 's2'], ['z1', 'z2'], ['za']);
      expect(k.texts.join(',')).toBe('a1,a2,z1,z2');   // different arrival line count: keep them
    });

    it('pure: count mismatch, a system line and nothing left change nothing', () => {
      const m: RemapResult = remapItemTexts(['s1', 's2'], 0, ['s1', 's2'], ['z1'], []);
      expect(m.reason).toBe('count_mismatch');
      expect(m.texts.join(',')).toBe('s1,s2');
      const n: RemapResult = remapItemTexts(['s1', 's2'], 0, ['s1', 's2'], [], []);
      expect(n.reason).toBe('count_mismatch');               // no translation at all
      expect(remapItemTexts(['Turn left.'], 0, [], [], []).reason).toBe('no_story');
      expect(remapItemTexts(['s1', 's2'], 2, ['s1', 's2'], ['z1', 'z2'], []).reason).toBe('nothing_left');
    });

    it('pure: menu offers the other two languages, named in themselves, saved as Story language rows', () => {
      expect(LIVE_LANGS.length).toBe(3);
      expect(otherLiveLangs(Lang.EN).join(',')).toBe('pl,zh');
      expect(otherLiveLangs(Lang.ZH).join(',')).toBe('en,pl');
      expect(liveLangName(Lang.ZH)).toBe('中文');
      expect(liveLangName(Lang.PL)).toBe('Polski');
      expect(storyLangForLive(Lang.PL)).toBe(StoryLang.PL);
      expect(storyLangForLive(Lang.ZH)).toBe(StoryLang.ZH);
      expect(storyLangForLive(Lang.EN)).toBe(StoryLang.EN);
    });

    it('engine: EN -> 中文 mid-story continues at the next sentence; captions follow; meta relabelled', () => {
      const d: Drv = new Drv(Lang.EN, false, VoiceLabel.PRERENDERED, []);
      d.at(MINI_ST_MARYS);
      d.start([MINI_ST_MARYS, MINI_CLOTH_HALL, MINI_BARBICAN]);
      d.arrive();
      expect(d.st.phase).toBe(TourPhase.AT_STOP);
      d.speakUntil(TEASER_1);
      expect(d.speaking !== undefined && d.speaking.text === TEASER_1).toBe(true);
      const prevId: string = (d.speaking as Utterance).id;
      d.switchTo(Lang.ZH, false, VoiceLabel.FALLBACK_ZH_READS_EN, []);
      expect(d.caption()).toBe(TEASER_1);                     // the in-flight sentence stays English
      expect(d.log(EngineLog.LANG_SWITCH).indexOf('from=en to=zh') >= 0).toBe(true);
      expect(d.log(EngineLog.LANG_SWITCH).indexOf('changed=1') >= 0).toBe(true);
      expect(d.metas[d.metas.length - 1].indexOf(VoiceLabel.FALLBACK_ZH_READS_EN) >= 0).toBe(true);
      d.done();
      const u: Utterance = d.speaking as Utterance;
      expect(u.text).toBe(tr(Lang.ZH, TEASER_2));
      expect(u.lang).toBe(Lang.ZH);
      expect(u.id.indexOf('.zh#') > 0).toBe(true);                   // a new id: no stale prefetch is reused
      expect(u.id === prevId).toBe(false);
      expect(d.caption()).toBe(tr(Lang.ZH, TEASER_2));
      expect(TourEngine.snapshot(d.st).voiceLabel).toBe(VoiceLabel.FALLBACK_ZH_READS_EN);
    });

    it('engine: switching while paused restarts the cut sentence in the new language on resume', () => {
      const d: Drv = new Drv(Lang.EN, false, VoiceLabel.NATIVE, []);
      d.at(MINI_ST_MARYS);
      d.start([MINI_ST_MARYS, MINI_CLOTH_HALL, MINI_BARBICAN]);
      d.arrive();
      d.speakUntil(TEASER_1);
      d.ev(EngineEventType.USER_PAUSE);
      expect(d.speaking === undefined).toBe(true);
      d.switchTo(Lang.PL, false, VoiceLabel.PRERENDERED, []);
      expect(d.log(EngineLog.LANG_SWITCH).indexOf('paused=true') >= 0).toBe(true);
      expect(d.st.paused).toBe(true);                              // the switch never resumes on its own
      d.ev(EngineEventType.USER_RESUME);
      expect((d.speaking as Utterance).text).toBe(tr(Lang.PL, TEASER_1));
      expect((d.speaking as Utterance).lang).toBe(Lang.PL);
    });

    it('engine: switching between stories: the next stop speaks the new language, names relocalized', () => {
      const d: Drv = new Drv(Lang.EN, false, VoiceLabel.NATIVE, []);
      d.at(MINI_CLOTH_HALL);
      d.start([MINI_ST_MARYS, MINI_CLOTH_HALL, MINI_BARBICAN]);
      d.switchTo(Lang.PL, false, VoiceLabel.PRERENDERED, []);   // walking, only system lines queued
      expect(d.log(EngineLog.LANG_SWITCH).indexOf('changed=0') >= 0).toBe(true);
      expect(d.st.stops[0].name).toBe('Bazylika Mariacka');
      d.at(MINI_ST_MARYS);
      d.arrive();
      d.speakUntil(tr(Lang.PL, TEASER_1));
      expect((d.speaking as Utterance).text).toBe(tr(Lang.PL, TEASER_1));
      expect(d.spoken.some((u: Utterance) => u.text === TEASER_1)).toBe(false);
    });

    it('engine: voice -> text (Polish without clips): the rest of the story becomes captions paced by TICK', () => {
      const d: Drv = new Drv(Lang.EN, false, VoiceLabel.NATIVE, []);
      d.at(MINI_ST_MARYS);
      d.start([MINI_ST_MARYS, MINI_CLOTH_HALL, MINI_BARBICAN]);
      d.arrive();
      d.speakUntil(TEASER_1);
      d.switchTo(Lang.PL, true, VoiceLabel.TEXT_ONLY_PLATFORM, []);
      const n: number = d.spoken.length;
      d.done();                                                      // the voiced English sentence ends
      expect(d.spoken.length).toBe(n);                        // no SPEAK in text mode
      expect(d.caption()).toBe(tr(Lang.PL, TEASER_2));
      expect(TourEngine.snapshot(d.st).speechText).toBe(true);
      d.t += 20000;
      d.ev(EngineEventType.TICK);
      expect(d.caption() === tr(Lang.PL, TEASER_2)).toBe(false);   // the caption moved on
    });

    it('engine: text -> voice: the caption on screen finishes its reading time, then the voice continues', () => {
      const d: Drv = new Drv(Lang.PL, true, VoiceLabel.TEXT_ONLY_PLATFORM, []);
      d.at(MINI_ST_MARYS);
      d.start([MINI_ST_MARYS, MINI_CLOTH_HALL, MINI_BARBICAN]);
      d.arrive();
      for (let i = 0; i < 40 && d.caption() !== tr(Lang.PL, TEASER_1); i++) {
        d.t += 20000;
        d.ev(EngineEventType.TICK);
      }
      expect(d.caption()).toBe(tr(Lang.PL, TEASER_1));
      d.switchTo(Lang.EN, false, VoiceLabel.NATIVE, []);
      expect(d.spoken.length).toBe(0);
      d.ev(EngineEventType.TICK);                                    // not due yet
      expect(d.caption()).toBe(tr(Lang.PL, TEASER_1));
      d.t += 20000;
      d.ev(EngineEventType.TICK);
      expect((d.speaking as Utterance).text).toBe(TEASER_2);
      expect((d.speaking as Utterance).lang).toBe(Lang.EN);
    });

    it('engine: a story with no translation (partial coverage) ends in its language; the next uses the new', () => {
        const d: Drv = new Drv(Lang.EN, false, VoiceLabel.NATIVE, []);
        d.at(MINI_ST_MARYS);
        d.start([MINI_ST_MARYS, MINI_CLOTH_HALL, MINI_BARBICAN]);
        d.arrive();
        d.speakUntil(TEASER_1);
        d.switchTo(Lang.ZH, false, VoiceLabel.NATIVE, [MINI_ST_MARYS]);
        expect(d.log(EngineLog.LANG_SWITCH).indexOf('count_mismatch') >= 0).toBe(true);
        d.done();
        expect((d.speaking as Utterance).text).toBe(TEASER_2);
        expect((d.speaking as Utterance).lang).toBe(Lang.EN);
      });
  });
}

langSwitchTest();
