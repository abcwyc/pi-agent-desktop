/**
 * What a session is allowed to reach, decided once on the server when it starts.
 *
 * The browser never computes this: it reads `workspaceKind` (server-classified) and the
 * results of the server's checks. Every server-side gate asks the policy instead of
 * re-deriving "is this a chat" from two booleans.
 *
 * - `chat`: the hidden non-project workspace. Skills, MCP and codemode, but no files, shell
 *   or other extension tools (lib/chat-workspace-policy.ts). Pi's structured prompt with a
 *   chat preamble, so the transcript matches what is sent.
 * - `chat-only`: a project session pinned to an empty tool list. Nothing is loaded and an
 *   exact prompt (the context files) replaces Pi's.
 * - `project`: everything the user configured (a subagent with tools is one too; its
 *   profile, not the policy, narrows what it gets).
 */
export type SessionKind = "chat" | "chat-only" | "project";

export interface SessionPolicy {
  kind: SessionKind;
  /** The session may use the user's files and shell, so a tool preset means something. */
  reachesFilesAndShell: boolean;
  /** Extensions, skills and the codemode / tool-search / MCP built-ins load. */
  loadsExtensions: boolean;
  /** The user may change the tool preset after the session exists. */
  allowsToolPresets: boolean;
  /** An exact prompt (not Pi's structured one) is sent. */
  sendsExactPrompt: boolean;
}

export function deriveSessionPolicy(input: {
  chatWorkspace?: boolean;
  chatOnly?: boolean;
}): SessionPolicy {
  if (input.chatWorkspace) {
    return {
      kind: "chat",
      reachesFilesAndShell: false,
      loadsExtensions: true,
      allowsToolPresets: false,
      sendsExactPrompt: false,
    };
  }
  if (input.chatOnly) {
    return {
      kind: "chat-only",
      reachesFilesAndShell: false,
      loadsExtensions: false,
      allowsToolPresets: true,
      sendsExactPrompt: true,
    };
  }
  return {
    kind: "project",
    reachesFilesAndShell: true,
    loadsExtensions: true,
    allowsToolPresets: true,
    sendsExactPrompt: false,
  };
}
