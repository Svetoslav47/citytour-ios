/*
 * Display formatting shared by the view models: distances and durations as localised strings (t(), so they follow
 * the app language; on HarmonyOS these returned Resource values that Text resolved)
 * and localised names from the pack (fallback order textLang -> en -> pl, ARCHITECTURE §8).
 */
import { Lang, LocalizedText } from '@citytour/core';
import { t } from '../platform/strings';

/** Route-level distance: "180 m" (rounded to 10 m / 20 m) or "2.5 km". */
export function distanceRes(m: number): string {
  const v = Math.max(0, m);
  if (v < 100) {
    return t('fmt_m', Math.round(v / 10) * 10);
  }
  if (v < 1000) {
    return t('fmt_m', Math.round(v / 20) * 20);
  }
  return t('fmt_km', (Math.round(v / 100) / 10).toFixed(1));
}

/**
 * "Optimised order: 300 m shorter than the listed order" as one sentence per language (word order differs in zh/pl),
 * with the same rounding as distanceRes.
 */
export function savingRes(m: number): string {
  const v = Math.max(0, m);
  if (v < 1000) {
    return t('route_optimised_m', v < 100 ? Math.round(v / 10) * 10 : Math.round(v / 20) * 20);
  }
  return t('route_optimised_km', (Math.round(v / 100) / 10).toFixed(1));
}

/** "25 min" or "1 h 25 min" (at least 1 min). */
export function durationRes(minutes: number): string {
  const total = Math.max(1, Math.round(minutes));
  if (total < 60) {
    return t('fmt_min', total);
  }
  return t('fmt_h_min', Math.floor(total / 60), total % 60);
}

/** Localised name with the documented fallback order; '' when nothing is available. */
export function localName(names: LocalizedText | undefined, lang: Lang): string {
  if (names === undefined) {
    return '';
  }
  let v: string | undefined = undefined;
  if (lang === Lang.ZH) {
    v = names.zh;
  } else if (lang === Lang.PL) {
    v = names.pl;
  } else {
    v = names.en;
  }
  if (v !== undefined && v.length > 0) {
    return v;
  }
  if (names.en !== undefined && names.en.length > 0) {
    return names.en;
  }
  if (names.pl !== undefined && names.pl.length > 0) {
    return names.pl;
  }
  return names.zh !== undefined ? names.zh : '';
}

/** Spoken-story length estimate: ~150 words per minute (en/pl), ~250 characters per minute (zh). */
export function storyMinutes(sentences: string[], lang: Lang): number {
  let words = 0;
  let chars = 0;
  for (const s of sentences) {
    chars += s.length;
    words += s.split(' ').filter((w: string) => w.length > 0).length;
  }
  const min = lang === Lang.ZH ? chars / 250 : words / 150;
  return min <= 0 ? 0 : Math.max(1, Math.round(min));
}

/** Language name as shown in the guide row ("English", "中文", "Polski"). */
export function langNameRes(lang: Lang): string {
  if (lang === Lang.ZH) {
    return t('lang_chinese');
  }
  if (lang === Lang.PL) {
    return t('lang_polish');
  }
  return t('lang_english');
}
