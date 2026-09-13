import { useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Input } from '../../../shared/view/ui';
import { useRuntimeNodes } from '../../runtime-nodes/hooks/useRuntimeNodes';
import {
  CAPABILITY_EVIDENCE_DEFAULTS,
  CAPABILITY_LABEL_DEFAULTS,
  describeCapabilityEvidence,
  describeResources,
  describeRuntimeNodeStatus,
  formatEvidenceReason,
  RESOURCES_DEFAULTS,
  type RuntimeNodeStatusDisplay,
  type RuntimeNodeView,
} from '../../runtime-nodes/utils/runtimeNodes';
import SettingsCard from '../../settings/view/SettingsCard';
import SettingsRow from '../../settings/view/SettingsRow';
import SettingsSection from '../../settings/view/SettingsSection';
import { useRemoteAccess } from '../hooks/useRemoteAccess';
import {
  buildNodeAgentCommands,
  describeGateway,
  describeLocalListener,
  resolveEnrollmentOrigin,
  type StatusDisplay,
} from '../utils/remoteAccess';

const EMPHASIS_CLASS: Record<StatusDisplay['emphasis'], string> = {
  positive: 'text-emerald-700 dark:text-emerald-400',
  warning: 'text-amber-700 dark:text-amber-400',
  muted: 'text-muted-foreground',
};

const GATEWAY_DEFAULTS: Record<string, string> = {
  listening: 'Listening',
  failed: 'Not running',
  starting: 'Starting',
  off: 'Off',
};

const LISTENER_DEFAULTS: Record<string, string> = {
  loopbackOnly: 'This machine only',
  exposed: 'Reachable from the network',
};

const NODE_STATUS_DEFAULTS: Record<RuntimeNodeStatusDisplay['key'], string> = {
  available: 'Available',
  claudeUnavailable: 'Claude CLI not found',
  notResponding: 'Status out of date',
  unknown: 'Status not checked yet',
  offline: 'Offline',
  checking: 'Checking…',
  conflict: 'Credential in use elsewhere',
  incompatible: 'Needs update',
  revoked: 'Revoked',
  neverConnected: 'Never connected',
};

const formatTime = (value: string) => new Date(value).toLocaleString();

const formatBytes = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);

/**
 * What a node has actually proved, expandable under its row (FT-M09): each
 * capability with its evidence state, freshness and short detail, plus the
 * node's Resource Governor report. Unknown stays unknown.
 */
function NodeEvidence({ node }: { node: RuntimeNodeView }) {
  const { t } = useTranslation('settings');
  const resources = node.resources ?? null;
  return (
    <details className="px-4 pb-3 text-xs">
      <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">
        {t('remoteAccess.nodes.evidence.title', { defaultValue: 'What this node has proved' })}
      </summary>
      <ul className="mt-2 space-y-1">
        {node.capabilities.map((capability) => {
          const display = describeCapabilityEvidence(capability);
          const note = capability.detail ?? formatEvidenceReason(capability.reason);
          return (
            <li key={capability.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium text-foreground">
                {t(`remoteAccess.nodes.evidence.capability.${capability.id}`, { defaultValue: CAPABILITY_LABEL_DEFAULTS[capability.id] })}
              </span>
              <span className={EMPHASIS_CLASS[display.emphasis]}>
                {t(`remoteAccess.nodes.evidence.state.${display.key}`, { defaultValue: CAPABILITY_EVIDENCE_DEFAULTS[display.key] })}
              </span>
              {note && <span className="text-muted-foreground">{note}</span>}
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-muted-foreground">
        {resources ? (
          <>
            <span className={EMPHASIS_CLASS[describeResources(resources).emphasis]}>
              {t(`remoteAccess.nodes.evidence.resources.${describeResources(resources).key}`, {
                defaultValue: RESOURCES_DEFAULTS[describeResources(resources).key],
                active: resources.activeRuns,
                max: resources.maxConcurrentRuns,
              })}
            </span>
            {' · '}
            {resources.storage.state === 'known'
              ? t('remoteAccess.nodes.evidence.storage', { defaultValue: '{{free}} free', free: formatBytes(resources.storage.freeBytes) })
              : t('remoteAccess.nodes.evidence.storageUnknown', { defaultValue: 'storage unknown' })}
            {' · '}
            {resources.battery.state === 'known'
              ? t('remoteAccess.nodes.evidence.battery', {
                defaultValue: 'battery {{percent}}%{{charging}}',
                percent: resources.battery.percent,
                charging: resources.battery.charging ? ' (charging)' : '',
              })
              : t('remoteAccess.nodes.evidence.batteryUnknown', { defaultValue: 'battery unknown' })}
          </>
        ) : (
          t('remoteAccess.nodes.evidence.noResources', { defaultValue: 'No resource report on the current connection.' })
        )}
      </p>
    </details>
  );
}

/**
 * Settings > Remote access (FT-M08): whether the remote gateway listens, pairing
 * codes and paired browsers, and RuntimeNode enrollment and revocation.
 */
export default function RemoteAccessSettingsTab() {
  const { t } = useTranslation('settings');
  const remote = useRemoteAccess();
  const runtimeNodes = useRuntimeNodes(null);
  const [nodeLabel, setNodeLabel] = useState('');

  const status = remote.status;
  const gateway = status ? describeGateway(status.gateway) : null;
  const listener = status ? describeLocalListener(status.localListener) : null;
  const enrollmentOrigin = resolveEnrollmentOrigin(status?.gateway ?? null, window.location.origin);
  const remoteNodes = runtimeNodes.listing?.nodes.filter((node) => !node.isLocal) ?? [];

  const handleEnroll = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await remote.createEnrollment(nodeLabel.trim());
    setNodeLabel('');
  };

  const handleRevokeNode = async (nodeId: string, label: string) => {
    const confirmed = window.confirm(t('remoteAccess.nodes.revokeConfirm', {
      defaultValue: 'Revoke "{{label}}"? It is disconnected now, its runs stop, and it must enroll again as a new node.',
      label,
    }));
    if (confirmed && await remote.revokeNode(nodeId)) {
      await runtimeNodes.refresh();
    }
  };

  return (
    <div className="space-y-6 md:space-y-8">
      {remote.error && (
        <p role="alert" className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          {remote.error}
        </p>
      )}

      <SettingsSection
        title={t('remoteAccess.gateway.title', { defaultValue: 'Remote gateway' })}
        description={t('remoteAccess.gateway.description', {
          defaultValue: 'Browsers on other devices reach CloudCLI only through this separate HTTPS listener. It is configured on the host (CLOUDCLI_REMOTE_GATEWAY).',
        })}
      >
        <SettingsCard divided>
          <SettingsRow
            label={t('remoteAccess.gateway.state', { defaultValue: 'Gateway' })}
            description={status?.gateway.state === 'listening'
              ? `${status.gateway.publicOrigin} (${status.gateway.mode})`
              : status?.gateway.error ?? t('remoteAccess.gateway.offHint', { defaultValue: 'Remote access is off.' })}
          >
            {gateway && (
              <span className={`text-sm font-medium ${EMPHASIS_CLASS[gateway.emphasis]}`}>
                {t(`remoteAccess.gateway.states.${gateway.key}`, { defaultValue: GATEWAY_DEFAULTS[gateway.key] })}
              </span>
            )}
          </SettingsRow>
          <SettingsRow
            label={t('remoteAccess.gateway.appPort', { defaultValue: 'App port' })}
            description={status ? `${status.localListener.host}:${status.localListener.port}` : undefined}
          >
            {listener && (
              <span className={`text-sm font-medium ${EMPHASIS_CLASS[listener.emphasis]}`}>
                {t(`remoteAccess.gateway.listener.${listener.key}`, { defaultValue: LISTENER_DEFAULTS[listener.key] })}
              </span>
            )}
          </SettingsRow>
          <SettingsRow
            label={t('remoteAccess.gateway.thisBrowser', { defaultValue: 'This browser' })}
            description={status?.transport === 'remote'
              ? t('remoteAccess.gateway.viaGateway', { defaultValue: 'Connected through the remote gateway' })
              : t('remoteAccess.gateway.viaLocal', { defaultValue: 'Connected on this machine' })}
          >
            <span />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('remoteAccess.browsers.title', { defaultValue: 'Paired browsers' })}
        description={t('remoteAccess.browsers.description', {
          defaultValue: 'A browser opening the gateway signs in with the password and a pairing code created here. Each code works once and expires in 10 minutes.',
        })}
      >
        <SettingsCard divided>
          <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
            <Button type="button" size="sm" onClick={() => void remote.createPairingCode()}>
              {t('remoteAccess.browsers.createCode', { defaultValue: 'Create pairing code' })}
            </Button>
            {remote.pairingCode && (
              <div className="min-w-0 text-sm">
                <code className="select-all rounded bg-muted px-2 py-1 font-mono text-base tracking-wider text-foreground">
                  {remote.pairingCode.code}
                </code>
                <span className="ml-2 text-xs text-muted-foreground">
                  {t('remoteAccess.expires', { defaultValue: 'expires {{time}}', time: formatTime(remote.pairingCode.expiresAt) })}
                </span>
              </div>
            )}
          </div>
          {(status?.sessions ?? []).map((session) => (
            <SettingsRow
              key={session.sessionId}
              label={`${session.label ?? t('remoteAccess.browsers.unknownBrowser', { defaultValue: 'Browser' })}${session.current ? ` · ${t('remoteAccess.browsers.current', { defaultValue: 'this browser' })}` : ''}`}
              description={t('remoteAccess.browsers.lastSeen', { defaultValue: 'Last active {{time}}', time: formatTime(session.lastSeenAt) })}
            >
              <Button type="button" variant="outline" size="sm" onClick={() => void remote.revokeSession(session.sessionId)}>
                {t('remoteAccess.revoke', { defaultValue: 'Revoke' })}
              </Button>
            </SettingsRow>
          ))}
          {status && status.sessions.length === 0 && (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              {t('remoteAccess.browsers.none', { defaultValue: 'No browser is paired.' })}
            </p>
          )}
          {status && status.sessions.length > 1 && (
            <div className="px-4 py-3">
              <Button type="button" variant="ghost" size="sm" onClick={() => void remote.revokeAllSessions()}>
                {t('remoteAccess.browsers.revokeAll', { defaultValue: 'Sign out all remote browsers' })}
              </Button>
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('remoteAccess.nodes.title', { defaultValue: 'Runtime nodes' })}
        description={t('remoteAccess.nodes.description', {
          defaultValue: 'Machines that run sessions. A node connects out to this server with its own key; its Claude login and files stay on that machine.',
        })}
      >
        <SettingsCard divided>
          <form onSubmit={handleEnroll} className="flex flex-col gap-2 px-4 py-4 sm:flex-row">
            <label htmlFor="runtime-node-label" className="sr-only">
              {t('remoteAccess.nodes.label', { defaultValue: 'Node name' })}
            </label>
            <Input
              id="runtime-node-label"
              value={nodeLabel}
              maxLength={64}
              onChange={(event) => setNodeLabel(event.target.value)}
              placeholder={t('remoteAccess.nodes.labelPlaceholder', { defaultValue: 'Node name, e.g. NAS' })}
              className="sm:max-w-xs"
            />
            <Button type="submit" size="sm">
              {t('remoteAccess.nodes.enroll', { defaultValue: 'Create enrollment code' })}
            </Button>
          </form>
          {remote.enrollment && (
            <div className="space-y-2 px-4 py-4 text-sm">
              <p className="text-muted-foreground">
                {t('remoteAccess.nodes.instructions', {
                  defaultValue: 'On the node (CloudCLI installed, Claude Code signed in), run — the code expires {{time}}:',
                  time: formatTime(remote.enrollment.expiresAt),
                })}
              </p>
              <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs text-foreground">
                {buildNodeAgentCommands(enrollmentOrigin, remote.enrollment.code).join('\n')}
              </pre>
            </div>
          )}
          {remoteNodes.map((node) => {
            const display = describeRuntimeNodeStatus(node);
            return (
              <div key={node.nodeId}>
                <SettingsRow
                  label={node.label}
                  description={[node.platform, node.arch, node.runtimeVersion].filter(Boolean).join(' · ') || undefined}
                >
                  <div className="flex items-center gap-3">
                    <span className={`text-sm ${EMPHASIS_CLASS[display.emphasis]}`}>
                      {t(`remoteAccess.nodes.status.${display.key}`, { defaultValue: NODE_STATUS_DEFAULTS[display.key] })}
                    </span>
                    {node.enrollment === 'active' && (
                      <Button type="button" variant="outline" size="sm" onClick={() => void handleRevokeNode(node.nodeId, node.label)}>
                        {t('remoteAccess.revoke', { defaultValue: 'Revoke' })}
                      </Button>
                    )}
                  </div>
                </SettingsRow>
                {node.enrollment !== 'revoked' && <NodeEvidence node={node} />}
              </div>
            );
          })}
          {runtimeNodes.listing && remoteNodes.length === 0 && (
            <p className="px-4 py-4 text-sm text-muted-foreground">
              {t('remoteAccess.nodes.none', { defaultValue: 'Only this machine runs sessions.' })}
            </p>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
