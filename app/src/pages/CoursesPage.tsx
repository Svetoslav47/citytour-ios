/*
 * Courses screen (docs/SERVER.md §6), opened from Home ("Browse walks" on first run, "More courses" later). The app
 * ships no built-in course: the catalog loads on open. One card per course: a 16:9 cover photo banner (credits in About)
 * (from the catalog before download, from the pack after), title in the UI language, city, stops ·
 * km · minutes, languages, and the action for its state: Download · size / progress % + Cancel / Downloaded ✓ /
 * Update / Try again / Delete, plus "Use" for a downloaded course that is not active ("In use" on the active one).
 * Notes: server disabled -> "No course server"; offline -> the cached list (or nothing) with an "Offline" note and
 * Try again; an empty catalog -> "No walks are published yet". DESIGN.md tokens, safe-area insets.
 * Play now (stream, the primary action of a course that is not downloaded) / "Preparing…" / "Streaming" on the
 * active streamed course; Download stays next to it as the offline option.
 * Ids: btnCoursePlay_<id>, pageCourses, courseRow_<id>, btnCourseDownload_<id>, btnCourseCancel_<id>, btnCourseUse_<id>,
 * btnCourseDelete_<id>, courseCover_<id>, noteCourses.
 */
import { CourseState, LogEvents } from '@citytour/core';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSnapshot } from 'valtio';
import { Log } from '@/app/Log';
import { useT } from '@/platform/strings';
import { Radius, Size, Space, TABULAR, Type, useColors } from '@/theme';
import { AppViewModel } from '@/viewmodel/AppViewModel';
import { CatalogNote, CourseItem, CoursesViewModel } from '@/viewmodel/CoursesViewModel';
import { CoverPhoto } from '@/views/common/CoverPhoto';
import { SettingsHeader } from '@/views/settings/SettingsRows';
import { Capsule, LinearProgress } from './PageParts';

type ItemSnap = Readonly<CourseItem>;

export function CoursesPage(): React.JSX.Element {
  const t = useT();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const appVm = AppViewModel.get();
  const vm = CoursesViewModel.get();
  const s = useSnapshot(vm);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  useEffect(() => {
    Log.i(LogEvents.APP_PAGE, 'page=Courses');
    vm.visible = true;
    vm.open(appVm.textLang);
    return () => {
      vm.visible = false;
    };
  }, [vm, appVm]);

  const confirmDelete = (it: ItemSnap): void => {
    try {
      Alert.alert(
        t('courses_delete_title'),
        it.active ? t('courses_delete_active_msg') : t('courses_delete_msg'),
        [
          { text: t('courses_cancel'), style: 'cancel' },
          {
            text: t('courses_delete'),
            style: 'destructive',
            onPress: () => {
              vm.remove(it.id);
            }
          }
        ]
      );
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=CoursesPage.confirmDelete ${Log.errKv(e)}`);
    }
  };

  const noteBox = (key: string, text: string, retry: boolean): React.JSX.Element => (
    <View key={key} testID="noteCourses" style={[styles.note, { backgroundColor: c.bg_surface_sunken }]}>
      <Text style={[styles.footnote, { color: c.text_secondary }]}>{text}</Text>
      {retry ? (
        <Capsule
          id="btnCoursesRetry"
          label={t('courses_retry')}
          height={Size.TOUCH}
          color={c.accent}
          onPress={() => vm.retry()}
        />
      ) : null}
    </View>
  );

  const notes = (): React.JSX.Element[] => {
    const out: React.JSX.Element[] = [];
    if (s.note === CatalogNote.LOADING) {
      out.push(
        <View key="loading" style={[styles.rowCenter, { gap: Space.S2 }]}>
          <ActivityIndicator size="small" color={c.accent} style={{ width: 20, height: 20 }} />
          <Text style={{ fontSize: Type.CALLOUT, color: c.text_secondary }}>{t('courses_loading')}</Text>
        </View>
      );
    } else if (s.note === CatalogNote.DISABLED) {
      out.push(
        <View key="disabled" testID="noteCourses" style={{ width: '100%', alignItems: 'flex-start', gap: Space.S1 }}>
          <Text style={{ fontSize: Type.BODY, fontWeight: '500', color: c.text_primary }}>
            {t('courses_no_server')}
          </Text>
          <Text style={[styles.footnote, { color: c.text_secondary }]}>{t('courses_no_server_note')}</Text>
        </View>
      );
    } else if (s.note === CatalogNote.OFFLINE_CACHED) {
      out.push(noteBox('offline', t('courses_offline'), true));
    } else if (s.note === CatalogNote.OFFLINE_EMPTY) {
      out.push(noteBox('offlineEmpty', t('courses_offline_empty'), true));
    } else if (s.note === CatalogNote.UNVERIFIED) {
      out.push(noteBox('unverified', t('courses_unverified'), true));
    } else if (s.note === CatalogNote.NONE && s.items.length === 0) {
      out.push(noteBox('empty', t('courses_empty'), true));
    }
    if (s.tourRunning) {
      out.push(noteBox('running', t('courses_tour_running'), false));
    }
    if (s.switchFailed) {
      out.push(noteBox('switchFailed', t('courses_switch_failed'), false));
    }
    return out;
  };

  const chip = (text: string): React.JSX.Element => (
    <View style={[styles.chip, { borderColor: c.divider }]}>
      <Text style={{ fontSize: Type.CAPTION, fontWeight: '500', color: c.text_secondary }}>{text}</Text>
    </View>
  );

  const downloadLabel = (it: ItemSnap): string => it.failed ? t('courses_retry') :
    (it.size !== '' ? t('courses_download', it.size) : t('courses_download_plain'));

  const primaryAction = (it: ItemSnap): React.JSX.Element => {
    if (it.downloading) {
      return (
        <>
          <View style={{ flex: 1, alignItems: 'flex-start', gap: Space.S1 }}>
            <Text style={[{ fontSize: Type.CALLOUT, color: c.text_secondary }, TABULAR]}>
              {it.cancelling ? t('courses_cancelling') : t('courses_downloading', `${it.pct}%`)}
            </Text>
            <LinearProgress
              pct={it.pct}
              color={c.accent}
              track={c.divider}
              label={t('courses_downloading', `${it.pct}%`)}
            />
          </View>
          <Capsule
            id={`btnCourseCancel_${it.id}`}
            label={t('courses_cancel')}
            height={Size.TOUCH}
            color={c.text_secondary}
            disabled={it.cancelling}
            onPress={() => vm.cancel(it.id)}
          />
        </>
      );
    }
    if (it.preparing) {
      return (
        <View style={[styles.rowCenter, { gap: Space.S2 }]}>
          <ActivityIndicator size="small" color={c.accent} style={{ width: 20, height: 20 }} />
          <Text style={{ fontSize: Type.CALLOUT, color: c.text_secondary }}>{t('courses_preparing')}</Text>
        </View>
      );
    }
    if (it.state === CourseState.AVAILABLE && (it.playNow || it.streaming)) {
      return (
        <>
          {it.playNow ? (
            <Capsule
              id={`btnCoursePlay_${it.id}`}
              label={t('courses_play_now')}
              height={36}
              color={c.on_accent}
              bg={c.accent}
              disabled={s.tourRunning}
              onPress={() => {
                vm.play(it.id);
              }}
            />
          ) : (
            <Text style={{ fontSize: Type.CALLOUT, color: c.accent }}>{t('courses_streaming')}</Text>
          )}
          {s.enabled ? (
            <Capsule
              id={`btnCourseDownload_${it.id}`}
              label={downloadLabel(it)}
              height={Size.TOUCH}
              color={c.accent}
              onPress={() => {
                vm.download(it.id);
              }}
            />
          ) : null}
        </>
      );
    }
    if (it.state === CourseState.AVAILABLE || it.state === CourseState.UPDATE) {
      return (
        <Capsule
          id={`btnCourseDownload_${it.id}`}
          label={it.failed ? t('courses_retry') :
            (it.state === CourseState.UPDATE ? t('courses_update') :
              (it.size !== '' ? t('courses_download', it.size) : t('courses_download_plain')))}
          height={36}
          color={c.accent}
          bg={c.accent_subtle}
          disabled={!s.enabled}
          onPress={() => {
            vm.download(it.id);
          }}
        />
      );
    }
    return <Text style={{ fontSize: Type.CALLOUT, color: c.accent }}>{t('courses_downloaded')}</Text>;
  };

  const card = (it: ItemSnap): React.JSX.Element => (
    <View
      // rebuild() makes new CourseItem objects: key on the row state too, so the row re-renders with it.
      key={`${it.id}|${it.state}|${it.downloading}|${it.active}|${it.failed}|${it.cancelling}|${it.playNow}|` +
        `${it.streaming}|${it.preparing}|${it.playFailed}`}
      testID={`courseRow_${it.id}`}
      style={[styles.card, { backgroundColor: c.bg_surface }]}
    >
      {/* 16:9 cover banner (also before download: the catalog's cover, fetched and verified); placeholder while it
          loads; no banner for a course without a cover. */}
      {it.hasCover ? (
        <CoverPhoto
          path={it.coverPath}
          alt={t('cover_alt_title', it.title)}
          ratio={16 / 9}
          textPadding={Space.S4}
          photoId={`courseCover_${it.id}`}
        />
      ) : null}
      <View style={styles.cardBody}>
        <View style={[styles.rowCenter, { width: '100%', gap: Space.S2 }]}>
          <Text style={[styles.title3, { flex: 1, color: c.text_primary }]}>{it.title}</Text>
          {it.active ? (
            <View style={[styles.activeChip, { backgroundColor: c.accent_subtle }]}>
              <Text style={{ fontSize: Type.CAPTION, fontWeight: '500', color: c.accent }}>{t('courses_active')}</Text>
            </View>
          ) : null}
        </View>

        {it.city !== '' ? (
          <Text style={{ fontSize: Type.CALLOUT, lineHeight: Type.CALLOUT_LH, color: c.text_secondary }}>{it.city}</Text>
        ) : null}
        <Text style={[styles.footnote, TABULAR, { color: c.text_secondary }]}>
          {it.km !== '' ? t('courses_meta', it.stops, it.km, it.minutes) :
            t('courses_meta_no_km', it.stops, it.minutes)}
        </Text>
        <View style={[styles.rowCenter, { gap: Space.S2 }]}>
          {it.langs !== '' ? chip(it.langs) : null}
        </View>

        {it.playFailed ? (
          <Text style={[styles.footnote, { color: c.signal_error }]}>{t('courses_play_failed')}</Text>
        ) : null}
        {it.failed ? (
          <Text style={[styles.footnote, { color: c.signal_error }]}>{t('courses_failed')}</Text>
        ) : null}

        <View style={[styles.rowCenter, { width: '100%', gap: Space.S2, marginTop: Space.S1 }]}>
          {primaryAction(it)}
          <View style={{ flex: 1 }} />
          {it.canSelect && !it.active && !it.downloading ? (
            <Capsule
              id={`btnCourseUse_${it.id}`}
              label={t('courses_use')}
              height={36}
              color={c.accent}
              bg={c.accent_subtle}
              disabled={s.tourRunning || s.busySwitch}
              onPress={() => {
                vm.select(it.id);
              }}
            />
          ) : null}
          {it.canDelete && !it.downloading && !it.preparing ? (
            <Capsule
              id={`btnCourseDelete_${it.id}`}
              label={t('courses_delete')}
              height={Size.TOUCH}
              color={c.signal_error}
              disabled={it.active && s.tourRunning}
              onPress={() => confirmDelete(it)}
            />
          ) : null}
        </View>
      </View>
    </View>
  );

  return (
    <View style={[styles.page, {
      paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right, backgroundColor: c.bg_canvas
    }]}>
      <ScrollView
        testID="pageCourses"
        style={{ flex: 1, width: '100%' }}
        contentContainerStyle={{ alignItems: 'center' }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          // Pull down to fetch the catalog again (it is also fetched every time the page opens).
          <RefreshControl
            refreshing={refreshing}
            tintColor={c.accent}
            onRefresh={() => {
              setRefreshing(true);
              vm.open(appVm.textLang).finally(() => {
                setRefreshing(false);
              });
            }}
          />
        }
      >
        <View style={{ width: '100%', maxWidth: Size.PAGE_MAX_W }}>
          <SettingsHeader title={t('courses_title')} backId="btnCoursesBack" onBack={() => appVm.back()} />
          <View style={[styles.list, { paddingBottom: Space.S6 + insets.bottom }]}>
            {notes()}
            {s.items.map((it: ItemSnap) => card(it))}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, width: '100%' },
  list: { width: '100%', gap: Space.S3, paddingLeft: Space.S4, paddingRight: Space.S4 },
  rowCenter: { flexDirection: 'row', alignItems: 'center' },
  title3: { fontSize: Type.TITLE3, lineHeight: Type.TITLE3_LH, fontWeight: '500' },
  footnote: { fontSize: Type.FOOTNOTE, lineHeight: Type.FOOTNOTE_LH },
  note: {
    width: '100%',
    alignItems: 'flex-start',
    gap: Space.S2,
    paddingLeft: 14,
    paddingRight: 14,
    paddingTop: 10,
    paddingBottom: 10,
    borderRadius: Radius.MD
  },
  chip: {
    height: 24,
    paddingLeft: Space.S2,
    paddingRight: Space.S2,
    borderRadius: Radius.SM,
    borderWidth: 1,
    justifyContent: 'center'
  },
  activeChip: {
    height: 24,
    paddingLeft: Space.S2,
    paddingRight: Space.S2,
    borderRadius: Radius.SM,
    justifyContent: 'center'
  },
  card: { width: '100%', borderRadius: Radius.LG, overflow: 'hidden' },
  cardBody: { width: '100%', alignItems: 'flex-start', gap: Space.S2, padding: Space.S4 }
});
