/*
 * Inline banner for an AppIssue (DESIGN §3.6.2 banners, ARCHITECTURE §9). One banner at a time, in the guide's
 * voice, with at most two actions. Codes go to the log, never to the UI.
 */
import { AppIssue, IssueCode } from '@citytour/core';
import { SymbolView } from 'expo-symbols';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSnapshot } from 'valtio';
import { t, useT } from '@/platform/strings';
import { Radius, Space, Type, useColors } from '@/theme';
import { AppViewModel } from '@/viewmodel/AppViewModel';

/** User-facing message for each §9 error-matrix code. */
export function issueMessage(code: IssueCode, city: string = ''): string {
  switch (code) {
    case IssueCode.PERM_DENIED:
      return t('err_perm_denied');
    case IssueCode.PERM_APPROX_ONLY:
      return t('err_perm_approx');
    case IssueCode.LOC_SWITCH_OFF:
      return t('err_loc_switch_off');
    case IssueCode.LOC_NOFIX:
      return t('err_loc_nofix');
    case IssueCode.LOC_LOST:
      return t('err_loc_lost');
    case IssueCode.LOC_POOR:
      return t('err_loc_poor');
    case IssueCode.LOC_UNAVAILABLE:
      return t('err_loc_unavailable');
    case IssueCode.LOC_OUT_OF_AREA:
      return city !== '' ? t('err_loc_out_of_area', city) : t('err_loc_out_of_area_any');
    case IssueCode.TTS_INIT_FAIL:
      return t('err_tts_init');
    case IssueCode.VOICE_UNAVAILABLE:
      return t('err_voice_unavailable');
    case IssueCode.TTS_ERR:
      return t('err_tts_err');
    case IssueCode.AUDIO_INTERRUPT:
      return t('err_audio_interrupt');
    case IssueCode.AUDIO_ROUTE_LOST:
      return t('err_audio_route_lost');
    case IssueCode.BG_FAIL:
      return t('err_bg_fail');
    case IssueCode.AVS_FAIL:
      return t('err_avs_fail');
    case IssueCode.NOTIF_DENIED:
      return t('err_notif_denied');
    case IssueCode.PACK_ERR:
      return t('err_pack');
    case IssueCode.NARR_FALLBACK:
      return t('err_narr_fallback');
    case IssueCode.ROUTE_FALLBACK:
      return t('err_route_fallback');
    default:
      return t('err_uncaught');
  }
}

/** The most important issue to show (DESIGN: permission > GPS > other). */
export function topIssue(issues: readonly AppIssue[]): AppIssue | undefined {
  const rank = (c: IssueCode): number => {
    if (c === IssueCode.PERM_DENIED || c === IssueCode.PERM_APPROX_ONLY || c === IssueCode.LOC_SWITCH_OFF) {
      return 0;
    }
    if (c === IssueCode.LOC_NOFIX || c === IssueCode.LOC_LOST || c === IssueCode.LOC_POOR ||
      c === IssueCode.LOC_UNAVAILABLE || c === IssueCode.LOC_OUT_OF_AREA) {
      return 1;
    }
    return 2;
  };
  let best: AppIssue | undefined = undefined;
  for (const i of issues) {
    if (best === undefined || rank(i.code) < rank(best.code)) {
      best = i;
    }
  }
  return best;
}

export interface IssueBannerProps {
  /** Explicit message; when empty the message comes from `code`. */
  message?: string;
  code?: IssueCode;
  actionLabel?: string;
  actionId?: string;
  secondaryLabel?: string;
  secondaryId?: string;
  onAction?: () => void;
  onSecondary?: () => void;
}

export function IssueBanner({
  message = '', code = IssueCode.UNCAUGHT, actionLabel = '', actionId = '', secondaryLabel = '',
  secondaryId = '', onAction = () => {}, onSecondary = () => {}
}: IssueBannerProps): React.JSX.Element {
  useT();
  const c = useColors();
  const app = useSnapshot(AppViewModel.get());
  return (
    <View style={[styles.box, { backgroundColor: c.signal_warning_bg }]}>
      <View style={styles.row}>
        <SymbolView name="exclamationmark.triangle.fill" size={20} tintColor={c.signal_simulated_fg} />
        <Text style={[styles.msg, { color: c.text_primary }]}>
          {message !== '' ? message : issueMessage(code, app.cityName)}
        </Text>
      </View>
      {actionLabel !== '' || secondaryLabel !== '' ? (
        <View style={styles.actions}>
          {actionLabel !== '' ? (
            <Pressable
              testID={actionId !== '' ? actionId : undefined}
              accessibilityRole="button"
              style={({ pressed }) => [styles.btn, {
                backgroundColor: c.bg_overlay_button,
                marginRight: Space.S2,
                opacity: pressed ? 0.6 : 1
              }]}
              onPress={() => onAction()}
            >
              <Text style={[styles.btnText, { color: c.accent }]}>{actionLabel}</Text>
            </Pressable>
          ) : null}
          {secondaryLabel !== '' ? (
            <Pressable
              testID={secondaryId !== '' ? secondaryId : undefined}
              accessibilityRole="button"
              style={({ pressed }) => [styles.btn, { opacity: pressed ? 0.6 : 1 }]}
              onPress={() => onSecondary()}
            >
              <Text style={[styles.btnText, { color: c.accent }]}>{secondaryLabel}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    width: '100%',
    padding: Space.S3,
    borderRadius: Radius.LG,
    gap: Space.S2
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Space.S3,
    width: '100%'
  },
  msg: {
    flex: 1,
    fontSize: Type.CALLOUT,
    lineHeight: Type.CALLOUT_LH
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    paddingLeft: 28,
    width: '100%'
  },
  btn: {
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 16,
    marginTop: Space.S1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  btnText: {
    fontSize: Type.CALLOUT,
    fontWeight: '500'
  }
});
