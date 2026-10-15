/*
 * "Where to look" box for tour stops (DESIGN §3.8): the reviewed view hint (look up / ahead / down + the
 * feature). Directions relative to the visitor ("on your left") are never stored: they come from the walking
 * course at runtime, so this box only says what to look for.
 */
import { LookDir } from '@citytour/core';
import { SymbolView } from 'expo-symbols';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useT } from '@/platform/strings';
import { Radius, Space, Type, useColors } from '@/theme';

export interface LookBoxProps {
  look?: LookDir;
  feature?: string;
}

function lookKey(look: LookDir): string {
  if (look === LookDir.UP) {
    return 'place_look_up';
  }
  if (look === LookDir.DOWN) {
    return 'place_look_down';
  }
  return 'place_look_level';
}

export function LookBox({ look = LookDir.LEVEL, feature = '' }: LookBoxProps): React.JSX.Element {
  const t = useT();
  const c = useColors();
  return (
    <View testID="boxLook" accessible={true} style={[styles.box, { backgroundColor: c.accent_subtle }]}>
      <View style={styles.head}>
        <SymbolView name="eye" size={14} tintColor={c.accent} />
        <Text style={[styles.overline, { color: c.accent }]}>{t('place_look')}</Text>
        <View style={styles.blank} />
        {look === LookDir.UP ? <SymbolView name="arrow.up" size={18} tintColor={c.accent} /> : null}
      </View>
      <Text style={[styles.body, { color: c.text_primary }]}>
        {t(lookKey(look))}
        {feature !== '' ? `: ${feature}` : ''}
        .
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    alignItems: 'flex-start',
    width: '100%',
    gap: 6,
    padding: Space.S4,
    borderRadius: Radius.LG
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    width: '100%'
  },
  overline: {
    fontSize: Type.CAPTION,
    fontWeight: '500',
    letterSpacing: Type.OVERLINE_SPACING,
    textTransform: 'uppercase'
  },
  blank: {
    flex: 1
  },
  body: {
    fontSize: 17,
    lineHeight: 25
  }
});
