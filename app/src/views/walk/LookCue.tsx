/*
 * The Look cue (DESIGN §3.6.1): a 72 pt top half-arc relative to the walking direction with one accent dot at
 * the target's relative bearing (-90 left, 0 ahead, +90 right; behind -> bottom + chevron), an "up" arrow when
 * the script says to look up, and the caption in the same words as the voice. No angle -> landmark mode
 * ("Face St Mary's Basilica"). Geometry: core/map/WalkDisplay.dialDot (unit-tested).
 */
import { DialDot, dialDot } from '@citytour/core';
import { SymbolView } from 'expo-symbols';
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import { useT } from '@/platform/strings';
import { Type, useColors } from '@/theme';

const SIZE: number = 72;
const CX: number = 36;
const CY: number = 38;
const R: number = 30;
const DOT: number = 12;

/** Caption string key for the engine's direction bucket (same words as the voice). */
export function relDirCaption(relDir: string): string {
  switch (relDir) {
    case 'ahead':
      return 'dir_ahead';
    case 'aheadRight':
      return 'dir_ahead_right';
    case 'right':
      return 'dir_right';
    case 'behindRight':
      return 'dir_behind_right';
    case 'behind':
      return 'dir_behind';
    case 'behindLeft':
      return 'dir_behind_left';
    case 'left':
      return 'dir_left';
    case 'aheadLeft':
      return 'dir_ahead_left';
    default:
      return 'dir_here';
  }
}

export interface LookCueProps {
  /** Relative bearing in degrees; NaN = landmark mode. */
  angleDeg?: number;
  relDir?: string;
  lookUp?: boolean;
  landmark?: string;
  /** Approaching: the dot gets a ring. */
  emphasised?: boolean;
  /** Paused / weak GPS: dimmed. */
  dim?: boolean;
}

export function LookCue({
  angleDeg = Number.NaN, relDir = 'here', lookUp = false, landmark = '', emphasised = false, dim = false
}: LookCueProps): React.JSX.Element {
  const t = useT();
  const c = useColors();
  const dot: DialDot = dialDot(angleDeg, CX, CY, R, 22);

  // Dot position animates (200 ms, friction-like ease-out) as on the original.
  const pos = useRef(new Animated.ValueXY({ x: dot.x - DOT / 2, y: dot.y - DOT / 2 })).current;
  useEffect(() => {
    if (!dot.valid) {
      return;
    }
    Animated.timing(pos, {
      toValue: { x: dot.x - DOT / 2, y: dot.y - DOT / 2 },
      duration: 200,
      easing: Easing.bezier(0.2, 0, 0.2, 1),
      useNativeDriver: true
    }).start();
  }, [dot.x, dot.y, dot.valid, pos]);

  let content: React.JSX.Element | null = null;
  if (dot.valid) {
    content = (
      <>
        <View style={{ width: SIZE, height: SIZE - 4, opacity: dim ? 0.5 : 1 }}>
          {/* Top half of a circle = the arc. */}
          <View style={[styles.arcClip, { left: CX - R - 1.5, top: CY - R - 1.5 }]}>
            <View style={[styles.arc, { borderColor: c.divider }]} />
          </View>
          {/* "You" notch at the bottom centre. */}
          <View style={[styles.notch, { left: CX - 1.5, top: CY - 2, backgroundColor: c.text_tertiary }]} />
          {dot.behind ? (
            <View style={{ position: 'absolute', left: CX - 6, top: dot.y + 6 }}>
              <SymbolView name="chevron.down" size={12} tintColor={c.accent} />
            </View>
          ) : null}
          {lookUp ? (
            <View style={{ position: 'absolute', left: dot.x - 5, top: dot.y - 18 }}>
              <SymbolView name="arrow.up" size={10} tintColor={c.accent} />
            </View>
          ) : null}
          <Animated.View
            style={[styles.dot, {
              backgroundColor: c.accent,
              borderWidth: emphasised ? 3 : 0,
              borderColor: c.accent_subtle,
              transform: pos.getTranslateTransform()
            }]}
          />
        </View>
        <Text numberOfLines={2} style={[styles.caption, { color: c.text_secondary }]}>
          {t(relDirCaption(relDir))}
          {lookUp ? t('walk_look_up') : ''}
        </Text>
      </>
    );
  } else if (landmark !== '') {
    content = (
      <View style={styles.landmark}>
        <SymbolView name="figure.walk" size={16} tintColor={c.accent} />
        <Text numberOfLines={2} style={[styles.landmarkText, { color: c.text_secondary }]}>
          {t('walk_face', landmark)}
        </Text>
      </View>
    );
  }

  return (
    <View testID="lookCue" accessible={true} style={styles.root}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    minWidth: SIZE,
    maxWidth: 140,
    gap: 2,
    alignItems: 'center'
  },
  arcClip: {
    position: 'absolute',
    width: 2 * R + 3,
    height: R + 2,
    overflow: 'hidden'
  },
  arc: {
    width: 2 * R + 3,
    height: 2 * R + 3,
    borderRadius: R + 1.5,
    borderWidth: 3,
    backgroundColor: 'transparent'
  },
  notch: {
    position: 'absolute',
    width: 3,
    height: 8,
    borderRadius: 1.5
  },
  dot: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2
  },
  caption: {
    fontSize: Type.CAPTION,
    lineHeight: Type.CAPTION_LH,
    fontWeight: '500',
    textAlign: 'center'
  },
  landmark: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  landmarkText: {
    flexShrink: 1,
    fontSize: Type.CAPTION,
    fontWeight: '500'
  }
});
