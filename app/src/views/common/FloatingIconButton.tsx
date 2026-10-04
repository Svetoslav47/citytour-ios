/*
 * 40 pt circular icon button that floats over the map (back, expand, attribution), with a 48 pt hit area and
 * the scrim material (DESIGN §4.5: blur only on the floating functional layer).
 */
import { SymbolView, SFSymbol } from 'expo-symbols';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useT } from '@/platform/strings';
import { Size, useColors } from '@/theme';

export interface FloatingIconButtonProps {
  /** SF Symbol name (the original took a sys.symbol resource; default chevron_backward). */
  symbol?: SFSymbol;
  /** Accessibility label (default: the a11y_back string). */
  label?: string;
  buttonId?: string;
  diameter?: number;
  onTap?: () => void;
}

export function FloatingIconButton({
  symbol = 'chevron.backward', label, buttonId = '', diameter = Size.ICON_BUTTON, onTap = () => {}
}: FloatingIconButtonProps): React.JSX.Element {
  const t = useT();
  const c = useColors();
  return (
    <Pressable
      testID={buttonId !== '' ? buttonId : undefined}
      style={styles.hit}
      accessibilityRole="button"
      accessibilityLabel={label ?? t('a11y_back')}
      onPress={() => onTap()}
    >
      <View
        style={[styles.disc, {
          width: diameter,
          height: diameter,
          borderRadius: diameter / 2,
          backgroundColor: c.bg_scrim
        }]}
      >
        <SymbolView
          name={symbol}
          size={diameter >= 40 ? 20 : 16}
          tintColor={c.text_primary}
          weight="medium"
        />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hit: {
    width: Size.TOUCH,
    height: Size.TOUCH,
    alignItems: 'center',
    justifyContent: 'center'
  },
  disc: {
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 }
  }
});
