/*
 * Native offline map (B6, ARCHITECTURE §3, DESIGN §4.7-4.8): a Skia canvas drawn by MapRenderer, no MapKit,
 * no web view. Base map: the vector layers of the map-detail.json of the active course's pack (its own map, or its
 * city's map); without one only the route and places are drawn. Modes: static fit-to-route (previews), follow the
 * user (Now Walking mini map), interactive (full map: pan, pinch, double-tap zoom, recenter). "© OpenStreetMap
 * contributors" is always shown when the base map is drawn (ODbL). Logs MAP_FRAME ms= (sampled).
 * Port of views/map/MapCanvas.ets: each frame is recorded into an SkPicture on the JS thread and handed to the
 * canvas through a shared value, so pans and pinches do not re-render React.
 *
 * Props (same names as the ArkTS @Param / @Event fields, all optional):
 *   map           MapData | undefined   base map (undefined: route and places only, no attribution)
 *   scene         MapOverlay            route legs, stop plaques, user marker, labels
 *   bounds        number[]              world box [minX, minY, maxX, maxY] to fit when not following
 *   follow        boolean               centre on scene.user at followScale (Now Walking)
 *   followScale   number = 2.2          px per metre while following
 *   interactive   boolean               pan / pinch / double-tap zoom / tap on dots, recenter button
 *   topInset, bottomInset  number       pt reserved for overlays (header, panel) when fitting / following
 *   boxHeight     number = 260          height in pt; width follows the parent
 *   mapId         string = 'map'        testID of the map box, also in MAP_FRAME lines
 *   lodScale      number = 1            multiplies the layers' minimum scale (< 1: street layers further out)
 *   places        PoiLayer | undefined  explore dots (full map), tappable when interactive
 *   placesRev     number                bump to redraw after the layer's selection changes
 *   onTapPlace    (poiId: string) => void  tap result: the dot's id, '' when no dot was hit
 *   focusRev, focusX, focusY, focusZoom  bump focusRev to centre on (focusX, focusY); focusZoom zooms in to at
 *                                        least street level (locateScale)
 */
import { Canvas, Picture, Skia, SkPicture } from '@shopify/react-native-skia';
import { SymbolView } from 'expo-symbols';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LayoutChangeEvent, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';
import { Camera, fitBounds, locateScale, MapData, pan, zoomAt } from '@citytour/core';
import { Log } from '@/main/Log';
import { useT } from '@/platform/strings';
import { useColors } from '@/theme';
import { DARK, LIGHT, MapPalette } from './MapStyle';
import { MapOverlay, MapRenderer } from './MapRenderer';
import { PoiLayer } from './PoiLayer';

const MAP_FRAME: string = 'MAP_FRAME';

const FIT_PAD: number = 28;

export interface MapCanvasProps {
  map?: MapData;
  scene?: MapOverlay;
  bounds?: number[];
  follow?: boolean;
  followScale?: number;
  interactive?: boolean;
  topInset?: number;
  bottomInset?: number;
  boxHeight?: number;
  mapId?: string;
  lodScale?: number;
  places?: PoiLayer;
  placesRev?: number;
  onTapPlace?: (poiId: string) => void;
  focusRev?: number;
  focusX?: number;
  focusY?: number;
  focusZoom?: boolean;
}

const EMPTY_SCENE: MapOverlay = new MapOverlay();
const EMPTY_BOUNDS: number[] = [];

function emptyPicture(): SkPicture {
  const rec = Skia.PictureRecorder();
  rec.beginRecording(Skia.XYWHRect(0, 0, 1, 1));
  return rec.finishRecordingAsPicture();
}

export function MapCanvas(props: MapCanvasProps): React.JSX.Element {
  const {
    map, scene = EMPTY_SCENE, bounds = EMPTY_BOUNDS, follow = false, followScale = 2.2, interactive = false,
    topInset = 0, bottomInset = 0, boxHeight = 260, mapId = 'map', lodScale = 1, places, placesRev = 0,
    focusRev = 0
  } = props;
  const t = useT();
  const c = useColors();
  const dark = useColorScheme() === 'dark';
  const [w, setW] = useState<number>(0);
  const [userMoved, setUserMovedState] = useState<boolean>(false);
  const picture = useSharedValue<SkPicture>(useMemo(() => emptyPicture(), []));

  // Imperative state (the ArkTS struct's private fields).
  const p = useRef<MapCanvasProps>(props);
  p.current = props;
  const st = useRef({
    w: 0,
    dark: false,
    userMoved: false,
    renderer: new MapRenderer(),
    cam: new Camera(0, 0, 1),
    pinchStart: new Camera(0, 0, 1),
    panLastX: 0,
    panLastY: 0,
    frames: 0,
    focusApplied: 0
  }).current;
  st.w = w;
  st.dark = dark;

  const setUserMoved = useCallback((v: boolean): void => {
    st.userMoved = v;
    setUserMovedState(v);
  }, [st]);

  const palette = (): MapPalette => (st.dark ? DARK : LIGHT);

  const draw = useCallback((fast: boolean): void => {
    const q = p.current;
    const h = q.boxHeight ?? 260;
    if (st.w <= 0) {
      return;
    }
    try {
      st.renderer.setMap(q.map, onPathsReady);
      const rec = Skia.PictureRecorder();
      const canvas = rec.beginRecording(Skia.XYWHRect(0, 0, st.w, h));
      const ms = st.renderer.draw(canvas, st.w, h, st.cam, q.scene ?? EMPTY_SCENE, palette(), fast, false,
        q.places, q.lodScale ?? 1);
      picture.value = rec.finishRecordingAsPicture();
      st.frames++;
      if (st.frames % 30 === 1 || ms > 33) {
        Log.i(MAP_FRAME, `id=${q.mapId ?? 'map'} ms=${ms} s=${st.cam.s.toFixed(2)} ` +
          `layers=${st.renderer.layerCount()} base=${st.renderer.hasBase() ? 'vector' : 'none'} fast=${fast} ` +
          `n=${st.frames}` + (q.places !== undefined ? ` dots=${q.places.shown()}/${q.places.size()}` : ''));
      }
    } catch (e) {
      Log.e(MAP_FRAME, `id=${q.mapId ?? 'map'} error ${Log.errKv(e)}`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st, picture]);

  /** A map layer finished building (incremental, off the critical frame): redraw with it. */
  const onPathsReady = useCallback((): void => {
    draw(false);
  }, [draw]);

  /** Applies a pending focus request once the canvas has a size (a request may arrive before the first layout). */
  const applyFocus = useCallback((): boolean => {
    const q = p.current;
    const rev = q.focusRev ?? 0;
    const fx = q.focusX ?? 0;
    const fy = q.focusY ?? 0;
    const h = q.boxHeight ?? 260;
    const b = q.bounds ?? EMPTY_BOUNDS;
    const top = q.topInset ?? 0;
    const bottom = q.bottomInset ?? 0;
    if (rev <= st.focusApplied || st.w <= 0 || !Number.isFinite(fx) || !Number.isFinite(fy)) {
      return false;
    }
    st.focusApplied = rev;
    if (!st.userMoved && b.length === 4) {
      // Start from the fitted scale, not the placeholder camera.
      st.cam = fitBounds(b, st.w, h, FIT_PAD, top, bottom);
    }
    // Like a pan: later scene/bounds updates keep this camera; the recenter button returns to the fit.
    setUserMoved(true);
    const s = q.focusZoom === true ? locateScale(st.cam.s) : st.cam.s;
    const band = (top - bottom) / 2;
    st.cam = new Camera(fx, fy + band / s, s);
    return true;
  }, [st, setUserMoved]);

  /** Static / follow cameras are recomputed from the inputs; a user-panned full map keeps its camera. */
  const placeCamera = useCallback((): void => {
    if (applyFocus()) {
      return;
    }
    const q = p.current;
    if (st.w <= 0 || ((q.interactive ?? false) && st.userMoved)) {
      return;
    }
    const h = q.boxHeight ?? 260;
    const top = q.topInset ?? 0;
    const bottom = q.bottomInset ?? 0;
    const u = (q.scene ?? EMPTY_SCENE).user;
    if ((q.follow ?? false) && u !== undefined) {
      const s = q.followScale ?? 2.2;
      // Keep the dot in the visible band between the insets.
      const band = (top - bottom) / 2;
      st.cam = new Camera(u.x, u.y + band / s, s);
      return;
    }
    const b = q.bounds ?? EMPTY_BOUNDS;
    if (b.length === 4) {
      st.cam = fitBounds(b, st.w, h, FIT_PAD, top, bottom);
    }
  }, [st, applyFocus]);

  // @Monitor('map', 'scene', 'bounds', 'follow', 'w', 'boxHeight', 'topInset', 'bottomInset', 'places', 'placesRev')
  useEffect(() => {
    placeCamera();
    draw(false);
  }, [map, scene, bounds, follow, w, boxHeight, topInset, bottomInset, places, placesRev, dark, placeCamera, draw]);

  // @Monitor('focusRev')
  useEffect(() => {
    if (applyFocus()) {
      draw(false);
    }
  }, [focusRev, applyFocus, draw]);

  useEffect(() => {
    const r = st.renderer;
    return () => r.release();
  }, [st]);

  const recenter = (): void => {
    setUserMoved(false);
    placeCamera();
    draw(false);
  };

  const gesture = useMemo(() => {
    const panG = Gesture.Pan()
      .runOnJS(true)
      .enabled(interactive)
      .maxPointers(1)
      .minDistance(4)
      .onStart((e) => {
        setUserMoved(true);
        st.panLastX = e.translationX;
        st.panLastY = e.translationY;
      })
      .onUpdate((e) => {
        st.cam = pan(st.cam, e.translationX - st.panLastX, e.translationY - st.panLastY);
        st.panLastX = e.translationX;
        st.panLastY = e.translationY;
        draw(true);
      })
      .onEnd(() => {
        draw(false);
      });
    const pinchG = Gesture.Pinch()
      .runOnJS(true)
      .enabled(interactive)
      .onStart(() => {
        setUserMoved(true);
        st.pinchStart = st.cam.copy();
      })
      .onUpdate((e) => {
        st.cam = zoomAt(st.pinchStart, e.scale, e.focalX, e.focalY, st.w, p.current.boxHeight ?? 260);
        draw(true);
      })
      .onEnd(() => {
        draw(false);
      });
    // Double tap zooms, a single tap picks a place dot; exclusive, double first, so a double tap never also selects.
    const doubleTap = Gesture.Tap()
      .runOnJS(true)
      .enabled(interactive)
      .numberOfTaps(2)
      .onEnd((_e, ok) => {
        if (!ok) {
          return;
        }
        const h = p.current.boxHeight ?? 260;
        setUserMoved(true);
        st.cam = zoomAt(st.cam, 2, st.w / 2, h / 2, st.w, h);
        draw(false);
      });
    const singleTap = Gesture.Tap()
      .runOnJS(true)
      .enabled(interactive)
      .numberOfTaps(1)
      .onEnd((e, ok) => {
        const q = p.current;
        if (!ok || q.places === undefined) {
          return;
        }
        q.onTapPlace?.(q.places.hit(e.x, e.y));
      });
    return Gesture.Simultaneous(Gesture.Simultaneous(panG, pinchG), Gesture.Exclusive(doubleTap, singleTap));
  }, [interactive, st, draw, setUserMoved]);

  const onLayout = (e: LayoutChangeEvent): void => {
    const nw = e.nativeEvent.layout.width;
    st.w = nw;
    setW(nw);
  };

  return (
    <GestureHandlerRootView
      testID={mapId}
      style={[styles.box, { height: boxHeight, backgroundColor: c.map_land }]}
      onLayout={onLayout}
    >
      <GestureDetector gesture={gesture}>
        <View style={StyleSheet.absoluteFill} collapsable={false}>
          <Canvas style={StyleSheet.absoluteFill}>
            <Picture picture={picture} />
          </Canvas>
        </View>
      </GestureDetector>

      {map !== undefined ? (
        <View pointerEvents="none" style={[styles.attributionWrap, { bottom: 6 + bottomInset }]}>
          <Text
            style={[styles.attribution, { color: c.text_secondary, backgroundColor: c.bg_scrim }]}
            accessibilityLabel={t('map_attribution')}
          >
            {t('map_attribution')}
          </Text>
        </View>
      ) : null}

      {interactive && userMoved ? (
        <Pressable
          testID="btnRecenter"
          accessibilityRole="button"
          accessibilityLabel={t('map_recenter')}
          onPress={recenter}
          style={[styles.recenter, { bottom: 12 + bottomInset, backgroundColor: c.bg_surface }]}
        >
          <SymbolView name="location.fill" size={20} tintColor={c.accent} />
        </Pressable>
      ) : null}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  box: {
    width: '100%',
    overflow: 'hidden'
  },
  attributionWrap: {
    position: 'absolute',
    left: 8
  },
  attribution: {
    fontSize: 10,
    paddingLeft: 6,
    paddingRight: 6,
    paddingTop: 2,
    paddingBottom: 2,
    borderRadius: 6,
    overflow: 'hidden'
  },
  recenter: {
    position: 'absolute',
    right: 12,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 }
  }
});
