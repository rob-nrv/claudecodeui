import { X } from 'lucide-react';

import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import { IS_PLATFORM } from '../../../shared/utils';

/**
 * For the empty shell instance (no project is ever selected for this modal),
 * mirrors `ProviderLoginModal`'s placeholder project.
 */
const DEFAULT_PROJECT_FOR_EMPTY_SHELL = {
  projectId: 'default',
  displayName: 'default',
  fullPath: IS_PLATFORM ? '/workspace' : '',
  path: IS_PLATFORM ? '/workspace' : '',
};

type UsageCheckModalProps = {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Opaque Claude profile id (see `ShellInitMessage.claudeProfileId`). The
   * backend resolves it to that profile's own `CLAUDE_CONFIG_DIR`, so the
   * `/usage` snapshot reflects the correct account. Omitted for the
   * historical/default account.
   */
  claudeProfileId?: string | null;
};

/**
 * There is no official, machine-readable way to read Claude subscription
 * usage (session/weekly caps) — see FT-M02 research gate. The only
 * trustworthy source is Anthropic's own interactive `/usage` slash command.
 * This opens a real `claude` CLI session (the same pty this app's Shell
 * feature already uses) and runs it — no parsing, no fabricated numbers,
 * the user reads Anthropic's own output directly.
 */
export default function UsageCheckModal({ isOpen, onClose, claudeProfileId = null }: UsageCheckModalProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-50 max-md:items-stretch max-md:justify-stretch">
      <div className="flex h-3/4 w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl dark:bg-gray-800 max-md:m-0 max-md:h-full max-md:max-w-none max-md:rounded-none md:m-4 md:h-3/4 md:max-w-4xl md:rounded-lg">
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Claude usage</h3>
          <button
            onClick={onClose}
            className="text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
            aria-label="Close usage modal"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden">
          <StandaloneShell
            project={DEFAULT_PROJECT_FOR_EMPTY_SHELL}
            command="claude /usage"
            minimal
            claudeProfileId={claudeProfileId}
          />
        </div>
      </div>
    </div>
  );
}
