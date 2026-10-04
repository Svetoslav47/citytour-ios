/*
 * HapticsPort implementation (task A8, docs/ARCHITECTURE.md §2.8): a short vibration on arrival (and on finish,
 * approach, off-route), the eyes-free cue that matters most in text-only mode (Polish, or no voice).
 *
 * iOS port: HarmonyOS vibrator presets -> expo-haptics (UIFeedbackGenerator on the Taptic Engine).
 * The pure choice (preset, count) is still core/notify/NotifyText.hapticPlan (unit-tested); the preset ids it
 * returns are mapped here:
 *   - 'haptic.notice.success' (ARRIVE x1, FINISH x2) -> notificationAsync(Success)
 *   - 'haptic.effect.soft'    (APPROACH x1)          -> impactAsync(Soft)
 *   - 'haptic.clock.timer'    (OFF_ROUTE x2)         -> impactAsync(Heavy)
 *   - timed fallback (effectId '')                   -> impactAsync(Medium) (iOS has no timed vibration API)
 * Repeats (count > 1) are spaced REPEAT_GAP_MS apart. iOS has no "is this effect supported" query: every preset
 * above exists on every iPhone with a Taptic Engine, so isSupported() is true; on the iOS Simulator and on devices
 * without a Taptic Engine the calls resolve silently. The HAPTIC log line records what was attempted (ok=1|0),
 * and a failure never reaches the tour. No permission is needed on iOS (ohos.permission.VIBRATE has no
 * counterpart); the system "System Haptics" switch can mute it.
 */
import * as ExpoHaptics from 'expo-haptics';
import { HapticKind } from '@citytour/core';
import { HapticsPort } from '@citytour/core';
import { HapticPlan, hapticPlan } from '@citytour/core';
import { Log } from '@/main/Log';
import { LogEvents } from '@citytour/core';

/** One buzz per kind within this window: a re-entered state must not rattle the phone. */
const MIN_GAP_MS: number = 800;
/** Gap between repeats of a preset (count > 1). */
const REPEAT_GAP_MS: number = 180;

/** One Taptic Engine pulse for a HarmonyOS preset id ('' = the timed fallback). */
function pulse(effectId: string): Promise<void> {
  switch (effectId) {
    case 'haptic.notice.success':
      return ExpoHaptics.notificationAsync(ExpoHaptics.NotificationFeedbackType.Success);
    case 'haptic.effect.soft':
      return ExpoHaptics.impactAsync(ExpoHaptics.ImpactFeedbackStyle.Soft);
    case 'haptic.clock.timer':
      return ExpoHaptics.impactAsync(ExpoHaptics.ImpactFeedbackStyle.Heavy);
    default:
      return ExpoHaptics.impactAsync(ExpoHaptics.ImpactFeedbackStyle.Medium);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class Haptics implements HapticsPort {
  private supportCache: Map<string, boolean> = new Map<string, boolean>();
  private lastAt: Map<string, number> = new Map<string, number>();
  private enabled: boolean = true;

  /** Settings "Vibrate on arrival" (B9). Off = no tour vibration at all; each skipped cue is still logged. */
  setEnabled(on: boolean): void {
    this.enabled = on;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  play(kind: HapticKind): void {
    try {
      if (!this.enabled) {
        Log.i(LogEvents.HAPTIC, `kind=${kind} skipped=user_off`);
        return;
      }
      const now: number = Date.now();
      const last: number | undefined = this.lastAt.get(kind);
      if (last !== undefined && now - last < MIN_GAP_MS) {
        Log.i(LogEvents.HAPTIC, `kind=${kind} skipped=debounce`);
        return;
      }
      this.lastAt.set(kind, now);
      const plan: HapticPlan = hapticPlan(kind, (id: string) => this.isSupported(id));
      this.start(plan);
    } catch (e) {
      Log.e(LogEvents.HAPTIC, `kind=${kind} ok=0 where=play ${Log.errKv(e as Object)}`);
    }
  }

  /** iOS: every mapped preset exists on the Taptic Engine (see the header); cached like the original. */
  private isSupported(effectId: string): boolean {
    const cached: boolean | undefined = this.supportCache.get(effectId);
    if (cached !== undefined) {
      return cached;
    }
    const ok: boolean = effectId.length > 0;
    this.supportCache.set(effectId, ok);
    return ok;
  }

  private start(plan: HapticPlan): void {
    const preset: boolean = plan.effectId.length > 0;
    const mode: string = preset ? `preset effect=${plan.effectId} count=${plan.count}` : `time ms=${plan.durationMs}`;
    try {
      const n: number = preset ? Math.max(1, plan.count) : 1;
      let p: Promise<void> = pulse(plan.effectId);
      for (let i = 1; i < n; i++) {
        p = p.then(() => delay(REPEAT_GAP_MS)).then(() => pulse(plan.effectId));
      }
      p.then(() => {
        Log.i(LogEvents.HAPTIC, `kind=${plan.kind} mode=${mode} ok=1`);
      }).catch((e: Object) => {
        Log.w(LogEvents.HAPTIC, `kind=${plan.kind} mode=${mode} ok=0 ${Log.errKv(e)}`);
      });
    } catch (e) {
      Log.w(LogEvents.HAPTIC, `kind=${plan.kind} mode=${mode} ok=0 ${Log.errKv(e as Object)}`);
    }
  }
}
