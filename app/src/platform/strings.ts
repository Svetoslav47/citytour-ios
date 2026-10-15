/*
 * UI strings in English, Polish and Simplified Chinese: the HarmonyOS app's resource files
 * (entry/src/main/resources/{base,pl_PL,zh_CN}/element/string.json) converted to i18n/{en,pl,zh}.json.
 * Placeholders keep the resource syntax: %s, %d and positional %1$s / %2$d.
 * The UI language follows the system language unless Settings › App language picks one (setAppLanguage).
 */
import { getLocales } from 'expo-localization';
import { proxy, useSnapshot } from 'valtio';
import en from '../i18n/en.json';
import pl from '../i18n/pl.json';
import zh from '../i18n/zh.json';

export type UiCode = 'en' | 'pl' | 'zh';
export type StringKey = keyof typeof en;

const TABLES: Record<UiCode, Record<string, string>> = { en, pl, zh };

function systemCode(): UiCode {
  try {
    const tag = (getLocales()[0]?.languageTag ?? 'en').toLowerCase();
    return tag.startsWith('pl') ? 'pl' : tag.startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

/** '' = follow the system language. */
export const uiLangState = proxy({ preferred: '' as '' | UiCode, rev: 0 });

export function uiCode(): UiCode {
  return uiLangState.preferred !== '' ? uiLangState.preferred : systemCode();
}

export function systemUiCode(): UiCode {
  return systemCode();
}

export function setAppLanguage(code: '' | UiCode): void {
  uiLangState.preferred = code;
  uiLangState.rev++;
}

export function formatString(template: string, args: (string | number)[]): string {
  let seq = 0;
  return template.replace(/%(?:(\d+)\$)?([sd%])/g, (m: string, pos: string | undefined, kind: string) => {
    if (kind === '%') {
      return '%';
    }
    const idx = pos !== undefined ? Number(pos) - 1 : seq++;
    if (idx < 0 || idx >= args.length) {
      return m;
    }
    const v = args[idx];
    return kind === 'd' ? String(typeof v === 'number' ? Math.trunc(v) : v) : String(v);
  });
}

/** The string `key` in the UI language (English if a locale lacks it, the key itself if unknown). */
export function t(key: string, ...args: (string | number)[]): string {
  const table = TABLES[uiCode()];
  const tpl = table[key] ?? (en as Record<string, string>)[key] ?? key;
  return args.length > 0 ? formatString(tpl, args) : tpl;
}

/** The string in a given UI language (the widget and notifications follow the app language too). */
export function tIn(code: UiCode, key: string, ...args: (string | number)[]): string {
  const tpl = TABLES[code][key] ?? (en as Record<string, string>)[key] ?? key;
  return args.length > 0 ? formatString(tpl, args) : tpl;
}

/** Re-renders the calling component when the UI language changes; returns t. */
export function useT(): typeof t {
  useSnapshot(uiLangState);
  return t;
}
