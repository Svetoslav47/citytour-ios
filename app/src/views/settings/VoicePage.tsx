/*
 * Settings > Voice (task B9, DESIGN §3.11 + Flow E): what you hear for the story language (the same VoicePlan label
 * the tour uses). Id: rowVoiceNow.
 * iOS port: the built-in system voice is dropped (stories play the studio-voice clips, then the server's studio
 * voice, else on-screen text), so the HarmonyOS sections that only managed the system voice are not ported: the
 * "English voice (Laura)" download card (rowLaura, btnDownloadVoice, rowDownloading, txtDownloadFailed) and the
 * "How English is spoken" strategy picker (radioStrategy<auto|zh|text>).
 */
import React, { useEffect } from 'react';
import { View } from 'react-native';
import { useSnapshot } from 'valtio';
import { useT } from '@/platform/strings';
import { Space } from '@/theme';
import { AppViewModel } from '@/viewmodel/AppViewModel';
import { SettingsViewModel } from '@/viewmodel/SettingsViewModel';
import { NavRow, SectionHeader, SettingsCard, SettingsFrame } from './SettingsRows';
import { voiceRowRes } from './SettingsText';

export function VoicePage(): React.JSX.Element {
  const t = useT();
  const app = AppViewModel.get();
  const vm = SettingsViewModel.get();
  const s = useSnapshot(vm);

  useEffect(() => {
    vm.refreshVoice();
  }, [vm]);

  return (
    <SettingsFrame title={t('settings_voice')} pageId="pageVoice" onBack={() => app.back()} gap={Space.S5}>
      <View>
        <SectionHeader label={t('settings_voice_now')} />
        <SettingsCard>
          <NavRow
            title={t('settings_story_language')}
            value={t(voiceRowRes(s.voiceRow))}
            tappable={false}
            rowId="rowVoiceNow"
          />
        </SettingsCard>
      </View>
    </SettingsFrame>
  );
}
