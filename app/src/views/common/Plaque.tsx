/*
 * Numbered stop marker ("plaque"), inspired by Kraków's numbered street plaques (DESIGN §4.7).
 * Visual sizes per state; callers give the 48 pt hit area.
 */
import { SymbolView } from 'expo-symbols';
import React from 'react';
import { Text, View } from 'react-native';
import { TABULAR, useColors } from '@/theme';

export enum PlaqueState { UPCOMING = 'upcoming', NEXT = 'next', CURRENT = 'current', VISITED = 'visited',
  SKIPPED = 'skipped', NEUTRAL = 'neutral' }

export interface PlaqueProps {
  n?: number;
  state?: PlaqueState;
}

function diameterOf(state: PlaqueState): number {
  if (state === PlaqueState.NEXT || state === PlaqueState.CURRENT) {
    return 34;
  }
  if (state === PlaqueState.VISITED || state === PlaqueState.SKIPPED) {
    return 24;
  }
  return 28;
}

export function Plaque({ n = 1, state = PlaqueState.UPCOMING }: PlaqueProps): React.JSX.Element {
  const c = useColors();
  const d = diameterOf(state);
  const filled = state === PlaqueState.NEXT || state === PlaqueState.CURRENT;
  const textColor = filled ? c.on_accent :
    state === PlaqueState.UPCOMING ? c.accent :
      state === PlaqueState.NEUTRAL ? c.text_primary : c.text_tertiary;
  return (
    <View
      style={{
        width: d,
        height: d,
        borderRadius: d / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: filled ? c.accent : state === PlaqueState.VISITED ? c.text_tertiary : c.bg_surface,
        borderWidth: filled ? 3 : state === PlaqueState.VISITED ? 0 : state === PlaqueState.UPCOMING ? 2 : 1.5,
        borderColor: filled ? c.bg_surface : state === PlaqueState.UPCOMING ? c.accent : c.text_tertiary,
        borderStyle: state === PlaqueState.SKIPPED ? 'dashed' : 'solid'
      }}
    >
      {state === PlaqueState.VISITED ? (
        <SymbolView name="checkmark" size={14} weight="bold" tintColor={c.bg_surface} />
      ) : (
        <Text
          allowFontScaling={false}
          style={[TABULAR, { fontSize: filled ? 13 : 12, fontWeight: '700', color: textColor }]}
        >
          {`${n}`}
        </Text>
      )}
    </View>
  );
}
