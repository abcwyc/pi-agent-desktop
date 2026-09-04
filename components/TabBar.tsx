"use client";

import { getFileIcon } from "./FileIcons";
import { useI18n } from "@/hooks/useI18n";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  sourceSessionId?: string | null;
  initialDisplayMode?: "source" | "preview" | "diff";
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
}

export function TabBar({ tabs, activeTabId, onSelectTab, onCloseTab }: Props) {
  const { t } = useI18n();

  return (
    <div className="file-tab-bar" role="tablist" aria-label={t("tabBar.openFiles")}>
      {tabs.length === 0 && (
        <div className="file-tab-bar-empty" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5Z" />
          </svg>
          <span>{t("tabBar.filesEmpty")}</span>
        </div>
      )}
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            className={`file-tab${isActive ? " is-active" : ""}`}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            data-tab-id={tab.id}
            title={tab.filePath}
            onClick={() => onSelectTab(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectTab(tab.id);
                return;
              }
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const currentIndex = tabs.findIndex((item) => item.id === tab.id);
              const offset = event.key === "ArrowRight" ? 1 : -1;
              const nextTab = tabs[(currentIndex + offset + tabs.length) % tabs.length];
              if (!nextTab) return;
              const nextElement = Array.from(document.querySelectorAll<HTMLElement>(".file-tab"))
                .find((element) => element.dataset.tabId === nextTab.id);
              nextElement?.focus();
              onSelectTab(nextTab.id);
            }}
            onMouseDown={(event) => {
              if (event.button === 1) event.preventDefault();
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              event.stopPropagation();
              onCloseTab(tab.id);
            }}
          >
            <span className="file-tab-icon">
              {getFileIcon(tab.label, 14)}
            </span>
            <span className="file-tab-label">{tab.label}</span>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onCloseTab(tab.id);
              }}
              className="file-tab-close"
              title={t("i18n.close")}
              aria-label={`${t("i18n.close")} ${tab.label}`}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        );
      })}
    </div>
  );
}
