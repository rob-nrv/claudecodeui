import { useEffect, useRef, useState } from 'react';
import { ClipboardCheck, EllipsisVertical, Folder, Globe, MessageSquare, SquareTerminal, type LucideIcon } from 'lucide-react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';
import type { AppTab } from '../../../../types/app';
import { usePlugins } from '../../../../contexts/PluginsContext';
import { useUiPreferences } from '../../../../hooks/useUiPreferences';
import PluginIcon from '../../../plugins/view/PluginIcon';

type MainContentTabSwitcherProps = {
  activeTab: AppTab;
  setActiveTab: Dispatch<SetStateAction<AppTab>>;
  shouldShowTasksTab: boolean;
  shouldShowBrowserTab: boolean;
};

const actionButton =
  'flex h-[26px] w-7 items-center justify-center rounded-[6px] text-c-text-2 transition-colors hover:bg-c-hover hover:text-c-text';
const activeAction = 'bg-[#383838] text-c-text hover:bg-[#383838]';

/** Claude desktop "changes" glyph: a framed plus over minus. */
function ChangesIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="15" viewBox="0 0 14 15" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <rect x="0.65" y="0.65" width="12.7" height="13.7" rx="1.8" />
      <path d="M7 3.6V7.8M4.9 5.7H9.1M4.9 10.7H9.1" />
    </svg>
  );
}

/** Claude desktop side-panel toggle: a window with a list column. */
function SidePanelIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="16" height="13" viewBox="0 0 16 13" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
      <rect x="0.65" y="0.65" width="14.7" height="11.7" rx="1.8" />
      <path d="M3.4 4.2H5M3.4 6.5H5M3.4 8.8H5M7 4.2H12.4M7 6.5H12.4M7 8.8H12.4" />
    </svg>
  );
}

type ViewAction = { id: AppTab; labelKey: string; fallback: string; icon: LucideIcon | typeof ChangesIcon };

/*
 * Claude desktop conversation header, right side (measured on the live app,
 * 2026-10-18): side-panel toggle, a hairline, then terminal, changes,
 * browser, files and a ⋮ menu — 28 px buttons on a 30 px pitch. Each view
 * opens in the pane beside the conversation; clicking the active one closes it.
 */
export default function MainContentTabSwitcher({
  activeTab,
  setActiveTab,
  shouldShowTasksTab,
  shouldShowBrowserTab,
}: MainContentTabSwitcherProps) {
  const { t } = useTranslation();
  const { plugins } = usePlugins();
  const { preferences, setPreference } = useUiPreferences();
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isMoreOpen) return undefined;
    const close = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) setIsMoreOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [isMoreOpen]);

  const views: ViewAction[] = [
    { id: 'shell', labelKey: 'tabs.shell', fallback: 'Terminal', icon: SquareTerminal },
    { id: 'git', labelKey: 'tabs.git', fallback: 'Changes', icon: ChangesIcon },
    ...(shouldShowBrowserTab ? [{ id: 'browser' as AppTab, labelKey: 'tabs.browser', fallback: 'Browser', icon: Globe }] : []),
    { id: 'files', labelKey: 'tabs.files', fallback: 'Files', icon: Folder },
  ];
  const overflow = [
    ...(shouldShowTasksTab ? [{ id: 'tasks' as AppTab, label: t('tabs.tasks'), icon: <ClipboardCheck className="h-4 w-4" strokeWidth={1.6} /> }] : []),
    ...plugins.filter((plugin) => plugin.enabled).map((plugin) => ({
      id: `plugin:${plugin.name}` as AppTab,
      label: plugin.displayName,
      icon: <PluginIcon pluginName={plugin.name} iconFile={plugin.icon} className="flex h-4 w-4 items-center justify-center [&>svg]:h-full [&>svg]:w-full" />,
    })),
  ];

  const toggleView = (id: AppTab) => setActiveTab(activeTab === id ? 'chat' : id);
  const panelLabel = t('mainContent.toggleSidePanel', { defaultValue: 'Toggle side panel' });

  return (
    <div className="flex items-center gap-[2px]" role="toolbar" aria-label={t('tabs.views', { defaultValue: 'Workspace views' })}>
      {activeTab === 'chat' && (
        <>
          <button
            type="button"
            onClick={() => setPreference('sidePanelVisible', !preferences.sidePanelVisible)}
            aria-pressed={preferences.sidePanelVisible}
            title={panelLabel}
            aria-label={panelLabel}
            className={cn(actionButton, 'w-[30px]', preferences.sidePanelVisible && activeAction)}
          >
            <SidePanelIcon />
          </button>
          <span aria-hidden="true" className="mx-[3px] h-[18px] w-px bg-[#383838]" />
        </>
      )}
      {views.map((view) => {
        const label = t(view.labelKey, { defaultValue: view.fallback });
        const Icon = view.icon;
        return (
          <button
            key={view.id}
            type="button"
            onClick={() => toggleView(view.id)}
            aria-pressed={activeTab === view.id}
            title={label}
            aria-label={label}
            className={cn(actionButton, activeTab === view.id && activeAction)}
          >
            <Icon className="h-[15px] w-[15px]" strokeWidth={1.6} />
          </button>
        );
      })}
      <div ref={moreRef} className="relative">
        <button
          type="button"
          onClick={() => setIsMoreOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={isMoreOpen}
          title={t('mainContent.moreViews', { defaultValue: 'More' })}
          aria-label={t('mainContent.moreViews', { defaultValue: 'More' })}
          className={cn(actionButton, overflow.some((item) => item.id === activeTab) && activeAction)}
        >
          <EllipsisVertical className="h-[15px] w-[15px]" strokeWidth={1.8} />
        </button>
        {isMoreOpen && (
          <div role="menu" className="absolute right-0 top-[30px] z-50 w-[220px] rounded-[10px] border border-c-card-border bg-c-surface p-1 shadow-[0_8px_24px_rgba(0,0,0,0.35)]">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={activeTab === 'chat'}
              onClick={() => { setActiveTab('chat'); setIsMoreOpen(false); }}
              className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[14px] text-c-text-2 hover:bg-c-active hover:text-c-text"
            >
              <MessageSquare className="h-4 w-4" strokeWidth={1.6} />
              {t('tabs.chat')}
            </button>
            {overflow.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitemradio"
                aria-checked={activeTab === item.id}
                onClick={() => { setActiveTab(item.id); setIsMoreOpen(false); }}
                className="flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-[14px] text-c-text-2 hover:bg-c-active hover:text-c-text"
              >
                {item.icon}
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
