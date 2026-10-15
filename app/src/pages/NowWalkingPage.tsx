/*
 * Now Walking (B5, DESIGN §3.6 + §3.6.2): the glanceable mirror of the audio. Map on top, a bottom sheet below:
 * banner, where next / how far / which way (Look cue), what am I hearing, pause / replay / skip. Honest labels: the
 * amber SIMULATED pill whenever the source is the Demo walk (tap -> Demo controls, "Demo assist"). The voice type is
 * not labelled on screen (it is named in Settings -> About). Back (chevron down) returns Home and the tour keeps
 * running.
 * Ids: pageNowWalking, btnMinimise, btnWalkMenu, badgeSimulated, btnReplay, btnPlayPause, btnSkip,
 * btnStops, btnTranscript, btnNextStopText, btnBackHome, btnJumpNext, segSpeedN, cardDirections, btnNoGpsDemo.
 * B11: when the tour ends (FINISHED or ABORTED) the page hands over to the Tour summary (SummaryPage).
 * B12: the ⋯ menu toggles the "How it works" HUD (views/walk/HowItWorksHud, id hudHowItWorks) over the map.
 * §3.6.3: the panel is a two-detent bottom sheet (core/map/SheetDetents). EXPANDED = the full panel below the DESIGN
 * map box; COLLAPSED ("peek") = next stop, distance + ETA, the turn text and play/pause + skip, so the map gets the
 * rest of the screen. Drag or fling the handle / peek (spring), tap the handle to toggle; the detent is kept for the
 * app session. Only translateY and opacity animate; the map's follow inset follows the settled detent.
 * Ids: sheetWalk, btnSheetHandle, sheetPeek, btnPeekPlayPause, btnPeekSkip.
 * iOS port: ArkUI bindMenu -> an anchored popover menu in a transparent Modal; showAlertDialog -> Alert.alert;
 * bindSheet -> Modal (Stops: native page sheet; Demo controls: fit-content bottom sheet); PanGesture ->
 * PanResponder; animateTo(springMotion(0.4, 0.86)) -> Animated.spring with the equivalent stiffness/damping.
 * Keep-screen-on and haptics are driven by the services (AppContainer), not by this page, as on HarmonyOS.
 */
import {
  AppIssue, collapseProgress, detentOffset, dragOffset, EngineSnapshot, expandedHeight, IssueCode, Lang,
  liveLangName, LogEvents, MapData, mapBottomInset, mapBoxHeight, peekHeight, resolveDetent, SheetDetent,
  sheetTravel, toggleDetent, visibleSheetHeight
} from '@citytour/core';
import { useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Animated, LayoutChangeEvent, Modal, PanResponder, PanResponderGestureState, Pressable, ScrollView,
  StyleSheet, Text, View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { proxy, useSnapshot } from 'valtio';
import { Log } from '@/main/Log';
import { useT } from '@/platform/strings';
import { Palette, Radius, Size, Space, TABULAR, Type, useColors } from '@/theme';
import { AppViewModel } from '@/viewmodel/AppViewModel';
import { NowWalkingViewModel, WalkState } from '@/viewmodel/NowWalkingViewModel';
import { FloatingIconButton } from '@/views/common/FloatingIconButton';
import { IssueBanner, topIssue } from '@/views/common/IssueBanner';
import { SimulatedBadge } from '@/views/common/SimulatedBadge';
import { StopList } from '@/views/common/StopList';
import { MapCanvas } from '@/views/map/MapCanvas';
import { MapOverlay } from '@/views/map/MapRenderer';
import { DemoControlsSheet } from '@/views/walk/DemoControlsSheet';
import { HowItWorksHud, HudPrefs, hudRowsFor } from '@/views/walk/HowItWorksHud';
import { NextStopBlock } from '@/views/walk/NextStopBlock';
import { NowPlayingCard } from '@/views/walk/NowPlayingCard';
import { WalkControls } from '@/views/walk/WalkControls';

const MAP_H: number = 300;
const MAP_H_READING: number = 200;
/** B12: with the HUD on, the map box reaches this far below the HUD, so the HUD never covers the panel and a strip of
 * map (user dot, route) stays visible under it (24 pt of it sit under the panel's rounded top). */
const HUD_MAP_STRIP: number = 120;
/** Drag handle strip at the top of the sheet (the bar is 36 x 4 pt, the strip is the touch area). */
const HANDLE_H: number = 24;
/** springMotion(response 0.4 s, damping 0.86) as a mass-1 spring: k = (2π / 0.4)², c = 2 · 0.86 · √k. */
const SPRING_K: number = Math.pow(2 * Math.PI / 0.4, 2);
const SPRING_C: number = 2 * 0.86 * Math.sqrt(SPRING_K);

/** Sheet detent kept for the app session (the page is rebuilt each time Now Walking opens). */
let sessionDetent: SheetDetent = SheetDetent.EXPANDED;

interface MenuItem {
  label: string;
  enabled: boolean;
  action: () => void;
}

export function NowWalkingPage(): React.JSX.Element {
  const t = useT();
  const c = useColors();
  const sa = useSafeAreaInsets();
  const app = AppViewModel.get();
  const vm = useMemo(() => proxy(new NowWalkingViewModel()), []);
  const s = useSnapshot(vm);
  /** B12: "How it works" HUD on/off, kept for the app session. */
  const hud = HudPrefs.get();
  const hs = useSnapshot(hud);
  /** Height of the chips + HUD overlay column (onLayout), for the map box and its follow inset. */
  const [overlayH, setOverlayH] = useState<number>(0);
  /** Page height (onLayout), for the sheet and the map box. 0 until the first layout. */
  const [pageH, setPageH] = useState<number>(0);
  /** Settled sheet detent (§3.6.3). */
  const [detent, setDetent] = useState<SheetDetent>(sessionDetent);
  /** While a finger drags the sheet, its offset follows the finger instead of the detent. */
  const [dragging, setDragging] = useState<boolean>(false);
  const [menuOpen, setMenuOpen] = useState<boolean>(false);

  const offset = useRef(new Animated.Value(0)).current;
  const offsetNow = useRef<number>(0);
  const detentRef = useRef<SheetDetent>(sessionDetent);
  const draggingRef = useRef<boolean>(false);
  const animatingRef = useRef<boolean>(false);
  const dragStartOff = useRef<number>(0);
  const travelRef = useRef<number>(0);

  useEffect(() => {
    const id = offset.addListener(({ value }) => {
      offsetNow.current = value;
    });
    return () => offset.removeListener(id);
  }, [offset]);

  useEffect(() => {
    vm.onTourEnded = () => app.openSummary();   // B11: Tour summary when the tour ends
    vm.attach(app.textLang);
    return () => vm.detach();
  }, [vm, app]);

  useFocusEffect(useCallback(() => {
    Log.i(LogEvents.APP_PAGE, 'page=NowWalking shown');
  }, []));

  // ---------- derived display ----------

  const st: WalkState = s.state();
  const paused: boolean = s.paused();
  const snap: EngineSnapshot | undefined = s.snap as EngineSnapshot | undefined;
  const atStop = st === WalkState.AT_STOP || st === WalkState.TEASER || st === WalkState.READING;
  const finished = st === WalkState.COMPLETE || st === WalkState.ENDED;
  const collapsed = detent === SheetDetent.COLLAPSED;

  const overline = (): string => {
    const n = s.stopNumber;
    if (st === WalkState.COMPLETE) {
      return t('walk_tour_complete');
    }
    if (st === WalkState.ENDED) {
      return t('walk_tour_ended');
    }
    if (paused) {
      return t('walk_paused');
    }
    switch (st) {
      case WalkState.APPROACHING:
        return t('walk_in_m', s.shownDistance !== undefined && !s.shownDistance.km ? s.shownDistance.value : 50);
      case WalkState.AT_STOP:
      case WalkState.READING:
        return t('walk_here_stop', n);
      case WalkState.TEASER:
        return t('walk_passing', n);
      case WalkState.NO_GPS:
        return t('walk_waiting_gps');
      case WalkState.OFF_ROUTE:
        return t('walk_off_route');
      default:
        return t('walk_next_stop', n);
    }
  };

  const title = (): string => {
    if (finished) {
      return s.tourTitle;
    }
    if (s.stopName !== '') {
      return s.stopName;
    }
    return s.totalStops > 0 ? t('fmt_stop_of', s.stopNumber, s.totalStops) : '';
  };

  const hero = (): string => {
    if (st === WalkState.NO_GPS) {
      return '—';
    }
    if (atStop || finished || st === WalkState.IDLE) {
      return '';
    }
    const d = s.shownDistance;
    if (d === undefined) {
      return '';
    }
    return d.km ? t('fmt_km', d.value.toFixed(1)) : t('fmt_m', d.value);
  };

  const sub = (): string => {
    if (hero() === '' || st === WalkState.NO_GPS) {
      return '';
    }
    return t('walk_about_min', s.etaMinutes());
  };

  /** Highest-priority engine issue (permission > GPS > other), if any. */
  const issueCode = (): IssueCode | undefined => {
    if (snap === undefined) {
      return undefined;
    }
    const i: AppIssue | undefined = topIssue(snap.issues);
    return i === undefined ? undefined : i.code;
  };

  /** Map box height: the DESIGN height, grown with the HUD on so the HUD sits over the map, never over the panel. */
  const mapBoxH = (): number => {
    const base: number = (st === WalkState.READING ? MAP_H_READING : MAP_H) + sa.top;
    return hs.visible && overlayH > 0 ? Math.max(base, overlayH + HUD_MAP_STRIP) : base;
  };

  /** Map follow inset: below the header (DESIGN), or below the HUD while it is on, so the user dot stays visible. */
  const mapTopInset = (): number => {
    const base: number = 96 + sa.top;
    return hs.visible && overlayH > 0 ? Math.max(base, overlayH) : base;
  };

  // ---------- sheet (§3.6.3) ----------

  const peekH: number = peekHeight(sa.bottom);
  /** Expanded sheet: the page below the DESIGN map box (grown with the HUD), as the fixed panel was. */
  const sheetH: number = expandedHeight(pageH, mapBoxH(), peekH);
  const travel: number = sheetTravel(sheetH, peekH);
  travelRef.current = travel;
  /** The map runs behind the sheet down to the peek; before the first layout, the DESIGN box. */
  const canvasH: number = pageH > 0 ? mapBoxHeight(pageH, peekH) : mapBoxH();
  /** Follow inset from the settled detent (not every drag frame), so the camera moves once per detent change. */
  const mapBottom: number = pageH <= 0 ? 24 :
    mapBottomInset(visibleSheetHeight(sheetH, detentOffset(detent, travel)), pageH, canvasH);

  // Re-seat the sheet when its travel changes (layout, HUD, reading mode) unless a drag or spring owns it.
  useEffect(() => {
    if (!draggingRef.current && !animatingRef.current) {
      offset.setValue(detentOffset(detentRef.current, travel));
    }
  }, [travel, offset]);

  const settle = useCallback((d: SheetDetent, why: string): void => {
    sessionDetent = d;
    detentRef.current = d;
    draggingRef.current = false;
    setDetent(d);
    setDragging(false);
    try {
      animatingRef.current = true;
      Animated.spring(offset, {
        toValue: detentOffset(d, travelRef.current),
        stiffness: SPRING_K,
        damping: SPRING_C,
        mass: 1,
        useNativeDriver: false
      }).start(() => {
        animatingRef.current = false;
      });
    } catch {
      animatingRef.current = false;
      offset.setValue(detentOffset(d, travelRef.current));
    }
    Log.i(LogEvents.APP_PAGE, `page=NowWalking sheet=${d === SheetDetent.COLLAPSED ? 'collapsed' : 'expanded'} by=${why}`);
  }, [offset]);

  const pan = useMemo(() => {
    const wants = (_e: unknown, g: PanResponderGestureState): boolean =>
      Math.abs(g.dy) > 4 && Math.abs(g.dy) > Math.abs(g.dx);
    return PanResponder.create({
      onMoveShouldSetPanResponder: wants,
      onMoveShouldSetPanResponderCapture: wants,
      onPanResponderGrant: () => {
        offset.stopAnimation();
        animatingRef.current = false;
        dragStartOff.current = offsetNow.current;
        draggingRef.current = true;
        setDragging(true);
      },
      onPanResponderMove: (_e, g: PanResponderGestureState) => {
        offset.setValue(dragOffset(dragStartOff.current, g.dy, travelRef.current));
      },
      onPanResponderRelease: (_e, g: PanResponderGestureState) => {
        if (!draggingRef.current) {
          return;
        }
        // vy is in pt/ms; resolveDetent wants pt/s.
        settle(resolveDetent(offsetNow.current, g.vy * 1000, travelRef.current), 'drag');
      },
      onPanResponderTerminate: () => {
        if (draggingRef.current) {
          settle(detentRef.current, 'cancel');
        }
      },
      onPanResponderTerminationRequest: () => false
    });
  }, [offset, settle]);

  /** 0 expanded .. 1 collapsed: the peek block fades in over the top of the full panel. */
  const progress: Animated.AnimatedInterpolation<number> | number = travel > 0 ?
    offset.interpolate({ inputRange: [0, travel], outputRange: [0, 1], extrapolate: 'clamp' }) :
    collapseProgress(0, travel);

  const toggleHud = (): void => {
    hud.visible = !hud.visible;
    Log.i(LogEvents.APP_PAGE, `page=NowWalking hud=${hud.visible ? 'on' : 'off'}`);
  };

  const confirmEnd = (): void => {
    try {
      Alert.alert(
        t('end_dialog_title'),
        t('end_dialog_msg', vm.visitedCount(), vm.totalStops),
        [
          { text: t('cta_keep_walking'), style: 'cancel', onPress: () => {} },
          { text: t('cta_end_tour'), style: 'destructive', onPress: () => vm.end() }
        ]
      );
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=NowWalkingPage.confirmEnd ${Log.errKv(e)}`);
    }
  };

  // ---------- pieces ----------

  const banner = (): React.JSX.Element | null => {
    const code = issueCode();
    if (code !== undefined) {
      return <IssueBanner code={code} />;
    }
    if (st === WalkState.NO_GPS) {
      return (
        <IssueBanner
          message={t('err_loc_lost')}
          code={IssueCode.LOC_LOST}
          actionLabel={s.isDemo() || !s.demoOffered() ? '' : t('err_try_demo')}
          actionId="btnNoGpsDemo"
          onAction={() => {
            vm.switchToDemo();
          }}
        />
      );
    }
    if (s.weakGps()) {
      return <IssueBanner message={t('err_loc_poor')} code={IssueCode.LOC_POOR} />;
    }
    if (st === WalkState.OFF_ROUTE) {
      return <IssueBanner message={t('walk_replanned')} code={IssueCode.ROUTE_FALLBACK} />;
    }
    return null;
  };

  const menuLangs: Lang[] = s.menuLangs() as Lang[];
  const menuItems: MenuItem[] = [
    { label: t('walk_menu_stops'), enabled: true, action: () => vm.openStops() },
    { label: t('walk_menu_full_map'), enabled: true, action: () => app.openFullMap('walk') },
    { label: hs.visible ? t('walk_menu_how_hide') : t('walk_menu_how'), enabled: true, action: () => toggleHud() },
    {
      label: t('walk_menu_lang', liveLangName(menuLangs[0])),
      enabled: !finished,
      action: () => vm.switchStoryLang(menuLangs[0])
    },
    {
      label: t('walk_menu_lang', liveLangName(menuLangs[1])),
      enabled: !finished,
      action: () => vm.switchStoryLang(menuLangs[1])
    },
    { label: t('cta_end_tour'), enabled: !finished, action: () => confirmEnd() }
  ];

  const header = (
    <View
      pointerEvents="box-none"
      style={[styles.header, { paddingLeft: Space.S2 + sa.left, paddingRight: Space.S2 + sa.right, paddingTop: Space.S2 + sa.top }]}
    >
      <View style={[styles.capsule, { backgroundColor: c.bg_scrim }]}>
        <FloatingIconButton
          symbol="chevron.down"
          label={t('walk_minimise')}
          buttonId="btnMinimise"
          diameter={36}
          onTap={() => app.back()}
        />
        <Text numberOfLines={1} style={[styles.headerTitle, { color: c.text_primary }]}>{s.tourTitle}</Text>
        {s.totalStops > 0 ? (
          <Text style={[styles.headerCount, TABULAR, { color: c.text_secondary }]}>
            {`${finished ? s.visitedCount() : s.stopNumber}/${s.totalStops}`}
          </Text>
        ) : null}
      </View>
      <View style={styles.blank} pointerEvents="none" />
      <Pressable
        testID="btnWalkMenu"
        accessibilityRole="button"
        accessibilityLabel={t('walk_menu')}
        style={({ pressed }) => [styles.menuBtn, { backgroundColor: c.bg_scrim, opacity: pressed ? 0.7 : 1 }]}
        onPress={() => setMenuOpen(true)}
      >
        <View style={styles.rotate}>
          <SymbolView name="ellipsis" size={20} tintColor={c.text_primary} />
        </View>
      </Pressable>
    </View>
  );

  const chips = (
    <View
      pointerEvents="box-none"   // the header buttons underneath stay tappable
      onLayout={(e: LayoutChangeEvent) => setOverlayH(e.nativeEvent.layout.height)}
      style={[styles.chips, { paddingLeft: Space.S3 + sa.left, paddingRight: Space.S3 + sa.right, paddingTop: 64 + sa.top }]}
    >
      <View style={styles.chipRow} pointerEvents="box-none">
        <SimulatedBadge
          visible={s.isDemo()}
          tappable={true}
          onTap={() => {
            vm.showDemoSheet = true;
          }}
        />
      </View>
      {hs.visible ? <HowItWorksHud rows={hudRowsFor(snap, s.stopName, s.demoSpeed)} /> : null}
    </View>
  );

  const playingOrDirections = (): React.JSX.Element | null => {
    const np = s.nowPlaying();
    if (np !== undefined) {
      return (
        <NowPlayingCard
          title={s.nowPlayingTitle}
          caption={np.caption ?? ''}
          sentenceIndex={np.sentenceIndex ?? 0}
          sentenceCount={np.sentenceCount ?? 0}
          playing={!paused}
          teaser={st === WalkState.TEASER}
          reading={st === WalkState.READING}
        />
      );
    }
    if (snap !== undefined && snap.next !== undefined && snap.next.maneuverText !== '' && !atStop && !finished) {
      return (
        <View testID="cardDirections" style={[styles.directions, { backgroundColor: c.bg_surface_sunken }]}>
          <SymbolView name="figure.walk" size={18} tintColor={c.accent} />
          <Text style={[styles.directionsText, { color: c.text_primary }]}>{snap.next.maneuverText}</Text>
        </View>
      );
    }
    return null;
  };

  const primaryButton = (label: string, id: string, onPress: () => void): React.JSX.Element => (
    <Pressable
      testID={id}
      accessibilityRole="button"
      style={({ pressed }) => [styles.primary, { backgroundColor: c.accent, opacity: pressed ? 0.8 : 1 }]}
      onPress={onPress}
    >
      <Text style={[styles.primaryText, { color: c.on_accent }]}>{label}</Text>
    </Pressable>
  );

  const controls = (): React.JSX.Element => {
    if (finished) {
      return primaryButton(t('walk_back_home'), 'btnBackHome', () => app.back());
    }
    if (st === WalkState.READING) {
      return primaryButton(t('walk_next_stop_cta'), 'btnNextStopText', () => vm.skip());
    }
    return (
      <WalkControls
        paused={paused}
        active={st !== WalkState.IDLE}
        onReplay={() => vm.replay()}
        onToggle={() => vm.togglePlay()}
        onSkip={() => vm.skip()}
      />
    );
  };

  const textButton = (label: string, id: string, onPress: () => void): React.JSX.Element => (
    <Pressable
      testID={id}
      accessibilityRole="button"
      style={({ pressed }) => [styles.textBtn, { opacity: pressed ? 0.6 : 1 }]}
      onPress={onPress}
    >
      <Text style={[styles.textBtnLabel, { color: c.accent }]}>{label}</Text>
    </Pressable>
  );

  /** Peek line under the stop name: the distance + ETA, or the story being told at a stop. */
  const peekSub = (): string => {
    if (hero() !== '') {
      return hero();
    }
    return s.nowPlaying() !== undefined ? s.nowPlayingTitle : '';
  };

  const maneuver = (): string => {
    if (snap === undefined || snap.next === undefined || atStop || finished) {
      return '';
    }
    return snap.next.maneuverText;
  };

  const peekControls = (): React.JSX.Element | null => {
    if (finished) {
      return null;
    }
    const active = st !== WalkState.IDLE;
    return (
      <View style={styles.peekControls}>
        {st !== WalkState.READING ? (
          <Pressable
            testID="btnPeekPlayPause"
            accessibilityRole="button"
            accessibilityLabel={paused ? t('walk_play') : t('walk_pause')}
            disabled={!active}
            style={({ pressed }) => [styles.peekPlay, {
              backgroundColor: c.accent, opacity: !active ? 0.4 : pressed ? 0.8 : 1
            }]}
            onPress={() => vm.togglePlay()}
          >
            <SymbolView name={paused ? 'play.fill' : 'pause.fill'} size={24} tintColor={c.on_accent} />
          </Pressable>
        ) : null}
        <Pressable
          testID="btnPeekSkip"
          accessibilityRole="button"
          accessibilityLabel={st === WalkState.READING ? t('walk_next_stop_cta') : t('walk_skip')}
          disabled={!active}
          style={({ pressed }) => [styles.peekSkip, {
            backgroundColor: c.bg_surface_sunken, opacity: !active ? 0.4 : pressed ? 0.7 : 1
          }]}
          onPress={() => vm.skip()}
        >
          <SymbolView name="forward.end.fill" size={20} tintColor={c.text_primary} />
        </Pressable>
      </View>
    );
  };

  /** COLLAPSED content (§3.6.3): where next, how far, which way, play/pause. Opaque, over the full panel's top. */
  const peek = (
    <Animated.View
      testID="sheetPeek"
      {...pan.panHandlers}
      pointerEvents={collapsed || dragging ? 'auto' : 'none'}
      accessibilityElementsHidden={!collapsed}
      importantForAccessibility={collapsed ? 'auto' : 'no-hide-descendants'}
      style={[styles.peek, {
        height: peekH - HANDLE_H,
        backgroundColor: c.bg_surface,
        opacity: progress
      }]}
    >
      <Pressable
        style={[styles.peekInner, {
          paddingLeft: Space.S4 + sa.left, paddingRight: Space.S4 + sa.right, paddingBottom: sa.bottom
        }]}
        onPress={() => settle(SheetDetent.EXPANDED, 'peek')}
      >
        <View style={styles.peekRow}>
          <View style={styles.peekText} accessible={true}>
            <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={[styles.overline, { color: c.text_secondary }]}>
              {overline()}
            </Text>
            <Text testID="peekTitle" numberOfLines={1} maxFontSizeMultiplier={1.3} style={[styles.peekTitle, { color: c.text_primary }]}>
              {title()}
            </Text>
            {peekSub() !== '' ? (
              <View style={styles.peekSubRow}>
                <Text
                  testID="peekHero"
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.3}
                  style={[TABULAR, styles.peekHero, {
                    fontSize: hero() !== '' ? Type.TITLE2 : Type.CALLOUT,
                    fontWeight: hero() !== '' ? '700' : '400',
                    color: paused || hero() === '' ? c.text_secondary : c.text_primary
                  }]}
                >
                  {hero() !== '' && s.weakGps() ? '~' : ''}
                  {peekSub()}
                </Text>
                {sub() !== '' ? (
                  <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={[styles.peekEta, { color: c.text_secondary }]}>
                    {sub()}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
          {peekControls()}
        </View>

        {maneuver() !== '' ? (
          <View testID="peekDirections" style={styles.peekDirections}>
            <SymbolView name="figure.walk" size={16} tintColor={c.accent} />
            <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={[styles.peekManeuver, { color: c.text_primary }]}>
              {maneuver()}
            </Text>
          </View>
        ) : null}
      </Pressable>
    </Animated.View>
  );

  const handle = (
    <View {...pan.panHandlers}>
      <Pressable
        testID="btnSheetHandle"
        accessibilityRole="button"
        accessibilityLabel={collapsed ? t('walk_sheet_expand') : t('walk_sheet_collapse')}
        hitSlop={{ top: 12, bottom: 12 }}   // 48 pt touch target
        style={styles.handle}
        onPress={() => settle(toggleDetent(detentRef.current), 'tap')}
      >
        <View style={[styles.handleBar, { backgroundColor: c.text_secondary }]} />
      </Pressable>
    </View>
  );

  // The surface runs under the home indicator; the scroll content (and so every control) stays above it.
  // §3.6.3: fixed expanded height, slid down by translateY to the peek; the peek block covers the panel's top.
  const panel = (
    <Animated.View
      testID="sheetWalk"
      style={[styles.sheet, {
        height: pageH > 0 ? sheetH : '45%',
        backgroundColor: c.bg_surface,
        transform: [{ translateY: offset }]
      }]}
    >
      {handle}
      <View style={styles.sheetBody}>
        <ScrollView
          style={styles.fill}
          showsVerticalScrollIndicator={false}
          accessibilityElementsHidden={collapsed}
          importantForAccessibility={collapsed ? 'no-hide-descendants' : 'auto'}
          contentContainerStyle={[styles.panelContent, {
            paddingLeft: Space.S4 + sa.left,
            paddingRight: Space.S4 + sa.right,
            paddingTop: Space.S5 - HANDLE_H / 2,
            paddingBottom: Space.S5 + sa.bottom
          }]}
        >
          {banner()}
          <NextStopBlock
            overline={overline()}
            title={title()}
            hero={hero()}
            approx={s.weakGps()}
            sub={sub()}
            dim={paused}
            showCue={!finished && st !== WalkState.NO_GPS && st !== WalkState.IDLE}
            angleDeg={s.dialDeg}
            relDir={s.relDir()}
            lookUp={s.lookUp && (atStop || st === WalkState.APPROACHING)}
            landmark={s.stopName}
            emphasised={st === WalkState.APPROACHING}
          />
          {playingOrDirections()}
          {controls()}
          {!finished && s.totalStops > 0 ? (
            <View style={styles.linkRow}>
              {s.stopName !== '' && snap !== undefined && snap.next !== undefined ?
                textButton(t('walk_transcript'), 'btnTranscript', () => app.openPlace(vm.snap?.next?.poiId ?? '')) :
                null}
              <View style={styles.blank} />
              {textButton(t('walk_stops', s.totalStops), 'btnStops', () => vm.openStops())}
            </View>
          ) : null}
        </ScrollView>
        {peek}
      </View>
    </Animated.View>
  );

  return (
    <View testID="pageNowWalking" style={[styles.page, { backgroundColor: c.bg_canvas }]}>
      <View style={styles.page} onLayout={(e: LayoutChangeEvent) => setPageH(e.nativeEvent.layout.height)}>
        <View style={styles.mapLayer} accessible={true} accessibilityLabel={t('walk_map_a11y', s.stopName)}>
          <MapCanvas
            map={s.map as MapData | undefined}
            scene={s.scene as MapOverlay}
            bounds={s.sceneBounds as number[]}
            follow={s.scene.user !== undefined}
            followScale={1.4}
            boxHeight={canvasH}
            topInset={mapTopInset()}
            bottomInset={mapBottom}
            mapId="mapWalk"
          />
        </View>
        {panel}
      </View>
      {header}
      {chips}

      <WalkMenu
        open={menuOpen}
        items={menuItems}
        top={Space.S2 + sa.top + 4 + Size.ICON_BUTTON + 4}
        right={Space.S2 + sa.right + 4}
        c={c}
        onClose={() => setMenuOpen(false)}
      />

      <Modal
        visible={s.showStopsSheet}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => {
          vm.showStopsSheet = false;
        }}
        onDismiss={() => {
          vm.showStopsSheet = false;
        }}
      >
        <SheetFrame fill={true} title={t('stops_sheet_title')} closeLabel={t('a11y_close')} c={c} onClose={() => {
          vm.showStopsSheet = false;
        }}>
          <ScrollView contentContainerStyle={[styles.stopsContent, { paddingBottom: Space.S6 + sa.bottom }]}>
            <StopList rows={s.stopRows} />
            <Text style={[styles.stopsFooter, { color: c.text_secondary }]}>
              {t('stops_footer', s.visitedCount(), s.totalStops,
                `${Math.round((snap?.remainingM ?? 0) / 100) / 10} km`)}
            </Text>
          </ScrollView>
        </SheetFrame>
      </Modal>

      <Modal
        visible={s.showDemoSheet}
        transparent={true}
        animationType="slide"
        onRequestClose={() => {
          vm.showDemoSheet = false;
        }}
      >
        <View style={styles.fitSheetRoot}>
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityLabel={t('a11y_close')}
            onPress={() => {
              vm.showDemoSheet = false;
            }}
          />
          <View style={[styles.fitSheet, { backgroundColor: c.bg_surface, paddingBottom: sa.bottom }]}>
            <View style={[styles.dragBar, { backgroundColor: c.text_secondary }]} />
            <SheetFrame title={t('demo_controls_title')} closeLabel={t('a11y_close')} c={c} onClose={() => {
              vm.showDemoSheet = false;
            }}>
              <DemoControlsSheet
                speed={s.demoSpeed}
                onSpeed={(x: number) => vm.setDemoSpeed(x)}
                onJump={() => vm.demoJumpToNext()}
              />
            </SheetFrame>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/** Sheet title row with a close button (ArkUI bindSheet title + showClose). */
function SheetFrame({ title, closeLabel, c, onClose, children, fill = false }: {
  title: string;
  fill?: boolean;
  closeLabel: string;
  c: Palette;
  onClose: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <View style={[fill ? styles.fill : styles.sheetFrame, { backgroundColor: c.bg_surface }]}>
      <View style={styles.sheetTitleRow}>
        <Text style={[styles.sheetTitle, { color: c.text_primary }]}>{title}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={closeLabel}
          style={[styles.sheetClose, { backgroundColor: c.bg_surface_sunken }]}
          onPress={onClose}
        >
          <SymbolView name="xmark" size={14} tintColor={c.text_secondary} weight="semibold" />
        </Pressable>
      </View>
      {children}
    </View>
  );
}

/** The ⋯ menu (ArkUI bindMenu): a popover anchored under the menu button; tap outside to dismiss. */
function WalkMenu({ open, items, top, right, c, onClose }: {
  open: boolean;
  items: MenuItem[];
  top: number;
  right: number;
  c: Palette;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Modal visible={open} transparent={true} animationType="fade" onRequestClose={onClose}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={[styles.menu, { top, right, backgroundColor: c.bg_surface }]}>
        {items.map((m: MenuItem, i: number) => (
          <Pressable
            key={`${i}`}
            accessibilityRole="menuitem"
            accessibilityState={{ disabled: !m.enabled }}
            disabled={!m.enabled}
            style={({ pressed }) => [styles.menuItem, {
              backgroundColor: pressed ? c.bg_surface_sunken : 'transparent',
              borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
              borderTopColor: c.divider
            }]}
            onPress={() => {
              onClose();
              m.action();
            }}
          >
            <Text numberOfLines={1} style={[styles.menuText, { color: m.enabled ? c.text_primary : c.text_tertiary }]}>
              {m.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1
  },
  fill: {
    flex: 1
  },
  blank: {
    flex: 1
  },
  mapLayer: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0
  },
  header: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.S2
  },
  capsule: {
    flexDirection: 'row',
    alignItems: 'center',
    height: Size.TOUCH,
    paddingRight: Space.S4,
    borderRadius: 24,
    flexShrink: 1
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '500',
    maxWidth: 170
  },
  headerCount: {
    fontSize: Type.CALLOUT,
    marginLeft: Space.S2
  },
  menuBtn: {
    width: Size.ICON_BUTTON,
    height: Size.ICON_BUTTON,
    borderRadius: Size.ICON_BUTTON / 2,
    margin: 4,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 }
  },
  rotate: {
    transform: [{ rotate: '90deg' }]
  },
  chips: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    alignItems: 'flex-end',
    gap: Space.S2
  },
  chipRow: {
    flexDirection: 'row',
    gap: Space.S2
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: Radius.XL,
    borderTopRightRadius: Radius.XL,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 }
  },
  sheetBody: {
    flex: 1,
    width: '100%'
  },
  panelContent: {
    gap: Space.S4,
    width: '100%'
  },
  handle: {
    width: '100%',
    height: HANDLE_H,
    alignItems: 'center',
    justifyContent: 'center'
  },
  handleBar: {
    width: 36,
    height: 4,
    borderRadius: 2,
    opacity: 0.5
  },
  directions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.S2,
    width: '100%',
    padding: Space.S4,
    borderRadius: Radius.LG
  },
  directionsText: {
    flex: 1,
    fontSize: Type.BODY,
    lineHeight: Type.BODY_LH
  },
  primary: {
    width: '100%',
    height: Size.BUTTON_H,
    borderRadius: Size.BUTTON_H / 2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  primaryText: {
    fontSize: Type.BODY,
    fontWeight: '500'
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%'
  },
  textBtn: {
    height: Size.TOUCH,
    paddingLeft: Space.S4,
    paddingRight: Space.S4,
    justifyContent: 'center'
  },
  textBtnLabel: {
    fontSize: Type.CALLOUT,
    fontWeight: '500'
  },
  peek: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    overflow: 'hidden'
  },
  peekInner: {
    flex: 1,
    gap: Space.S1,
    paddingTop: Space.S1,
    justifyContent: 'flex-start'
  },
  peekRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.S3,
    width: '100%'
  },
  peekText: {
    flex: 1,
    alignItems: 'flex-start',
    gap: 2
  },
  overline: {
    fontSize: Type.CAPTION,
    lineHeight: Type.CAPTION_LH,
    fontWeight: '500',
    letterSpacing: Type.OVERLINE_SPACING,
    textTransform: 'uppercase'
  },
  peekTitle: {
    fontSize: Type.TITLE3,
    lineHeight: Type.TITLE3_LH,
    fontWeight: '700'
  },
  peekSubRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Space.S2
  },
  peekHero: {
    flexShrink: 1
  },
  peekEta: {
    fontSize: Type.CALLOUT
  },
  peekControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.S3
  },
  peekPlay: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center'
  },
  peekSkip: {
    width: Size.TOUCH,
    height: Size.TOUCH,
    borderRadius: Size.TOUCH / 2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  peekDirections: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.S2,
    width: '100%'
  },
  peekManeuver: {
    flex: 1,
    fontSize: Type.CALLOUT,
    lineHeight: Type.CALLOUT_LH
  },
  menu: {
    position: 'absolute',
    minWidth: 200,
    maxWidth: 280,
    borderRadius: Radius.MD,
    paddingTop: 4,
    paddingBottom: 4,
    shadowColor: '#000000',
    shadowOpacity: 0.16,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 }
  },
  menuItem: {
    minHeight: Size.TOUCH,
    paddingLeft: Space.S4,
    paddingRight: Space.S4,
    justifyContent: 'center'
  },
  menuText: {
    fontSize: Type.BODY
  },
  sheetFrame: {
    flex: 0
  },
  sheetTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: Space.S4,
    paddingRight: Space.S4,
    paddingTop: Space.S3,
    paddingBottom: Space.S2
  },
  sheetTitle: {
    flex: 1,
    fontSize: 20,
    fontWeight: '700'
  },
  sheetClose: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center'
  },
  stopsContent: {
    gap: Space.S3,
    paddingLeft: Space.S4,
    paddingRight: Space.S4
  },
  stopsFooter: {
    fontSize: Type.FOOTNOTE
  },
  fitSheetRoot: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.3)'
  },
  fitSheet: {
    borderTopLeftRadius: Radius.XL,
    borderTopRightRadius: Radius.XL,
    paddingTop: Space.S2
  },
  dragBar: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    opacity: 0.5
  }
});
