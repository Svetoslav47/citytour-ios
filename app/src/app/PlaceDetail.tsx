import { useLocalSearchParams } from 'expo-router';
import React from 'react';
import { PlaceDetailPage } from '@/pages/PlaceDetailPage';

export default function PlaceDetailRoute(): React.JSX.Element {
  const p = useLocalSearchParams<{ p?: string }>().p;
  return <PlaceDetailPage poiId={p ?? ''} />;
}
