/*
 * Mid-tour story language switch (task X2, issue #37; docs/DESIGN.md §3.6 ⋯ menu, docs/OPPORTUNITIES.md wow #3).
 * Pure: no @kit import, unit-tested in entry/src/test/LangSwitch.test.ets.
 *
 * A queued story item is `[arrival lines...] + story sentences` (TourEngine.arrive) or the story alone (full, deep,
 * replay). B7 guarantees that the pl/zh translation of a story has exactly as many sentences as the English one, so
 * sentence N of one language is sentence N of the others. The switch keeps every sentence already heard (and the
 * one in flight, which finishes in the old language: "the next sentence boundary") and rewrites the rest:
 *   - story sentences -> the same index in the new language (when the counts match; otherwise nothing changes),
 *   - unplayed arrival lines -> the new language's arrival lines when there are as many of them.
 * Which narration an item plays is found by matching the old story's sentences against the item's tail, so the
 * engine needs no extra bookkeeping per item.
 */
import { Lang } from '../../contracts/Model';
import { StoryLang } from '../settings/SettingsRules';

/** The languages the Now Walking ⋯ menu can switch to mid-tour, in menu order. */
export const LIVE_LANGS: Lang[] = [Lang.EN, Lang.PL, Lang.ZH];

/** The menu entries for a tour narrated in `current`: the other live languages. */
export function otherLiveLangs(current: Lang): Lang[] {
  return LIVE_LANGS.filter((l: Lang) => l !== current);
}

/** Each language named in itself (the menu shows "Continue in 中文" whatever the UI language). */
export function liveLangName(l: Lang): string {
  if (l === Lang.PL) {
    return 'Polski';
  }
  if (l === Lang.ZH) {
    return '中文';
  }
  return 'English';
}

/** The saved Story language row for a menu choice (Polski = Polish text, spoken by the studio clips if shipped). */
export function storyLangForLive(l: Lang): StoryLang {
  if (l === Lang.PL) {
    return StoryLang.PL;
  }
  return l === Lang.ZH ? StoryLang.ZH : StoryLang.EN;
}

/** What remapItemTexts did, for the LANG_SWITCH log line and the tests. */
export class RemapResult {
  texts: string[] = [];
  /** Indices >= this are rewritten (in-flight and earlier sentences stay). */
  from: number = 0;
  /** Number of sentences whose text changed language. */
  changed: number = 0;
  /** 'ok' | 'no_story' | 'count_mismatch' | 'nothing_left' */
  reason: string = 'ok';
}

/** The first sentence of an item that may still change: the cursor, or the one after it while it is in flight. */
export function firstUnplayedIndex(cursor: number, inFlight: boolean): number {
  const c: number = Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0;
  return inFlight ? c + 1 : c;
}

/** True when `story` is exactly the last story.length entries of `texts`. */
export function isStoryTail(texts: string[], story: string[]): boolean {
  if (story.length === 0 || story.length > texts.length) {
    return false;
  }
  const off: number = texts.length - story.length;
  for (let i = 0; i < story.length; i++) {
    if (texts[off + i] !== story[i]) {
      return false;
    }
  }
  return true;
}

/** Index of the first candidate story that is the tail of `texts`, -1 if none (a system line or a nav cue). */
export function matchStory(texts: string[], candidates: string[][]): number {
  for (let i = 0; i < candidates.length; i++) {
    if (isStoryTail(texts, candidates[i])) {
      return i;
    }
  }
  return -1;
}

/**
 * The item's sentences after a switch. `oldStory`/`newStory`: the matched narration in the old and the new language
 * ([] when the item is not a story). `newPrefix`: the arrival lines in the new language ([] = keep the old ones).
 */
export function remapItemTexts(texts: string[], from: number, oldStory: string[], newStory: string[],
  newPrefix: string[]): RemapResult {
  const r: RemapResult = new RemapResult();
  r.texts = texts.slice();
  r.from = Math.max(0, from);
  if (r.from >= texts.length) {
    r.reason = 'nothing_left';
    return r;
  }
  if (!isStoryTail(texts, oldStory)) {
    r.reason = 'no_story';
    return r;
  }
  if (newStory.length !== oldStory.length) {
    r.reason = 'count_mismatch';     // B7 guards against it; the item then ends in the old language
    return r;
  }
  const off: number = texts.length - oldStory.length;
  const prefixOk: boolean = newPrefix.length === off;
  for (let i = r.from; i < texts.length; i++) {
    let t: string = texts[i];
    if (i >= off) {
      t = newStory[i - off];
    } else if (prefixOk) {
      t = newPrefix[i];
    }
    if (t !== texts[i]) {
      r.texts[i] = t;
      r.changed++;
    }
  }
  return r;
}
