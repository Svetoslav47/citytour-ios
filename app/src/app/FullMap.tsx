/*
 * Route Routes.FULL_MAP: the full native map (pages/MapPage). The one parameter is the MapMode
 * ('walk' | 'tour' | 'explore'); headers are hidden by the root Stack.
 */
import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { MapPage } from '@/pages/MapPage';

export default function FullMap(): React.JSX.Element {
  const { p } = useLocalSearchParams<{ p?: string }>();
  return <MapPage mode={p ?? ''} />;
}
