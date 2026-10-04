/*
 * The app's one log channel (ARCHITECTURE §10 of the HarmonyOS app): every line is "CityTour EVENT k=v ...".
 * On HarmonyOS this was hilog domain 0xC17A, tag CityTour. On iOS the lines go to the JS console (Metro in a
 * debug build, the device log via React Native's RCTLog in a release build) and to an in-memory ring buffer that
 * the Developer page shows, so a logs view during the demo backs up the behaviour.
 */
import { LoggerPort } from '@citytour/core';

export const LOG_TAG: string = 'CityTour';
const RING_MAX: number = 400;

export type LogLevel = 'D' | 'I' | 'W' | 'E';

export interface LogLine {
  ts: number;
  level: LogLevel;
  event: string;
  kv: string;
}

const ring: LogLine[] = [];
const listeners: Set<(l: LogLine) => void> = new Set();

function emit(level: LogLevel, event: string, kv: string): void {
  try {
    const line: LogLine = { ts: Date.now(), level, event, kv };
    ring.push(line);
    if (ring.length > RING_MAX) {
      ring.splice(0, ring.length - RING_MAX);
    }
    const text = `${LOG_TAG} ${level} ${event} ${kv}`;
    // One console level for all lines (the level is in the text): console.error/warn would raise React Native's
    // red/yellow LogBox toasts over the UI in a debug build for handled, expected states (e.g. BG_FAIL, PACK_ERR).
    console.log(text);
    listeners.forEach((l) => l(line));
  } catch {
    // logging must never crash the app
  }
}

export class Log {
  static d(event: string, kv: string = ''): void {
    emit('D', event, kv);
  }

  static i(event: string, kv: string = ''): void {
    emit('I', event, kv);
  }

  static w(event: string, kv: string = ''): void {
    emit('W', event, kv);
  }

  static e(event: string, kv: string = ''): void {
    emit('E', event, kv);
  }

  /** "code=… msg=…" for a caught error of unknown shape. */
  static errKv(err: unknown): string {
    if (err === undefined || err === null) {
      return 'code=-1 msg=unknown';
    }
    try {
      const o = err as { code?: unknown; message?: unknown };
      const msg = o.message !== undefined ? String(o.message) : JSON.stringify(err);
      return `code=${o.code !== undefined ? String(o.code) : '-1'} msg=${msg}`;
    } catch {
      return 'code=-1 msg=unprintable';
    }
  }

  static recent(): LogLine[] {
    return ring.slice();
  }

  static subscribe(l: (line: LogLine) => void): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }
}

export class ConsoleLogger implements LoggerPort {
  info(event: string, kv: string): void {
    Log.i(event, kv);
  }

  warn(event: string, kv: string): void {
    Log.w(event, kv);
  }

  error(event: string, kv: string): void {
    Log.e(event, kv);
  }
}
