import type { MainContentHeaderProps } from '../../types/types';

import MobileMenuButton from './MobileMenuButton';
import MainContentTabSwitcher from './MainContentTabSwitcher';
import MainContentTitle from './MainContentTitle';

/*
 * Claude desktop conversation header: a borderless 36px row on the main
 * surface — the title menu at x=24, the view actions on the right.
 */
export default function MainContentHeader({
  activeTab,
  setActiveTab,
  selectedProject,
  selectedSession,
  shouldShowTasksTab,
  shouldShowBrowserTab,
  isMobile,
  onMenuClick,
  sessionLineage,
  onNavigateToSession,
}: MainContentHeaderProps) {
  return (
    <header className={`${isMobile ? 'pwa-header-safe h-11 items-center pl-2' : 'h-9 items-start pl-[18px] pt-[3px]'} flex flex-shrink-0 gap-1 bg-c-bg pr-3`}>
      {isMobile && <MobileMenuButton onMenuClick={onMenuClick} />}
      <div className="min-w-0 flex-1">
        <MainContentTitle
          selectedProject={selectedProject}
          selectedSession={selectedSession}
          sessionLineage={sessionLineage}
          onNavigateToSession={onNavigateToSession}
        />
      </div>
      <div className={isMobile ? '' : 'pt-[2px]'}>
        <MainContentTabSwitcher
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          shouldShowTasksTab={shouldShowTasksTab}
          shouldShowBrowserTab={shouldShowBrowserTab}
        />
      </div>
    </header>
  );
}
