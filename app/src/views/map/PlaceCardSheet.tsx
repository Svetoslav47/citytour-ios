/*
 * Place card (B13, DESIGN §3.7): the sheet content shown when a place dot is tapped on the full map. Kind,
 * name, distance from you (only when the tour knows where you are), a 2-line teaser and
 * Details -> Place detail. Text comes from PlaceViewModel (validated pack narration, fallback chain of B3).
 * Port of views/map/PlaceCardSheet.ets (content only; MapPage hosts it in the bottom sheet).
 */
import React, { useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Lang } from '@citytour/core';
import { AppContainer } from '@/main/AppContainer';
import { Log } from '@/main/Log';
import { kindLabel } from '@/pages/PlaceDetailPage';
import { useT } from '@/platform/strings';
import { Size, Space, Type, useColors } from '@/theme';
import { distanceRes } from '@/viewmodel/Format';
import { PlaceViewModel } from '@/viewmodel/PlaceViewModel';

const MAP_PLACE: string = 'MAP_PLACE';

export interface PlaceCardSheetProps {
  poiId?: string;
  lang?: Lang;
  onDetails?: (poiId: string) => void;
}

interface Loaded {
  vm: PlaceViewModel;
  distM: number;
}

function load(poiId: string, lang: Lang): Loaded {
  const vm = new PlaceViewModel();
  let distM = Number.NaN;
  if (poiId === '') {
    return { vm, distM };
  }
  vm.load(poiId, lang);
  try {
    const u = AppContainer.tourControl().current().user;
    const p = AppContainer.packRepository().poi(poiId);
    if (u !== undefined && p !== undefined && Number.isFinite(u.x) && Number.isFinite(u.y)) {
      distM = Math.hypot(p.x - u.x, p.y - u.y);
    }
  } catch {
    distM = Number.NaN;
  }
  return { vm, distM };
}

export function PlaceCardSheet({ poiId = '', lang = Lang.EN, onDetails = () => {} }: PlaceCardSheetProps):
  React.JSX.Element {
  const t = useT();
  const c = useColors();
  const { vm, distM } = useMemo(() => load(poiId, lang), [poiId, lang]);

  useEffect(() => {
    if (poiId === '') {
      return;
    }
    Log.i(MAP_PLACE, `poi=${poiId} found=${vm.found} tier=${vm.tier} ` +
      `distM=${Number.isFinite(distM) ? Math.round(distM) : 'none'}`);
  }, [poiId, vm, distM]);

  return (
    <View style={styles.col}>
      {!vm.found ? (
        <Text style={{ fontSize: Type.BODY, color: c.text_secondary }}>{t('place_not_found')}</Text>
      ) : (
        <>
          <View style={styles.row}>
            <Text style={[styles.callout, { color: c.text_secondary }]}>{kindLabel(vm.kind)}</Text>
            {Number.isFinite(distM) ? (
              <>
                <Text style={[styles.callout, { color: c.text_tertiary }]}>·</Text>
                <Text style={[styles.callout, { color: c.text_secondary }]}>{distanceRes(distM)}</Text>
              </>
            ) : null}
          </View>

          <Text testID="placeCardName" numberOfLines={2} style={[styles.name, { color: c.text_primary }]}>
            {vm.name}
          </Text>

          {vm.paragraphs.length > 0 ? (
            <Text numberOfLines={2} style={[styles.teaser, { color: c.text_secondary }]}>{vm.paragraphs[0]}</Text>
          ) : null}

          <Pressable
            testID="btnPlaceDetails"
            accessibilityRole="button"
            onPress={() => onDetails(poiId)}
            style={({ pressed }) => [styles.button, { backgroundColor: c.accent, opacity: pressed ? 0.85 : 1 }]}
          >
            <Text style={[styles.buttonText, { color: c.on_accent }]}>{t('place_card_details')}</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  col: {
    width: '100%',
    alignItems: 'flex-start',
    gap: Space.S2,
    paddingLeft: Space.S4,
    paddingRight: Space.S4,
    paddingTop: Space.S2,
    paddingBottom: Space.S4
  },
  row: {
    flexDirection: 'row',
    gap: Space.S2
  },
  callout: {
    fontSize: Type.CALLOUT
  },
  name: {
    fontSize: Type.TITLE3,
    lineHeight: Type.TITLE3_LH,
    fontWeight: '500'
  },
  teaser: {
    fontSize: Type.CALLOUT,
    lineHeight: Type.CALLOUT_LH
  },
  button: {
    height: Size.BUTTON_H,
    width: '100%',
    marginTop: Space.S2,
    borderRadius: Size.BUTTON_H / 2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  buttonText: {
    fontSize: Type.BODY,
    fontWeight: '500'
  }
});
