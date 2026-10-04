/*
 * System clock behind the contracts Clock port, so core/ and tests can inject a fake clock.
 * Scheduler (A7): the timers TourController needs (1 Hz TICK, snapshot throttle, timeouts), behind an interface so
 * the controller's unit tests can drive time by hand. SystemScheduler uses the global setTimeout/setInterval
 * (ArkTS runtime timers, no @kit import), so this file stays loadable by the local test runner.
 */
import { Clock } from '../contracts/Ports';

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

/** Timer port. cancel() of an unknown or already fired id is a no-op. */
export interface Scheduler {
  after(ms: number, fn: () => void): number;
  every(ms: number, fn: () => void): number;
  cancel(id: number): void;
}

export class SystemScheduler implements Scheduler {
  private intervals: Set<number> = new Set<number>();
  // Timer handles are numbers in Hermes; Node returns objects, so the ids are cast.

  after(ms: number, fn: () => void): number {
    return setTimeout(fn, Math.max(0, ms)) as unknown as number;
  }

  every(ms: number, fn: () => void): number {
    const id: number = setInterval(fn, Math.max(1, ms)) as unknown as number;
    this.intervals.add(id);
    return id;
  }

  cancel(id: number): void {
    if (id < 0) {
      return;
    }
    if (this.intervals.has(id)) {
      this.intervals.delete(id);
      clearInterval(id);
    } else {
      clearTimeout(id);
    }
  }
}
