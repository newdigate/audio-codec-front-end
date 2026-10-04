import React from 'react';

export interface TabItem {
  id: string;
  title: string;
  isPinned?: boolean;
  filePath?: string;
}

export interface TabBarProps {
  tabs: TabItem[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}

export const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
}) => {
  const handleKeyDown = (e: React.KeyboardEvent, tabId: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelectTab(tabId);
    }
  };

  return (
    <nav className="tab-bar" role="tablist" aria-label="Audio tabs">
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const className = `tab-item ${isActive ? 'active' : ''} ${tab.isPinned ? 'pinned' : ''}`.trim();

        return (
          <div
            key={tab.id}
            role="tab"
            tabIndex={0}
            aria-selected={isActive}
            className={className}
            onClick={() => onSelectTab(tab.id)}
            onKeyDown={(e) => handleKeyDown(e, tab.id)}
          >
            <span className="tab-title">{tab.title}</span>
            {!tab.isPinned && (
              <button
                type="button"
                className="tab-close-btn"
                aria-label={`Close ${tab.title.replace(/^🎵\s*/, '')}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </nav>
  );
};
