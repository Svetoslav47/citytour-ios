/*
 * Schematic route preview for Home, Tour detail and Route ready: the stops (projected metres from the pack) joined
 * in walking order on the map land colour, north up, fitted to the box. No base map is drawn, so no map attribution
 * is needed here. Port of views/common/RoutePreview.ets (the polyline is drawn with Skia).
 */
import { Canvas, Path, Skia } from '@shopify/react-native-skia';
import React, { useMemo, useState } from 'react';
import { LayoutChangeEvent, StyleSheet, View } from 'react-native';
import { useT } from '@/platform/strings';
import { useColors } from '@/theme';
import { Plaque, PlaqueState } from './Plaque';

export class PreviewPoint {
  x: number;   // projected metres east of the pack origin
  y: number;   // projected metres north of the pack origin
  n: number;   // plaque number

  constructor(x: number, y: number, n: number) {
    this.x = x;
    this.y = y;
    this.n = n;
  }
}

interface ScreenPoint {
  x: number;
  y: number;
  n: number;
}

const PAD: number = 28;

export interface RoutePreviewProps {
  points?: PreviewPoint[];
  /** Fixed height in pt; the width follows the parent. */
  boxHeight?: number;
  /** Space reserved at the top for floating header controls, so no plaque hides under them. */
  topInset?: number;
  /** Space reserved at the bottom (e.g. a panel overlapping the map). */
  bottomInset?: number;
  /** Plaques bigger than this many are drawn as small dots to keep the preview readable. */
  maxPlaques?: number;
  /** Optional plaque state per point (same order); default: first = next, others upcoming. */
  states?: PlaqueState[];
  /** Optional user position (projected metres); drawn as the blue dot, hollow when simulated. */
  user?: PreviewPoint;
  userSimulated?: boolean;
}

/** Fits the first `fitCount` points (default: all) into the box and projects every point with that transform. */
function projectWith(source: PreviewPoint[], boxWidth: number, boxHeight: number, topInset: number,
  bottomInset: number, fitCount: number = -1): ScreenPoint[] {
  const out: ScreenPoint[] = [];
  const n = fitCount < 0 ? source.length : fitCount;
  if (n === 0 || boxWidth <= 0) {
    return out;
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const p = source[i];
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const usableH = Math.max(1, boxHeight - topInset - bottomInset);
  const scale = Math.min((boxWidth - 2 * PAD) / spanX, (usableH - 2 * PAD) / spanY);
  const offX = (boxWidth - spanX * scale) / 2;
  const offY = topInset + (usableH - spanY * scale) / 2;
  for (const p of source) {
    out.push({ x: offX + (p.x - minX) * scale, y: offY + (maxY - p.y) * scale, n: p.n });   // north up
  }
  return out;
}

export function RoutePreview({
  points = [], boxHeight = 260, topInset = 0, bottomInset = 0, maxPlaques = 11, states = [], user,
  userSimulated = false
}: RoutePreviewProps): React.JSX.Element {
  const t = useT();
  const c = useColors();
  const [boxWidth, setBoxWidth] = useState<number>(0);

  const stateAt = (idx: number): PlaqueState => {
    if (idx < states.length) {
      return states[idx];
    }
    return idx === 0 ? PlaqueState.NEXT : PlaqueState.UPCOMING;
  };

  const halfSize = (idx: number): number => {
    const st = stateAt(idx);
    if (st === PlaqueState.NEXT || st === PlaqueState.CURRENT) {
      return 17;
    }
    return st === PlaqueState.VISITED || st === PlaqueState.SKIPPED ? 12 : 14;
  };

  const projected = useMemo(() => projectWith(points, boxWidth, boxHeight, topInset, bottomInset),
    [points, boxWidth, boxHeight, topInset, bottomInset]);

  /** The user dot in the same transform as the stops (undefined when off-screen or unknown). */
  const userPt = useMemo((): ScreenPoint | undefined => {
    if (user === undefined || points.length === 0) {
      return undefined;
    }
    const pts = projectWith(points.concat([user]), boxWidth, boxHeight, topInset, bottomInset, points.length);
    if (pts.length !== points.length + 1) {
      return undefined;
    }
    const u = pts[pts.length - 1];
    if (u.x < 0 || u.y < 0 || u.x > boxWidth || u.y > boxHeight) {
      return undefined;
    }
    return u;
  }, [user, points, boxWidth, boxHeight, topInset, bottomInset]);

  const line = useMemo(() => {
    const p = Skia.Path.Make();
    projected.forEach((s: ScreenPoint, i: number) => {
      if (i === 0) {
        p.moveTo(s.x, s.y);
      } else {
        p.lineTo(s.x, s.y);
      }
    });
    return p;
  }, [projected]);

  const onLayout = (e: LayoutChangeEvent): void => {
    setBoxWidth(e.nativeEvent.layout.width);
  };

  return (
    <View style={[styles.box, { height: boxHeight, backgroundColor: c.map_land }]} onLayout={onLayout}>
      {boxWidth > 0 && points.length > 1 ? (
        <Canvas style={{ position: 'absolute', left: 0, top: 0, width: boxWidth, height: boxHeight }}>
          <Path path={line} style="stroke" color={c.accent} strokeWidth={4} strokeJoin="round"
            strokeCap="round" />
        </Canvas>
      ) : null}
      {projected.map((p: ScreenPoint, idx: number) =>
        points.length <= maxPlaques ? (
          <View key={`${p.n}:${Math.round(p.x)}:${Math.round(p.y)}`}
            style={{ position: 'absolute', left: p.x - halfSize(idx), top: p.y - halfSize(idx) }}>
            <Plaque n={p.n} state={stateAt(idx)} />
          </View>
        ) : (
          <View key={`${p.n}:${Math.round(p.x)}:${Math.round(p.y)}`}
            style={[styles.dot, { left: p.x - 4, top: p.y - 4, backgroundColor: c.accent }]} />
        ))}
      {userPt !== undefined ? (
        <View
          accessible={true}
          accessibilityLabel={userSimulated ? t('label_simulated_a11y') : t('map_you')}
          style={[styles.user, {
            left: userPt.x - 7,
            top: userPt.y - 7,
            backgroundColor: userSimulated ? 'transparent' : c.map_user,
            borderColor: userSimulated ? c.map_user : '#FFFFFF'
          }]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    width: '100%',
    overflow: 'hidden'
  },
  dot: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4
  },
  user: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 3,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 }
  }
});
