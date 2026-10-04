/*
 * App shell: the iOS counterpart of EntryAbility + pages/Index.ets. Boot order: hydrate persisted settings
 * (AsyncStorage) -> AppContainer.init() (builds services, starts nothing) -> the Index.aboutToAppear sequence
 * (UI language, settings, online voice, active course pack, tour summary recorder, home-screen widget).
 * Every route is a full-screen stack page without a header, like the ArkUI Navigation stack.
 */
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState, useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LogEvents } from '@citytour/core';
import { AppConfig } from '@/main/AppConfig';
import { AppContainer } from '@/main/AppContainer';
import { Log } from '@/main/Log';
import { hydratePersistence } from '@/platform/Persist';
import { DARK, LIGHT } from '@/theme';
import { AppViewModel } from '@/viewmodel/AppViewModel';
import { RemoteSettings } from '@/viewmodel/CoursesViewModel';
import { SafeAreaSync } from '@/viewmodel/SafeAreaSync';
import { SettingsViewModel } from '@/viewmodel/SettingsViewModel';
import { SummaryViewModel } from '@/viewmodel/SummaryViewModel';
import { WidgetBridge } from '@/viewmodel/WidgetBridge';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

let booted: boolean = false;

async function boot(): Promise<void> {
  if (booted) {
    return;
  }
  booted = true;
  await hydratePersistence();
  AppContainer.init();
  Log.i(LogEvents.APP_START, `ver=${AppConfig.APP_VERSION} pack=none packKind=${AppContainer.packKind()} page=Index`);
  const app = AppViewModel.get();
  app.applySupportedUiLanguage();
  SettingsViewModel.applyAll(app);
  RemoteSettings.apply();
  app.loadPack();
  SummaryViewModel.startRecording();
  WidgetBridge.start(() => app.textLang);
}

export default function RootLayout() {
  const [ready, setReady] = useState<boolean>(false);
  const scheme = useColorScheme();
  const colors = scheme === 'dark' ? DARK : LIGHT;

  useEffect(() => {
    boot().catch((e: unknown) => {
      Log.e(LogEvents.UNCAUGHT, `where=RootLayout.boot ${Log.errKv(e)}`);
    }).finally(() => {
      setReady(true);
      SplashScreen.hideAsync().catch(() => undefined);
    });
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        Log.i(LogEvents.APP_FG, '');
      } else if (s === 'background') {
        // The tour keeps running in the background (location + audio background modes).
        Log.i(LogEvents.APP_BG, '');
      }
    });
    return () => sub.remove();
  }, []);

  if (!ready) {
    return null;
  }
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.bg_canvas }}>
      <SafeAreaProvider>
        <SafeAreaSync />
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg_canvas } }} />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
