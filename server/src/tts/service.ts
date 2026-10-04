// Runtime studio voice (docs/SERVER.md §2 step 2, §4): only allowed lines, cache forever by sha256(text), daily
// character budget, circuit breaker, one upstream call per line even under concurrent requests.
import type { Logger } from 'pino';
import { sha256Hex } from '../canonical.js';
import { DataStore, utcDay } from '../store.js';
import { CircuitBreaker } from './breaker.js';
import { Synthesizer, UpstreamError } from './elevenlabs.js';

export type TtsOutcome =
  | { kind: 'audio'; textSha: string; blobSha: string; cache: 'hit' | 'miss' }
  | { kind: 'unknown_course' }
  | { kind: 'not_allowed'; textSha: string }
  | { kind: 'budget' }
  | { kind: 'unavailable'; retryAfterS: number }
  | { kind: 'upstream_error' };

export interface TtsRequest {
  courseId: string;
  lang: string;
  text: string;
}

export class TtsService {
  private readonly inflight = new Map<string, Promise<TtsOutcome>>();
  private reservedChars = 0;   // characters of calls in flight (so concurrent misses cannot overshoot the budget)

  constructor(
    private readonly store: DataStore,
    private readonly synth: Synthesizer,
    readonly breaker: CircuitBreaker,
    private readonly budgetChars: number,
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date()
  ) {}

  async handle(req: TtsRequest): Promise<TtsOutcome> {
    const allowed = await this.store.allowed(req.courseId);
    if (allowed === null) {
      return { kind: 'unknown_course' };
    }
    const textSha = sha256Hex(Buffer.from(req.text, 'utf8'));
    if (!allowed.has(textSha)) {
      return { kind: 'not_allowed', textSha };
    }
    const hit = await this.store.ttsLookup(textSha);
    if (hit && (await this.store.hasBlob(hit.blob))) {
      return { kind: 'audio', textSha, blobSha: hit.blob, cache: 'hit' };
    }
    const pending = this.inflight.get(textSha);
    if (pending) {
      const r = await pending;
      return r.kind === 'audio' ? { ...r, cache: 'hit' } : r;
    }
    const p = this.render(req, textSha).finally(() => this.inflight.delete(textSha));
    this.inflight.set(textSha, p);
    return p;
  }

  /** Budget left today (for the HUD / logs). */
  async remainingToday(): Promise<number> {
    return Math.max(0, this.budgetChars - (await this.store.usage(utcDay(this.now()))) - this.reservedChars);
  }

  private async render(req: TtsRequest, textSha: string): Promise<TtsOutcome> {
    if (!this.breaker.allow()) {
      return { kind: 'unavailable', retryAfterS: this.breaker.retryAfterS() };
    }
    const chars = [...req.text].length;
    const day = utcDay(this.now());
    const spent = await this.store.usage(day);
    if (spent + this.reservedChars + chars > this.budgetChars) {
      this.log.warn({ evt: 'TTS_BUDGET', day, spent, budget: this.budgetChars, textSha }, 'daily character budget reached');
      return { kind: 'budget' };
    }
    this.reservedChars += chars;
    try {
      const audio = await this.synth.synthesize({ text: req.text, lang: req.lang });
      this.breaker.success();
      const blobSha = sha256Hex(audio);
      await this.store.putBlob(blobSha, audio);
      await this.store.addUsage(day, chars);
      await this.store.ttsRecord(textSha, {
        blob: blobSha, chars, lang: req.lang, source: 'runtime', renderedAt: this.now().toISOString()
      });
      this.log.info({ evt: 'TTS_RENDER', textSha, chars, bytes: audio.length, lang: req.lang }, 'rendered');
      return { kind: 'audio', textSha, blobSha, cache: 'miss' };
    } catch (e) {
      if (e instanceof UpstreamError) {
        const fatal = e.kind === 'auth' || e.kind === 'quota';
        const transient = fatal || e.kind === 'rate' || e.kind === 'server' || e.kind === 'timeout' ||
          e.kind === 'network';
        if (transient) {
          this.breaker.failure(e.kind, fatal);
        }
        this.log.warn({ evt: 'TTS_UPSTREAM', kind: e.kind, status: e.status, textSha, breaker: this.breaker.state() },
          'upstream failed');
        return this.breaker.allow() ? { kind: 'upstream_error' } :
          { kind: 'unavailable', retryAfterS: this.breaker.retryAfterS() };
      }
      throw e;
    } finally {
      this.reservedChars -= chars;
    }
  }
}
