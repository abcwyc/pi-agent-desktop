import { NextResponse } from "next/server";
import { isAbsolute, resolve } from "path";
import { getAllowedFileRoots } from "@/lib/file-access";
import { getWorkspaceStatus } from "@/lib/workspace-availability";

export const dynamic = "force-dynamic";

// GET /api/cwd/status?cwd=<absolute path>
// Read-only: whether a known workspace still exists, so the UI can tell a
// deleted folder apart from a model or permission error. It grants nothing —
// trust, MCP and file access keep their own checks.
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("cwd")?.trim() ?? "";
  if (!raw || !isAbsolute(raw)) {
    return NextResponse.json({ error: "An absolute cwd is required" }, { status: 400 });
  }
  const result = await getWorkspaceStatus(raw, await getAllowedFileRoots());
  if (!result.ok) return NextResponse.json({ error: "Access denied" }, { status: 403 });
  return NextResponse.json({ cwd: resolve(raw), availability: result.availability });
}
