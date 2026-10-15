/*
 * The amber SIMULATED pill (DESIGN §3.6, §4.1 signal.simulated). Shown on every surface while the Demo walk
 * (or any other simulated input) is active. Amber means simulated or warning, never brand.
 */
import { SymbolView } from 'expo-symbols';
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useT } from '@/platform/strings';
import { Type, useColors } from '@/theme';

export interface SimulatedBadgeProps {
  /** When false nothing is rendered, so callers can bind it straight to `snapshot.source === DEMO`. */
  visible?: boolean;
  /** Optional: tapping opens the Demo controls sheet (B5). */
  tappable?: boolean;
  onTap?: () => void;
}

export function SimulatedBadge({ visible = true, tappable = false, onTap = () => {} }: SimulatedBadgeProps):
  React.JSX.Element | null {
  const t = useT();
  const c = useColors();
  if (!visible) {
    return null;
  }
  return (
    <Pressable
      testID="badgeSimulated"
      style={[styles.pill, { backgroundColor: c.signal_simulated_bg }]}
      accessible={true}
      accessibilityRole={tappable ? 'button' : 'text'}
      accessibilityLabel={tappable ? t('label_demo_walk_a11y') : t('label_simulated_a11y')}
      onPress={() => {
        if (tappable) {
          onTap();
        }
      }}
    >
      <SymbolView name="figure.walk" size={14} tintColor={c.signal_simulated_fg} />
      <Text style={[styles.label, { color: c.signal_simulated_fg }]}>{t('label_simulated')}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 28,
    paddingLeft: 10,
    paddingRight: 12,
    borderRadius: 14
  },
  label: {
    fontSize: Type.CAPTION,
    lineHeight: Type.CAPTION_LH,
    fontWeight: '500',
    letterSpacing: Type.OVERLINE_SPACING
  }
});
