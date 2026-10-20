import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  ProjectContextMenuPanel,
  createProjectWorktree,
  currentCheckout,
  fetchProjectBranchMenu,
  fetchRemoteBranches,
  removeProjectWorktree,
} = await jiti.import("./ProjectContextMenu.tsx");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");

const ROOT = "/repo";
const MAIN = { path: ROOT, branch: "main", isMain: true };
const FEATURE = { path: "/repo-worktrees/feature", branch: "feature", isMain: false };

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

/** Answers fetch with `status`/`body` and records the requests. */
function stubFetch(status, body) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return calls;
}

test("the menu data carries isGit and falls back to an empty non-git state", async () => {
  stubFetch(200, { projectRoot: ROOT, isGit: true, branches: ["main"], remoteBranches: ["r"], worktrees: [MAIN] });
  assert.deepEqual(await fetchProjectBranchMenu(ROOT), {
    root: ROOT, isGit: true, branches: ["main"], remoteBranches: ["r"], worktrees: [MAIN], loaded: true,
  });
  stubFetch(200, { projectRoot: "/elsewhere", isGit: true });
  assert.equal((await fetchProjectBranchMenu(ROOT)).isGit, false);
  stubFetch(403, { error: "Access denied" });
  assert.deepEqual((await fetchProjectBranchMenu(ROOT)).worktrees, []);
});

test("fetching remote branches posts the project root and surfaces git's error", async () => {
  const calls = stubFetch(200, { success: true, branches: ["main", "x"], remoteBranches: ["y"] });
  assert.deepEqual(await fetchRemoteBranches(ROOT), { branches: ["main", "x"], remoteBranches: ["y"] });
  assert.deepEqual(calls, [{ url: "/api/worktrees/fetch", method: "POST", body: { cwd: ROOT } }]);
  stubFetch(400, { error: "fatal: unable to access remote" });
  await assert.rejects(fetchRemoteBranches(ROOT), /unable to access remote/);
});

test("creating a worktree posts the branch and returns its path", async () => {
  const calls = stubFetch(200, { path: FEATURE.path, branch: "feature" });
  assert.deepEqual(await createProjectWorktree(ROOT, "feature"), { path: FEATURE.path, branch: "feature" });
  assert.deepEqual(calls, [{ url: "/api/worktrees", method: "POST", body: { cwd: ROOT, branch: "feature" } }]);
  stubFetch(400, { error: "Directory already exists: /repo-worktrees/feature" });
  await assert.rejects(createProjectWorktree(ROOT, "feature"), /already exists/);
});

test("removing a dirty worktree asks for force first, then reports git's refusal", async () => {
  const calls = stubFetch(200, { success: true });
  assert.equal(await removeProjectWorktree(ROOT, FEATURE.path, false), "removed");
  assert.deepEqual(calls[0], { url: "/api/worktrees", method: "DELETE", body: { cwd: ROOT, path: FEATURE.path, force: false } });

  stubFetch(409, { error: "contains modified or untracked files", dirty: true });
  assert.equal(await removeProjectWorktree(ROOT, FEATURE.path, false), "needs-force");
  await assert.rejects(removeProjectWorktree(ROOT, FEATURE.path, true), /modified or untracked/);
  stubFetch(400, { error: "Cannot remove the main worktree" });
  await assert.rejects(removeProjectWorktree(ROOT, ROOT, false), /main worktree/);
});

test("the current checkout is the selected worktree, else the main one", () => {
  assert.equal(currentCheckout([MAIN, FEATURE], FEATURE.path), FEATURE);
  assert.equal(currentCheckout([MAIN, FEATURE], "/somewhere/else"), MAIN);
  assert.equal(currentCheckout([], null), undefined);
});

const noop = () => {};
function render(overrides = {}) {
  const props = {
    menuRef: { current: null },
    projectRoot: ROOT,
    pos: { top: 0, left: 0 },
    view: "actions",
    branchMenu: { root: ROOT, isGit: true, branches: ["main", "feature", "dev"], remoteBranches: ["remote-only"], worktrees: [MAIN, FEATURE], loaded: true },
    branchLoading: false,
    selectedCwd: FEATURE.path,
    switchingBranch: null,
    fetching: false,
    worktreeBusy: false,
    worktreeError: null,
    confirmRemove: null,
    newBranch: "",
    canReveal: true,
    revealLabel: "Reveal",
    projectRevealError: null,
    t: (key, params) => params ? `${key}(${Object.values(params).join(",")})` : key,
    onShowBranches: noop, onShowWorktrees: noop, onShowNewWorktree: noop, onBackToActions: noop,
    onOpenTerminal: noop, onReveal: noop, onArchive: noop, onSwitchBranch: noop, onFetch: noop,
    onSelectWorktree: noop, onRequestRemove: noop, onConfirmRemove: noop, onCancelRemove: noop,
    onNewBranchChange: noop, onCreateWorktree: noop,
    ...overrides,
  };
  return renderToStaticMarkup(React.createElement(ProjectContextMenuPanel, props));
}

test("the actions page offers branches and worktrees next to the existing entries", () => {
  const html = render();
  for (const key of ["sidebar.switchBranch", "sidebar.worktrees", "sidebar.openTerminalHere", "Reveal", "sidebar.archiveProject"]) {
    assert.ok(html.includes(key), key);
  }
  assert.doesNotMatch(html, /sidebar-project-context-menu--wide/);
});

test("the worktree page switches, removes non-main checkouts and creates new ones", () => {
  const html = render({ view: "worktrees" });
  assert.match(html, /sidebar-project-context-menu--wide/);
  assert.ok(html.includes("sidebar.switchWorktree"));
  // One remove button, for the feature worktree only; main is never removable.
  assert.equal(html.match(/worktree-remove-button/g)?.length, 1);
  assert.ok(html.includes(`sidebar.removeWorktreeTitle(${FEATURE.path})`));
  // Current-checkout semantics drive the shared selection pill; main keeps its tag.
  assert.match(html, /aria-current="true"><span class="sidebar-project-context-menu-label">feature<\/span>/);
  assert.match(html, /<span class="sidebar-project-context-menu-label">main<\/span><span class="sidebar-project-context-menu-branch-tag">sidebar.main<\/span>/);
  assert.ok(html.includes("sidebar.newWorktree"));
});

test("a removal is confirmed in place, and a dirty checkout asks for force", () => {
  const confirm = render({ view: "worktrees", confirmRemove: { path: FEATURE.path, force: false } });
  assert.ok(confirm.includes("sidebar.confirmRemoveWorktree"));
  assert.ok(confirm.includes("i18n.remove"));
  assert.equal(confirm.match(/worktree-remove-button/g), null);
  const force = render({ view: "worktrees", confirmRemove: { path: FEATURE.path, force: true } });
  assert.ok(force.includes("sidebar.forceRemoveCheckout"));
  assert.match(force, /sidebar-project-context-menu-danger[^>]*>sidebar.force</);
});

test("worktrees and fetch are hidden for a folder that is not a git repository", () => {
  const branchMenu = { root: ROOT, isGit: false, branches: [], remoteBranches: [], worktrees: [], loaded: true };
  const worktrees = render({ view: "worktrees", branchMenu });
  assert.ok(worktrees.includes("sidebar.worktreesNeedGit"));
  assert.ok(!worktrees.includes("sidebar.newWorktree"));
  const branches = render({ view: "branches", branchMenu });
  assert.ok(!branches.includes("sidebar.fetchBranches"));
  assert.ok(branches.includes("sidebar.noOtherBranches"));
});

test("the branch page leads with a fetch row that shows its progress", () => {
  const idle = render({ view: "branches" });
  assert.match(idle, /sidebar-project-context-menu-fetch[^>]*>.*sidebar.fetchBranches/);
  assert.ok(idle.includes("remote-only"));
  const busy = render({ view: "branches", fetching: true });
  assert.ok(busy.includes("sidebar.fetchingBranches"));
  assert.match(busy, /sidebar-project-context-menu-fetch"[^>]*disabled/);
});

test("the new-worktree page suggests local branches and only creates with a name", () => {
  const empty = render({ view: "new-worktree" });
  assert.match(empty, /<input[^>]*role="combobox"/);
  assert.doesNotMatch(empty, /<datalist|<select/);
  assert.match(empty, /sidebar-project-context-menu-primary"[^>]*disabled/);
  const named = render({ view: "new-worktree", newBranch: "topic" });
  assert.doesNotMatch(named, /sidebar-project-context-menu-primary"[^>]*disabled/);
  const busy = render({ view: "new-worktree", newBranch: "topic", worktreeBusy: true });
  assert.ok(busy.includes("sidebar.creating"));
});

test("git errors are shown on the page that caused them", () => {
  for (const view of ["branches", "worktrees", "new-worktree"]) {
    const html = render({ view, worktreeError: "fatal: invalid reference" });
    assert.match(html, /role="alert">fatal: invalid reference</, view);
  }
});

test("the sidebar wires the worktree pages into both the DOM and the native menu", async () => {
  const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
  // Native: a Worktrees entry next to Switch branch, and fetch in the branch popup.
  assert.match(sidebar, /label: t\("sidebar\.worktrees"\), onSelect: \(\) => void showNativeWorktreeMenu\(projectRoot, at\)/);
  assert.match(sidebar, /showNativeProjectWorktreeMenu\(\{/);
  assert.match(sidebar, /onFetch: \(root\) => void \(async \(\) => \{/);
  // Steps a native menu cannot do open the DOM menu at the same point.
  assert.match(sidebar, /openDomProjectMenu\(root, point, "new-worktree", loaded\)/);
  assert.match(sidebar, /openDomProjectMenu\(root, point, "worktrees", loaded\);\s+requestWorktreeRemoval\(path\)/);
  // DOM: the view and every worktree action reach the menu.
  for (const prop of ["view={projectMenuView}", "onFetch=", "onSelectWorktree=", "onConfirmRemove=", "onCreateWorktree="]) {
    assert.ok(sidebar.includes(prop), prop);
  }
  // The hidden header panel and its branch list are gone for good.
  assert.doesNotMatch(sidebar, /showLegacyHeaderProjectRows|WorktreeBranchList|wtDropdownOpen|sidebar-folder-row/);
});
