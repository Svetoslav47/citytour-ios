/*
 * Tour detail (DESIGN §3.3): hero cover photo with the title (or, for a course without a cover, the route preview
 * as before), stats, the route map in its own "Route" section when the hero is a photo, guide row (name and
 * language), the stop list from the pack and the sticky "Start tour" (id btnStartTour): one tap plans every stop
 * (optimised order, default settings) and starts, then Now Walking (no Route ready); a running walk just reopens.
 * Location is checked here, in context (Flow D): a denied/approximate/switched-off state shows a banner that always
 * offers the Demo walk, so the flow never dead-ends.
 */
import { CoverView, IssueCode, LogEvents } from '@citytour/core';
import { useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, NativeScrollEvent, NativeSyntheticEvent, Pressable, ScrollView, StyleSheet, Text, View
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSnapshot } from 'valtio';
import { Log } from '@/app/Log';
import { useT } from '@/platform/strings';
import { Radius, Size, Space, TABULAR, Type, useColors } from '@/theme';
import { AppViewModel } from '@/viewmodel/AppViewModel';
import { distanceRes, durationRes, langNameRes } from '@/viewmodel/Format';
import { LocBanner } from '@/viewmodel/TourPlanViewModel';
import { CoverPhoto } from '@/views/common/CoverPhoto';
import { FloatingIconButton } from '@/views/common/FloatingIconButton';
import { IssueBanner } from '@/views/common/IssueBanner';
import { StopList, StopRow } from '@/views/common/StopList';
import { MapCanvas } from '@/views/map/MapCanvas';
import { Capsule } from './PageParts';

/** The route card is fitted to the whole walk (s ~0.25 for a 2 km route): show streets/buildings at that scale. */
const ROUTE_CARD_LOD: number = 0.4;

export interface TourDetailPageProps {
  tourId?: string;
}

export function TourDetailPage({ tourId = '' }: TourDetailPageProps): React.JSX.Element {
  const t = useT();
  const c = useColors();
  /** Safe-area insets (edge-to-edge): the map runs under the status bar, the CTA bar under the home indicator;
   * the back button and the button stay clear of both. */
  const sa = useSafeAreaInsets();
  const appVm = AppViewModel.get();
  // The flow's plan view model as it was when the page opened (AppViewModel.openTour makes a fresh one).
  const vm = useMemo(() => AppViewModel.get().tourPlan, []);
  const s = useSnapshot(vm);
  /** The hero has scrolled under the status bar: a canvas-coloured scrim keeps the text below the status bar. */
  const [pastHero, setPastHero] = useState<boolean>(false);

  useEffect(() => {
    vm.load(tourId, appVm.textLang);
  }, [vm, appVm, tourId]);

  useFocusEffect(useCallback(() => {
    Log.i(LogEvents.APP_PAGE, `page=TourDetail shown tour=${vm.tourId} stops=${vm.stops.length}`);
  }, [vm]));

  /** One tap: plan all stops (optimised order, default settings) and start; Now Walking (no Route ready). */
  const go = async (): Promise<void> => {
    if (await vm.startNow()) {
      appVm.openNowWalking();
    }
  };

  const onStartTour = async (): Promise<void> => {
    if (vm.tourRunning()) {
      appVm.openNowWalking();   // the walk is already running: continue it
      return;
    }
    const ok = await vm.startTour();
    if (ok) {
      await go();
    }
  };

  const onAllow = async (): Promise<void> => {
    const ok = vm.locBanner === LocBanner.SWITCH_OFF ? await vm.turnOnLocationSwitch() : await vm.allowLocation();
    if (ok) {
      await go();
    }
  };

  const onDemo = async (): Promise<void> => {
    const ok = await vm.useDemo();
    if (ok) {
      await go();
    }
  };

  const bannerMessage = (): string => {
    if (s.locBanner === LocBanner.APPROX) {
      return t('err_perm_approx');
    }
    if (s.locBanner === LocBanner.SWITCH_OFF) {
      return t('err_loc_switch_off');
    }
    return t('err_perm_denied');
  };

  const bannerAction = (): string =>
    s.locBanner === LocBanner.DENIED ? t('err_perm_allow') : t('err_perm_turn_on');

  /** The hero is the cover photo (or its loading placeholder); else the route map is the hero, as before. */
  const photoHero = s.cover.view() !== CoverView.FALLBACK;

  const routeMap = (boxHeight: number, topInset: number): React.JSX.Element => {
    // Subscribe to the map inputs; pass the live objects (not frozen snapshot copies) to the canvas.
    void s.map;
    void s.scene;
    void s.sceneBounds;
    return (
      <Pressable
        accessible={true}
        accessibilityRole="button"
        accessibilityLabel={t('tour_map_a11y', s.title, s.stops.length)}
        onPress={() => appVm.openFullMap('tour')}
      >
        <MapCanvas
          map={vm.map}
          scene={vm.scene}
          bounds={vm.sceneBounds}
          boxHeight={boxHeight}
          topInset={topInset}
          mapId="mapTourDetail"
          lodScale={ROUTE_CARD_LOD}
        />
      </Pressable>
    );
  };

  const stat = (value: string, label: string): React.JSX.Element => (
    <View style={{ flex: 1, alignItems: 'flex-start', gap: 2 }}>
      <Text style={[styles.title3, TABULAR, { color: c.text_primary }]}>{value}</Text>
      <Text style={[styles.caption, { color: c.text_secondary }]}>{label}</Text>
    </View>
  );

  const sectionHeader = (label: string): React.JSX.Element => (
    <Text style={[styles.overline, { color: c.text_secondary, marginTop: 22, marginBottom: Space.S2, marginLeft: Space.S1 }]}>
      {label}
    </Text>
  );

  const guideRow = (): React.JSX.Element => (
    <View testID="rowGuide" accessible={true} style={[styles.guideRow, { backgroundColor: c.bg_surface }]}>
      <View style={[styles.guideIcon, { backgroundColor: c.accent_subtle }]}>
        <SymbolView name="person" size={18} tintColor={c.accent} />
      </View>
      <View style={{ flex: 1, alignItems: 'flex-start' }}>
        <Text style={{ fontSize: Type.BODY, fontWeight: '500', color: c.text_primary }}>{s.guideName}</Text>
        <Text style={{ fontSize: Type.FOOTNOTE, lineHeight: Type.FOOTNOTE_LH, color: c.text_secondary }}>
          {`${t('tour_your_guide')} · ${langNameRes(s.textLang)}`}
        </Text>
      </View>
    </View>
  );

  const content = (): React.JSX.Element => (
    <View style={[styles.content, { paddingLeft: Space.S4 + sa.left, paddingRight: Space.S4 + sa.right }]}>
      {!photoHero ? (
        <Text style={[styles.title1, { color: c.text_primary }]}>{s.title}</Text>
      ) : null}
      {s.summary !== '' ? (
        <Text style={[styles.body, { color: c.text_secondary, marginTop: photoHero ? 0 : Space.S1 }]}>
          {s.summary}
        </Text>
      ) : null}
      <View style={styles.stats}>
        {stat(s.listedM > 0 ? distanceRes(s.listedM) : '—', t('tour_stat_walk'))}
        {s.estMinutes > 0 ? stat(durationRes(s.estMinutes), t('tour_stat_with_stories')) : null}
        {stat(`${s.stops.length}`, t('tour_stat_stops'))}
      </View>

      {photoHero ? (
        // The route map moved here from the top when the hero became the cover photo (same map, same tap).
        <>
          {sectionHeader(t('tour_route_header'))}
          <View style={{ width: '100%', borderRadius: Radius.LG, overflow: 'hidden' }}>
            {routeMap(200, 0)}
          </View>
        </>
      ) : null}

      {s.guideName !== '' ? guideRow() : null}

      {sectionHeader(t('tour_stops_header'))}
      <StopList
        rows={s.stops as readonly StopRow[]}
        tappable={true}
        onTapStop={(poiId: string) => appVm.openPlace(poiId)}
      />

      <View style={{ height: (s.locBanner === LocBanner.NONE ? 104 : 240) + sa.bottom }} />
    </View>
  );

  const bottomBar = (): React.JSX.Element => (
    <View style={[styles.bottomBar, {
      paddingLeft: Space.S4 + sa.left,
      paddingRight: Space.S4 + sa.right,
      paddingBottom: Space.S5 + sa.bottom,
      backgroundColor: c.bg_surface,
      borderTopColor: c.divider
    }]}>
      {s.locBanner !== LocBanner.NONE ? (
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
            onDemo();
          }}
        />
      ) : null}
      {s.startFailed ? <IssueBanner message={t('route_start_failed')} code={IssueCode.UNCAUGHT} /> : null}
      <Capsule
        id="btnStartTour"
        height={Size.BUTTON_H}
        color={c.on_accent}
        bg={c.accent}
        a11y={t('cta_start_tour')}
        disabled={!(s.found && !s.checking && !s.starting)}
        style={{ width: '100%' }}
        onPress={() => {
          onStartTour();
        }}
      >
        {s.checking || s.starting ? (
          <ActivityIndicator color={c.on_accent} style={{ width: 24, height: 24 }} />
        ) : (
          <Text style={{ fontSize: Type.BODY, fontWeight: '500', color: c.on_accent }}>{t('cta_start_tour')}</Text>
        )}
      </Capsule>
    </View>
  );

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>): void => {
    const hero = photoHero ? 280 : 260;   // hero height below the status bar (see the hero below)
    const past = e.nativeEvent.contentOffset.y >= hero;
    if (past !== pastHero) {
      setPastHero(past);
    }
  };

  return (
    <View style={[styles.page, { backgroundColor: c.bg_canvas }]}>
      <ScrollView
        style={{ flex: 1, width: '100%' }}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={32}
        onScroll={onScroll}
        contentInsetAdjustmentBehavior="never"
      >
        <View style={{ width: '100%' }}>
          {photoHero ? (
            <CoverPhoto
              path={s.cover.path}
              alt={t('cover_alt_title', s.title)}
              title={s.title}
              boxHeight={280 + sa.top}
              textPadding={Space.S4 + sa.left}
              photoId="coverTourDetail"
            />
          ) : routeMap(260 + sa.top, 40 + sa.top)}
          <View style={{ position: 'absolute', left: Space.S1 + sa.left, top: Space.S1 + sa.top }}>
            <FloatingIconButton
              symbol="chevron.backward"
              label={t('a11y_back')}
              buttonId="btnBack"
              onTap={() => appVm.back()}
            />
          </View>
        </View>

        {s.found ? content() : (
          <Text style={{ fontSize: Type.BODY, color: c.text_secondary, padding: Space.S4 }}>
            {t('tour_not_found')}
          </Text>
        )}
      </ScrollView>

      {/* Status-bar scrim (edge-to-edge): once the hero is gone the body stops below the clock. */}
      {pastHero && sa.top > 0 ? (
        <View
          testID="scrimTourDetail"
          pointerEvents="none"
          style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: sa.top, backgroundColor: c.bg_canvas }}
        />
      ) : null}

      {bottomBar()}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, width: '100%' },
  content: { width: '100%', alignItems: 'flex-start', paddingTop: 18 },
  title1: { fontSize: Type.TITLE1, lineHeight: Type.TITLE1_LH, fontWeight: '700' },
  title3: { fontSize: Type.TITLE3, lineHeight: Type.TITLE3_LH, fontWeight: '500' },
  body: { fontSize: Type.BODY, lineHeight: Type.BODY_LH },
  caption: { fontSize: Type.CAPTION, lineHeight: Type.CAPTION_LH, fontWeight: '500' },
  overline: {
    fontSize: Type.CAPTION,
    lineHeight: Type.CAPTION_LH,
    fontWeight: '500',
    letterSpacing: Type.OVERLINE_SPACING,
    textTransform: 'uppercase'
  },
  stats: {
    flexDirection: 'row',
    width: '100%',
    paddingLeft: Space.S1,
    paddingRight: Space.S1,
    marginTop: Space.S5
  },
  guideRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.S3,
    width: '100%',
    height: 60,
    paddingLeft: Space.S4,
    paddingRight: Space.S4,
    borderRadius: Radius.LG,
    marginTop: Space.S5
  },
  guideIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    gap: Space.S3,
    paddingTop: Space.S3,
    borderTopWidth: 1
  }
});
