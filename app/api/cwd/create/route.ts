import { NextResponse } from "next/server";
import { mkdirSync, readdirSync, statSync, type Stats } from "fs";
import { allowFileRoot } from "@/lib/file-access";
import { resolveNewProjectFolder } from "@/lib/new-project-folder";
import { directoryPermissionMessage, isPermissionError } from "@/lib/directory-browser";

// POST /api/cwd/create  body: { path: string }
// Creates a new project folder and registers it as an allowed file root, so
// the UI can go straight from "New Folder…" to a chat in the fresh directory.
// A bare name is created inside the home directory; resolveNewProjectFolder
// rejects anything that escapes it (creation is a write, and the server may
// be exposed beyond loopback via start:lan).
export async function POST(req: Request) {
  try {
    const body = await req.json() as { path?: unknown };
    const candidate = typeof body.path === "string" ? body.path : "";
    const { dir, error } = resolveNewProjectFolder(candidate);
    if (!dir) {
      return NextResponse.json({ error }, { status: 400 });
    }

    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      if (isPermissionError(err)) {
        return NextResponse.json({ error: directoryPermissionMessage(dir) }, { status: 403 });
      }
      return NextResponse.json({ error: `Cannot create folder: ${String(err)}` }, { status: 400 });
    }

    let stat: Stats;
    try {
      stat = statSync(dir);
    } catch {
      return NextResponse.json({ error: `Directory does not exist: ${dir}` }, { status: 400 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: `Path is not a directory: ${dir}` }, { status: 400 });
    }

    // Probe read access so a permission-denied folder is rejected at creation
    // time instead of failing later (file tree, git status, session reads) —
    // same contract as POST /api/cwd/validate.
    try {
      readdirSync(dir);
    } catch (err) {
      if (isPermissionError(err)) {
        return NextResponse.json({ error: directoryPermissionMessage(dir) }, { status: 403 });
      }
      return NextResponse.json({ error: `Directory cannot be read: ${dir}` }, { status: 400 });
    }

    allowFileRoot(dir);
    return NextResponse.json({ success: true, cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
