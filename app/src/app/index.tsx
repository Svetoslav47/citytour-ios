/*
 * Root screen (pages/Index.ets): Onboarding until it is done (persisted UserSettings.onboardingDone), then Home.
 */
import { useSnapshot } from 'valtio';
import { HomePage } from '@/pages/HomePage';
import { OnboardingPage } from '@/pages/OnboardingPage';
import { OnboardingViewModel } from '@/viewmodel/OnboardingViewModel';

export default function Index() {
  const settings = useSnapshot(OnboardingViewModel.settings());
  return settings.onboardingDone ? <HomePage /> : <OnboardingPage asRoute={false} />;
}
