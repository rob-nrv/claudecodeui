import { useTranslation } from 'react-i18next';
import { PencilIcon, XIcon } from 'lucide-react';

interface QueuedMessageCardProps {
  content: string;
  attachmentCount?: number;
  onEdit: () => void;
  onDelete: () => void;
}

/*
 * Claude desktop queued message (reference C2, 2026-07-28): one rounded row
 * above the composer — "1 queued message" in bold, the message in muted text,
 * then its actions.
 */
export default function QueuedMessageCard({
  content,
  attachmentCount = 0,
  onEdit,
  onDelete,
}: QueuedMessageCardProps) {
  const { t } = useTranslation('chat');

  return (
    <div className="claude-box settings-content-enter mb-[6px]">
      <div className="flex min-h-[38px] items-center gap-2 rounded-[10px] bg-c-surface py-[7px] pl-3 pr-[6px] text-[14px] leading-5">
        <span className="flex-shrink-0 font-semibold text-c-text">
          {t('input.queue.oneQueued', { defaultValue: '1 queued message' })}
        </span>
        <span className="min-w-0 flex-1 truncate text-c-text-3" title={content}>
          {content}
          {attachmentCount > 0 && ` · ${attachmentCount} ${attachmentCount === 1 ? 'file' : 'files'}`}
        </span>
        <button
          type="button"
          onClick={onEdit}
          aria-label={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
          title={t('input.queue.edit', { defaultValue: 'Edit queued message' })}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-c-text-3 hover:bg-c-active hover:text-c-text"
        >
          <PencilIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
          title={t('input.queue.delete', { defaultValue: 'Delete queued message' })}
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-c-text-3 hover:bg-c-active hover:text-c-text"
        >
          <XIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
