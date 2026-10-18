import { Maximize2, Minimize2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type MainViewPaneHeaderProps = {
  label: string;
  projectName: string;
  isExpanded: boolean;
  canExpand: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
};

const iconButton =
  'flex h-7 w-7 items-center justify-center rounded-md text-c-text-2 transition-colors hover:bg-c-active hover:text-c-text';

/*
 * Header of the pane opened beside the conversation (reference B: the diff
 * pane's "main → branch" row with expand and close at the right).
 */
export default function MainViewPaneHeader({
  label,
  projectName,
  isExpanded,
  canExpand,
  onToggleExpand,
  onClose,
}: MainViewPaneHeaderProps) {
  const { t } = useTranslation();

  return (
    <header className="flex h-9 flex-shrink-0 items-center gap-2 pl-3 pr-2">
      <span className="min-w-0 truncate text-[13.5px] font-medium text-c-text">{label}</span>
      <span className="min-w-0 truncate text-[13px] text-c-text-3">{projectName}</span>
      <div className="flex-1" />
      {canExpand && (
        <button
          type="button"
          onClick={onToggleExpand}
          className={iconButton}
          title={isExpanded ? t('mainContent.collapsePane', { defaultValue: 'Show the conversation' }) : t('mainContent.expandPane', { defaultValue: 'Expand' })}
          aria-label={isExpanded ? t('mainContent.collapsePane', { defaultValue: 'Show the conversation' }) : t('mainContent.expandPane', { defaultValue: 'Expand' })}
        >
          {isExpanded ? <Minimize2 className="h-3.5 w-3.5" strokeWidth={1.8} /> : <Maximize2 className="h-3.5 w-3.5" strokeWidth={1.8} />}
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        className={iconButton}
        title={t('mainContent.closePane', { defaultValue: 'Close' })}
        aria-label={t('mainContent.closePane', { defaultValue: 'Close' })}
      >
        <X className="h-4 w-4" strokeWidth={1.8} />
      </button>
    </header>
  );
}
