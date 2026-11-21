import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../hooks/useI18n";
// Exported by the test bundler only; all row actions are the application's own.
import { SidebarSessionFixture } from "../components/SessionSidebar";

// Relative to the run, so the sidebar's compact time stays a short label ("3d" / "3天").
// A fixed date grew into "1个月" a month later, widening the trailing slot the
// "…" button fills, and the 28px hit-target assertion failed on unchanged code.
const RECENT = new Date(Date.now() - 3 * 86_400_000).toISOString();

function Fixture() {
  const query = new URLSearchParams(location.search);
  const [removed, setRemoved] = useState(false);
  const [activated, setActivated] = useState(0);
  const title = query.has("long")
    ? '<file name="C:\\Projects\\YMS\\数据导出与合并\\report-preview.html"> 检查长标题与文件名 & 保留原始记录 — '.repeat(5)
    : "查看 YMS 的报表导出与合并策略";
  return <div style={{ height: "100%", display: "flex", background: "var(--surface)" }}>
    <aside className="app-sidebar" style={{ width: "min(260px, 100vw)", paddingTop: 24, background: "var(--canvas-background)" }}>
      <div style={{ padding: "0 20px 12px", fontSize: 14, color: "var(--text-muted)" }}>YMS-pi-uitext</div>
      <div role="tree" aria-label="Fixture sessions">
        {!removed && <SidebarSessionFixture
          session={{ id: "fixture-session", path: "/fixture/session.jsonl", cwd: "/fixture/project",
            name: title, firstMessage: "Fixture", messageCount: 4,
            created: RECENT, modified: RECENT, chatFolder: query.has("folder") }}
          isSelected onClick={() => setActivated(value => value + 1)} onDeleted={() => setRemoved(true)}
        />}
      </div>
    </aside>
    <main style={{ flex: 1, padding: 24, minWidth: 0, color: "var(--text-muted)" }}>
      <button type="button">Background control</button>
      <output data-activated>{activated}</output>
    </main>
  </div>;
}

createRoot(document.getElementById("root")).render(<I18nProvider><Fixture /></I18nProvider>);
