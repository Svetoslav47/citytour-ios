/*
 * Route ready (DESIGN §3.4) + the Before-you-go sheet (§3.5). The plan comes from TourControl.plan (Held-Karp).
 * A saving is claimed only when a real planner computed it and it is at least 50 m. "Begin" (id btnBegin) opens the
 * sheet; "Start walking" (id btnStartWalking) starts the tour.
 * Sheet: the ArkUI bindSheet (FIT_CONTENT, drag bar, close button, title) is a bottom sheet in a transparent Modal.
 * X1: "Time available" (All stops | 30 min | 45 min, ids segBudget0/30/45) re-plans with TourControl.plan(tourId,
 * budgetMin): exact orienteering picks the best subset; the result line says "Best k of n stops".
 */
import { IssueCode, LogEvents } from '@citytour/core';
import { useFocusEffect } from 'expo-router';
import { SFSymbol, SymbolView } from 'expo-symbols';
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSnapshot } from 'valtio';
import { Log } from '@/main/Log';
import { useT } from '@/platform/strings';
import { Radius, Size, Space, TABULAR, Type, useColors } from '@/theme';
import { AppViewModel } from '@/viewmodel/AppViewModel';
import { distanceRes, durationRes } from '@/viewmodel/Format';
import { BUDGET_OPTIONS_MIN, OrderRow } from '@/viewmodel/TourPlanViewModel';
import { FloatingIconButton } from '@/views/common/FloatingIconButton';
import { IssueBanner } from '@/views/common/IssueBanner';
import { Plaque, PlaqueState } from '@/views/common/Plaque';
import { SimulatedBadge } from '@/views/common/SimulatedBadge';
import { MapCanvas } from '@/views/map/MapCanvas';
import { SegmentOption, SegmentRow } from '@/views/settings/SettingsRows';
import { Capsule } from './PageParts';

export function RouteReadyPage(): React.JSX.Element {
  const t = useT();
  const c = useColors();
  /** Safe-area insets (edge-to-edge): the map runs under the status bar, the header capsule sits below it, and the
   * panel's last control clears the home indicator. */
  const sa = useSafeAreaInsets();
  const appVm = AppViewModel.get();
  const vm = useMemo(() => AppViewModel.get().tourPlan, []);
  const s = useSnapshot(vm);

  const budgetOptions: SegmentOption[] = BUDGET_OPTIONS_MIN.map((m: number) => m === 0 ?
    new SegmentOption('0', t('route_budget_all')) :
    new SegmentOption(`${m}`, t('fmt_min', m), t('route_budget_min_a11y', m)));

  useEffect(() => {
    vm.planRoute();
  }, [vm]);

  useFocusEffect(useCallback(() => {
    Log.i(LogEvents.APP_PAGE, `page=RouteReady shown tour=${vm.tourId} demo=${vm.demo}`);
  }, [vm]));

  // bindSheet onDisappear: the sheet went from shown to gone (closed, swiped away or Start walking).
  const sheetWasShown = useRef<boolean>(false);
  useEffect(() => {
    if (s.showSheet) {
      sheetWasShown.current = true;
      return;
    }
    if (sheetWasShown.current) {
      sheetWasShown.current = false;
      vm.onSheetGone().then((ok: boolean) => {
        if (ok) {
          appVm.openNowWalking();
        }
      }).catch((e: unknown) => {
        Log.e(LogEvents.UNCAUGHT, `where=RouteReadyPage.onSheetGone ${Log.errKv(e)}`);
      });
    }
  }, [s.showSheet, vm, appVm]);

  const overline = (label: string): React.JSX.Element => (
    <Text style={[styles.overline, { color: c.text_secondary }]}>{label}</Text>
  );

  const budgetPicker = (): React.JSX.Element => (
    <View style={{ width: '100%', alignItems: 'flex-start', marginTop: Space.S4 }}>
      {overline(t('route_time_available'))}
      <View style={{ marginLeft: -Space.S4, marginRight: -Space.S4, alignSelf: 'stretch' }}>
        <SegmentRow
          options={budgetOptions}
          selected={`${s.budgetMin}`}
          idPrefix="segBudget"
          onSelect={(key: string) => vm.setBudget(Number(key))}
        />
      </View>
    </View>
  );

  const orderList = (): React.JSX.Element => (
    <View style={{ width: '100%', marginTop: Space.S2 }}>
      {s.orderRows.map((row: Readonly<OrderRow>) => (
        <View key={`${row.order}:${row.poiId}`}>
          <View style={[styles.rowCenter, { height: Size.TOUCH, width: '100%', gap: Space.S3 }]}>
            <Plaque n={row.order} state={row.order === 1 ? PlaqueState.NEXT : PlaqueState.UPCOMING} />
            <Text style={{ flex: 1, fontSize: Type.BODY, color: c.text_primary }}>
              {row.name !== '' ? row.name : `${row.order}`}
            </Text>
          </View>
          {row.legToNextM > 0 ? (
            <View style={[styles.rowCenter, { gap: Space.S2, paddingLeft: 10, width: '100%' }]}>
              <SymbolView name="chevron.down" size={12} tintColor={c.text_tertiary} />
              <Text style={[{ fontSize: Type.FOOTNOTE, color: c.text_secondary }, TABULAR]}>
                {distanceRes(row.legToNextM)}
              </Text>
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );

  const planSummary = (): React.JSX.Element | null => {
    if (s.plan === undefined) {
      return null;
    }
    const walkMin = s.walkMinutes();
    return (
      <>
        <Text style={[styles.body, TABULAR, { color: c.text_primary, marginTop: Space.S2 }]}>
          {distanceRes(s.plan.walkM)}
          {walkMin > 0 ? ` · ${durationRes(walkMin)} ${t('route_walking')}` : ''}
        </Text>
        <Text style={[styles.body, TABULAR, { color: c.text_secondary }]}>
          {`~${durationRes(s.withStoriesMinutes())} ${t('tour_stat_with_stories')}`}
        </Text>
      </>
    );
  };

  const sheetRow = (n: number, symbol: SFSymbol, title: string, body: string, last: boolean): React.JSX.Element => (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 14, width: '100%', paddingBottom: last ? Space.S2 : 20 }}>
      <Plaque n={n} state={PlaqueState.NEUTRAL} />
      <View style={{ flex: 1, alignItems: 'flex-start', gap: 2 }}>
        <View style={[styles.rowCenter, { gap: Space.S2 }]}>
          <SymbolView name={symbol} size={18} tintColor={c.accent} />
          <Text style={{ fontSize: Type.BODY, fontWeight: '500', color: c.text_primary }}>{title}</Text>
        </View>
        <Text style={{ fontSize: Type.CALLOUT, lineHeight: Type.CALLOUT_LH, color: c.text_secondary }}>{body}</Text>
      </View>
    </View>
  );

  const beforeYouGo = (): React.JSX.Element => (
    <View style={{ width: '100%', paddingLeft: Space.S4, paddingRight: Space.S4, paddingTop: Space.S2, paddingBottom: Space.S5 }}>
      {sheetRow(1, 'headphones', t('byg_headphones_title'), t('byg_headphones_body'), false)}
      {sheetRow(2, 'speaker.wave.2', t('byg_volume_title'), t('byg_volume_body'), false)}
      {sheetRow(3, 'lock.fill', t('byg_lock_title'), t('byg_lock_body'), true)}
      <Text style={{
        fontSize: Type.FOOTNOTE, lineHeight: Type.FOOTNOTE_LH, color: c.text_secondary,
        marginTop: Space.S2, marginBottom: Space.S4
      }}>
        {t('byg_footnote')}
      </Text>
      <Capsule
        id="btnStartWalking"
        label={t('cta_start_walking')}
        height={Size.BUTTON_H}
        color={c.on_accent}
        bg={c.accent}
        style={{ width: '100%' }}
        onPress={() => vm.startWalking()}
      >
        <Text style={{ fontSize: Type.BODY, fontWeight: '500', color: c.on_accent }}>{t('cta_start_walking')}</Text>
      </Capsule>
    </View>
  );

  const sheet = (): React.JSX.Element => (
    <Modal
      visible={s.showSheet}
      transparent={true}
      animationType="slide"
      onRequestClose={() => {
        vm.showSheet = false;
      }}
    >
      <View style={styles.sheetRoot}>
        <Pressable
          style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.3)' }]}
          accessibilityLabel={t('a11y_close')}
          onPress={() => {
            vm.showSheet = false;
          }}
        />
        <View style={[styles.sheet, { backgroundColor: c.bg_surface, paddingBottom: sa.bottom }]}>
          <View style={[styles.dragBar, { backgroundColor: c.divider }]} />
          <View style={styles.sheetHeader}>
            <Text style={[styles.sheetTitle, { color: c.text_primary }]} accessibilityRole="header">
              {t('byg_title')}
            </Text>
            <Pressable
              style={[styles.sheetClose, { backgroundColor: c.bg_surface_sunken }]}
              accessibilityRole="button"
              accessibilityLabel={t('a11y_close')}
              onPress={() => {
                vm.showSheet = false;
              }}
            >
              <SymbolView name="xmark" size={14} weight="semibold" tintColor={c.text_secondary} />
            </Pressable>
          </View>
          {beforeYouGo()}
        </View>
      </View>
    </Modal>
  );

  const panel = (): React.JSX.Element => {
    const first = s.firstStopName();
    return (
      <View style={[styles.panel, {
        backgroundColor: c.bg_surface,
        paddingLeft: Space.S4 + sa.left,
        paddingRight: Space.S4 + sa.right,
        paddingBottom: Space.S5 + sa.bottom
      }]}>
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', width: '100%' }}>
          <View style={{ flex: 1, alignItems: 'flex-start', gap: Space.S1 }}>
            {overline(t('route_first_stop'))}
            <Text
              numberOfLines={2}
              ellipsizeMode="tail"
              style={{ fontSize: Type.TITLE2, lineHeight: Type.TITLE2_LH, fontWeight: '700', color: c.text_primary }}
            >
              {first !== '' ? first : '—'}
            </Text>
          </View>
          {s.orderRows.length > 0 ? (
            <Pressable
              testID="btnShowOrder"
              accessibilityRole="button"
              style={[styles.rowCenter, { height: Size.TOUCH, gap: 2, paddingLeft: Space.S4, paddingRight: Space.S2 }]}
              onPress={() => {
                vm.showOrder = !vm.showOrder;
              }}
            >
              <Text style={{ fontSize: Type.CALLOUT, fontWeight: '500', color: c.accent }}>
                {s.showOrder ? t('route_hide_order') : t('route_show_order')}
              </Text>
              <SymbolView name={s.showOrder ? 'chevron.up' : 'chevron.down'} size={14} tintColor={c.accent} />
            </Pressable>
          ) : null}
        </View>

        {s.planning ? (
          <View style={[styles.rowCenter, { gap: Space.S2, marginTop: Space.S3 }]}>
            <ActivityIndicator color={c.accent} style={{ width: 24, height: 24 }} />
            <Text style={{ fontSize: Type.CALLOUT, color: c.text_secondary }}>{t('route_planning')}</Text>
          </View>
        ) : s.planFailed ? (
          <View style={{ width: '100%', marginTop: Space.S3 }}>
            <IssueBanner
              message={t('err_plan_failed')}
              code={IssueCode.ROUTE_FALLBACK}
              actionLabel={t('err_try_again')}
              actionId="btnReplan"
              onAction={() => {
                vm.planRoute();
              }}
            />
          </View>
        ) : planSummary()}

        {budgetPicker()}

        {s.showOrder ? orderList() : null}

        {s.demo ? (
          <Text style={{
            fontSize: Type.FOOTNOTE, lineHeight: Type.FOOTNOTE_LH, color: c.signal_simulated_fg, marginTop: Space.S3
          }}>
            {t('route_demo_note')}
          </Text>
        ) : null}

        {s.startFailed ? (
          <View style={{ width: '100%', marginTop: Space.S3 }}>
            <IssueBanner message={t('route_start_failed')} code={IssueCode.UNCAUGHT} />
          </View>
        ) : null}

        {/* Short plans: push Begin to the bottom of the stretched panel instead of leaving a gap under it. */}
        <View style={{ flex: 1 }} />
        <Capsule
          id="btnBegin"
          height={Size.BUTTON_H}
          color={c.on_accent}
          bg={c.accent}
          a11y={t('cta_begin')}
          disabled={!(s.plan !== undefined && !s.planning && !s.starting)}
          style={{ width: '100%', marginTop: Space.S5 }}
          onPress={() => vm.begin()}
        >
          {s.starting ? (
            <ActivityIndicator color={c.on_accent} style={{ width: 24, height: 24 }} />
          ) : (
            <Text style={{ fontSize: Type.BODY, fontWeight: '500', color: c.on_accent }}>{t('cta_begin')}</Text>
          )}
        </Capsule>
      </View>
    );
  };

  // Subscribe to the map inputs; pass the live objects (not frozen snapshot copies) to the canvas.
  const useOrder = s.orderScene.stops.length > 0;
  void s.map;
  void s.scene;
  void s.sceneBounds;
  void s.orderBounds;

  return (
    <View style={[styles.page, { backgroundColor: c.bg_canvas }]}>
      <ScrollView
        style={{ flex: 1, width: '100%' }}
        contentContainerStyle={{ flexGrow: 1 }}
        showsVerticalScrollIndicator={false}
        contentInsetAdjustmentBehavior="never"
      >
        <MapCanvas
          map={vm.map}
          scene={useOrder ? vm.orderScene : vm.scene}
          bounds={useOrder ? vm.orderBounds : vm.sceneBounds}
          boxHeight={300 + sa.top}
          topInset={56 + sa.top}
          mapId="mapRouteReady"
        />
        {panel()}
      </ScrollView>

      <View
        pointerEvents="box-none"
        style={[styles.headerRow, {
          paddingLeft: Space.S2 + sa.left,
          paddingRight: Space.S3 + sa.right,
          paddingTop: Space.S2 + sa.top
        }]}
      >
        <View style={[styles.headerCapsule, { backgroundColor: c.bg_scrim }]}>
          <FloatingIconButton
            symbol="chevron.backward"
            label={t('a11y_back')}
            buttonId="btnBackRoute"
            diameter={36}
            onTap={() => appVm.back()}
          />
          {/* The tour's own name (long names end in "…"; the capsule shrinks before the SIMULATED badge does). */}
          <Text
            numberOfLines={1}
            ellipsizeMode="tail"
            style={{ flexShrink: 1, fontSize: 17, fontWeight: '500', color: c.text_primary, marginRight: 20 }}
          >
            {s.title.length > 0 ? s.title : t('route_title')}
          </Text>
        </View>
        <View style={{ flex: 1, minWidth: Space.S2 }} />
        <View style={{ flexShrink: 0 }}>
          <SimulatedBadge visible={s.demo} />
        </View>
      </View>

      {sheet()}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, width: '100%' },
  rowCenter: { flexDirection: 'row', alignItems: 'center' },
  body: { fontSize: Type.BODY, lineHeight: Type.BODY_LH },
  overline: {
    fontSize: Type.CAPTION,
    lineHeight: Type.CAPTION_LH,
    fontWeight: '500',
    letterSpacing: Type.OVERLINE_SPACING,
    textTransform: 'uppercase'
  },
  panel: {
    width: '100%',
    alignItems: 'flex-start',
    paddingTop: Space.S5,
    flexGrow: 1,   // the panel reaches the bottom edge even when the plan is short (no blank strip below it)
    borderTopLeftRadius: Radius.XL,
    borderTopRightRadius: Radius.XL,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 }
  },
  headerRow: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center'
  },
  headerCapsule: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    height: Size.TOUCH,
    borderRadius: 24
  },
  sheetRoot: { flex: 1, justifyContent: 'flex-end' },
  sheet: { width: '100%', borderTopLeftRadius: Radius.XL, borderTopRightRadius: Radius.XL },
  dragBar: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginTop: Space.S2 },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: Space.S4,
    paddingRight: Space.S4,
    paddingTop: Space.S2,
    paddingBottom: Space.S2
  },
  sheetTitle: { flex: 1, fontSize: 20, lineHeight: 26, fontWeight: '700' },
  sheetClose: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }
});
