/*
 * Pushes the home-screen "Next stop" widget (B14, DESIGN §3.13, ARCHITECTURE §2.8) from the running app.
 * Subscribes to TourControl snapshots for the app's lifetime (started in Index, like the summary recorder; it keeps
 * running in the background during a tour thanks to the background location/audio modes). core/widget/CardModel
 * decides what the card shows and when to push (events, >= 50 m distance steps, never per fix). Texts are localised
 * here in the app language (t()).
 *
 * iOS: the HarmonyOS Form Kit card (formProvider.updateForm) becomes a WidgetKit extension (app/targets/widget).
 * Each push writes the card as a JSON string into the App Group shared defaults with @bacons/apple-targets
 * ExtensionStorage, then asks WidgetKit to reload the timelines (ExtensionStorage.reloadWidget()).
 *
 *   App Group:  group.com.hackyeah.citytour.ios
 *   Key:        nextStopCard
 *   Value:      JSON string of an object whose fields are all strings (same as the HarmonyOS formBindingData):
 *     {
 *       "overline": string,        // "Next · 2/7", "Here · 2/7", the tour title, or "CityTour"
 *       "title": string,           // place name, "Tour complete" / "Tour ended", idle title
 *       "big": string,             // distance ("180 m", "1.2 km"), "5/7" at the end, '' otherwise
 *       "foot": string,            // "~3 min", "Paused", "Story at this stop", "stops heard", idle hint
 *       "demo": "0" | "1",         // "1" = SIMULATED Demo walk: the widget shows simulatedLabel
 *       "mode": "idle" | "heading" | "atStop" | "complete" | "ended",
 *       "simulatedLabel": string   // t('label_simulated') in the app language ("SIMULATED")
 *     }
 *
 * Logs: WIDGET event=push forms=1 mode= stop=k/n distM= src=demo|real (forms=0 when the write failed), or
 * event=push_fail.
 */
import type { ExtensionStorage } from '@bacons/apple-targets';
import { EngineSnapshot } from '@citytour/core';
import { Lang } from '@citytour/core';
import { AppContainer } from '../app/AppContainer';
import { Log } from '../app/Log';
import { LogEvents } from '@citytour/core';
import { t } from '../platform/strings';
import { CardMode, CardState, cardStateFor, shouldPushCard } from '@citytour/core';
import { localName } from './Format';
import { findTour, poiName } from './PackView';

/** App Group shared with the WidgetKit extension, and the key the widget reads. */
export const WIDGET_APP_GROUP: string = 'group.com.hackyeah.citytour.ios';
export const WIDGET_CARD_KEY: string = 'nextStopCard';
const WALK_MPS: number = 1.3;

type ExtensionStorageClass = typeof ExtensionStorage;

/**
 * The ExtensionStorage class, loaded lazily: the module reads the `expo` global at import time, which throws outside
 * the app (unit tests), so it is required inside the push's try/catch.
 */
function extensionStorageClass(): ExtensionStorageClass {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('@bacons/apple-targets') as { ExtensionStorage: ExtensionStorageClass }).ExtensionStorage;
}

export class WidgetBridge {
  private static unsubscribe: (() => void) | undefined = undefined;
  private static lang: () => Lang = () => Lang.EN;
  private static last: CardState | undefined = undefined;
  private static lastPushMs: number = 0;
  private static storage: ExtensionStorage | undefined = undefined;

  /** Subscribes once (Index.aboutToAppear). `lang` = the text language for tour and place names. Never throws. */
  static start(lang: () => Lang): void {
    WidgetBridge.lang = lang;
    if (WidgetBridge.unsubscribe !== undefined) {
      return;
    }
    try {
      WidgetBridge.unsubscribe =
        AppContainer.tourControl().subscribe((s: EngineSnapshot) => WidgetBridge.onSnapshot(s));
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=WidgetBridge.start ${Log.errKv(e as Object)}`);
    }
  }

  private static onSnapshot(s: EngineSnapshot): void {
    try {
      const next = cardStateFor(s);
      const now = Date.now();
      if (!shouldPushCard(WidgetBridge.last, next, WidgetBridge.lastPushMs, now)) {
        return;
      }
      WidgetBridge.last = next;
      WidgetBridge.lastPushMs = now;
      WidgetBridge.push(next);
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=WidgetBridge.onSnapshot ${Log.errKv(e as Object)}`);
    }
  }

  private static str(name: string, ...args: (string | number)[]): string {
    try {
      return t(name, ...args);
    } catch (e) {
      Log.w(LogEvents.WIDGET, `event=string_fail name=${name} ${Log.errKv(e as Object)}`);
      return '';
    }
  }

  private static distanceText(m: number): string {
    if (!Number.isFinite(m)) {
      return '';
    }
    return m >= 1000 ? WidgetBridge.str('fmt_km', (m / 1000).toFixed(1)) : WidgetBridge.str('fmt_m', Math.round(m));
  }

  /** Card texts for the state (already localised). */
  private static texts(c: CardState): Record<string, string> {
    const pack = AppContainer.packRepository();
    const lang = WidgetBridge.lang();
    const tour = findTour(pack, c.tourId);
    const tourTitle = tour === undefined ? 'CityTour' : localName(tour.titles, lang);
    const o: Record<string, string> = {
      'overline': 'CityTour', 'title': '', 'big': '', 'foot': '', 'demo': c.demo ? '1' : '0', 'mode': c.mode,
      'simulatedLabel': WidgetBridge.str('label_simulated')
    };
    switch (c.mode) {
      case CardMode.HEADING:
        o['overline'] = WidgetBridge.str('widget_next', c.stopNumber, c.totalStops);
        o['title'] = poiName(pack, c.poiId, lang);
        o['big'] = WidgetBridge.distanceText(c.distanceM);
        o['foot'] = c.paused ? WidgetBridge.str('walk_paused') : Number.isFinite(c.distanceM) ?
          `~${WidgetBridge.str('fmt_min', Math.max(1, Math.round(c.distanceM / WALK_MPS / 60)))}` : '';
        break;
      case CardMode.AT_STOP:
        o['overline'] = WidgetBridge.str('widget_here', c.stopNumber, c.totalStops);
        o['title'] = poiName(pack, c.poiId, lang);
        o['foot'] = c.paused ? WidgetBridge.str('walk_paused') : WidgetBridge.str('widget_at_stop');
        break;
      case CardMode.COMPLETE:
      case CardMode.ENDED:
        o['overline'] = tourTitle;
        o['title'] = WidgetBridge.str(c.mode === CardMode.COMPLETE ? 'walk_tour_complete' : 'walk_tour_ended');
        o['big'] = `${c.visited}/${c.totalStops}`;
        o['foot'] = WidgetBridge.str('widget_stops_heard');
        break;
      default:
        o['title'] = tour === undefined ? WidgetBridge.str('widget_idle_title') : tourTitle;
        o['foot'] = WidgetBridge.str('widget_idle_foot');
        break;
    }
    return o;
  }

  private static push(c: CardState): void {
    const src = c.demo ? 'demo' : 'real';
    let forms = 0;
    try {
      const json = JSON.stringify(WidgetBridge.texts(c));
      const Storage = extensionStorageClass();
      if (WidgetBridge.storage === undefined) {
        WidgetBridge.storage = new Storage(WIDGET_APP_GROUP);
      }
      WidgetBridge.storage.set(WIDGET_CARD_KEY, json);
      Storage.reloadWidget();
      forms = 1;
    } catch (e) {
      Log.w(LogEvents.WIDGET, `event=push_fail ${Log.errKv(e as Object)} src=${src}`);
    }
    Log.i(LogEvents.WIDGET, `event=push forms=${forms} mode=${c.mode} stop=${c.stopNumber}/${c.totalStops} ` +
      `distM=${Number.isFinite(c.distanceM) ? c.distanceM : 'nan'} src=${src}`);
  }
}
