import React, { useState } from 'react';
import { TimerOffIcon } from 'lucide-react';

import type { PendingPermissionRequest } from '../../types/types';
import { buildClaudeToolPermissionEntry, formatToolInputForDisplay } from '../../utils/chatPermissions';
import { getClaudeSettings } from '../../utils/chatStorage';
import { isAwaitingPermissionDecision } from '../../utils/permissionRequestState';
import { getPermissionPanel, registerPermissionPanel } from '../../tools/configs/permissionPanelRegistry';
import { AskUserQuestionPanel } from '../../tools/components/InteractiveRenderers';

registerPermissionPanel('AskUserQuestion', AskUserQuestionPanel);

interface PermissionRequestsBannerProps {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
  handleGrantToolPermission: (suggestion: { entry: string; toolName: string }) => { success: boolean };
  handlePermissionDismiss: (requestId: string) => void;
}

/** One-line target (command, file, URL) so a settled notice says what it was about. */
function describeToolTarget(input: unknown): string {
  if (!input || typeof input !== 'object') {
    return '';
  }
  const record = input as Record<string, unknown>;
  const target = [record.command, record.file_path, record.path, record.url, record.pattern]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const text = target?.trim() ?? '';
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function NotSentNotice() {
  return (
    <p className="mt-1 text-xs text-foreground">
      Your answer was not sent — the connection dropped. Answer again once reconnected.
    </p>
  );
}

/** An approval that can no longer be answered. Visible until dismissed, never clickable. */
function SettledPermissionNotice({
  request,
  onDismiss,
}: {
  request: PendingPermissionRequest;
  onDismiss: (requestId: string) => void;
}) {
  const isExpired = request.status === 'expired';
  const target = describeToolTarget(request.input);

  return (
    <div role="status" className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm">
      <TimerOffIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div>
          <span className="font-medium text-foreground">
            {isExpired ? 'Permission request expired' : 'Permission request no longer available'}
          </span>
          <span className="ml-2 text-muted-foreground">
            Tool: <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{request.toolName}</code>
          </span>
        </div>
        {target && <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{target}</div>}
        <p className="mt-1 text-xs text-muted-foreground">
          {isExpired
            ? 'Nobody answered in time, so Claude did not run this tool. Send a message to ask it to try again.'
            : 'Claude is no longer waiting for this answer (its run ended or the server restarted).'}
        </p>
      </div>
      <button
        type="button"
        onClick={() => onDismiss(request.requestId)}
        className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        Dismiss
      </button>
    </div>
  );
}

export default function PermissionRequestsBanner({
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  handlePermissionDismiss,
}: PermissionRequestsBannerProps) {
  // Filter out plan tool requests — they are handled inline by PlanDisplay
  const filteredRequests = pendingPermissionRequests.filter(
    (r) => r.toolName !== 'ExitPlanMode' && r.toolName !== 'exit_plan_mode'
  );

  if (!filteredRequests.length) {
    return null;
  }

  return (
    <div className="mb-3 space-y-2">
      {filteredRequests.map((request) => {
        if (request.status === 'expired' || request.status === 'unavailable') {
          return (
            <SettledPermissionNotice key={request.requestId} request={request} onDismiss={handlePermissionDismiss} />
          );
        }

        const isSubmitting = request.status === 'submitting';
        const CustomPanel = getPermissionPanel(request.toolName);
        if (CustomPanel) {
          return (
            <div key={request.requestId}>
              {request.notice === 'not_sent' && <NotSentNotice />}
              <CustomPanel
                request={request}
                onDecision={handlePermissionDecision}
                isSubmitting={isSubmitting}
              />
            </div>
          );
        }

        const rawInput = formatToolInputForDisplay(request.input);
        const permissionEntry = buildClaudeToolPermissionEntry(request.toolName, rawInput);
        const settings = getClaudeSettings();
        const alreadyAllowed = permissionEntry ? settings.allowedTools.includes(permissionEntry) : false;
        const matchingRequestIds = permissionEntry
          ? pendingPermissionRequests
              .filter(
                (item) =>
                  isAwaitingPermissionDecision(item)
                  && buildClaudeToolPermissionEntry(item.toolName, formatToolInputForDisplay(item.input)) === permissionEntry,
              )
              .map((item) => item.requestId)
          : [request.requestId];

        return (
          <ClaudePermissionCard
            key={request.requestId}
            toolName={request.toolName}
            input={request.input}
            rawInput={rawInput}
            permissionEntry={permissionEntry}
            alreadyAllowed={alreadyAllowed}
            isSubmitting={isSubmitting}
            notSent={request.notice === 'not_sent'}
            onAllowOnce={() => handlePermissionDecision(request.requestId, { allow: true })}
            onAllowAndRemember={() => {
              if (permissionEntry && !alreadyAllowed) {
                handleGrantToolPermission({ entry: permissionEntry, toolName: request.toolName });
              }
              handlePermissionDecision(matchingRequestIds, { allow: true, rememberEntry: permissionEntry });
            }}
            onDeny={(message) => handlePermissionDecision(request.requestId, { allow: false, message: message || 'User denied tool use' })}
          />
        );
      })}
    </div>
  );
}

type ClaudePermissionCardProps = {
  toolName: string;
  input: unknown;
  rawInput: string;
  permissionEntry: string | null;
  alreadyAllowed: boolean;
  isSubmitting: boolean;
  notSent: boolean;
  onAllowOnce: () => void;
  onAllowAndRemember: () => void;
  onDeny: (message?: string) => void;
};

/*
 * Claude Code permission prompt (reference X2/X3: "Allow this bash command?",
 * numbered answers, "Tell Claude what to do instead", "Esc to cancel"). The
 * reference is Claude Code's VS Code panel — no desktop capture of this
 * prompt exists yet — so only its structure and wording are reused.
 */
function ClaudePermissionCard({
  toolName,
  input,
  rawInput,
  permissionEntry,
  alreadyAllowed,
  isSubmitting,
  notSent,
  onAllowOnce,
  onAllowAndRemember,
  onDeny,
}: ClaudePermissionCardProps) {
  const [focused, setFocused] = useState(0);
  const [instead, setInstead] = useState('');
  const fields = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const command = typeof fields.command === 'string' ? fields.command : null;
  const description = typeof fields.description === 'string' ? fields.description : null;
  const filePath = typeof fields.file_path === 'string' ? fields.file_path : null;
  const subject = toolName === 'Bash' ? 'bash command' : toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit' ? 'edit' : `${toolName} call`;

  const options = [
    { label: 'Yes', run: onAllowOnce, disabled: false },
    ...(permissionEntry
      ? [{ label: alreadyAllowed ? `Yes (${permissionEntry} is already allowed)` : `Yes, allow ${permissionEntry} for this project (just you)`, run: onAllowAndRemember, disabled: false }]
      : []),
    { label: 'No', run: () => onDeny(), disabled: false },
  ];

  return (
    <div
      role="alertdialog"
      aria-label={`Allow this ${subject}?`}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.target instanceof HTMLInputElement) return;
        const index = Number(event.key) - 1;
        if (index >= 0 && index < options.length) { event.preventDefault(); options[index].run(); }
        else if (event.key === 'ArrowDown') { event.preventDefault(); setFocused((value) => Math.min(options.length - 1, value + 1)); }
        else if (event.key === 'ArrowUp') { event.preventDefault(); setFocused((value) => Math.max(0, value - 1)); }
        else if (event.key === 'Enter') { event.preventDefault(); options[focused].run(); }
        else if (event.key === 'Escape') { event.preventDefault(); onDeny(); }
      }}
      className="rounded-[10px] border border-c-card-border bg-c-surface p-2 text-[14px] leading-5 text-c-text outline-none"
    >
      <p className="px-[2px] font-semibold">Allow this {subject}?</p>
      {(command || filePath) && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap px-[2px] font-[family-name:var(--c-mono)] text-[13px] leading-5 text-c-text">{command ?? filePath}</pre>
      )}
      {!command && !filePath && rawInput && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap px-[2px] font-[family-name:var(--c-mono)] text-[12px] leading-[18px] text-c-text-2">{rawInput}</pre>
      )}
      {description && <p className="mt-1 px-[2px] text-[13px] text-c-text-3">{description}</p>}
      {notSent && <NotSentNotice />}
      <div className="mt-2 space-y-[6px]">
        {options.map((option, index) => (
          <button
            key={option.label}
            type="button"
            onClick={option.run}
            onMouseEnter={() => setFocused(index)}
            disabled={isSubmitting || option.disabled}
            className={`flex h-[28px] w-full items-center gap-2 rounded-[4px] border px-2 text-left text-[13px] font-semibold disabled:opacity-50 ${focused === index ? 'border-transparent bg-[#2a7aa0] text-white' : 'border-c-card-border text-c-text-2'}`}
          >
            <span className="font-normal text-c-text-3">{index + 1}</span>
            <span className="min-w-0 truncate">{option.label}</span>
          </button>
        ))}
        <input
          value={instead}
          onChange={(event) => setInstead(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && instead.trim()) { event.preventDefault(); onDeny(instead.trim()); }
            if (event.key === 'Escape') { event.preventDefault(); onDeny(); }
          }}
          disabled={isSubmitting}
          placeholder="Tell Claude what to do instead"
          className="block h-[30px] w-full rounded-[4px] border border-c-card-border bg-transparent px-2 text-[13px] text-c-text outline-none placeholder:text-c-text-3 focus:border-c-input-border"
        />
      </div>
      <p className="mt-[6px] px-[2px] text-[11px] text-c-text-3">{isSubmitting ? 'Sending your answer…' : 'Esc to cancel'}</p>
    </div>
  );
}
