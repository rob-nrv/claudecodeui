import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import type { ChatMessage, ClaudePermissionSuggestion, PermissionGrantResult, Provider } from '../../types/types';
import type { Project } from '../../../../types/app';
import { describeToolGroup, type ToolGroupItem } from '../../utils/toolGrouping';

import MessageComponent from './MessageComponent';

type DiffLine = {
  type: string;
  content: string;
  lineNum: number;
};

interface ToolGroupContainerProps {
  group: ToolGroupItem;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  getMessageKey: (message: ChatMessage) => string;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject?: Project | null;
  provider: Provider | string;
}

/*
 * Claude desktop tool summary: one muted 14px line ("Ran 2 commands ›") per
 * run of tool calls, expanding in place to the calls themselves. A run that
 * is still executing or that contains an error says so in the same line.
 */
export default function ToolGroupContainer({
  group,
  prevMessage,
  createDiff,
  getMessageKey,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
  provider,
}: ToolGroupContainerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const summary = useMemo(() => describeToolGroup(group.messages), [group.messages]);
  const isRunning = group.messages.some((message) => !message.toolResult);
  const hasError = group.messages.some((message) => message.toolResult?.isError);

  const spacingClass = !prevMessage ? 'mt-0' : prevMessage.type === 'user' ? 'mt-[32px]' : 'mt-[14px]';

  return (
    <div className={`chat-message tool ${spacingClass}`} data-message-timestamp={group.timestamp || undefined}>
      <button
        type="button"
        className={`group/tool flex max-w-full items-center gap-[5px] text-left text-[14px] leading-5 transition-colors ${hasError ? 'text-c-danger' : 'text-c-text-3 hover:text-c-text-2'}`}
        onClick={() => setIsExpanded((current) => !current)}
        aria-expanded={isExpanded}
      >
        <span className={`min-w-0 truncate ${isRunning ? 'claude-shimmer' : ''}`}>
          {summary.segments.map((segment, index) => (
            segment.strong
              ? <span key={index} className={hasError ? '' : 'text-c-text'}>{segment.text}</span>
              : <span key={index}>{segment.text}</span>
          ))}
        </span>
        {summary.diff && (
          <span className="ml-[5px] inline-flex h-4 flex-shrink-0 overflow-hidden rounded-[3px] font-[family-name:var(--c-mono)] text-[11px] leading-4">
            <span className="bg-c-diff-add-bg px-[4px] text-c-diff-add">+{summary.diff.added}</span>
            <span className="bg-c-diff-del-bg px-[4px] text-c-danger">−{summary.diff.removed}</span>
          </span>
        )}
        <ChevronRight
          className={`h-3 w-3 flex-shrink-0 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
          strokeWidth={2}
          aria-hidden
        />
      </button>

      {isExpanded && (
        <div className="mt-2 border-l border-c-card-border pl-3">
          {group.messages.map((message, index) => (
            <MessageComponent
              key={getMessageKey(message)}
              message={message}
              prevMessage={index > 0 ? group.messages[index - 1] : null}
              createDiff={createDiff}
              onFileOpen={onFileOpen}
              onShowSettings={onShowSettings}
              onGrantToolPermission={onGrantToolPermission}
              showRawParameters={showRawParameters}
              showThinking={showThinking}
              selectedProject={selectedProject}
              provider={provider}
            />
          ))}
        </div>
      )}
    </div>
  );
}
