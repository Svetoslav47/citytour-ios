/*
 * PermissionPort implementation (task A5, docs/ARCHITECTURE.md §2.3 and §9 rows 1-3).
 * Location permission (precise vs approximate), the re-request after a denial and the system location switch.
 *
 * iOS port (abilityAccessCtrl + geoLocationManager -> expo-location + Settings):
 *   - state: Location.getForegroundPermissionsAsync(): status 'granted' -> GRANTED or APPROX_ONLY, 'denied' ->
 *     DENIED, 'undetermined' -> UNKNOWN (never asked yet).
 *   - precise vs approximate: iOS 14+ lets the user switch "Precise Location" off (CLAccuracyAuthorization
 *     .reducedAccuracy). expo-location ~19 does not expose it (its iOS permission response only has `ios.scope`),
 *     so the service reads `ios.accuracy` ('full' | 'reduced') when a future expo-location provides it and otherwise
 *     infers it from the real fixes: RealLocationSource reports every fix's accuracy through noteFixAccuracy();
 *     reduced-accuracy fixes are kilometres wide (>= REDUCED_ACCURACY_M), precise ones are not. Before the first
 *     fix a granted permission reads GRANTED. The PERM_APPROX_ONLY issue is raised on the first real fix, which is
 *     when the original's controller checks it too (TourController.checkFirstRealFix).
 *   - request: Location.requestForegroundPermissionsAsync() ("While Using the App"; the iOS dialog carries the
 *     "Precise: On/Off" toggle). After a denial iOS no longer shows it (canAskAgain = false) -> DENIED.
 *   - openLocationSettings (the original's requestPermissionOnSetting): Linking.openSettings() opens this app's page
 *     in iOS Settings; the state is re-read when the app is active again (or after SETTINGS_WAIT_MS).
 *     Note: iOS terminates the app when the user revokes a privacy permission in Settings.
 *   - location switch: Location.hasServicesEnabledAsync() is async on iOS but isLocationSwitchOn() is sync in the
 *     port, so the value is cached and refreshed on construction and on every locationState()/request call.
 *     requestLocationSwitch (the original's requestGlobalSwitch sheet): iOS has no in-app sheet and apps may not
 *     deep-link to Privacy > Location Services, so it opens this app's Settings page and returns the re-checked
 *     value when the user comes back.
 * Never throws: every platform call is wrapped; failures are logged and reported as a state.
 */
import { AppState, AppStateStatus, Linking, NativeEventSubscription } from 'react-native';
import * as Location from 'expo-location';
import { PermissionPort, PermissionState } from '@citytour/core';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';

/** Fixes at least this wide come from iOS "Precise Location: Off" (reduced accuracy, ~1-10 km). */
export const REDUCED_ACCURACY_M: number = 1000;
/** openLocationSettings / requestLocationSwitch: stop waiting for the user to come back after this long. */
export const SETTINGS_WAIT_MS: number = 5 * 60 * 1000;

/** Resolves when the app is active again after leaving for Settings (or after `maxMs`). Never rejects. */
function waitForReturn(maxMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let left: boolean = false;
    let sub: NativeEventSubscription | undefined = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const done = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (sub !== undefined) {
        sub.remove();
        sub = undefined;
      }
      resolve();
    };
    try {
      sub = AppState.addEventListener('change', (s: AppStateStatus) => {
        if (s !== 'active') {
          left = true;
        } else if (left) {
          done();
        }
      });
      timer = setTimeout(done, maxMs);
    } catch (e) {
      done();
    }
  });
}

export class PermissionService implements PermissionPort {
  private lastState: PermissionState = PermissionState.UNKNOWN;
  private servicesOn: boolean = true;   // optimistic until the first hasServicesEnabledAsync() answers
  /** Inferred from real fixes (see the header); undefined = no fix seen yet. */
  private reducedHint: boolean | undefined = undefined;

  constructor() {
    this.refreshServices();
  }

  /** Last state seen by any call (for the HUD / DevPanel). */
  last(): PermissionState {
    return this.lastState;
  }

  /** GRANTED (precise), APPROX_ONLY, DENIED (asked and refused), UNKNOWN (never asked or not readable). */
  async locationState(): Promise<PermissionState> {
    await this.refreshServices();
    return this.readState();
  }

  /** The system dialog (approximate/precise in one request). After a denial it no longer appears. */
  async requestLocation(): Promise<PermissionState> {
    await this.refreshServices();
    const before = await this.readState();
    if (before === PermissionState.GRANTED) {
      return before;
    }
    try {
      const r: Location.LocationPermissionResponse = await Location.requestForegroundPermissionsAsync();
      const s = this.stateFrom(r);
      const scope = r.ios !== undefined ? r.ios.scope : '?';
      Log.i(LogEvents.SETTINGS, `perm_request results=${JSON.stringify([r.status, scope])}` +
        ` dialogShown=${before === PermissionState.UNKNOWN} state=${s}`);
      return this.report(s, 'request');
    } catch (e) {
      Log.e(LogEvents.PERM_DENIED, `perm=LOCATION where=requestForegroundPermissionsAsync ${Log.errKv(e)}`);
      return this.report(await this.readState(), 'request_error');
    }
  }

  /** Second chance after a denial: this app's page in iOS Settings, then the state as the user left it. */
  async openLocationSettings(): Promise<PermissionState> {
    const now = await this.readState();
    if (now === PermissionState.GRANTED) {
      return now;
    }
    try {
      const back = waitForReturn(SETTINGS_WAIT_MS);
      await Linking.openSettings();
      await back;
      await this.refreshServices();
      const s = await this.readState();
      Log.i(LogEvents.SETTINGS, `perm_on_setting list=${now === PermissionState.APPROX_ONLY ? 1 : 2} result=${s}`);
      return this.report(s, 'on_setting');
    } catch (e) {
      Log.w(LogEvents.PERM_DENIED, `perm=LOCATION where=openSettings ${Log.errKv(e)}`);
      return this.report(await this.readState(), 'on_setting_error');
    }
  }

  /** Cached Location Services switch (refreshed by locationState()/requestLocation()/requestLocationSwitch()). */
  isLocationSwitchOn(): boolean {
    return this.servicesOn;
  }

  /** Location Services off: opens Settings and returns the re-checked switch when the user comes back. */
  async requestLocationSwitch(): Promise<boolean> {
    if (await this.refreshServices()) {
      return true;
    }
    Log.w(LogEvents.LOC_SWITCH_OFF, 'action=openSettings');
    try {
      const back = waitForReturn(SETTINGS_WAIT_MS);
      await Linking.openSettings();
      await back;
      const enabled = await this.refreshServices();
      Log.i(LogEvents.SETTINGS, `loc_switch openSettings=true enabled=${enabled}`);
      if (!enabled) {
        Log.w(LogEvents.LOC_SWITCH_OFF, 'result=still_off');
      }
      return enabled;
    } catch (e) {
      Log.e(LogEvents.LOC_SWITCH_OFF, `where=openSettings ${Log.errKv(e)}`);
      return false;
    }
  }

  /**
   * RealLocationSource reports each real fix's horizontal accuracy: with expo-location ~19 this is the only way to
   * tell iOS "Precise Location: Off" (see the header).
   */
  noteFixAccuracy(accuracyM: number): void {
    if (!Number.isFinite(accuracyM) || accuracyM <= 0) {
      return;
    }
    const reduced = accuracyM >= REDUCED_ACCURACY_M;
    if (reduced !== this.reducedHint) {
      this.reducedHint = reduced;
      Log.i(LogEvents.SETTINGS, `perm_accuracy inferred=${reduced ? 'reduced' : 'full'} acc=${Math.round(accuracyM)}`);
      if (this.lastState === PermissionState.GRANTED || this.lastState === PermissionState.APPROX_ONLY) {
        this.lastState = reduced ? PermissionState.APPROX_ONLY : PermissionState.GRANTED;
      }
    }
  }

  private async refreshServices(): Promise<boolean> {
    try {
      this.servicesOn = await Location.hasServicesEnabledAsync();
    } catch (e) {
      Log.e(LogEvents.LOC_UNAVAILABLE, `where=hasServicesEnabledAsync ${Log.errKv(e)}`);
      this.servicesOn = false;
    }
    return this.servicesOn;
  }

  private async readState(): Promise<PermissionState> {
    try {
      const r: Location.LocationPermissionResponse = await Location.getForegroundPermissionsAsync();
      if (r.status === Location.PermissionStatus.GRANTED || r.granted) {
        this.lastState = this.grantedState(r);
      } else if (r.status === Location.PermissionStatus.DENIED) {
        this.lastState = PermissionState.DENIED;
      } else {
        this.lastState = PermissionState.UNKNOWN;   // UNDETERMINED: never asked yet
      }
    } catch (e) {
      Log.w(LogEvents.UNCAUGHT, `where=getForegroundPermissionsAsync ${Log.errKv(e)}`);
      this.lastState = PermissionState.UNKNOWN;
    }
    return this.lastState;
  }

  /** GRANTED vs APPROX_ONLY for a granted response: ios.accuracy when present, else the fix-based hint. */
  private grantedState(r: Location.LocationPermissionResponse): PermissionState {
    const ios = r.ios as { accuracy?: unknown } | undefined;
    const acc = ios !== undefined ? ios.accuracy : undefined;
    if (acc === 'reduced') {
      return PermissionState.APPROX_ONLY;
    }
    if (acc === 'full') {
      return PermissionState.GRANTED;
    }
    return this.reducedHint === true ? PermissionState.APPROX_ONLY : PermissionState.GRANTED;
  }

  private stateFrom(r: Location.LocationPermissionResponse): PermissionState {
    if (r.status === Location.PermissionStatus.GRANTED || r.granted) {
      return this.grantedState(r);
    }
    return PermissionState.DENIED;
  }

  private report(s: PermissionState, where: string): PermissionState {
    this.lastState = s;
    if (s === PermissionState.DENIED) {
      Log.e(LogEvents.PERM_DENIED, `perm=LOCATION where=${where}`);
    } else if (s === PermissionState.APPROX_ONLY) {
      Log.w(LogEvents.PERM_APPROX_ONLY, `where=${where}`);
    }
    return s;
  }
}
