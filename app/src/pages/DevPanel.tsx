/*
 * Developer-only page (A-owned). HarmonyOS opened it with `aa start ... --ps page dev`; on iOS it is the route
 * '/DevPanel' (deep link citytour://DevPanel, or a long press on Settings › About › Version).
 * Location sources (A5): LocationDevSection in DevPanelLocation.tsx.
 *
 * A7 "Demo tour" section (DemoTourSection, first on the page): the real TourController via
 * AppContainer.tourControl(): "Start demo tour" = setSource(DEMO) -> plan(first tour) -> start(); "End tour";
 * "Demo xN (cycle)" and "Jump to next stop" (Demo assist). A status line shows phase, SIMULATED, next stop,
 * voice label and platform flags; the caption line shows the sentence being said.
 * Log section (iOS stand-in for `hilog`): the last lines of the app's one log channel (Log.recent() /
 * Log.subscribe()), so a logs view during the demo backs up the behaviour.
 *
 * A4 speech buttons exercise the real stack through AppContainer.speech() / voiceManager():
 *   "EN sample (3 sentences)" / "ZH sample" / "Text-only sample (PL)" and "Pause" / "Resume" / "Stop".
 *   On iOS the system voice is dropped, so a sample plays studio-voice clips, then the server's studio voice, else
 *   it is shown as text on a reading timer. The HarmonyOS buttons that only drove the system voice are not ported:
 *   "Strategy: ... (cycle)", "Fallback ctx: ... (toggle)" and "Download English voice" (btnStrategy, btnCtx,
 *   btnDlEn, dlStatus) and the "strategy | fallback ctx" line (voiceStrategy).
 * The sample runner below plays the role TourController (A7) has: speak n, prefetch n+1, next on done.
 *
 * A6 background + lock screen buttons (AppContainer.background() / mediaSession()):
 *   "Start continuous task" / "Stop continuous task"   background location + audio (BG_START / BG_STOP)
 *   "Start AVSession" / "Destroy AVSession"            lock-screen / Control Center card (AVS_META event=active)
 *   "Meta: ... (toggle)"                               "Walking to Cloth Hall" <-> "Next: Cloth Hall · 120 m"
 *   "Narration loop"                                   EN sample every 45 s, for the screen-off test (UTT_START)
 * Card commands (AVS_CMD) drive the speech stack the way TourController drives the engine:
 *   play -> resume, pause/stop -> pause, playNext -> skip the sentence, playPrevious -> replay the sample,
 *   toggleFavorite ("Tell me more") -> the "more" sample. The card text is DEV TEST DATA, so the artist line
 *   carries " · DEMO".
 * Developer page: literal strings on purpose (this page is not user-facing).
 */
import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  BackgroundListener, EngineSnapshot, FixSource, Lang, LogEvents, MediaCommand, MediaMeta, MediaPlayState, NextInfo,
  SpeechCapabilities, SpeechListener, stripPauseMarkup, Tour, TourControl, TourPlan, Utterance, VoiceLabel, VoicePlan
} from '@citytour/core';
import { AppContainer } from '@/main/AppContainer';
import { Log, LogLine } from '@/main/Log';
import { DevButton, devStyles, LocationDevSection } from './DevPanelLocation';

const EN_SAMPLE: string[] = [
  'Welcome to the Main Market Square in Krakow.[p300]',
  'Look to your left: Saint Mary\'s Basilica was built in the fourteenth century, and its taller tower is 81 metres high.',
  'Every hour, a trumpeter plays a short melody from that tower and stops in the middle of a note.'
];
const ZH_SAMPLE: string[] = [
  '欢迎来到克拉科夫中央广场。[p300]',
  '请看你的左边，那是圣玛利亚教堂，建于十四世纪，高塔高81米。'
];
const PL_SAMPLE: string[] = [
  'Witamy na Rynku Głównym w Krakowie.',
  'Spójrz w lewo: to Bazylika Mariacka z XIV wieku.'
];

const EN_MORE: string[] = [
  'Tell me more: the trumpeter\'s tune, the Hejnał, breaks off to remember a watchman who, legend says, was shot ' +
    'while sounding the alarm.'
];

const AVS_TITLES: string[] = ['Walking to Cloth Hall', 'Next: Cloth Hall · 120 m'];
const NARRATION_LOOP_MS: number = 45000;
const LOG_SHOWN: number = 200;
const LOG_FLUSH_MS: number = 250;

function labelText(l: VoiceLabel): string {
  if (l === VoiceLabel.NATIVE) {
    return 'Native voice';
  }
  if (l === VoiceLabel.FALLBACK_ZH_READS_EN) {
    return 'Fallback voice';
  }
  if (l === VoiceLabel.TEXT_ONLY_PLATFORM) {
    return 'Text only (no voice for this language)';
  }
  if (l === VoiceLabel.PRERENDERED) {
    return 'Studio voice (ElevenLabs clips)';
  }
  return 'Text only (your choice)';
}

/** Sequences a sample like the tour does: speak n, prefetch n+1, next on done or error. */
class SampleRunner implements SpeechListener {
  onLine: (line: string) => void = () => {};
  onCaption: (text: string) => void = () => {};
  onFinished: () => void = () => {};
  private items: Utterance[] = [];
  private lastName: string = '';
  private lastTexts: string[] = [];
  private lastLang: Lang = Lang.EN;
  private idx: number = -1;
  private run: number = 0;

  start(name: string, texts: string[], lang: Lang): void {
    this.run++;
    this.lastName = name;
    this.lastTexts = texts;
    this.lastLang = lang;
    const items: Utterance[] = [];
    for (let i = 0; i < texts.length; i++) {
      const u: Utterance = {
        id: `${name}-r${this.run}-${i + 1}`, itemId: `sample-${name}`, text: texts[i], lang: lang,
        personaId: 'historian'
      };
      items.push(u);
    }
    this.items = items;
    this.idx = -1;
    Log.i(LogEvents.STORY_QUEUE, `event=dev_sample name=${name} run=${this.run} n=${texts.length} lang=${lang}`);
    this.next();
  }

  stop(): void {
    this.run++;
    this.items = [];
    this.idx = -1;
  }

  isActive(): boolean {
    return this.idx >= 0 && this.idx < this.items.length;
  }

  /** Card playNext: drop the rest of the current sentence and go on with the next one. */
  skip(): void {
    if (!this.isActive()) {
      return;
    }
    AppContainer.speech().stopNow();
    this.onLine(`skipped ${this.items[this.idx].id}`);
    this.next();
  }

  /** Card playPrevious: replay the last sample from its start. */
  replay(): boolean {
    if (this.lastTexts.length === 0) {
      return false;
    }
    AppContainer.speech().stopNow();
    this.start(this.lastName, this.lastTexts, this.lastLang);
    return true;
  }

  onUtteranceStart(id: string): void {
    const u = this.find(id);
    if (u !== undefined) {
      this.onCaption(stripPauseMarkup(u.text));
      this.onLine(`speaking ${id}`);
    }
  }

  onUtteranceDone(id: string): void {
    if (this.isCurrent(id)) {
      this.onLine(`done ${id}`);
      this.next();
    }
  }

  onUtteranceError(id: string, code: number): void {
    if (this.isCurrent(id)) {
      this.onLine(`error ${id} code=${code}`);
      this.next();
    }
  }

  private isCurrent(id: string): boolean {
    return this.idx >= 0 && this.idx < this.items.length && this.items[this.idx].id === id;
  }

  private find(id: string): Utterance | undefined {
    for (const u of this.items) {
      if (u.id === id) {
        return u;
      }
    }
    return undefined;
  }

  private next(): void {
    this.idx++;
    if (this.idx >= this.items.length) {
      if (this.items.length > 0) {
        this.onLine(`sample finished (${this.items.length} sentences)`);
        this.onCaption('');
        this.onFinished();
      }
      return;
    }
    const sp = AppContainer.speech();
    sp.speak(this.items[this.idx]);
    if (this.idx + 1 < this.items.length) {
      sp.prefetch(this.items[this.idx + 1]);
    }
  }
}

/** Refreshes the A6 status lines when the system stops the background session. */
class DevBgListener implements BackgroundListener {
  private readonly cancelled: () => void;
  private readonly suspended: () => void;

  constructor(cancelled: () => void, suspended: () => void) {
    this.cancelled = cancelled;
    this.suspended = suspended;
  }

  onCancelled(_reason: string): void {
    this.cancelled();
  }

  onSuspended(_reason: string): void {
    this.suspended();
  }
}

const DEMO_SPEED_CYCLE: number[] = [8, 4, 2, 1];

/** A7: drives the real TourController with the Demo walk (SIMULATED). */
function DemoTourSection(): React.JSX.Element {
  const [line, setLine] = useState<string>('tour: idle');
  const [caption, setCaption] = useState<string>('');
  const [speed, setSpeed] = useState<number>(8);

  useEffect(() => {
    let unsub: (() => void) | undefined = undefined;
    try {
      unsub = AppContainer.tourControl().subscribe((s: EngineSnapshot) => {
        const n: NextInfo | undefined = s.next;
        const next: string = n === undefined ? '-' :
          `${n.poiId} ${Number.isFinite(n.distanceM) ? Math.round(n.distanceM) + ' m' : '?'}`;
        setLine(`${s.phase}${s.paused ? ' (paused)' : ''} | ${s.source === FixSource.DEMO ? 'SIMULATED demo walk' :
          'real GPS'} | next ${next} | voice ${s.voiceLabel} | bg=${s.platform.bgRunning ? 1 : 0}` +
          ` avs=${s.platform.avsActive ? 1 : 0}${s.platform.demoHold ? ' | Demo assist: holding' : ''}` +
          ` | issues ${s.issues.map((i) => i.code).join(',')}`);
        setCaption(s.nowPlaying !== undefined ? s.nowPlaying.caption : '');
      });
    } catch (e) {
      setLine(`tour: subscribe failed ${Log.errKv(e)}`);
    }
    return () => {
      if (unsub !== undefined) {
        unsub();
      }
    };
  }, []);

  const startDemo = (): void => {
    const tc: TourControl = AppContainer.tourControl();
    const tours: Tour[] = AppContainer.packRepository().tours();
    const tourId: string = tours.length > 0 ? tours[0].id : '';
    if (tourId === '' || !AppContainer.demoWalkOffered()) {
      setLine('tour: no course with a demo track is active (Home > Browse walks)');   // no built-in course
      return;
    }
    setLine('tour: planning...');
    tc.setSource(FixSource.DEMO).then(() => tc.plan(tourId, 0)).then((_p: TourPlan) => {
      tc.setDemoSpeed(speed);
      return tc.start();
    }).catch((e: unknown) => {
      setLine(`tour: start failed ${Log.errKv(e)}`);
    });
  };

  const cycleSpeed = (): void => {
    const i: number = DEMO_SPEED_CYCLE.indexOf(speed);
    const v = DEMO_SPEED_CYCLE[(i + 1) % DEMO_SPEED_CYCLE.length];
    setSpeed(v);
    AppContainer.tourControl().setDemoSpeed(v);
  };

  return (
    <View style={devStyles.section}>
      <Text style={devStyles.h2}>Demo tour (A7)</Text>
      <Text testID="tourStatus" style={devStyles.small}>{line}</Text>
      <Text testID="tourCaption" style={styles.caption}>{caption}</Text>
      <DevButton id="btnDevDemoTour" label="Start demo tour" onPress={() => startDemo()} />
      <View style={devStyles.row}>
        <DevButton id="btnDevDemoSpeed" label={`Demo x${speed}`} flex={true} onPress={() => cycleSpeed()} />
        <DevButton id="btnDevDemoJump" label="Jump to next stop" flex={true}
          onPress={() => AppContainer.tourControl().demoJumpToNext()} />
        <DevButton id="btnDevEndTour" label="End tour" flex={true} onPress={() => AppContainer.tourControl().end()} />
      </View>
    </View>
  );
}

function fmtLog(l: LogLine): string {
  const d = new Date(l.ts);
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  const ss = `${d.getSeconds()}`.padStart(2, '0');
  const ms = `${d.getMilliseconds()}`.padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms} ${l.level} ${l.event} ${l.kv}`;
}

const LEVEL_COLOR: Record<string, string> = { D: '#8A8A8A', I: '#D8D8D8', W: '#FFB000', E: '#FF6B6B' };

/** The iOS stand-in for `hdc hilog`: the app's log channel, newest at the bottom, follows new lines. */
function LogSection(): React.JSX.Element {
  const [lines, setLines] = useState<LogLine[]>(() => Log.recent().slice(-LOG_SHOWN));
  const [follow, setFollow] = useState<boolean>(true);
  const scroller = useRef<ScrollView>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const unsub = Log.subscribe(() => {
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          setLines(Log.recent().slice(-LOG_SHOWN));
        }, LOG_FLUSH_MS);
      }
    });
    return () => {
      unsub();
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, []);

  return (
    <View style={devStyles.section}>
      <Text style={devStyles.h2}>Log (CityTour)</Text>
      <Text style={devStyles.small}>{`last ${lines.length} lines of the app log (hilog on HarmonyOS)`}</Text>
      <ScrollView
        testID="devLog"
        ref={scroller}
        style={styles.log}
        contentContainerStyle={{ padding: 8 }}
        nestedScrollEnabled={true}
        onContentSizeChange={() => {
          if (follow) {
            scroller.current?.scrollToEnd({ animated: false });
          }
        }}
      >
        {lines.map((l: LogLine, i: number) => (
          <Text key={`${l.ts}-${i}`} selectable={true} style={[styles.logLine, { color: LEVEL_COLOR[l.level] }]}>
            {fmtLog(l)}
          </Text>
        ))}
      </ScrollView>
      <View style={devStyles.row}>
        <DevButton id="btnDevLogFollow" label={follow ? 'Follow: ON' : 'Follow: off'} flex={true}
          onPress={() => setFollow(!follow)} />
        <DevButton id="btnDevLogRefresh" label="Refresh" flex={true}
          onPress={() => setLines(Log.recent().slice(-LOG_SHOWN))} />
      </View>
    </View>
  );
}

export function DevPanel(): React.JSX.Element {
  const sa = useSafeAreaInsets();
  const [status, setStatus] = useState<string>('speech: initialising...');
  const [capsLine, setCapsLine] = useState<string>('voices: ?');
  const [planLine, setPlanLine] = useState<string>('EN plan: ?');
  const [chip, setChip] = useState<string>('');
  const [caption, setCaption] = useState<string>('');
  const [bgLine, setBgLine] = useState<string>('bg: stopped');
  const [avsLine, setAvsLine] = useState<string>('avs: inactive');
  const [avsCmdLine, setAvsCmdLine] = useState<string>('');
  const [metaIdx, setMetaIdx] = useState<number>(0);
  const [loopOn, setLoopOn] = useState<boolean>(false);
  const runner = useRef<SampleRunner>(new SampleRunner()).current;
  const loopTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const metaRef = useRef<number>(0);
  const loopRef = useRef<boolean>(false);

  // ---------- A6: background + lock-screen card ----------

  const refreshPlatformLines = (): void => {
    try {
      const bg = AppContainer.backgroundRunner();
      const issue = bg.lastIssueLine();
      setBgLine(`bg: ${bg.isRunning() ? 'running [location,audio]' : 'stopped'}` +
        (issue !== '' ? ` | last: ${issue}` : ''));
      const avs = AppContainer.mediaSessionService();
      setAvsLine(`avs: ${avs.isActive() ? 'active' : 'inactive'} | title: ${AVS_TITLES[metaRef.current]}`);
      const cmd = avs.lastCommandLine();
      setAvsCmdLine(cmd !== '' ? `last card command: ${cmd}` : 'last card command: -');
    } catch (e) {
      setBgLine(`bg: status error ${Log.errKv(e)}`);
    }
  };

  const refreshVoiceLines = (): void => {
    const p: VoicePlan = AppContainer.voiceManager().plan(Lang.EN);
    setChip(labelText(p.label));
    setPlanLine(`EN plan: ${p.speechMode} ${p.engineLocale !== '' ? p.engineLocale : '-'}/${p.person}` +
      ` ctx=${p.languageContext !== '' ? p.languageContext : '-'} (${p.reason})`);
  };

  const stopLoop = (): void => {
    if (loopTimer.current !== undefined) {
      clearInterval(loopTimer.current);
      loopTimer.current = undefined;
      Log.i(LogEvents.STORY_QUEUE, 'event=dev_loop on=0');
    }
    loopRef.current = false;
    setLoopOn(false);
  };

  const play = (name: string, texts: string[], lang: Lang): void => {
    try {
      refreshVoiceLines();
      setCaption('');
      runner.start(name, texts, lang);
    } catch (e) {
      setStatus(`sample failed ${Log.errKv(e)}`);
    }
  };

  useEffect(() => {
    runner.onLine = (l: string) => setStatus(l);
    runner.onCaption = (tx: string) => setCaption(tx);
    runner.onFinished = () => {
      // Between stories the tour is still "playing" while the loop runs; otherwise the card shows paused.
      AppContainer.mediaSession().setState(loopRef.current ? MediaPlayState.PLAY : MediaPlayState.PAUSE);
    };
    // A running tour owns the speech and background listeners (the controller set them on start). Taking them here
    // would leave the tour waiting for a UTT_DONE that never reaches it, so the page only observes during a tour.
    let tourRunning = false;
    try {
      tourRunning = AppContainer.tourController().isRunning();
    } catch (e) {
      tourRunning = false;
    }
    try {
      if (!tourRunning) {
        AppContainer.background().setListener(new DevBgListener(() => {
          stopLoop();
          refreshPlatformLines();
        }, () => refreshPlatformLines()));
      }
    } catch (e) {
      setBgLine(`bg: listener error ${Log.errKv(e)}`);
    }
    refreshPlatformLines();
    try {
      if (tourRunning) {
        refreshVoiceLines();
        setStatus('tour running: samples off');
        return () => undefined;
      }
      AppContainer.speech().setListener(runner);
      refreshVoiceLines();
      AppContainer.speech().init().then((c: SpeechCapabilities) => {
        setCapsLine(`voices: en=${c.en} zh=${c.zh}`);
        setStatus('speech ready');
        refreshVoiceLines();
      }).catch((e: unknown) => {
        setStatus(`speech init failed ${Log.errKv(e)}`);
      });
    } catch (e) {
      setStatus(`speech init threw ${Log.errKv(e)}`);
    }
    return () => {
      stopLoop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startBg = (): void => {
    setBgLine('bg: starting...');
    AppContainer.background().start().then((ok: boolean) => {
      refreshPlatformLines();
      if (!ok) {
        setBgLine((l: string) => `${l} (start failed, see BG_FAIL; the tour would continue in the foreground)`);
      }
    }).catch((e: unknown) => {
      setBgLine(`bg: start error ${Log.errKv(e)}`);
    });
  };

  const stopBg = (): void => {
    stopLoop();
    runner.stop();
    AppContainer.background().stop().then(() => {
      refreshPlatformLines();
    }).catch((e: unknown) => {
      setBgLine(`bg: stop error ${Log.errKv(e)}`);
    });
  };

  const currentMeta = (): MediaMeta => {
    const label = AppContainer.voiceManager().plan(Lang.EN).label;
    return { title: AVS_TITLES[metaRef.current], artist: '', voiceLabel: label, demo: true };
  };

  /** What TourController does with USER_* events, done here on the speech stack. */
  const onCardCommand = (cmd: MediaCommand): void => {
    const sp = AppContainer.speech();
    const avs = AppContainer.mediaSession();
    if (cmd === MediaCommand.PLAY) {
      sp.resume();
      avs.setState(MediaPlayState.PLAY);
      setStatus('card: resume');
    } else if (cmd === MediaCommand.PAUSE || cmd === MediaCommand.STOP) {
      sp.pause();
      avs.setState(MediaPlayState.PAUSE);
      setStatus(`card: ${cmd} -> paused`);
    } else if (cmd === MediaCommand.NEXT) {
      runner.skip();
      avs.setState(MediaPlayState.PLAY);
    } else if (cmd === MediaCommand.PREVIOUS) {
      if (runner.replay()) {
        avs.setState(MediaPlayState.PLAY);
        setStatus('card: replay');
      }
    } else if (cmd === MediaCommand.FAVORITE) {
      play('more', EN_MORE, Lang.EN);
      setStatus('card: tell me more');
    }
    refreshPlatformLines();
  };

  const startAvs = (): void => {
    setAvsLine('avs: starting...');
    const avs = AppContainer.mediaSession();
    avs.setMeta(currentMeta());
    avs.setState(AppContainer.speech().isSpeaking() || loopRef.current ? MediaPlayState.PLAY : MediaPlayState.PAUSE);
    avs.init((cmd: MediaCommand) => onCardCommand(cmd)).then((ok: boolean) => {
      refreshPlatformLines();
      if (!ok) {
        setAvsLine('avs: failed (see AVS_FAIL); in-app controls only');
      }
    }).catch((e: unknown) => {
      setAvsLine(`avs: error ${Log.errKv(e)}`);
    });
  };

  const destroyAvs = (): void => {
    AppContainer.mediaSession().destroy().then(() => {
      refreshPlatformLines();
    }).catch((e: unknown) => {
      setAvsLine(`avs: destroy error ${Log.errKv(e)}`);
    });
  };

  const toggleMeta = (): void => {
    metaRef.current = (metaRef.current + 1) % AVS_TITLES.length;
    setMetaIdx(metaRef.current);
    AppContainer.mediaSession().setMeta(currentMeta());
    refreshPlatformLines();
  };

  const loopTick = (): void => {
    try {
      const sp = AppContainer.speech();
      if (runner.isActive() || sp.isSpeaking()) {
        return; // the previous sample is still running (or paused from the card)
      }
      play('en', EN_SAMPLE, Lang.EN);
      AppContainer.mediaSession().setState(MediaPlayState.PLAY);
      refreshPlatformLines();
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=DevPanel.loopTick ${Log.errKv(e)}`);
    }
  };

  const toggleLoop = (): void => {
    if (loopRef.current) {
      stopLoop();
      AppContainer.mediaSession().setState(MediaPlayState.PAUSE);
      return;
    }
    loopRef.current = true;
    setLoopOn(true);
    loopTick();
    loopTimer.current = setInterval(() => loopTick(), NARRATION_LOOP_MS);
    Log.i(LogEvents.STORY_QUEUE, `event=dev_loop on=1 everyMs=${NARRATION_LOOP_MS}`);
  };

  const stopAll = (): void => {
    runner.stop();
    AppContainer.speech().stopNow();
    setStatus('stopped');
    setCaption('');
  };

  const close = (): void => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/');
    }
  };

  return (
    // The scroll viewport starts below the status bar, the end clears the home indicator.
    <View style={[styles.page, { paddingTop: sa.top, paddingLeft: sa.left, paddingRight: sa.right }]}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.content, { paddingBottom: 32 + sa.bottom }]}>
        <View style={styles.titleRow}>
          <Text testID="devPanelTitle" style={styles.title}>CityTour DevPanel</Text>
          <Pressable testID="btnDevClose" accessibilityRole="button" onPress={close} style={styles.close}>
            <Text style={styles.closeText}>Close</Text>
          </Pressable>
        </View>
        <DemoTourSection />
        <LogSection />
        <LocationDevSection />
        <Text style={devStyles.h2}>Speech (A4)</Text>
        <Text testID="voiceChip" style={styles.chip}>{chip}</Text>
        <Text testID="voiceCaps" style={devStyles.small}>{capsLine}</Text>
        <Text testID="voicePlan" style={devStyles.small}>{planLine}</Text>
        <Text testID="speechStatus" style={devStyles.small}>{status}</Text>
        <Text testID="speechCaption" style={styles.caption}>{caption}</Text>
        <DevButton id="btnEnSample" label="EN sample (3 sentences)" onPress={() => play('en', EN_SAMPLE, Lang.EN)} />
        <DevButton id="btnZhSample" label="ZH sample" onPress={() => play('zh', ZH_SAMPLE, Lang.ZH)} />
        <DevButton id="btnTextSample" label="Text-only sample (PL)" onPress={() => play('pl', PL_SAMPLE, Lang.PL)} />
        <View style={devStyles.row}>
          <DevButton id="btnPause" label="Pause" flex={true} onPress={() => AppContainer.speech().pause()} />
          <DevButton id="btnResume" label="Resume" flex={true} onPress={() => AppContainer.speech().resume()} />
          <DevButton id="btnStop" label="Stop" flex={true} onPress={() => stopAll()} />
        </View>
        <Text style={[devStyles.h2, { marginTop: 12 }]}>Background + lock screen (A6)</Text>
        <Text testID="bgStatus" style={devStyles.small}>{bgLine}</Text>
        <Text testID="avsStatus" style={devStyles.small}>{avsLine}</Text>
        <Text testID="avsCmd" style={devStyles.small}>{avsCmdLine}</Text>
        <View style={devStyles.row}>
          <DevButton id="btnBgStart" label="Start continuous task" flex={true} onPress={() => startBg()} />
          <DevButton id="btnBgStop" label="Stop continuous task" flex={true} onPress={() => stopBg()} />
        </View>
        <View style={devStyles.row}>
          <DevButton id="btnAvsStart" label="Start AVSession" flex={true} onPress={() => startAvs()} />
          <DevButton id="btnAvsStop" label="Destroy AVSession" flex={true} onPress={() => destroyAvs()} />
        </View>
        <DevButton id="btnAvsMeta" label={`Meta: ${AVS_TITLES[metaIdx]} (toggle)`} onPress={() => toggleMeta()} />
        <DevButton id="btnNarrLoop"
          label={loopOn ? 'Narration loop: ON (tap to stop)' : 'Narration loop: OFF (EN sample every 45 s)'}
          onPress={() => toggleLoop()} />
        <Text style={{ fontSize: 11, color: '#888888' }}>
          Card text is dev test data (SIMULATED), artist line shows DEMO.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#F1F3F5' },
  content: { paddingHorizontal: 16, gap: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', marginTop: 48 },
  title: { flex: 1, fontSize: 24, fontWeight: '700', color: '#000000' },
  close: { minHeight: 44, paddingHorizontal: 12, justifyContent: 'center' },
  closeText: { fontSize: 16, color: '#0A59F7', fontWeight: '500' },
  caption: { fontSize: 15, fontStyle: 'italic' },
  chip: {
    alignSelf: 'flex-start', fontSize: 13, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
    overflow: 'hidden', backgroundColor: '#80808033'
  },
  log: { width: '100%', height: 320, backgroundColor: '#111418', borderRadius: 8 },
  logLine: { fontSize: 10, lineHeight: 13, fontFamily: 'Menlo' }
});
