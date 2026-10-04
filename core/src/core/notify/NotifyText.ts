/*
 * Pure text, rate and haptic-pattern rules for the next-stop notification and the arrival haptic (task A8).
 * services/notify/TourNotifier.ets and services/haptics/Haptics.ets hold the Kit calls; everything they decide is
 * here so the local unit tests (entry/src/test/NotifyText.test.ets) can check it.
 * Sources: docs/ARCHITECTURE.md §2.7 ("Next: Wawel Cathedral", "240 m · ~3 min · on your left", "5/12"; one
 * notification, updated on stop change and every >= 50 m; cancelled at tour end), §2.8 (arrival vibration,
 * isSupportEffect check first), docs/DESIGN.md §3.12.3 (text-only arrival: "You're at St Mary's Basilica" /
 * "Jesteś przy: Kościół Mariacki", never more than one CityTour notification), PLAN §0.3 rule 6 (SIMULATED on every
 * surface where the Demo walk is active). Notification text never carries emoji (sanitizeNotifyText).
 * Pure: no platform imports.
 */
import { EngineSnapshot, HapticKind, NextNotice, RelDir, TourPhase } from '../../contracts/EngineTypes';
import { FixSource } from '../../contracts/Ports';
import { Lang } from '../../contracts/Model';
import { relDirPhrase } from '../content/Phrases';

/** The one CityTour notification id (ARCHITECTURE §2.7): every publish updates it in place. */
export const NOTIFY_ID: number = 1001;
/** Distance refresh step while walking (ARCHITECTURE §2.7). */
export const NOTIFY_REFRESH_M: number = 50;
/** Minimum gap between two distance refreshes (the Demo walk at x8 covers 50 m in about 5 s). */
export const NOTIFY_REFRESH_MIN_MS: number = 3000;
/** Display limits: the shade truncates anyway; these keep a bad pack string from flooding it. */
export const NOTIFY_TITLE_MAX: number = 80;
export const NOTIFY_TEXT_MAX: number = 240;
/** Used for the ETA when the snapshot has none for this stop (TourConfig default). */
export const NOTIFY_WALK_SPEED_MPS: number = 1.3;

export enum NoticeKind { NEXT = 'next', ARRIVAL = 'arrival' }

/** What the notifier knows about the tour when it formats a notice (built from the live snapshot). */
export interface NotifyContext {
  lang: Lang;
  demo: boolean;               // Demo walk active => SIMULATED in the text
  phase: TourPhase;
  activePoiId: string;         // the stop the user is at (AT_STOP), '' otherwise
  nextPoiId: string;           // snapshot.next.poiId, '' if none
  nextDistanceM: number;       // snapshot.next.distanceM, NaN if unknown
  nextEtaS: number;            // snapshot.next.etaS, NaN if unknown
  nextRelDir: RelDir;          // snapshot.next.relDir (HERE = no usable direction)
  stopNumbers: Map<string, number>; // poiId -> 1-based position in the walking order
  stopCount: number;
}

export interface NotifyText {
  title: string;
  text: string;
  additionalText: string;
}

/** The context of a snapshot (lang is the tour's text language, which the snapshot does not carry). */
export function contextFromSnapshot(s: EngineSnapshot, lang: Lang): NotifyContext {
  const nums: Map<string, number> = new Map<string, number>();
  for (let i = 0; i < s.stops.length; i++) {
    if (!nums.has(s.stops[i].poiId)) {
      nums.set(s.stops[i].poiId, i + 1);
    }
  }
  const atStop: boolean = s.phase === TourPhase.AT_STOP && s.currentStopIdx >= 0 &&
    s.currentStopIdx < s.stops.length;
  const ctx: NotifyContext = {
    lang: lang,
    demo: s.source === FixSource.DEMO,
    phase: s.phase,
    activePoiId: atStop ? s.stops[s.currentStopIdx].poiId : '',
    nextPoiId: s.next !== undefined ? s.next.poiId : '',
    nextDistanceM: s.next !== undefined ? s.next.distanceM : Number.NaN,
    nextEtaS: s.next !== undefined ? s.next.etaS : Number.NaN,
    nextRelDir: s.next !== undefined ? s.next.relDir : RelDir.HERE,
    stopNumbers: nums,
    stopCount: s.stops.length
  };
  return ctx;
}

/**
 * NOTIFY_NEXT carries no kind. The engine emits it for the next stop (tour start, stop done, re-plan) and, in
 * text-only mode, for the stop just reached (TourEngine.arrive). It is an arrival when the engine is AT_STOP at
 * that very stop: effects run right after reduce(), so the live snapshot already shows the arrival.
 */
export function noticeKind(n: NextNotice, ctx: NotifyContext): NoticeKind {
  return ctx.phase === TourPhase.AT_STOP && ctx.activePoiId.length > 0 && n.poiId === ctx.activePoiId ?
    NoticeKind.ARRIVAL : NoticeKind.NEXT;
}

/** True while a tour notification makes sense; outside these phases the notification is cancelled. */
export function isTourLive(phase: TourPhase): boolean {
  return phase === TourPhase.WALKING || phase === TourPhase.APPROACHING || phase === TourPhase.AT_STOP;
}

// ---------------------------------------------------------------- sanitising

function isEmojiCodePoint(cp: number): boolean {
  return (cp >= 0x1F000 && cp <= 0x1FAFF) ||   // pictographs, emoticons, transport, flags, symbols ext.
    (cp >= 0x2600 && cp <= 0x27BF) ||          // misc symbols, dingbats
    (cp >= 0x2B00 && cp <= 0x2BFF) ||          // arrows/stars used as emoji
    (cp >= 0xFE00 && cp <= 0xFE0F) ||          // variation selectors
    cp === 0x200D || cp === 0x20E3 ||          // zero-width joiner, keycap
    (cp >= 0xE0020 && cp <= 0xE007F);          // tag characters (subdivision flags)
}

/** Drops emoji and control characters, collapses whitespace, trims, and cuts to `max` characters with "...". */
export function sanitizeNotifyText(s: string, max: number): string {
  if (s === undefined || s === null) {
    return '';
  }
  let out: string = '';
  for (const ch of s) {              // for..of walks code points, so surrogate pairs stay whole
    const cp: number = ch.codePointAt(0) as number;
    if (isEmojiCodePoint(cp)) {
      continue;
    }
    out += (cp < 0x20 || cp === 0x7F) ? ' ' : ch;
  }
  out = out.replace(/\s+/g, ' ').trim();
  const chars: string[] = Array.from(out);
  if (max > 3 && chars.length > max) {
    out = chars.slice(0, max - 3).join('').trim() + '...';
  }
  return out;
}

// ---------------------------------------------------------------- formatting

/** "240 m" / "1.2 km" (pl "1,2 km", zh "240 米" / "1.2 公里"); '' when unknown. Under 1 km to the nearest 10 m. */
export function shortDistance(m: number, lang: Lang): string {
  if (!Number.isFinite(m) || m < 0) {
    return '';
  }
  if (m < 995) {
    const r: number = Math.max(10, Math.round(m / 10) * 10);
    return lang === Lang.ZH ? `${r} 米` : `${r} m`;
  }
  let km: string = (Math.round(m / 100) / 10).toFixed(1);
  if (lang === Lang.PL) {
    km = km.replace('.', ',');
  }
  return lang === Lang.ZH ? `${km} 公里` : `${km} km`;
}

/** "~3 min" (zh "约3分钟"); at least 1 minute; '' when unknown. */
export function shortEta(etaS: number, lang: Lang): string {
  if (!Number.isFinite(etaS) || etaS < 0) {
    return '';
  }
  const min: number = Math.max(1, Math.round(etaS / 60));
  return lang === Lang.ZH ? `约${min}分钟` : `~${min} min`;
}

/** The honesty label for the Demo walk (PLAN §0.3 rule 6). */
export function simulatedLabel(lang: Lang): string {
  switch (lang) {
    case Lang.PL: return 'SYMULACJA';
    case Lang.ZH: return '模拟';
    default: return 'SIMULATED';
  }
}

function nextTitle(lang: Lang, name: string): string {
  switch (lang) {
    case Lang.PL: return `Dalej: ${name}`;
    case Lang.ZH: return `下一站：${name}`;
    default: return `Next: ${name}`;
  }
}

function arrivalTitle(lang: Lang, name: string): string {
  switch (lang) {
    case Lang.PL: return `Jesteś przy: ${name}`;
    case Lang.ZH: return `您已到达${name}`;
    default: return `You're at ${name}`;
  }
}

/** "5/11"; '' when the stop is not in the order. */
export function progressText(poiId: string, ctx: NotifyContext): string {
  const k: number | undefined = ctx.stopNumbers.get(poiId);
  return k === undefined || ctx.stopCount <= 0 ? '' : `${k}/${ctx.stopCount}`;
}

const SEP: string = ' · ';

/**
 * Notification content for a notice. NEXT: "Next: Wawel Cathedral" / "240 m · ~3 min · on your left".
 * ARRIVAL (text-only mode): "You're at St Mary's Basilica" / the engine's arrival line. With the Demo walk the
 * text starts with SIMULATED. additionalText is the k/n progress. No emoji, bounded length.
 * Distance, ETA and direction come from the live snapshot when it is about the same stop, else from the notice.
 */
export function formatNotice(n: NextNotice, kind: NoticeKind, ctx: NotifyContext): NotifyText {
  const lang: Lang = ctx.lang;
  const parts: string[] = [];
  if (ctx.demo) {
    parts.push(simulatedLabel(lang));
  }
  let title: string;
  if (kind === NoticeKind.ARRIVAL) {
    title = arrivalTitle(lang, n.title);
    const line: string = sanitizeNotifyText(n.text, NOTIFY_TEXT_MAX);
    if (line.length > 0) {
      parts.push(line);
    }
  } else {
    title = nextTitle(lang, n.title);
    const same: boolean = ctx.nextPoiId === n.poiId;
    const d: number = same && Number.isFinite(ctx.nextDistanceM) ? ctx.nextDistanceM :
      (n.distanceM >= 0 ? n.distanceM : Number.NaN);
    const eta: number = same && Number.isFinite(ctx.nextEtaS) ? ctx.nextEtaS : d / NOTIFY_WALK_SPEED_MPS;
    const dist: string = shortDistance(d, lang);
    if (dist.length > 0) {
      parts.push(dist);
      const e: string = shortEta(eta, lang);
      if (e.length > 0) {
        parts.push(e);
      }
    }
    if (same && ctx.nextRelDir !== RelDir.HERE) {
      parts.push(relDirPhrase(ctx.nextRelDir, lang));
    }
    if (dist.length === 0) {
      const line: string = sanitizeNotifyText(n.text, NOTIFY_TEXT_MAX);   // the spoken next-stop sentence
      if (line.length > 0) {
        parts.push(line);
      }
    }
  }
  const t: NotifyText = {
    title: sanitizeNotifyText(title, NOTIFY_TITLE_MAX),
    text: sanitizeNotifyText(parts.join(SEP), NOTIFY_TEXT_MAX),
    additionalText: progressText(n.poiId, ctx)
  };
  return t;
}

// ---------------------------------------------------------------- rate rule

/** What is on screen now (the last successful publish). */
export interface ShownNotice {
  kind: NoticeKind;
  notice: NextNotice;
  distanceM: number;           // distance the text shows, NaN if none
  atMs: number;
}

/**
 * Distance refresh while walking to the same stop: only for a NEXT notice, only when the snapshot is about that
 * stop, at least NOTIFY_REFRESH_M away from the shown distance and NOTIFY_REFRESH_MIN_MS after the last publish.
 * Stop changes do not go through here: the engine's NOTIFY_NEXT always publishes.
 */
export function shouldRefresh(shown: ShownNotice | undefined, ctx: NotifyContext, nowMs: number): boolean {
  if (shown === undefined || shown.kind !== NoticeKind.NEXT || !isTourLive(ctx.phase) ||
    ctx.phase === TourPhase.AT_STOP) {
    return false;
  }
  if (ctx.nextPoiId !== shown.notice.poiId || !Number.isFinite(ctx.nextDistanceM)) {
    return false;
  }
  if (nowMs - shown.atMs < NOTIFY_REFRESH_MIN_MS) {
    return false;
  }
  if (!Number.isFinite(shown.distanceM)) {
    return true;                 // the first fix after a notice without a distance
  }
  return Math.abs(ctx.nextDistanceM - shown.distanceM) >= NOTIFY_REFRESH_M;
}

/** The distance a formatted NEXT notice shows (for ShownNotice.distanceM). */
export function shownDistance(n: NextNotice, kind: NoticeKind, ctx: NotifyContext): number {
  if (kind !== NoticeKind.NEXT) {
    return Number.NaN;
  }
  if (ctx.nextPoiId === n.poiId && Number.isFinite(ctx.nextDistanceM)) {
    return ctx.nextDistanceM;
  }
  return n.distanceM >= 0 ? n.distanceM : Number.NaN;
}

// ---------------------------------------------------------------- haptics

/**
 * One vibration plan: a system preset (preferred, HarmonyOS vibrator guide) when the device supports it,
 * else a plain timed buzz. count > 1 repeats the preset (VibratePreset.count).
 */
export interface HapticPlan {
  kind: HapticKind;
  effectId: string;            // '' => timed vibration
  count: number;
  durationMs: number;          // for the timed fallback
}

/** Preferred preset per kind (ARCHITECTURE §2.8) and the timed fallback. */
export function preferredEffect(kind: HapticKind): string {
  switch (kind) {
    case HapticKind.ARRIVE: return 'haptic.notice.success';
    case HapticKind.FINISH: return 'haptic.notice.success';
    case HapticKind.OFF_ROUTE: return 'haptic.clock.timer';
    default: return 'haptic.effect.soft';   // APPROACH
  }
}

export function fallbackDurationMs(kind: HapticKind): number {
  switch (kind) {
    case HapticKind.ARRIVE: return 80;
    case HapticKind.FINISH: return 200;
    case HapticKind.OFF_ROUTE: return 120;
    default: return 40;
  }
}

/** `supported(effectId)` is vibrator.isSupportEffectSync behind a cache; it may be unknown (false). */
export function hapticPlan(kind: HapticKind, supported: (effectId: string) => boolean): HapticPlan {
  const id: string = preferredEffect(kind);
  let ok: boolean = false;
  try {
    ok = supported(id);
  } catch (e) {
    ok = false;
  }
  const count: number = kind === HapticKind.OFF_ROUTE || kind === HapticKind.FINISH ? 2 : 1;
  const p: HapticPlan = {
    kind: kind, effectId: ok ? id : '', count: ok ? count : 1, durationMs: fallbackDurationMs(kind)
  };
  return p;
}
