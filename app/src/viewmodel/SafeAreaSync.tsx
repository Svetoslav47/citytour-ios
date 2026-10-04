/*
 * Feeds SafeArea from react-native-safe-area-context (the port of HarmonyOS SafeAreaWatcher). Mount it once inside
 * the SafeAreaProvider of the root layout: <SafeAreaProvider><SafeAreaSync /> ... </SafeAreaProvider>.
 * It renders nothing.
 */
import { useEffect } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SafeArea } from './SafeArea';

export function SafeAreaSync(): null {
  const insets = useSafeAreaInsets();
  useEffect(() => {
    SafeArea.update(insets.top, insets.bottom, insets.left, insets.right, 'insets');
  }, [insets.top, insets.bottom, insets.left, insets.right]);
  return null;
}
