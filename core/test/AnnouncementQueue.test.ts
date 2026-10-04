// Suite: AnnouncementQueue.test - module under test: core/tour/AnnouncementQueue (task A3).
// Cases from docs/ARCHITECTURE.md §11.1: P1 arriving mid-P2 plays after the current sentence, then P2 resumes
// at its cursor; expiry drops a stale P1; dedupe; skip-after-current; text-only timer pacing.
// Plus: one sentence in flight, a started item beats a fresh one of the same priority, pause restarts the
// sentence with a new id (a late DONE of the cut one is ignored), empty items refused, stale cue removal.
import { describe, it, expect } from 'vitest';
import {
  AnnouncementQueue, QueueAdvance, expiryFor, readingTimeMs, readingWords, stripMarkup
} from '../src';
import { TourConfig, defaultTourConfig } from '../src';
import { Announcement, AnnouncementKind, Priority } from '../src';
import { Utterance } from '../src';
import { Lang } from '../src';

function item(id: string, priority: Priority, n: number, nowMs: number, cfg: TourConfig): Announcement {
  const us: Utterance[] = [];
  for (let i = 0; i < n; i++) {
    const u: Utterance = { id: `${id}.${i}`, itemId: id, text: `${id} sentence ${i}.`, lang: Lang.EN, personaId: 'historian' };
    us.push(u);
  }
  const a: Announcement = {
    id: id, priority: priority, kind: AnnouncementKind.STOP_STORY, utterances: us, cursor: 0,
    expiresAtMs: expiryFor(priority, nowMs, cfg), dedupeKey: `key:${id}`
  };
  return a;
}

/** Hands out the next sentence and returns its text ('' when nothing is handed out). */
function nextText(q: AnnouncementQueue): string {
  const u: Utterance | undefined = q.next();
  return u === undefined ? '' : u.text;
}

/** Finishes the in-flight sentence. */
function done(q: AnnouncementQueue): QueueAdvance {
  const u: Utterance | undefined = q.inFlight();
  return q.onDone(u === undefined ? 'none' : u.id);
}

function announcementQueueTest() {
  describe('AnnouncementQueue', () => {
    it('one_sentence_in_flight_until_done', () => {
      const cfg: TourConfig = defaultTourConfig();
      const q: AnnouncementQueue = new AnnouncementQueue();
      expect(q.enqueue(item('a', Priority.P2_STORY, 3, 0, cfg))).toBe(true);
      expect(nextText(q)).toBe('a sentence 0.');
      expect(q.isBusy()).toBe(true);
      expect(q.next() === undefined).toBe(true);                 // busy: nothing new
      expect(q.onDone('someone-else').matched).toBe(false);      // stray DONE ignored
      expect(q.isBusy()).toBe(true);
      const r: QueueAdvance = done(q);
      expect(r.matched).toBe(true);
      expect(r.finished).toBe(false);
      expect(nextText(q)).toBe('a sentence 1.');
      done(q);
      expect(nextText(q)).toBe('a sentence 2.');
      const last: QueueAdvance = done(q);
      expect(last.finished).toBe(true);
      expect(q.size()).toBe(0);
      expect(q.next() === undefined).toBe(true);
    });

    it('p1_mid_p2_plays_after_current_sentence_then_p2_resumes_at_cursor', () => {
      const cfg: TourConfig = defaultTourConfig();
      const q: AnnouncementQueue = new AnnouncementQueue();
      q.enqueue(item('story', Priority.P2_STORY, 3, 0, cfg));
      expect(nextText(q)).toBe('story sentence 0.');
      q.enqueue(item('nav', Priority.P1_NAV, 2, 1000, cfg));       // arrives mid-sentence
      expect(q.next() === undefined).toBe(true);                 // the sentence is never cut
      done(q);
      expect(nextText(q)).toBe('nav sentence 0.');
      done(q);
      expect(nextText(q)).toBe('nav sentence 1.');
      expect(done(q).finished).toBe(true);
      expect(nextText(q)).toBe('story sentence 1.');        // resumes at its cursor
      done(q);
      expect(nextText(q)).toBe('story sentence 2.');
      expect(done(q).finished).toBe(true);
    });

    it('started_item_beats_fresh_item_of_same_priority', () => {
      const cfg: TourConfig = defaultTourConfig();
      const q: AnnouncementQueue = new AnnouncementQueue();
      q.enqueue(item('a', Priority.P2_STORY, 2, 0, cfg));
      nextText(q);
      q.enqueue(item('p0', Priority.P0_SYSTEM, 1, 0, cfg));
      q.enqueue(item('b', Priority.P2_STORY, 1, 0, cfg));
      done(q);
      expect(nextText(q)).toBe('p0 sentence 0.');
      done(q);
      expect(nextText(q)).toBe('a sentence 1.');
      done(q);
      expect(nextText(q)).toBe('b sentence 0.');
    });

    it('expiry_drops_stale_p1_but_never_the_in_flight_item', () => {
      const cfg: TourConfig = defaultTourConfig();
      expect(expiryFor(Priority.P0_SYSTEM, 1000, cfg)).toBe(31000);
      expect(expiryFor(Priority.P1_NAV, 1000, cfg)).toBe(21000);
      expect(expiryFor(Priority.P2_STORY, 1000, cfg)).toBe(Number.POSITIVE_INFINITY);
      expect(expiryFor(Priority.P3_APPROACH, 1000, cfg)).toBe(31000);
      expect(expiryFor(Priority.P4_AMBIENT, 1000, cfg)).toBe(61000);

      const q: AnnouncementQueue = new AnnouncementQueue();
      q.enqueue(item('story', Priority.P2_STORY, 2, 0, cfg));
      nextText(q);
      q.enqueue(item('turn', Priority.P1_NAV, 1, 0, cfg));
      expect(q.expire(20000).length).toBe(0);              // exactly at the deadline: kept
      const dropped: Announcement[] = q.expire(25000);
      expect(dropped.length).toBe(1);
      expect(dropped[0].id).toBe('turn');
      done(q);
      expect(nextText(q)).toBe('story sentence 1.');       // P2 never expires

      const r: AnnouncementQueue = new AnnouncementQueue();
      r.enqueue(item('cue', Priority.P1_NAV, 2, 0, cfg));
      nextText(r);
      expect(r.expire(60000).length).toBe(0);              // in flight: kept
    });

    it('dedupe_key_accepted_once', () => {
      const cfg: TourConfig = defaultTourConfig();
      const q: AnnouncementQueue = new AnnouncementQueue();
      const a: Announcement = item('a', Priority.P3_APPROACH, 1, 0, cfg);
      expect(q.enqueue(a)).toBe(true);
      const again: Announcement = item('a2', Priority.P3_APPROACH, 1, 0, cfg);
      again.dedupeKey = a.dedupeKey;
      expect(q.enqueue(again)).toBe(false);
      expect(q.size()).toBe(1);
      nextText(q);
      done(q);
      expect(q.enqueue(again)).toBe(false);                     // also after the first one played
      expect(q.wasEnqueued('key:a')).toBe(true);
      const empty: Announcement = item('e', Priority.P2_STORY, 0, 0, cfg);
      expect(q.enqueue(empty)).toBe(false);                     // nothing to say
    });

    it('skip_drops_rest_of_item_after_current_sentence', () => {
      const cfg: TourConfig = defaultTourConfig();
      const q: AnnouncementQueue = new AnnouncementQueue();
      q.enqueue(item('story', Priority.P2_STORY, 3, 0, cfg));
      q.enqueue(item('next', Priority.P2_STORY, 1, 0, cfg));
      nextText(q);
      const skipped: Announcement | undefined = q.skipCurrent();
      expect(skipped !== undefined && skipped.id === 'story').toBe(true);
      expect(q.isBusy()).toBe(true);                            // the current sentence still finishes
      expect(q.next() === undefined).toBe(true);
      const r: QueueAdvance = done(q);
      expect(r.matched).toBe(true);
      expect(r.item === undefined).toBe(true);
      expect(nextText(q)).toBe('next sentence 0.');
    });

    it('pause_restarts_the_sentence_with_a_new_id', () => {
      const cfg: TourConfig = defaultTourConfig();
      const q: AnnouncementQueue = new AnnouncementQueue();
      q.enqueue(item('story', Priority.P2_STORY, 2, 0, cfg));
      const first: Utterance | undefined = q.next();
      const cut: Utterance | undefined = q.interrupt();
      expect(first !== undefined && cut !== undefined && first.id === cut.id).toBe(true);
      expect(q.isBusy()).toBe(false);
      expect(q.onDone(first === undefined ? '' : first.id).matched).toBe(false); // late DONE of the cut one
      const again: Utterance | undefined = q.next();
      expect(again !== undefined && again.text === 'story sentence 0.').toBe(true);
      expect(again !== undefined && first !== undefined && again.id !== first.id).toBe(true);
    });

    it('remove_waiting_cue_and_clear', () => {
      const cfg: TourConfig = defaultTourConfig();
      const q: AnnouncementQueue = new AnnouncementQueue();
      q.enqueue(item('story', Priority.P2_STORY, 2, 0, cfg));
      q.enqueue(item('approach', Priority.P3_APPROACH, 1, 0, cfg));
      nextText(q);
      expect(q.removeWaiting('key:story') === undefined).toBe(true);   // in flight: not removable
      expect(q.removeWaiting('key:approach') !== undefined).toBe(true);
      expect(q.size()).toBe(1);
      q.clear();
      expect(q.size()).toBe(0);
      expect(q.isBusy()).toBe(false);
    });

    it('text_only_reading_timer', () => {
      const cfg: TourConfig = defaultTourConfig();
      expect(readingTimeMs('Short one.', cfg)).toBe(2500);                  // floor 2.5 s
      // 13 words / 2.6 words per second = 5 s
      expect(readingTimeMs('One two three four five six seven eight nine ten eleven twelve thirteen.', cfg))
        .toBe(5000);
      expect(stripMarkup('[p300] Look up. [n1]')).toBe('Look up.');
      expect(readingWords('[p600] Look left, and up at the taller tower.')).toBe(8);
      // 20 CJK characters count as 10 words => 3846 ms
      expect(readingTimeMs('圣玛丽大教堂在您左侧请抬头看较高的塔楼好', cfg)).toBe(Math.round(10 / 2.6 * 1000));
    });
  });
}

announcementQueueTest();
