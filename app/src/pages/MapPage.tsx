/*
 * Full map (B6 P1, DESIGN §3.7, tour mode): the whole native map, interactive (pan, pinch, double-tap zoom,
 * recenter), north-up. Opened from Now Walking (menu "Full map": live walk overlay) or from Tour detail (tap the
 * map: the planned route). The SIMULATED pill shows while the Demo walk drives the dot.
 * B13 explore mode (Home "All places in {city}"): every place of the course's city as dots (PoiLayer), fitted to the
 * course map (the city's default bounds from its city.json without one); the layers button toggles the same dots on
 * the tour maps. Tapping a dot opens the place card sheet (bottom sheet, map stays interactive) -> Details -> Place
 * detail.
 * Explore "you are here": the WALK-mode position marker, live. Source (core/map/ExploreMe): a running tour's
 * snapshots (incl. the Demo walk, SIMULATED pill as in WALK mode), else the location service while the page is open
 * (only when already permitted; the locate button asks). Logs MAP_ME per state change.
 * Port of pages/MapPage.ets.
 */
import { useFocusEffect } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LayoutChangeEvent, Pressable, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSnapshot } from 'valtio';
import {
  centreOnFirstFix, chooseMeSource, EngineSnapshot, Fix, FixSource, LogEvents, MapData, mapOpenBounds, MeChoice,
  MeSource, PermissionState, Projection, worldBox
} from '@citytour/core';
import { AppContainer } from '@/app/AppContainer';
import { Log } from '@/app/Log';
import { useT } from '@/platform/strings';
import { RealLocationSource } from '@/services/location/RealLocationSource';
import { Radius, Size, Space, useColors } from '@/theme';
import { AppViewModel } from '@/viewmodel/AppViewModel';
import { MapCache, overlayBounds, userMark, walkOverlay } from '@/viewmodel/MapViewModel';
import { FloatingIconButton } from '@/views/common/FloatingIconButton';
import { SimulatedBadge } from '@/views/common/SimulatedBadge';
import { MapCanvas } from '@/views/map/MapCanvas';
import { MapOverlay } from '@/views/map/MapRenderer';
import { PlaceCardSheet } from '@/views/map/PlaceCardSheet';
import { PoiLayer } from '@/views/map/PoiLayer';

export class MapMode {
  static readonly WALK: string = 'walk';
  static readonly TOUR: string = 'tour';
  static readonly EXPLORE: string = 'explore';
}

/** Explore mode opens on the course map's bounds; without a map, on the city's default bounds (city.json). */
function cityDefaultBounds(): number[] {
  const c = AppContainer.activeCity();
  return c === undefined ? [] : worldBox(c.defaultBounds, Projection.fromOrigin(c.origin));
}

/** The city's projection (the frame of its map and places); undefined without an active city. */
function cityProjection(): Projection | undefined {
  const c = AppContainer.activeCity();
  return c === undefined ? undefined : Projection.fromOrigin(c.origin);
}

function permOk(p: PermissionState): boolean {
  return p === PermissionState.GRANTED || p === PermissionState.APPROX_ONLY;
}

export interface MapPageProps {
  mode?: string;
}

export function MapPage({ mode = MapMode.TOUR }: MapPageProps): React.JSX.Element {
  const t = useT();
  const c = useColors();
  const sa = useSafeAreaInsets();
  const app = AppViewModel.get();
  const appSnap = useSnapshot(app);

  const [map] = useState<MapData | undefined>(() => MapCache.detailMap());
  const [scene, setScene] = useState<MapOverlay>(() => new MapOverlay());
  const [bounds, setBoundsState] = useState<number[]>([]);
  const [demo, setDemo] = useState<boolean>(false);
  const [h, setH] = useState<number>(0);
  const [places, setPlaces] = useState<PoiLayer | undefined>(undefined);
  const [showPlaces, setShowPlaces] = useState<boolean>(mode === MapMode.EXPLORE);
  const [placesRev, setPlacesRev] = useState<number>(0);
  const [cardPoi, setCardPoi] = useState<string>('');
  const [showCard, setShowCard] = useState<boolean>(false);
  /** Explore "you are here" (EXPLORE mode only). */
  const [meSrc, setMeSrcState] = useState<string>(MeSource.NONE);
  const [focus, setFocus] = useState({ rev: 0, x: 0, y: 0, zoom: false });

  // Imperative fields of the ArkTS struct.
  const r = useRef({
    unsubscribe: undefined as (() => void) | undefined,
    bounds: [] as number[],
    places: undefined as PoiLayer | undefined,
    meSrc: MeSource.NONE as string,
    meX: Number.NaN,
    meY: Number.NaN,
    meFirstHandled: false,
    meLoc: undefined as RealLocationSource | undefined,
    meProj: undefined as Projection | undefined,
    meGone: false,
    demo: false
  }).current;

  const setBounds = useCallback((b: number[]): void => {
    r.bounds = b;
    setBoundsState(b);
  }, [r]);

  const setMe = useCallback((src: MeSource, reason: string): void => {
    if (r.meSrc !== src) {
      Log.i('MAP_ME', `src=${src} reason=${reason}`);
    }
    r.meSrc = src;
    setMeSrcState(src);
  }, [r]);

  const focusOn = useCallback((zoom: boolean): void => {
    setFocus((f) => ({ rev: f.rev + 1, x: r.meX, y: r.meY, zoom }));
  }, [r]);

  const onMe = useCallback((x: number, y: number, acc: number, speed: number, course: number,
    simulated: boolean): void => {
    const u = userMark(x, y, acc, speed, course, simulated);
    if (u === undefined) {
      return;
    }
    const ov = new MapOverlay();
    ov.user = u;
    setScene(ov);
    r.meX = x;
    r.meY = y;
    if (!r.meFirstHandled) {
      const centre = centreOnFirstFix(false, r.bounds, x, y);
      r.meFirstHandled = true;
      Log.i('MAP_ME', `first_fix src=${r.meSrc} centred=${centre} ` +
        `reason=${centre ? 'inside_bounds' : 'outside_bounds'}`);
      if (centre) {
        focusOn(false);
      }
    }
  }, [r, focusOn]);

  /** The location service directly (own RealLocationSource: the tour's shared one keeps its listener). start()
   * asks for the permission / switch only when they are missing, i.e. only from the locate button. */
  const startLocation = useCallback((reason: string): void => {
    r.meProj = cityProjection();
    if (r.meProj === undefined) {
      setMe(MeSource.NONE, 'no_city');
      return;
    }
    if (r.meLoc === undefined) {
      r.meLoc = new RealLocationSource(AppContainer.permissions());
    }
    const src = r.meLoc;
    src.start((f: Fix) => {
      const p = r.meProj;
      if (!r.meGone && p !== undefined) {
        setMe(MeSource.LOCATION, reason);
        onMe(p.x(f.lng), p.y(f.lat), f.accuracyM, f.speedMps, f.courseDeg, false);
      }
    }, (code: number) => {
      if (!src.isRunning()) {
        setMe(MeSource.NONE, `location_error code=${code}`);
      }
    }).then(() => {
      if (r.meGone) {
        src.stop();
      } else if (src.isRunning()) {
        setMe(MeSource.LOCATION, reason);
      }
    });
  }, [r, setMe, onMe]);

  /** Picks the position source without ever opening a system dialog (that is the locate button's job). */
  const startMe = useCallback(async (): Promise<void> => {
    try {
      const tourRunning = AppContainer.tourController().isRunning();
      let granted = false;
      let switchOn = false;
      if (!tourRunning) {
        const perms = AppContainer.permissions();
        granted = permOk(await perms.locationState());
        switchOn = granted && perms.isLocationSwitchOn();
      }
      if (r.meGone) {
        return;
      }
      const ch: MeChoice = chooseMeSource(tourRunning, granted, switchOn);
      if (ch.src === MeSource.TOUR) {
        setMe(MeSource.TOUR, ch.reason);   // before subscribe: it delivers the current snapshot at once
        r.unsubscribe = AppContainer.tourControl().subscribe((s: EngineSnapshot) => {
          r.demo = s.source === FixSource.DEMO;
          setDemo(r.demo);
          if (s.user !== undefined) {
            onMe(s.user.x, s.user.y, s.user.accuracyM, s.user.speedMps, s.user.courseDeg, r.demo);
          }
        });
      } else if (ch.src === MeSource.LOCATION) {
        startLocation(ch.reason);
      } else {
        setMe(MeSource.NONE, ch.reason);
      }
    } catch (e) {
      setMe(MeSource.NONE, 'error');
      Log.e(LogEvents.UNCAUGHT, `where=MapPage.startMe ${Log.errKv(e)}`);
    }
  }, [r, setMe, onMe, startLocation]);

  const loadPlaces = useCallback((): void => {
    if (r.places !== undefined) {
      return;
    }
    const t0 = Date.now();
    try {
      r.places = PoiLayer.of(AppContainer.packRepository().pois());
      setPlaces(r.places);
      Log.i('MAP_PLACES', `on=true pois=${r.places.size()} mode=${mode} ms=${Date.now() - t0}`);
    } catch (e) {
      r.places = undefined;
      setPlaces(undefined);
      setShowPlaces(false);
      Log.e(LogEvents.PACK_ERR, `where=MapPage.places ${Log.errKv(e)} blocking=false`);
    }
  }, [r, mode]);

  // aboutToAppear / aboutToDisappear
  useEffect(() => {
    r.meGone = false;
    if (mode === MapMode.EXPLORE) {
      loadPlaces();
      setBounds(mapOpenBounds(map?.bounds, cityDefaultBounds()));
      startMe();
    } else if (mode === MapMode.WALK) {
      try {
        r.unsubscribe = AppContainer.tourControl().subscribe((s: EngineSnapshot) => {
          const ov = walkOverlay(s, app.textLang);
          setScene(ov);
          setDemo(s.source === FixSource.DEMO);
          if (r.bounds.length === 0) {
            setBounds(overlayBounds(ov) ?? []);
          }
        });
      } catch (e) {
        Log.e(LogEvents.UNCAUGHT, `where=MapPage.subscribe ${Log.errKv(e)}`);
      }
    } else {
      const plan = app.tourPlan;
      const sc = plan.orderScene.stops.length > 0 ? plan.orderScene : plan.scene;
      setScene(sc);
      setBounds(overlayBounds(sc) ?? []);
    }
    return () => {
      r.meGone = true;
      if (r.meLoc !== undefined) {
        r.meLoc.stop();
        r.meLoc = undefined;
      }
      if (r.unsubscribe !== undefined) {
        r.unsubscribe();
        r.unsubscribe = undefined;
      }
    };
    // Runs once per page, like aboutToAppear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFocusEffect(useCallback(() => {
    Log.i(LogEvents.APP_PAGE, `page=FullMap shown mode=${mode}`);
  }, [mode]));

  /** Locate: centre on the position; without one and without a source, ask for the permission (and switch). */
  const locate = (): void => {
    if (Number.isFinite(r.meX) && Number.isFinite(r.meY)) {
      Log.i('MAP_ME', `locate src=${r.meSrc} action=centre`);
      focusOn(true);
      return;
    }
    if (r.meSrc !== MeSource.NONE) {
      Log.i('MAP_ME', `locate src=${r.meSrc} action=wait_fix`);
      return;
    }
    Log.i('MAP_ME', 'locate src=none action=request_permission');
    startLocation('locate_button');
  };

  const closeCard = (): void => {
    setShowCard(false);
    if (r.places !== undefined && r.places.selectedId !== '') {
      r.places.selectedId = '';
      setPlacesRev((v) => v + 1);
    }
  };

  const togglePlaces = (): void => {
    const on = !showPlaces;
    setShowPlaces(on);
    if (on) {
      loadPlaces();
    } else {
      closeCard();
      Log.i('MAP_PLACES', `on=false mode=${mode}`);
    }
  };

  const selectPlace = (poiId: string): void => {
    if (poiId === '') {
      return;   // a tap on the map, not on a dot: keep the card as it is
    }
    if (r.places !== undefined) {
      r.places.selectedId = poiId;
    }
    setPlacesRev((v) => v + 1);
    setCardPoi(poiId);
    setShowCard(true);
  };

  // Drag the sheet down to dismiss it (ArkUI bindSheet dragBar).
  const sheetDrag = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetY(10)
    .onEnd((e) => {
      if (e.translationY > 60 || e.velocityY > 800) {
        closeCard();
      }
    });

  const onLayout = (e: LayoutChangeEvent): void => {
    setH(e.nativeEvent.layout.height);
  };

  return (
    <GestureHandlerRootView testID="pageMap" style={[styles.page, { backgroundColor: c.map_land }]}
      onLayout={onLayout}>
      {h > 0 ? (
        <MapCanvas
          map={map}
          scene={scene}
          bounds={bounds}
          interactive={true}
          boxHeight={h}
          topInset={56 + sa.top}
          bottomInset={sa.bottom}
          mapId="mapFull"
          places={showPlaces ? places : undefined}
          placesRev={placesRev}
          focusRev={focus.rev}
          focusX={focus.x}
          focusY={focus.y}
          focusZoom={focus.zoom}
          onTapPlace={selectPlace}
        />
      ) : null}

      {/* The map is full-bleed under both system bars; the floating controls sit below the status bar. */}
      <View
        pointerEvents="box-none"
        style={[styles.topRow, {
          paddingLeft: Space.S2 + sa.left,
          paddingRight: Space.S2 + sa.right,
          paddingTop: Space.S2 + sa.top,
          height: Size.TOUCH + Space.S2 + sa.top
        }]}
      >
        <FloatingIconButton symbol="chevron.backward" label={t('a11y_back')} buttonId="btnBackMap"
          onTap={() => app.back()} />
        <View style={styles.blank} pointerEvents="none" />
        <SimulatedBadge visible={demo} />
        <FloatingIconButton
          symbol={showPlaces ? 'square.3.layers.3d.down.right' : 'square.3.layers.3d'}
          label={showPlaces ? t('map_places_hide') : t('map_places_show')}
          buttonId="btnPlaces"
          onTap={togglePlaces}
        />
      </View>

      {mode === MapMode.EXPLORE ? (
        <View
          pointerEvents="box-none"
          style={[styles.locateRow, { paddingRight: Space.S2 + sa.right, top: Size.TOUCH + Space.S2 + sa.top }]}
        >
          <FloatingIconButton
            symbol={meSrc === MeSource.NONE ? 'location' : 'location.fill'}
            label={t('map_locate_me')}
            buttonId="btnLocateMe"
            onTap={locate}
          />
        </View>
      ) : null}

      {showCard ? (
        <GestureDetector gesture={sheetDrag}>
          <View style={[styles.sheet, { backgroundColor: c.bg_canvas, paddingBottom: sa.bottom }]}>
            <View style={styles.dragBarRow}>
              <View style={[styles.dragBar, { backgroundColor: c.divider }]} />
            </View>
            <Pressable
              testID="btnSheetClose"
              accessibilityRole="button"
              accessibilityLabel={t('a11y_close')}
              onPress={closeCard}
              style={[styles.close, { backgroundColor: c.bg_surface_sunken }]}
            >
              <SymbolView name="xmark" size={16} tintColor={c.text_primary} weight="medium" />
            </Pressable>
            <View style={styles.sheetBody}>
              <PlaceCardSheet
                poiId={cardPoi}
                lang={appSnap.textLang}
                onDetails={(poiId: string) => {
                  closeCard();
                  app.openPlace(poiId);
                }}
              />
            </View>
          </View>
        </GestureDetector>
      ) : null}
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1
  },
  topRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center'
  },
  blank: {
    flex: 1
  },
  locateRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'flex-end'
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: Radius.XL,
    borderTopRightRadius: Radius.XL,
    shadowColor: '#000000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 }
  },
  dragBarRow: {
    alignItems: 'center',
    paddingTop: Space.S2,
    paddingBottom: Space.S1
  },
  dragBar: {
    width: 36,
    height: 4,
    borderRadius: 2
  },
  close: {
    position: 'absolute',
    top: Space.S4,
    right: Space.S4,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1
  },
  sheetBody: {
    paddingTop: Space.S3
  }
});
