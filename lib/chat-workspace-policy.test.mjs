import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  CHAT_BLOCKED_TOOL_NAMES,
  chatDateSection,
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
});

test("persisted chat sessions load extensions and skills but no context files", () => {
  const startup = rpcManager.slice(rpcManager.indexOf("export async function startRpcSession"));

  assert.match(startup, /const chatWorkspace = isChatWorkspacePath\(sessionCwd\)/);
  assert.match(startup, /const subagentResources = sessionFile && !chatWorkspace/);
  // A stale tool selection in an old chat's transcript is ignored.
  assert.match(startup, /const selectedToolNames = chatWorkspace\s*\?\s*undefined\s*:/);
  assert.match(startup, /noContextFiles: true,\s*systemPrompt: chatWorkspacePrompt\(chatFilesEnabled\)/);
  assert.match(startup, /createChatWorkspaceExtension\(\{/);
  // Delegating to another agent would carry the file access a chat is denied.
  assert.match(startup, /withoutAgentDelegation\(base, CHAT_DELEGATION_TOOL_NAMES\)/);
  // The chat keeps `read` alone among the coding tools, confined to skill files.
  assert.match(startup, /chatWorkspace \? \[CHAT_READ_TOOL_NAME\] : selectedToolNames \?\? initialToolNames/);
  assert.match(startup, /chatWorkspace,\s*onAgentRunComplete/);
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

  assert.match(setTools, /if \(this\.chatWorkspace\) \{\s*throw new Error\("Chats have no tools\. Open a project to change the tool preset\."\)/);
  assert.match(bash, /if \(this\.chatWorkspace\) \{\s*throw new Error\("Shell commands are unavailable in chats\. Open a project to run one\."\)/);
  assert.match(setter, /if \(isChatWorkspacePath\(manager\.getCwd\(\)\)\) \{\s*throw new Error\("Chats have no tools/);
  assert.match(setter, /if \(existing\.isChatWorkspace\(\)\) \{\s*throw new Error\("Chats have no tools/);
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

  assert.match(getTools, /this\.chatWorkspace && CHAT_BLOCKED_TOOL_NAMES\.has\(t\.name\)/);
  assert.doesNotMatch(getTools, /if \(this\.chatWorkspace\) return \[\]/);
  assert.doesNotMatch(getCommands, /this\.chatWorkspace/);
});

test("navigating a chat's tree re-applies the chat tool selection", () => {
  const navigate = rpcManager.slice(
    rpcManager.indexOf("private async navigateTreeKeepingToolSelection"),
    rpcManager.indexOf("private emit(event"),
  );
  assert.match(navigate, /if \(this\.chatWorkspace\) \{[\s\S]*?\[CHAT_READ_TOOL_NAME\]/);
});

test("server session classification strips every project field from chats", () => {
  assert.match(
    sessionReader,
    /if \(isChatWorkspacePath\(session\.cwd\)\) \{\s*return \{\s*\.\.\.session,\s*workspaceKind: "chat" as const,\s*projectRoot: undefined,\s*projectKey: undefined,\s*branch: undefined,\s*isWorktree: undefined,/,
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
  await symlink(secret, path.join(skillDir, "escape.txt"));
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

test("a chat's read cannot leave a skill folder by ../ or a symlink", async () => {
  const { skillDir, secret, skills, cwd } = await skillFixture();
  assert.match(chatReadBlockReason(path.join(skillDir, "..", "..", "secret.txt"), cwd, skills), /Chats can only read/);
  assert.match(chatReadBlockReason(path.join(skillDir, "escape.txt"), cwd, skills), /Chats can only read/);
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
  extension.factory({ on: (name, handler) => { handlers[name] = handler; }, getAllTools: () => [{ name: "read" }] });

  for (const toolName of CHAT_BLOCKED_TOOL_NAMES) {
    assert.equal(handlers.tool_call({ toolName, input: {} }).block, true, toolName);
  }
  assert.equal(handlers.tool_call({ toolName: "read", input: { path: secret } }).block, true);
  assert.equal(handlers.tool_call({ toolName: "read", input: { path: path.join(skillDir, "SKILL.md") } }), undefined);
  // Extension and MCP tools pass through.
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
  const registered = [{ name: "act_ui" }, { name: "mcp__docs__search" }, { name: "codemode" }, { name: "read" }];
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
