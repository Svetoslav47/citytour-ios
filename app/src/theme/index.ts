/*
 * Design tokens (docs/DESIGN.md §4 of the HarmonyOS app): the shared palette (common/src/main/resources
 * {base,dark}/element/color.json, converted to theme/colors.json) plus spacing, radii and the type scale.
 * HarmonyOS colours are #AARRGGBB; React Native wants #RRGGBBAA, so 9-character values are reordered here.
 */
import { useColorScheme } from 'react-native';
import raw from './colors.json';

export type ColorName = keyof typeof raw.light;
export type Palette = Record<ColorName, string>;

function toRn(hex: string): string {
  return hex.length === 9 ? `#${hex.slice(3)}${hex.slice(1, 3)}` : hex;
}

function convert(p: Record<string, string>): Palette {
  const out: Record<string, string> = {};
  for (const k of Object.keys(p)) {
    out[k] = toRn(p[k]);
  }
  return out as Palette;
}

export const LIGHT: Palette = convert(raw.light);
export const DARK: Palette = convert(raw.dark);

export function useColors(): Palette {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}

export const Space = { S1: 4, S2: 8, S3: 12, S4: 16, S5: 24, S6: 32, S7: 48, S8: 64 } as const;
export const Radius = { SM: 8, MD: 12, LG: 20, XL: 28 } as const;
export const Type = {
  DISPLAY: 34, DISPLAY_LH: 40, TITLE1: 28, TITLE1_LH: 34, TITLE2: 22, TITLE2_LH: 28, TITLE3: 18, TITLE3_LH: 24,
  BODY: 16, BODY_LH: 24, TRANSCRIPT: 18, TRANSCRIPT_LH: 28, CALLOUT: 14, CALLOUT_LH: 20, FOOTNOTE: 13,
  FOOTNOTE_LH: 18, CAPTION: 12, CAPTION_LH: 16, OVERLINE_SPACING: 0.6
} as const;
export const Size = { TOUCH: 48, BUTTON_H: 48, ICON_BUTTON: 40, PAGE_MAX_W: 600 } as const;
/** Tabular figures for numbers that change (DESIGN §4.2). */
export const TABULAR = { fontVariant: ['tabular-nums' as const] };
