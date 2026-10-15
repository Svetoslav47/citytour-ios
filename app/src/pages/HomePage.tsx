/*
 * Home (DESIGN §3.2; SERVER.md §6 "Home"): the walks of the current city straight from the catalog, one tap to walk.
 * Header "You're in {city}" (a real fix inside the city's bbox) or "Walks in {city}" (core/remote/HomeRules). The
 * "Now walking" continue card when a tour runs; then one card per walk (cover 16:10, title, stops · km · ~min,
 * languages) with its actions ON the card: Start (id btnStartWalk: stream it if needed, check location, plan every
 * stop, start, Now Walking; no Route ready), Demo walk (id btnDemoWalk, SIMULATED), a small offline button
 * (download / progress ring / downloaded) and ⋯ / long-press "Remove download". The running walk's card says
 * Continue; another card's Start first asks to end the running tour. Tapping the cover or title opens Tour detail.
 * "All places in {city}" below (download-gated). Ids of the second and later cards end in _<course id>.
 * There is no separate Courses page in the flow.
 */
import {
  CardDownload, CardPrimary, ExploreStep, HomeHeader, IssueCode, LogEvents, StopProgress, StopStatus
} from '@citytour/core';
import { SymbolView } from 'expo-symbols';
import React, { useEffect, useMemo, useRef } from 'react';
import {
  ActionSheetIOS, ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { proxy, useSnapshot } from 'valtio';
import { Log } from '@/main/Log';
import { t, useT } from '@/platform/strings';
import { Radius, Size, Space, TABULAR, Type, useColors } from '@/theme';
import { AppViewModel, PackState, Routes } from '@/viewmodel/AppViewModel';
import { CatalogNote, CourseItem } from '@/viewmodel/CoursesViewModel';
import { HomeViewModel } from '@/viewmodel/HomeViewModel';
import { LocBanner } from '@/viewmodel/TourPlanViewModel';
import { CoverPhoto } from '@/views/common/CoverPhoto';
import { IssueBanner } from '@/views/common/IssueBanner';
import { SimulatedBadge } from '@/views/common/SimulatedBadge';
import { Capsule, LinearProgress, ProgressRing } from './PageParts';

type HomeSnap = ReturnType<typeof useSnapshot<HomeViewModel>>;
type ItemSnap = Readonly<CourseItem>;

export function HomePage(): React.JSX.Element {
  const t = useT();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const appVm = AppViewModel.get();
  const app = useSnapshot(appVm);
  const vm = useMemo(() => proxy(new HomeViewModel()), []);
  const s = useSnapshot(vm);

  // aboutToAppear / aboutToDisappear
  useEffect(() => {
    vm.attach();
    if (appVm.packState === PackState.READY) {
      vm.refresh(appVm.textLang);
    }
    vm.loadWalks(appVm.textLang);
    return () => {
      vm.detach();
    };
  }, [vm, appVm]);

  // @Monitor('app.packState', 'app.textLang', 'app.courseRev')
  const first = useRef<boolean>(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (appVm.packState === PackState.READY) {
      vm.refresh(appVm.textLang);
    }
  }, [app.packState, app.textLang, app.courseRev, vm, appVm]);

  const packReady = app.packState === PackState.READY;

  /** Card Start / Demo walk: Continue for the running walk; another walk first ends the running tour (confirm). */
  const onStart = (it: ItemSnap, demo: boolean): void => {
    const a = vm.card(it as CourseItem);
    if (a.primary === CardPrimary.CONTINUE && !demo) {
      appVm.openNowWalking();
      return;
    }
    if (a.confirmEnd) {
      confirmEnd(() => {
        run(it.id, demo);
      });
      return;
    }
    run(it.id, demo);
  };

  const run = async (id: string, demo: boolean): Promise<void> => {
    if (await vm.startWalk(id, demo)) {
      appVm.openNowWalking();
    }
  };

  const onAllow = async (): Promise<void> => {
    if (await vm.allowAndStart()) {
      appVm.openNowWalking();
    }
  };

  const onDemoInstead = async (): Promise<void> => {
    if (await vm.demoInstead()) {
      appVm.openNowWalking();
    }
  };

  /** Cover / title: Tour detail of that walk (made the active course first when needed). */
  const onOpen = async (it: ItemSnap): Promise<void> => {
    if (vm.startingId !== '') {
      return;
    }
    const id = await vm.openWalk(it.id);
    if (id !== '') {
      appVm.openTour(id);
    }
  };

  const confirmRemove = (it: ItemSnap): void => {
    if (!vm.card(it as CourseItem).canRemove) {
      return;
    }
    try {
      Alert.alert(
        t('home_remove_title'),
        it.active ? t('courses_delete_active_msg') : t('courses_delete_msg'),
        [
          { text: t('courses_cancel'), style: 'cancel' },
          {
            text: t('home_remove_download'),
            style: 'destructive',
            onPress: () => {
              vm.courses.remove(it.id);
            }
          }
        ]
      );
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=HomePage.confirmRemove ${Log.errKv(e)}`);
    }
  };

  /** ⋯ menu (ArkUI bindMenu): one item, "Remove download". */
  const openMore = (it: ItemSnap): void => {
    try {
      ActionSheetIOS.showActionSheetWithOptions({
        options: [t('home_remove_download'), t('courses_cancel')],
        destructiveButtonIndex: 0,
        cancelButtonIndex: 1
      }, (i: number) => {
        if (i === 0) {
          confirmRemove(it);
        }
      });
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=HomePage.openMore ${Log.errKv(e)}`);
    }
  };

  const bannerMessage = (): string => {
    if (s.gate.locBanner === LocBanner.APPROX) {
      return t('err_perm_approx');
    }
    if (s.gate.locBanner === LocBanner.SWITCH_OFF) {
      return t('err_loc_switch_off');
    }
    return t('err_perm_denied');
  };

  const bannerAction = (): string =>
    s.gate.locBanner === LocBanner.DENIED ? t('err_perm_allow') : t('err_perm_turn_on');

  const confirmEnd = (then?: () => void): void => {
    const snap = vm.snap;
    const visited = snap === undefined ? 0 :
      snap.stops.filter((p: StopProgress) => p.status === StopStatus.VISITED).length;
    try {
      Alert.alert(
        t('end_dialog_title'),
        t('end_dialog_msg', visited, vm.totalStops()),
        [
          { text: t('cta_keep_walking'), style: 'cancel' },
          {
            text: t('cta_end_tour'),
            style: 'destructive',
            onPress: () => {
              vm.endTour();
              if (then !== undefined) {
                then();
              }
            }
          }
        ]
      );
    } catch (e) {
      vm.endTour();
    }
  };

  const walks = s.walks();

  /** Card ids: the first walk keeps the short ids (btnStartWalk, btnDemoWalk); the others add _<course id>. */
  const cardId = (base: string, it: ItemSnap): string =>
    walks.length > 0 && walks[0].id === it.id ? base : `${base}_${it.id}`;

  const sectionHeader = (label: string): React.JSX.Element => (
    <Text style={[styles.overline, { color: c.text_secondary, marginTop: 28, marginBottom: Space.S2, marginLeft: Space.S1 }]}>
      {label}
    </Text>
  );

  const header = (): React.JSX.Element => (
    <View style={styles.headerRow}>
      <Text
        testID="txtHomeCity"
        style={[styles.title1, { color: c.text_primary }]}
      >
        {s.cityLabel === '' ? t('home_walks_any') :
          (s.header === HomeHeader.IN_CITY ? t('home_in_city', s.cityLabel) : t('home_walks_in', s.cityLabel))}
      </Text>
      {/* DESIGN §3.2: gearshape -> Settings (B9). 48 pt hit area. */}
      <Pressable
        testID="btnSettings"
        style={styles.gear}
        accessibilityRole="button"
        accessibilityLabel={t('a11y_settings')}
        onPress={() => appVm.openSettingsPage(Routes.SETTINGS, '')}
      >
        <SymbolView name="gearshape" size={24} tintColor={c.text_primary} />
      </Pressable>
    </View>
  );

  const continueCard = (): React.JSX.Element => (
    <View style={[styles.continueCard, { backgroundColor: c.bg_surface }]}>
      <View style={styles.rowCenter}>
        <Text style={[styles.overline, { color: c.text_secondary }]}>{t('home_now_walking')}</Text>
        <View style={{ flex: 1 }} />
        <SimulatedBadge visible={s.isDemo()} />
        <View style={[styles.rowCenter, { gap: 6, marginLeft: Space.S2 }]}>
          <View style={{
            width: 8, height: 8, borderRadius: 4,
            backgroundColor: s.snap?.paused ? c.text_tertiary : c.accent
          }} />
          <Text style={{ fontSize: Type.CAPTION, fontWeight: '500', color: c.text_secondary }}>
            {s.snap?.paused ? t('home_paused') : t('home_live')}
          </Text>
        </View>
      </View>
      <Text style={[styles.title3, { color: c.text_primary }]}>{s.title}</Text>
      <Text style={[styles.callout, { color: c.text_secondary }]}>
        {t('home_continue_line', s.currentStopNumber(), s.totalStops(), s.currentStopName)}
      </Text>
      <LinearProgress
        pct={s.progressPct()}
        color={c.accent}
        track={c.divider}
        label={t('home_progress_a11y', s.currentStopNumber(), s.totalStops())}
      />
      <View style={styles.rowCenter}>
        <Capsule
          id="btnOpenWalking"
          label={t('home_open')}
          a11y={t('home_open_a11y')}
          height={36}
          color={c.accent}
          bg={c.accent_subtle}
          onPress={() => appVm.openNowWalking()}
        />
        <View style={{ flex: 1 }} />
        <Capsule
          id="btnEndTourHome"
          label={t('cta_end_tour')}
          height={Size.TOUCH}
          color={c.signal_error}
          onPress={() => confirmEnd(undefined)}
        />
      </View>
    </View>
  );

  const chip = (text: string): React.JSX.Element => (
    <View style={[styles.chip, { borderColor: c.divider }]}>
      <Text style={{ fontSize: Type.CAPTION, fontWeight: '500', color: c.text_secondary }}>{text}</Text>
    </View>
  );

  /** Small offline button: download / progress ring / downloaded check. */
  const downloadButton = (it: ItemSnap): React.JSX.Element | null => {
    const d = s.card(it as CourseItem).download;
    if (d === CardDownload.PROGRESS) {
      return (
        <Pressable
          testID={cardId('btnWalkDownload', it)}
          style={styles.touch}
          accessibilityRole="button"
          accessibilityLabel={t('courses_downloading', `${it.pct}%`)}
          onPress={() => vm.courses.cancel(it.id)}
        >
          <ProgressRing pct={it.pct} size={28} stroke={3} color={c.accent} track={c.divider} />
        </Pressable>
      );
    }
    if (d === CardDownload.DONE) {
      return (
        <Pressable
          testID={cardId('btnWalkDownload', it)}
          style={styles.touch}
          accessibilityRole="button"
          accessibilityLabel={t('home_downloaded_a11y')}
          onPress={() => confirmRemove(it)}
        >
          <SymbolView name="checkmark.circle.fill" size={22} tintColor={c.accent} />
        </Pressable>
      );
    }
    if (d === CardDownload.DOWNLOAD) {
      return (
        <Pressable
          testID={cardId('btnWalkDownload', it)}
          style={styles.touch}
          accessibilityRole="button"
          accessibilityLabel={it.size !== '' ? t('courses_download', it.size) : t('home_download_a11y')}
          onPress={() => {
            vm.courses.download(it.id);
          }}
        >
          <SymbolView name="arrow.down.circle" size={22} tintColor={c.text_secondary} />
        </Pressable>
      );
    }
    return null;
  };

  const primaryButton = (it: ItemSnap): React.JSX.Element => {
    const a = s.card(it as CourseItem);
    const enabled = a.enabled && s.startingId === '';
    return (
      <Capsule
        id={cardId('btnStartWalk', it)}
        height={Size.BUTTON_H}
        color={c.on_accent}
        bg={c.accent}
        disabled={!enabled}
        style={{ flex: 1 }}
        a11y={a.primary === CardPrimary.PREPARING ? t('courses_preparing') :
          a.primary === CardPrimary.CONTINUE ? t('home_continue') : t('home_start')}
        onPress={() => onStart(it, false)}
      >
        <View style={[styles.rowCenter, { gap: Space.S2 }]}>
          {a.primary === CardPrimary.PREPARING ? (
            <>
              <ActivityIndicator size="small" color={c.on_accent} style={{ width: 20, height: 20 }} />
              <Text style={[styles.btnBody, { color: c.on_accent }]}>{t('courses_preparing')}</Text>
            </>
          ) : (
            <>
              <SymbolView
                name={a.primary === CardPrimary.CONTINUE ? 'figure.walk' : 'play.fill'}
                size={18}
                tintColor={c.on_accent}
              />
              <Text style={[styles.btnBody, { color: c.on_accent }]}>
                {a.primary === CardPrimary.CONTINUE ? t('home_continue') : t('home_start')}
              </Text>
            </>
          )}
        </View>
      </Capsule>
    );
  };

  const demoButton = (it: ItemSnap): React.JSX.Element => (
    <Capsule
      id={cardId('btnDemoWalk', it)}
      height={Size.BUTTON_H}
      color={c.accent}
      bg={c.accent_subtle}
      a11y={t('home_demo_a11y')}
      disabled={!(s.card(it as CourseItem).enabled && s.startingId === '')}
      onPress={() => onStart(it, true)}
    >
      <Text style={[styles.btnBody, { color: c.accent }]}>{t('home_demo_short')}</Text>
    </Capsule>
  );

  /** One walk: cover, title, stats, languages; Start / Demo walk and the offline button on the card itself. */
  const walkCard = (it: ItemSnap): React.JSX.Element => {
    const a = s.card(it as CourseItem);
    return (
      <Pressable
        key={`${it.id}|${it.state}|${it.downloading}|${it.active}|${it.failed}|` +
          `${it.streaming}|${it.preparing}|${it.playFailed}|${it.hasCover}`}
        testID={cardId('cardWalk', it)}
        style={[styles.card, { backgroundColor: c.bg_surface }]}
        onLongPress={() => {
          if (vm.card(it as CourseItem).canRemove) {
            confirmRemove(it);
          }
        }}
      >
        {it.hasCover ? (
          <Pressable onPress={() => onOpen(it)}>
            <CoverPhoto
              path={it.coverPath}
              alt={t('cover_alt_title', it.title)}
              ratio={16 / 10}
              photoId={cardId('coverWalk', it)}
            />
          </Pressable>
        ) : null}
        <View style={styles.cardBody}>
          <View style={[styles.row, { alignItems: 'flex-start' }]}>
            <Text
              style={[styles.title3, { color: c.text_primary, flex: 1 }]}
              onPress={() => onOpen(it)}
            >
              {it.title}
            </Text>
            {downloadButton(it)}
            {a.canRemove ? (
              <Pressable
                testID={cardId('btnWalkMore', it)}
                style={styles.more}
                accessibilityRole="button"
                accessibilityLabel={t('home_more_a11y')}
                onPress={() => openMore(it)}
              >
                <Text style={{ fontSize: Type.TITLE3, color: c.text_secondary, textAlign: 'center' }}>⋯</Text>
              </Pressable>
            ) : null}
          </View>

          <Text style={[styles.footnote, TABULAR, { color: c.text_secondary }]}>
            {it.km !== '' ? t('home_card_meta', it.stops, it.km, it.minutes) :
              t('home_card_meta_no_km', it.stops, it.minutes)}
          </Text>
          {it.langs !== '' ? (
            <View style={[styles.row, { marginTop: Space.S2 }]}>{chip(it.langs)}</View>
          ) : null}
          {a.showFailed ? (
            <Text style={[styles.footnote, { color: c.signal_error, marginTop: Space.S2 }]}>
              {it.failed ? t('courses_failed') : t('home_start_failed')}
            </Text>
          ) : null}
          {s.noDemoId === it.id ? (
            <Text style={[styles.footnote, { color: c.text_secondary, marginTop: Space.S2 }]}>
              {t('home_no_demo')}
            </Text>
          ) : null}
          {s.gateId === it.id && s.gate.locBanner !== LocBanner.NONE ? (
            <View style={{ marginTop: Space.S2, width: '100%' }}>
              <IssueBanner
                message={bannerMessage()}
                code={IssueCode.PERM_DENIED}
                actionLabel={bannerAction()}
                actionId="btnAllowLocation"
                secondaryLabel={s.demoOffered ? t('err_try_demo') : ''}
                secondaryId="btnTryDemo"
                onAction={() => {
                  onAllow();
                }}
                onSecondary={() => {
                  onDemoInstead();
                }}
              />
            </View>
          ) : null}
          <View style={[styles.row, { gap: Space.S2, marginTop: Space.S3 }]}>
            {primaryButton(it)}
            {a.demo ? demoButton(it) : null}
          </View>
        </View>
      </Pressable>
    );
  };

  const noteBox = (text: string, retry: boolean): React.JSX.Element => (
    <View testID="noteCourses" style={[styles.note, { backgroundColor: c.bg_surface_sunken }]}>
      <Text style={[styles.footnote, { color: c.text_secondary }]}>{text}</Text>
      {retry ? (
        <Capsule
          id="btnCoursesRetry"
          label={t('courses_retry')}
          height={Size.TOUCH}
          color={c.accent}
          onPress={() => {
            vm.loadWalks(appVm.textLang);
          }}
        />
      ) : null}
    </View>
  );

  /** Catalog notes: checking, offline (cached or nothing), no server, nothing published. */
  const walksNote = (): React.JSX.Element | null => {
    const note = s.courses.note;
    if (note === CatalogNote.LOADING && walks.length === 0) {
      return (
        <View style={[styles.rowCenter, { gap: Space.S2, marginBottom: Space.S3 }]}>
          <ActivityIndicator size="small" color={c.accent} style={{ width: 20, height: 20 }} />
          <Text style={{ fontSize: Type.CALLOUT, color: c.text_secondary }}>{t('courses_loading')}</Text>
        </View>
      );
    }
    if (note === CatalogNote.DISABLED && walks.length === 0) {
      return noteBox(t('courses_no_server_note'), false);
    }
    if (note === CatalogNote.OFFLINE_CACHED) {
      return noteBox(t('courses_offline'), true);
    }
    if (note === CatalogNote.OFFLINE_EMPTY) {
      return noteBox(t('courses_offline_empty'), true);
    }
    if (note === CatalogNote.UNVERIFIED) {
      return noteBox(t('courses_unverified'), true);
    }
    if (note === CatalogNote.NONE && walks.length === 0) {
      return noteBox(t('courses_empty'), true);
    }
    return null;
  };

  const onExplore = async (): Promise<void> => {
    if (await vm.explore(appVm.packState === PackState.READY)) {
      appVm.openFullMap('explore');
    }
  };

  const exploreRow = (): React.JSX.Element => (
    // B13: full map, explore mode (all places). No walk yet: a tap makes one active; a streamed walk has only its
    // stops: a tap fetches the city's places first (HomeRules.exploreStep), then the map opens.
    <Pressable
      testID="rowAllPlaces"
      style={[styles.exploreRow, { backgroundColor: c.bg_surface }]}
      accessible={true}
      accessibilityRole="button"
      onPress={() => {
        onExplore();
      }}
    >
      <View style={[styles.exploreIcon, { backgroundColor: c.bg_surface_sunken }]}>
        <SymbolView name="map" size={20} tintColor={c.text_primary} />
      </View>
      <View style={{ flex: 1, alignItems: 'flex-start' }}>
        <Text style={[styles.body, { fontWeight: '500', color: c.text_primary }]}>
          {app.cityName !== '' ? t('home_all_places', app.cityName) :
            s.cityLabel !== '' ? t('home_all_places', s.cityLabel) : t('home_all_places_any')}
        </Text>
        <Text style={[styles.callout, TABULAR, { color: c.text_secondary }]}>
          {exploreLine(s, s.exploreStep(packReady))}
        </Text>
      </View>
    </Pressable>
  );

  const packError = (): React.JSX.Element => (
    <View style={styles.packError}>
      <SymbolView name="exclamationmark.triangle.fill" size={32} tintColor={c.text_secondary} />
      <Text style={{ fontSize: Type.TITLE3, fontWeight: '500', color: c.text_primary, textAlign: 'center' }}>
        {t('home_pack_error_title')}
      </Text>
      <Text style={{ fontSize: Type.CALLOUT, color: c.text_secondary, textAlign: 'center' }}>
        {t('home_pack_error_body')}
      </Text>
    </View>
  );

  // Edge-to-edge (issue #63): the canvas colour runs under the status bar and the home indicator.
  // The list scrolls below the status bar (top inset on the frame); its end clears the home indicator.
  return (
    <View style={[styles.page, {
      paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right, backgroundColor: c.bg_canvas
    }]}>
      <ScrollView
        testID="pageHome"
        style={{ flex: 1, width: '100%' }}
        contentContainerStyle={{ alignItems: 'center' }}
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.content, { paddingBottom: Space.S5 + insets.bottom }]}>
          {header()}
          {app.packState === PackState.ERROR ? packError() : null}
          {s.sessionActive() ? continueCard() : null}
          <View style={{ width: '100%', marginTop: Space.S4 }}>
            {walksNote()}
            {walks.map((it: ItemSnap) => walkCard(it))}
          </View>
          {s.exploreStep(packReady) !== ExploreStep.HIDDEN &&
            app.packState !== PackState.LOADING && app.packState !== PackState.ERROR ? (
              <>
                {sectionHeader(t('home_explore'))}
                {exploreRow()}
              </>
            ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

/** The Explore row's second line for its step. */
function exploreLine(s: HomeSnap, step: ExploreStep): string {
  if (step === ExploreStep.OPEN) {
    return t('home_places_count', s.placesCount);
  }
  if (step === ExploreStep.BUSY) {
    return s.explorePct >= 0 ? t('home_all_places_progress', `${s.explorePct}%`) : t('home_all_places_preparing');
  }
  if (s.exploreFailed) {
    return t('home_all_places_failed');
  }
  const size = s.citySize();
  return size !== '' ? t('home_all_places_get_size', size) : t('home_all_places_get');
}

const styles = StyleSheet.create({
  page: { flex: 1, width: '100%' },
  content: {
    width: '100%',
    maxWidth: Size.PAGE_MAX_W,
    alignItems: 'flex-start',
    paddingLeft: Space.S4,
    paddingRight: Space.S4
  },
  headerRow: { flexDirection: 'row', alignItems: 'center', height: 56, width: '100%' },
  title1: { flex: 1, fontSize: Type.TITLE1, lineHeight: Type.TITLE1_LH, fontWeight: '700' },
  gear: { width: Size.TOUCH, height: Size.TOUCH, marginRight: -Space.S3, alignItems: 'center', justifyContent: 'center' },
  overline: {
    fontSize: Type.CAPTION,
    lineHeight: Type.CAPTION_LH,
    fontWeight: '500',
    letterSpacing: Type.OVERLINE_SPACING,
    textTransform: 'uppercase'
  },
  row: { flexDirection: 'row', width: '100%' },
  rowCenter: { flexDirection: 'row', alignItems: 'center' },
  title3: { fontSize: Type.TITLE3, lineHeight: Type.TITLE3_LH, fontWeight: '500' },
  body: { fontSize: Type.BODY, lineHeight: Type.BODY_LH },
  callout: { fontSize: Type.CALLOUT, lineHeight: Type.CALLOUT_LH },
  footnote: { fontSize: Type.FOOTNOTE, lineHeight: Type.FOOTNOTE_LH },
  btnBody: { fontSize: Type.BODY, fontWeight: '500' },
  continueCard: {
    width: '100%',
    alignItems: 'flex-start',
    gap: Space.S2,
    paddingLeft: Space.S4,
    paddingRight: Space.S4,
    paddingTop: Space.S4,
    paddingBottom: Space.S2,
    borderRadius: Radius.LG,
    marginTop: Space.S5
  },
  card: { width: '100%', borderRadius: Radius.LG, overflow: 'hidden', marginBottom: Space.S3 },
  cardBody: {
    width: '100%',
    alignItems: 'flex-start',
    gap: 2,
    paddingLeft: Space.S4,
    paddingRight: Space.S4,
    paddingTop: 14,
    paddingBottom: Space.S4
  },
  touch: { width: Size.TOUCH, height: Size.TOUCH, alignItems: 'center', justifyContent: 'center' },
  more: { width: 36, height: Size.TOUCH, marginRight: -Space.S2, alignItems: 'center', justifyContent: 'center' },
  chip: {
    height: 28,
    paddingLeft: 10,
    paddingRight: 10,
    borderRadius: Radius.SM,
    borderWidth: 1,
    justifyContent: 'center'
  },
  note: {
    width: '100%',
    alignItems: 'flex-start',
    gap: Space.S2,
    paddingLeft: 14,
    paddingRight: 14,
    paddingTop: 10,
    paddingBottom: 10,
    borderRadius: Radius.MD,
    marginBottom: Space.S3
  },
  exploreRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.S3,
    width: '100%',
    paddingLeft: Space.S4,
    paddingRight: Space.S3,
    paddingTop: 10,
    paddingBottom: 10,
    borderRadius: Radius.LG
  },
  exploreIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  packError: { width: '100%', alignItems: 'center', gap: Space.S2, padding: Space.S6, marginTop: Space.S6 }
});
