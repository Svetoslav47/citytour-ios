/*
 * Safe areas (issue #63, DESIGN §3 + §4.5). Every screen is laid out edge to edge, so backgrounds and the map
 * surfaces reach under the status bar and the home indicator, and every screen pads its content and controls by
 * the insets held here. One central source of truth:
 * - SafeAreaSync (SafeAreaSync.tsx, mounted once inside the SafeAreaProvider of the root layout) reads the insets
 *   from react-native-safe-area-context and writes them into SafeArea on every change (rotation, split view).
 * - SafeArea is a valtio proxy singleton (the port of the AppStorageV2 'safeArea' object), so pages that read it
 *   with useSnapshot(SafeArea.get()) re-layout when the insets change.
 * On HarmonyOS SafeAreaWatcher read window.getWindowAvoidArea and converted px to vp; React Native insets are
 * already in points.
 */
import { proxy } from 'valtio';
import { Log } from '../app/Log';
import { LogEvents } from '@citytour/core';

/** Current safe-area insets of the main window, in points. 0 when there is nothing to avoid on that edge. */
export class SafeArea {
  /** Status bar / Dynamic Island / notch. */
  top: number = 0;
  /** Home indicator. */
  bottom: number = 0;
  /** Side insets (notch or rounded corners in landscape). */
  left: number = 0;
  right: number = 0;

  private static inst: SafeArea | undefined = undefined;

  /** The one shared instance (the AppStorageV2 key 'safeArea' on HarmonyOS). */
  static get(): SafeArea {
    if (SafeArea.inst === undefined) {
      SafeArea.inst = proxy(new SafeArea());
    }
    return SafeArea.inst;
  }

  /** Publishes new insets (only when they changed) and logs them. Never throws. */
  static update(top: number, bottom: number, left: number, right: number, reason: string): void {
    try {
      const sa = SafeArea.get();
      if (sa.top !== top || sa.bottom !== bottom || sa.left !== left || sa.right !== right) {
        sa.top = top;
        sa.bottom = bottom;
        sa.left = left;
        sa.right = right;
        Log.i(LogEvents.APP_PAGE, `safeArea top=${top.toFixed(1)} bottom=${bottom.toFixed(1)} ` +
          `left=${left.toFixed(1)} right=${right.toFixed(1)} reason=${reason}`);
      }
    } catch (e) {
      Log.e(LogEvents.UNCAUGHT, `where=SafeArea.update ${Log.errKv(e as Object)}`);
    }
  }
}
