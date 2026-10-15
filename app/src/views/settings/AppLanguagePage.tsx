/*
 * Settings > App language (task B9, DESIGN §3.11): System / English / Polski / 中文 through setAppLanguage
 * (SettingsViewModel.applyUiLang). Ids: radioUi<system|en|pl|zh>.
 */
import React from 'react';
import { useSnapshot } from 'valtio';
import { UI_LANGS, UiLang } from '@citytour/core';
import { useT } from '@/platform/strings';
import { AppViewModel } from '@/viewmodel/AppViewModel';
import { SettingsViewModel } from '@/viewmodel/SettingsViewModel';
import { uiLangRes } from './SettingsText';
import { Footnote, RadioRow, RowDivider, SettingsCard, SettingsFrame } from './SettingsRows';

export function AppLanguagePage(): React.JSX.Element {
  const t = useT();
  const app = AppViewModel.get();
  const vm = SettingsViewModel.get();
  const s = useSnapshot(vm);
  return (
    <SettingsFrame title={t('settings_app_language')} pageId="pageAppLanguage" onBack={() => app.back()}>
      <SettingsCard>
        {UI_LANGS.map((u: UiLang, i: number) => (
          <React.Fragment key={u}>
            {i > 0 ? <RowDivider /> : null}
            <RadioRow
              title={t(uiLangRes(u))}
              selected={s.uiLang() === u}
              rowId={`radioUi${u}`}
              group="uiLang"
              onSelect={() => vm.setUiLang(u)}
            />
          </React.Fragment>
        ))}
      </SettingsCard>
      <Footnote text={t('settings_app_language_note')} />
    </SettingsFrame>
  );
}
