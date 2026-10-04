/*
 * Async helpers for view models. Every platform call a view model makes goes through withTimeout, so a hung
 * service never freezes a screen (AGENTS.md: explicit timeouts, never crash).
 */
import { Log } from '../app/Log';
import { LogEvents } from '@citytour/core';

/**
 * Resolves with `fallback` if `p` rejects or takes longer than `ms`, and logs why. Every platform call made by a
 * view model goes through this, so a hung service never freezes a screen.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T, where: string): Promise<T> {
  return new Promise<T>((resolve: (v: T) => void) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        Log.w(LogEvents.UNCAUGHT, `where=${where} timeoutMs=${ms}`);
        resolve(fallback);
      }
    }, ms);
    p.then((v: T) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(v);
      }
    }).catch((e: Object) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        Log.e(LogEvents.UNCAUGHT, `where=${where} ${Log.errKv(e)}`);
        resolve(fallback);
      }
    });
  });
}
