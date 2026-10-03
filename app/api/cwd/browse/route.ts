import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import type { Stats } from "fs";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  createDirectory,
  directoryPermissionMessage,
  type BrowsableDirectory,
  getBrowseStartDirectory,
  getParentDirectory,
  isPermissionError,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  shouldShowWindowsDrivePicker,
} from "@/lib/directory-browser";

// GET /api/cwd/browse?path=...：列出文件系统中的可读子目录。
export async function GET(request: NextRequest) {
  try {
    const requested = request.nextUrl.searchParams.get("path")?.trim();

    if (shouldShowWindowsDrivePicker(requested)) {
      return NextResponse.json({
        path: "",
        parentPath: null,
        drives: await listWindowsDrives(),
        directories: [],
      });
    }

    const candidate = getBrowseStartDirectory(requested);

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate);
    } catch (error) {
      // macOS TCC / POSIX mode denial, not a missing path.
      if (isPermissionError(error)) {
        return NextResponse.json({ error: directoryPermissionMessage(candidate) }, { status: 403 });
      }
      return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
    }

    let directoryStat: Stats;
    try {
      directoryStat = await stat(resolved);
    } catch (error) {
      if (isPermissionError(error)) {
        return NextResponse.json({ error: directoryPermissionMessage(resolved) }, { status: 403 });
      }
      return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
    }
    if (!directoryStat.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
    }

    let directories: BrowsableDirectory[];
    try {
      directories = await listDirectories(resolved);
    } catch (error) {
      if (isPermissionError(error)) {
        return NextResponse.json({ error: directoryPermissionMessage(resolved) }, { status: 403 });
      }
      return NextResponse.json({ error: String(error) }, { status: 500 });
    }

    return NextResponse.json({
      path: resolved,
      parentPath: getParentDirectory(resolved),
      directories,
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/cwd/browse  body: { path: string, name: string }
// Creates one direct child of the currently browsed directory.
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await request.json() as { path?: unknown; name?: unknown };
    const parentPath = typeof body.path === "string" ? body.path.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!parentPath) {
      return NextResponse.json({ error: "Parent path is required" }, { status: 400 });
    }
    if (!name) {
      return NextResponse.json({ error: "Directory name is required" }, { status: 400 });
    }

    const createdPath = await createDirectory(parentPath, name);
    return NextResponse.json({ success: true, path: createdPath });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "";
    if (code === "EEXIST") {
      return NextResponse.json({ error: "A file or directory with this name already exists" }, { status: 409 });
    }
    if (code === "ENOENT") {
      return NextResponse.json({ error: "Parent directory does not exist" }, { status: 404 });
    }
    if (code === "EACCES" || code === "EPERM") {
      return NextResponse.json({ error: "Permission denied" }, { status: 403 });
    }
    if (code === "EINVAL" || code === "ENAMETOOLONG") {
      return NextResponse.json({ error: "Directory name is invalid" }, { status: 400 });
    }
    if (error instanceof Error && (
      error.message === "Directory name must be a single folder name"
      || error.message === "Parent path is not a directory"
    )) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
