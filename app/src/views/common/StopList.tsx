/*
 * The tour's stop list (DESIGN §3.3 "STOPS"): plaque, a 2 pt connector between plaques, name and story length.
 * Rows are plain data built by the view model.
 */
import { SymbolView } from 'expo-symbols';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useT } from '@/platform/strings';
import { Radius, Size, Space, TABULAR, Type, useColors } from '@/theme';
import { Plaque, PlaqueState } from './Plaque';

export class StopRow {
  order: number;        // 1-based position in the shown order
  poiId: string;
  name: string;         // already localised; '' = unknown (shown as "Stop N")
  storyMin: number;     // estimated story length, 0 = unknown
  state: PlaqueState;

  constructor(order: number, poiId: string, name: string, storyMin: number, state: PlaqueState) {
    this.order = order;
    this.poiId = poiId;
    this.name = name;
    this.storyMin = storyMin;
    this.state = state;
  }
}

export interface StopListProps {
  rows?: readonly StopRow[];
  tappable?: boolean;
  onTapStop?: (poiId: string) => void;
}

export function StopList({ rows = [], tappable = false, onTapStop = () => {} }: StopListProps):
  React.JSX.Element {
  const t = useT();
  const c = useColors();
  const connector = (visible: boolean): React.JSX.Element => (
    <View style={{ width: 2, flex: 1, backgroundColor: visible ? c.divider : 'transparent' }} />
  );
  return (
    <View style={[styles.list, { backgroundColor: c.bg_surface }]}>
      {rows.map((row: StopRow, idx: number) => (
        <Pressable
          key={`${row.order}:${row.poiId}:${row.state}`}
          style={styles.row}
          accessible={true}
          accessibilityRole={tappable ? 'button' : undefined}
          accessibilityLabel={row.name !== '' ? t('tour_stop_a11y', row.order, row.name) :
            t('fmt_stop_of', row.order, rows.length)}
          onPress={() => {
            if (tappable) {
              onTapStop(row.poiId);
            }
          }}
        >
          <View style={styles.plaqueCol}>
            <View style={styles.connectors}>
              {connector(idx > 0)}
              {connector(idx < rows.length - 1)}
            </View>
            <Plaque n={row.order} state={row.state} />
          </View>

          {row.name !== '' ? (
            <Text
              style={[styles.name, { color: c.text_primary }]}
              numberOfLines={2}
              ellipsizeMode="tail"
            >
              {row.name}
            </Text>
          ) : (
            <Text style={[styles.name, { color: c.text_secondary }]}>
              {t('fmt_stop_of', row.order, rows.length)}
            </Text>
          )}

          {row.storyMin > 0 ? (
            <Text style={[styles.min, TABULAR, { color: c.text_secondary }]}>
              {t('tour_story_min', row.storyMin)}
            </Text>
          ) : null}
          {tappable ? <SymbolView name="chevron.right" size={16} tintColor={c.text_tertiary} /> : null}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: {
    width: '100%',
    paddingTop: Space.S1,
    paddingBottom: Space.S1,
    borderRadius: Radius.LG
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    width: '100%',
    height: Size.TOUCH,
    paddingLeft: 10,
    paddingRight: 12
  },
  plaqueCol: {
    width: 34,
    height: Size.TOUCH,
    alignItems: 'center',
    justifyContent: 'center'
  },
  connectors: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center'
  },
  name: {
    flex: 1,
    fontSize: Type.BODY,
    lineHeight: Type.BODY_LH
  },
  min: {
    fontSize: Type.FOOTNOTE,
    lineHeight: Type.FOOTNOTE_LH
  }
});
