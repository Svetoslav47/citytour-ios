/*
 * NotifierPort implementation (task A8, docs/ARCHITECTURE.md §2.7, DESIGN §3.12.3): ONE CityTour notification,
 * updated in place: "Next: Wawel Cathedral" / "240 m · ~3 min · on your left" / "5/11" while walking and,
 * in text-only mode, "You're at St Mary's Basilica" + the arrival line when the engine reaches a stop. It is the
 * glanceable surface for a locked screen; the lock-screen media card carries the audio controls, so this is the
 * only text we own there.
 *
 * iOS port (Notification Kit -> expo-notifications / UNUserNotificationCenter):
 * - Identity: the original's id 1001 (core NOTIFY_ID, still logged as id=1001) becomes the fixed request identifier
 *   NOTIFY_IDENT 'citytour-next-stop'. scheduleNotificationAsync({ identifier, trigger: null }) delivers it now and
 *   replaces a delivered one with the same identifier in place. Cancel = dismissNotificationAsync (delivered) +
 *   cancelScheduledNotificationAsync (pending).
 * - Consent: the first NOTIFY_NEXT of a tour (or Onboarding through requestEnable()) asks once per app session:
 *   getPermissionsAsync() -> requestPermissionsAsync() (iOS shows the system dialog only once per install).
 *   Refusal logs NOTIF_DENIED and the tour goes on without the notification (§9 row 16). Provisional authorization
 *   counts as granted (it delivers quietly to Notification Center).
 * - Content: core formatNotice() builds the text exactly as the original: title -> title, text -> body,
 *   additionalText -> subtitle (iOS has no separate "additional text" line; the subtitle is the nearest slot).
 * - isAlertOnce semantics: only the first publish while nothing is on screen (first of the tour, or the first after
 *   a cancel) alerts; later updates are silent. What iOS allows:
 *     * app in the background / screen locked: the alerting publish uses interruptionLevel 'active' with the default
 *       sound; silent updates use interruptionLevel 'passive' and no sound (iOS 15+: no banner, no screen wake, no
 *       sound, the Notification Center entry is just replaced). On iOS < 15 updates may show a banner again.
 *     * app in the foreground: iOS shows nothing unless the app's handler says so; setNotificationHandler (installed
 *       once by the constructor) shows the banner and plays the sound only for the alerting publish (data.alert)
 *       and keeps silent updates in the list only.
 *   The arrival haptic remains the cue for updates, as in the original.
 * - Tap: opens the app (iOS default for a notification of the app); no WantAgent equivalent is needed.
 * - Demo walk: the text starts with SIMULATED (logs src=demo). No emoji (core/notify/NotifyText sanitises).
 * - Not available on iOS: notification slots (SERVICE_INFORMATION) - lock-screen visibility is the user's iOS
 *   notification setting for the app. Every call is wrapped and never throws out.
 */
import * as Notifications from 'expo-notifications';
import { EngineSnapshot, NextNotice } from '@citytour/core';
import { NotifierPort, TourControl } from '@citytour/core';
import { Lang } from '@citytour/core';
import {
  NOTIFY_ID, NoticeKind, NotifyContext, NotifyText, ShownNotice, contextFromSnapshot, formatNotice, isTourLive,
  noticeKind, shouldRefresh, shownDistance
} from '@citytour/core';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';

/** iOS request identifier of the one CityTour notification (the original's id 1001 = core NOTIFY_ID). */
export const NOTIFY_IDENT: string = 'citytour-next-stop';

/** Notification permission state on iOS. */
function permGranted(p: Notifications.NotificationPermissionsStatus): boolean {
  if (p.granted) {
    return true;
  }
  const st = p.ios !== undefined ? p.ios.status : undefined;
  return st === Notifications.IosAuthorizationStatus.PROVISIONAL ||
    st === Notifications.IosAuthorizationStatus.EPHEMERAL ||
    st === Notifications.IosAuthorizationStatus.AUTHORIZED;
}

let handlerInstalled: boolean = false;

/**
 * Foreground presentation (isAlertOnce): the alerting publish shows a banner with sound, silent updates go to the
 * list only. Other notifications (none today) keep the iOS default of showing a banner.
 */
function installHandler(): void {
  if (handlerInstalled) {
    return;
  }
  handlerInstalled = true;
  try {
    Notifications.setNotificationHandler({
      handleNotification: (n: Notifications.Notification): Promise<Notifications.NotificationBehavior> => {
        let alert: boolean = true;
        try {
          if (n.request.identifier === NOTIFY_IDENT) {
            const data = n.request.content.data as Record<string, unknown> | null | undefined;
            alert = data !== undefined && data !== null && data['alert'] === true;
          }
        } catch (e) {
          alert = false;
        }
        const b: Notifications.NotificationBehavior = {
          shouldShowBanner: alert, shouldShowList: true, shouldPlaySound: alert, shouldSetBadge: false
        };
        return Promise.resolve(b);
      }
    });
  } catch (e) {
    Log.w(LogEvents.NOTIF_FAIL, `where=setNotificationHandler ${Log.errKv(e as Object)}`);
  }
}

enum Consent { UNKNOWN = 'unknown', GRANTED = 'granted', DENIED = 'denied' }

export class TourNotifier implements NotifierPort {
  private control: TourControl | undefined = undefined;
  private langOf: () => Lang = () => Lang.EN;
  private unsubscribe: (() => void) | undefined = undefined;
  private consent: Consent = Consent.UNKNOWN;
  private consentAsk: Promise<boolean> | undefined = undefined;
  private deniedLogged: boolean = false;
  private shown: ShownNotice | undefined = undefined;  // last successful publish, undefined = nothing on screen
  private seq: number = 0;                             // bumps on every engine notice and every cancel
  private cancelledLast: boolean = false;              // the newest seq bump was a cancel
  private inFlight: boolean = false;

  constructor() {
    installHandler();
  }

  /** Live tour context (snapshot + text language) and the snapshot stream for refreshes and the end of a tour. */
  attach(control: TourControl, langOf: () => Lang): void {
    try {
      if (this.unsubscribe !== undefined) {
        this.unsubscribe();
      }
      this.control = control;
      this.langOf = langOf;
      this.unsubscribe = control.subscribe((s: EngineSnapshot) => this.onSnapshot(s));
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=TourNotifier.attach ${Log.errKv(e as Object)}`);
    }
  }

  detach(): void {
    try {
      if (this.unsubscribe !== undefined) {
        this.unsubscribe();
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=TourNotifier.detach ${Log.errKv(e as Object)}`);
    }
    this.unsubscribe = undefined;
    this.control = undefined;
  }

  /** Once per app session at most; resolves true when notifications are allowed. Never rejects. */
  requestEnable(): Promise<boolean> {
    if (this.consent === Consent.GRANTED) {
      return Promise.resolve(true);
    }
    if (this.consent === Consent.DENIED) {
      return Promise.resolve(false);
    }
    if (this.consentAsk === undefined) {
      this.consentAsk = this.askConsent().then((ok: boolean) => {
        this.consentAsk = undefined;
        return ok;
      });
    }
    return this.consentAsk;
  }

  publishNext(notice: NextNotice): Promise<void> {
    this.seq++;
    this.cancelledLast = false;
    const mySeq: number = this.seq;
    return this.requestEnable().then((ok: boolean) => {
      if (!ok) {
        this.logDeniedOnce('publish');
        return;
      }
      if (mySeq !== this.seq) {
        return;                          // a newer notice or a cancel arrived while consent was pending
      }
      const ctx: NotifyContext | undefined = this.context();
      if (ctx === undefined || !isTourLive(ctx.phase)) {
        Log.i(LogEvents.NOTIF_PUBLISH, `id=${NOTIFY_ID} poi=${notice.poiId} skipped=tour_not_live`);
        return;
      }
      return this.publish(notice, noticeKind(notice, ctx), ctx, 'engine');
    }).catch((e: Object) => {
      Log.e(LogEvents.NOTIF_FAIL, `where=publishNext ${Log.errKv(e)}`);
    });
  }

  cancel(): Promise<void> {
    return this.cancelWhy('port');
  }

  // ---------------------------------------------------------------- internals

  private async askConsent(): Promise<boolean> {
    let canAsk: boolean = true;
    try {
      const now: Notifications.NotificationPermissionsStatus = await Notifications.getPermissionsAsync();
      if (permGranted(now)) {
        this.consent = Consent.GRANTED;
        Log.i(LogEvents.NOTIF_PERM, 'enabled=1 asked=0');
        return true;
      }
      canAsk = now.canAskAgain;
    } catch (e) {
      Log.w(LogEvents.NOTIF_PERM, `where=getPermissionsAsync ${Log.errKv(e as Object)}`);
    }
    if (!canAsk) {
      this.consent = Consent.DENIED;     // refused before: iOS does not show the dialog again
      this.deniedLogged = true;
      Log.i(LogEvents.NOTIF_DENIED, 'code=denied where=getPermissionsAsync');
      return false;
    }
    try {
      const r: Notifications.NotificationPermissionsStatus = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: false }
      });
      if (permGranted(r)) {
        this.consent = Consent.GRANTED;
        Log.i(LogEvents.NOTIF_PERM, 'enabled=1 asked=1');
        return true;
      }
      this.consent = Consent.DENIED;     // the system shows this dialog only once
      this.deniedLogged = true;
      Log.i(LogEvents.NOTIF_DENIED, `code=${r.status} where=requestPermissionsAsync`);
      return false;
    } catch (e) {
      Log.w(LogEvents.NOTIF_PERM, `enabled=0 asked=1 ${Log.errKv(e as Object)}`);
      return false;
    }
  }

  private logDeniedOnce(where: string): void {
    if (!this.deniedLogged) {
      this.deniedLogged = true;
      Log.i(LogEvents.NOTIF_DENIED, `where=${where}`);
    }
  }

  private context(): NotifyContext | undefined {
    if (this.control === undefined) {
      return undefined;
    }
    try {
      return contextFromSnapshot(this.control.current(), this.langOf());
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=TourNotifier.context ${Log.errKv(e as Object)}`);
      return undefined;
    }
  }

  private onSnapshot(s: EngineSnapshot): void {
    try {
      const ctx: NotifyContext = contextFromSnapshot(s, this.langOf());
      if (!isTourLive(ctx.phase)) {
        if (this.shown !== undefined || this.inFlight) {
          this.cancelWhy(`phase=${ctx.phase}`);
        }
        return;
      }
      const shown: ShownNotice | undefined = this.shown;
      if (shown !== undefined && !this.inFlight && this.consent === Consent.GRANTED &&
        shouldRefresh(shown, ctx, Date.now())) {
        this.publish(shown.notice, NoticeKind.NEXT, ctx, 'refresh');
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=TourNotifier.onSnapshot ${Log.errKv(e as Object)}`);
    }
  }

  private async publish(notice: NextNotice, kind: NoticeKind, ctx: NotifyContext, why: string): Promise<void> {
    const mySeq: number = this.seq;
    this.inFlight = true;
    try {
      const t: NotifyText = formatNotice(notice, kind, ctx);
      // isAlertOnce: alert only when nothing of ours is on screen yet; updates in place are silent.
      const alert: boolean = this.shown === undefined;
      const content: Notifications.NotificationContentInput = {
        title: t.title,
        body: t.text,
        subtitle: t.additionalText.length > 0 ? t.additionalText : null,
        sound: alert,
        interruptionLevel: alert ? 'active' : 'passive',
        data: { alert: alert, kind: kind, poiId: notice.poiId }
      };
      await Notifications.scheduleNotificationAsync({ identifier: NOTIFY_IDENT, content: content, trigger: null });
      if (mySeq !== this.seq) {
        if (this.cancelledLast) {        // the tour ended while this publish was on its way: take it down again
          await this.cancelWhy('late_publish');
        }
        return;
      }
      const d: number = shownDistance(notice, kind, ctx);
      this.shown = { kind: kind, notice: notice, distanceM: d, atMs: Date.now() };
      Log.i(LogEvents.NOTIF_PUBLISH, `id=${NOTIFY_ID} kind=${kind} why=${why} poi=${notice.poiId} ` +
        `d=${Number.isFinite(d) ? Math.round(d) : -1} k=${t.additionalText} src=${ctx.demo ? 'demo' : 'real'} ` +
        `lang=${ctx.lang}`);
    } catch (e) {
      if (await this.deniedNow()) {
        this.consent = Consent.DENIED;   // switched off in Settings during the tour
        Log.i(LogEvents.NOTIF_DENIED, 'code=denied where=publish');
      } else {
        Log.e(LogEvents.NOTIF_FAIL, `where=publish kind=${kind} ${Log.errKv(e as Object)}`);
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async cancelWhy(why: string): Promise<void> {
    this.seq++;
    this.cancelledLast = true;
    const had: boolean = this.shown !== undefined || why === 'late_publish';
    this.shown = undefined;
    if (!had && why !== 'shutdown') {
      return;
    }
    try {
      await Notifications.dismissNotificationAsync(NOTIFY_IDENT);
      await Notifications.cancelScheduledNotificationAsync(NOTIFY_IDENT);
      Log.i(LogEvents.NOTIF_CANCEL, `id=${NOTIFY_ID} why=${why}`);
    } catch (e) {
      Log.w(LogEvents.NOTIF_FAIL, `where=cancel why=${why} ${Log.errKv(e as Object)}`);
    }
  }

  /** AppContainer.shutdown: the notification must not outlive the app process. */
  shutdown(): Promise<void> {
    this.detach();
    return this.cancelWhy('shutdown');
  }

  /** After a failed publish: were notifications switched off in Settings? */
  private async deniedNow(): Promise<boolean> {
    try {
      return !permGranted(await Notifications.getPermissionsAsync());
    } catch (e) {
      return false;
    }
  }
}
