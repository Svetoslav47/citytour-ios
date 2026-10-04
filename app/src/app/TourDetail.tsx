/* Route Routes.TOUR_DETAIL: the tour id travels as the `p` search param. */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { TourDetailPage } from '@/pages/TourDetailPage';

export default function TourDetail(): React.JSX.Element {
  const p = useLocalSearchParams<{ p?: string }>().p;
  return <TourDetailPage tourId={p ?? ''} />;
}
