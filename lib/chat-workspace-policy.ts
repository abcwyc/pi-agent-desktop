import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InlineExtension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { isMcpTool } from "./mcp-read-only-policy";

/**
 * What a chat (the hidden, non-project workspace) may and may not do.
 *
 * A chat loads the same extensions, skills, prompt templates and MCP servers as a
 * project session, so a skill or an MCP tool works there. What it never gets is the
 * user's filesystem or a shell: the coding tools that write, run or search are blocked
 * outright, and `read` is kept only so a model can load the `SKILL.md` files that skills
 * are made of. Anything the user wants the model to see goes in through the composer's
 * attach button, which puts the content into the message itself.
 */

export const CHAT_WORKSPACE_EXTENSION_NAME = "pi-web-chat-workspace";

/** Coding tools a chat never runs, whoever asks (the model, tool_search, a codemode script). */
export const CHAT_BLOCKED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
]);

/** The only coding tool a chat keeps active; see `chatReadBlockReason`. */
export const CHAT_READ_TOOL_NAME = "read";

/**
 * The tools a chat may use: `read` (confined to skills), the two that reach other tools,
 * and every MCP tool. Any other extension tool stays off, because an installed extension
 * can carry file readers, computer control or sub-agents (which run with their own tools)
 * and a chat promises none of them.
 */
const CHAT_ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set([CHAT_READ_TOOL_NAME, "codemode", "tool_search"]);

export function isChatToolAllowed(tool: { name: string; sourceInfo?: unknown }): boolean {
  if (CHAT_BLOCKED_TOOL_NAMES.has(tool.name)) return false;
  return CHAT_ALLOWED_TOOL_NAMES.has(tool.name) || isMcpTool({ name: tool.name, sourceInfo: tool.sourceInfo as never });
}

export function chatUnavailableToolReason(toolName: string): string {
  return `"${toolName}" is not available in a chat. Chats can use skills and MCP tools; open a project to use other tools.`;
}

export const CHAT_WORKSPACE_PROMPT = `You are a helpful, knowledgeable assistant in a desktop chat app. Answer directly and accurately, and ask a clarifying question only when the request is genuinely ambiguous. Reply in the language the user writes in, and use Markdown when it makes the answer easier to read.

This is a general chat, not a project. You cannot see the user's files, run shell commands or edit anything on their computer. The user can attach images and files to a message; what they attach is included in the message itself. You may use the tools and skills made available to you, such as MCP servers. When the task needs files or a shell, tell the user to open a project instead.`;

export function chatBlockedToolReason(toolName: string): string {
  return `"${toolName}" is not available in a chat. Chats have no access to the user's files or shell; open a project to use it.`;
}

/**
 * Roots a chat's `read` may open: the directory of every skill that ships as a
 * `SKILL.md` folder (its scripts and references live beside it) and the exact file of a
 * single-file skill.
 */
export function skillReadRoots(
  skills: readonly { filePath: string; baseDir?: string }[],
): { directories: string[]; files: string[] } {
  const directories = new Set<string>();
  const files = new Set<string>();
  for (const skill of skills) {
    const real = safeRealpath(skill.filePath);
    if (!real) continue;
    if (basename(skill.filePath).toLowerCase() === "skill.md") {
      directories.add(dirname(real));
    } else {
      files.add(real);
    }
  }
  return { directories: [...directories], files: [...files] };
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function expandPath(rawPath: string, cwd: string): string {
  let value = rawPath.trim();
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") value = homedir();
  else if (value.startsWith("~/") || value.startsWith("~\\")) value = join(homedir(), value.slice(2));
  return isAbsolute(value) ? resolve(value) : resolve(cwd, value);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/**
 * Why a chat's `read` of `rawPath` is refused, or null when the path is inside a skill.
 * The path is resolved through symlinks before it is compared, so a link inside a skill
 * folder cannot lead out of it.
 */
export function chatReadBlockReason(
  rawPath: unknown,
  cwd: string,
  skills: readonly { filePath: string; baseDir?: string }[],
): string | null {
  const refusal = "Chats can only read skill files. Ask the user to attach the file to the message, or open a project to read files.";
  if (typeof rawPath !== "string" || !rawPath.trim()) return refusal;
  const real = safeRealpath(expandPath(rawPath, cwd));
  if (!real) return refusal;
  const roots = skillReadRoots(skills);
  if (roots.files.includes(real)) return null;
  if (roots.directories.some((root) => isInside(root, real))) return null;
  return refusal;
}

/**
 * Drop every extension that registers a tool able to hand work to another agent. A
 * subagent runs with its own tools, so it would carry the file and shell access a chat
 * is denied; the tool_call guard cannot see inside it.
 */
export function withoutAgentDelegation(
  base: LoadExtensionsResult,
  delegationToolNames: ReadonlySet<string>,
): LoadExtensionsResult {
  const dropped = new Set(
    base.extensions
      .filter((extension) => [...delegationToolNames].some((name) => extension.tools.has(name)))
      .map((extension) => extension.path),
  );
  if (dropped.size === 0) return base;
  return {
    ...base,
    extensions: base.extensions.filter((extension) => !dropped.has(extension.path)),
    errors: base.errors.filter((error) => !dropped.has(error.path)),
  };
}

/** `Today's date is …` for the model; a chat has no environment section of its own. */
export function chatDateSection(now: Date = new Date()): string {
  let timeZone: string | undefined;
  try {
    timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    timeZone = undefined;
  }
  const date = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).format(now);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    ...(timeZone ? { timeZone } : {}),
  }).format(now);
  return `Today's date is ${date} (${weekday})${timeZone ? `, time zone ${timeZone}` : ""}.`;
}

/**
 * Registers the chat's prompt sections and tool guard.
 *
 * `getSkills` and `getCwd` are read lazily on each call: the session (and with it the
 * resource loader) does not exist yet when the extension factory is built.
 */
export function createChatWorkspaceExtension(options: {
  getSkills: () => readonly { filePath: string; baseDir?: string }[];
  getCwd: () => string;
}): InlineExtension {
  return {
    name: CHAT_WORKSPACE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event) => {
        // An edit to selectedTools wins over the live loadout, so a tool an extension or
        // tool_search switched on cannot reach the model's declarations.
        const registered = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
        const selected = event.systemPromptOptions.selectedTools;
        const allowed = selected.filter((name) => isChatToolAllowed(registered.get(name) ?? { name }));
        if (allowed.length !== selected.length) event.systemPromptOptions.selectedTools = allowed;
        event.systemPromptOptions.sections.date = chatDateSection();
        // Pi appends the working directory to every prompt; a chat has none worth naming.
        event.systemPromptOptions.cwd = "(none)";
        return undefined;
      });
      // Nested calls (a codemode script's) pass through tool_call as well.
      pi.on("tool_call", (event) => {
        if (CHAT_BLOCKED_TOOL_NAMES.has(event.toolName)) {
          return { block: true, reason: chatBlockedToolReason(event.toolName) };
        }
        const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
        if (!isChatToolAllowed(tool ?? { name: event.toolName })) {
          return { block: true, reason: chatUnavailableToolReason(event.toolName) };
        }
        if (event.toolName === CHAT_READ_TOOL_NAME) {
          const input = event.input as { path?: unknown } | undefined;
          const reason = chatReadBlockReason(input?.path, options.getCwd(), options.getSkills());
          if (reason) return { block: true, reason };
        }
        return undefined;
      });
    },
  };
}
