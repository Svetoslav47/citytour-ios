/*
 * Keep the screen on during a tour (§9 row 14): the original's AppContainer.keepScreenOn
 * (window.setWindowKeepScreenOn on the last window). iOS port: expo-keep-awake
 * (UIApplication.isIdleTimerDisabled) under the tag KEEP_SCREEN_TAG, so other keep-awake users are not affected.
 * Never throws; logs `SETTINGS keepScreenOn=<on> ok=1` on success like the original.
 */
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { LogEvents } from '@citytour/core';
import { Log } from '../../app/Log';

export const KEEP_SCREEN_TAG: string = 'citytour-tour';

export function keepScreenOn(on: boolean): void {
  try {
    const p: Promise<void> = on ? activateKeepAwakeAsync(KEEP_SCREEN_TAG) : deactivateKeepAwake(KEEP_SCREEN_TAG);
    p.then(() => {
      Log.i(LogEvents.SETTINGS, `keepScreenOn=${on} ok=1`);
    }).catch((e: unknown) => {
      Log.w(LogEvents.UNCAUGHT, `where=AppContainer.keepScreenOn on=${on} ${Log.errKv(e)}`);
    });
  } catch (e) {
    Log.w(LogEvents.UNCAUGHT, `where=AppContainer.keepScreenOn on=${on} ${Log.errKv(e)}`);
  }
}
