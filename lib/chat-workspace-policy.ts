import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { InlineExtension, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { isMcpTool } from "./mcp-read-only-policy";
import { isSensitivePath, type ChatFileGrants } from "./chat-file-access";
import { SAVE_TO_DOWNLOADS_TOOL_NAME } from "./chat-downloads-tool";

/**
 * What a chat (the hidden, non-project workspace) may and may not do.
 *
 * A chat loads the same extensions, skills, prompt templates and MCP servers as a
 * project session, so a skill or an MCP tool works there. What it never gets is the
 * user's filesystem or a shell: the coding tools that write, run or search are blocked
 * outright, and `read` opens only skill files, files the user named by path in their own
 * messages, and files the chat saved (lib/chat-file-access.ts). Whatever else the user
 * wants the model to see goes in through the composer's attach button, which puts the
 * content into the message itself. The one thing a chat writes is `save_to_downloads`.
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
 * The tools a chat may use by default: `read` (confined, see above), the two that reach
 * other tools, every MCP tool, `save_to_downloads`, and the well-known read-only web tools
 * (search and fetch). Any other extension tool stays off, because an installed extension
 * can carry file readers, computer control or sub-agents (which run with their own tools);
 * the user adds those by name in Settings › Chats.
 */
export const CHAT_DEFAULT_TOOL_NAMES: readonly string[] = [
  CHAT_READ_TOOL_NAME,
  "codemode",
  "tool_search",
  SAVE_TO_DOWNLOADS_TOOL_NAME,
  "web_search",
  "fetch_content",
  "source_check",
  "get_search_content",
];
const CHAT_ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set(CHAT_DEFAULT_TOOL_NAMES);

/**
 * `extraAllowed` is the user's own list (Settings › Chats). It can add an extension tool
 * but never one of the blocked coding tools, which stay off whoever asks.
 */
export function isChatToolAllowed(
  tool: { name: string; sourceInfo?: unknown },
  extraAllowed: ReadonlySet<string> = NO_EXTRA_TOOLS,
): boolean {
  if (CHAT_BLOCKED_TOOL_NAMES.has(tool.name)) return false;
  return CHAT_ALLOWED_TOOL_NAMES.has(tool.name)
    || extraAllowed.has(tool.name)
    || isMcpTool({ name: tool.name, sourceInfo: tool.sourceInfo as never });
}

const NO_EXTRA_TOOLS: ReadonlySet<string> = new Set();

export function chatUnavailableToolReason(toolName: string): string {
  return `"${toolName}" is not available in a chat. Chats can use skills and MCP tools; open a project to use other tools.`;
}

const CHAT_PROMPT_INTRO = `You are a helpful, knowledgeable assistant in a desktop chat app. Answer directly and accurately, and ask a clarifying question only when the request is genuinely ambiguous. Reply in the language the user writes in, and use Markdown when it makes the answer easier to read.`;

const CHAT_PROMPT_FILES = `This is a general chat, not a project. You cannot run shell commands or edit files on the user's computer. The user can attach images and files to a message; what they attach is included in the message itself. You can read a file only when the user writes its full path in their own message, and you can save a file they ask for into their Downloads folder with save_to_downloads (a file name only, never overwriting). You may use the tools and skills made available to you, such as MCP servers. When the task needs a shell or editing a project, tell the user to open a project instead.`;

const CHAT_PROMPT_NO_FILES = `This is a general chat, not a project. You cannot see the user's files, run shell commands or edit anything on their computer. The user can attach images and files to a message; what they attach is included in the message itself. You may use the tools and skills made available to you, such as MCP servers. When the task needs files or a shell, tell the user to open a project instead.`;

/** The chat preamble; the file lines apply only where the server may touch the user's files. */
export function chatWorkspacePrompt(filesEnabled: boolean): string {
  return `${CHAT_PROMPT_INTRO}\n\n${filesEnabled ? CHAT_PROMPT_FILES : CHAT_PROMPT_NO_FILES}`;
}

export const CHAT_WORKSPACE_PROMPT = chatWorkspacePrompt(true);

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
  grants?: ChatFileGrants,
): string | null {
  const refusal = grants
    ? "Chats can read skill files, files you saved, and files the user named by full path in their own message. Ask the user to give the file's full path or attach it, or open a project to read files."
    : "Chats can only read skill files. Ask the user to attach the file to the message, or open a project to read files.";
  if (typeof rawPath !== "string" || !rawPath.trim()) return refusal;
  const real = safeRealpath(expandPath(rawPath, cwd));
  if (!real) return refusal;
  if (grants && isSensitivePath(real)) {
    return "Credentials and keys (such as ~/.ssh and Pi's own settings) are never readable in a chat, even when named.";
  }
  const roots = skillReadRoots(skills);
  if (roots.files.includes(real)) return null;
  if (roots.directories.some((root) => isInside(root, real))) return null;
  if (grants?.allows(real, cwd)) return null;
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
  /** The user's own chat instructions, read on every run so an edit applies to the next prompt. */
  getInstructions?: () => string | undefined;
  /** Extension tools the user allows in chats; read on every run and call. */
  getExtraTools?: () => readonly string[];
  /** Files the user named or the chat saved; omitted where the server must not touch the user's files. */
  grants?: ChatFileGrants;
}): InlineExtension {
  return {
    name: CHAT_WORKSPACE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("before_agent_start", (event, ctx) => {
        if (options.grants) {
          // Only the user's own words name a readable file: not tool output, not the model.
          options.grants.noteSessionOnce(() => userMessageTexts(ctx.sessionManager.getEntries()));
          if (event.messageType === "user") options.grants.noteUserText(event.prompt);
        }
        // An edit to selectedTools wins over the live loadout, so a tool an extension or
        // tool_search switched on cannot reach the model's declarations.
        const registered = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
        const selected = event.systemPromptOptions.selectedTools;
        const extra = new Set(options.getExtraTools?.() ?? []);
        const allowed = selected.filter((name) => isChatToolAllowed(registered.get(name) ?? { name }, extra));
        if (allowed.length !== selected.length) event.systemPromptOptions.selectedTools = allowed;
        event.systemPromptOptions.sections.date = chatDateSection();
        const instructions = options.getInstructions?.();
        if (instructions) event.systemPromptOptions.sections.instructions = instructions;
        else delete event.systemPromptOptions.sections.instructions;
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
        if (!isChatToolAllowed(tool ?? { name: event.toolName }, new Set(options.getExtraTools?.() ?? []))) {
          return { block: true, reason: chatUnavailableToolReason(event.toolName) };
        }
        if (event.toolName === CHAT_READ_TOOL_NAME) {
          const input = event.input as { path?: unknown } | undefined;
          const reason = chatReadBlockReason(input?.path, options.getCwd(), options.getSkills(), options.grants);
          if (reason) return { block: true, reason };
        }
        return undefined;
      });
    },
  };
}

function* userMessageTexts(entries: readonly unknown[]): Iterable<string> {
  for (const entry of entries) {
    const message = (entry as { type?: string; message?: { role?: string; content?: unknown } }).message;
    if ((entry as { type?: string }).type !== "message" || message?.role !== "user") continue;
    const content = message.content;
    if (typeof content === "string") {
      yield content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if ((block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
          yield (block as { text: string }).text;
        }
      }
    }
  }
}
