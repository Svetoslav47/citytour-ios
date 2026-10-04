/*
 * Place detail (B8, DESIGN §3.8): a 4:3 offline map snippet centred on the place (the pack has no photos),
 * overline (stop number + kind), name (+ Polish name), the reviewed "where to look" box for tour stops and the
 * story (selectable). Sources, licences and the AI note live in Settings -> About, not here. Missing narration
 * never gives an empty screen: a plain line shows instead. "Tell me more" only at the stop being visited
 * (TourControl.more).
 */
import { LogEvents, LookDir, MapData, PoiKind } from '@citytour/core';
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { LayoutChangeEvent, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { proxy, useSnapshot } from 'valtio';
import { Log } from '@/app/Log';
import { t as tr, useT } from '@/platform/strings';
import { Size, Space, Type, useColors } from '@/theme';
import { AppViewModel } from '@/viewmodel/AppViewModel';
import { PlaceViewModel } from '@/viewmodel/PlaceViewModel';
import { FloatingIconButton } from '@/views/common/FloatingIconButton';
import { MapCanvas } from '@/views/map/MapCanvas';
import { MapOverlay } from '@/views/map/MapRenderer';
import { LookBox } from '@/views/place/LookBox';

/** The kind of place in the UI language (also used by the map's place card). */
export function kindLabel(kind: PoiKind): string {
  switch (kind) {
    case PoiKind.MONUMENT:
      return tr('kind_monument');
    case PoiKind.CHURCH:
      return tr('kind_church');
    case PoiKind.CASTLE:
      return tr('kind_castle');
    case PoiKind.SQUARE:
      return tr('kind_square');
    case PoiKind.GATE:
      return tr('kind_gate');
    case PoiKind.MUSEUM:
      return tr('kind_museum');
    case PoiKind.BUILDING:
      return tr('kind_building');
    case PoiKind.PLAQUE:
      return tr('kind_plaque');
    case PoiKind.VIEWPOINT:
      return tr('kind_viewpoint');
    case PoiKind.SYNAGOGUE:
      return tr('kind_synagogue');
    default:
      return tr('kind_other');
  }
}

export interface PlaceDetailPageProps {
  poiId: string;
}

export function PlaceDetailPage({ poiId }: PlaceDetailPageProps): React.JSX.Element {
  const t = useT();
  const c = useColors();
  const sa = useSafeAreaInsets();
  const app = AppViewModel.get();
  const vm = useMemo(() => proxy(new PlaceViewModel()), []);
  const s = useSnapshot(vm);
  const [pageW, setPageW] = useState<number>(0);

  useEffect(() => {
    vm.load(poiId, app.textLang);
  }, [vm, app, poiId]);

  useFocusEffect(useCallback(() => {
    Log.i(LogEvents.APP_PAGE, `page=PlaceDetail shown poi=${poiId} tier=${vm.tier}`);
  }, [poiId, vm]));

  const onLayout = (e: LayoutChangeEvent): void => {
    setPageW(Math.min(e.nativeEvent.layout.width, Size.PAGE_MAX_W));
  };

  const sectionHeader = (label: string): React.JSX.Element => (
    <Text style={[styles.section, { color: c.text_secondary }]}>{label}</Text>
  );

  const content = (): React.JSX.Element => (
    <View style={styles.content}>
      <View style={styles.heading}>
        <Text style={[styles.overline, { color: c.text_secondary }]}>
          {s.stopNumber > 0 ? `${t('place_stop_overline', s.stopNumber)} · ` : ''}
          {kindLabel(s.kind)}
        </Text>
        <Text testID="placeName" style={[styles.name, { color: c.text_primary }]}>{s.name}</Text>
        {s.localNamePl !== '' ? (
          <Text style={[styles.localName, { color: c.text_secondary }]}>{s.localNamePl}</Text>
        ) : null}
      </View>

      {s.currentStop ? (
        <Pressable
          testID="btnTellMore"
          accessibilityRole="button"
          style={({ pressed }) => [styles.tellMore, { backgroundColor: c.bg_surface_sunken, opacity: pressed ? 0.7 : 1 }]}
          onPress={() => vm.tellMore()}
        >
          <Text style={[styles.tellMoreText, { color: c.text_primary }]}>{t('cta_tell_more')}</Text>
        </Pressable>
      ) : null}

      {s.look !== undefined ? <LookBox look={s.look as LookDir} feature={s.lookFeature} /> : null}

      {s.paragraphs.length > 0 ? (
        <View testID="placeTranscript" style={styles.transcript}>
          {sectionHeader(t('place_transcript'))}
          {s.paragraphs.map((p: string, i: number) => (
            <Text key={`${i}:${p.length}`} selectable={true} style={[styles.paragraph, { color: c.text_primary }]}>
              {p}
            </Text>
          ))}
        </View>
      ) : (
        <Text style={[styles.basic, { color: c.text_secondary }]}>{t('place_basic_note')}</Text>
      )}

      <View style={{ height: Space.S6 }} />
    </View>
  );

  return (
    <View testID="pagePlace" style={[styles.page, { backgroundColor: c.bg_canvas }]}>
      <ScrollView
        style={styles.page}
        contentContainerStyle={{ paddingBottom: sa.bottom }}
        showsVerticalScrollIndicator={false}
        onLayout={onLayout}
      >
        {/* No photos in the pack: the 4:3 map snippet centred on the place stands in (DESIGN §3.8), with the
            back button floating over it as on Tour detail. */}
        <View style={styles.top}>
          {s.found && pageW > 0 ? (
            <View accessible={true} accessibilityLabel={t('place_map_a11y', s.name)}>
              <MapCanvas
                map={s.map as MapData | undefined}
                scene={s.scene as MapOverlay}
                bounds={s.sceneBounds as number[]}
                boxHeight={Math.round(pageW * 3 / 4) + sa.top}
                topInset={sa.top}
                mapId="mapPlace"
              />
            </View>
          ) : null}
          <View style={[styles.back, { left: Space.S2 + sa.left, top: Space.S2 + sa.top }]}>
            <FloatingIconButton
              symbol="chevron.backward"
              label={t('a11y_back')}
              buttonId="btnBackPlace"
              onTap={() => app.back()}
            />
          </View>
          {/* Keeps the back button inside the scroll content when there is no map. */}
          {!(s.found && pageW > 0) ? <View style={{ height: Space.S2 + sa.top + Size.TOUCH }} /> : null}
        </View>

        {s.found ? (
          <View style={styles.center}>{content()}</View>
        ) : (
          <Text style={[styles.notFound, { color: c.text_secondary }]}>{t('place_not_found')}</Text>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1
  },
  top: {
    width: '100%'
  },
  back: {
    position: 'absolute'
  },
  center: {
    alignItems: 'center',
    width: '100%'
  },
  content: {
    alignItems: 'flex-start',
    width: '100%',
    maxWidth: Size.PAGE_MAX_W,
    gap: 20,
    paddingLeft: Space.S4,
    paddingRight: Space.S4,
    paddingTop: Space.S5
  },
  heading: {
    alignItems: 'flex-start',
    width: '100%',
    gap: 2
  },
  overline: {
    fontSize: Type.CAPTION,
    lineHeight: Type.CAPTION_LH,
    fontWeight: '500',
    letterSpacing: Type.OVERLINE_SPACING,
    textTransform: 'uppercase'
  },
  name: {
    fontSize: Type.TITLE1,
    lineHeight: Type.TITLE1_LH,
    fontWeight: '700',
    marginTop: 6
  },
  localName: {
    fontSize: Type.CALLOUT,
    lineHeight: Type.CALLOUT_LH
  },
  tellMore: {
    height: Size.BUTTON_H,
    borderRadius: Size.BUTTON_H / 2,
    paddingLeft: Space.S5,
    paddingRight: Space.S5,
    alignItems: 'center',
    justifyContent: 'center'
  },
  tellMoreText: {
    fontSize: Type.BODY,
    fontWeight: '500'
  },
  transcript: {
    alignItems: 'flex-start',
    width: '100%',
    gap: Space.S3
  },
  section: {
    fontSize: Type.CAPTION,
    lineHeight: Type.CAPTION_LH,
    fontWeight: '500',
    letterSpacing: Type.OVERLINE_SPACING,
    textTransform: 'uppercase',
    marginLeft: Space.S1
  },
  paragraph: {
    width: '100%',
    fontSize: Type.TRANSCRIPT,
    lineHeight: Type.TRANSCRIPT_LH
  },
  basic: {
    fontSize: Type.CALLOUT,
    lineHeight: Type.CALLOUT_LH
  },
  notFound: {
    fontSize: Type.BODY,
    padding: Space.S4
  }
});
