/*
 * Small ArkUI stand-ins shared by the Home, Courses, Tour detail and Route ready screens: the Capsule button
 * (ButtonType.Capsule NORMAL / TEXTUAL / EMPHASIZED), the linear Progress bar and the Progress ring.
 */
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import React from 'react';
import { Pressable, StyleProp, Text, View, ViewStyle } from 'react-native';
import { Space, Type } from '@/theme';

/** ArkUI ProgressType.Ring: a 28 pt ring, accent arc over the divider track. */
export function ProgressRing({ pct, size, stroke, color, track }: {
  pct: number; size: number; stroke: number; color: string; track: string;
}): React.JSX.Element {
  const r = (size - stroke) / 2;
  const oval = { x: stroke / 2, y: stroke / 2, width: 2 * r, height: 2 * r };
  const trackPath = Skia.Path.Make();
  trackPath.addCircle(size / 2, size / 2, r);
  const arc = Skia.Path.Make();
  arc.addArc(oval, -90, 360 * Math.max(0, Math.min(100, pct)) / 100);
  return (
    <Canvas style={{ width: size, height: size }}>
      <Path path={trackPath} style="stroke" strokeWidth={stroke} color={track} />
      <Path path={arc} style="stroke" strokeWidth={stroke} strokeCap="round" color={color} />
    </Canvas>
  );
}

/** ArkUI Progress (Linear, strokeWidth 4). */
export function LinearProgress({ pct, color, track, label }: {
  pct: number; color: string; track: string; label: string;
}): React.JSX.Element {
  return (
    <View
      accessible={true}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      style={{ width: '100%', height: 4, borderRadius: 2, backgroundColor: track, overflow: 'hidden' }}
    >
      <View style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: 4, borderRadius: 2, backgroundColor: color }} />
    </View>
  );
}

/** Capsule button (ArkUI Button ButtonType.Capsule): NORMAL / TEXTUAL / EMPHASIZED differ only in colours here. */
export function Capsule({ id, label, a11y, height, color, bg, onPress, disabled = false, style, children }: {
  id: string; label?: string; a11y?: string; height: number; color: string; bg?: string; onPress: () => void;
  disabled?: boolean; style?: StyleProp<ViewStyle>; children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={a11y ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [{
        height,
        borderRadius: height / 2,
        paddingHorizontal: Space.S4,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: bg ?? 'transparent',
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1
      }, style]}
    >
      {children ?? <Text style={{ fontSize: Type.CALLOUT, fontWeight: '500', color }}>{label}</Text>}
    </Pressable>
  );
}
