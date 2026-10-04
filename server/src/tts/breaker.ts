// Circuit breaker for the ElevenLabs call (docs/SERVER.md §4): a rejected key / no credits opens it for a long
// time, repeated 429 / 5xx / timeouts open it for a short time. While open, /v1/tts answers 503 at once (cache
// hits still work) and the app falls back to its built-in voice.

export interface BreakerOptions {
  failureThreshold: number;   // consecutive transient failures before opening
  shortOpenMs: number;        // after transient failures
  longOpenMs: number;         // after auth / quota failures
  now?: () => number;
}

export const DEFAULT_BREAKER: BreakerOptions = { failureThreshold: 3, shortOpenMs: 60_000, longOpenMs: 15 * 60_000 };

export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;
  private lastReason = '';

  constructor(private readonly o: BreakerOptions = DEFAULT_BREAKER) {}

  private now(): number {
    return this.o.now ? this.o.now() : Date.now();
  }

  /** True when a call may go upstream (closed, or half-open after the cool-down). */
  allow(): boolean {
    return this.now() >= this.openUntil;
  }

  retryAfterS(): number {
    return Math.max(1, Math.ceil((this.openUntil - this.now()) / 1000));
  }

  state(): { open: boolean; reason: string; failures: number } {
    return { open: !this.allow(), reason: this.lastReason, failures: this.failures };
  }

  success(): void {
    this.failures = 0;
    this.lastReason = '';
  }

  /** fatal = the key was rejected or the credits are gone: open for the long period at once. */
  failure(reason: string, fatal: boolean): void {
    this.lastReason = reason;
    this.failures++;
    if (fatal) {
      this.openUntil = this.now() + this.o.longOpenMs;
    } else if (this.failures >= this.o.failureThreshold) {
      this.openUntil = this.now() + this.o.shortOpenMs;
    }
  }
}
