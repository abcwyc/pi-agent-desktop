import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isChatWorkspacePath } from "@/lib/chat-workspace";
import { allowFileRoot } from "@/lib/file-access";
import { getRpcSession } from "@/lib/rpc-manager";
import {
  invalidateSessionListCache,
  readSessionHeader,
  resolveSessionPath,
} from "@/lib/session-reader";
import { appendClearedSessionToolSelection } from "@/lib/session-tool-selection";

export const runtime = "nodejs";

/**
 * Continue a chat inside a project: the conversation is copied into a new session whose
 * cwd is the chosen project, so the model gains that project's tools while the chat stays
 * exactly as it was. The copy records the chat as its parent, like a fork.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await req.json() as { cwd?: unknown };
    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    }
    const cwd = resolve(body.cwd);
    if (isChatWorkspacePath(cwd)) {
      return NextResponse.json({ error: "Choose a project folder" }, { status: 400 });
    }
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const header = readSessionHeader(filePath);
    if (!header || !isChatWorkspacePath(header.cwd)) {
      return NextResponse.json({ error: "Only a chat can be continued in a project" }, { status: 400 });
    }
    if (getRpcSession(id)?.isRunning()) {
      return NextResponse.json({ error: "Wait for the chat to finish first" }, { status: 409 });
    }

    const manager = SessionManager.forkFrom(filePath, cwd);
    // An older chat's transcript pins an empty tool list; the project session follows its own settings.
    appendClearedSessionToolSelection(manager);
    // pi restores the tool loadout the transcript declares, which for a chat is `read` and
    // `codemode` only, so the chat's system messages stay behind.
    const copiedFile = manager.getSessionFile();
    if (copiedFile) forgetChatSystemPrompt(copiedFile);
    allowFileRoot(cwd);
    invalidateSessionListCache();
    return NextResponse.json({
      sessionId: manager.getSessionId(),
      path: manager.getSessionFile() ?? null,
      cwd,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * Remove the system messages from a copied transcript, joining the entries around them.
 * They hold the chat's prompt and tool declarations; without them pi builds the project
 * session's own prompt and default tools on its next run, as it does for a new session.
 */
function forgetChatSystemPrompt(file: string): void {
  const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  });
  if (entries.some((entry) => entry === null)) return;
  const parents = new Map<string, string | null>();
  const kept = (entries as Record<string, unknown>[]).filter((entry) => {
    const message = entry.message as { role?: string } | undefined;
    if (entry.type === "message" && message?.role === "system" && typeof entry.id === "string") {
      parents.set(entry.id, (entry.parentId as string | null | undefined) ?? null);
      return false;
    }
    return true;
  });
  const survivor = (id: string | null | undefined): string | null => {
    let current = id ?? null;
    while (current !== null && parents.has(current)) current = parents.get(current) ?? null;
    return current;
  };
  const rewritten = kept.map((entry) => (
    "parentId" in entry ? { ...entry, parentId: survivor(entry.parentId as string | null | undefined) } : entry
  ));
  writeFileSync(file, `${rewritten.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}
