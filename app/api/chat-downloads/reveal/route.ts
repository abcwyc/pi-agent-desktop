import { existsSync } from "fs";
import { dirname, relative, resolve, isAbsolute } from "path";
import { NextResponse } from "next/server";
import { chatDownloadsDir, isNetworkExposedServer } from "@/lib/chat-file-access";
import { isFileManagerSupported, isLoopbackHost, launchFileManager } from "@/lib/open-in-file-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Shows a file a chat saved to Downloads in the OS file manager. Only the Downloads
 * folder and what is inside it can be named, and only from this machine.
 */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  if (isNetworkExposedServer() || !isLoopbackHost(request.headers.get("host"))) {
    return NextResponse.json({ error: "remote" }, { status: 403 });
  }
  if (!isFileManagerSupported(process.platform)) {
    return NextResponse.json({ error: "unsupported-platform" }, { status: 403 });
  }
  try {
    const body = await request.json() as { path?: unknown };
    if (typeof body.path !== "string" || !body.path.trim()) {
      return NextResponse.json({ error: "path-required" }, { status: 400 });
    }
    const target = resolve(body.path);
    const downloads = resolve(chatDownloadsDir());
    const rel = relative(downloads, target);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return NextResponse.json({ error: "access-denied" }, { status: 403 });
    }
    if (!existsSync(target)) return NextResponse.json({ error: "not-found" }, { status: 404 });
    await launchFileManager(rel === "" ? target : dirname(target));
    return NextResponse.json({ opened: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
