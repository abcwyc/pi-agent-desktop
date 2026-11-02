import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { isChatFolderPath, isChatWorkspacePath } from "@/lib/chat-workspace";
import { readChatUnlocked } from "@/lib/chat-unlock";
import { isNetworkExposedServer } from "@/lib/chat-file-access";
import { isLocalRequest } from "@/lib/remote-access";
import { getRpcSession, setRpcChatUnlock } from "@/lib/rpc-manager";
import { openSessionManager, readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import type { SessionEntry } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ChatAccess {
  /** Whether this session is a chat at all. */
  chat: boolean;
  /** The chat's own folder; null for a legacy chat. */
  folder: string | null;
  /** The user let this chat use their computer. */
  unlocked: boolean;
  /** Whether the chat can be unlocked: it has a folder and the server is local. */
  available: boolean;
}

async function describeChat(id: string, local = true): Promise<{ access: ChatAccess; filePath: string | undefined } | null> {
  const live = getRpcSession(id);
  const filePath = (live?.isAlive() ? live.sessionFile : undefined) || await resolveSessionPath(id) || undefined;
  const cwd = live?.isAlive()
    ? live.cwd
    : filePath && existsSync(filePath) ? readSessionHeader(filePath)?.cwd : undefined;
  if (!live?.isAlive() && !filePath) return null;
  if (!cwd || !isChatWorkspacePath(cwd)) {
    return { access: { chat: false, folder: null, unlocked: false, available: false }, filePath };
  }
  const folder = isChatFolderPath(cwd) ? cwd : null;
  let unlocked = false;
  if (live?.isAlive()) unlocked = live.isChatUnlocked();
  else if (filePath && existsSync(filePath)) {
    unlocked = readChatUnlocked(openSessionManager(filePath).getEntries() as unknown as SessionEntry[]);
  }
  return {
    access: { chat: true, folder, unlocked, available: Boolean(folder) && !isNetworkExposedServer() && local },
    filePath,
  };
}

// GET /api/sessions/[id]/chat-access - the chat's folder and whether it may use the computer.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    // Unlocking is offered only where it can be done: on this computer.
    const described = await describeChat(id, isLocalRequest(req));
    if (!described) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    return NextResponse.json(described.access, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

// POST /api/sessions/[id]/chat-access  body: { unlocked: boolean }
// Lets one chat use the user's computer (a shell, files anywhere), or takes that back.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await req.json() as { unlocked?: unknown };
    if (typeof body.unlocked !== "boolean") {
      return NextResponse.json({ error: "unlocked must be a boolean" }, { status: 400 });
    }
    // Letting a chat use the computer is decided at the computer, not from a phone
    // reaching it through Settings › Remote access. Locking it again is fine from anywhere.
    if (body.unlocked && !isLocalRequest(req)) {
      return NextResponse.json({ error: "A chat can only be allowed to use this computer on the computer itself." }, { status: 403 });
    }
    const described = await describeChat(id);
    if (!described) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    if (!described.access.chat || !described.access.folder) {
      return NextResponse.json({ error: "Only a chat with its own folder can use the computer." }, { status: 400 });
    }
    const changed = await setRpcChatUnlock(id, described.filePath, body.unlocked);
    return NextResponse.json({
      success: true,
      data: { sessionId: changed.sessionId, recreated: changed.recreated, unlocked: body.unlocked },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
