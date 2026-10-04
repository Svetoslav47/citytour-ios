/* Route '/Onboarding' (Routes.ONBOARDING in AppViewModel): the onboarding replay from Settings › Show intro. */
import React from 'react';
import { OnboardingPage } from '@/pages/OnboardingPage';

export default function OnboardingRoute(): React.JSX.Element {
  return <OnboardingPage asRoute={true} />;
}
