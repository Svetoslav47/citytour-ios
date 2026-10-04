/*
 * Demo controls sheet content (DESIGN Flow G, §3.6 SIMULATED pill): replay speed 1/2/4/8 and "Jump to next
 * stop", labelled "Demo assist". Only reachable while the Demo walk (SIMULATED source) is active.
 * Ids: segSpeed1/2/4/8, btnJumpNext.
 */
import { SymbolView } from 'expo-symbols';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useT } from '@/platform/strings';
import { Radius, Size, Space, TABULAR, Type, useColors } from '@/theme';

const SPEEDS: number[] = [1, 2, 4, 8];

export interface DemoControlsSheetProps {
  speed?: number;
  onSpeed?: (mult: number) => void;
  onJump?: () => void;
}

export function DemoControlsSheet({ speed = 4, onSpeed = () => {}, onJump = () => {} }: DemoControlsSheetProps):
  React.JSX.Element {
  const t = useT();
  const c = useColors();
  return (
    <View style={styles.root}>
      <View style={[styles.assist, { backgroundColor: c.signal_simulated_bg }]}>
        <SymbolView name="figure.walk" size={16} tintColor={c.signal_simulated_fg} />
        <Text style={[styles.overline, { color: c.signal_simulated_fg }]}>{t('label_demo_assist')}</Text>
      </View>

      <Text style={[styles.overline, { color: c.text_secondary, marginTop: Space.S2 }]}>{t('demo_speed')}</Text>

      <View style={[styles.segments, { backgroundColor: c.bg_surface_sunken }]}>
        {SPEEDS.map((x: number) => (
          <Pressable
            key={`${x}`}
            testID={`segSpeed${x}`}
            accessibilityRole="button"
            accessibilityState={{ selected: x === speed }}
            style={[styles.segment, { backgroundColor: x === speed ? c.accent : 'transparent' }]}
            onPress={() => onSpeed(x)}
          >
            <Text style={[styles.segText, TABULAR, { color: x === speed ? c.on_accent : c.text_secondary }]}>
              {`${x}×`}
            </Text>
          </Pressable>
        ))}
      </View>

      <Pressable
        testID="btnJumpNext"
        accessibilityRole="button"
        style={({ pressed }) => [styles.jump, { backgroundColor: c.accent_subtle, opacity: pressed ? 0.7 : 1 }]}
        onPress={() => onJump()}
      >
        <SymbolView name="forward.end.fill" size={18} tintColor={c.accent} />
        <Text style={[styles.jumpText, { color: c.accent }]}>{t('demo_jump_next')}</Text>
      </Pressable>

      <Text style={[styles.note, { color: c.text_secondary }]}>{t('demo_assist_note')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'flex-start',
    width: '100%',
    gap: Space.S3,
    paddingLeft: Space.S4,
    paddingRight: Space.S4,
    paddingTop: Space.S2,
    paddingBottom: Space.S6,
    borderRadius: Radius.LG
  },
  assist: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.S2,
    height: 28,
    paddingLeft: 10,
    paddingRight: 12,
    borderRadius: 14
  },
  overline: {
    fontSize: Type.CAPTION,
    fontWeight: '500',
    letterSpacing: Type.OVERLINE_SPACING,
    textTransform: 'uppercase'
  },
  segments: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    height: Size.TOUCH,
    paddingLeft: 4,
    paddingRight: 4,
    borderRadius: 24
  },
  segment: {
    flex: 1,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center'
  },
  segText: {
    fontSize: Type.CALLOUT,
    fontWeight: '500',
    textAlign: 'center'
  },
  jump: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Space.S2,
    width: '100%',
    height: Size.BUTTON_H,
    borderRadius: Size.BUTTON_H / 2,
    marginTop: Space.S2
  },
  jumpText: {
    fontSize: Type.BODY,
    fontWeight: '500'
  },
  note: {
    fontSize: Type.FOOTNOTE,
    lineHeight: Type.FOOTNOTE_LH
  }
});
