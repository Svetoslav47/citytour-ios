/*
 * "How it works" HUD (task B12, docs/DESIGN.md §3.6 HUD block, docs/OPPORTUNITIES.md §3.2): a translucent card over
 * the Now Walking map that shows every platform capability live, one row each: location source (Core Location or
 * the SIMULATED Demo walk), course/speed, next stop + bearing, trigger radii, route (off-route / turn cue), voice,
 * lock-screen media session, background mode, server. Rows come from the pure, unit-tested core/hud/HudRows; every
 * value is read from the EngineSnapshot (or "n/a"). Toggled from the Now Walking ⋯ menu; the on/off state lives
 * for the app session (a module-level valtio proxy, the AppStorageV2 'hud' key on HarmonyOS).
 * Ids: hudHowItWorks, hudRow_<key>.
 */
import {
  EngineSnapshot, HudInput, HudRow, HudTone, hudRows, LogEvents, Poi, Tour, TourConfig, TourStop, TriggerRadii,
  triggerRadii
} from '@citytour/core';
import { SymbolView } from 'expo-symbols';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { proxy } from 'valtio';
import { AppContainer } from '@/app/AppContainer';
import { Log } from '@/app/Log';
import { useT } from '@/platform/strings';
import { Palette, Radius, Space, TABULAR, Type, useColors } from '@/theme';
import { findTour, safePoi } from '@/viewmodel/PackView';

const LABEL_W: number = 78;

/** HUD visibility for the app session (DESIGN: "remembers its state per session"). */
export class HudPrefs {
  visible: boolean = false;

  private static inst: HudPrefs | undefined = undefined;

  /** The one shared (valtio proxy) instance; read it with useSnapshot. */
  static get(): HudPrefs {
    if (HudPrefs.inst === undefined) {
      HudPrefs.inst = proxy(new HudPrefs());
    }
    return HudPrefs.inst;
  }
}

/** The next stop's trigger radii as the engine builds them (pack + the tour options' TourConfig); undefined if unknown. */
function nextTrigger(snap: EngineSnapshot | undefined): TriggerRadii | undefined {
  if (snap === undefined || snap.next === undefined) {
    return undefined;
  }
  try {
    const pack = AppContainer.packRepository();
    const poiId: string = snap.next.poiId;
    const poi: Poi | undefined = safePoi(pack, poiId);
    const tour: Tour | undefined = findTour(pack, snap.tourId);
    const stop: TourStop | undefined = tour === undefined ? undefined :
      tour.stops.find((s: TourStop) => s.poiId === poiId);
    const cfg: TourConfig | undefined = AppContainer.tourController().options().config;
    return triggerRadii(stop, poi, cfg !== undefined ? cfg : new TourConfig());
  } catch (e) {
    Log.e(LogEvents.UNCAUGHT, `where=HowItWorksHud.nextTrigger ${Log.errKv(e)}`);
    return undefined;
  }
}

/** Builds the HUD rows for one snapshot; never throws (all rows "n/a" on error). */
export function hudRowsFor(snap: EngineSnapshot | undefined, nextName: string, demoSpeed: number): HudRow[] {
  let server: string | undefined = undefined;
  try {
    server = AppContainer.remoteVoice().hudText();
  } catch {
    server = undefined;
  }
  const input: HudInput = {
    snap: snap, nextName: nextName, demoSpeed: demoSpeed, trigger: nextTrigger(snap), server: server
  };
  try {
    return hudRows(input);
  } catch (e) {
    Log.e(LogEvents.UNCAUGHT, `where=HowItWorksHud.rows ${Log.errKv(e)}`);
    const none: HudInput = { snap: undefined, nextName: '', demoSpeed: Number.NaN, trigger: undefined };
    return hudRows(none);
  }
}

function toneColor(tone: HudTone, c: Palette): string {
  switch (tone) {
    case HudTone.OK:
      return c.accent;
    case HudTone.WARN:
    case HudTone.SIM:
      return c.signal_simulated_fg;
    case HudTone.OFF:
      return c.signal_error;
    default:
      return c.text_tertiary;
  }
}

export interface HowItWorksHudProps {
  rows?: HudRow[];
}

export function HowItWorksHud({ rows = [] }: HowItWorksHudProps): React.JSX.Element {
  const t = useT();
  const c = useColors();
  return (
    <View testID="hudHowItWorks" style={[styles.card, { backgroundColor: c.bg_scrim }]}>
      <View style={styles.head}>
        <SymbolView name="info.circle" size={14} tintColor={c.text_secondary} />
        <Text style={[styles.title, { color: c.text_secondary }]}>{t('hud_title')}</Text>
        <Text style={[styles.caption, { color: c.text_tertiary }]}>{t('hud_live')}</Text>
      </View>

      {rows.map((r: HudRow) => (
        <View
          key={r.key}
          testID={`hudRow_${r.key}`}
          accessible={true}
          accessibilityLabel={`${r.label}: ${r.value}`}
          style={styles.row}
        >
          <View style={[styles.dot, { backgroundColor: toneColor(r.tone, c) }]} />
          <Text numberOfLines={1} style={[styles.label, { color: c.text_secondary }]}>{r.label}</Text>
          <Text numberOfLines={2} style={[styles.value, TABULAR, { color: c.text_primary }]}>{r.value}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    maxWidth: 480,
    gap: Space.S1,
    paddingLeft: Space.S3,
    paddingRight: Space.S3,
    paddingTop: Space.S2,
    paddingBottom: Space.S3,
    borderRadius: Radius.MD,
    shadowColor: '#000000',
    shadowOpacity: 0.1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 }
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Space.S2,
    width: '100%',
    marginBottom: 2
  },
  title: {
    flex: 1,
    fontSize: Type.CAPTION,
    lineHeight: Type.CAPTION_LH,
    fontWeight: '500',
    letterSpacing: Type.OVERLINE_SPACING
  },
  caption: {
    fontSize: Type.CAPTION,
    lineHeight: Type.CAPTION_LH
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.S2,
    width: '100%'
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginTop: 5
  },
  label: {
    width: LABEL_W,
    fontSize: Type.CAPTION,
    lineHeight: Type.CAPTION_LH,
    fontWeight: '500'
  },
  value: {
    flex: 1,
    fontSize: Type.CAPTION,
    lineHeight: Type.CAPTION_LH
  }
});
