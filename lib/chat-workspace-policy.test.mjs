import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { fileSymlinksAvailable, fileSymlinkSkip, linkDirectory } from "../scripts/test-platform.mjs";

const jiti = createJiti(import.meta.url);
const {
  CHAT_BLOCKED_TOOL_NAMES,
  CHAT_FOLDER_DEFAULT_TOOL_NAMES,
  chatDateSection,
  chatFolderToolBlockReason,
  isInsideChatFolder,
  chatReadBlockReason,
  createChatWorkspaceExtension,
  isChatToolAllowed,
  withoutAgentDelegation,
} = await jiti.import("./chat-workspace-policy.ts");

const [newRoute, sessionsRoute, validateRoute, rpcManager, sessionReader] = await Promise.all([
  readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/sessions/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/api/cwd/validate/route.ts", import.meta.url), "utf8"),
  readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8"),
  readFile(new URL("./session-reader.ts", import.meta.url), "utf8"),
]);

test("new chats ignore the requested tool preset and leave the policy to the server", () => {
  assert.match(newRoute, /const chatWorkspace = typeof cwd === "string" && isChatWorkspacePath\(cwd\)/);
  assert.match(newRoute, /const toolNames = chatWorkspace \? undefined : requestedToolNames/);
  assert.match(newRoute, /if \(chatWorkspace\) await ensureChatWorkspace\(\)/);
  // The chat root is only a request: the chat runs in a folder of its own.
  assert.match(newRoute, /allowFileRoot\(session\.cwd \|\| cwd\)/);
});

test("persisted chat sessions load extensions and skills but no context files", () => {
  const startup = rpcManager.slice(rpcManager.indexOf("export async function startRpcSession"));

  assert.match(startup, /const chatWorkspace = isChatWorkspacePath\(sessionCwd\)/);
  assert.match(startup, /const subagentResources = sessionFile && !chatWorkspace/);
  // A stale tool selection in an old chat's transcript is ignored.
  assert.match(startup, /const pinnedToolNames = chatWorkspace\s*\?\s*undefined\s*:/);
  assert.match(startup, /noContextFiles: true,\s*systemPrompt: chatWorkspacePrompt\(chatFilesEnabled, \{ folder: chatFolder, unlocked: chatUnlocked \}\)/);
  // A new chat is requested with the chat root and gets a folder; an unlocked chat is never one on an exposed server.
  assert.match(startup, /isChatRootPath\(cwd\) \? await createChatFolder\(\) : cwd/);
  assert.match(startup, /const chatUnlocked = chatFolder\s*&& !isNetworkExposedServer\(\)\s*&& readChatUnlocked\(/);
  assert.match(startup, /createChatWorkspaceExtension\(\{/);
  // Delegating to another agent would carry the file access a chat is denied.
  assert.match(startup, /withoutAgentDelegation\(base, CHAT_DELEGATION_TOOL_NAMES\)/);
  // A chat with a folder keeps the file tools (confined to it); a legacy chat keeps `read` alone.
  assert.match(startup, /chatFolder \? \[\.\.\.CHAT_FOLDER_TOOL_NAMES\] : \[CHAT_READ_TOOL_NAME\]/);
  assert.match(startup, /chatWorkspace,\s*chatFolder,\s*chatUnlocked,\s*onAgentRunComplete/);
  // Only a legacy chat saves to Downloads; a chat with a folder saves into it.
  assert.match(startup, /chatGrants && !chatFolder/);
  // A chat sends Pi's structured sections, not an exact prompt override.
  assert.doesNotMatch(startup, /chatWorkspace\s*\?\s*\(\) => ""/);
});

test("chat runtimes reject shell and tool mutations", () => {
  const setTools = rpcManager.slice(
    rpcManager.indexOf('case "set_tools"'),
    rpcManager.indexOf('case "reload"'),
  );
  const bash = rpcManager.slice(
    rpcManager.indexOf('case "bash"'),
    rpcManager.indexOf('case "abort_bash"'),
  );
  const setter = rpcManager.slice(
    rpcManager.indexOf("export async function setRpcSessionTools"),
    rpcManager.indexOf("export function getRunningRpcSessionIds"),
  );

  assert.match(setTools, /if \(this\.chatWorkspace \|\| this\.chatUnlocked\) \{\s*throw new Error\("Chats have no tools\. Open a project to change the tool preset\."\)/);
  assert.match(bash, /if \(this\.chatWorkspace\) \{\s*throw new Error\("Shell commands are unavailable in chats\. Open a project to run one\."\)/);
  assert.match(setter, /if \(isChatWorkspacePath\(manager\.getCwd\(\)\)\) \{\s*throw new Error\("Chats have no tools/);
  assert.match(setter, /if \(existing\.isChat\(\)\) \{\s*throw new Error\("Chats have no tools/);
});

test("chat runtimes list their tools and slash commands without the blocked coding tools", () => {
  const getTools = rpcManager.slice(
    rpcManager.indexOf('case "get_tools"'),
    rpcManager.indexOf('case "get_commands"'),
  );
  const getCommands = rpcManager.slice(
    rpcManager.indexOf('case "get_commands"'),
    rpcManager.indexOf('case "set_tools"'),
  );

  assert.match(getTools, /this\.chatWorkspace && chatBlockedToolNames\(this\.chatFolder\)\.has\(t\.name\)/);
  assert.doesNotMatch(getTools, /if \(this\.chatWorkspace\) return \[\]/);
  assert.doesNotMatch(getCommands, /this\.chatWorkspace/);
});

test("navigating a chat's tree re-applies the chat tool selection", () => {
  const navigate = rpcManager.slice(
    rpcManager.indexOf("private async navigateTreeKeepingToolSelection"),
    rpcManager.indexOf("private emit(event"),
  );
  assert.match(navigate, /if \(this\.chatWorkspace\) \{[\s\S]*?\[CHAT_READ_TOOL_NAME\]/);
  // An unlocked chat keeps whatever pi restored, like a project session.
  assert.match(navigate, /this\.chatOnly \|\| this\.chatUnlocked/);
});

test("server session classification strips every project field from chats", () => {
  assert.match(
    sessionReader,
    /if \(isChatWorkspacePath\(session\.cwd\)\) \{\s*return \{\s*\.\.\.session,\s*workspaceKind: "chat" as const,\s*\.\.\.\(isChatFolderPath\(session\.cwd\) \? \{ chatFolder: true \} : \{\}\),\s*projectRoot: undefined,\s*projectKey: undefined,\s*branch: undefined,\s*isWorktree: undefined,/,
  );
  assert.match(
    sessionReader,
    /await Promise\.all\(uniqueCwds\.map\(async \(cwd\) => \{\s*if \(isChatWorkspacePath\(cwd\)\) return;/,
  );
});

test("chat workspace cwd is server-owned and allow-listed", () => {
  assert.match(sessionsRoute, /ensureChatWorkspace\(\)/);
  assert.match(sessionsRoute, /allowFileRoot\(chatWorkspaceCwd\)/);
  assert.match(sessionsRoute, /chatWorkspaceCwd,/);
  assert.match(validateRoute, /if \(isChatWorkspacePath\(normalizedCwd\)\) \{[\s\S]*?workspaceKind: "chat"/);
});

async function skillFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-chat-skill-"));
  const skillDir = path.join(root, "skills", "writer");
  await mkdir(path.join(skillDir, "references"), { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "# writer");
  await writeFile(path.join(skillDir, "references", "style.md"), "style");
  const single = path.join(root, "skills", "single.md");
  await writeFile(single, "# single");
  const secret = path.join(root, "secret.txt");
  await writeFile(secret, "secret");
  // A file symlink needs Developer Mode on Windows; the test that reads it skips there.
  if (fileSymlinksAvailable) await symlink(secret, path.join(skillDir, "escape.txt"));
  const skills = [
    { filePath: path.join(skillDir, "SKILL.md"), baseDir: skillDir },
    { filePath: single, baseDir: path.dirname(single) },
  ];
  return { root, skillDir, single, secret, skills, cwd: path.join(root, "cwd") };
}

test("a chat reads skill files and nothing else", async () => {
  const { skillDir, single, secret, skills, cwd } = await skillFixture();
  assert.equal(chatReadBlockReason(path.join(skillDir, "SKILL.md"), cwd, skills), null);
  assert.equal(chatReadBlockReason(path.join(skillDir, "references", "style.md"), cwd, skills), null);
  assert.equal(chatReadBlockReason(single, cwd, skills), null);
  assert.match(chatReadBlockReason(secret, cwd, skills), /Chats can only read skill files/);
  assert.match(chatReadBlockReason(os.homedir(), cwd, skills), /Chats can only read skill files/);
  assert.match(chatReadBlockReason(undefined, cwd, skills), /Chats can only read skill files/);
  assert.match(chatReadBlockReason("", cwd, skills), /Chats can only read skill files/);
  // A single-file skill does not open its siblings.
  assert.match(chatReadBlockReason(path.join(path.dirname(single), "writer", "references", "style.md"), cwd, [skills[1]]), /Chats can only read/);
});

test("a chat's read cannot leave a skill folder by ../ or a symlink", async (t) => {
  const { skillDir, secret, skills, cwd } = await skillFixture();
  assert.match(chatReadBlockReason(path.join(skillDir, "..", "..", "secret.txt"), cwd, skills), /Chats can only read/);
  await t.test("refuses a file link leaving the skill folder", { skip: fileSymlinkSkip }, () => {
    assert.match(chatReadBlockReason(path.join(skillDir, "escape.txt"), cwd, skills), /Chats can only read/);
  });
  assert.match(chatReadBlockReason(`@${secret}`, cwd, skills), /Chats can only read/);
  // Nothing is readable without a skill.
  assert.match(chatReadBlockReason(path.join(skillDir, "SKILL.md"), cwd, []), /Chats can only read/);
});

test("the chat policy blocks shell, edit and search tools and guards read", async () => {
  assert.deepEqual(
    [...CHAT_BLOCKED_TOOL_NAMES].sort(),
    ["bash", "edit", "find", "grep", "ls", "powershell", "write"],
  );
  const { skillDir, secret, skills, cwd } = await skillFixture();
  const handlers = {};
  const extension = createChatWorkspaceExtension({ getSkills: () => skills, getCwd: () => cwd });
  extension.factory({
    on: (name, handler) => { handlers[name] = handler; },
    getAllTools: () => [{ name: "read" }, { name: "mcp__docs__search", annotations: { readOnlyHint: true } }],
  });

  for (const toolName of CHAT_BLOCKED_TOOL_NAMES) {
    assert.equal(handlers.tool_call({ toolName, input: {} }).block, true, toolName);
  }
  assert.equal(handlers.tool_call({ toolName: "read", input: { path: secret } }).block, true);
  assert.equal(handlers.tool_call({ toolName: "read", input: { path: path.join(skillDir, "SKILL.md") } }), undefined);
  // A read-only MCP tool passes through.
  assert.equal(handlers.tool_call({ toolName: "mcp__docs__search", input: {} }), undefined);

  const event = { systemPromptOptions: { sections: {}, cwd, selectedTools: ["read"] } };
  handlers.before_agent_start(event);
  assert.match(event.systemPromptOptions.sections.date, /^Today's date is \d{4}-\d{2}-\d{2}/);
  // The hidden workspace path never reaches the model.
  assert.equal(event.systemPromptOptions.cwd, "(none)");
});

test("the date section names the day in the user's time zone", () => {
  const text = chatDateSection(new Date("2026-10-19T12:00:00Z"));
  assert.match(text, /^Today's date is 2026-10-(19|20) \((Monday|Tuesday)\)/);
});

test("extensions that delegate to another agent are dropped from a chat", () => {
  const extensions = [
    { path: "/ext/mcp", tools: new Set(["mcp"]) },
    { path: "/ext/subagents", tools: new Set(["Agent", "other"]) },
  ];
  const base = {
    extensions,
    errors: [{ path: "/ext/subagents", error: "x" }, { path: "/ext/mcp", error: "y" }],
  };
  const result = withoutAgentDelegation(base, new Set(["Agent"]));
  assert.deepEqual(result.extensions.map((extension) => extension.path), ["/ext/mcp"]);
  assert.deepEqual(result.errors.map((error) => error.path), ["/ext/mcp"]);
  assert.equal(withoutAgentDelegation({ extensions: [extensions[0]], errors: [] }, new Set(["Agent"])).extensions.length, 1);
});

test("a chat allows its defaults and MCP tools, and no other extension tool", () => {
  for (const name of ["read", "codemode", "tool_search", "mcp__docs__search", "save_to_downloads", "web_search", "fetch_content"]) {
    assert.equal(isChatToolAllowed({ name }), true, name);
  }
  // File readers, computer control, sub-agents and browsers from installed extensions stay off.
  for (const name of ["bash", "edit", "subagent", "act_ui", "read_text", "launch_browser", "find_roots", "Agent"]) {
    assert.equal(isChatToolAllowed({ name }), false, name);
  }
});

test("the chat extension narrows the run's tools and blocks other extension tools", async () => {
  const handlers = {};
  const registered = [
    { name: "act_ui" },
    { name: "mcp__docs__search", annotations: { readOnlyHint: true } },
    { name: "codemode" },
    { name: "read" },
  ];
  const extension = createChatWorkspaceExtension({ getSkills: () => [], getCwd: () => "/tmp" });
  extension.factory({ on: (name, handler) => { handlers[name] = handler; }, getAllTools: () => registered });

  const event = {
    systemPromptOptions: {
      sections: {},
      cwd: "/x",
      selectedTools: ["read", "act_ui", "mcp__docs__search", "subagent", "bash", "codemode"],
    },
  };
  handlers.before_agent_start(event);
  assert.deepEqual(event.systemPromptOptions.selectedTools, ["read", "mcp__docs__search", "codemode"]);

  assert.equal(handlers.tool_call({ toolName: "act_ui", input: {} }).block, true);
  assert.equal(handlers.tool_call({ toolName: "subagent", input: {} }).block, true);
  assert.equal(handlers.tool_call({ toolName: "mcp__docs__search", input: {} }), undefined);
  assert.equal(handlers.tool_call({ toolName: "codemode", input: {} }), undefined);
});

test("continuing a chat in a project copies it without the chat's prompt and tool declarations", async () => {
  const route = await readFile(new URL("../app/api/sessions/[id]/continue-in-project/route.ts", import.meta.url), "utf8");
  // Only a chat can be copied, into a real project folder, and never while it runs.
  assert.match(route, /isChatWorkspacePath\(cwd\)/);
  assert.match(route, /!isChatWorkspacePath\(header\.cwd\)/);
  assert.match(route, /getRpcSession\(id\)\?\.isRunning\(\)/);
  assert.match(route, /SessionManager\.forkFrom\(filePath, cwd\)/);
  assert.match(route, /appendClearedSessionToolSelection\(manager\)/);
  // The chat's system messages declare read + codemode, which pi would restore in the project.
  assert.match(route, /forgetChatSystemPrompt\(copiedFile\)/);
});

test("chat settings reach a new chat's model, reasoning and prompt, and the composer's default", async () => {
  const models = await readFile(new URL("../app/api/models/route.ts", import.meta.url), "utf8");
  const settingsRoute = await readFile(new URL("../app/api/chat-settings/route.ts", import.meta.url), "utf8");
  const startup = rpcManager.slice(rpcManager.indexOf("export async function startRpcSession"));

  // Only a brand-new chat takes them; an explicit pick for the session wins; unset follows the global default.
  assert.match(startup, /chatWorkspace && !hasExistingMessages\s*\?\s*resolveChatStartDefaults\(readChatSettings\(\), scope\.visible\)/);
  assert.match(startup, /effectiveInitialModel \?\? chatStart\.requestedModel/);
  assert.match(startup, /thinkingLevel \?\? chatStart\.thinkingLevel/);
  // The instructions are re-read on every run.
  assert.match(startup, /getInstructions: \(\) => chatInstructionsSection\(readChatSettings\(\)\)/);
  // The composer asks /api/models for the same default, so what it shows is what starts.
  assert.match(models, /isChatWorkspacePath\(cwd\)\s*\?\s*resolveChatStartDefaults\(readChatSettings\(\), visible\)/);
  // Saving drops the cached model list that carries that default.
  assert.match(settingsRoute, /invalidateModelsCache\(\)/);
  assert.match(settingsRoute, /isApiRequestAllowed\(req\)/);
});

test("the session policy is computed once and the wrapper reads it", () => {
  const startup = rpcManager.slice(rpcManager.indexOf("export async function startRpcSession"));
  assert.match(startup, /const sessionPolicy = deriveSessionPolicy\(\{\s*chatWorkspace,/);
  assert.match(rpcManager, /private readonly policy: SessionPolicy/);
  assert.match(rpcManager, /private get chatWorkspace\(\): boolean \{\s*return this\.policy\.kind === "chat"/);
});

test("a tool the user allowed in Settings › Chats works in a chat, but a blocked coding tool never does", () => {
  const extra = new Set(["launch_browser", "bash"]);
  assert.equal(isChatToolAllowed({ name: "launch_browser" }), false);
  assert.equal(isChatToolAllowed({ name: "launch_browser" }, extra), true);
  assert.equal(isChatToolAllowed({ name: "bash" }, extra), false);

  const handlers = {};
  const registered = [{ name: "launch_browser" }, { name: "act_ui" }];
  createChatWorkspaceExtension({ getSkills: () => [], getCwd: () => "/tmp", getExtraTools: () => ["launch_browser"] })
    .factory({ on: (name, handler) => { handlers[name] = handler; }, getAllTools: () => registered });
  const event = { systemPromptOptions: { sections: {}, cwd: "/x", selectedTools: ["read", "launch_browser", "act_ui"] } };
  handlers.before_agent_start(event);
  assert.deepEqual(event.systemPromptOptions.selectedTools, ["read", "launch_browser"]);
  assert.equal(handlers.tool_call({ toolName: "launch_browser", input: {} }), undefined);
  assert.equal(handlers.tool_call({ toolName: "act_ui", input: {} }).block, true);
});

test("the chat prompt says what this chat can do, and MCP writes only once it is unlocked", async () => {
  const { chatWorkspacePrompt } = await createJiti(import.meta.url).import("./chat-workspace-policy.ts");
  for (const filesEnabled of [true, false]) {
    for (const scope of [{}, { folder: true }]) {
      const prompt = chatWorkspacePrompt(filesEnabled, scope);
      assert.match(prompt, /MCP tools work here only when their server marks them read-only/);
      assert.doesNotMatch(prompt, /can do more than read/);
    }
  }
  const folder = chatWorkspacePrompt(true, { folder: true });
  assert.match(folder, /working folder of its own/);
  assert.match(folder, /no shell/);
  assert.match(folder, /use their computer from the chat's menu/);
  assert.match(folder, /full path in their own message/);
  assert.doesNotMatch(chatWorkspacePrompt(false, { folder: true }), /full path in their own message/);
  const unlocked = chatWorkspacePrompt(true, { folder: true, unlocked: true });
  assert.match(unlocked, /you have a shell/);
  assert.match(unlocked, /can do more than read/);
});

async function folderFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-chat-folder-policy-"));
  const folder = path.join(root, "chats", "20261022-101500-ab12cd34");
  await mkdir(path.join(folder, "notes"), { recursive: true });
  await writeFile(path.join(folder, "notes", "a.md"), "a");
  const outside = path.join(root, "outside.txt");
  await writeFile(outside, "outside");
  await mkdir(path.join(root, "other-dir"));
  if (fileSymlinksAvailable) await symlink(outside, path.join(folder, "link-to-file.txt"));
  await linkDirectory(path.join(root, "other-dir"), path.join(folder, "link-to-dir"));
  return { root, folder, outside };
}

function registerFolderChat(options = {}) {
  const handlers = {};
  const registered = options.registered ?? [
    { name: "read" }, { name: "write" }, { name: "edit" }, { name: "grep" }, { name: "find" }, { name: "ls" },
    { name: "bash" }, { name: "mcp__docs__search", annotations: { readOnlyHint: true } }, { name: "mcp__fs__write_file" },
  ];
  createChatWorkspaceExtension({
    getSkills: () => options.skills ?? [],
    getCwd: () => options.folder,
    folder: true,
    ...options.extension,
  }).factory({ on: (name, handler) => { handlers[name] = handler; }, getAllTools: () => registered });
  return handlers;
}

test("a chat with a folder keeps the file tools, replaces save_to_downloads, and still has no shell", () => {
  for (const name of ["read", "write", "edit", "grep", "find", "ls", "codemode", "web_search", "mcp__docs__search"]) {
    assert.equal(isChatToolAllowed({ name }, undefined, true), true, name);
  }
  assert.equal(isChatToolAllowed({ name: "save_to_downloads" }, undefined, true), false);
  for (const name of ["bash", "powershell"]) {
    assert.equal(isChatToolAllowed({ name }, new Set([name]), true), false, name);
  }
  assert.equal(CHAT_FOLDER_DEFAULT_TOOL_NAMES.includes("save_to_downloads"), false);
  // A legacy chat is unchanged: it never gets write, edit or the search tools.
  for (const name of ["write", "edit", "grep", "find", "ls"]) {
    assert.equal(isChatToolAllowed({ name }), false, name);
  }
});

test("write, edit and search tools stay inside the chat's folder", async (t) => {
  const { folder, outside, root } = await folderFixture();
  const inside = (toolName, input) => chatFolderToolBlockReason(toolName, input, folder, []);

  // A relative path starts in the folder, and a file that does not exist yet is judged by where it would land.
  assert.equal(inside("write", { path: "report.md", content: "x" }), null);
  assert.equal(inside("write", { path: "deep/new/dir/report.md", content: "x" }), null);
  assert.equal(inside("write", { path: path.join(folder, "notes", "b.md"), content: "x" }), null);
  assert.equal(inside("edit", { path: "notes/a.md", edits: [] }), null);
  assert.equal(inside("ls", {}), null);
  assert.equal(inside("ls", { path: "notes" }), null);
  assert.equal(inside("grep", { pattern: "x", glob: "**/*.md" }), null);
  assert.equal(inside("find", { pattern: "**/*.md" }), null);

  for (const bad of [
    outside,
    path.join(root, "new.md"),
    "../outside.txt",
    "notes/../../outside.txt",
    "~/Desktop/x.md",
    "link-to-dir/new.md",
    "",
    undefined,
    42,
  ]) {
    assert.match(inside("write", { path: bad, content: "x" }) ?? "", /only works inside this chat's own folder|^$/, String(bad));
    assert.notEqual(inside("write", { path: bad, content: "x" }), null, String(bad));
    assert.notEqual(inside("edit", { path: bad, edits: [] }), null, String(bad));
  }
  assert.notEqual(inside("ls", { path: root }), null);
  assert.notEqual(inside("grep", { pattern: "x", path: "link-to-dir" }), null);
  assert.notEqual(inside("find", { pattern: "*", path: ".." }), null);
  // A pattern or glob that starts at the root or climbs out would search beyond the folder.
  assert.notEqual(inside("find", { pattern: "/etc/**" }), null);
  assert.notEqual(inside("find", { pattern: "../**" }), null);
  assert.notEqual(inside("grep", { pattern: "x", glob: "../../**" }), null);
  assert.notEqual(inside("grep", { pattern: "x", glob: "~/**" }), null);
  assert.equal(isInsideChatFolder("notes/a.md", folder), true);
  assert.equal(isInsideChatFolder("a\0b", folder), false);
  await t.test("refuses writing and editing through an external file link", { skip: fileSymlinkSkip }, () => {
    assert.notEqual(inside("write", { path: "link-to-file.txt", content: "x" }), null);
    assert.notEqual(inside("edit", { path: "link-to-file.txt", edits: [] }), null);
  });
});

test("read opens the folder, skills and files the user named, and nothing else", async (t) => {
  const { folder, outside, root } = await folderFixture();
  const skillDir = path.join(root, "skills", "writer");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "# writer");
  const skills = [{ filePath: path.join(skillDir, "SKILL.md"), baseDir: skillDir }];
  const read = (p, grants) => chatFolderToolBlockReason("read", { path: p }, folder, skills, grants);

  assert.equal(read("notes/a.md"), null);
  assert.equal(read(path.join(skillDir, "SKILL.md")), null);
  assert.match(read(outside) ?? "", /own folder, skill files, and files the user named/);
  assert.match(read("link-to-dir/private.txt") ?? "", /own folder, skill files/);
  await t.test("an external file link needs a user grant", { skip: fileSymlinkSkip }, () => {
    assert.match(read("link-to-file.txt") ?? "", /own folder, skill files/);
  });
  const grants = { allows: (real) => real === fs_realpath(outside) };
  assert.equal(read(outside, grants), null, "a file the user named by full path");
});

function fs_realpath(p) {
  return realpathSync(p);
}

test("the chat extension confines a folder chat's tools and blocks the shell and unmarked MCP tools", async () => {
  const { folder, outside } = await folderFixture();
  const handlers = registerFolderChat({ folder });

  assert.equal(handlers.tool_call({ toolName: "bash", input: { command: "ls" } }).block, true);
  assert.match(handlers.tool_call({ toolName: "bash", input: {} }).reason, /no shell/);
  assert.equal(handlers.tool_call({ toolName: "write", input: { path: "a.md", content: "x" } }), undefined);
  assert.equal(handlers.tool_call({ toolName: "write", input: { path: outside, content: "x" } }).block, true);
  assert.equal(handlers.tool_call({ toolName: "edit", input: { path: "../outside.txt", edits: [] } }).block, true);
  assert.equal(handlers.tool_call({ toolName: "read", input: { path: "notes/a.md" } }), undefined);
  assert.equal(handlers.tool_call({ toolName: "ls", input: {} }), undefined);
  // MCP: read-only tools run, anything its server does not mark read-only does not.
  assert.equal(handlers.tool_call({ toolName: "mcp__docs__search", input: {} }), undefined);
  const blocked = handlers.tool_call({ toolName: "mcp__fs__write_file", input: {} });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /does not mark read-only/);
  assert.match(blocked.reason, /Settings › Chats/);

  // The model's tools: the file tools stay, the shell goes.
  const event = { systemPromptOptions: { sections: {}, cwd: "/x", selectedTools: ["read", "write", "edit", "bash", "ls"] } };
  handlers.before_agent_start(event);
  assert.deepEqual(event.systemPromptOptions.selectedTools, ["read", "write", "edit", "ls"]);
  // The model is told its folder, not "(none)".
  assert.equal(event.systemPromptOptions.cwd, folder);
});

test("a tool the user named in Settings › Chats runs even if its MCP server does not mark it read-only", async () => {
  const { folder } = await folderFixture();
  const handlers = registerFolderChat({ folder, extension: { getExtraTools: () => ["mcp__fs__write_file"] } });
  assert.equal(handlers.tool_call({ toolName: "mcp__fs__write_file", input: {} }), undefined);
});

test("an unlocked chat keeps the chat prompt sections but no tool limits", async () => {
  const { folder, outside } = await folderFixture();
  const handlers = registerFolderChat({ folder, extension: { unrestricted: true } });
  assert.equal(handlers.tool_call, undefined, "no tool guard is registered");
  const event = { systemPromptOptions: { sections: {}, cwd: "/x", selectedTools: ["read", "bash", "write", "act_ui"] } };
  handlers.before_agent_start(event);
  assert.deepEqual(event.systemPromptOptions.selectedTools, ["read", "bash", "write", "act_ui"]);
  assert.match(event.systemPromptOptions.sections.date, /^Today's date is/);
  assert.equal(event.systemPromptOptions.cwd, folder);
  assert.equal(outside.length > 0, true);
});
