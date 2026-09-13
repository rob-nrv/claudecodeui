import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { IS_PLATFORM } from '../../../shared/utils';
import { useAuth } from '../context/AuthContext';
import Onboarding from '../../onboarding/view/Onboarding';

import AuthLoadingScreen from './AuthLoadingScreen';
import AuthScreenLayout from './AuthScreenLayout';
import LoginForm from './LoginForm';
import RemotePairingForm from './RemotePairingForm';
import SetupForm from './SetupForm';

type ProtectedRouteProps = {
  children: ReactNode;
};

export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { t } = useTranslation('auth');
  const { user, isLoading, needsSetup, hasCompletedOnboarding, refreshOnboardingStatus, transport } = useAuth();

  if (isLoading) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return <>{children}</>;
  }

  // Through the Remote Gateway, the first account is never created and
  // passwords alone never sign in (FT-M08).
  if (transport === 'remote' && needsSetup) {
    return (
      <AuthScreenLayout
        title={t('remotePairing.setupRequiredTitle', { defaultValue: 'Finish setup on the host' })}
        description={t('remotePairing.setupRequired', {
          defaultValue: 'CloudCLI has no account yet. Create it on the machine running CloudCLI, then pair this browser.',
        })}
        footerText=""
      >
        <span />
      </AuthScreenLayout>
    );
  }

  if (transport === 'remote' && !user) {
    return <RemotePairingForm />;
  }

  if (needsSetup) {
    return <SetupForm />;
  }

  if (!user) {
    return <LoginForm />;
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return <>{children}</>;
}
