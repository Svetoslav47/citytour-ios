/* Route '/DevPanel' (not in Routes; SettingsPage.DEV_PANEL_ROUTE): the Developer page (HarmonyOS: --ps page dev; iOS: citytour://DevPanel or a long press on Settings › About › Version). */
import React from 'react';
import { DevPanel } from '@/pages/DevPanel';

export default function DevPanelRoute(): React.JSX.Element {
  return <DevPanel />;
}
