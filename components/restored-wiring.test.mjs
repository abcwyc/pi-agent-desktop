import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

// Features whose code survived an upstream merge while the wiring that made
// them reachable did not. Each check fails if the wiring is dropped again.
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ModelScopeWarningBanner } = await jiti.import("./ChatInput.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const read = (file) => readFile(new URL(file, import.meta.url), "utf8");

test("model scope warnings can be dismissed and link to provider setup (#48)", async () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ModelScopeWarningBanner, {
      warnings: [{ code: "unauthenticated-provider", pattern: "acme/*", message: "", unauthenticatedProviders: ["acme"] }],
      onDismiss() {},
      dismissLabel: "Dismiss",
      onOpenModelsConfig() {},
    })));
  assert.match(html, /aria-label="Dismiss"/);
  assert.match(html, /Configure providers/);

  const chatInput = await read("./ChatInput.tsx");
  assert.match(chatInput, /<ModelScopeWarningBanner\s+warnings=\{modelScopeWarnings\}\s+onDismiss=\{onDismissModelScopeWarnings\}\s+dismissLabel=\{t\("chat\.modelScopeDismiss"\)\}\s+onOpenModelsConfig=\{onOpenModelsConfig\}/);
  const hook = await read("../hooks/useAgentSession.ts");
  assert.match(hook, /modelScopeWarnings: visibleModelScopeWarnings,/, "dismissed warnings must be filtered out");
});

test("patch diffs in chat follow the diff display setting", async () => {
  const messageView = await read("./MessageView.tsx");
  const splitPatch = messageView.slice(messageView.indexOf("function SplitPatchView("), messageView.indexOf("function SplitFilesView("));
  assert.match(splitPatch, /const \{ mode \} = useDiffViewMode\(\);/);
  assert.match(splitPatch, /<SplitFilesView files=\{files\} mode=\{mode\} \/>/);
});

test("the file viewer forwards whole-file @mentions to the text viewer", async () => {
  const viewer = await read("./FileViewer.tsx");
  const fileViewer = viewer.slice(viewer.indexOf("export function FileViewer("), viewer.indexOf("function TextFileViewer("));
  assert.match(fileViewer, /<TextFileViewer [^>]*onAtMention=\{onAtMention\}/);
});

test("long user messages scroll inside a height-capped bubble (#419)", async () => {
  const messageView = await read("./MessageView.tsx");
  const bubble = messageView.slice(messageView.indexOf("message-user-bubble"));
  assert.match(bubble.slice(0, 300), /maxHeight: USER_BUBBLE_MAX_HEIGHT,\s+overflowY: "auto",/);
});

test("the right-panel file tree refreshes when a run ends", async () => {
  const shell = await read("./AppShell.tsx");
  const explorer = shell.slice(shell.indexOf("<FileExplorer\n"));
  assert.match(explorer.slice(0, 400), /refreshKey=\{explorerRefreshKey\}/);
  assert.match(shell, /const handleAgentEnd = useCallback\(\(\) => \{[\s\S]{0,120}setExplorerRefreshKey\(/);
});

test("the sidebar scrollbar hides again and a failed list load is reported", async () => {
  const sidebar = await read("./SessionSidebar.tsx");
  // Without the ref the hide timer finds no element and `is-scrolling` sticks.
  assert.match(sidebar, /<div ref=\{listScrollRef\} className="sidebar-project-tree" onScroll=\{handleListScroll\}>/);
  assert.match(sidebar, /t\("sidebar\.loadFailed"\)/);
  assert.match(sidebar, /onClick=\{\(\) => void loadSessions\(true, true\)\}/);
});
