import { useCallback, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Check, FolderInput, Loader2, RefreshCw, Server } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useProjectWorkspaceState } from '../hooks/useProjectWorkspaceState';
import type { MapWorkspaceResult } from '../hooks/useRuntimeNodes';
import {
  describeRuntimeNodeStatus,
  describeWorkspaceState,
  needsRuntimePicker,
  RUN_TARGET_BLOCK_DEFAULTS,
  selectableRuntimeNodes,
  WORKSPACE_STATE_DEFAULTS,
  type RunTargetResolution,
  type RuntimeNodeStatusDisplay,
  type RuntimeNodesListing,
} from '../utils/runtimeNodes';

import RuntimeNodeTargetLine from './RuntimeNodeTargetLine';

/** Everything the new-session surface needs about runtime targeting (FT-M08). */
export type RuntimeNodePickerModel = {
  listing: RuntimeNodesListing | null;
  loading: boolean;
  error: string | null;
  target: RunTargetResolution;
  projectId: string | null;
  select(nodeId: string): void;
  refresh(): void;
  mapWorkspace(nodeId: string, folderPath: string): Promise<MapWorkspaceResult>;
};

const EMPHASIS_CLASS: Record<RuntimeNodeStatusDisplay['emphasis'], string> = {
  positive: 'text-emerald-700 dark:text-emerald-400',
  warning: 'text-amber-700 dark:text-amber-400',
  muted: 'text-muted-foreground',
};

const STATUS_DEFAULTS: Record<RuntimeNodeStatusDisplay['key'], string> = {
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

/**
 * Compact runtime target choice on the new-session surface (FT-M08). With a
 * single node it stays the one informational line from FT-M07. With several
 * nodes it is a keyboard-navigable radio group whose states are always spelled
 * out in text; a blocked target explains why, and a remote node without a
 * folder for this project can be mapped in place.
 */
export default function RuntimeNodePicker({ model, className = '' }: { model: RuntimeNodePickerModel; className?: string }) {
  const { t } = useTranslation('chat');
  const groupRef = useRef<HTMLDivElement>(null);
  const [mappingNodeId, setMappingNodeId] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState('');
  const [mappingError, setMappingError] = useState<string | null>(null);
  const [isMapping, setIsMapping] = useState(false);

  const nodes = selectableRuntimeNodes(model.listing);
  const { target } = model;
  // FT-M09: the chosen remote node's own copy of this project, inspected by that node.
  const workspaceState = useProjectWorkspaceState(
    target.nodeId,
    model.projectId,
    needsRuntimePicker(model.listing) && target.isRemote && !target.blocked,
  );

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) {
      return;
    }
    const radios = Array.from(groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []);
    const currentIndex = radios.findIndex((radio) => radio === document.activeElement);
    if (radios.length === 0) {
      return;
    }
    event.preventDefault();
    let nextIndex = currentIndex < 0 ? 0 : currentIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = radios.length - 1;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (nextIndex + 1) % radios.length;
    else nextIndex = (nextIndex - 1 + radios.length) % radios.length;
    radios[nextIndex].focus();
    radios[nextIndex].click();
  }, []);

  const handleMapSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!mappingNodeId || !folderPath.trim()) {
      return;
    }
    setIsMapping(true);
    setMappingError(null);
    const result = await model.mapWorkspace(mappingNodeId, folderPath.trim());
    setIsMapping(false);
    if (result.ok) {
      setMappingNodeId(null);
      setFolderPath('');
    } else {
      setMappingError(result.error);
    }
  }, [folderPath, mappingNodeId, model]);

  if (!needsRuntimePicker(model.listing)) {
    return (
      <RuntimeNodeTargetLine
        listing={model.listing}
        loading={model.loading}
        error={model.error}
        className={className}
      />
    );
  }

  const labelId = 'runtime-node-picker-label';
  const targetLabel = target.node?.label ?? '';
  const canMapFolder = Boolean(
    model.projectId
    && target.node
    && target.isRemote
    && target.node.canExecute
    && (target.blocked === 'workspace_unmapped' || target.blocked === 'workspace_unavailable'),
  );

  return (
    <div className={`w-full max-w-md ${className}`}>
      <div className="flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
        <Server className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span id={labelId}>{t('runtimeNode.runOn', { defaultValue: 'Run on' })}</span>
        <button
          type="button"
          onClick={model.refresh}
          className="rounded p-1 hover:bg-accent hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          aria-label={t('runtimeNode.refresh', { defaultValue: 'Refresh runtime nodes' })}
        >
          <RefreshCw className={`h-3 w-3 ${model.loading ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>
      </div>

      <div
        ref={groupRef}
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={handleKeyDown}
        className="mt-1.5 flex flex-wrap justify-center gap-1.5"
      >
        {nodes.map((node, index) => {
          const isSelected = target.nodeId === node.nodeId;
          const status = describeRuntimeNodeStatus(node);
          const tabIndex = isSelected || (!target.nodeId && index === 0) ? 0 : -1;
          return (
            <button
              key={node.nodeId}
              type="button"
              role="radio"
              aria-checked={isSelected}
              tabIndex={tabIndex}
              onClick={() => model.select(node.nodeId)}
              className={`flex min-h-9 max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:min-h-7 ${
                isSelected
                  ? 'border-primary/60 bg-primary/10 text-foreground'
                  : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground'
              }`}
            >
              {isSelected && <Check className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />}
              <span className="max-w-28 truncate font-medium" title={node.label}>{node.label}</span>
              {node.isLocal && (
                <span className="shrink-0 text-muted-foreground">{t('runtimeNode.thisServer', { defaultValue: '(this server)' })}</span>
              )}
              <span aria-hidden="true">·</span>
              <span className={`shrink-0 ${EMPHASIS_CLASS[status.emphasis]}`}>
                {t(`runtimeNode.status.${status.key}`, { defaultValue: STATUS_DEFAULTS[status.key] })}
              </span>
            </button>
          );
        })}
      </div>

      {target.blocked ? (
        <p role="alert" className="mt-1.5 text-center text-[11px] text-amber-700 dark:text-amber-400">
          {t(`runtimeNode.blocked.${target.blocked}`, { defaultValue: RUN_TARGET_BLOCK_DEFAULTS[target.blocked], label: targetLabel })}
        </p>
      ) : target.isRemote && target.node ? (
        <>
          <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
            {t('runtimeNode.remoteNote', {
              defaultValue: 'Uses {{label}}’s own Claude login. Files, Git and Shell still show this server.',
              label: targetLabel,
            })}
          </p>
          <p className="mt-1 text-center text-[11px] text-muted-foreground" aria-live="polite">
            {t('runtimeNode.workspace.prefix', { defaultValue: 'Folder on {{label}}:', label: targetLabel })}{' '}
            {workspaceState.loading ? (
              t('runtimeNode.workspace.checking', { defaultValue: 'checking…' })
            ) : workspaceState.workspace ? (() => {
              const display = describeWorkspaceState(workspaceState.workspace);
              const branch = workspaceState.workspace.git?.branch;
              return (
                <span className={EMPHASIS_CLASS[display.emphasis]}>
                  {t(`runtimeNode.workspace.state.${display.key}`, {
                    defaultValue: WORKSPACE_STATE_DEFAULTS[display.key],
                    count: workspaceState.workspace.changes?.total ?? 0,
                  })}
                  {branch ? ` · ${branch}` : ''}
                </span>
              );
            })() : (
              t('runtimeNode.workspace.unreadable', { defaultValue: 'state could not be read' })
            )}
          </p>
        </>
      ) : null}

      {canMapFolder && mappingNodeId !== target.nodeId && (
        <div className="mt-1.5 flex justify-center">
          <button
            type="button"
            onClick={() => {
              setMappingNodeId(target.nodeId);
              setMappingError(null);
            }}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <FolderInput className="h-3 w-3" aria-hidden="true" />
            {t('runtimeNode.mapFolder', { defaultValue: 'Map a folder on {{label}}', label: targetLabel })}
          </button>
        </div>
      )}

      {canMapFolder && mappingNodeId === target.nodeId && (
        <form onSubmit={handleMapSubmit} className="mt-2 flex flex-col gap-1.5 sm:flex-row">
          <label htmlFor="runtime-node-folder" className="sr-only">
            {t('runtimeNode.folderLabel', { defaultValue: 'Project folder on {{label}}', label: targetLabel })}
          </label>
          <input
            id="runtime-node-folder"
            value={folderPath}
            onChange={(event) => setFolderPath(event.target.value)}
            placeholder={t('runtimeNode.folderPlaceholder', { defaultValue: 'Folder path on {{label}}', label: targetLabel })}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <div className="flex gap-1.5">
            <button
              type="submit"
              disabled={isMapping || !folderPath.trim()}
              className="flex flex-1 items-center justify-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-60 sm:flex-none"
            >
              {isMapping && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
              {t('runtimeNode.verifyFolder', { defaultValue: 'Verify on node' })}
            </button>
            <button
              type="button"
              onClick={() => setMappingNodeId(null)}
              className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {t('runtimeNode.cancel', { defaultValue: 'Cancel' })}
            </button>
          </div>
        </form>
      )}
      {mappingError && (
        <p role="alert" className="mt-1 text-center text-[11px] text-red-600 dark:text-red-400">{mappingError}</p>
      )}
    </div>
  );
}
