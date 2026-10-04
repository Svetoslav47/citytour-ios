/*
 * Settings > Story language (task B9, DESIGN §3.11 + Flow F): a radio list of the four narration choices and the
 * footnote about Polish when it is text only. Ids: radioStory<en|zh|pl|pl-listen-en>.
 */
import React from 'react';
import { useSnapshot } from 'valtio';
import { STORY_LANGS, StoryLang } from '@citytour/core';
import { useT } from '@/platform/strings';
import { AppViewModel } from '@/viewmodel/AppViewModel';
import { SettingsViewModel } from '@/viewmodel/SettingsViewModel';
import { storyLangRes } from './SettingsText';
import { Footnote, RadioRow, RowDivider, SettingsCard, SettingsFrame } from './SettingsRows';

export function StoryLanguagePage(): React.JSX.Element {
  const t = useT();
  const app = AppViewModel.get();
  const vm = SettingsViewModel.get();
  const s = useSnapshot(vm);
  const plSpoken = s.plSpoken();
  return (
    <SettingsFrame title={t('settings_story_language')} pageId="pageStoryLanguage" onBack={() => app.back()}>
      <SettingsCard>
        {STORY_LANGS.map((l: StoryLang, i: number) => (
          <React.Fragment key={l}>
            {i > 0 ? <RowDivider /> : null}
            <RadioRow
              title={t(storyLangRes(l, plSpoken))}
              selected={s.storyLang() === l}
              rowId={`radioStory${l}`}
              group="storyLang"
              onSelect={() => vm.setStoryLang(l)}
            />
          </React.Fragment>
        ))}
      </SettingsCard>
      {!plSpoken ? <Footnote text={t('lang_pl_footnote')} /> : null}
    </SettingsFrame>
  );
}
