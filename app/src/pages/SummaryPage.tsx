/*
 * Tour summary (B11, DESIGN §3.10): closes the loop after a tour. Header "Tour complete" / "Tour ended" with Done
 * (-> Home), the walked route on the offline map, tour title and date, the amber SIMULATED pill and note for the Demo
 * walk, the stat trio (stops heard, walked, total), "You heard" (tap -> Place detail), "Still to see" with the
 * distance from where the walk ended, and Start again (-> Tour detail).
 * No confetti, no rating prompt, no share push. Opened by Now Walking when the tour ends (SummaryViewModel.pending).
 * Ids: pageSummary, btnSummaryDone, mapSummary, badgeSimulated, txtSummarySimulated, statStops, statWalked, statTotal,
 * listHeard, listStillToSee, btnStartAgain.
 */
import { LogEvents, MapData } from '@citytour/core';
import { useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import React, { useCallback, useEffect, useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { proxy, useSnapshot } from 'valtio';
import { Log } from '@/main/Log';
import { useT } from '@/platform/strings';
import { Radius, Size, Space, TABULAR, Type, useColors } from '@/theme';
import { AppViewModel } from '@/viewmodel/AppViewModel';
import { distanceRes, durationRes } from '@/viewmodel/Format';
import { StillRow, SummaryViewModel } from '@/viewmodel/SummaryViewModel';
import { Plaque, PlaqueState } from '@/views/common/Plaque';
import { SimulatedBadge } from '@/views/common/SimulatedBadge';
import { StopList, StopRow } from '@/views/common/StopList';
import { MapCanvas } from '@/views/map/MapCanvas';
import { MapOverlay } from '@/views/map/MapRenderer';

const MAP_H: number = 220;

export function SummaryPage(): React.JSX.Element {
  const t = useT();
  const c = useColors();
  const sa = useSafeAreaInsets();
  const app = AppViewModel.get();
  const vm = useMemo(() => proxy(new SummaryViewModel()), []);
  const s = useSnapshot(vm);

  useEffect(() => {
    vm.load(app.textLang);
  }, [vm, app]);

  useFocusEffect(useCallback(() => {
    Log.i(LogEvents.APP_PAGE, 'page=Summary shown');
  }, []));

  const d = s.data;
  const complete = d !== undefined && d.complete;
  const demo = d !== undefined && d.demo;
  const stopsValue = d === undefined ? '—' : `${d.heardCount()}/${d.totalStops}`;
  const walkedValue = d === undefined || d.walkedM <= 0 ? '—' : distanceRes(d.walkedM);
  const total = s.totalTime();
  const totalValue = Number.isFinite(total) && total > 0 ? durationRes(total / 60) : '—';

  const sectionHeader = (label: string): React.JSX.Element => (
    <Text style={[styles.section, { color: c.text_secondary }]}>{label}</Text>
  );

  const stat = (value: string, caption: string, id: string): React.JSX.Element => (
    <View testID={id} accessible={true} style={styles.stat}>
      <Text numberOfLines={1} style={[styles.statValue, TABULAR, { color: c.text_primary }]}>{value}</Text>
      <Text style={[styles.statCaption, { color: c.text_secondary }]}>{caption}</Text>
    </View>
  );

  const stillList = (): React.JSX.Element => (
    <View testID="listStillToSee" style={[styles.stillList, { backgroundColor: c.bg_surface }]}>
      {(s.stillRows as StillRow[]).map((row: StillRow, idx: number) => (
        <Pressable
          key={`${row.order}:${row.poiId}`}
          accessible={true}
          accessibilityRole="button"
          style={[styles.stillRow, { borderTopWidth: idx === 0 ? 0 : 1, borderTopColor: c.divider }]}
          onPress={() => app.openPlace(row.poiId)}
        >
          <Plaque n={row.order} state={row.skipped ? PlaqueState.SKIPPED : PlaqueState.UPCOMING} />
          <Text numberOfLines={2} style={[styles.stillName, { color: c.text_primary }]}>{row.name}</Text>
          {Number.isFinite(row.distanceM) ? (
            <Text style={[styles.stillDist, TABULAR, { color: c.text_secondary }]}>{distanceRes(row.distanceM)}</Text>
          ) : null}
          <SymbolView name="chevron.right" size={16} tintColor={c.text_tertiary} />
        </Pressable>
      ))}
    </View>
  );

  const empty = (extra: object): React.JSX.Element => (
    <Text testID="txtSummaryEmpty" style={[styles.empty, { color: c.text_secondary }, extra]}>
      {t('summary_empty')}
    </Text>
  );

  const body = (): React.JSX.Element => (
    <View style={styles.body}>
      <View style={styles.map} accessible={true} accessibilityLabel={t('summary_map_a11y')}>
        <MapCanvas
          map={s.map as MapData | undefined}
          scene={s.scene as MapOverlay}
          bounds={s.sceneBounds as number[]}
          boxHeight={MAP_H}
          mapId="mapSummary"
        />
      </View>

      <Text style={[styles.title, { color: c.text_primary }]}>{s.tourTitle}</Text>
      {s.dateText !== '' ? <Text style={[styles.date, { color: c.text_secondary }]}>{s.dateText}</Text> : null}
      {demo ? (
        <View style={styles.simulated}>
          <SimulatedBadge visible={true} />
          <Text testID="txtSummarySimulated" style={[styles.simNote, { color: c.text_secondary }]}>
            {t('summary_simulated')}
          </Text>
        </View>
      ) : null}

      <View style={[styles.stats, { backgroundColor: c.bg_surface }]}>
        {stat(stopsValue, t('summary_stops'), 'statStops')}
        {stat(walkedValue, t('summary_walked'), 'statWalked')}
        {stat(totalValue, t('summary_total'), 'statTotal')}
      </View>

      {s.heardRows.length > 0 ? (
        <>
          {sectionHeader(t('summary_heard'))}
          <View testID="listHeard" style={styles.full}>
            <StopList rows={s.heardRows as StopRow[]} tappable={true} onTapStop={(poiId: string) => app.openPlace(poiId)} />
          </View>
        </>
      ) : !complete ? empty({ marginTop: Space.S5 }) : null}
      {s.stillRows.length > 0 ? (
        <>
          {sectionHeader(t('summary_still_to_see'))}
          {stillList()}
        </>
      ) : null}

      {d !== undefined && d.tourId !== '' ? (
        <Pressable
          testID="btnStartAgain"
          accessibilityRole="button"
          style={({ pressed }) => [styles.startAgain, { backgroundColor: c.bg_surface_sunken, opacity: pressed ? 0.7 : 1 }]}
          onPress={() => app.startTourAgain(vm.data !== undefined ? vm.data.tourId : '')}
        >
          <Text style={[styles.startAgainText, { color: c.accent }]}>{t('summary_start_again')}</Text>
        </Pressable>
      ) : null}
      <View style={{ height: Space.S6 }} />
    </View>
  );

  return (
    <View
      testID="pageSummary"
      style={[styles.page, {
        backgroundColor: c.bg_canvas,
        paddingTop: sa.top,
        paddingBottom: sa.bottom,
        paddingLeft: sa.left,
        paddingRight: sa.right
      }]}
    >
      <View style={styles.header}>
        <Text style={[styles.headerTitle, { color: c.text_primary }]}>
          {complete ? t('summary_complete') : t('summary_ended')}
        </Text>
        <Pressable
          testID="btnSummaryDone"
          accessibilityRole="button"
          style={({ pressed }) => [styles.done, { opacity: pressed ? 0.6 : 1 }]}
          onPress={() => app.home()}
        >
          <Text style={[styles.doneText, { color: c.accent }]}>{t('summary_done')}</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {d !== undefined ? body() : empty({ padding: Space.S4 })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    paddingLeft: Space.S4,
    paddingRight: Space.S2,
    paddingTop: Space.S2,
    paddingBottom: Space.S2
  },
  headerTitle: {
    flex: 1,
    fontSize: Type.TITLE3,
    fontWeight: '500'
  },
  done: {
    height: Size.TOUCH,
    paddingLeft: Space.S3,
    paddingRight: Space.S3,
    justifyContent: 'center'
  },
  doneText: {
    fontSize: Type.BODY,
    fontWeight: '500'
  },
  scroll: {
    flex: 1,
    width: '100%'
  },
  scrollContent: {
    alignItems: 'center'
  },
  body: {
    alignItems: 'flex-start',
    width: '100%',
    maxWidth: Size.PAGE_MAX_W,
    paddingLeft: Space.S4,
    paddingRight: Space.S4
  },
  map: {
    width: '100%',
    height: MAP_H,
    borderRadius: Radius.LG,
    overflow: 'hidden'
  },
  title: {
    fontSize: Type.TITLE1,
    lineHeight: Type.TITLE1_LH,
    fontWeight: '700',
    marginTop: Space.S5
  },
  date: {
    fontSize: Type.CALLOUT,
    lineHeight: Type.CALLOUT_LH,
    marginTop: Space.S1
  },
  simulated: {
    alignItems: 'flex-start',
    gap: Space.S2,
    marginTop: Space.S3
  },
  simNote: {
    fontSize: Type.FOOTNOTE,
    lineHeight: Type.FOOTNOTE_LH
  },
  stats: {
    flexDirection: 'row',
    gap: Space.S3,
    width: '100%',
    padding: Space.S4,
    marginTop: Space.S5,
    borderRadius: Radius.LG
  },
  stat: {
    flex: 1,
    alignItems: 'flex-start',
    gap: 2
  },
  statValue: {
    fontSize: Type.TITLE2,
    lineHeight: Type.TITLE2_LH,
    fontWeight: '500'
  },
  statCaption: {
    fontSize: Type.CAPTION,
    lineHeight: Type.CAPTION_LH
  },
  section: {
    fontSize: Type.CAPTION,
    lineHeight: Type.CAPTION_LH,
    fontWeight: '500',
    letterSpacing: Type.OVERLINE_SPACING,
    textTransform: 'uppercase',
    marginTop: 28,
    marginBottom: Space.S2,
    marginLeft: Space.S1
  },
  full: {
    width: '100%'
  },
  stillList: {
    width: '100%',
    paddingTop: Space.S1,
    paddingBottom: Space.S1,
    borderRadius: Radius.LG
  },
  stillRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    width: '100%',
    height: Size.TOUCH,
    paddingLeft: 10,
    paddingRight: 12
  },
  stillName: {
    flex: 1,
    fontSize: Type.BODY,
    lineHeight: Type.BODY_LH
  },
  stillDist: {
    fontSize: Type.FOOTNOTE,
    lineHeight: Type.FOOTNOTE_LH
  },
  empty: {
    fontSize: Type.BODY,
    lineHeight: Type.BODY_LH
  },
  startAgain: {
    width: '100%',
    height: Size.BUTTON_H,
    borderRadius: Size.BUTTON_H / 2,
    marginTop: Space.S5,
    alignItems: 'center',
    justifyContent: 'center'
  },
  startAgainText: {
    fontSize: Type.BODY,
    fontWeight: '500'
  }
});
