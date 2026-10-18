import { useState } from 'react';
import {
  Activity,
  Archive,
  BriefcaseBusiness,
  Ellipsis,
  FolderPlus,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import type { TFunction } from 'i18next';

import { cn } from '../../../../lib/utils';
import type { SidebarSearchMode } from '../../types/types';

type SidebarHeaderProps = {
  isPWA: boolean;
  isMobile: boolean;
  isLoading: boolean;
  projectsCount: number;
  runningSessionsCount: number;
  archivedSessionsCount: number;
  isArchivedSessionsLoading: boolean;
  searchFilter: string;
  onSearchFilterChange: (value: string) => void;
  onClearSearchFilter: () => void;
  searchMode: SidebarSearchMode;
  onSearchModeChange: (mode: SidebarSearchMode) => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onCreateProject: () => void;
  onNewSession: () => void;
  onShowSettings: () => void;
  onCollapseSidebar: () => void;
  t: TFunction;
};

/*
 * Claude desktop sidebar header, measured from the reference capture:
 * 36px window row (menu, panel toggle, back, forward), a 264×26 search field
 * at x=3/y=43, then a 26.67px-pitch nav list (New, Customize, More).
 * Claude's Chat/Code switch and Artifacts entry have no CloudCLI counterpart
 * and are intentionally not rendered (no decoration without a function).
 */
const iconButton =
  'flex h-7 w-7 items-center justify-center rounded-md text-c-text-2 transition-colors hover:bg-c-hover hover:text-c-text disabled:opacity-40';

const navRow =
  'flex h-[26.67px] w-full items-center gap-[9px] rounded-md pl-[9px] pr-2 text-left text-[14px] leading-5 text-c-text-2 transition-colors hover:bg-c-hover hover:text-c-text';

export default function SidebarHeader({
  isPWA,
  isMobile,
  isLoading,
  projectsCount,
  runningSessionsCount,
  archivedSessionsCount,
  isArchivedSessionsLoading,
  searchFilter,
  onSearchFilterChange,
  onClearSearchFilter,
  searchMode,
  onSearchModeChange,
  onRefresh,
  isRefreshing,
  onCreateProject,
  onNewSession,
  onShowSettings,
  onCollapseSidebar,
  t,
}: SidebarHeaderProps) {
  const [isMoreOpen, setIsMoreOpen] = useState(searchMode !== 'projects');
  const showSearch = (projectsCount > 0 || runningSessionsCount > 0 || archivedSessionsCount > 0 || isArchivedSessionsLoading) && !isLoading;
  const searchPlaceholder = searchMode === 'conversations'
    ? t('search.conversationsPlaceholder')
    : searchMode === 'archived'
      ? t('search.archivedPlaceholder', 'Search archived sessions...')
      : searchMode === 'running'
        ? t('search.runningPlaceholder', 'Search running sessions...')
        : t('search.placeholderShort', 'Search');

  const moreRow = (mode: SidebarSearchMode, Icon: typeof Activity, label: string, badge?: number) => (
    <button
      type="button"
      onClick={() => onSearchModeChange(searchMode === mode ? 'projects' : mode)}
      aria-pressed={searchMode === mode}
      className={cn(navRow, 'pl-[30px]', searchMode === mode && 'bg-c-active text-c-text')}
    >
      <Icon className="h-[14px] w-[14px] flex-shrink-0" strokeWidth={1.6} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {badge ? <span className="text-[12px] tabular-nums text-c-text-3">{badge > 99 ? '99+' : badge}</span> : null}
    </button>
  );

  return (
    <div
      className="flex-shrink-0 select-none"
      style={isPWA && isMobile ? { paddingTop: '12px' } : undefined}
    >
      {/* Window row (live app, 2026-10-18): icon centres x = 25.5 / 57.5 / 89.5 / 119.5, y = 17.5;
          Chat / Code switch at x = 210–279, y = 4–31. */}
      <div className="relative h-9">
        <button type="button" className={cn(iconButton, 'absolute left-[11.5px] top-[3.5px] text-c-text')} onClick={onShowSettings} title={t('tooltips.settings', 'Settings')} aria-label={t('tooltips.settings', 'Settings')}>
          <svg width="14" height="10" viewBox="0 0 14 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
            <path d="M0.65 0.65H13.35M0.65 5H13.35M0.65 9.35H7.35" />
          </svg>
        </button>
        {!isMobile && (
          <>
            <button type="button" className={cn(iconButton, 'absolute left-[43.5px] top-[3.5px] text-c-text')} onClick={onCollapseSidebar} title={t('tooltips.hideSidebar')} aria-label={t('tooltips.hideSidebar')}>
              <svg width="14" height="12" viewBox="0 0 14 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
                <rect x="0.6" y="0.6" width="12.8" height="10.8" rx="1.6" />
                <path d="M3.9 0.6V11.4" />
              </svg>
            </button>
            <button type="button" className={cn(iconButton, 'absolute left-[75.5px] top-[3.5px] text-c-text')} onClick={() => window.history.back()} title={t('tooltips.back', 'Back')} aria-label={t('tooltips.back', 'Back')}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11.35 6H0.65M5.65 0.65L0.65 6L5.65 11.35" />
              </svg>
            </button>
            <button type="button" className={cn(iconButton, 'absolute left-[105.5px] top-[3.5px] text-[#807f7e]')} onClick={() => window.history.forward()} title={t('tooltips.forward', 'Forward')} aria-label={t('tooltips.forward', 'Forward')}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M0.65 6H11.35M6.35 0.65L11.35 6L6.35 11.35" />
              </svg>
            </button>
          </>
        )}
        {/* Claude's Chat / Code switch drives CloudCLI's two sidebar lists:
            all conversations (Chat) or conversations grouped by project (Code). */}
        <div role="radiogroup" aria-label={t('search.listMode', 'Sidebar list')} className="absolute right-[7px] top-[4px] flex h-[28px] w-[70px] rounded-[8px] bg-c-search p-px">
          <button
            type="button"
            role="radio"
            aria-checked={searchMode === 'conversations'}
            onClick={() => onSearchModeChange('conversations')}
            title={t('search.modeConversations')}
            aria-label={t('search.modeConversations')}
            className={cn('flex flex-1 items-center justify-center rounded-[7px] text-c-text-2 hover:text-c-text', searchMode === 'conversations' && 'bg-c-active text-c-text')}
          >
            <svg width="14" height="13" viewBox="0 0 14 13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" aria-hidden="true">
              <path d="M5.6 0.7C8.3 0.7 10.5 2.6 10.5 4.9C10.5 7.2 8.3 9.1 5.6 9.1C5 9.1 4.4 9 3.9 8.8L1.3 9.6L2 7.6C1.2 6.9 0.7 5.9 0.7 4.9C0.7 2.6 2.9 0.7 5.6 0.7Z" />
              <path d="M11.6 4.4C12.6 5.1 13.3 6.1 13.3 7.3C13.3 8.2 12.9 9.1 12.2 9.7L12.8 11.5L10.6 10.8C10.1 11 9.6 11.1 9 11.1C7.9 11.1 6.9 10.8 6.1 10.2" />
            </svg>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={searchMode !== 'conversations'}
            onClick={() => onSearchModeChange('projects')}
            title={t('search.modeProjects')}
            aria-label={t('search.modeProjects')}
            className={cn('flex flex-1 items-center justify-center rounded-[7px] text-c-text-2 hover:text-c-text', searchMode !== 'conversations' && 'bg-c-active text-c-text')}
          >
            <svg width="14" height="12" viewBox="0 0 14 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4.2 2.4L0.8 6L4.2 9.6M9.8 2.4L13.2 6L9.8 9.6M8.1 0.8L5.9 11.2" />
            </svg>
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="relative ml-[10px] mr-3 mt-[8px]">
        <Search className="pointer-events-none absolute left-[9px] top-1/2 h-[13px] w-[13px] -translate-y-1/2 text-c-text-3" strokeWidth={1.8} />
        <input
          type="text"
          value={searchFilter}
          onChange={(event) => onSearchFilterChange(event.target.value)}
          placeholder={searchPlaceholder}
          disabled={!showSearch}
          className="block h-[26px] w-full rounded-[6px] border border-c-active bg-c-search pl-[31px] pr-7 text-[14px] leading-5 text-c-text outline-none transition-colors placeholder:text-c-text-3 focus:border-c-input-border"
          aria-label={searchPlaceholder}
        />
        {searchFilter && (
          <button
            type="button"
            onClick={onClearSearchFilter}
            aria-label={t('tooltips.clearSearch')}
            className="absolute right-1.5 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-c-text-3 hover:text-c-text"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="mt-[7px] px-[10px]">
        <button type="button" className={cn(navRow, 'gap-[7px] pl-[7px]')} onClick={onNewSession}>
          <span className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full bg-c-icon-bg text-c-text">
            <Plus className="h-[12px] w-[12px]" strokeWidth={2} />
          </span>
          <span className="truncate">{t('actions.new', 'New')}</span>
        </button>
        {/* Claude's 4th entry is Artifacts, which CloudCLI does not have; the slot
            shows CloudCLI's live sessions instead (same geometry, real data). */}
        <button
          type="button"
          className={cn(navRow, searchMode === 'running' && 'bg-c-active text-c-text')}
          onClick={() => onSearchModeChange(searchMode === 'running' ? 'projects' : 'running')}
          aria-pressed={searchMode === 'running'}
        >
          <Activity className="h-[14px] w-[14px] flex-shrink-0" strokeWidth={1.6} />
          <span className="min-w-0 flex-1 truncate">{t('search.modeRunning', 'Running')}</span>
          {runningSessionsCount > 0 && <span className="text-[12px] tabular-nums text-c-text-3">{runningSessionsCount > 99 ? '99+' : runningSessionsCount}</span>}
        </button>
        <button type="button" className={navRow} onClick={onShowSettings}>
          <BriefcaseBusiness className="h-[14px] w-[14px] flex-shrink-0" strokeWidth={1.6} />
          <span className="truncate">{t('actions.customize', 'Customize')}</span>
        </button>
        <button
          type="button"
          className={navRow}
          onClick={() => setIsMoreOpen((open) => !open)}
          aria-expanded={isMoreOpen}
        >
          <Ellipsis className="h-[14px] w-[14px] flex-shrink-0" strokeWidth={1.8} />
          <span className="truncate">{t('actions.more', 'More')}</span>
        </button>
        {isMoreOpen && (
          <div>
            {moreRow('archived', Archive, t('search.archiveOnlyTooltip', 'Archived'), archivedSessionsCount)}
            <button type="button" className={cn(navRow, 'pl-[30px]')} onClick={onCreateProject}>
              <FolderPlus className="h-[14px] w-[14px] flex-shrink-0" strokeWidth={1.6} />
              <span className="truncate">{t('actions.openProject', 'Open or create a project')}</span>
            </button>
            <button type="button" className={cn(navRow, 'pl-[30px]')} onClick={onRefresh} disabled={isRefreshing}>
              <RefreshCw className={cn('h-[14px] w-[14px] flex-shrink-0', isRefreshing && 'animate-spin')} strokeWidth={1.6} />
              <span className="truncate">{t('tooltips.refresh')}</span>
            </button>
          </div>
        )}
      </nav>
    </div>
  );
}
