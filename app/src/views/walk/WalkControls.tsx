/*
 * Replay 56 pt · Play/Pause 72 pt (accent) · Skip 56 pt (DESIGN §3.6 controls). No haptic on tap.
 * Ids: btnReplay, btnPlayPause, btnSkip.
 */
import { SFSymbol, SymbolView } from 'expo-symbols';
import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useT } from '@/platform/strings';
import { useColors } from '@/theme';

export interface WalkControlsProps {
  paused?: boolean;
  active?: boolean;
  onReplay?: () => void;
  onToggle?: () => void;
  onSkip?: () => void;
}

export function WalkControls({
  paused = false, active = true, onReplay = () => {}, onToggle = () => {}, onSkip = () => {}
}: WalkControlsProps): React.JSX.Element {
  const t = useT();
  const c = useColors();

  const side = (symbol: SFSymbol, label: string, id: string, action: () => void): React.JSX.Element => (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !active }}
      disabled={!active}
      style={({ pressed }) => [styles.side, {
        backgroundColor: c.bg_surface_sunken, opacity: !active ? 0.4 : pressed ? 0.7 : 1
      }]}
      onPress={() => action()}
    >
      <SymbolView name={symbol} size={24} tintColor={c.text_primary} />
    </Pressable>
  );

  return (
    <View style={styles.row}>
      {side('arrow.counterclockwise', t('walk_replay'), 'btnReplay', onReplay)}
      <Pressable
        testID="btnPlayPause"
        accessibilityRole="button"
        accessibilityLabel={paused ? t('walk_play') : t('walk_pause')}
        accessibilityState={{ disabled: !active }}
        disabled={!active}
        style={({ pressed }) => [styles.main, {
          backgroundColor: c.accent, opacity: !active ? 0.4 : pressed ? 0.8 : 1
        }]}
        onPress={() => onToggle()}
      >
        <SymbolView name={paused ? 'play.fill' : 'pause.fill'} size={32} tintColor={c.on_accent} />
      </Pressable>
      {side('forward.end.fill', t('walk_skip'), 'btnSkip', onSkip)}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 28,
    width: '100%'
  },
  side: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center'
  },
  main: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: 'center',
    justifyContent: 'center'
  }
});
