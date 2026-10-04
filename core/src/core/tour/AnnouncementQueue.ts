/*
 * The single speech queue of the tour (task A3). Source: docs/ARCHITECTURE.md §4.4, DESIGN §5.5.
 *   - One utterance (= one sentence) in flight at a time: next() hands out a sentence only when nothing
 *     is in flight, and the in-flight sentence is released only by onDone (UTTERANCE_DONE/FAILED),
 *     interrupt() (user pause) or clear(). "Never cut a sentence" is structural.
 *   - Order: priority (P0 first), then an item already started (cursor > 0) before a fresh one of the same
 *     priority, then enqueue order. So a P1 arriving mid-P2 plays at the next sentence boundary, and the P2
 *     item resumes at its cursor afterwards (it is interleaved, never dropped).
 *   - Expiry: expire(nowMs) drops waiting items whose expiresAtMs has passed (P2 never expires).
 *   - Dedupe: a dedupeKey is accepted at most once for the lifetime of the queue (clear() included).
 *   - skipCurrent(): drops the rest of the current item; its in-flight sentence still finishes
 *     (the engine emits STOP_SPEECH(afterCurrent = true)).
 *   - interrupt(): user pause; the in-flight sentence is forgotten without advancing the cursor, so it
 *     restarts from its beginning on resume (with a new utterance id, so a late DONE for the cut one is ignored).
 *   - readingTimeMs(): the text-only pacing timer, max(2.5 s, words / 2.6 words per second).
 * Pure: no platform imports.
 */
import { Announcement, Priority } from '../../contracts/EngineTypes';
import { Utterance } from '../../contracts/Ports';
import { TourConfig } from './TourConfig';

/** Result of onDone(). */
export interface QueueAdvance {
  matched: boolean;                 // the id was the in-flight utterance
  item?: Announcement;              // the item the sentence belonged to (if still queued)
  finished: boolean;                // that item has no sentences left and was removed
}

/** Default expiry deadline for an item enqueued at nowMs (§4.4: P0 30 s, P1 20 s, P2 never, P3 30 s, P4 60 s). */
export function expiryFor(priority: Priority, nowMs: number, cfg: TourConfig): number {
  switch (priority) {
    case Priority.P0_SYSTEM:
      return nowMs + cfg.expiryP0Ms;
    case Priority.P1_NAV:
      return nowMs + cfg.expiryP1Ms;
    case Priority.P3_APPROACH:
      return nowMs + cfg.expiryP3Ms;
    case Priority.P4_AMBIENT:
      return nowMs + cfg.expiryP4Ms;
    default:
      return Number.POSITIVE_INFINITY;
  }
}

/** Strips Core Speech Kit markup such as [p300] or [n1] from a sentence. */
export function stripMarkup(text: string): string {
  return text.replace(/\[[a-z][0-9]+\]/g, ' ').trim();
}

/**
 * Reading units of a sentence: Latin words, plus CJK characters / 2 (about two characters per word),
 * because Chinese has no spaces between words.
 */
export function readingWords(text: string): number {
  const clean: string = stripMarkup(text);
  const cjk: RegExpMatchArray | null = clean.match(/[㐀-鿿豈-﫿]/g);
  const cjkCount: number = cjk === null ? 0 : cjk.length;
  const latin: string = clean.replace(/[㐀-鿿豈-﫿]/g, ' ');
  const words: string[] = latin.split(/\s+/).filter((w: string) => /[0-9A-Za-zÀ-ɏ]/.test(w));
  return words.length + cjkCount / 2;
}

/** Text-only pacing: max(2.5 s, words / 2.6 words per second). */
export function readingTimeMs(text: string, cfg: TourConfig): number {
  return Math.max(cfg.textMinSentenceMs, Math.round(readingWords(text) / cfg.textWordsPerS * 1000));
}

export class AnnouncementQueue {
  private items: Announcement[] = [];
  private order: Map<string, number> = new Map<string, number>();
  private seenKeys: Set<string> = new Set<string>();
  private enqueueSeq: number = 0;
  private issueSeq: number = 0;
  private flight: Utterance | undefined = undefined;
  private flightItemId: string = '';

  /** Adds an item; false (and nothing changes) for a duplicate dedupeKey, a duplicate id or no sentences. */
  enqueue(a: Announcement): boolean {
    if (this.seenKeys.has(a.dedupeKey) || this.order.has(a.id) || a.cursor >= a.utterances.length) {
      return false;
    }
    this.seenKeys.add(a.dedupeKey);
    this.order.set(a.id, this.enqueueSeq++);
    this.items.push(a);
    return true;
  }

  /** True if this dedupeKey was ever accepted. */
  wasEnqueued(dedupeKey: string): boolean {
    return this.seenKeys.has(dedupeKey);
  }

  /** Removes a waiting (not in-flight) item by dedupeKey, e.g. a stale approach cue after arrival. */
  removeWaiting(dedupeKey: string): Announcement | undefined {
    for (let i = 0; i < this.items.length; i++) {
      const a: Announcement = this.items[i];
      if (a.dedupeKey === dedupeKey && a.id !== this.flightItemId) {
        this.items.splice(i, 1);
        this.order.delete(a.id);
        return a;
      }
    }
    return undefined;
  }

  size(): number {
    return this.items.length;
  }

  /** Copy of the queued items in play order. */
  pending(): Announcement[] {
    return this.sorted();
  }

  isBusy(): boolean {
    return this.flight !== undefined;
  }

  inFlight(): Utterance | undefined {
    return this.flight;
  }

  /** The item whose sentence is in flight (undefined if none or if it was skipped). */
  currentItem(): Announcement | undefined {
    return this.flight === undefined ? undefined : this.find(this.flightItemId);
  }

  /** The item that plays now or will play next. */
  headItem(): Announcement | undefined {
    const cur: Announcement | undefined = this.currentItem();
    if (cur !== undefined) {
      return cur;
    }
    const s: Announcement[] = this.sorted();
    return s.length > 0 ? s[0] : undefined;
  }

  /** Drops waiting items whose deadline passed (never the in-flight item). Returns the dropped items. */
  expire(nowMs: number): Announcement[] {
    const dropped: Announcement[] = [];
    const kept: Announcement[] = [];
    for (const a of this.items) {
      if (a.id !== this.flightItemId && nowMs > a.expiresAtMs) {
        dropped.push(a);
        this.order.delete(a.id);
      } else {
        kept.push(a);
      }
    }
    this.items = kept;
    return dropped;
  }

  /**
   * The next sentence to speak, or undefined when one is already in flight or the queue is empty.
   * The returned utterance is a copy of the item's sentence with a fresh id `<sentenceId>#<n>`.
   */
  next(): Utterance | undefined {
    if (this.flight !== undefined) {
      return undefined;
    }
    const s: Announcement[] = this.sorted();
    if (s.length === 0) {
      return undefined;
    }
    const a: Announcement = s[0];
    const src: Utterance = a.utterances[a.cursor];
    this.issueSeq++;
    const u: Utterance = {
      id: `${src.id}#${this.issueSeq}`, itemId: a.id, text: src.text, lang: src.lang, personaId: src.personaId
    };
    this.flight = u;
    this.flightItemId = a.id;
    return u;
  }

  /** UTTERANCE_DONE (or a failed sentence that is skipped): advances the cursor of the in-flight item. */
  onDone(utteranceId: string): QueueAdvance {
    if (this.flight === undefined || this.flight.id !== utteranceId) {
      const miss: QueueAdvance = { matched: false, finished: false };
      return miss;
    }
    const item: Announcement | undefined = this.find(this.flightItemId);
    this.flight = undefined;
    this.flightItemId = '';
    if (item === undefined) {
      const skipped: QueueAdvance = { matched: true, finished: false };
      return skipped;                      // the item was skipped while its last sentence played
    }
    item.cursor++;
    const finished: boolean = item.cursor >= item.utterances.length;
    if (finished) {
      this.remove(item.id);
    }
    const r: QueueAdvance = { matched: true, item: item, finished: finished };
    return r;
  }

  /** USER_SKIP: drops the rest of the current item (the in-flight sentence still finishes). */
  skipCurrent(): Announcement | undefined {
    const cur: Announcement | undefined = this.currentItem();
    if (cur !== undefined) {
      this.remove(cur.id);
    }
    return cur;
  }

  /** User pause / audio interrupt: forget the in-flight sentence without advancing; it restarts on resume. */
  interrupt(): Utterance | undefined {
    const u: Utterance | undefined = this.flight;
    this.flight = undefined;
    this.flightItemId = '';
    return u;
  }

  /** Drops everything (USER_END). Dedupe keys stay remembered. */
  clear(): void {
    this.items = [];
    this.order.clear();
    this.flight = undefined;
    this.flightItemId = '';
  }

  private find(id: string): Announcement | undefined {
    for (const a of this.items) {
      if (a.id === id) {
        return a;
      }
    }
    return undefined;
  }

  private remove(id: string): void {
    this.items = this.items.filter((a: Announcement) => a.id !== id);
    this.order.delete(id);
  }

  private seqOf(id: string): number {
    const v: number | undefined = this.order.get(id);
    return v === undefined ? Number.MAX_SAFE_INTEGER : v;
  }

  private sorted(): Announcement[] {
    return this.items.slice().sort((a: Announcement, b: Announcement) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      const aStarted: number = a.cursor > 0 ? 0 : 1;
      const bStarted: number = b.cursor > 0 ? 0 : 1;
      if (aStarted !== bStarted) {
        return aStarted - bStarted;
      }
      return this.seqOf(a.id) - this.seqOf(b.id);
    });
  }
}
