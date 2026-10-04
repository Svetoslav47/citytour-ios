/*
 * BackgroundPort implementation (docs/ARCHITECTURE.md §2.4, task A6).
 *
 * iOS port: the HarmonyOS continuous task ['location','audioPlayback'] maps to
 *   - UIBackgroundModes 'audio' (app.json) + the .playback audio session (ClipPlayer.warmUp): the guide keeps talking
 *     with the screen locked, nothing to start here;
 *   - UIBackgroundModes 'location' (app.json) + background location updates started here with
 *     expo-location startLocationUpdatesAsync on the TaskManager task BG_LOCATION_TASK ('citytour-bg-location'),
 *     defined at module scope (expo-task-manager requires defineTask in the global scope of the bundle). The task
 *     feeds every background fix to subscribeBackgroundFixes() listeners (RealLocationSource consumes them).
 * start() asks for the "Always" location permission first (requestBackgroundPermissionsAsync). Refused, failed or
 * thrown -> BG_FAIL and false (ARCHITECTURE §9 row 14: the tour continues in the foreground); it never crashes.
 * iOS has no "continuous task cancelled/suspended" callbacks. The closest signal is an error delivered to the
 * location task (e.g. the permission revoked in Settings): it is logged BG_SUSPEND reason=LOCATION_ERROR and passed
 * to the listener's onSuspended(). The stopAudio hook still runs before every stop, as on HarmonyOS.
 * Every platform call is wrapped in try/catch; failures log BG_FAIL.
 */
import * as Location from 'expo-location';
import type { LocationObject } from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { BackgroundListener, BackgroundPort } from '@citytour/core';
import { AppConfig } from '../../app/AppConfig';
import { Log } from '../../app/Log';
import { LogEvents } from '@citytour/core';

export const BG_MODES: string[] = ['location', 'audio'];
export const BG_LOCATION_TASK: string = 'citytour-bg-location';

// ---------- background fix stream (module scope: the task may run before any React tree exists) ----------

export type BackgroundFixListener = (loc: LocationObject) => void;
export type BackgroundErrorListener = (code: string, message: string) => void;

const fixListeners: Set<BackgroundFixListener> = new Set<BackgroundFixListener>();
const errorListeners: Set<BackgroundErrorListener> = new Set<BackgroundErrorListener>();

/**
 * Every fix delivered by the background location task, in order. Returns the unsubscribe function.
 * Fixes arrive while the app is in the background AND in the foreground (the task keeps running until stop()).
 */
export function subscribeBackgroundFixes(l: BackgroundFixListener): () => void {
  fixListeners.add(l);
  return () => {
    fixListeners.delete(l);
  };
}

function subscribeBackgroundErrors(l: BackgroundErrorListener): () => void {
  errorListeners.add(l);
  return () => {
    errorListeners.delete(l);
  };
}

interface LocationTaskData {
  locations?: LocationObject[];
}

try {
  if (!TaskManager.isTaskDefined(BG_LOCATION_TASK)) {
    TaskManager.defineTask<LocationTaskData>(BG_LOCATION_TASK, async (body: TaskManager.TaskManagerTaskBody<LocationTaskData>) => {
      try {
        if (body.error !== null && body.error !== undefined) {
          const code = String(body.error.code);
          const msg = body.error.message;
          Log.w(LogEvents.BG_FAIL, `where=task code=${code} msg=${msg}`);
          errorListeners.forEach((l: BackgroundErrorListener) => {
            try {
              l(code, msg);
            } catch (e) {
              Log.e(LogEvents.UNCAUGHT, `where=BackgroundRunner.errorListener ${Log.errKv(e)}`);
            }
          });
          return;
        }
        const locs: LocationObject[] = body.data !== undefined && body.data !== null &&
          Array.isArray(body.data.locations) ? body.data.locations : [];
        for (const loc of locs) {
          fixListeners.forEach((l: BackgroundFixListener) => {
            try {
              l(loc);
            } catch (e) {
              Log.e(LogEvents.UNCAUGHT, `where=BackgroundRunner.fixListener ${Log.errKv(e)}`);
            }
          });
        }
      } catch (e) {
        Log.e(LogEvents.UNCAUGHT, `where=BackgroundRunner.task ${Log.errKv(e)}`);
      }
    });
  }
} catch (e) {
  Log.e(LogEvents.BG_FAIL, `where=defineTask ${Log.errKv(e)}`);
}

// ---------- BackgroundPort ----------

function errCode(e: unknown): string {
  if (e === undefined || e === null) {
    return '-1';
  }
  const c = (e as { code?: unknown }).code;
  return c !== undefined && c !== null ? String(c) : '-1';
}

export class BackgroundRunner implements BackgroundPort {
  private readonly stopAudio: () => void;
  private listener: BackgroundListener | undefined = undefined;
  private running: boolean = false;
  private starting: Promise<boolean> | undefined = undefined;
  private lastIssue: string = '';
  private unsubErrors: (() => void) | undefined = undefined;

  /** stopAudio runs before every stop (the continuous-task rule of the original, kept). */
  constructor(stopAudio: () => void) {
    this.stopAudio = stopAudio;
  }

  setListener(l: BackgroundListener): void {
    this.listener = l;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Last suspend/failure as "BG_xxx k=v", '' if none. For the DevPanel and the HUD. */
  lastIssueLine(): string {
    return this.lastIssue;
  }

  start(): Promise<boolean> {
    if (this.running) {
      return Promise.resolve(true);
    }
    if (this.starting !== undefined) {
      return this.starting;
    }
    const p = this.doStart().catch((e: unknown) => {
      this.fail('start', e);
      return false;
    });
    this.starting = p;
    p.then(() => {
      this.starting = undefined;
    }).catch(() => {
      this.starting = undefined;
    });
    return p;
  }

  private async doStart(): Promise<boolean> {
    if (AppConfig.DEBUG_FAIL_BG_START) {
      // §9 row 14 demo: behave as if the system refused background running.
      this.fail('startBackgroundRunning', { code: -99, message: 'simulated src=debug (AppConfig.DEBUG_FAIL_BG_START)' });
      return false;
    }
    try {
      const perm = await Location.requestBackgroundPermissionsAsync();
      if (!perm.granted) {
        Log.w(LogEvents.BG_FAIL, `where=requestBackgroundPermissions code=${perm.status} msg=always_not_granted`);
        this.lastIssue = `BG_FAIL where=permission code=${perm.status}`;
        return false;
      }
    } catch (e) {
      this.fail('requestBackgroundPermissions', e);
      return false;
    }
    try {
      if (await Location.hasStartedLocationUpdatesAsync(BG_LOCATION_TASK)) {
        // Still running from before (e.g. a JS reload): count it as success, like 9800005 on HarmonyOS.
        this.running = true;
        this.watchErrors();
        Log.w(LogEvents.BG_START, `modes=${BG_MODES.join(',')} already=1 id=${BG_LOCATION_TASK}`);
        return true;
      }
    } catch (e) {
      Log.w(LogEvents.BG_FAIL, `where=hasStartedLocationUpdates ${Log.errKv(e)}`);
    }
    try {
      await Location.startLocationUpdatesAsync(BG_LOCATION_TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        timeInterval: 1000,
        distanceInterval: 0,
        activityType: Location.ActivityType.Fitness,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true
      });
      this.running = true;
      this.lastIssue = '';
      this.watchErrors();
      Log.i(LogEvents.BG_START, `modes=${BG_MODES.join(',')} id=${BG_LOCATION_TASK} notif=-1`);
      return true;
    } catch (e) {
      this.fail('startLocationUpdates', e);
      return false;
    }
  }

  async stop(): Promise<void> {
    this.safeStopAudio('stop');
    const wasRunning = this.running;
    this.running = false;
    this.unwatchErrors();
    try {
      if (await Location.hasStartedLocationUpdatesAsync(BG_LOCATION_TASK)) {
        await Location.stopLocationUpdatesAsync(BG_LOCATION_TASK);
      }
      Log.i(LogEvents.BG_STOP, `ok=1 id=${BG_LOCATION_TASK} wasRunning=${wasRunning ? 1 : 0}`);
    } catch (e) {
      // Stopping when nothing runs is harmless; log it and carry on.
      Log.w(LogEvents.BG_STOP, `ok=0 ${Log.errKv(e)}`);
    }
  }

  private watchErrors(): void {
    if (this.unsubErrors !== undefined) {
      return;
    }
    this.unsubErrors = subscribeBackgroundErrors((code: string, msg: string) => this.handleSuspend(code, msg));
  }

  private unwatchErrors(): void {
    const u = this.unsubErrors;
    this.unsubErrors = undefined;
    if (u !== undefined) {
      u();
    }
  }

  /** An error from the location task (e.g. permission revoked): the closest iOS signal to a suspended task. */
  private handleSuspend(code: string, msg: string): void {
    try {
      const reason = 'LOCATION_ERROR';
      Log.w(LogEvents.BG_SUSPEND, `reason=${reason} suspended=1 id=${BG_LOCATION_TASK} code=${code} msg=${msg}`);
      this.lastIssue = `BG_SUSPEND reason=${reason} suspended=1`;
      if (this.running && this.listener !== undefined) {
        this.listener.onSuspended(reason);
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=BackgroundRunner.suspend ${Log.errKv(e)}`);
    }
  }

  private safeStopAudio(why: string): void {
    try {
      this.stopAudio();
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=BackgroundRunner.stopAudio why=${why} ${Log.errKv(e)}`);
    }
  }

  private fail(where: string, e: unknown): void {
    Log.e(LogEvents.BG_FAIL, `where=${where} ${Log.errKv(e)}`);
    this.lastIssue = `BG_FAIL where=${where} code=${errCode(e)}`;
  }
}
