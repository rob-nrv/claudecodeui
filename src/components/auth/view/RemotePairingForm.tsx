import { useCallback, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Loader2, Lock, User } from 'lucide-react';

import { useAuth } from '../context/AuthContext';

import AuthErrorAlert from './AuthErrorAlert';
import AuthInputField from './AuthInputField';
import AuthScreenLayout from './AuthScreenLayout';

type PairingFormState = {
  username: string;
  password: string;
  pairingCode: string;
};

const initialState: PairingFormState = { username: '', password: '', pairingCode: '' };

/**
 * Sign-in through the Remote Gateway (FT-M08). A remote browser needs the
 * account password AND a one-time pairing code created from a device that is
 * already signed in (Settings > Remote access). Nothing is installed on this
 * device and nothing secret is stored by the page: the server keeps the
 * session behind an HttpOnly cookie.
 */
export default function RemotePairingForm() {
  const { t } = useTranslation('auth');
  const { error: sessionError, pairRemote } = useAuth();
  const [formState, setFormState] = useState<PairingFormState>(initialState);
  const [errorMessage, setErrorMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const updateField = useCallback((field: keyof PairingFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setErrorMessage('');

      if (!formState.username.trim() || !formState.password || !formState.pairingCode.trim()) {
        setErrorMessage(t('remotePairing.errors.requiredFields', { defaultValue: 'Enter your username, password and pairing code.' }));
        return;
      }

      setIsSubmitting(true);
      const result = await pairRemote(formState.username.trim(), formState.password, formState.pairingCode.trim());
      if (!result.success) {
        setErrorMessage(result.error);
        // A failed attempt burns the code on the server; ask for a fresh one.
        setFormState((previous) => ({ ...previous, password: '', pairingCode: '' }));
      }
      setIsSubmitting(false);
    },
    [formState, pairRemote, t],
  );

  return (
    <AuthScreenLayout
      title={t('remotePairing.title', { defaultValue: 'Pair this browser' })}
      description={t('remotePairing.description', {
        defaultValue: 'You are connecting to CloudCLI remotely. Create a pairing code on a device that is already signed in (Settings > Remote access).',
      })}
      footerText={t('remotePairing.footer', { defaultValue: 'Each pairing code works once and expires in 10 minutes.' })}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <AuthInputField
          id="remote-username"
          label={t('login.username')}
          value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('login.placeholders.username')}
          isDisabled={isSubmitting}
          autoComplete="username"
          icon={User}
        />

        <AuthInputField
          id="remote-password"
          label={t('login.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('login.placeholders.password')}
          isDisabled={isSubmitting}
          type="password"
          autoComplete="current-password"
          icon={Lock}
        />

        <AuthInputField
          id="remote-pairing-code"
          label={t('remotePairing.code', { defaultValue: 'Pairing code' })}
          value={formState.pairingCode}
          onChange={(value) => updateField('pairingCode', value.toUpperCase())}
          placeholder="XXXX-XXXX-XXXX"
          isDisabled={isSubmitting}
          autoComplete="one-time-code"
          icon={KeyRound}
        />

        <AuthErrorAlert errorMessage={errorMessage || sessionError || ''} />

        <button
          type="submit"
          disabled={isSubmitting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:shadow-primary/30 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('remotePairing.loading', { defaultValue: 'Pairing…' })}
            </>
          ) : (
            t('remotePairing.submit', { defaultValue: 'Pair and sign in' })
          )}
        </button>
      </form>
    </AuthScreenLayout>
  );
}
