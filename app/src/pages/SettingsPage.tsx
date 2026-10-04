/*
 * Settings (task B9, docs/DESIGN.md §3.11, mockup docs/design/mockups/Settings.dc.html). A screen with its own header
 * (back + large title) and grouped cards: Narration, Walking, Sound and haptics, Offline data, Demo, Permissions,
 * About. Everything is persisted (UserSettings via @/platform/Persist) and applied by SettingsViewModel.
 * Ids for the smoke/verification scripts: btnSettings (Home), rowStoryLanguage, rowAppLanguage, rowVoice,
 * segDetail<brief|standard|deep>, rowSpokenDirections, segTrigger<20|35|50>, rowVibrate, rowDemoWalk,
 * segSpeed<1|2|4|8>, rowLocation, rowNotifications, rowSources (About & licences: the only place with credits,
 * licences and the AI note), rowShowIntro, rowVersion.
 *
 * Honesty: "Mention places along the way" and "Arrival chime" have no engine behind them in this build, so their
 * rows are left out (DESIGN §3.11 lists them; the strings stay for when they ship).
 * iOS addition: the Developer page (HarmonyOS: a separate page opened with a launch parameter) opens with a long
 * press on the Version row (or the citytour://DevPanel deep link).
 */
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSnapshot } from 'valtio';
import {
  DEMO_SPEEDS, DetailLevel, LocRow, LogEvents, NotifRow, TRIGGER_DISTANCES_M
} from '@citytour/core';
import { Log } from '@/main/Log';
import { useT } from '@/platform/strings';
import { Radius, Space, Type, useColors } from '@/theme';
import { AppViewModel, Routes } from '@/viewmodel/AppViewModel';
import { SettingsViewModel } from '@/viewmodel/SettingsViewModel';
import { SimulatedBadge } from '@/views/common/SimulatedBadge';
import {
  Footnote, NavRow, RowDivider, SectionHeader, SegmentOption, SegmentRow, SettingsCard, SettingsFrame, ToggleRow
} from '@/views/settings/SettingsRows';
import { storyLangRes, uiLangRes, voiceRowRes } from '@/views/settings/SettingsText';

/** The Developer page's route (app/src/app/DevPanel.tsx). */
export const DEV_PANEL_ROUTE: string = 'DevPanel';

function detailNote(d: DetailLevel): string {
  if (d === DetailLevel.BRIEF) {
    return 'settings_detail_brief_note';
  }
  if (d === DetailLevel.DEEP) {
    return 'settings_detail_deep_note';
  }
  return 'settings_detail_standard_note';
}

function locRes(r: LocRow): string {
  if (r === LocRow.ALLOWED) {
    return 'settings_loc_allowed';
  }
  if (r === LocRow.APPROX) {
    return 'settings_loc_approx';
  }
  if (r === LocRow.SWITCH_OFF) {
    return 'settings_loc_switch_off';
  }
  if (r === LocRow.DENIED) {
    return 'settings_loc_off';
  }
  return 'settings_loc_ask';
}

function notifRes(r: NotifRow): string {
  if (r === NotifRow.ALLOWED) {
    return 'settings_on';
  }
  if (r === NotifRow.DENIED) {
    return 'settings_off';
  }
  return 'settings_loc_ask';
}

export function SettingsPage(): React.JSX.Element {
  const t = useT();
  const c = useColors();
  const app = AppViewModel.get();
  const vm = SettingsViewModel.get();
  const s = useSnapshot(vm);

  useEffect(() => {
    Log.i(LogEvents.APP_PAGE, `page=Settings ${SettingsViewModel.summaryKv()}`);
  }, []);

  useFocusEffect(useCallback(() => {
    vm.refresh();
  }, [vm]));

  const open = (name: string, param: string): void => {
    app.openSettingsPage(name, param);
  };

  const detailOptions: SegmentOption[] = [
    new SegmentOption(DetailLevel.BRIEF, t('settings_detail_brief')),
    new SegmentOption(DetailLevel.STANDARD, t('settings_detail_standard')),
    new SegmentOption(DetailLevel.DEEP, t('settings_detail_deep'))
  ];
  const triggerOptions: SegmentOption[] = TRIGGER_DISTANCES_M.map((m: number) =>
    new SegmentOption(`${m}`, t('fmt_m', m)));
  const speedOptions: SegmentOption[] = DEMO_SPEEDS.map((x: number) =>
    new SegmentOption(`${x}`, t('settings_speed_x', x), t('settings_speed_a11y', x)));

  const useDemoWalk = s.settings.useDemoWalk;

  return (
    <SettingsFrame title={t('settings_title')} pageId="pageSettings" onBack={() => app.back()} gap={Space.S5}>
      {/* Narration */}
      <View>
        <SectionHeader label={t('settings_narration')} />
        <SettingsCard>
          <NavRow
            title={t('settings_story_language')} value={t(storyLangRes(s.storyLang(), s.plSpoken()))}
            rowId="rowStoryLanguage" onTap={() => open(Routes.SETTINGS_STORY_LANG, '')}
          />
          <RowDivider />
          <NavRow
            title={t('settings_app_language')} value={t(uiLangRes(s.uiLang()))}
            rowId="rowAppLanguage" onTap={() => open(Routes.SETTINGS_APP_LANG, '')}
          />
          <RowDivider />
          <NavRow
            title={t('settings_voice')} value={t(voiceRowRes(s.voiceRow))}
            rowId="rowVoice" onTap={() => open(Routes.SETTINGS_VOICE, '')}
          />
          <RowDivider />
          <NavRow title={t('settings_guide')} value={s.guideName} rowId="rowGuide" tappable={false} />
          <RowDivider />
          <SegmentRow
            title={t('settings_detail_level')} options={detailOptions} selected={s.detailLevel()}
            idPrefix="segDetail" onSelect={(k: string) => vm.setDetailLevel(k as DetailLevel)}
          />
        </SettingsCard>
        <Footnote text={t(detailNote(s.detailLevel()))} />
      </View>

      {/* Walking */}
      <View>
        <SectionHeader label={t('settings_walking')} />
        <SettingsCard>
          <ToggleRow
            title={t('settings_spoken_directions')} subtitle={t('settings_spoken_directions_note')}
            isOn={s.settings.spokenDirections} rowId="rowSpokenDirections"
            onToggle={(on: boolean) => vm.setSpokenDirections(on)}
          />
          <RowDivider />
          <SegmentRow
            title={t('settings_trigger')} options={triggerOptions} selected={`${s.triggerM()}`}
            idPrefix="segTrigger" onSelect={(k: string) => vm.setTriggerM(Number(k))}
          />
        </SettingsCard>
        <Footnote text={t('settings_trigger_note')} />
      </View>

      {/* Sound and haptics */}
      <View>
        <SectionHeader label={t('settings_sound_haptics')} />
        <SettingsCard>
          <ToggleRow
            title={t('settings_vibrate')} subtitle={t('settings_vibrate_note')}
            isOn={s.extras.vibrateOnArrival} rowId="rowVibrate" onToggle={(on: boolean) => vm.setVibrate(on)}
          />
        </SettingsCard>
      </View>

      {/* Offline data */}
      <View>
        <SectionHeader label={t('settings_offline_data')} />
        <SettingsCard>
          {!s.packKnown ? (
            <NavRow
              title={t('settings_pack_title')} subtitle={t('settings_pack_loading')}
              tappable={false} busy={true} rowId="rowPack"
            />
          ) : !s.hasCourse ? (
            <NavRow
              title={t('settings_pack_title')} subtitle={t('settings_pack_none')} tappable={false} rowId="rowPack"
            />
          ) : !s.packOk ? (
            <NavRow
              title={t('settings_pack_title')} subtitle={t('settings_pack_error')} tappable={false} rowId="rowPack"
            />
          ) : (
            <NavRow
              title={t('settings_pack_title')}
              subtitle={t('settings_pack_line', s.pack.places, s.pack.stories)}
              value={s.pack.sizeMb > 0 ? t('settings_pack_size', `${s.pack.sizeMb}`) : t('settings_pack_included')}
              tappable={false} rowId="rowPack"
            />
          )}
        </SettingsCard>
      </View>

      {/* Demo (SIMULATED) */}
      {s.demoOffered || useDemoWalk ? (
        <View>
          <View style={styles.demoHead}>
            <View style={{ flex: 1 }}>
              <SectionHeader label={t('settings_demo')} />
            </View>
            <View style={{ marginRight: Space.S2, marginBottom: Space.S2 }}>
              <SimulatedBadge visible={useDemoWalk} />
            </View>
          </View>
          <SettingsCard>
            <ToggleRow
              title={t('settings_demo_walk')}
              subtitle={s.tourRunning ? t('settings_demo_running_note') :
                (useDemoWalk ? t('settings_demo_on_note') : '')}
              isOn={useDemoWalk} rowId="rowDemoWalk"
              onToggle={(on: boolean) => {
                vm.setDemoWalk(on);
              }}
            />
            {useDemoWalk ? (
              <>
                <RowDivider />
                <SegmentRow
                  title={t('settings_replay_speed')} options={speedOptions} selected={`${s.demoSpeed()}`}
                  idPrefix="segSpeed" onSelect={(k: string) => vm.setDemoSpeed(Number(k))}
                />
              </>
            ) : null}
          </SettingsCard>
          {/* The amber footnote (DESIGN §3.11, signal.simulated): amber = simulated, never brand. */}
          <Text
            testID="noteSimulated"
            style={[styles.simNote, { color: c.signal_simulated_fg, backgroundColor: c.signal_simulated_bg }]}
          >
            {t('settings_demo_walk_note')}
          </Text>
        </View>
      ) : null}

      {/* Permissions */}
      <View>
        <SectionHeader label={t('settings_permissions')} />
        <SettingsCard>
          <NavRow
            title={t('settings_location')} value={t(locRes(s.loc))} busy={s.locBusy}
            rowId="rowLocation" tappable={s.loc !== LocRow.ALLOWED} onTap={() => {
              vm.onLocationRow();
            }}
          />
          <RowDivider />
          <NavRow
            title={t('settings_notifications')} value={t(notifRes(s.notif))} busy={s.notifBusy}
            rowId="rowNotifications" tappable={s.notif !== NotifRow.ALLOWED} onTap={() => {
              vm.onNotificationsRow();
            }}
          />
        </SettingsCard>
        <Footnote text={t('settings_perm_note')} />
      </View>

      {/* About */}
      <View>
        <SectionHeader label={t('settings_about')} />
        <SettingsCard>
          <NavRow title={t('settings_sources')} rowId="rowSources" onTap={() => app.openAbout()} />
          <RowDivider />
          <NavRow title={t('settings_show_intro')} rowId="rowShowIntro" onTap={() => open(Routes.ONBOARDING, '')} />
          <RowDivider />
          <NavRow
            title={t('settings_version')} value={t('settings_version_value')} tappable={false} rowId="rowVersion"
            onLongPress={() => open(DEV_PANEL_ROUTE, '')}
          />
        </SettingsCard>
      </View>
    </SettingsFrame>
  );
}

const styles = StyleSheet.create({
  demoHead: { width: '100%', flexDirection: 'row', alignItems: 'center' },
  simNote: {
    fontSize: Type.FOOTNOTE, lineHeight: Type.FOOTNOTE_LH, borderRadius: Radius.MD, overflow: 'hidden',
    paddingHorizontal: 14, paddingVertical: 10, marginTop: Space.S2, width: '100%'
  }
});
