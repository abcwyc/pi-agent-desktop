import type { InlineExtension, ToolInfo } from "@earendil-works/pi-coding-agent";
import { MCP_EXTENSION_PATH } from "./mcp-command";
import { readSessionToolSelection } from "./session-tool-selection";
import { SDK_BUILTIN_TOOLS } from "./subagents";
import type { SessionEntry } from "./types";

// A Read-only session pins coding tools that cannot change anything, but MCP
// tools stay callable beside them, directly or from a codemode script. While
// such a selection is pinned, this policy blocks every MCP tool its server
// does not mark `readOnlyHint: true` (ADR 0006, "Safety → Read-only"). The
// hint comes from the server: the policy keeps the model from writing through
// a tool by mistake, it does not defend against a malicious server.

const WRITE_CAPABLE_TOOLS = new Set(["bash", "powershell", "edit", "write"]);
const MCP_TOOL_PREFIX = "mcp__";

export const READ_ONLY_MCP_POLICY_EXTENSION_NAME = "pi-web-read-only-mcp";

/**
 * Whether a pinned tool selection is read-only: it names tools, and none of
 * them can write or run commands. The Read-only preset is one; so is a subset
 * of it. No pin (pi's configured tools) is not.
 */
export function isReadOnlySelection(tools: readonly string[] | undefined): boolean {
  return tools !== undefined && tools.length > 0 && !tools.some((name) => WRITE_CAPABLE_TOOLS.has(name));
}

/** A tool the MCP extension registered, or one named like an MCP tool by another MCP extension. */
export function isMcpTool(tool: Pick<ToolInfo, "name" | "sourceInfo">): boolean {
  return tool.sourceInfo?.path === MCP_EXTENSION_PATH || tool.name.startsWith(MCP_TOOL_PREFIX);
}

export function readOnlyMcpBlockReason(toolName: string): string {
  return `This session uses a read-only tool selection, and the MCP server does not mark "${toolName}" as read-only (readOnlyHint), so the call was blocked. Switch the session to a preset that allows changes to use it.`;
}

export const SUBAGENT_MCP_POLICY_EXTENSION_NAME = "pi-web-subagent-mcp-policy";

export function subagentReadOnlyMcpBlockReason(toolName: string): string {
  return `This subagent's profile gives it read-only tools, and the MCP server does not mark "${toolName}" as read-only (readOnlyHint), so the call was blocked.`;
}

export function unselectedMcpToolBlockReason(toolName: string): string {
  return `"${toolName}" comes from an extension this subagent's profile did not select, so the call was blocked.`;
}

/**
 * The MCP policy of a subagent with `mcp: on`, whose tools are its profile's, not a pin. While
 * its built-in tools are read-only (Explore, Plan), it blocks MCP tools without
 * `readOnlyHint: true` as the Read-only policy does; a profile of extension tools alone is not
 * read-only. An allowlist admits MCP tools by name alone (`mcp__*`, the SDK's only test), so
 * it would also admit those of an extension the profile's `ext:` selectors left out: only pi's
 * built-in MCP extension's tools and the ones the profile named may run. `scope` is read at
 * every call, so spawn can hand it over once the extension tools are resolved.
 */
export function createSubagentMcpPolicyExtension(
  scope: () => { tools: readonly string[]; allExtensionTools?: boolean },
): InlineExtension {
  return {
    name: SUBAGENT_MCP_POLICY_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      // Nested calls (a codemode script's) pass through tool_call as well.
      pi.on("tool_call", (event) => {
        const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
        if (!tool || !isMcpTool(tool)) return undefined;
        const { tools, allExtensionTools } = scope();
        if (!allExtensionTools && tool.sourceInfo?.path !== MCP_EXTENSION_PATH && !tools.includes(tool.name)) {
          return { block: true, reason: unselectedMcpToolBlockReason(event.toolName) };
        }
        if (tool.annotations?.readOnlyHint === true) return undefined;
        if (!isReadOnlySelection(tools.filter((name) => SDK_BUILTIN_TOOLS.includes(name)))) return undefined;
        return { block: true, reason: subagentReadOnlyMcpBlockReason(event.toolName) };
      });
    },
  };
}

export function createReadOnlyMcpPolicyExtension(): InlineExtension {
  return {
    name: READ_ONLY_MCP_POLICY_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      // Nested calls (a codemode script's) pass through tool_call as well, with parentToolCallId set.
      pi.on("tool_call", (event, ctx) => {
        const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
        if (!tool || !isMcpTool(tool) || tool.annotations?.readOnlyHint === true) return undefined;
        // Read last: most calls are not MCP calls, and the selection scan walks the session.
        const selection = readSessionToolSelection(ctx.sessionManager.getEntries() as unknown as SessionEntry[]);
        if (!isReadOnlySelection(selection)) return undefined;
        return { block: true, reason: readOnlyMcpBlockReason(event.toolName) };
      });
    },
  };
}
