/*
 * Display strings for Settings values (task B9): story language rows, app language rows, the voice row.
 * Each function returns the string key; callers resolve it with `t(...)` from useT() so a language switch re-renders.
 */
import { StoryLang, UiLang, VoiceRow } from '@citytour/core';

/** plSpoken: the A13 clips cover Polish, so the row says spoken instead of text only. */
export function storyLangRes(l: StoryLang, plSpoken: boolean = false): string {
  if (l === StoryLang.ZH) {
    return 'lang_zh_spoken';
  }
  if (l === StoryLang.PL) {
    return plSpoken ? 'lang_pl_spoken' : 'lang_pl_text';
  }
  if (l === StoryLang.PL_LISTEN_EN) {
    return 'lang_en_listen_pl_read';
  }
  return 'lang_en_spoken';
}

export function uiLangRes(u: UiLang): string {
  if (u === UiLang.EN) {
    return 'lang_english';
  }
  if (u === UiLang.PL) {
    return 'lang_polish';
  }
  if (u === UiLang.ZH) {
    return 'lang_chinese';
  }
  return 'lang_system';
}

export function voiceRowRes(v: VoiceRow): string {
  if (v === VoiceRow.LAURA) {
    return 'voice_laura_installed';
  }
  if (v === VoiceRow.FALLBACK || v === VoiceRow.PRERENDERED) {
    return 'onb_spoken';   // the voice type is not labelled on screen (Settings > About names it)
  }
  if (v === VoiceRow.ZH) {
    return 'voice_zh';
  }
  if (v === VoiceRow.TEXT_USER) {
    return 'voice_text_only';
  }
  return 'voice_text_only_platform';
}
