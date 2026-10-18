import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronDown, ChevronRight, Code, File, FileImage, Folder, Monitor, MousePointer2, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import type { Project, ProjectSession } from '../../../../types/app';
import { api, authenticatedFetch } from '../../../../utils/api';
import {
  RUN_TARGET_BLOCK_DEFAULTS,
  RUNTIME_NODE_STATUS_DEFAULTS,
  describeRuntimeNodeStatus,
  readRuntimeTargetChoice,
  selectableRuntimeNodes,
  writeRuntimeTargetChoice,
  type RuntimeNodeView,
  type RuntimeNodesListing,
  type RunTargetResolution,
} from '../../../runtime-nodes/utils/runtimeNodes';
import type { ChatMessage } from '../../types/types';

/*
 * Claude desktop right panel (measured): 278px cards with a 1px #2d2d2d
 * border, radius 8, 12px inset, 10px apart, sticky 17px under the header.
 *
 *  - Environment: the machine the session runs on, its folder, remote access.
 *  - Context: the context window actually used by the session.
 *  - Outputs: files this conversation created or edited.
 *
 * Every row reads real CloudCLI state; nothing here is a placeholder.
 */

type ChatSidePanelProps = {
  project: Project;
  session: ProjectSession | null;
  runtimeListing: RuntimeNodesListing | null;
  /** Where a new session in this project would run (used when no session is open). */
  creationTarget: RunTargetResolution;
  tokenBudget: Record<string, unknown> | null;
  messages: ChatMessage[];
  onFileOpen?: (filePath: string) => void;
  onShowSettings?: () => void;
  /** New session only: choose the machine it will be created and run on (computer / NAS). */
  onSelectNode?: (nodeId: string) => void;
};

const COLLAPSE_KEY = 'claude-side-panel-collapsed';
const OUTPUT_TOOL_NAMES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const IMAGE_EXTENSIONS = /.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i;
const CODE_EXTENSIONS = /\.(c|cc|cpp|cs|css|go|h|hpp|html|java|js|jsx|kt|lua|php|py|rb|rs|scss|sh|sql|swift|ts|tsx|vue|json|ya?ml|toml)$/i;

const readCollapsed = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
};

const formatTokens = (value: number): string => {
  if (value >= 1_000_000) return `${+(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${+(value / 1_000).toFixed(1)}k`;
  return String(Math.max(0, Math.round(value)));
};

const baseName = (filePath: string) => filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;

function Card({ id, title, collapsed, onToggle, children }: { id: string; title: string; collapsed: boolean; onToggle: (id: string) => void; children: ReactNode }) {
  return (
    <section className="rounded-[8px] border border-c-card-border px-3 pb-2 pt-[10.5px]">
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={!collapsed}
        className="flex items-center gap-[5px] text-[13px] font-semibold leading-5 text-c-text"
      >
        {title}
        <ChevronDown className={cn('h-3 w-3 text-c-text-3 transition-transform', collapsed && '-rotate-90')} strokeWidth={2} />
      </button>
      {!collapsed && <div className="mt-1">{children}</div>}
    </section>
  );
}

function Row({ icon, children, trailing, title }: { icon: ReactNode; children: ReactNode; trailing?: ReactNode; title?: string }) {
  return (
    <div className="flex h-[25.25px] items-center gap-[11px] text-[14px] leading-5 text-c-text" title={title}>
      <span className="flex w-[14px] flex-shrink-0 justify-center text-c-text-2">{icon}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate">{children}</span>
      {trailing}
    </div>
  );
}

function describeNode(node: RuntimeNodeView | null, t: (key: string, fallback: string) => string): { label: string; offline: boolean; reason: string | null } {
  if (!node) {
    return { label: t('sidePanel.noMachine', 'No machine selected'), offline: false, reason: null };
  }
  const offline = node.availability.state === 'unavailable';
  return {
    label: node.isLocal ? t('sidePanel.thisComputer', 'This computer') : node.label,
    offline,
    reason: offline ? (node.availability.reason ? String(node.availability.reason) : t('sidePanel.offline', 'Offline')) : null,
  };
}

export default function ChatSidePanel({
  project,
  session,
  runtimeListing,
  creationTarget,
  tokenBudget,
  messages,
  onFileOpen,
  onShowSettings,
  onSelectNode,
}: ChatSidePanelProps) {
  const { t } = useTranslation('chat');
  const tr = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(readCollapsed);
  const [showAllOutputs, setShowAllOutputs] = useState(false);
  const [isMachineMenuOpen, setIsMachineMenuOpen] = useState(false);
  const [remoteState, setRemoteState] = useState<'listening' | 'off' | 'failed' | 'starting' | null>(null);
  const [connectorCount, setConnectorCount] = useState<number | null>(null);
  const [savedNodeId, setSavedNodeId] = useState<string | null>(() => readRuntimeTargetChoice(project.projectId));

  useEffect(() => {
    setSavedNodeId(readRuntimeTargetChoice(project.projectId));
  }, [project.projectId]);

  // Connectors = the MCP servers Claude Code has configured for this project
  // (user, local and project scopes), as listed by the existing MCP module.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const params = new URLSearchParams({ workspacePath: project.fullPath });
        const response = await authenticatedFetch(`/api/providers/claude/mcp/servers?${params.toString()}`);
        const body = response.ok ? await response.json() : null;
        const scopes = (body?.data?.scopes ?? {}) as Record<string, unknown[]>;
        const count = Object.values(scopes).reduce((total, servers) => total + (Array.isArray(servers) ? servers.length : 0), 0);
        if (!cancelled) setConnectorCount(body?.success ? count : null);
      } catch {
        if (!cancelled) setConnectorCount(null);
      }
    })();
    return () => { cancelled = true; };
  }, [project.fullPath]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await api.remoteAccess.status();
        const body = response.ok ? await response.json() : null;
        if (!cancelled) setRemoteState(body?.data?.gateway?.state ?? null);
      } catch {
        if (!cancelled) setRemoteState(null);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggle = (id: string) => {
    setCollapsed((previous) => {
      const next = { ...previous, [id]: !previous[id] };
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
      return next;
    });
  };

  // A session is bound to the node it was created on; a new one follows the project's choice.
  const boundNodeId = (session as Record<string, unknown> | null)?.runtimeNodeId;
  const sessionNodeId = typeof boundNodeId === 'string' && boundNodeId ? boundNodeId : null;
  const node = sessionNodeId
    ? runtimeListing?.nodes.find((candidate) => candidate.nodeId === sessionNodeId) ?? null
    : creationTarget.node ?? (runtimeListing?.nodes.find((candidate) => candidate.isLocal) ?? null);
  const machine = describeNode(node, tr);
  // "Save" makes this machine the project's default for new sessions (the
  // existing per-project runtime choice); it disappears once saved.
  const canSaveMachine = Boolean(node && node.nodeId !== savedNodeId);
  const saveMachine = () => {
    if (!node) return;
    writeRuntimeTargetChoice(project.projectId, node.nodeId);
    setSavedNodeId(node.nodeId);
    if (!session) onSelectNode?.(node.nodeId);
  };
  // A session stays on the node it was created on; only a new one can choose.
  const choosableNodes = session ? [] : selectableRuntimeNodes(runtimeListing);
  const canChooseMachine = Boolean(onSelectNode) && choosableNodes.length > 1;

  const used = Number(tokenBudget?.used) || 0;
  const total = Number(tokenBudget?.total) || 0;
  const percent = total > 0 ? Math.min(100, (used / total) * 100) : 0;

  const outputs = useMemo(() => {
    const seen = new Map<string, string>();
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message.isToolUse || !OUTPUT_TOOL_NAMES.has(String(message.toolName)) || message.toolResult?.isError) continue;
      const input = (typeof message.toolInput === 'object' && message.toolInput ? message.toolInput : {}) as Record<string, unknown>;
      const filePath = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : null;
      if (filePath && !seen.has(filePath)) seen.set(filePath, baseName(filePath));
    }
    return [...seen.entries()];
  }, [messages]);
  const visibleOutputs = showAllOutputs ? outputs : outputs.slice(0, 5);

  const remoteLabel = remoteState === 'listening'
    ? tr('sidePanel.remoteOn', 'On')
    : remoteState === 'failed'
      ? tr('sidePanel.remoteFailed', 'Failed')
      : remoteState === 'starting'
        ? tr('sidePanel.remoteStarting', 'Starting')
        : tr('sidePanel.remoteOff', 'Off');

  return (
    <div className="space-y-[10px]">
      <Card id="environment" title={tr('sidePanel.environment', 'Environment')} collapsed={Boolean(collapsed.environment)} onToggle={toggle}>
        <Row
          icon={node && !node.isLocal ? <Server className="h-[14px] w-[14px]" strokeWidth={1.6} /> : <Monitor className="h-[14px] w-[14px]" strokeWidth={1.6} />}
          title={machine.reason ?? undefined}
          trailing={machine.offline
            ? <span className="flex-shrink-0 text-[12px] text-amber-400">{tr('sidePanel.offline', 'Offline')}</span>
            : canSaveMachine
              ? (
                <button type="button" onClick={saveMachine} title={tr('sidePanel.saveMachineHint', 'Use this machine for new sessions in this project')} className="flex-shrink-0 text-[13px] text-c-text-3 underline decoration-c-text-3/60 underline-offset-[3px] hover:text-c-text">
                  {tr('sidePanel.save', 'Save')}
                </button>
              )
              : undefined}
        >
          {canChooseMachine ? (
            <button
              type="button"
              onClick={() => setIsMachineMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={isMachineMenuOpen}
              className="flex min-w-0 items-center gap-1 hover:text-c-text"
            >
              <span className="truncate">{machine.label}</span>
              <ChevronDown className="h-3 w-3 flex-shrink-0 text-c-text-3" strokeWidth={2} />
            </button>
          ) : (
            <span className="truncate">{machine.label}</span>
          )}
        </Row>
        {canChooseMachine && isMachineMenuOpen && (
          <div role="menu" className="my-1 rounded-md border border-c-card-border bg-c-surface p-1">
            {choosableNodes.map((candidate) => {
              const status = describeRuntimeNodeStatus(candidate);
              const isChosen = candidate.nodeId === node?.nodeId;
              return (
                <button
                  key={candidate.nodeId}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isChosen}
                  onClick={() => { onSelectNode?.(candidate.nodeId); setIsMachineMenuOpen(false); }}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[13px] text-c-text-2 hover:bg-c-active hover:text-c-text"
                >
                  {candidate.isLocal ? <Monitor className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.6} /> : <Server className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={1.6} />}
                  <span className="min-w-0 flex-1 truncate">{candidate.isLocal ? tr('sidePanel.thisComputer', 'This computer') : candidate.label}</span>
                  <span className={cn('flex-shrink-0 text-[11px]', status.emphasis === 'positive' ? 'text-emerald-400' : status.emphasis === 'warning' ? 'text-amber-400' : 'text-c-text-3')}>
                    {t(`runtimeNode.status.${status.key}`, { defaultValue: RUNTIME_NODE_STATUS_DEFAULTS[status.key] })}
                  </span>
                  {isChosen && <Check className="h-3.5 w-3.5 flex-shrink-0 text-c-text" />}
                </button>
              );
            })}
          </div>
        )}
        {!session && creationTarget.blocked && (
          <p className="py-1 text-[12px] leading-4 text-amber-400">
            {t(`runtimeNode.blocked.${creationTarget.blocked}`, {
              defaultValue: RUN_TARGET_BLOCK_DEFAULTS[creationTarget.blocked],
              label: creationTarget.node?.label ?? '',
            })}
          </p>
        )}
        <Row icon={<Folder className="h-[14px] w-[14px]" strokeWidth={1.6} />} title={project.fullPath}>
          <span className="flex-shrink-0">{project.displayName}</span>
          <span className="flex-shrink-0 text-c-text-3">·</span>
          <span className="truncate text-c-text-3">{project.fullPath}</span>
        </Row>
        {/* Claude shows a Remote Control switch here. CloudCLI's remote gateway is
            configured in .env and needs a restart, so the switch shows the real
            state and opens Settings > Remote access instead of toggling. */}
        <Row
          icon={<MousePointer2 className="h-[14px] w-[14px]" strokeWidth={1.6} />}
          trailing={(
            <button
              type="button"
              role="switch"
              aria-checked={remoteState === 'listening'}
              aria-readonly="true"
              onClick={onShowSettings}
              title={`${tr('sidePanel.remoteAccess', 'Remote access')}: ${remoteLabel} — ${tr('sidePanel.remoteHint', 'configured in Settings > Remote access')}`}
              className={cn('relative h-[16px] w-[28px] flex-shrink-0 rounded-full transition-colors', remoteState === 'listening' ? 'bg-c-toggle' : 'bg-c-active')}
            >
              <span className={cn('absolute top-[2px] h-[12px] w-[12px] rounded-full bg-white transition-[left]', remoteState === 'listening' ? 'left-[14px]' : 'left-[2px]')} />
            </button>
          )}
        >
          {tr('sidePanel.remoteAccess', 'Remote access')}
        </Row>
      </Card>

      <Card id="context" title={tr('sidePanel.context', 'Context')} collapsed={Boolean(collapsed.context)} onToggle={toggle}>
        {total > 0 ? (
          <>
            <div className="flex items-baseline justify-between text-[14px] leading-5">
              <span className="font-semibold text-c-text">{t('sidePanel.used', { defaultValue: '{{percent}}% used', percent: Math.round(percent) })}</span>
              <span className="text-[13px] text-c-text-3">{formatTokens(used)} / {formatTokens(total)}</span>
            </div>
            <div className="mt-[7px] h-1 overflow-hidden rounded-full bg-c-active">
              <div className="h-full rounded-full bg-[#3987e5]" style={{ width: `${percent}%` }} />
            </div>
          </>
        ) : (
          <p className="text-[13px] leading-5 text-c-text-3">{tr('sidePanel.contextUnknown', 'Reported after the first reply.')}</p>
        )}
      </Card>

      <section className="flex h-[41px] items-center rounded-[8px] border border-c-card-border px-3">
        <button type="button" onClick={onShowSettings} className="flex items-center gap-[5px] text-[13px] font-semibold text-c-text">
          {tr('sidePanel.connectors', 'Connectors')}
          <ChevronRight className="h-3 w-3 text-c-text-3" strokeWidth={2} />
        </button>
        <div className="flex-1" />
        {connectorCount !== null && (
          <span className="text-[13px] text-c-text-3">{t('sidePanel.connectorsConfigured', { defaultValue: '{{count}} configured', count: connectorCount })}</span>
        )}
      </section>

      <Card id="outputs" title={tr('sidePanel.outputs', 'Outputs')} collapsed={Boolean(collapsed.outputs)} onToggle={toggle}>
        {outputs.length === 0 ? (
          <p className="text-[13px] leading-5 text-c-text-3">{tr('sidePanel.noOutputs', 'Files this session writes appear here.')}</p>
        ) : (
          <>
            {visibleOutputs.map(([filePath, name]) => (
              <button
                key={filePath}
                type="button"
                onClick={() => onFileOpen?.(filePath)}
                title={filePath}
                className="flex h-[26px] w-full items-center gap-[11px] text-left text-[14px] text-c-text hover:text-c-text"
              >
                <span className="flex w-[14px] flex-shrink-0 justify-center text-c-text-2">
                  {CODE_EXTENSIONS.test(name)
                    ? <Code className="h-[14px] w-[14px]" strokeWidth={1.6} />
                    : IMAGE_EXTENSIONS.test(name)
                      ? <FileImage className="h-[14px] w-[14px]" strokeWidth={1.6} />
                      : <File className="h-[14px] w-[14px]" strokeWidth={1.6} />}
                </span>
                <span className="truncate hover:underline">{name}</span>
              </button>
            ))}
            {outputs.length > 5 && (
              <button type="button" onClick={() => setShowAllOutputs((value) => !value)} className="mt-[3px] flex items-center gap-1 text-[13px] text-c-text-3 hover:text-c-text-2">
                {showAllOutputs ? tr('sidePanel.showLess', 'Show less') : tr('sidePanel.showMore', 'Show more')}
                {!showAllOutputs && <ChevronRight className="h-3 w-3" />}
              </button>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
