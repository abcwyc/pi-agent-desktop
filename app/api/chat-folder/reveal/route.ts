import { existsSync } from "fs";
import { NextResponse } from "next/server";
import { isChatFolderPath } from "@/lib/chat-workspace";
import { isNetworkExposedServer } from "@/lib/chat-file-access";
import { isFileManagerSupported, launchFileManager } from "@/lib/open-in-file-manager";
import { isLocalRequest } from "@/lib/remote-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRpcSession } from "@/lib/rpc-manager";
import { readSessionHeader, resolveSessionPath } from "@/lib/session-reader";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Shows a chat's own folder in the OS file manager. The folder is looked up from the
 * session (never taken from the request), and only from this machine.
 */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  if (isNetworkExposedServer() || !isLocalRequest(request)) {
    return NextResponse.json({ error: "remote" }, { status: 403 });
  }
  if (!isFileManagerSupported(process.platform)) {
    return NextResponse.json({ error: "unsupported-platform" }, { status: 403 });
  }
  try {
    const body = await request.json() as { sessionId?: unknown };
    if (typeof body.sessionId !== "string" || !body.sessionId.trim()) {
      return NextResponse.json({ error: "sessionId-required" }, { status: 400 });
    }
    const live = getRpcSession(body.sessionId);
    const filePath = await resolveSessionPath(body.sessionId);
    const cwd = live?.isAlive() ? live.cwd : filePath && existsSync(filePath) ? readSessionHeader(filePath)?.cwd : undefined;
    if (!cwd || !isChatFolderPath(cwd)) {
      return NextResponse.json({ error: "not-a-chat-folder" }, { status: 400 });
    }
    if (!existsSync(cwd)) return NextResponse.json({ error: "not-found" }, { status: 404 });
    await launchFileManager(cwd);
    return NextResponse.json({ opened: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
