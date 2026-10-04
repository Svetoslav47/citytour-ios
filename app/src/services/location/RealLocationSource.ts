/*
 * Real GPS (task A5, docs/ARCHITECTURE.md §2.3 and §5).
 *
 * iOS port (Location Kit on('locationChange') -> expo-location watchPositionAsync over CLLocationManager):
 *   - watchPositionAsync({ accuracy: BestForNavigation, distanceInterval: 0, timeInterval: 1000 }) = the original's
 *     ContinuousLocationRequest { interval: 1, locationScenario: NAVIGATION } (timeInterval is Android-only; iOS
 *     delivers every CoreLocation update, about 1 Hz while moving);
 *   - before subscribing: permission (PermissionPort.requestLocation) and Location Services
 *     (hasServicesEnabledAsync -> Settings), exactly as the original;
 *   - LocationObject -> Fix: CoreLocation reports -1 for an invalid speed/course, mapped to NaN; course is ignored
 *     below REAL_MIN_COURSE_SPEED_MPS as in the original; iOS has no course accuracy in expo-location -> NaN;
 *     provider 1 (CoreLocation fused fix; the original passed the Location Kit sourceType);
 *   - errors: expo-location ends the stream on any CoreLocation failure (didFailWithError), so the source re-checks
 *     permission and Location Services to name the cause and reports the original's codes to onError:
 *     ERR_PERMISSION (-2, = core LOC_ERR_PERMISSION), ERR_SWITCH_OFF (-4, = core LOC_ERR_SWITCH_OFF), otherwise
 *     ERR_DEFAULT (-1, LOC_UNAVAILABLE in core) and a re-subscribe after RESUBSCRIBE_MS (the original stayed
 *     subscribed through transient errors). A failure to subscribe at all reports CODE_SERVICE_UNAVAILABLE.
 *   - background: the foreground watch is suspended with the JS thread when the app is backgrounded. The
 *     BackgroundRunner (app/src/services/background/BackgroundRunner.ts) runs Location.startLocationUpdatesAsync in
 *     a TaskManager task and forwards its fixes here: HOOK acceptBackgroundLocation(l) / acceptBackgroundFix(fix).
 *     Duplicates of the foreground watch are harmless (core FixFilter drops non-increasing timestamps).
 *   - each fix's accuracy also goes to PermissionService.noteFixAccuracy() (precise vs reduced accuracy inference).
 * Never throws; start() always resolves and reports failures through onError (and isRunning() stays false).
 */
import * as Location from 'expo-location';
import { Fix, FixListener, FixSource, LocationErrorListener, LocationSource, PermissionPort, PermissionState }
  from '@citytour/core';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';
import { PermissionService } from './PermissionService';

/** Course from the platform is unreliable below this speed (ARCHITECTURE §5). */
export const REAL_MIN_COURSE_SPEED_MPS: number = 0.3;
/** LOC_FIX log rate limit (ARCHITECTURE §10). */
export const LOC_FIX_LOG_EVERY_MS: number = 5000;
/** onError codes (the original's LocationError values, ARCHITECTURE §2.3; core TourController LOC_ERR_*). */
export const ERR_DEFAULT: number = -1;
export const ERR_PERMISSION: number = -2;
export const ERR_SWITCH_OFF: number = -4;
/** Original exception codes of on(); kept so core's locationErrorIssue() maps them the same way. */
export const CODE_SWITCH_OFF: number = 3301100;
export const CODE_SERVICE_UNAVAILABLE: number = 3301000;
export const CODE_NOT_SUPPORTED: number = 801;
/** iOS: after a transient CoreLocation error the stream is gone; subscribe again after this delay. */
export const RESUBSCRIBE_MS: number = 3000;
/** Provider id of an iOS fix (CoreLocation fuses GPS, Wi-Fi and cell; no per-fix source type). */
export const PROVIDER_CORE_LOCATION: number = 1;

function num(v: number | null | undefined): number {
  return v !== undefined && v !== null && typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
}

/** expo-location -> contracts Fix (pure mapping, exported for reuse by the background task). */
export function locationToFix(l: Location.LocationObject): Fix {
  const c = l.coords;
  const rawSpeed = num(c.speed);
  const speed = Number.isFinite(rawSpeed) && rawSpeed >= 0 ? rawSpeed : Number.NaN;
  const rawDir = num(c.heading);
  const dir = Number.isFinite(rawDir) && rawDir >= 0 ? rawDir : Number.NaN;
  const courseValid = Number.isFinite(speed) && speed >= REAL_MIN_COURSE_SPEED_MPS && Number.isFinite(dir);
  const acc = num(c.accuracy);
  const ts = num(l.timestamp);
  const f: Fix = {
    lat: c.latitude,
    lng: c.longitude,
    accuracyM: Number.isFinite(acc) && acc >= 0 ? acc : Number.NaN,
    speedMps: speed,
    courseDeg: courseValid ? dir : Number.NaN,
    courseAccuracyDeg: Number.NaN,
    timestampMs: Number.isFinite(ts) && ts > 0 ? ts : Date.now(),
    provider: PROVIDER_CORE_LOCATION,
    source: FixSource.REAL
  };
  return f;
}

function fmt(v: number, digits: number): string {
  return Number.isFinite(v) ? v.toFixed(digits) : 'nan';
}

export class RealLocationSource implements LocationSource {
  readonly kind: FixSource = FixSource.REAL;
  private readonly perms: PermissionPort;
  private running: boolean = false;
  private starting: boolean = false;
  private onFix: FixListener | undefined = undefined;
  private onError: LocationErrorListener | undefined = undefined;
  private count: number = 0;
  private lastLogMs: number = 0;
  private lastAcc: number = Number.NaN;
  private lastFixMs: number = 0;
  private lastErr: string = '';
  private sub: Location.LocationSubscription | undefined = undefined;
  private subGen: number = 0;   // bumps on every (re)subscribe and stop: late callbacks of an old watch are dropped
  private retryTimer: ReturnType<typeof setTimeout> | undefined = undefined;

  constructor(perms: PermissionPort) {
    this.perms = perms;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Last real accuracy (m), NaN before the first fix: PlatformStatus.realGpsAccuracyM. */
  lastAccuracyM(): number {
    return this.lastAcc;
  }

  fixCount(): number {
    return this.count;
  }

  lastFixAtMs(): number {
    return this.lastFixMs;
  }

  /** Short reason of the last failure, '' if none (DevPanel / HUD). */
  lastError(): string {
    return this.lastErr;
  }

  async start(onFix: FixListener, onError: LocationErrorListener): Promise<void> {
    this.onFix = onFix;
    this.onError = onError;
    if (this.running || this.starting) {
      return;
    }
    this.starting = true;
    this.lastErr = '';
    try {
      // 1. Permission (system dialog the first time; a denial is reported, Settings is the caller's next step).
      let state = await this.perms.locationState();
      if (state !== PermissionState.GRANTED && state !== PermissionState.APPROX_ONLY) {
        state = await this.perms.requestLocation();
      }
      if (state !== PermissionState.GRANTED && state !== PermissionState.APPROX_ONLY) {
        this.fail(ERR_PERMISSION, `permission ${state}`);
        return;
      }
      if (state === PermissionState.APPROX_ONLY) {
        // §9 row 2: approximate fixes still move the dot; the engine disables triggers.
        Log.w(LogEvents.PERM_APPROX_ONLY, 'src=real action=continue_approximate');
      }
      // 2. Location Services switch (locationState() refreshed the cached value).
      if (!this.perms.isLocationSwitchOn()) {
        Log.w(LogEvents.LOC_SWITCH_OFF, 'src=real action=request');
        const on = await this.perms.requestLocationSwitch();
        if (!on) {
          this.fail(ERR_SWITCH_OFF, 'location switch off');
          return;
        }
      }
      // 3. Subscribe.
      await this.subscribe();
    } catch (e) {
      this.fail(ERR_DEFAULT, `start threw ${Log.errKv(e)}`);
    } finally {
      this.starting = false;
    }
  }

  stop(): void {
    this.clearRetry();
    const was = this.running;
    this.running = false;
    this.unsubscribe('stop');   // also invalidates a watch that is still being set up
    if (!was) {
      return;
    }
    Log.i(LogEvents.LOC_SOURCE, `kind=real state=stop fixes=${this.count}`);
  }

  /**
   * HOOK for BackgroundRunner: a fix from the background location task (Location.startLocationUpdatesAsync) while
   * the app is backgrounded. Ignored unless this source is running (a tour on real GPS).
   */
  acceptBackgroundLocation(l: Location.LocationObject): void {
    if (!this.running) {
      return;
    }
    try {
      this.handleFix(locationToFix(l), 'bg');
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=RealLocationSource.acceptBackgroundLocation ${Log.errKv(e)}`);
    }
  }

  /** HOOK for BackgroundRunner: same as acceptBackgroundLocation for an already mapped Fix. */
  acceptBackgroundFix(fix: Fix): void {
    if (!this.running) {
      return;
    }
    this.handleFix(fix, 'bg');
  }

  private async subscribe(): Promise<void> {
    const gen = ++this.subGen;
    try {
      const sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, distanceInterval: 0, timeInterval: 1000 },
        (l: Location.LocationObject) => {
          if (gen === this.subGen) {
            this.handleLocation(l);
          }
        },
        (reason: string) => {
          if (gen === this.subGen) {
            this.handleLocationError(reason);
          }
        });
      if (gen !== this.subGen) {
        sub.remove();   // stopped while subscribing
        return;
      }
      this.sub = sub;
      this.running = true;
      this.lastLogMs = 0;
      Log.i(LogEvents.LOC_SOURCE, 'kind=real state=start scenario=NAVIGATION interval=1');
    } catch (e) {
      const code = await this.classify(CODE_SERVICE_UNAVAILABLE);
      if (code === ERR_SWITCH_OFF) {
        Log.w(LogEvents.LOC_SWITCH_OFF, `src=real code=${code}`);
      } else if (code === CODE_SERVICE_UNAVAILABLE) {
        Log.e(LogEvents.LOC_UNAVAILABLE, `src=real code=${code}`);
      }
      this.fail(code, `watchPositionAsync ${Log.errKv(e)}`);
    }
  }

  private unsubscribe(where: string): void {
    this.subGen++;
    const s = this.sub;
    this.sub = undefined;
    if (s === undefined) {
      return;
    }
    try {
      s.remove();
    } catch (e) {
      Log.w(LogEvents.LOC_ERR, `src=real where=${where}_remove ${Log.errKv(e)}`);
    }
  }

  /** Names the cause of a CoreLocation failure from the current permission and Location Services state. */
  private async classify(fallback: number): Promise<number> {
    try {
      const st = await this.perms.locationState();   // also refreshes the Location Services cache
      if (st !== PermissionState.GRANTED && st !== PermissionState.APPROX_ONLY) {
        return ERR_PERMISSION;
      }
      if (!this.perms.isLocationSwitchOn()) {
        return ERR_SWITCH_OFF;
      }
    } catch (e) {
      // keep the fallback
    }
    return fallback;
  }

  private handleLocation(l: Location.LocationObject): void {
    try {
      this.handleFix(locationToFix(l), 'fg');
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=RealLocationSource.onLocation ${Log.errKv(e)}`);
    }
  }

  private handleFix(f: Fix, via: string): void {
    try {
      this.count++;
      this.lastAcc = f.accuracyM;
      this.lastFixMs = Date.now();
      if (this.perms instanceof PermissionService) {
        this.perms.noteFixAccuracy(f.accuracyM);
      }
      const now = Date.now();
      if (now - this.lastLogMs >= LOC_FIX_LOG_EVERY_MS) {
        this.lastLogMs = now;
        // Real coordinates rounded to 4 decimals (~10 m), ARCHITECTURE §10.
        Log.i(LogEvents.LOC_FIX, `src=real lat=${fmt(f.lat, 4)} lng=${fmt(f.lng, 4)} acc=${fmt(f.accuracyM, 1)}` +
          ` spd=${fmt(f.speedMps, 2)} crs=${fmt(f.courseDeg, 0)} prov=${f.provider} n=${this.count}` +
          (via === 'bg' ? ' via=bg' : ''));
      }
      if (this.onFix !== undefined) {
        this.onFix(f);
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=RealLocationSource.onLocation ${Log.errKv(e)}`);
    }
  }

  /** expo-location ended the watch with a CoreLocation failure (`reason` is its message). */
  private handleLocationError(reason: string): void {
    this.unsubscribe('error');
    this.classify(ERR_DEFAULT).then((c: number) => {
      if (!this.running) {
        return;   // stopped meanwhile
      }
      Log.w(LogEvents.LOC_ERR, `src=real code=${c} reason=${reason}`);
      if (c === ERR_SWITCH_OFF) {
        Log.w(LogEvents.LOC_SWITCH_OFF, `src=real code=${c}`);
      } else if (c === ERR_PERMISSION) {
        Log.e(LogEvents.PERM_DENIED, `perm=LOCATION src=real code=${c}`);
      }
      this.lastErr = `locationError ${c}`;
      try {
        if (this.onError !== undefined) {
          this.onError(c, `locationError ${c}`);
        }
      } catch (e) {
        Log.e(LogEvents.UNCAUGHT, `where=RealLocationSource.onLocationError ${Log.errKv(e)}`);
      }
      if (c === ERR_DEFAULT) {
        this.scheduleResubscribe();   // transient (e.g. kCLErrorLocationUnknown): keep trying like the original
      } else {
        this.running = false;         // permission / switch: the caller offers Settings or the Demo walk
      }
    }).catch((e: unknown) => {
      Log.e(LogEvents.UNCAUGHT, `where=RealLocationSource.onLocationError ${Log.errKv(e)}`);
    });
  }

  private scheduleResubscribe(): void {
    this.clearRetry();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.running && this.sub === undefined) {
        Log.i(LogEvents.LOC_SOURCE, 'kind=real state=resubscribe');
        this.subscribe();
      }
    }, RESUBSCRIBE_MS);
  }

  private clearRetry(): void {
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  private fail(code: number, msg: string): void {
    this.running = false;
    this.lastErr = `${code} ${msg}`;
    Log.e(LogEvents.LOC_ERR, `src=real code=${code} msg=${msg}`);
    try {
      if (this.onError !== undefined) {
        this.onError(code, msg);
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=RealLocationSource.fail ${Log.errKv(e)}`);
    }
  }
}
