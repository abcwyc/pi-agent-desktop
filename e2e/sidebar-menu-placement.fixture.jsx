import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider, useI18n } from "../hooks/useI18n";
// Exported by the test bundler only; the menus are the application's own.
import { SidebarSessionFixture } from "../components/SessionSidebar";
import { ProjectContextMenuPanel } from "../components/ProjectContextMenu";

const session = {
  id: "fixture-session", path: "/fixture/session.jsonl", cwd: "/fixture/project",
  name: "菜单定位回归", firstMessage: "Fixture", messageCount: 4,
  created: "2026-10-20T12:00:00Z", modified: "2026-10-20T12:00:00Z",
};

function Fixture() {
  const { t } = useI18n();
  const menuRef = useRef(null);
  const [projectOpen, setProjectOpen] = useState(false);
  // Anchors sit close to the bottom edge, so a menu that ignores the space
  // below runs off the window and its last item cannot be clicked.
  const anchor = { top: window.innerHeight - 44, bottom: window.innerHeight - 28, right: 240 };
  return (
    <div style={{ height: "100%", position: "relative" }}>
      <aside
        className="app-sidebar"
        style={{ position: "fixed", bottom: 12, left: 12, width: 240, background: "var(--canvas-background)" }}
      >
        <div role="tree" aria-label="Fixture sessions">
          <SidebarSessionFixture session={session} isSelected onClick={() => {}} />
        </div>
        <button
          id="project-more"
          type="button"
          style={{ marginTop: 8 }}
          onClick={() => setProjectOpen((open) => !open)}
        >
          {t("sidebar.moreActions")}
        </button>
      </aside>
      {projectOpen && (
        <ProjectContextMenuPanel
          menuRef={menuRef}
          projectRoot="/fixture/project"
          pos={{ top: anchor.bottom + 4, left: anchor.right - 168 }}
          anchor={anchor}
          view="actions"
          branchMenu={null}
          branchLoading={false}
          selectedCwd="/fixture/project"
          switchingBranch={null}
          fetching={false}
          worktreeBusy={false}
          worktreeError={null}
          confirmRemove={null}
          newBranch=""
          canReveal={false}
          revealLabel="Reveal"
          projectRevealError={null}
          t={t}
          onShowBranches={() => {}}
          onShowWorktrees={() => {}}
          onShowNewWorktree={() => {}}
          onBackToActions={() => {}}
          onReveal={() => {}}
          onArchive={() => {}}
          onRestore={() => {}}
          onSwitchBranch={() => {}}
          onFetch={() => {}}
          onSelectWorktree={() => {}}
          onRequestRemove={() => {}}
          onConfirmRemove={() => {}}
          onCancelRemove={() => {}}
          onNewBranchChange={() => {}}
          onCreateWorktree={() => {}}
        />
      )}
      <main style={{ flex: 1, padding: 24, color: "var(--text-muted)" }}>
        <button type="button">Background control</button>
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <I18nProvider>
    <Fixture />
  </I18nProvider>,
);
