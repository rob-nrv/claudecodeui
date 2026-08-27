import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge, Button, Input } from '../../../../../../../shared/view/ui';
import ProviderLoginModal from '../../../../../../provider-auth/view/ProviderLoginModal';
import { useClaudeProfiles, type ClaudeProfile } from '../../../../../hooks/useClaudeProfiles';

const connectionBadgeClass = (state: ClaudeProfile['connectionState']): string => {
  switch (state) {
    case 'connected':
      return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
    case 'not_authenticated':
    case 'expired':
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';
    default:
      return 'bg-muted';
  }
};

type ProfileRowProps = {
  profile: ClaudeProfile;
  pending: boolean;
  onLogin: (profile: ClaudeProfile) => void;
  onVerify: (id: string) => void;
  onSetDefault: (id: string) => void;
  onRename: (id: string, displayName: string) => Promise<boolean>;
  onRemove: (id: string) => void;
};

function ProfileRow({ profile, pending, onLogin, onVerify, onSetDefault, onRename, onRemove }: ProfileRowProps) {
  const { t } = useTranslation('settings');
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(profile.displayName);
  const [isConfirmingRemove, setIsConfirmingRemove] = useState(false);
  const [removeConfirmText, setRemoveConfirmText] = useState('');

  const isConnected = profile.connectionState === 'connected';

  const submitRename = async () => {
    const ok = await onRename(profile.id, renameValue);
    if (ok) {
      setIsRenaming(false);
    }
  };

  return (
    <div className="rounded-lg border border-border/50 bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submitRename();
                  if (event.key === 'Escape') setIsRenaming(false);
                }}
                className="h-8 max-w-xs"
              />
              <Button size="sm" className="h-8" onClick={() => void submitRename()}>
                {t('claudeProfiles.actions.save')}
              </Button>
              <Button size="sm" variant="ghost" className="h-8" onClick={() => setIsRenaming(false)}>
                {t('claudeProfiles.actions.cancel')}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-foreground">{profile.displayName}</span>
              {profile.isDefault && (
                <Badge variant="secondary" className="bg-muted text-xs">
                  {t('claudeProfiles.default')}
                </Badge>
              )}
            </div>
          )}

          <div className="mt-1 text-sm text-muted-foreground">
            {profile.verifiedIdentity
              ? profile.verifiedIdentity.value
              : t('claudeProfiles.identityNotVerified')}
            {profile.verifiedIdentity?.tier && (
              <span className="ml-1 text-xs uppercase text-muted-foreground/80">
                · {profile.verifiedIdentity.tier}
              </span>
            )}
          </div>
        </div>

        <Badge variant="secondary" className={connectionBadgeClass(profile.connectionState)}>
          {t(`claudeProfiles.connectionState.${profile.connectionState}`)}
        </Badge>
      </div>

      {!isRenaming && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={() => onLogin(profile)}
          >
            {isConnected ? t('claudeProfiles.actions.relogin') : t('claudeProfiles.actions.login')}
          </Button>
          {isConnected && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              disabled={pending}
              onClick={() => onVerify(profile.id)}
            >
              {pending ? t('claudeProfiles.actions.verifying') : t('claudeProfiles.actions.verify')}
            </Button>
          )}
          {!profile.isDefault && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs"
              onClick={() => onSetDefault(profile.id)}
            >
              {t('claudeProfiles.actions.setDefault')}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => {
              setRenameValue(profile.displayName);
              setIsRenaming(true);
            }}
          >
            {t('claudeProfiles.actions.rename')}
          </Button>

          {isConfirmingRemove ? (
            <div className="flex items-center gap-2">
              <Input
                autoFocus
                placeholder={profile.displayName}
                value={removeConfirmText}
                onChange={(event) => setRemoveConfirmText(event.target.value)}
                className="h-7 w-40 text-xs"
              />
              <Button
                size="sm"
                variant="destructive"
                className="h-7 text-xs"
                disabled={removeConfirmText.trim() !== profile.displayName}
                onClick={() => {
                  onRemove(profile.id);
                  setIsConfirmingRemove(false);
                  setRemoveConfirmText('');
                }}
              >
                {t('claudeProfiles.actions.confirmRemove')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => {
                  setIsConfirmingRemove(false);
                  setRemoveConfirmText('');
                }}
              >
                {t('claudeProfiles.actions.cancel')}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-red-600 hover:text-red-700 dark:text-red-400"
              onClick={() => setIsConfirmingRemove(true)}
            >
              {t('claudeProfiles.actions.remove')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

type ClaudeAccountsSectionProps = {
  agent: 'claude' | 'cursor' | 'codex' | 'opencode';
};

/**
 * Multi-account Claude profiles, rendered below the existing single-account
 * status card (`AccountContent.tsx`, untouched). Structurally always mounted
 * for the Claude account category so a first profile can be created, but its
 * footprint is a small "+ Add account" affordance until one exists — see
 * `CLOUDCLI_EXTENSION_PLAN.md` §6.1/§9.3.
 *
 * `loading` only ever gates the very first render (before the initial list
 * fetch settles) — every later refresh uses `refreshing` instead, which must
 * never hide this section. It used to gate on every refresh, including the
 * one a successful "+ Add account" triggers, which made Save look like it
 * did nothing (the whole section, form included, blinked away and back).
 *
 * "Login"/"Re-login" reuses the exact same `ProviderLoginModal` +
 * `StandaloneShell` terminal the historical account's login button already
 * uses (`AccountContent.tsx`, untouched, has its own separate instance) — it
 * is not a second login system. The only difference is this modal also
 * carries `claudeProfileId`, so the backend scopes `CLAUDE_CONFIG_DIR` to
 * that one profile's own directory for the login shell it spawns.
 */
export default function ClaudeAccountsSection({ agent }: ClaudeAccountsSectionProps) {
  const { t } = useTranslation('settings');
  const {
    profiles,
    loading,
    creating,
    error,
    justCreated,
    pendingProfileId,
    createProfile,
    renameProfile,
    setDefaultProfile,
    removeProfile,
    verifyProfile,
    dismissJustCreated,
  } = useClaudeProfiles();

  const [isAdding, setIsAdding] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [loginTarget, setLoginTarget] = useState<ClaudeProfile | null>(null);

  if (agent !== 'claude' || loading) {
    return null;
  }

  const submitNewProfile = async () => {
    const ok = await createProfile(newProfileName);
    if (ok) {
      setIsAdding(false);
      setNewProfileName('');
    }
    // On failure, the form stays open and `error` (from the hook) renders
    // below it — Save never silently succeeds or silently fails.
  };

  const handleLoginComplete = () => {
    if (!loginTarget) {
      return;
    }
    // Never rely on the terminal's exit code alone to decide "connected":
    // re-probe this profile's real state via `claude auth status`, exactly
    // as the historical account's login flow re-probes its own status
    // rather than trusting the process exit code.
    void verifyProfile(loginTarget.id);
  };

  return (
    <div className="mt-6 space-y-3">
      <div>
        <h4 className="text-sm font-medium text-foreground">{t('claudeProfiles.title')}</h4>
        <p className="text-xs text-muted-foreground">{t('claudeProfiles.description')}</p>
      </div>

      {profiles.length > 0 && (
        <div className="space-y-2">
          {profiles.map((profile) => (
            <ProfileRow
              key={profile.id}
              profile={profile}
              pending={pendingProfileId === profile.id}
              onLogin={setLoginTarget}
              onVerify={(id) => void verifyProfile(id)}
              onSetDefault={(id) => void setDefaultProfile(id)}
              onRename={renameProfile}
              onRemove={(id) => void removeProfile(id)}
            />
          ))}
        </div>
      )}

      {justCreated && (
        <div className="text-sm text-green-700 dark:text-green-400">
          {t('claudeProfiles.addedConfirmation', { name: justCreated.displayName })}
        </div>
      )}

      {isAdding ? (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            placeholder={t('claudeProfiles.newAccountPlaceholder')}
            value={newProfileName}
            disabled={creating}
            onChange={(event) => setNewProfileName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submitNewProfile();
              if (event.key === 'Escape' && !creating) setIsAdding(false);
            }}
            className="h-8 max-w-xs"
          />
          <Button size="sm" className="h-8" disabled={creating || !newProfileName.trim()} onClick={() => void submitNewProfile()}>
            {creating ? t('claudeProfiles.actions.saving') : t('claudeProfiles.actions.save')}
          </Button>
          <Button size="sm" variant="ghost" className="h-8" disabled={creating} onClick={() => setIsAdding(false)}>
            {t('claudeProfiles.actions.cancel')}
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs"
          onClick={() => {
            dismissJustCreated();
            setIsAdding(true);
          }}
        >
          {t('claudeProfiles.actions.addAccount')}
        </Button>
      )}

      {error && (
        <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
      )}

      <ProviderLoginModal
        isOpen={loginTarget !== null}
        provider="claude"
        claudeProfileId={loginTarget?.id ?? null}
        onComplete={handleLoginComplete}
        onClose={() => setLoginTarget(null)}
      />
    </div>
  );
}
