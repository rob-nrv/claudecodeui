import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../../../shared/view/ui';
import { useAppUserIdentity } from '../../../../hooks/useAppUserIdentity';
import { useAuth } from '../../../auth/context/AuthContext';
import IdentityMonogram from '../../../identity/view/IdentityMonogram';
import { api } from '../../../../utils/api';
import SettingsCard from '../SettingsCard';
import SettingsSection from '../SettingsSection';

const MAX_DISPLAY_NAME_LENGTH = 60;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * Settings → Profile: the app user's own identity.
 *
 * Deliberately small. This is not account management — there is no signup,
 * no roles, no second user. It exposes exactly the three values every
 * identity surface derives from: the avatar initial, the display name and
 * the registered username. The values live in this installation's user
 * record, so a fork or a second install shows its own user.
 */
export default function ProfileSettingsTab() {
  const { t } = useTranslation('settings');
  const { refreshUser } = useAuth();
  const identity = useAppUserIdentity();

  const [draftDisplayName, setDraftDisplayName] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');

  // Seed (and re-seed) the field from the server-owned record rather than
  // keeping a second copy of the name in component state.
  useEffect(() => {
    setDraftDisplayName(identity.isFallback ? '' : identity.displayName);
  }, [identity.displayName, identity.isFallback]);

  const save = async () => {
    setSaveState('saving');
    try {
      const response = await api.auth.updateProfile(draftDisplayName.trim());
      if (!response.ok) {
        setSaveState('error');
        return;
      }
      await refreshUser();
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  };

  return (
    <div className="space-y-6">
      <SettingsSection
        title={t('profile.title', 'Profile')}
        description={t('profile.description', 'How you appear in CloudCLI. Stored on this installation only.')}
      >
        <SettingsCard className="p-4">
          <div className="flex items-center gap-4">
            <IdentityMonogram monogram={identity.monogram} size="lg" muted={identity.isFallback} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-base font-semibold text-foreground" title={identity.displayName}>
                {identity.displayName}
              </div>
              <div className="truncate text-sm text-muted-foreground">
                {identity.username
                  ? `@${identity.username}`
                  : t('profile.noUsername', 'No username on record')}
              </div>
            </div>
          </div>

          <div className="mt-5 space-y-2">
            <label htmlFor="profile-display-name" className="block text-sm font-medium text-foreground">
              {t('profile.displayNameLabel', 'Display name')}
            </label>
            <Input
              id="profile-display-name"
              value={draftDisplayName}
              maxLength={MAX_DISPLAY_NAME_LENGTH}
              placeholder={identity.username ?? t('profile.displayNamePlaceholder', 'Your name')}
              onChange={(event) => {
                setDraftDisplayName(event.target.value);
                setSaveState('idle');
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void save();
              }}
            />
            <p className="text-xs text-muted-foreground">
              {t('profile.displayNameHelp', 'Leave empty to use your username.')}
            </p>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <Button size="sm" onClick={() => void save()} disabled={saveState === 'saving'}>
              {saveState === 'saving' ? t('profile.saving', 'Saving…') : t('profile.save', 'Save')}
            </Button>
            {saveState === 'saved' && (
              <span className="text-xs text-muted-foreground">{t('profile.saved', 'Saved')}</span>
            )}
            {saveState === 'error' && (
              <span className="text-xs text-destructive">
                {t('profile.saveFailed', "Couldn't save your name. Try again.")}
              </span>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('profile.accountTitle', 'Sign-in')}
        description={t('profile.accountDescription', 'The username you sign in with. It cannot be changed here.')}
      >
        <SettingsCard className="px-4 py-4">
          <div className="text-sm font-medium text-foreground">{t('account.username', 'Username')}</div>
          <div className="mt-0.5 truncate text-sm text-muted-foreground">
            {identity.username ?? t('profile.noUsername', 'No username on record')}
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
