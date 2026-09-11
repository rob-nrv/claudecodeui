import React from 'react';
import { ShieldAlertIcon, TimerOffIcon } from 'lucide-react';

import type { PendingPermissionRequest } from '../../types/types';
import { buildClaudeToolPermissionEntry, formatToolInputForDisplay } from '../../utils/chatPermissions';
import { getClaudeSettings } from '../../utils/chatStorage';
import { isAwaitingPermissionDecision } from '../../utils/permissionRequestState';
import { getPermissionPanel, registerPermissionPanel } from '../../tools/configs/permissionPanelRegistry';
import { AskUserQuestionPanel } from '../../tools/components/InteractiveRenderers';
import {
  Confirmation,
  ConfirmationTitle,
  ConfirmationRequest,
  ConfirmationActions,
  ConfirmationAction,
} from '../../../../shared/view/ui';

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
        const rememberLabel = alreadyAllowed ? 'Allow (saved)' : 'Allow & remember';
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
          <Confirmation key={request.requestId} approval="pending">
            <ConfirmationTitle className="flex items-start gap-3">
              <ShieldAlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <ConfirmationRequest>
                <div>
                  <span className="font-medium text-foreground">Permission required</span>
                  <span className="ml-2 text-muted-foreground">
                    Tool: <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{request.toolName}</code>
                  </span>
                </div>
                {permissionEntry && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    Allow rule: <code className="rounded bg-muted px-1 py-0.5 text-xs">{permissionEntry}</code>
                  </div>
                )}
                {request.notice === 'not_sent' && <NotSentNotice />}
                {isSubmitting && <p className="mt-1 text-xs text-muted-foreground">Sending your answer…</p>}
              </ConfirmationRequest>
            </ConfirmationTitle>

            {rawInput && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  View tool input
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/50 p-2 text-xs text-muted-foreground">
                  {rawInput}
                </pre>
              </details>
            )}

            <ConfirmationActions>
              <ConfirmationAction
                variant="outline"
                onClick={() => handlePermissionDecision(request.requestId, { allow: false, message: 'User denied tool use' })}
                disabled={isSubmitting}
              >
                Deny
              </ConfirmationAction>
              <ConfirmationAction
                variant="outline"
                onClick={() => {
                  if (permissionEntry && !alreadyAllowed) {
                    handleGrantToolPermission({ entry: permissionEntry, toolName: request.toolName });
                  }
                  handlePermissionDecision(matchingRequestIds, { allow: true, rememberEntry: permissionEntry });
                }}
                disabled={isSubmitting || !permissionEntry}
              >
                {rememberLabel}
              </ConfirmationAction>
              <ConfirmationAction
                variant="default"
                onClick={() => handlePermissionDecision(request.requestId, { allow: true })}
                disabled={isSubmitting}
              >
                Allow once
              </ConfirmationAction>
            </ConfirmationActions>
          </Confirmation>
        );
      })}
    </div>
  );
}
